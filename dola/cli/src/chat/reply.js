import { evaluate } from '../cdp.js';
import { DolaCliError } from '../errors.js';
import { normalizeImageKey } from '../media/urls.js';
import { sleep } from '../utils.js';

export async function lastReplySnapshot(client) {
  const snapshot = await evaluate(client, `(() => {
    const visible = el => {
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    const rectOf = el => {
      const rect = el.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom, height: rect.height, width: rect.width, area: rect.width * rect.height };
    };
    const textOf = el => (el.innerText || el.textContent || "").replace(/\\s+/g, " ").trim();
    const inputBoxes = Array.from(document.querySelectorAll("textarea, input[type='text'], [contenteditable='true'], [role='textbox']")).filter(visible);
    const composerTop = inputBoxes.length ? Math.min(...inputBoxes.map(el => el.getBoundingClientRect().top)) : Number.POSITIVE_INFINITY;
     const generatedImageSelector = 'img[alt="image"][data-track-key], video[src], video source[src]';
    const messageSelector = [
      "[data-message-id]",
      "[data-testid*='message' i]",
      "[class*='message' i]",
      "[class*='chat-item' i]",
      "[class*='bubble' i]",
      "[class*='answer' i]",
      "[class*='assistant' i]",
      "article"
    ].join(",");
    const isUiChrome = el => {
      const tag = el.tagName;
      if (["BUTTON", "NAV", "HEADER", "FOOTER", "ASIDE", "TEXTAREA", "INPUT", "SELECT", "OPTION"].includes(tag)) return true;
      if (el.closest("button, nav, header, footer, aside")) return true;
      return false;
    };
    const nearestMessage = el => el.closest(messageSelector)
      || el.closest("[class*='container-' i], [class*='wrapper' i], [class*='content' i]")
      || el.parentElement;
    const raw = [];
    for (const img of Array.from(document.querySelectorAll(generatedImageSelector)).filter(visible)) {
      const node = nearestMessage(img);
      if (node) raw.push(node);
    }
    for (const node of Array.from(document.querySelectorAll(messageSelector)).filter(visible)) raw.push(node);
    for (const node of Array.from(document.querySelectorAll("div, section, article, li")).filter(visible)) {
      if (isUiChrome(node)) continue;
      const rect = node.getBoundingClientRect();
      if (rect.bottom > composerTop - 4) continue;
      const text = textOf(node);
      const hasGeneratedImage = Boolean(node.querySelector(generatedImageSelector));
      if (hasGeneratedImage || (text.length >= 4 && text.length <= 1200 && rect.height <= window.innerHeight * 0.75)) raw.push(node);
    }
    const candidates = Array.from(new Set(raw))
      .filter(node => visible(node) && !isUiChrome(node))
      .map(node => {
        const rect = rectOf(node);
        const text = textOf(node);
         const imgs = Array.from(node.querySelectorAll(generatedImageSelector))
          .filter(visible)
           .filter(img => img.tagName === "VIDEO" || img.naturalWidth >= 128 && img.naturalHeight >= 128)
          .map(img => ({
             url: img.currentSrc || img.src || img.getAttribute("src") || "",
            key: img.getAttribute("data-track-key") || "",
            width: img.naturalWidth,
            height: img.naturalHeight
          }));
        const idSource = [
          node.getAttribute("data-message-id"),
          node.getAttribute("data-messageid"),
          node.id,
          node.getAttribute("data-track-key"),
          ...imgs.map(img => img.key)
        ].filter(Boolean).join(" ");
        const messageMatch = /(?:^|\\D)(\\d{8,})(?:\\D|$)/.exec(idSource);
        return { text, imgs, rect, messageId: messageMatch ? messageMatch[1] : "", html: node.outerHTML.slice(0, 300) };
      })
      .filter(item => item.rect.bottom <= composerTop - 4 && (item.text || item.imgs.length))
      .filter(item => item.rect.area <= window.innerWidth * window.innerHeight * 1.5)
      .sort((a, b) => (b.rect.bottom - a.rect.bottom) || (b.rect.top - a.rect.top) || (a.rect.area - b.rect.area));
    const last = candidates[0] || null;
    if (!last) return { text: "", images: [], imageKeys: [], imageUrls: [], messageId: "", signature: "" };
    const imageKeys = Array.from(new Set(last.imgs.map(img => img.key).filter(Boolean)));
    const imageUrls = Array.from(new Set(last.imgs.map(img => img.url).filter(Boolean)));
    const signature = [last.messageId, last.text, imageKeys.join("|"), imageUrls.join("|")].join("\\n").slice(0, 2000);
    return {
      text: last.text.slice(0, 1200),
      images: last.imgs,
      imageKeys,
      imageUrls,
      messageId: last.messageId,
      signature,
      rect: last.rect
    };
  })()`).catch(() => null);
  const normalizedKeys = new Set();
  for (const key of snapshot?.imageKeys || []) {
    const normalized = normalizeImageKey(key);
    if (normalized) normalizedKeys.add(normalized);
  }
  for (const url of snapshot?.imageUrls || []) {
    const normalized = normalizeImageKey(url);
    if (normalized) normalizedKeys.add(normalized);
  }
  return {
    text: snapshot?.text || "",
    images: Array.isArray(snapshot?.images) ? snapshot.images : [],
    imageKeys: [...normalizedKeys],
    imageUrls: Array.isArray(snapshot?.imageUrls) ? snapshot.imageUrls : [],
    messageId: snapshot?.messageId || "",
    signature: snapshot?.signature || "",
    rect: snapshot?.rect || null,
  };
}

