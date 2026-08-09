// 只等待并下载 ChatGPT 页面中已提交生成的图片（不重复提交 prompt）
// 用法: node resume-download.mjs <basename>
import { connectChatGPT, waitImage, downloadImage } from './src/chatgpt-image.mjs';

const port = 9221;
const outDir = 'G:/投资笔记/today/covers';
const basename = process.argv[2];
if (!basename) { console.error('need basename'); process.exit(1); }

const { cdp } = await connectChatGPT(port);
try {
  console.log(`[resume] 等待 ${basename} 图片（不重复提交）...`);
  const result = await waitImage(cdp, 120, 60);
  if (result.kind === 'image') {
    const path = await downloadImage(cdp, result.url, outDir, basename);
    console.log('OK image:', path);
  } else {
    console.log('TEXT reply:', String(result.text).slice(0, 300));
    process.exitCode = 2;
  }
} finally {
  cdp.close();
}
