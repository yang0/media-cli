/**
 * ChatGPT.com image generation helpers via CDP.
 * Logic ported from G:\初中\generate_wenyuan_grade8_images.mjs
 * (selectors / send / wait / download proven on real batches).
 */

import { mkdirSync } from 'node:fs';
import { writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { CDP, jsonFetch } from './cdp.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Injected page helpers for image-gen DOM. */
export const PAGE_HELPERS = `window.__cgi={
  before:new Set(),
  beforeText:new Set(),
  imgs(){
    return [...document.querySelectorAll('[class~="group/imagegen-image"] img')]
      .map(x=>x.currentSrc).filter(Boolean);
  },
  texts(){
    return [...document.querySelectorAll('[data-message-author-role="assistant"]')]
      .map(x=>(x.innerText||x.textContent||'').trim()).filter(Boolean);
  },
  mark(){ this.before=new Set(this.imgs()); this.beforeText=new Set(this.texts()); },
  newImg(){ return this.imgs().filter(x=>!this.before.has(x)).at(-1)||null; },
  newText(){ return this.texts().filter(x=>!this.beforeText.has(x)).at(-1)||null; },
  send(){
    const b=document.querySelector('[data-testid="send-button"]')
      ||[...document.querySelectorAll('button')].find(x=>/send|发送/i.test((x.ariaLabel||'')+' '+x.textContent)&&!x.disabled);
    if(!b) return false;
    b.click();
    return true;
  }
};`;

export async function waitComposer(cdp, seconds = 45) {
  const end = Date.now() + seconds * 1000;
  while (Date.now() < end) {
    try {
      const ok = await cdp.evaluate(`(() => !![...document.querySelectorAll(
        '#prompt-textarea,textarea:not([hidden]),[contenteditable=true]'
      )].find(x => x.getClientRects().length))()`);
      if (ok) return true;
    } catch {
      // page may still be loading
    }
    await sleep(1000);
  }
  throw new Error('等待 ChatGPT 输入框超时（请确认已登录 chatgpt.com）');
}

/**
 * Connect to an existing Chrome with remote debugging.
 * Prefer an open chatgpt.com tab; otherwise open a new one.
 */
export async function connectChatGPT(port, { newTab = false } = {}) {
  const base = `http://127.0.0.1:${port}`;
  let page;
  if (newTab) {
    page = await jsonFetch(`${base}/json/new?https://chatgpt.com/`, { method: 'PUT' });
  } else {
    const tabs = await jsonFetch(`${base}/json/list`);
    page =
      tabs
        .filter((t) => t.type === 'page' && /^https:\/\/chatgpt\.com\//i.test(t.url))
        .at(-1) ||
      (await jsonFetch(`${base}/json/new?https://chatgpt.com/`, { method: 'PUT' }));
  }
  const cdp = new CDP(page.webSocketDebuggerUrl);
  await cdp.open();
  await cdp.call('Runtime.enable');
  await cdp.call('Page.enable');
  try {
    await cdp.call('Page.bringToFront');
  } catch {
    // optional
  }
  await waitComposer(cdp, newTab ? 60 : 25);
  await cdp.evaluate(PAGE_HELPERS);
  return { cdp, page };
}

export async function sendPrompt(cdp, prompt) {
  await waitComposer(cdp, 30);
  const focused = await cdp.evaluate(`(() => {
    const e = [...document.querySelectorAll(
      '#prompt-textarea,textarea:not([hidden]),[contenteditable=true]'
    )].find(x => x.getClientRects().length);
    if (!e) return false;
    e.focus();
    if (e.tagName === 'TEXTAREA') e.select();
    else {
      const r = document.createRange();
      r.selectNodeContents(e);
      const s = getSelection();
      s.removeAllRanges();
      s.addRange(r);
    }
    window.__cgiPrompt = e;
    return true;
  })()`);
  if (!focused) throw new Error('找不到 ChatGPT 输入框');

  await cdp.call('Input.insertText', { text: prompt });

  const expected = prompt.length;
  let actual = 0;
  for (let i = 0; i < 20; i++) {
    actual = await cdp.evaluate(`(() => {
      const e = window.__cgiPrompt;
      if (!e) return 0;
      return (e.value ?? e.innerText ?? e.textContent ?? '').length;
    })()`);
    if (actual >= expected) break;
    await sleep(500);
  }
  if (actual < expected) {
    throw new Error(`提示词未完整写入输入框：${actual}/${expected}`);
  }

  for (let i = 0; i < 30; i++) {
    if (await cdp.evaluate('window.__cgi.send()')) return;
    await sleep(1000);
  }
  throw new Error('无法点击发送按钮');
}

/**
 * Wait for a new imagegen image, with grace period after the main timeout.
 * Returns { kind:'image', url } or { kind:'text', text }.
 */
export async function waitImage(cdp, waitSeconds = 300, graceSeconds = 120) {
  const end = Date.now() + waitSeconds * 1000;
  while (Date.now() < end) {
    const url = await cdp.evaluate('window.__cgi.newImg()').catch(() => null);
    if (url) return { kind: 'image', url };
    await sleep(1000);
  }

  const graceEnd = Date.now() + graceSeconds * 1000;
  while (Date.now() < graceEnd) {
    const url = await cdp.evaluate('window.__cgi.newImg()').catch(() => null);
    if (url) return { kind: 'image', url };
    await sleep(1000);
  }

  const text = await cdp.evaluate('window.__cgi.newText()').catch(() => null);
  // Intermediate status strings are not final text replies.
  if (
    text &&
    !/正在思考|正在生成|生成中|分析中|处理中|请稍候|思考中|generating|thinking|loading/i.test(
      text,
    )
  ) {
    return { kind: 'text', text };
  }
  throw new Error('等待生图超时');
}

/** Download image URL through the page session (cookies included). */
export async function downloadImage(cdp, url, outDir, basename) {
  const dataUrl = await cdp.evaluate(
    `(async () => {
      const r = await fetch(${JSON.stringify(url)}, { credentials: 'include' });
      const b = await r.blob();
      const f = new FileReader();
      return await new Promise((ok, no) => {
        f.onload = () => ok(f.result);
        f.onerror = no;
        f.readAsDataURL(b);
      });
    })()`,
    true,
  );
  const match = String(dataUrl).match(/^data:image\/([^;]+);base64,(.+)$/);
  if (!match) throw new Error('图片数据异常（非 data:image base64）');

  const mime = match[1];
  const ext = mime.includes('webp')
    ? '.webp'
    : mime.includes('jpeg')
      ? '.jpg'
      : '.png';
  mkdirSync(outDir, { recursive: true });
  const tmp = join(outDir, `.${basename}.downloading${ext}`);
  const out = join(outDir, basename + ext);
  await writeFile(tmp, Buffer.from(match[2], 'base64'));
  await rename(tmp, out);
  return out;
}

/**
 * One-shot: mark → send prompt → wait image → download.
 * On text reply or error, caller may reconnect with newTab and retry.
 */
export async function generateOnce(cdp, prompt, { outDir, basename, waitSeconds }) {
  await cdp.evaluate('window.__cgi.mark()');
  await sendPrompt(cdp, prompt);
  const result = await waitImage(cdp, waitSeconds);
  if (result.kind === 'text') return result;
  const path = await downloadImage(cdp, result.url, outDir, basename);
  return { kind: 'image', path, url: result.url };
}
