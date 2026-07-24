#!/usr/bin/env node

const { program } = require('commander');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, spawn } = require('child_process');
const puppeteer = require('puppeteer-core');

const DEFAULT_CDP_URL = 'http://localhost:9222';
const DEFAULT_MODEL = 'FLUX.2 Pro';
const DEFAULT_KEEP_LINE = '高品质3D动画电影风格，画面不出现任何文字、数字、字幕、标志或水印。根据字幕含义设计具有隐喻性和故事性的单一场景，通过角色动作、表情、视线、道具和环境关系准确传达概念，避免角色静站、正面讲解或简单摆拍。画面包含明确的前景、中景和背景，主体突出，空间层次丰富，构图简洁但不空洞。角色表演自然细腻，姿态具有动态感，场景中加入少量与主题相关的叙事细节和视觉对比。精致的动画电影角色设计，统一的材质与比例，柔和体积光，电影级布光，细腻阴影，适度景深，丰富但克制的色彩，干净背景，高完成度，高细节，视觉焦点清晰，适合作为口播视频配图。';
const DEFAULT_OUTPUT_DIR = './higgsfield-downloads';
const DEFAULT_CONCURRENCY = 2;
const STATE_FILENAME = '.higgsfield-state.json';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const CHROME_EXE = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const CHROME_PROFILE = 'G:\\chrome_data\\y0';
const HIGGSFIELD_URL = 'https://higgsfield.ai/ai/image?model=flux-2-pro';

function restartChromeForProfile() {
  try {
    // Only terminate Chrome processes using the configured profile; unrelated
    // Chrome profiles are left untouched.
    const profile = CHROME_PROFILE;
    const ps = `$pattern='${profile}'; $ps=Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | Where-Object { $_.CommandLine -like \"*$pattern*\" }; $ps | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }; for($i=0;$i -lt 20;$i++){ $left=Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | Where-Object { $_.CommandLine -like \"*$pattern*\" }; if(-not $left){break}; Start-Sleep -Milliseconds 500 }`;
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'ignore' });
  } catch {}
  spawn(CHROME_EXE, [`--user-data-dir=${CHROME_PROFILE}`, '--remote-debugging-port=9222', HIGGSFIELD_URL], {
    detached: true,
    stdio: 'ignore',
  }).unref();
}

function extractHash(key) {
  // 从 key 中提取可用于文件名的简短哈希
  try {
    const u = new URL(key);
    const basename = path.basename(u.pathname);
    const stem = basename.replace(/\.[^.]+$/, '');
    // 取最后一段作为 hash（去除时间戳前缀）
    return stem.replace(/^hf_\d{8}_\d{6}_?/, '') || stem;
  } catch {
    return key.replace(/[^a-zA-Z0-9_-]/g, '').slice(-16);
  }
}

function findResumeFiles(outputDir) {
  if (!fs.existsSync(outputDir)) return [];
  const filesByIndex = new Map();
  for (const entry of fs.readdirSync(outputDir)) {
    // 手动下载的图片可能是 `21.png`，脚本生成的则通常为 `21_xxx.png`；两者都视为该序号已存在。
    const match = entry.match(/^(?:ep\d+_)?(\d+)(?:_|\.(?:webp|png|jpe?g)$)/i);
    if (match) filesByIndex.set(parseInt(match[1], 10), entry);
  }
  const files = [];
  while (filesByIndex.has(files.length + 1)) {
    files.push(filesByIndex.get(files.length + 1));
  }
  return files;
}

function findMissingImageIndexes(outputDir, total) {
  const existing = new Set();
  if (fs.existsSync(outputDir)) {
    for (const entry of fs.readdirSync(outputDir)) {
      // 输出目录是续传的唯一完成依据：手动保存的 `21.png` 与脚本文件 `21_xxx.png` 同等有效。
      const match = entry.match(/^(?:ep\d+_)?(\d+)(?:_.*)?\.(?:webp|png|jpe?g)$/i);
      if (match) existing.add(parseInt(match[1], 10));
    }
  }
  const missing = [];
  for (let index = 1; index <= total; index++) {
    if (!existing.has(index)) missing.push(index);
  }
  return missing;
}

function eventTimeForFile(file) {
  const match = file.name.match(/hf_(\d{8})_(\d{6})/);
  if (match) return Number(match[1] + match[2]);
  return file.birthtimeMs || file.mtimeMs;
}

function cleanReferenceAndRenumber(outputDir) {
  if (!fs.existsSync(outputDir)) throw new Error(`输出目录不存在: ${outputDir}`);
  const images = fs
    .readdirSync(outputDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(?:webp|png|jpe?g)$/i.test(entry.name))
    .map((entry) => {
      const fullPath = path.join(outputDir, entry.name);
      return { name: entry.name, fullPath, ...fs.statSync(fullPath) };
    })
    .sort((a, b) => eventTimeForFile(a) - eventTimeForFile(b) || a.name.localeCompare(b.name));

  if (images.length === 0) {
    console.log('ℹ️ 输出目录中没有可处理的图片');
    return;
  }

  const reference = images.shift();
  fs.unlinkSync(reference.fullPath);
  const padLen = Math.max(2, String(images.length + 1).length);
  // 先改为临时名，避免重编号时文件名互相覆盖。
  const staged = images.map((image, index) => {
    const tempPath = path.join(outputDir, `.renumber-${process.pid}-${index}${path.extname(image.name)}`);
    fs.renameSync(image.fullPath, tempPath);
    return { ...image, tempPath };
  });
  for (let index = 0; index < staged.length; index++) {
    const image = staged[index];
    const hash = sanitizeFilename(path.basename(image.name, path.extname(image.name)).replace(/^\d+_/, ''));
    const filename = `${String(index + 2).padStart(padLen, '0')}_${hash}${path.extname(image.name).toLowerCase()}`;
    fs.renameSync(image.tempPath, path.join(outputDir, filename));
  }
  // 编号已改变，旧的断点映射不再可靠。
  const statePath = path.join(outputDir, STATE_FILENAME);
  if (fs.existsSync(statePath)) fs.unlinkSync(statePath);
  console.log(`🗑️ 已删除首张参考图: ${reference.name}`);
  console.log(`🔢 已按事件时间为其余 ${staged.length} 张图片重新编号`);
}

function promptsHash(prompts) {
  return crypto.createHash('sha256').update(JSON.stringify(prompts)).digest('hex');
}

