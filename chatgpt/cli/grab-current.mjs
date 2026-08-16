// grab-current.mjs — 下载当前 ChatGPT 页面上已生成的全部完整尺寸图
// 用法: node grab-current.mjs <outdir> <prefix>
import { connectChatGPT, downloadImage } from './src/chatgpt-image.mjs';

const [, , outDir, prefix] = process.argv;
if (!outDir || !prefix) { console.error('usage: node grab-current.mjs <outdir> <prefix>'); process.exit(1); }

const { cdp, page } = await connectChatGPT(9221);
try {
  const urls = await cdp.evaluate(`(() => {
    const seen=[];
    for (const i of document.querySelectorAll('img')) {
      if (i.naturalWidth<=0) continue;
      const s=i.currentSrc||i.src||'';
      if (s.includes('backend-api/estuary')||s.includes('oaidalleapiprod')||s.includes('blob.core.windows.net')) {
        if (i.naturalWidth >= 800 && !seen.includes(s)) seen.push(s);
      }
    }
    return seen;
  })()`);
  console.log('[grab] full-size urls:', urls.length);
  const saved = [];
  for (let idx = 0; idx < urls.length; idx++) {
    const name = idx === 0 ? prefix : `${prefix}-${String(idx + 1).padStart(2, '0')}`;
    try {
      const p = await downloadImage(cdp, urls[idx], outDir, name);
      saved.push(p);
      console.log('[grab] saved:', p);
    } catch (e) {
      console.warn('[grab] skip:', e.message);
    }
  }
  console.log(JSON.stringify({ ok: true, saved }, null, 2));
} finally {
  cdp.close();
}
