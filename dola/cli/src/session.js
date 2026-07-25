import { applyAccountCookies } from './accounts/cookies.js';
import { CdpClient, evaluate, findOrCreateTarget, waitForPageReady } from './cdp.js';
import { DOLA_CHAT_HOME } from './config.js';
import { installImageHook } from './media/capture.js';
import { sleep } from './utils.js';

export function normalizeSession(session) {
  const value = String(session || "").trim();
  if (!value) throw new Error("chat session is required.");
  if (/^https?:\/\//i.test(value)) {
    const url = new URL(value);
    if (!/(^|\.)dola\.com$/i.test(url.hostname)) throw new Error("session URL must be a dola.com URL.");
    if (url.pathname.replace(/\/+$/, "") === "/chat") return DOLA_CHAT_HOME;
    return url.toString();
  }
  if (/^\d{8,}$/.test(value)) return `https://www.dola.com/chat/${value}`;
  throw new Error("chat session must be a Dola chat URL or numeric session id.");
}

export function isChatHomeUrl(url) {
  try {
    const parsed = new URL(url);
    return /(^|\.)dola\.com$/i.test(parsed.hostname) && parsed.pathname.replace(/\/+$/, "") === "/chat";
  } catch {
    return false;
  }
}

export function isConcreteChatUrl(url) {
  try {
    const parsed = new URL(url);
    return /(^|\.)dola\.com$/i.test(parsed.hostname) && /^\/chat\/\d+\/?$/.test(parsed.pathname);
  } catch {
    return false;
  }
}

export async function detectDolaLoginState(client) {
  return evaluate(client, `(() => {
    const text = (document.body && document.body.innerText) || "";
    const hasLogin = /\\u767b\\u5f55|\\u767b\\u5165|log\\s*in|sign\\s*in/i.test(text.slice(0, 2000));
    const hasUser = /user\\d{6,}|uid|\\u4e2a\\u4eba\\u4e2d\\u5fc3|\\u8d26\\u53f7/i.test(text)
      || Boolean(document.querySelector('[class*="avatar"], [class*="user-"], img[alt*="avatar" i]'));
    const composer = Boolean(document.querySelector("textarea, [contenteditable='true'], [role='textbox']"));
    return {
      url: location.href,
      title: document.title,
      looksLoggedIn: hasUser || (composer && !hasLogin),
      hasLoginPrompt: hasLogin && !hasUser,
      composer,
    };
  })()`).catch(() => ({ looksLoggedIn: false, hasLoginPrompt: true, composer: false }));
}

export async function startFreshChat(client) {
  // Prefer the sidebar "新对话" control so video jobs do not land in an old image thread.
  const clicked = await evaluate(client, `(() => {
    const labels = ["\\u65b0\\u5bf9\\u8bdd", "New chat", "New Chat", "New conversation"];
    const plain = el => (el.innerText || el.textContent || el.getAttribute("aria-label") || el.title || "").replace(/\\s+/g, " ").trim();
    const visible = el => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.display !== "none" && s.visibility !== "hidden";
    };
    const nodes = Array.from(document.querySelectorAll("button, [role='button'], a, div, span")).filter(visible);
    // Prefer exact short label (avoid "新对话 Ctrl Shift K" side chrome).
    const scored = nodes
      .map(node => {
        const t = plain(node);
        let score = 0;
        if (labels.some(label => t === label)) score = 100;
        else if (labels.some(label => t.startsWith(label)) && t.length <= 12) score = 60;
        else return null;
        return { node, t, score };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score);
    const el = scored[0]?.node;
    if (!el) return { ok: false };
    el.click();
    return { ok: true, text: plain(el).slice(0, 40) };
  })()`).catch(() => ({ ok: false }));
  if (clicked?.ok) {
    console.log(`[dola-cli] started fresh chat via ${clicked.text}`);
    await sleep(1500);
    return true;
  }
  console.log("[dola-cli] navigating to chat home for a fresh conversation");
  await client.send("Page.navigate", { url: DOLA_CHAT_HOME });
  await waitForPageReady(client);
  await sleep(2500);
  return true;
}

export async function openAccountSession(cdp, sessionUrl, forceNew, resume, account, preferExistingDola = false) {
  const target = await findOrCreateTarget(cdp, sessionUrl, forceNew, preferExistingDola);
  if (!target?.webSocketDebuggerUrl) throw new Error("No page CDP target found.");
  const client = new CdpClient(target.webSocketDebuggerUrl);
  await client.connect();
  await client.send("Runtime.enable");
  await client.send("Page.enable");
  await client.send("Network.enable");
  await client.send("Page.bringToFront").catch(() => {});
  await applyAccountCookies(client, account);

  let currentUrl = await evaluate(client, "location.href");
  const onDola = (() => {
    try {
      return /(^|\.)dola\.com$/i.test(new URL(currentUrl).hostname);
    } catch {
      return false;
    }
  })();
  // preferExistingDola may attach to an unrelated/blank tab when no chat is open.
  // Always land on the requested Dola session unless we already match it.
  const needsNavigate = currentUrl !== sessionUrl && (!preferExistingDola || !onDola || isChatHomeUrl(currentUrl) && !isChatHomeUrl(sessionUrl));
  if (needsNavigate) {
    console.log(`[dola-cli] navigating session ${currentUrl} -> ${sessionUrl}`);
    await client.send("Page.navigate", { url: sessionUrl });
    await waitForPageReady(client);
    await sleep(3000);
    currentUrl = await evaluate(client, "location.href");
    console.log(`[dola-cli] session ready ${currentUrl}`);
  } else if (resume) {
    console.log(`[dola-cli] refreshing resumed session ${sessionUrl}`);
    await client.send("Page.reload", { ignoreCache: false });
    await waitForPageReady(client);
    await sleep(3000);
    currentUrl = await evaluate(client, "location.href");
  }
  // Re-apply cookies after navigation so domain-scoped cookies bind to dola.com.
  if (account?.cookieFile) {
    await applyAccountCookies(client, account);
    if (needsNavigate || resume) {
      await client.send("Page.reload", { ignoreCache: false }).catch(() => {});
      await waitForPageReady(client);
      await sleep(2000);
      currentUrl = await evaluate(client, "location.href").catch(() => currentUrl);
    }
  }
  await installImageHook(client);
  return { client, currentUrl };
}