function loadResumeState(outputDir, prompts) {
  const statePath = path.join(outputDir, STATE_FILENAME);
  const promptHash = promptsHash(prompts);
  if (!fs.existsSync(statePath)) {
    const existingFiles = findResumeFiles(outputDir);
    return {
      statePath,
      promptHash,
      completed: existingFiles.length,
      submitted: existingFiles.length,
      submittedIndexes: [],
      // 兼容旧版本已保存的编号文件；首次保存新图时会一并迁移到状态文件。
      saved: existingFiles.map((filename, index) => ({ index: index + 1, filename })),
    };
  }

  try {
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    if (state.promptHash !== promptHash) {
      // 提示词已变更，重置断点状态，以当前磁盘文件为准
      console.log('⚠️ 提示词文件已变更，重置断点状态，以当前输出目录中的图片为准...');
      fs.unlinkSync(statePath);
      const existingFiles = findResumeFiles(outputDir);
      return {
        statePath,
        promptHash,
        completed: existingFiles.length,
        submitted: existingFiles.length,
        submittedIndexes: [],
        saved: existingFiles.map((filename, index) => ({ index: index + 1, filename })),
      };
    }
    const saved = Array.isArray(state.saved) ? state.saved : [];
    let completed = 0;
    while (
      saved[completed] &&
      saved[completed].index === completed + 1 &&
      fs.existsSync(path.join(outputDir, saved[completed].filename))
    ) {
      completed++;
    }
    return {
      statePath,
      promptHash,
      completed,
      submitted: Math.max(completed, Math.min(prompts.length, Number(state.submitted) || completed)),
      submittedIndexes: Array.isArray(state.submittedIndexes) ? state.submittedIndexes : [],
      saved: saved.slice(0, completed),
      baselineKeys: Array.isArray(state.baselineKeys) ? state.baselineKeys : null,
      baselineSrcs: Array.isArray(state.baselineSrcs) ? state.baselineSrcs : null,
    };
  } catch (err) {
    if (err.message.includes('提示词文件')) throw err;
    throw new Error(`无法读取断点记录 ${statePath}: ${err.message}`);
  }
}

function saveResumeState(resumeState) {
  const payload = {
    version: 1,
    promptHash: resumeState.promptHash,
    submitted: resumeState.submitted,
    submittedIndexes: resumeState.submittedIndexes || [],
    saved: resumeState.saved,
    baselineKeys: resumeState.baselineKeys,
    baselineSrcs: resumeState.baselineSrcs,
    updatedAt: new Date().toISOString(),
  };
  const tempPath = `${resumeState.statePath}.tmp`;
  fs.mkdirSync(path.dirname(resumeState.statePath), { recursive: true });
  fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2));
  fs.renameSync(tempPath, resumeState.statePath);
}

program
  .name('higgsfield-bot')
  .description('通过 Chrome DevTools Protocol 自动在 Higgsfield 上批量提交生图任务。')
  .version('1.0.0')
  .option('-u, --cdp-url <url>', 'CDP 连接地址', DEFAULT_CDP_URL)
  .option('-m, --model <model>', '要使用的模型名称（页面上显示的文本）', DEFAULT_MODEL)
  .option('-p, --prompts <file>', '替换提示词文件，每行一条；行数即为提交次数')
  .option('-k, --keep-line <text>', '提示词中保留的固定句子', DEFAULT_KEEP_LINE)
  .option('-o, --output <dir>', '图片下载目录', DEFAULT_OUTPUT_DIR)
  .option('-c, --concurrency <n>', '允许的最大并发生图数量', String(DEFAULT_CONCURRENCY))
  .option('--cleanup-reference', '删除输出目录按事件时间排序的首张参考图，并为剩余图片重新编号后退出')
  .option('--no-unlimited', '不强制开启 Unlimited 开关（默认会开启）')
  .addHelpText(
    'after',
    `
安装到全局:
  npm install -g higgsfield-bot
  # 安装后可在任意目录直接运行
  higgsfield-bot --help

示例 (Demo):
  # 1. 读取 prompts.txt 提交，并把生成的图片下载到默认目录
  higgsfield-bot -p ./prompts.txt

  # 2. 指定图片保存目录
  higgsfield-bot -p ./prompts.txt -o ./my-images

  # 3. 切换模型并指定保留句
  higgsfield-bot -p ./prompts.txt -m "FLUX.2 Pro" -k "3d动画风格，画面上不要出现文字。为以下口播稿设计一张会意图片"

  # 4. 连接非默认 CDP 端口并指定并发数
  higgsfield-bot -p ./prompts.txt -u http://localhost:9223

  # 5. 指定并发生图数（默认 2）
  higgsfield-bot -p ./prompts.txt -c 6

  # 6. 断点续传：直接再次运行，工具会自动跳过已生成的图片
  higgsfield-bot -p ./prompts.txt

  # 7. 清理旧输出：删除按事件时间最早的参考图，并重排其余图片编号
  higgsfield-bot -o ./my-images --cleanup-reference

提示词文件格式 (prompts.txt):
  a cute robot toy, soft lighting
  a magical forest with glowing mushrooms
  a futuristic candy shop on a floating island

默认值:
  • 模型: FLUX.2 Pro
  • 并发数: 2
  • Unlimited: 开启
  • 保留句: "3d动画风格，画面上不要出现文字。为以下口播稿设计一张会意图片"
  • 图片下载目录: ./higgsfield-downloads

注意事项:
  • 运行前请先用 Chrome 打开目标页面并设置好参考图，然后以 CDP 模式启动浏览器：
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --remote-debugging-port=9222
  • 本工具会保留 --keep-line 指定的句子，替换其余提示词内容。
  • 工具会控制并发生图数量（默认 2 张，可用 -c 调整），图片生成后立即保存，文件命名格式为 NN_hash.webp（如 01_abc123.webp）。
  • 支持断点续传与补图：输出目录会写入 .higgsfield-state.json；再次运行时会先保存上次已提交但未落盘的结果，并只为缺失序号重新生图。
  • 若超时未识别到足够新增图片，会自动按时间戳兜底取最新图片。
`
  )
  .parse();

const opts = program.opts();
const CDP_URL = opts.cdpUrl;
const MODEL_NAME = opts.model;
const KEEP_LINE = opts.keepLine;
const ENABLE_UNLIMITED = opts.unlimited;
const CONCURRENCY = parseInt(opts.concurrency, 10) || DEFAULT_CONCURRENCY;
const OUTPUT_DIR = path.resolve(opts.output);