export function classifyImageGenerationTextError(text) {
  const value = String(text || "").trim();
  // Generation progress text should not be misclassified as a hard failure.
  // Exception: explicit zero remaining quota is actionable for account rotation.
  if (/今日剩余\s*0\s*个|剩余\s*0\s*个(?:视频|图像|图片)?生成额度|额度不足|次数用完|没有剩余额度/i.test(value)
    || /no\s+quota|quota\s+exhausted|out\s+of\s+credits|0\s+remaining/i.test(value)) {
    return "IMAGE_GENERATION_QUOTA_EXHAUSTED";
  }
  if (looksLikeImageGenerationProgress(value)) return "IMAGE_GENERATION_TEXT_RESPONSE";
  // Use unicode escapes so source encoding never breaks Chinese matchers.
  if (/(?:\u8d26\u53f7|\u8d26\u6237).{0,8}(?:\u53d7\u9650|\u5c01\u7981|\u5c01\u53f7)|account.*(?:restricted|suspended|disabled)|too many requests|rate limit/i.test(value)) {
    return "ACCOUNT_RESTRICTED";
  }
  if (/quota|credits?|\u914d\u989d|\u989d\u5ea6|\u6b21\u6570|\u4eca\u65e5.*\u7528\u5b8c|\u5df2\u7528\u5b8c|\u4e0a\u9650|\u7528\u5c3d/i.test(value)) {
    return "IMAGE_GENERATION_QUOTA_EXHAUSTED";
  }
  if (/(?:\u65e0\u6cd5\u751f\u6210|\u4e0d\u80fd\u751f\u6210|\u751f\u6210\u4e0d\u4e86|\u62d2\u7edd|\u8fdd\u89c4|\u5b89\u5168)|policy|cannot|can't|unable|refus/i.test(value)) {
    return "IMAGE_GENERATION_REFUSED";
  }
  if (value) return "IMAGE_GENERATION_TEXT_RESPONSE";
  return "IMAGE_GENERATION_NO_IMAGE";
}

export function isAccountRestrictedError(error) {
  return ["ACCOUNT_RESTRICTED", "IMAGE_GENERATION_QUOTA_EXHAUSTED", "ACCOUNT_COOKIE_INVALID"].includes(error?.code);
}

export function looksLikeImageGenerationProgress(text) {
  const value = String(text || "");
  return /generate(?:d|ing)?\s+image|will\s+generate|starting\s+to\s+generate|generating/i.test(value)
    || /(?:\u6b63\u5728\u4e3a\u60a8\u751f\u6210|\u751f\u6210\u4e2d|\u9884\u8ba1\u7b49\u5f85)/i.test(value)
    || /video\s+generation.*(?:need|take|minute)|(?:video|video generation).*(?:generating|completed|ready|send)/i.test(value)
    || /(?:\u6b63\u5728\u4e3a\u60a8\u751f\u6210\u89c6\u9891|\u4f60\u7684\u89c6\u9891\u751f\u6210\u597d\u4e86)/i.test(value);
}

/** Parse soft remaining-quota hints from Dola replies for proactive rotation. */

