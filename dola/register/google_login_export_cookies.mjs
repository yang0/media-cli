/**
 * Log into dola.com via Google OAuth with accounts from google_mail.txt,
 * then export Netscape cookies into G:\cookies\dola.
 *
 * Usage:
 *   node google_login_export_cookies.mjs --accounts ..\google_mail.txt --out G:\cookies\dola --cdp http://127.0.0.1:9223 --limit 1
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const args = {
    cdp: "http://127.0.0.1:9223",
    accounts: path.resolve(__dirname, "..", "google_mail.txt"),
    out: "G:\\cookies\\dola",
    limit: 1,
    start: 0,
    timeoutMs: 180000,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    const v = () => {
      const n = argv[++i];
      if (!n) throw new Error(`Missing value for ${a}`);
      return n;
    };
    if (a === "--cdp") args.cdp = v();
    else if (a === "--accounts") args.accounts = path.resolve(v());
    else if (a === "--out") args.out = path.resolve(v());
    else if (a === "--limit") args.limit = Number(v());
    else if (a === "--start") args.start = Number(v());
    else if (a === "--timeout") args.timeoutMs = Number(v());
    else if (a === "--help" || a === "-h") args.help = true;
    else throw new Error(`Unknown arg: ${a}`);
  }
  return args;
}

function loadAccounts(file) {
  const text = readFileSync(file, "utf8");
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line, index) => {
      const sep = line.includes("|") ? "|" : line.includes("----") ? "----" : line.includes(":") ? ":" : null;
      if (!sep) throw new Error(`Bad account line ${index + 1}: ${line}`);
      const [email, ...rest] = line.split(sep);
      const password = rest.join(sep).trim();
      if (!email || !password) throw new Error(`Bad account line ${index + 1}`);
      return { email: email.trim(), password, index: index + 1 };
    });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

class CdpClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.id = 0;
    this.pending = new Map();
  }
  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((res, rej) => {
      this.ws.addEventListener("open", res);
      this.ws.addEventListener("error", (e) => rej(e.error || e));
    });
    this.ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.method === "Target.attachedToTarget" && msg.params?.sessionId) {
        // ignore
      }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const payload = { id, method, params };
      if (sessionId) payload.sessionId = sessionId;
      this.ws.send(JSON.stringify(payload));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 60000);
    });
  }
  async evaluate(expression, sessionId) {
    const r = await this.send(
      "Runtime.evaluate",
      { expression, awaitPromise: true, returnByValue: true, userGesture: true },
      sessionId
    );
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || "evaluate failed");
    return r.result?.value;
  }
  close() {
    try {
      this.ws.close();
    } catch {}
  }
}

async function cdpJson(cdp, p) {
  const origin = new URL(cdp).origin;
  return fetch(`${origin}${p}`).then((r) => r.json());
}

async function ensurePage(cdp, urlHint = /dola\.com/i) {
  const list = await cdpJson(cdp, "/json/list");
  let page = list.find((t) => t.type === "page" && urlHint.test(t.url || ""));
  if (!page) {
    const u = `${new URL(cdp).origin}/json/new?${encodeURIComponent("https://www.dola.com/")}`;
    try {
      page = await fetch(u, { method: "PUT" }).then((r) => r.json());
    } catch {
      page = await fetch(u).then((r) => r.json());
    }
    await sleep(2500);
    const list2 = await cdpJson(cdp, "/json/list");
    page = list2.find((t) => t.id === page.id) || list2.find((t) => t.type === "page");
  }
  if (!page?.webSocketDebuggerUrl) throw new Error("No page CDP target");
  return page;
}

function cookieToNetscape(cookies) {
  const lines = [
    "# Netscape HTTP Cookie File",
    "# https://curl.haxx.se/rfc/cookie_spec.html",
    "# This is a generated file! Do not edit.",
    "",
  ];
  for (const c of cookies) {
    const domain = c.domain || "";
    const includeSub = domain.startsWith(".") ? "TRUE" : "FALSE";
    const cookiePath = c.path || "/";
    const secure = c.secure ? "TRUE" : "FALSE";
    const expires = c.expires && c.expires > 0 ? Math.floor(c.expires) : 0;
    const name = c.name || "";
    const value = c.value || "";
    if (!name || !domain) continue;
    // Netscape: domain \t flag \t path \t secure \t expires \t name \t value
    const prefix = c.httpOnly ? "#HttpOnly_" : "";
    lines.push(`${prefix}${domain}\t${includeSub}\t${cookiePath}\t${secure}\t${expires}\t${name}\t${value}`);
  }
  return lines.join("\n") + "\n";
}

function hasDolaSession(cookies) {
  const names = new Set(cookies.map((c) => c.name));
  return ["sessionid", "sessionid_ss", "sid_tt", "sid_guard", "uid_tt"].some((n) => names.has(n));
}

async function waitFor(fn, timeoutMs, interval = 800) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeoutMs) {
    last = await fn();
    if (last) return last;
    await sleep(interval);
  }
  return last;
}

async function loginOne(cdp, account, outDir, opts) {
  const page = await ensurePage(cdp, /dola\.com|accounts\.google|google\.com/i);
  const client = new CdpClient(page.webSocketDebuggerUrl);
  await client.connect();
  await client.send("Runtime.enable");
  await client.send("Page.enable");
  await client.send("Network.enable");
  await client.send("Page.bringToFront").catch(() => {});

  const log = (m) => console.log(`[${account.email}] ${m}`);

  // Clear cookies for a clean login on this profile? Risky if multi-account same profile.
  // Instead only clear google+dola related cookies for this attempt.
  try {
    await client.send("Network.clearBrowserCookies");
    log("cleared browser cookies for clean login");
  } catch (e) {
    log(`clear cookies warn: ${e.message}`);
  }

  try {
    await Promise.race([
      client.send("Page.navigate", { url: "https://www.dola.com/" }),
      sleep(15000).then(() => {
        throw new Error("navigate timeout");
      }),
    ]);
  } catch (e) {
    log(`navigate warn: ${e.message}; trying again with new tab`);
    try {
      const u = `${new URL(cdp).origin}/json/new?${encodeURIComponent("https://www.dola.com/")}`;
      await fetch(u, { method: "PUT" }).catch(() => fetch(u));
      await sleep(3000);
      // reattach to dola tab
      const list = await cdpJson(cdp, "/json/list");
      const dola = list.find((t) => t.type === "page" && /dola\.com/i.test(t.url || ""));
      if (dola?.webSocketDebuggerUrl) {
        client.close();
        const nc = new CdpClient(dola.webSocketDebuggerUrl);
        await nc.connect();
        await nc.send("Runtime.enable");
        await nc.send("Page.enable");
        await nc.send("Network.enable");
        // replace methods on local binding by reassign - simpler to throw and let outer retry
        Object.assign(client, nc);
        client.ws = nc.ws;
        client.send = nc.send.bind(nc);
        client.evaluate = nc.evaluate.bind(nc);
        client.close = nc.close.bind(nc);
      }
    } catch (e2) {
      log(`reattach warn: ${e2.message}`);
    }
  }
  await sleep(3500);

  // Click Log In
  let clicked = await client.evaluate(`(() => {
    const plain = el => (el.innerText || el.textContent || el.getAttribute('aria-label') || '').replace(/\\s+/g,' ').trim();
    const visible = el => { const r=el.getBoundingClientRect(); const s=getComputedStyle(el); return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'; };
    const nodes = Array.from(document.querySelectorAll('button,a,[role=button]')).filter(visible);
    const el = nodes.filter(n => { const t=plain(n); return t==='Log In' || t==='登录' || t==='Sign in' || t==='Log in'; })
      .sort((a,b)=>(b.getBoundingClientRect().width*b.getBoundingClientRect().height)-(a.getBoundingClientRect().width*a.getBoundingClientRect().height))[0];
    if (!el) return {ok:false};
    el.click();
    return {ok:true, text: plain(el)};
  })()`);
  log(`Log In click: ${JSON.stringify(clicked)}`);
  await sleep(2000);

  // Click Continue with Google — prefer exact short BUTTON/A, never the whole modal container.
  clicked = await client.evaluate(`(() => {
    const plain = el => (el.innerText || el.textContent || el.getAttribute('aria-label') || '').replace(/\\s+/g,' ').trim();
    const visible = el => { const r=el.getBoundingClientRect(); const s=getComputedStyle(el); return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'; };
    const nodes = Array.from(document.querySelectorAll('button,a,[role=button]')).filter(visible);
    const exact = nodes
      .map(el => ({ el, t: plain(el), r: el.getBoundingClientRect() }))
      .filter(x => x.t === 'Continue with Google' || x.t === '使用 Google 账号继续' || x.t === '使用 Google 登录' || /^Continue with Google$/i.test(x.t))
      .sort((a,b) => (a.r.width*a.r.height) - (b.r.width*b.r.height)); // smallest exact chip
    let el = exact[0]?.el;
    if (!el) {
      // fallback: short nodes containing google continue
      const soft = nodes
        .map(el => ({ el, t: plain(el), r: el.getBoundingClientRect() }))
        .filter(x => x.t.length <= 40 && /Continue with Google|使用 Google/i.test(x.t))
        .sort((a,b) => (a.r.width*a.r.height) - (b.r.width*b.r.height));
      el = soft[0]?.el;
    }
    if (!el) {
      return {
        ok: false,
        candidates: nodes.map(n => plain(n)).filter(t => t && t.length <= 50 && /google|登录|Log|Continue/i.test(t)).slice(0, 30),
      };
    }
    el.scrollIntoView({ block: 'center', inline: 'center' });
    el.click();
    return { ok: true, text: plain(el), tag: el.tagName };
  })()`);
  log(`Google click: ${JSON.stringify(clicked)}`);
  if (!clicked?.ok) {
    // Try coordinate click on first Continue with Google button rect
    const point = await client.evaluate(`(() => {
      const plain = el => (el.innerText || el.textContent || '').replace(/\\s+/g,' ').trim();
      const visible = el => { const r=el.getBoundingClientRect(); const s=getComputedStyle(el); return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'; };
      const el = Array.from(document.querySelectorAll('button,a,[role=button]')).filter(visible)
        .find(n => plain(n) === 'Continue with Google');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width/2, y: r.y + r.height/2 };
    })()`);
    if (!point) {
      client.close();
      return { ok: false, email: account.email, error: "Continue with Google not found", detail: clicked };
    }
    await client.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 });
    await client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 });
    log(`Google coordinate click at ${point.x},${point.y}`);
  }

  // Wait for Google accounts page (same tab or new tab / popup)
  await sleep(1500);
  const googlePage = await waitFor(async () => {
    const list = await cdpJson(cdp, "/json/list");
    const g = list.find(
      (t) =>
        t.type === "page" &&
        /accounts\.google\.com|google\.com\/(?:signin|o\/oauth)|accounts\.youtube|ggsession/i.test(t.url || "")
    );
    if (g) return g;
    // also check if main tab navigated to google
    const main = list.find((t) => t.type === "page" && /dola\.com/i.test(t.url || ""));
    return null;
  }, 25000);

  let gClient = client;
  let sessionClose = null;
  if (googlePage && googlePage.id !== page.id && googlePage.webSocketDebuggerUrl) {
    log(`Google opened in tab: ${googlePage.url}`);
    gClient = new CdpClient(googlePage.webSocketDebuggerUrl);
    await gClient.connect();
    await gClient.send("Runtime.enable");
    await gClient.send("Page.enable");
    sessionClose = () => gClient.close();
  } else {
    // maybe navigated in same tab
    await sleep(2000);
    const url = await client.evaluate("location.href");
    log(`current url after google click: ${url}`);
  }

  // Enter email
  const emailFilled = await waitFor(async () => {
    try {
      return await gClient.evaluate(`(() => {
        const email = ${JSON.stringify(account.email)};
        const visible = el => { const r=el.getBoundingClientRect(); const s=getComputedStyle(el); return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'; };
        let el = document.querySelector('input[type=email]') || document.querySelector('#identifierId') ||
          Array.from(document.querySelectorAll('input')).filter(visible).find(i => /email|identifier|account/i.test((i.type||'')+(i.name||'')+(i.id||'')+(i.getAttribute('autocomplete')||'')));
        if (!el) return null;
        el.focus();
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        setter?.call(el, email);
        el.dispatchEvent(new Event('input', { bubbles:true }));
        el.dispatchEvent(new Event('change', { bubbles:true }));
        return { ok:true, id: el.id||'', name: el.name||'' };
      })()`);
    } catch {
      return null;
    }
  }, 20000);

  if (!emailFilled?.ok) {
    sessionClose?.();
    client.close();
    return { ok: false, email: account.email, error: "Email input not found on Google page" };
  }
  log("email filled");

  // Next after email
  await gClient.evaluate(`(() => {
    const plain = el => (el.innerText||el.textContent||'').replace(/\\s+/g,' ').trim();
    const visible = el => { const r=el.getBoundingClientRect(); const s=getComputedStyle(el); return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'; };
    const btn = Array.from(document.querySelectorAll('button,div[role=button],input[type=submit]')).filter(visible)
      .find(el => {
        const t = plain(el) || el.getAttribute('aria-label') || '';
        return t === 'Next' || t === '下一步' || t === '继续' || /identifierNext|next/i.test(el.id||'') || /identifierNext/i.test(el.getAttribute('jsname')||'');
      });
    // Prefer known id
    const next = document.querySelector('#identifierNext') || btn;
    if (next) next.click();
    return Boolean(next);
  })()`);
  await sleep(3000);

  // Password
  const passFilled = await waitFor(async () => {
    try {
      return await gClient.evaluate(`(() => {
        const password = ${JSON.stringify(account.password)};
        const visible = el => { const r=el.getBoundingClientRect(); const s=getComputedStyle(el); return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'; };
        let el = document.querySelector('input[type=password]') ||
          Array.from(document.querySelectorAll('input')).filter(visible).find(i => i.type==='password' || /password/i.test(i.name||i.id||''));
        if (!el || !visible(el)) return null;
        el.focus();
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        setter?.call(el, password);
        el.dispatchEvent(new Event('input', { bubbles:true }));
        el.dispatchEvent(new Event('change', { bubbles:true }));
        return { ok:true };
      })()`);
    } catch {
      return null;
    }
  }, 25000);

  if (!passFilled?.ok) {
    const pageText = await gClient.evaluate("(document.body&&document.body.innerText||'').slice(0,800)").catch(() => "");
    sessionClose?.();
    client.close();
    return { ok: false, email: account.email, error: "Password input not found / blocked", pageText };
  }
  log("password filled");

  await gClient.evaluate(`(() => {
    const plain = el => (el.innerText||el.textContent||'').replace(/\\s+/g,' ').trim();
    const visible = el => { const r=el.getBoundingClientRect(); const s=getComputedStyle(el); return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'; };
    const next = document.querySelector('#passwordNext') ||
      Array.from(document.querySelectorAll('button,div[role=button],input[type=submit]')).filter(visible)
        .find(el => {
          const t = plain(el) || el.getAttribute('aria-label') || '';
          return t === 'Next' || t === '下一步' || t === '继续';
        });
    if (next) next.click();
    return Boolean(next);
  })()`);

  // Wait for return to dola or consent
  const deadline = Date.now() + opts.timeoutMs;
  let state = { url: "", text: "" };
  while (Date.now() < deadline) {
    // refresh page list - maybe oauth closed google tab
    const list = await cdpJson(cdp, "/json/list");
    const dola = list.find((t) => t.type === "page" && /dola\.com/i.test(t.url || ""));
    const google = list.find((t) => t.type === "page" && /accounts\.google|google\.com\/signin/i.test(t.url || ""));

    // Google intermediate pages: workspace TOS / consent / continue
    if (google?.webSocketDebuggerUrl) {
      try {
        if (gClient.wsUrl !== google.webSocketDebuggerUrl) {
          sessionClose?.();
          gClient = new CdpClient(google.webSocketDebuggerUrl);
          await gClient.connect();
          await gClient.send("Runtime.enable");
          await gClient.send("Page.enable");
          sessionClose = () => gClient.close();
        }
        const gUrl = google.url || "";
        const clickedGoogle = await gClient.evaluate(`(() => {
          const plain = el => (el.innerText||el.textContent||el.getAttribute('aria-label')||'').replace(/\\s+/g,' ').trim();
          const visible = el => { const r=el.getBoundingClientRect(); const s=getComputedStyle(el); return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'; };
          const url = location.href;
          const body = plain(document.body).slice(0, 500);
          const buttons = Array.from(document.querySelectorAll('button,div[role=button],input[type=submit],a')).filter(visible);
          // Workspace education welcome / terms
          const prefer = [
            'I understand', 'I agree', 'Accept', 'Accept all', 'Agree',
            'Continue', 'Next', 'Allow',
            '我了解', '我同意', '同意', '继续', '下一步', '接受', '允许',
          ];
          let el = null;
          for (const label of prefer) {
            el = buttons.find(b => plain(b) === label || plain(b).toLowerCase() === label.toLowerCase());
            if (el) break;
          }
          if (!el) {
            el = buttons.find(b => {
              const t = plain(b);
              return t.length <= 40 && /understand|agree|accept|continue|allow|同意|继续|了解|接受|允许|下一步/i.test(t);
            });
          }
          // Checkbox agree if present
          const checks = Array.from(document.querySelectorAll('input[type=checkbox]')).filter(visible);
          for (const c of checks) {
            if (!c.checked) c.click();
          }
          if (el) {
            el.click();
            return { ok:true, text: plain(el), url, body };
          }
          return { ok:false, url, body, buttons: buttons.map(b => plain(b)).filter(Boolean).slice(0, 20) };
        })()`).catch((e) => ({ ok: false, error: e.message }));
        if (clickedGoogle?.ok) log(`google intermediate click: ${clickedGoogle.text} @ ${gUrl.slice(0, 80)}`);
        else if (clickedGoogle?.body) log(`google page: ${String(clickedGoogle.body).slice(0, 160)}`);
      } catch {}
    }

    // check dola login state via cookies
    if (dola?.webSocketDebuggerUrl) {
      try {
        // use Network.getAllCookies from current client if still valid, else attach dola
        let cookieClient = client;
        if (page.id !== dola.id) {
          // Network.getCookies works on browser domain via page session too when enabled
        }
        const all = await client.send("Network.getAllCookies").catch(async () => {
          // reconnect to dola tab
          const dc = new CdpClient(dola.webSocketDebuggerUrl);
          await dc.connect();
          await dc.send("Network.enable");
          const r = await dc.send("Network.getAllCookies");
          dc.close();
          return r;
        });
        const cookies = (all.cookies || []).filter((c) => /dola\.com|bytedance|byteoversea|tiktok|capcut|pipo|snssdk/i.test(c.domain || ""));
        if (hasDolaSession(all.cookies || []) || hasDolaSession(cookies)) {
          const full = all.cookies || [];
          const dolaRelated = full.filter((c) =>
            /dola\.com|bytedance|byteoversea|tiktok|capcut|snssdk|byteimg|ttwid|passport/i.test(
              `${c.domain || ""} ${c.name || ""}`
            )
          );
          // Prefer exporting all cookies that help dola session (including .dola.com and related SSO)
          const exportCookies = dolaRelated.length ? dolaRelated : full.filter((c) => /dola\.com/i.test(c.domain || ""));
          mkdirSync(outDir, { recursive: true });
          // filename from email local part
          const safe = account.email.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 40);
          // next free dola_N or email-based
          let outName = `dola_${safe}.txt`;
          let outPath = path.join(outDir, outName);
          writeFileSync(outPath, cookieToNetscape(exportCookies), "utf8");
          log(`exported ${exportCookies.length} cookies -> ${outPath}`);
          // also verify session names
          const names = exportCookies.map((c) => c.name);
          sessionClose?.();
          client.close();
          return {
            ok: true,
            email: account.email,
            file: outPath,
            cookieCount: exportCookies.length,
            hasSession: hasDolaSession(exportCookies) || hasDolaSession(full),
            names: names.slice(0, 40),
          };
        }
        state = {
          url: dola.url,
          text: await (async () => {
            try {
              const dc = new CdpClient(dola.webSocketDebuggerUrl);
              await dc.connect();
              await dc.send("Runtime.enable");
              const t = await dc.evaluate("(document.body&&document.body.innerText||'').slice(0,400)");
              dc.close();
              return t;
            } catch {
              return "";
            }
          })(),
        };
        if (/Log In|登录|Continue with Google/i.test(state.text || "") === false && /New Chat|新对话|How can I assist/i.test(state.text || "")) {
          // maybe logged in without classic session cookie names yet - dump all cookies anyway after short wait
        }
      } catch (e) {
        log(`cookie poll warn: ${e.message}`);
      }
    }

    // Detect Google challenge
    try {
      const gText = await gClient.evaluate("(document.body&&document.body.innerText||'').slice(0,500)");
      if (/verify|unusual|captcha|phone|2-step|两步|验证|恢复|不支持此浏览器|browser or app may not be secure|couldn't sign you in/i.test(gText || "")) {
        sessionClose?.();
        client.close();
        return { ok: false, email: account.email, error: "Google challenge / blocked", pageText: gText };
      }
    } catch {}

    await sleep(1500);
  }

  sessionClose?.();
  client.close();
  return { ok: false, email: account.email, error: "Timeout waiting for dola session cookies", last: state };
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(`node google_login_export_cookies.mjs --accounts google_mail.txt --out G:\\cookies\\dola --cdp http://127.0.0.1:9223 --limit 1`);
    return;
  }
  // CDP health
  const origin = new URL(args.cdp).origin;
  try {
    await fetch(`${origin}/json/version`);
  } catch {
    throw new Error(`CDP not reachable: ${args.cdp}. Start Chrome with --remote-debugging-port first.`);
  }

  const all = loadAccounts(args.accounts);
  const slice = all.slice(args.start, args.start + args.limit);
  if (!slice.length) throw new Error("No accounts selected");
  mkdirSync(args.out, { recursive: true });

  console.log(`[dola-login] accounts=${slice.length} out=${args.out} cdp=${args.cdp}`);
  const results = [];
  for (const acc of slice) {
    console.log(`\n=== ${acc.email} ===`);
    try {
      const r = await loginOne(args.cdp, acc, args.out, args);
      results.push(r);
      console.log(JSON.stringify(r, null, 2));
    } catch (e) {
      const r = { ok: false, email: acc.email, error: e.message };
      results.push(r);
      console.error(r);
    }
    await sleep(2000);
  }
  const summaryPath = path.join(args.out, `login_summary_${Date.now()}.json`);
  writeFileSync(summaryPath, JSON.stringify(results, null, 2), "utf8");
  console.log(`\n[dola-login] summary -> ${summaryPath}`);
  const ok = results.filter((r) => r.ok).length;
  if (!ok) process.exitCode = 2;
}

main().catch((e) => {
  console.error("[dola-login] failed:", e.stack || e.message);
  process.exit(1);
});