if (opts.cleanupReference) {
  cleanReferenceAndRenumber(OUTPUT_DIR);
  process.exit(0);
}

if (!opts.prompts) {
  console.error('❌ 必须指定提示词文件: -p, --prompts <file>');
  process.exit(1);
}

const promptsPath = path.resolve(opts.prompts);
if (!fs.existsSync(promptsPath)) {
  console.error(`❌ 提示词文件不存在: ${promptsPath}`);
  process.exit(1);
}

const REPLACEMENTS = fs
  .readFileSync(promptsPath, 'utf-8')
  .split(/\r?\n/)
  .map((l) => l.trim())
  .filter((l) => l.length > 0);

if (REPLACEMENTS.length === 0) {
  console.error('❌ 提示词文件为空');
  process.exit(1);
}

console.log(`📄 读取到 ${REPLACEMENTS.length} 条提示词，将提交 ${REPLACEMENTS.length} 次`);

const TARGET_URL_PART = 'higgsfield.ai/ai/image';
const SUBMIT_ID = 'hf:image-form-submit';
const PROMPT_SELECTOR = "[id='hf:tour-image-prompt']";

async function findPage(browser) {
  const pages = await browser.pages();
  for (const p of pages) {
    const url = await p.url();
    if (url.includes(TARGET_URL_PART)) return p;
  }
  const targets = await browser.targets();
  for (const t of targets) {
    if (t.url().includes(TARGET_URL_PART)) {
      return await t.page();
    }
  }
  throw new Error(`找不到包含 ${TARGET_URL_PART} 的页面，请先在浏览器中打开目标页面。`);
}

async function closeDialog(page) {
  await page.evaluate(() => {
    const close = document.querySelector('[role="dialog"] button[aria-label="Close"]');
    close?.click();
  });
  await sleep(500);
}

async function clearViewportOverride(page) {
  let session;
  try {
    session = await page.target().createCDPSession();
    await session.send('Emulation.clearDeviceMetricsOverride');
    await session.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1 });
    console.log('✅ 已恢复 Chrome 原始页面布局');
  } catch (err) {
    console.log(`⚠️ 恢复原始页面布局失败：${err.message}`);
  } finally {
    try { await session?.detach(); } catch {}
  }
}

async function ensureModel(page) {
  const current = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    return btns.find((b) => /(?:Nano Banana|FLUX(?:\\.\\d+)?)/i.test(b.textContent.trim()))?.textContent?.trim();
  });
  if (current && current.includes(MODEL_NAME) && !current.includes('Lite')) {
    console.log('✅ 当前模型:', current);
    return;
  }
  console.log(`🔄 切换模型到 ${MODEL_NAME}`);
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    btns.find((b) => /(?:Nano Banana|FLUX(?:\\.\\d+)?)/i.test(b.textContent.trim()))?.click();
  });
  await sleep(1500);
  await page.evaluate((model) => {
    const btns = Array.from(document.querySelectorAll('button'));
    const target = btns.find((b) => {
      const t = b.textContent.trim();
      return t.startsWith(model) && !t.includes('Lite');
    });
    target?.click();
  }, MODEL_NAME);
  await sleep(3000);
  const after = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    return btns.find((b) => /(?:Nano Banana|FLUX(?:\\.\\d+)?)/i.test(b.textContent.trim()))?.textContent?.trim();
  });
  console.log('✅ 切换后模型:', after);
}

async function readUnlimitedSwitch(page) {
  return page.evaluate(() => {
    // 1. 直接找 role="switch" 的按钮
    const switchBtn = document.querySelector('button[role="switch"]');
    if (switchBtn) {
      return { checked: switchBtn.getAttribute('aria-checked') === 'true' };
    }
    // 2. 兜底：通过提交按钮文字判断是否 Unlimited
    const submit = document.getElementById('hf:image-form-submit');
    const text = submit?.textContent?.trim() || '';
    return { checked: /unlimited/i.test(text) };
  });
}

async function toggleUnlimited(page) {
  await page.evaluate(() => {
    const switchBtn = document.querySelector('button[role="switch"]');
    if (switchBtn) {
      switchBtn.click();
      return;
    }
    // 没有开关时尝试点击文字为 Unlimited 的区域
    const unlimitedDiv = Array.from(document.querySelectorAll('div')).find(
      (el) => el.textContent.trim() === 'Unlimited'
    );
    unlimitedDiv?.click();
  });
}

async function ensureUnlimitedOn(page) {
  if (!ENABLE_UNLIMITED) {
    console.log('ℹ️ 跳过 Unlimited 开关检测（--no-unlimited）');
    return;
  }
  // The control can be temporarily unavailable while the form refreshes.
  // Keep retrying every five seconds instead of aborting the whole batch.
  let retryCount = 0;
  for (;;) {
    retryCount++;
    try {
      const state = await readUnlimitedSwitch(page);
      if (state.checked) {
        console.log('✅ Unlimited 已是开启状态');
        return;
      }
      console.log('🔄 Unlimited 未开启，点击开启；5 秒后继续检查');
      await toggleUnlimited(page);
    } catch (err) {
      console.log(`⚠️ Unlimited 检查/点击失败：${err.message}；5 秒后重试`);
    }
    if (retryCount % 12 === 0) {
      console.log('🔄 Unlimited 连续 12 次未开启，重启指定 Chrome 后继续检查');
      try { await page.browser().disconnect(); } catch {}
      restartChromeForProfile();
      throw new Error('Chrome 已重启，等待外层脚本重新连接');
    } else {
      await sleep(5000);
    }
  }
}

async function findPromptElement(page, timeoutMs = 10000) {
  const selectors = [
    "[id='hf:tour-image-prompt']",
    'textarea[placeholder*="prompt" i]',
    'textarea[placeholder*="describe" i]',
    'textarea',
    '[contenteditable="true"]',
  ];
  let start = Date.now();
  while (Date.now() - start < timeoutMs) {
    for (const sel of selectors) {
      const exists = await page.evaluate((s) => document.querySelector(s) !== null, sel);
      if (exists) return sel;
    }
    await sleep(500);
  }
  return null;
}

