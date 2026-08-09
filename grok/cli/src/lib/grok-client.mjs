// grok 搜索客户端：CDP 驱动 x.com/i/grok（复用 9221 Chrome 登录态）
// playwright-core 复用 doubao-img 的 node_modules（Windows 绝对路径 import）
import pkg from 'file:///E:/projectHome/doubao-img/node_modules/playwright-core/index.js';
const { chromium } = pkg;

const DEFAULT_CDP = 'http://127.0.0.1:9221';

/**
 * 用 Grok 搜索并返回回答文本 + 链接
 * @param {string} query 搜索词
 * @param {{cdp?: string, timeoutMs?: number, model?: string, keepOpen?: boolean, attachFile?: string, attachOnly?: boolean, resume?: boolean}} opts
 *        attachFile: 上传附件（短评 .md 等）给 Grok 读取，query 作为附带指令
 *        attachOnly: 只上传附件不提交（让用户核查），tab 保留
 *        resume: 复用已有 grok tab（不新开），在已有输入框填 query 并提交（配合 attachOnly 两步用）
 */
export async function grokSearch(query, { cdp = DEFAULT_CDP, timeoutMs = 120000, model, keepOpen = false, attachFile, attachOnly = false, resume = false } = {}) {
  const browser = await chromium.connectOverCDP(cdp);
  const ctx = browser.contexts()[0];
  let page;
  if (resume) {
    // 复用已有 grok tab（附件已在输入框里）
    page = ctx.pages().find((p) => p.url().includes('x.com/i/grok'));
    if (!page) {
      await browser.close();
      throw new Error('没有可复用的 Grok tab——请先运行 --attach 上传附件');
    }
  } else {
    page = ctx.pages().find((p) => p.url().includes('x.com/i/grok'));
    if (!page) {
      page = await ctx.newPage();
      await page.goto('https://x.com/i/grok', { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(6000);
    } else {
      // 已有 grok tab：新开一个标签保证干净会话
      page = await ctx.newPage();
      await page.goto('https://x.com/i/grok', { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(6000);
    }
  }

  // 找可见输入框（X 页面有隐藏辅助 textarea，必须过滤可见）
  const input = page.locator('[role="textbox"]:visible, textarea:visible').last();
  await input.waitFor({ state: 'visible', timeout: 20000 });

  // 上传附件（短评文件）——X 的 file input（accept 含 text/markdown），setInputFiles 直接注入
  if (attachFile) {
    const fileInput = page.locator('input[type="file"]').first();
    const fileInputCount = await fileInput.count();
    if (fileInputCount > 0) {
      await fileInput.setInputFiles(attachFile);
      await page.waitForTimeout(3000); // 等附件上传完成
    } else {
      console.error('[grok] 未找到 file input，附件未上传');
    }
  }

  // attachOnly：上传后停下（不提交、不关闭 tab），让用户核查
  if (attachOnly) {
    await browser.close().catch(() => {});
    return { attachOnly: true, tabKept: true };
  }

  await input.click();
  await page.waitForTimeout(800);
  await input.fill(query);
  await page.waitForTimeout(500);
  await page.keyboard.press('Enter');

  // 等回答生成（流式）：搜索状态行消失 + 文本稳定才算完成
  const deadline = Date.now() + timeoutMs;
  let lastLen = 0;
  let stableCount = 0;
  let answerText = '';
  const isSearching = (t) => /正在网上搜索|Thinking about|努力思考/.test(t) && t.length < 3000;
  while (Date.now() < deadline) {
    await page.waitForTimeout(4000);
    const cur = await page
      .evaluate(() => {
        // Grok 回答：优先消息容器，fallback 取 body 文本（消息区在"与 Grok 对话"之后）
        const conv = document.querySelector(
          '[data-testid="conversation"], [data-testid="messageContainer"], [data-testid="grok-response"]',
        );
        if (conv) return conv.innerText;
        const body = document.body.innerText;
        const idx = body.indexOf('与 Grok 对话');
        return idx > -1 ? body.slice(idx + 5) : body.slice(-4000);
      })
      .catch(() => '');
    if (!isSearching(cur) && cur.length >= lastLen + 40) {
      lastLen = cur.length;
      stableCount = 0;
    } else if (!isSearching(cur)) {
      stableCount += 1;
    } else {
      stableCount = 0; // 还在搜索/思考：重置稳定计数
    }
    answerText = cur;
    if (!isSearching(cur) && stableCount >= 4 && cur.length > 80) break; // 完成且稳定
  }

  // 提取链接
  const links = await page
    .evaluate(() =>
      [...document.querySelectorAll('a[href]')]
        .map((a) => ({ text: (a.innerText || '').trim().slice(0, 60), href: a.href }))
        .filter((l) => l.href && !l.href.includes('x.com') && !l.href.includes('twitter.com')),
    )
    .catch(() => []);

  // 关闭搜索 tab（避免累积）；需要查看时用 --keep-open
  if (!keepOpen && page.url().includes('x.com/i/grok')) {
    await page.close().catch(() => {});
  }
  await browser.close().catch(() => {});
  // 清理 UI 噪音：开头快捷键提示、查询回显、思考/搜索状态行、结尾模式按钮
  let cleaned = answerText
    .replace(/^[\s\S]*?\n查看新帖子\n/, '')  // 开头 UI（快捷键提示+查询回显）直到"查看新帖子"行
    .replace(/Thinking about your request\n?/, '')
    .replace(/正在网上搜索\n?/, '')
    .replace(/努力思考\n.*$/, '')
    .replace(/自动\n×\n.*$/s, '')
    .replace(/\n×\nDrag & drop.*$/s, '')
    .replace(/^\s*\d+ 网页\n/, '')
    .trim();
  return { answer: cleaned || '(无回答)', links };
}
