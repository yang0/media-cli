import { isConcreteChatUrl } from './session.js';
import { sleep } from './utils.js';

export function cdpHttpUrl(cdp, pathname) {
  const base = new URL(cdp);
  return `${base.origin}${pathname}`;
}

export class CdpClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.id = 1;
    this.pending = new Map();
    this.events = new Map();
  }

  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    this.ws.onmessage = event => this.handleMessage(String(event.data));
    this.ws.onerror = () => {};
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`CDP WebSocket timeout: ${this.wsUrl}`)), 15000);
      this.ws.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      this.ws.onclose = () => {
        clearTimeout(timer);
        reject(new Error(`CDP WebSocket closed before opening: ${this.wsUrl}`));
      };
    });
  }

  handleMessage(raw) {
    const msg = JSON.parse(raw);
    if (msg.id && this.pending.has(msg.id)) {
      const { resolve, reject, timer } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      clearTimeout(timer);
      if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else resolve(msg.result || {});
      return;
    }
    if (msg.method && this.events.has(msg.method)) {
      for (const fn of this.events.get(msg.method)) fn(msg.params || {});
    }
  }

  on(method, fn) {
    if (!this.events.has(method)) this.events.set(method, new Set());
    this.events.get(method).add(fn);
  }

  send(method, params = {}, options = {}) {
    const id = this.id++;
    const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 60000;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  close() {
    this.ws?.close();
  }
}

export async function findOrCreateTarget(cdp, sessionUrl, forceNew = false, preferExistingDola = false) {
  const targets = await fetch(cdpHttpUrl(cdp, "/json/list")).then(r => r.json());
  if (preferExistingDola) {
    const existing = targets.find(item => item.type === "page" && /(^|\.)dola\.com\/chat/i.test(item.url || ""));
    if (existing) return existing;
  }
  if (!forceNew) {
    const exact = targets.find(item => item.type === "page" && item.url === sessionUrl);
    if (exact) return exact;
  }

  const createPath = `/json/new?${encodeURIComponent(sessionUrl)}`;
  const created = await fetch(cdpHttpUrl(cdp, createPath), { method: "PUT" })
    .then(r => r.ok ? r.json() : fetch(cdpHttpUrl(cdp, createPath)).then(rr => rr.json()));
  const otherDolaPages = targets.filter(item =>
    item.type === "page"
    && item.id !== created.id
    && /(^|\.)dola\.com\//i.test(item.url || "")
  );
  await Promise.all(otherDolaPages.map(item =>
    fetch(cdpHttpUrl(cdp, `/json/close/${encodeURIComponent(item.id)}`)).catch(() => null)
  ));
  if (otherDolaPages.length) console.log(`[dola-cli] closed ${otherDolaPages.length} other Dola tab(s)`);
  return created;
}

export async function evaluate(client, expression, awaitPromise = true) {
  const result = await client.send("Runtime.evaluate", {
    expression,
    awaitPromise,
    returnByValue: true,
    userGesture: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || "Runtime.evaluate failed.");
  }
  return result.result?.value;
}

export async function waitForPageReady(client, timeoutMs = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const ready = await evaluate(client, `document.readyState`).catch(() => "");
    if (ready === "interactive" || ready === "complete") return;
    await sleep(500);
  }
}

export async function waitForConcreteChatUrl(client, initialUrl, timeoutMs = 60000) {
  const started = Date.now();
  let lastUrl = initialUrl;
  while (Date.now() - started < timeoutMs) {
    lastUrl = await evaluate(client, "location.href").catch(() => lastUrl);
    if (isConcreteChatUrl(lastUrl)) return lastUrl;
    await sleep(1000);
  }
  return lastUrl;
}

export async function waitForComposer(client, timeoutMs = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const ready = await evaluate(client, `(() => {
      const visible = el => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      };
      return Boolean(
        Array.from(document.querySelectorAll("textarea, [contenteditable='true'], [role='textbox']")).some(visible)
        || document.querySelector("input[type=file]")
      );
    })()`).catch(() => false);
    if (ready) return;
    await sleep(1000);
  }
  throw new Error(`Dola composer/file input did not appear within ${timeoutMs}ms.`);
}

export async function pageSnapshot(client) {
  return evaluate(client, `(() => ({
    title: document.title,
    url: location.href,
    textTail: (document.body.innerText || "").slice(-2500),
    inputCount: document.querySelectorAll("textarea, input[type='text'], [contenteditable='true'], [role='textbox']").length,
    fileInputCount: document.querySelectorAll("input[type=file]").length,
  }))()`);
}

export async function uiSnapshot(client) {
  return evaluate(client, `(() => {
    const visible = el => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    const rectOf = el => {
      const rect = el.getBoundingClientRect();
      return { x: rect.x, y: rect.y, w: rect.width, h: rect.height };
    };
    return {
      url: location.href,
      active: document.activeElement?.outerHTML?.slice(0, 300) || "",
      inputs: Array.from(document.querySelectorAll("textarea, input, [contenteditable='true'], [role='textbox']"))
        .filter(visible)
        .map(el => ({
          tag: el.tagName,
          id: el.id || "",
          className: String(el.className).slice(0, 180),
          type: el.getAttribute("type") || "",
          role: el.getAttribute("role") || "",
          aria: el.getAttribute("aria-label") || "",
          placeholder: el.getAttribute("placeholder") || "",
          value: (el.value || el.innerText || el.textContent || "").slice(0, 160),
          rect: rectOf(el),
        })),
      buttons: Array.from(document.querySelectorAll("button, [role='button'], [aria-label], [title]"))
        .filter(visible)
        .map(el => ({
          tag: el.tagName,
          id: el.id || "",
          className: String(el.className).slice(0, 180),
          text: (el.innerText || el.textContent || el.getAttribute("aria-label") || el.title || "").trim().slice(0, 160),
          aria: el.getAttribute("aria-label") || "",
          title: el.title || "",
          disabled: Boolean(el.disabled || el.getAttribute("aria-disabled")),
          dataValue: el.getAttribute("data-value") || "",
          actionKey: el.getAttribute("data-input-engine-actionbar-control-key") || "",
          rect: rectOf(el),
        }))
        .slice(-120),
    };
  })()`);
}