async function setPrompt(page, text) {
  const sel = await findPromptElement(page);
  if (!sel) {
    throw new Error('找不到提示词输入框，请确认页面已加载完成');
  }

  let actual = '';
  // 逐字 type 会在 React 重渲染时掉字。CDP 的 insertText 是原子注入，
  // 再配合最多 3 次全量重试，确保提交前页面中是完整的当前提示词。
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await page.evaluate((selector) => {
      const el = document.querySelector(selector);
      if (!el) throw new Error('找不到提示词输入框');
      el.focus();
      if (typeof el.select === 'function') {
        el.select();
      } else {
        const range = document.createRange();
        range.selectNodeContents(el);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
      }
    }, sel);
    await page.keyboard.press('Backspace');
    // puppeteer-core 当前版本将 CDP Input.insertText 暴露为 sendCharacter；
    // 传入完整字符串会原子写入，避免逐字输入时被 React 重渲染截断。
    await page.keyboard.sendCharacter(text);
    await sleep(700);

    actual = await page.evaluate((selector) => {
      const el = document.querySelector(selector);
      return el ? (el.value || el.textContent || '') : '';
    }, sel);
    if (promptMatchKey(actual) === promptMatchKey(text)) return;
    // 输入框会自动补全 `{` 的闭合 `}`。当我们原提示词本身已带结尾 `}` 时，
    // 会稳定多出一个末尾花括号；删除这一个自动补全字符后再校验，不能把它提交。
    if (
      actual.endsWith('}') &&
      promptMatchKey(actual.slice(0, -1)) === promptMatchKey(text)
    ) {
      await page.evaluate((selector) => {
        const el = document.querySelector(selector);
        if (!el) return;
        el.focus();
        if (typeof el.setSelectionRange === 'function') {
          el.setSelectionRange(el.value.length, el.value.length);
        }
      }, sel);
      await page.keyboard.press('Backspace');
      await sleep(300);
      actual = await page.evaluate((selector) => {
        const el = document.querySelector(selector);
        return el ? (el.value || el.textContent || '') : '';
      }, sel);
      if (promptMatchKey(actual) === promptMatchKey(text)) return;
    }
    console.log(`⚠️ 提示词写入未完整生效，第 ${attempt}/3 次重试（实际 ${actual.length} 字，预期 ${text.length} 字）`);
    await sleep(500);
  }
  throw new Error(
    `提示词写入校验失败：页面实际内容与待提交内容不一致（实际 ${actual.length} 字，预期 ${text.length} 字）`
  );
}

function buildNewPrompt(replacement) {
  return KEEP_LINE + ' ' + replacement;
}

// Higgsfield 会在长时间会话或页面刷新后偶尔插入换行、NBSP、零宽字符。
// 这些不会改变提示词语义，但若按字节比较会误报输入失败，也会让完成图无法回收。
function promptMatchKey(value) {
  return String(value || '')
    .normalize('NFC')
    .replace(/[\s\u00A0\u200B-\u200D\uFEFF]+/g, '');
}

function promptLabel(value, index, padLen) {
  const match = String(value || '').match(/\b(ep\d+_\d+)\b/i);
  return match ? match[1].toLowerCase() : String(index).padStart(padLen, '0');
}

function promptIndexFromLabel(value) {
  const match = String(value || '').match(/\bep\d+_(\d+)\b/i);
  return match ? Number(match[1]) : null;
}

async function modifyPrompt(page, replacement) {
  const newText = buildNewPrompt(replacement);
  console.log('📝 新提示词：');
  console.log(newText);
  console.log('');
  await setPrompt(page, newText);
  return newText;
}

async function isSubmitDisabled(page) {
  try {
    return await page.evaluate((id) => {
      const btn = document.getElementById(id);
      if (!btn) return true;
      return btn.disabled || btn.getAttribute('aria-disabled') === 'true';
    }, SUBMIT_ID);
  } catch (e) {
    return true;
  }
}

async function waitForSubmitEnabled(page, timeoutMs = 600000) {
  let start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const disabled = await isSubmitDisabled(page);
    if (!disabled) return true;
    await sleep(3000);
  }
  return false;
}

async function countProcessingCards(page) {
  return page.evaluate(() => {
    // 一个状态标签会同时命中自身和父节点，按文本节点计数会把一个任务误算成两个，
    // 导致并发槽位永远不释放。用任务卡片的 React job.status 一卡一计数。
    function getJob(card) {
      const fiberKey = Object.getOwnPropertyNames(card).find((key) => key.startsWith('__reactFiber'));
      let fiber = fiberKey ? card[fiberKey] : null;
      for (let depth = 0; fiber && depth < 12; depth += 1, fiber = fiber.return) {
        const props = fiber.memoizedProps || fiber.pendingProps || {};
        const job = props.job || props.asset?.details;
        if (job?.id) {
          const src = job?.media?.rawUrl || job?.media?.media?.source || props.asset?.raw || props.asset?.preview || '';
          return { ...job, __imageSrc: typeof src === 'string' ? src : '' };
        }
      }
      return null;
    }
    // 状态枚举可能随站点更新增加（queued/created/rendering 等）。安全策略是：
    // 只有明确终态才释放槽位，未知状态一律按仍在生成处理，避免过早并发提交。
    const terminal = new Set(['completed', 'complete', 'done', 'success', 'succeeded', 'failed', 'cancelled', 'canceled', 'error', 'rejected']);
    return Array.from(document.querySelectorAll('[data-asset-id]')).filter((card) => {
      const job = getJob(card);
      const status = String(job?.status || '').toLowerCase();
      // 成品 URL 是比状态文案更稳定的完成信号；状态名称可能随站点版本变化。
      const hasCompletedImage = /hf_\d{8}_\d{6}/.test(job?.__imageSrc || '');
      return !hasCompletedImage && !terminal.has(status);
    }).length;
  });
}

async function waitForProcessingSlot(page, maxCards, timeoutMs = 120000, onWaiting) {
  for (;;) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const count = await countProcessingCards(page);
      if (count < maxCards) {
        console.log(`⏳ 当前 Processing/Generating 卡片数: ${count}，可以继续提交`);
        return false;
      }
      console.log(`⏳ 已达 ${maxCards} 个并行任务，等待空位...`);
      await onWaiting?.();
      await sleep(5000);
    }
    // 不退出整批任务。Higgsfield 偶尔会长时间排队；保持当前页面继续等待，
    // 用户可自行中断，断点状态会保留，绝不能因单次等待超时而让全部剧集失败。
    console.log(`⚠️ 等待 ${maxCards} 个并发槽位超过 2 分钟，保持当前页面继续等待，不会跳过任务...`);
  }
}

