// gen-asset.mjs — 健壮版 ChatGPT 单图生成（修复 imgs() 选择器）
// 用法: node gen-asset.mjs <prompt-file> <outdir> <basename> [waitSeconds]
// 输出: <outdir>/<basename>-01.ext, -02.ext ...（全部新变体）
import { readFileSync } from 'node:fs';
import { connectChatGPT, sendPrompt, downloadImage } from './src/chatgpt-image.mjs';

const [, , promptFile, outDir, basename, waitArg] = process.argv;
const waitSeconds = Number(waitArg || 480);
if (!promptFile || !outDir || !basename) {
  console.error('usage: node gen-asset.mjs <prompt-file> <outdir> <basename> [waitSeconds]');
  process.exit(1);
}
const prompt = readFileSync(promptFile, 'utf8');

const FIXED_HELPERS = `window.__cgi={
  before:new Set(),
  realSrc(i){
    const s=(i.currentSrc||i.src||'');
    if(!s) return '';
    // 只取完整尺寸生成图（p=fs 全尺寸，排除 p=gpp 缩略图），或 oaidalle/data/blob
    if (s.includes('backend-api/estuary')) return s.includes('p=fs') ? s : '';
    return (s.includes('oaidalleapiprod')||s.includes('blob.core.windows.net')||s.startsWith('data:image')) ? s : '';
  },
  imgs(){
    const urls=[];
    for (const i of document.querySelectorAll('img')) {
      const s=this.realSrc(i);
      if (s && !urls.includes(s)) urls.push(s);
    }
    return urls;
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { cdp, page } = await connectChatGPT(9221);
try {
  await cdp.evaluate(FIXED_HELPERS);
  await cdp.evaluate('window.__cgi.mark()');
  console.log('[gen] mark done, sending prompt...');
  await sendPrompt(cdp, prompt);
  console.log('[gen] prompt sent, waiting for image...');

  const end = Date.now() + waitSeconds * 1000;
  let url = null;
  while (Date.now() < end) {
    url = await cdp.evaluate('window.__cgi.newImg()').catch(() => null);
    if (url) break;
    await sleep(2000);
  }
  if (!url) {
    const text = await cdp.evaluate('window.__cgi.newText()').catch(() => null);
    console.error('[gen] NO_IMAGE', String(text || '').slice(0, 300));
    process.exit(2);
  }
  console.log('[gen] found:', url.slice(0, 140));

  // 下载全部新变体（1-3 张）
  const allNew = await cdp.evaluate(`window.__cgi.imgs().filter(x=>!window.__cgi.before.has(x))`);
  console.log('[gen] new urls:', allNew.length);
  const saved = [];
  let idx = 0;
  for (const u of allNew) {
    idx += 1;
    const name = idx === 1 ? basename : `${basename}-${String(idx).padStart(2, '0')}`;
    try {
      const p = await downloadImage(cdp, u, outDir, name);
      saved.push(p);
      console.log('[gen] saved:', p);
    } catch (e) {
      console.warn('[gen] skip download:', e.message);
    }
  }
  if (!saved.length) { console.error('[gen] no download succeeded'); process.exit(3); }
  console.log(JSON.stringify({ ok: true, saved }, null, 2));
} finally {
  cdp.close();
}
