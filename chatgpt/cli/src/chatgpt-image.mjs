/**
 * ChatGPT.com image generation helpers via CDP.
 * ChatGPT image-generation and download logic.
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
  realSrc(i){
    const s=(i.currentSrc||i.src||'');
    if(!s) return '';
    // 只认真实生成图 URL（backend-api/estuary 或 oaidalle blob 或 data:image），排除占位/空
    return (s.includes('backend-api/estuary')||s.includes('oaidalleapiprod')||s.includes('blob.core.windows.net')||s.startsWith('data:image')) ? s : '';
  },
  imgs(){
    // 只统计已加载（naturalWidth>0）的真实生成图——懒加载/占位图一律不算
    return [...document.querySelectorAll('[class~="group/imagegen-image"] img')]
      .filter(i=>i.naturalWidth>0)
      .map(x=>this.realSrc(x)).filter(Boolean);
  },
  texts(){
    return [...document.querySelectorAll('[data-message-author-role="assistant"]')]
      .map(x=>(x.innerText||x.textContent||'').trim()).filter(Boolean);
  },
  mark(){ this.before=new Set(this.imgs()); this.beforeText=new Set(this.texts()); },
  newImg(){ return this.imgs().filter(x=>!this.before.has(x)).at(-1)||null; },
  newText(){ return this.texts().filter(x=>!this.beforeText.has(x)).at(-1)||null; },
  send(){
    const sels=[
      '[data-testid="send-button"]',
      '[data-testid="composer-send-button"]',
      '[data-testid="send-prompt-button"]',
      'button[aria-label*="Send" i]',
      'button[aria-label*="发送"]',
      'button[title*="发送"]',
      'button[title*="Send" i]',
    ];
    for(const sel of sels){
      const b=document.querySelector(sel);
      if(b&&!b.disabled){ b.click(); return true; }
    }
    const b=[...document.querySelectorAll('button')].find(x=>
      /send|发送|submit/i.test((x.ariaLabel||'')+' '+(x.textContent||'')+' '+(x.title||''))&&!x.disabled);
    if(b){ b.click(); return true; }
    return false;
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

/** 关闭所有 chatgpt.com 页签，只保留 keepId（或第一个）；避免多 tab 选错/历史图污染 */
async function pruneChatGPTTabs(base, keepId) {
  let tabs;
  try {
    tabs = await jsonFetch(`${base}/json/list`);
  } catch {
    return;
  }
  const chatgptTabs = tabs.filter(
    (t) => t.type === 'page' && /^https:\/\/chatgpt\.com\//i.test(t.url),
  );
  if (chatgptTabs.length <= 1) return;
  const kept = chatgptTabs.find((t) => t.id === keepId) || chatgptTabs[0];
  let closed = 0;
  for (const t of chatgptTabs) {
    if (t.id === kept.id || !t?.id) continue;
    try {
      const r = await fetch(`${base}/json/close/${encodeURIComponent(t.id)}`, {
        signal: AbortSignal.timeout(5000),
      });
      if (r.ok) closed += 1;
    } catch {
      // best effort
    }
  }
  if (closed > 0) console.log(`[prune] 关闭 ${closed} 个多余 ChatGPT 标签页`);
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
  // 关闭其他 chatgpt 页签，只保留将要使用的这一个
  await pruneChatGPTTabs(base, page?.id);
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

/** 等待输入框就绪且稳定：可见、可编辑、内容在 1s 内不再变化（React 已挂载完成） */
async function waitInputReady(cdp, seconds = 20) {
  const end = Date.now() + seconds * 1000;
  let prev = null;
  while (Date.now() < end) {
    try {
      const s = await cdp.evaluate(`(() => {
        const e = [...document.querySelectorAll(
          '#prompt-textarea,textarea:not([hidden]),[contenteditable=true]'
        )].find(x => x.getClientRects().length);
        if (!e) return null;
        if (e.getAttribute('contenteditable') === 'false') return null;
        if (e.getAttribute('aria-disabled') === 'true' || e.disabled) return null;
        // 输入框上方若有"正在加载"遮罩也视为未就绪
        const text = (e.value ?? e.innerText ?? e.textContent ?? '').trim();
        return { len: text.length, tag: e.tagName };
      })()`);
      if (s) {
        if (prev && prev.len === s.len) return true; // 连续两次内容一致 = 稳定
        prev = s;
      } else {
        prev = null;
      }
    } catch {
      // page may still be loading
    }
    await sleep(600);
  }
  throw new Error('等待 ChatGPT 输入框就绪超时（页面可能未刷新完）');
}

/** 清空输入框残留内容（防上次失败/重试时追加污染） */
async function clearInput(cdp) {
  return await cdp.evaluate(`(() => {
    const e = [...document.querySelectorAll(
      '#prompt-textarea,textarea:not([hidden]),[contenteditable=true]'
    )].find(x => x.getClientRects().length);
    if (!e) return false;
    e.focus();
    if (e.tagName === 'TEXTAREA') {
      e.select();
      document.execCommand('delete');
      return (e.value ?? '').length === 0;
    }
    const r = document.createRange();
    r.selectNodeContents(e);
    const s = getSelection();
    s.removeAllRanges();
    s.addRange(r);
    document.execCommand('delete');
    e.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
    return (e.innerText ?? e.textContent ?? '').trim().length === 0;
  })()`);
}

export async function sendPrompt(cdp, prompt) {
  await waitComposer(cdp, 30);
  // 关键：等输入框真正就绪（React/ProseMirror 挂载稳定）再填写，避免写入被吞
  await waitInputReady(cdp, 20);
  // 写入前清空残留（失败重试/历史残留的 prompt 不能追加混入）
  try { await clearInput(cdp); } catch { /* best-effort */ }
  await sleep(300);

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

  // 写入验证：重新查询所有输入框取最大长度（防元素引用失效/React 重渲染）
  const expected = prompt.length;
  let actual = 0;
  for (let i = 0; i < 20; i++) {
    actual = await cdp.evaluate(`(() => {
      const all = [...document.querySelectorAll(
        '#prompt-textarea,textarea:not([hidden]),[contenteditable=true]'
      )].filter(x => x.getClientRects().length);
      return Math.max(0, ...all.map(e => (e.value ?? e.innerText ?? e.textContent ?? '').length));
    })()`);
    if (actual >= expected) break;
    await sleep(500);
  }
  if (actual < expected) {
    throw new Error(`提示词未完整写入输入框：${actual}/${expected}（页面可能未刷新完，将重试）`);
  }

  // 提交：按钮（多选择器）→ Enter → Ctrl+Enter 多策略
  let sent = false;
  for (let i = 0; i < 15; i++) {
    if (await cdp.evaluate('window.__cgi.send()')) { sent = true; break; }
    await sleep(800);
  }
  if (!sent) {
    // 兜底 1：Enter（ChatGPT 默认 Enter 发送）
    for (const type of ['keyDown', 'keyUp']) {
      await cdp.call('Input.dispatchKeyEvent', {
        type, key: 'Enter', code: 'Enter',
        windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
      });
    }
    await sleep(1500);
    // 兜底 2：Ctrl+Enter（部分账号设置 Enter=换行、Ctrl+Enter=发送）
    if (!(await isInputCleared(cdp))) {
      for (const type of ['keyDown', 'keyUp']) {
        await cdp.call('Input.dispatchKeyEvent', {
          type, key: 'Enter', code: 'Enter', modifiers: 2, // Ctrl
          windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
        });
      }
      await sleep(1500);
    }
  }
  // 验证提交：输入框清空 = 已发出（生成中指示器出现也算）
  const cleared = await isInputCleared(cdp);
  if (!cleared) throw new Error('无法提交提示词（按钮与 Enter/Ctrl+Enter 均未生效）');
}

/** 输入框是否已清空（提交成功的标志） */
async function isInputCleared(cdp) {
  return await cdp.evaluate(`(() => {
    const e = window.__cgiPrompt;
    if (e && (e.value ?? e.innerText ?? e.textContent ?? '').trim().length === 0) return true;
    // 引用失效则重新查询
    const all = [...document.querySelectorAll(
      '#prompt-textarea,textarea:not([hidden]),[contenteditable=true]'
    )].filter(x => x.getClientRects().length);
    return all.every(x => (x.value ?? x.innerText ?? x.textContent ?? '').trim().length === 0);
  })()`);
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
  // 下载前校验：只接受真实生成图 URL，拒绝占位/历史页 URL
  if (
    !/backend-api\/estuary|oaidalleapiprod|blob\.core\.windows\.net|^data:image/i.test(url)
  ) {
    throw new Error(`下载 URL 非真实生成图（拒绝下载）: ${String(url).slice(0, 90)}`);
  }
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

/** 发送提示词（mark 基线 + 输入 + 提交）。单独导出供重试流程组合。 */
export async function sendOnce(cdp, prompt) {
  await cdp.evaluate('window.__cgi.mark()');
  await sendPrompt(cdp, prompt);
}

/**
 * One-shot: mark → send prompt → wait image → download.
 * On text reply or error, caller may reconnect with newTab and retry.
 * resume=true 时跳过 mark+send（同一 tab 超时后继续等待，不重复提交 prompt）。
 */
export async function generateOnce(cdp, prompt, { outDir, basename, waitSeconds, resume = false }) {
  if (!resume) {
    await sendOnce(cdp, prompt);
  } else {
    console.log('[resume] 继续等待已提交的生成（不重复发送 prompt）');
  }
  const result = await waitImage(cdp, waitSeconds);
  if (result.kind === 'text') return result;
  const path = await downloadImage(cdp, result.url, outDir, basename);
  return { kind: 'image', path, url: result.url };
}