async function clickSubmit(page, concurrency, onWaiting, expectedPrompt) {
  const refreshed = await waitForProcessingSlot(page, concurrency, 120000, onWaiting);
  // 只有等待并发槽位期间真的刷新过页面时，提示词才会丢失，需要重新写入。
  if (refreshed && expectedPrompt) await setPrompt(page, expectedPrompt);

  // Unlimited 不是启动时的一次性设置；每一次真实提交前都要确认它仍处于开启状态。
  await ensureUnlimitedOn(page);

  const enabled = await waitForSubmitEnabled(page, 120000);
  if (!enabled) throw new Error('提交按钮长时间不可用');
  const before = await countProcessingCards(page);
  const promptSel = await findPromptElement(page);
  const promptBefore = promptSel
    ? await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        return el ? el.value || el.textContent || '' : '';
      }, promptSel)
    : '';
  if (expectedPrompt && promptMatchKey(promptBefore) !== promptMatchKey(expectedPrompt)) {
    throw new Error('提交前提示词校验失败：页面中的提示词不是当前队列项，已停止以避免错位提交');
  }

  const center = await page.evaluate((id) => {
    const submit = document.getElementById(id);
    if (!submit) return null;
    submit.scrollIntoView({ block: 'center', inline: 'center' });
    const rect = submit.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }, SUBMIT_ID);

  if (!center) throw new Error('找不到提交按钮');

  console.log('🚀 点击提交按钮', center);
  // 先触发 React 按钮本身；若 5 秒内任务卡仍未出现，再用可见坐标兜底。
  // 页面提交后会立即重建按钮节点，因此不使用可能卡住的旧 ElementHandle。
  await page.evaluate((id) => {
    const submit = document.getElementById(id);
    if (!submit) throw new Error('找不到提交按钮元素');
    submit.click();
  }, SUBMIT_ID);
  let coordinateFallback = false;

  // 给 UI 一点反应时间后再开始轮询
  await sleep(1500);

  const start = Date.now();
  while (Date.now() - start < 60000) {
    const after = await countProcessingCards(page);
    if (after > before) {
      console.log('✅ 检测到新的 Processing/Generating 卡片，提交成功\n');
      return true;
    }
    if (!coordinateFallback && Date.now() - start >= 5000) {
      console.log('⚠️ DOM 点击后未出现任务卡，使用坐标点击兜底...');
      await page.mouse.click(center.x, center.y);
      coordinateFallback = true;
    }
    const disabled = await isSubmitDisabled(page);
    if (disabled) {
      console.log('✅ 提交按钮已禁用，提交已注册\n');
      return true;
    }
    // 兜底：若提示词框被清空，也视为已提交
    if (promptSel) {
      const promptNow = await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        return el ? el.value || el.textContent || '' : '';
      }, promptSel);
      if (promptNow.trim().length === 0 && promptBefore.trim().length > 0) {
        console.log('✅ 提示词框已清空，提交已注册\n');
        return true;
      }
    }
    await sleep(500);
  }

  // 未确认就不推进断点。只核对当前 DOM，不刷新页面，避免破坏会话和 Unlimited。
  console.log('⚠️ 60 秒未确认新任务，直接核对当前任务，不会跳到下一条...');
  try {
    const currentJobs = await Promise.race([
      collectCurrentJobStatuses(page),
      sleep(10000).then(() => null),
    ]);
    if (currentJobs?.some((item) => promptMatchKey(item.prompt) === promptMatchKey(expectedPrompt))) {
      console.log('✅ 当前页面找到提示词任务，提交成功\n');
      return true;
    }
  } catch (err) {
    console.log(`⚠️ 提交核对失败: ${err.message}`);
  }
  console.log('↻ 未找到当前提示词任务，将重试当前条，不会写入断点\n');
  return false;
}

async function getActiveJobSignatures(page) {
  return page.evaluate(() => {
    const isActive = (text) => {
      const t = text.trim().toLowerCase();
      return t === 'processing' || t === 'generating';
    };
    return Array.from(document.querySelectorAll('*'))
      .filter((el) => {
        if (!isActive(el.textContent)) return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      })
      .map((el) => {
        const rect = el.getBoundingClientRect();
        return `${rect.x.toFixed(1)}:${rect.y.toFixed(1)}:${el.textContent.trim()}`;
      });
  });
}

async function waitForGenerationComplete(browser, page, beforeCount, timeoutMs = 600000) {
  console.log('⏳ 等待本次生成完成...');
  const start = Date.now();
  let currentPage = page;
  let beforeSignatures = new Set(await getActiveJobSignatures(currentPage));

  // 先等待本次任务真正开始（处理排队情况）
  let seenNewJob = false;
  while (Date.now() - start < timeoutMs) {
    try {
      const count = await countProcessingCards(currentPage);
      const cards = count;
      const currentSignatures = await getActiveJobSignatures(currentPage);

      // 检测到全新的 Processing/Generating 元素，视为本次任务已开始
      if (!seenNewJob) {
        const hasNew = currentSignatures.some((sig) => !beforeSignatures.has(sig));
        if (hasNew || count > beforeCount) {
          seenNewJob = true;
          console.log('   本次任务已开始');
        }
      }

      if (seenNewJob && count <= beforeCount) {
        console.log('✅ 本次生成已完成');
        return { success: true, page: currentPage };
      }

      if (!seenNewJob) {
        console.log(`   任务排队中，当前 Processing/Generating 卡片数: ${cards}`);
      } else {
        console.log(`   当前 Processing/Generating 卡片数: ${cards}`);
      }
    } catch (err) {
      if (err.message.includes('Execution context was destroyed') || err.message.includes('Protocol')) {
        console.log('🔄 页面发生导航/刷新，尝试重新连接...');
        await sleep(3000);
        currentPage = await findPage(browser);
        await currentPage.bringToFront();
        beforeSignatures = new Set(await getActiveJobSignatures(currentPage));
        continue;
      }
      throw err;
    }
    await sleep(5000);
  }
  console.log('⚠️ 等待生成完成超时');
  return { success: false, page: currentPage };
}