export function parseRemainingQuota(text) {
  const value = String(text || "");
  const patterns = [
    /今日剩余\s*(\d+)\s*个(?:视频|图像|图片)?生成额度/i,
    /剩余\s*(\d+)\s*个(?:视频|图像|图片)?生成额度/i,
    /remaining\s*[:=]?\s*(\d+)/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(value);
    if (match) return Number(match[1]);
  }
  return null;
}

export function looksLikePromptEcho(text, promptText) {
  const compact = value => String(value || "").replace(/\s+/g, " ").trim();
  const reply = compact(text);
  const prompt = compact(promptText);
  if (!reply || !prompt) return false;
  return reply === prompt || reply.includes(prompt.slice(0, 300)) || prompt.includes(reply.slice(0, 300));
}

export async function imageGenerationUiSnapshot(client) {
  // Keep selectors narrow — broad [class*='message'] scans freeze CDP after large attachments.
  return evaluate(client, `(() => {
    const visible = el => {
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    const loading = Array.from(document.querySelectorAll("[data-loading='true'], [aria-busy='true'], [data-generating='true'], [data-pending='true']"))
      .filter(visible)
      .slice(0, 12)
      .map(el => ({ tag: el.tagName, id: el.id || "", className: String(el.className || "").slice(0, 80) }));
    const messageNodes = Array.from(document.querySelectorAll("[data-message-id], [data-messageid]"))
      .filter(visible)
      .slice(-20)
      .map(el => ({
        id: el.getAttribute("data-message-id") || el.getAttribute("data-messageid") || el.id || "",
        className: String(el.className || "").slice(0, 80),
        role: el.getAttribute("data-role") || el.getAttribute("data-message-role") || "",
        children: el.childElementCount,
        images: el.querySelectorAll("img[alt='image'][data-track-key]").length,
      }));
    const assistantNodes = messageNodes.filter(item => /assistant|answer|bot|ai/i.test(item.className + " " + item.role));
    const send = document.querySelector("#flow-end-msg-send");
    const input = Array.from(document.querySelectorAll("textarea, [contenteditable='true'], [role='textbox']"))
      .filter(visible).at(-1);
    return {
      loading,
      busy: loading.length > 0,
      messageCount: messageNodes.length,
      assistantCount: assistantNodes.length,
      assistantShape: assistantNodes.slice(-3),
      generatedImageCount: document.querySelectorAll("img[alt='image'][data-track-key], video[src]").length,
      send: send ? { disabled: Boolean(send.disabled), ariaDisabled: send.getAttribute("aria-disabled") || "", loading: send.getAttribute("data-loading") || "" } : null,
      inputEmpty: !input || !(input.value || input.innerText || input.textContent || "").trim(),
    };
  })()`);
}

export async function waitForImageGenerationComplete(client, options) {
  const started = Date.now();
  const before = options.beforeGenerationUi || await imageGenerationUiSnapshot(client);
  let activitySeen = false;
  let lastShape = "";
  let lastShapeChange = Date.now();
  while (Date.now() - started < options.timeout) {
    const state = await imageGenerationUiSnapshot(client).catch(() => null);
    if (!state) {
      await sleep(1000);
      continue;
    }
    const shape = JSON.stringify({
      loading: state.loading,
      messageCount: state.messageCount,
      assistantCount: state.assistantCount,
      assistantShape: state.assistantShape,
      generatedImageCount: state.generatedImageCount,
      send: state.send,
    });
    if (shape !== lastShape) {
      lastShape = shape;
      lastShapeChange = Date.now();
    }
    const responseNodeAdded = state.assistantCount > (before?.assistantCount || 0)
      || state.generatedImageCount > (before?.generatedImageCount || 0);
    const messageAdded = state.messageCount >= (before?.messageCount || 0) + 2;
    if (state.busy || responseNodeAdded || messageAdded) activitySeen = true;
    const stable = Date.now() - lastShapeChange >= options.stable;
    const noLongerBusy = !state.busy;
    if (activitySeen && noLongerBusy && stable) {
      console.log(`[dola-cli] image generation UI complete (busy=${state.busy}, assistants=${state.assistantCount}, images=${state.generatedImageCount})`);
      return state;
    }
    await sleep(1000);
  }
  throw new DolaCliError("IMAGE_GENERATION_TIMEOUT", `Timed out after ${options.timeout}ms waiting for Dola image generation to finish.`);
}