async function waitForAllGenerationsComplete(browser, page, targetCount = 0, timeoutMs = 600000) {
  console.log('⏳ 等待所有生成完成...');
  const start = Date.now();
  let currentPage = page;
  while (Date.now() - start < timeoutMs) {
    try {
      const count = await countProcessingCards(currentPage);
      const cards = count;
      if (count <= targetCount) {
        console.log('✅ 所有生成已完成');
        return { success: true, page: currentPage };
      }
      console.log(`   当前 Processing/Generating 卡片数: ${cards}`);
    } catch (err) {
      if (err.message.includes('Execution context was destroyed') || err.message.includes('Protocol')) {
        console.log('🔄 页面发生导航/刷新，尝试重新连接...');
        await sleep(3000);
        currentPage = await findPage(browser);
        await currentPage.bringToFront();
        continue;
      }
      throw err;
    }
    await sleep(5000);
  }
  console.log('⚠️ 等待生成完成超时');
  return { success: false, page: currentPage };
}

async function collectImageUrls(page) {
  // 多次滚动，确保懒加载图片都已出现
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(500);
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await sleep(1500);
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(500);

  const items = await page.evaluate(() => {
    function jobFromCard(card) {
      const fiberKey = Object.getOwnPropertyNames(card).find((key) => key.startsWith('__reactFiber'));
      let fiber = fiberKey ? card[fiberKey] : null;
      for (let depth = 0; fiber && depth < 12; depth += 1, fiber = fiber.return) {
        const props = fiber.memoizedProps || fiber.pendingProps || {};
        const job = props.job || props.asset?.details;
        const prompt = job?.params?.prompt?.prompt || job?.params?.prompt || job?.rawParams?.prompt;
        const src = job?.media?.rawUrl || job?.media?.media?.source || props.asset?.raw || props.asset?.preview;
        if (job?.id && typeof prompt === 'string' && typeof src === 'string') {
          return { id: job.id, prompt, src, status: job.status || props.asset?.details?.status || '' };
        }
      }
      return null;
    }
    return Array.from(document.querySelectorAll('[data-asset-id]'))
      .map(jobFromCard)
      // 站点的完成状态文案会变化，但已返回的 hf_ 成品地址是稳定信号。
      // 不再硬编码 status === 'completed'，否则图已生成也无法被下载回收。
      .filter((item) => item && /hf_\d{8}_\d{6}/.test(item.src));
  });
  const map = new Map();
  for (const item of items) {
    if (!map.has(item.id)) map.set(item.id, { ...item, key: item.src });
  }
  return map;
}

// 续传决策不能只看“曾经提交过”。任务可能已经被站点取消、丢失，或完成结果
// 不再出现在页面中；此时必须允许重新提交缺失序号。
async function collectCurrentJobStatuses(page) {
  const items = await page.evaluate(() => {
    function jobFromCard(card) {
      const fiberKey = Object.getOwnPropertyNames(card).find((key) => key.startsWith('__reactFiber'));
      let fiber = fiberKey ? card[fiberKey] : null;
      for (let depth = 0; fiber && depth < 12; depth += 1, fiber = fiber.return) {
        const props = fiber.memoizedProps || fiber.pendingProps || {};
        const job = props.job || props.asset?.details;
        const prompt = job?.params?.prompt?.prompt || job?.params?.prompt || job?.rawParams?.prompt;
        if (job?.id && typeof prompt === 'string') {
          const src = job?.media?.rawUrl || job?.media?.media?.source || props.asset?.raw || props.asset?.preview || '';
          return {
            id: job.id,
            prompt,
            status: String(job.status || props.asset?.details?.status || '').toLowerCase(),
            hasCompletedImage: /hf_\d{8}_\d{6}/.test(typeof src === 'string' ? src : ''),
          };
        }
      }
      return null;
    }
    return Array.from(document.querySelectorAll('[data-asset-id]')).map(jobFromCard).filter(Boolean);
  });
  return items;
}

function diffMaps(prevMap, currMap) {
  const newEntries = [];
  for (const [key, src] of currMap.entries()) {
    if (!prevMap.has(key)) newEntries.push({ key, src });
  }
  return newEntries;
}

function extractTimestamp(key) {
  const m = key.match(/hf_(\d{8})_(\d{6})/);
  if (!m) return 0;
  return parseInt(m[1] + m[2], 10);
}

function getNewestImage(map) {
  let newest = null;
  let newestTs = -1;
  for (const [key, src] of map.entries()) {
    const ts = extractTimestamp(key);
    if (ts > newestTs) {
      newestTs = ts;
      newest = { key, src };
    }
  }
  return newest;
}

function extFromContentType(contentType) {
  if (!contentType) return 'webp';
  const type = contentType.split(';')[0].trim().toLowerCase();
  if (type === 'image/webp') return 'webp';
  if (type === 'image/png') return 'png';
  if (type === 'image/jpeg' || type === 'image/jpg') return 'jpg';
  return 'webp';
}

function sanitizeFilename(name) {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/\s+/g, ' ').trim();
}

async function downloadImage(src, destPath) {
  const res = await fetch(src, { signal: AbortSignal.timeout(120000) });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  const tempPath = `${destPath}.part`;
  fs.writeFileSync(tempPath, buf);
  fs.renameSync(tempPath, destPath);
  return buf.length;
}

async function downloadImageEntries(entries, outputDir) {
  if (entries.length === 0) {
    console.log('ℹ️ 未检测到新增图片');
    return [];
  }

  fs.mkdirSync(outputDir, { recursive: true });
  console.log(`\n📥 检测到 ${entries.length} 张新增图片，开始下载到 ${outputDir}`);

  const downloaded = [];
  for (let i = 0; i < entries.length; i++) {
    const { key, src } = entries[i];
    let basename;
    try {
      const keyUrl = new URL(key);
      basename = path.basename(keyUrl.pathname) || `image_${i + 1}`;
    } catch {
      basename = `image_${i + 1}`;
    }
    basename = sanitizeFilename(basename);
    if (!path.extname(basename)) basename += '.webp';

    let destPath = path.join(outputDir, basename);
    let counter = 1;
    const ext = path.extname(destPath);
    const stem = destPath.slice(0, -ext.length);
    while (fs.existsSync(destPath)) {
      destPath = `${stem}_${counter}${ext}`;
      counter++;
    }

    try {
      const probeRes = await fetch(src, { method: 'HEAD', signal: AbortSignal.timeout(30000) });
      const contentType = probeRes.headers.get('content-type');
      const finalExt = extFromContentType(contentType);
      destPath = destPath.replace(/\.[^.]+$/, `.${finalExt}`);
      counter = 1;
      const finalStem = destPath.slice(0, -path.extname(destPath).length);
      while (fs.existsSync(destPath)) {
        destPath = `${finalStem}_${counter}.${finalExt}`;
        counter++;
      }

      const bytes = await downloadImage(src, destPath);
      console.log(`✅ [${i + 1}/${entries.length}] ${path.basename(destPath)} (${bytes} bytes)`);
      downloaded.push(destPath);
    } catch (err) {
      console.error(`❌ [${i + 1}/${entries.length}] 下载失败: ${err.message}`);
    }
  }
  return downloaded;
}

(async function connectBrowserWithRetry() {
  for (;;) {
    try {
      return await puppeteer.connect({
        browserURL: CDP_URL,
        protocolTimeout: 300000,
        defaultViewport: null,
      });
    } catch (err) {
      console.error(`⚠️ 连接 Higgsfield 浏览器失败：${err.message}；5 秒后重试`);
      await sleep(5000);
    }
  }
})().then(async (browser) => {
  let page;
  for (;;) {
    try {
      page = await findPage(browser);
      break;
    } catch (err) {
      console.error(`⚠️ 读取 Higgsfield 页面失败：${err.message}；5 秒后断开旧会话并重连`);
      try { await browser.disconnect(); } catch {}
      restartChromeForProfile();
      await sleep(5000);
      for (;;) {
        try {
          browser = await puppeteer.connect({ browserURL: CDP_URL, protocolTimeout: 300000, defaultViewport: null });
          break;
        } catch (connectErr) {
          console.error(`⚠️ 重连 Higgsfield 失败：${connectErr.message}；5 秒后继续重试`);
          await sleep(5000);
        }
      }
    }
  }
  await page.bringToFront();
  console.log('✅ 已连接页面:', page.url());

  await closeDialog(page);
  await ensureModel(page);

  // 断点文件只在图片真正写入磁盘后更新，因此中断后可安全继续。
  const resumeState = loadResumeState(OUTPUT_DIR, REPLACEMENTS);
  const missingIndexes = findMissingImageIndexes(OUTPUT_DIR, REPLACEMENTS.length);
  const resumeIdx = REPLACEMENTS.length - missingIndexes.length;
  const padLen = String(REPLACEMENTS.length).length;
  if (missingIndexes.length > 0 && resumeIdx > 0) {
    console.log(`🔄 检测到 ${resumeIdx} 张已保存图片，将补生成缺失序号: ${missingIndexes.join(', ')}`);
  }

  if (missingIndexes.length === 0) {
    console.log('✅ 所有提示词已完成生成，无需继续');
    await browser.disconnect();
    return;
  }

  const allDownloaded = [];
  const downloadedSrcs = new Set(resumeState.saved.map((item) => item.src).filter(Boolean));
  const downloadedKeys = new Set(resumeState.saved.map((item) => item.key).filter(Boolean));
  const submittedIndexes = new Set(resumeState.submittedIndexes || []);
  const expectedIndexes = new Map(REPLACEMENTS.map((replacement, index) => [promptMatchKey(buildNewPrompt(replacement)), index + 1]));
  const missingIndexSet = new Set(missingIndexes);
  let downloadedThisRun = 0;

  // 先收集页面已有图片，用于 diff
  const knownMap = await collectImageUrls(page);
  if (!resumeState.baselineKeys || !resumeState.baselineSrcs) {
    // 在第一次提交前记录页面基线。后续重启时，基线之外的已生成图片仍会被保存。
    resumeState.baselineKeys = Array.from(knownMap.keys());
    resumeState.baselineSrcs = Array.from(knownMap.values()).map((item) => item.src);
    saveResumeState(resumeState);
  }
  const knownKeys = new Set(resumeState.baselineKeys);
  const knownSrcs = new Set(resumeState.baselineSrcs);
  console.log(`ℹ️ 当前页面已有 ${knownMap.size} 张图片（已按本次任务基线排除）`);

  async function downloadFreshImages(maxNewImages = Infinity) {
    const currentMap = await collectImageUrls(page);
    const freshEntries = [];
    for (const [assetId, item] of currentMap.entries()) {
      // Prefer the explicit epXX_NN marker embedded in the prompt. This is
      // stable across refreshes and virtualized task-card reorderings.
      const labeledIndex = promptIndexFromLabel(item.prompt);
      const nextIndex = labeledIndex || expectedIndexes.get(promptMatchKey(item.prompt));
      // 忽略本次启动前页面中已有的图片，避免恢复时误保存为新任务结果。
      const mayRecoverSubmittedJob = submittedIndexes.has(nextIndex);
      if (
        ((knownKeys.has(assetId) || knownSrcs.has(item.src)) && !mayRecoverSubmittedJob) ||
        downloadedKeys.has(assetId) ||
        downloadedSrcs.has(item.src) ||
        !nextIndex ||
        !missingIndexSet.has(nextIndex)
      ) {
        continue;
      }
      freshEntries.push({ ...item, assetId, nextIndex });
    }

    freshEntries.sort((a, b) => extractTimestamp(a.key) - extractTimestamp(b.key));
    let savedThisCall = 0;
    for (const entry of freshEntries) {
      if (downloadedThisRun >= missingIndexes.length) break;
      if (savedThisCall >= maxNewImages) break;

      const nextIndex = entry.nextIndex;
      const hash = sanitizeFilename(extractHash(entry.key)) || `image_${nextIndex}`;
      const filename = `${promptLabel(entry.prompt, nextIndex, padLen)}_${hash}.webp`;
      const destPath = path.join(OUTPUT_DIR, filename);
      if (fs.existsSync(destPath)) {
        throw new Error(`目标文件已存在，无法安全续传: ${destPath}`);
      }

      try {
        const bytes = await downloadImage(entry.src, destPath);
        downloadedThisRun++;
        savedThisCall++;
        downloadedKeys.add(entry.assetId);
        downloadedSrcs.add(entry.src);
        missingIndexSet.delete(nextIndex);
        resumeState.saved = resumeState.saved.filter((item) => item.index !== nextIndex);
        resumeState.saved.push({ index: nextIndex, filename, key: entry.assetId, src: entry.src, prompt: entry.prompt });
        saveResumeState(resumeState);
        console.log(`✅ [${nextIndex}/${REPLACEMENTS.length}] ${filename} (${bytes} bytes)`);
        allDownloaded.push(destPath);
      } catch (err) {
        // 失败时不推进编号，也不写状态；下次轮询或下次运行会重试这张图。
        console.error(`❌ [${nextIndex}] 下载失败: ${err.message}`);
      }
    }
  }

  // 续传启动时只回收断点中“已提交但未落盘”的序号。匹配条件是完整提示词，
  // 不会把页面历史图按时间/顺序错配到字幕；这样中断后已经完成的图不会被跳过。
  await downloadFreshImages();

  // 已提交只是一份本地历史记录，不是“永不重提”的锁。若当前页面既没有对应的
  // 进行中任务、也没有可回收的完成图，则站点任务已不可恢复，重新提交该缺图。
  const terminalStatuses = new Set(['completed', 'complete', 'done', 'success', 'succeeded', 'failed', 'cancelled', 'canceled', 'error', 'rejected']);
  const liveIndexes = new Set(
    (await collectCurrentJobStatuses(page))
      .filter((item) => !item.hasCompletedImage && !terminalStatuses.has(item.status))
      .map((item) => promptIndexFromLabel(item.prompt) || expectedIndexes.get(promptMatchKey(item.prompt)))
      .filter(Boolean)
  );
  // downloadFreshImages() 可能刚刚补回了部分启动时缺失的文件；提交前必须再次
  // 以实时缺失集合为准，绝不能把已下载的 20、21 等序号重复投递。
  const indexesToSubmit = missingIndexes.filter(
    (index) => missingIndexSet.has(index) && (!submittedIndexes.has(index) || !liveIndexes.has(index))
  );
  const requeuedIndexes = indexesToSubmit.filter((index) => submittedIndexes.has(index));
  if (requeuedIndexes.length > 0) {
    console.log(`⚠️ 已提交但页面无可恢复任务，将重新提交缺失序号: ${requeuedIndexes.join(', ')}`);
  }
  await ensureUnlimitedOn(page);

  for (const globalIdx of indexesToSubmit) {
    // 提交之间留出随机间隔，降低连续点击触发页面限流或状态错位的概率。
    if (globalIdx !== indexesToSubmit[0]) {
      const delayMs = 2000 + Math.floor(Math.random() * 1001);
      console.log(`⏱️ 距离下一条提交等待 ${(delayMs / 1000).toFixed(1)} 秒...`);
      await sleep(delayMs);
    }
    console.log(`\n=== 第 ${globalIdx} 次提交 / 共 ${REPLACEMENTS.length} 次 ===`);
    const expectedPrompt = REPLACEMENTS[globalIdx - 1]
      ? buildNewPrompt(REPLACEMENTS[globalIdx - 1])
      : '';
    let confirmed = false;
    while (!confirmed) {
      try {
        await closeDialog(page);
        await modifyPrompt(page, REPLACEMENTS[globalIdx - 1]);
        confirmed = await clickSubmit(page, CONCURRENCY, () => downloadFreshImages(), expectedPrompt);
      } catch (err) {
        if (err.message.includes('Execution context was destroyed') || err.message.includes('Protocol')) {
          console.log('🔄 提交期间页面发生导航，重新连接后重试当前条...');
          await sleep(3000);
          page = await findPage(browser);
          await page.bringToFront();
          confirmed = false;
          continue;
        }
        throw err;
      }
      if (!confirmed) {
        console.log(`↻ 第 ${globalIdx} 条提交未确认，3 秒后仅重试本条...`);
        await sleep(3000);
      }
    }
    // 只有点击成功后才标记为已提交；重启时会先等待这些未落盘的结果。
    resumeState.submitted = Math.max(resumeState.submitted, globalIdx);
    submittedIndexes.add(globalIdx);
    resumeState.submittedIndexes = Array.from(submittedIndexes).sort((a, b) => a - b);
    saveResumeState(resumeState);

    // 仅在已经提交当前任务之后下载；绝不在续传启动时拿页面历史图补位。
    // 并发槽位满时，waitForProcessingSlot 会等待空位再继续提交。
    await downloadFreshImages(1);
  }

  // 阶段 2：轮询等待生成完成，逐张保存
  console.log('\n⏳ 等待生成并逐张下载...');
  const expectedTotal = missingIndexes.length;
  const startTime = Date.now();
  const timeout = 600000; // 10 分钟
  let lastDownloadedCount = downloadedThisRun;
  let idleRounds = 0;

  while (downloadedThisRun < expectedTotal && Date.now() - startTime < timeout) {
    await sleep(5000);
    try {
      await downloadFreshImages();

      const remaining = expectedTotal - downloadedThisRun;
      if (remaining > 0) {
        const cards = await countProcessingCards(page);
        console.log(`   剩余 ${remaining} 张，当前处理中: ${cards}`);
        if (downloadedThisRun === lastDownloadedCount && cards === 0) {
          idleRounds++;
          if (idleRounds >= 6) {
            throw new Error(`仍有 ${remaining} 张图片未下载且页面无活动任务，重新提交当前缺失序号`);
          }
        } else {
          idleRounds = 0;
          lastDownloadedCount = downloadedThisRun;
        }
      }
    } catch (err) {
      if (
        err.message.includes('Execution context was destroyed') ||
        err.message.includes('Protocol')
      ) {
        console.log('🔄 页面发生导航/刷新，尝试重新连接...');
        await sleep(3000);
        page = await findPage(browser);
        await page.bringToFront();
        continue;
      }
      throw err;
    }
  }

  // 兜底：超时前再进行一次扫描。仍未保存的任务保留在断点状态中，可直接重跑。
  if (downloadedThisRun < expectedTotal) {
    console.log(
      `\n⚠️ 等待超时，已下载 ${downloadedThisRun}/${expectedTotal} 张，尝试兜底获取剩余图片...`
    );
    await downloadFreshImages();
  }

  console.log('\n🏁 流程结束');
  if (allDownloaded.length > 0) {
    console.log(`📁 共下载 ${allDownloaded.length} 张图片到: ${OUTPUT_DIR}`);
    for (const p of allDownloaded) console.log('   -', path.relative(process.cwd(), p));
  } else {
    console.log('ℹ️ 没有下载到图片');
  }
  await browser.disconnect();
}).catch((err) => {
  console.error('❌ 出错:', err.message);
  process.exit(1);
});
