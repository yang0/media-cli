#!/usr/bin/env node
/**
 * chatgpt-img — generate images through chatgpt.com via Chrome CDP.
 *
 * Source logic: G:\初中\generate_wenyuan_grade8_images.mjs
 *
 * Prerequisites:
 *   chrome.exe --remote-debugging-port=9221
 *   Log in to https://chatgpt.com/ in that browser.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import {
  connectChatGPT,
  generateOnce,
} from './chatgpt-image.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function printHelp() {
  console.log(`chatgpt-img — 通过 chatgpt.com（Chrome CDP）生图

前置：
  1. 启动 Chrome 远程调试，例如：
     chrome.exe --remote-debugging-port=9221 --user-data-dir="D:\\\\chrome-profiles\\\\chatgpt"
  2. 在该浏览器中登录 https://chatgpt.com/

用法：
  node src/cli.mjs generate --prompt "一只赛博朋克橘猫" -o downloads
  node src/cli.mjs generate --prompt-file prompt.md -o downloads --name cat-01
  node src/cli.mjs batch --prompts-dir ./prompts -o ./figures
  node src/cli.mjs batch --prompt-list prompts.txt -o ./figures
  node src/cli.mjs dry-run --port 9221

选项：
  --port <n>            CDP 端口（默认 9221，与 G:\\\\初中 脚本一致）
  --prompt <text>       单条提示词
  --prompt-file <path>  从文件读提示词
  --prompts-dir <dir>   批量：目录内每个 .md/.txt 一条提示词
  --prompt-list <file>  批量：文本文件每行一条提示词（# 开头为注释）
  -o, --out <dir>       输出目录（默认 ./downloads）
  --name <basename>     单次生成文件名（无扩展名；默认时间戳）
  --wait-seconds <n>    等待生图秒数（默认 300）
  --retries <n>         失败/文字回复时换新标签页重试次数（默认 2）
  --limit <n>           批量最多处理条数
  --dry-run             只检查 CDP / chatgpt.com 标签，不提交
  -h, --help            帮助
`);
}

function parseArgs(argv) {
  const a = {
    cmd: null,
    port: 9221,
    out: resolve('downloads'),
    wait: 300,
    retries: 2,
    limit: 0,
    dryRun: false,
  };
  const rest = [...argv];
  if (rest[0] && !rest[0].startsWith('-')) a.cmd = rest.shift();

  for (let i = 0; i < rest.length; i++) {
    const x = rest[i];
    const next = () => {
      const v = rest[++i];
      if (v == null) throw new Error(`缺少参数值：${x}`);
      return v;
    };
    switch (x) {
      case '-h':
      case '--help':
        a.help = true;
        break;
      case '--dry-run':
        a.dryRun = true;
        break;
      case '--port':
        a.port = +next();
        break;
      case '--prompt':
        a.prompt = next();
        break;
      case '--prompt-file':
        a.promptFile = resolve(next());
        break;
      case '--prompts-dir':
        a.promptsDir = resolve(next());
        break;
      case '--prompt-list':
        a.promptList = resolve(next());
        break;
      case '-o':
      case '--out':
        a.out = resolve(next());
        break;
      case '--name':
        a.name = next();
        break;
      case '--wait-seconds':
        a.wait = +next();
        break;
      case '--retries':
        a.retries = +next();
        break;
      case '--limit':
        a.limit = +next();
        break;
      default:
        throw new Error(`未知参数：${x}`);
    }
  }
  return a;
}

function loadPrompt(a) {
  if (a.prompt != null) return a.prompt;
  if (a.promptFile) {
    if (!existsSync(a.promptFile)) throw new Error(`找不到提示词文件：${a.promptFile}`);
    return readFileSync(a.promptFile, 'utf8');
  }
  throw new Error('请提供 --prompt 或 --prompt-file');
}

function collectBatchJobs(a) {
  const jobs = [];
  if (a.promptsDir) {
    if (!existsSync(a.promptsDir)) throw new Error(`找不到目录：${a.promptsDir}`);
    const files = readdirSync(a.promptsDir)
      .filter((f) => /\.(md|txt)$/i.test(f))
      .sort();
    for (const f of files) {
      const full = join(a.promptsDir, f);
      jobs.push({
        id: basename(f, extname(f)),
        prompt: readFileSync(full, 'utf8'),
        source: full,
      });
    }
  } else if (a.promptList) {
    if (!existsSync(a.promptList)) throw new Error(`找不到列表：${a.promptList}`);
    const lines = readFileSync(a.promptList, 'utf8')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));
    lines.forEach((prompt, i) => {
      jobs.push({ id: String(i + 1).padStart(3, '0'), prompt, source: a.promptList });
    });
  } else {
    throw new Error('batch 需要 --prompts-dir 或 --prompt-list');
  }
  return a.limit > 0 ? jobs.slice(0, a.limit) : jobs;
}

async function withRetry(port, retries, work) {
  let session = await connectChatGPT(port);
  try {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const result = await work(session.cdp, attempt);
        if (result?.kind === 'text' && attempt < retries) {
          console.warn(`[retry] 返回文字，换新标签页重试（${attempt}/${retries}）`);
          session.cdp.close();
          session = await connectChatGPT(port, { newTab: true });
          continue;
        }
        return result;
      } catch (e) {
        if (attempt >= retries) throw e;
        console.warn(`[retry] ${e.message}，换新标签页重试（${attempt}/${retries}）`);
        session.cdp.close();
        session = await connectChatGPT(port, { newTab: true });
      }
    }
  } finally {
    session.cdp.close();
  }
}

async function cmdDryRun(a) {
  console.log(`[dry-run] 连接 CDP port ${a.port}...`);
  const { cdp, page } = await connectChatGPT(a.port);
  try {
    const title = await cdp.evaluate('document.title');
    const url = await cdp.evaluate('location.href');
    console.log(JSON.stringify({ ok: true, title, url, pageUrl: page.url }, null, 2));
  } finally {
    cdp.close();
  }
}

async function cmdGenerate(a) {
  const prompt = loadPrompt(a);
  mkdirSync(a.out, { recursive: true });
  const name = a.name || `chatgpt-${new Date().toISOString().replace(/[:.]/g, '-')}`;

  console.log(`[generate] port=${a.port} out=${a.out} name=${name}`);
  const result = await withRetry(a.port, a.retries, async (cdp) =>
    generateOnce(cdp, prompt, {
      outDir: a.out,
      basename: name,
      waitSeconds: a.wait,
    }),
  );

  if (result.kind === 'text') {
    console.error('[generate] ChatGPT 返回文字而非图片：');
    console.error(result.text.slice(0, 500));
    process.exitCode = 2;
    return;
  }
  console.log(JSON.stringify({ ok: true, path: result.path, url: result.url }, null, 2));
}

async function cmdBatch(a) {
  const jobs = collectBatchJobs(a);
  mkdirSync(a.out, { recursive: true });
  console.log(`[batch] ${jobs.length} 条任务 → ${a.out}`);

  const report = [];
  let session = await connectChatGPT(a.port);
  try {
    for (const job of jobs) {
      const existing = ['.webp', '.png', '.jpg', '.jpeg']
        .map((e) => join(a.out, job.id + e))
        .find(existsSync);
      if (existing) {
        console.log(`[skip] 已存在 ${existing}`);
        report.push({ id: job.id, status: 'skipped-exists', path: existing });
        continue;
      }

      let finished = false;
      for (let attempt = 1; attempt <= a.retries && !finished; attempt++) {
        try {
          console.log(`[run] ${job.id}（第${attempt}次）`);
          const result = await generateOnce(session.cdp, job.prompt, {
            outDir: a.out,
            basename: job.id,
            waitSeconds: a.wait,
          });
          if (result.kind === 'text') {
            if (attempt < a.retries) {
              console.warn(`[text] ${job.id} 返回文字，换标签重试`);
              session.cdp.close();
              session = await connectChatGPT(a.port, { newTab: true });
              continue;
            }
            report.push({ id: job.id, status: 'skipped-text', text: result.text?.slice(0, 200) });
            console.warn(`[skip-text] ${job.id}`);
            finished = true;
            continue;
          }
          report.push({ id: job.id, status: 'done', path: result.path });
          console.log(`[done] ${result.path}`);
          finished = true;
          await sleep(1200);
        } catch (e) {
          if (attempt >= a.retries) {
            report.push({ id: job.id, status: 'failed', error: e.message });
            console.error(`[fail] ${job.id}: ${e.message}`);
            finished = true;
          } else {
            console.warn(`[retry] ${job.id}: ${e.message}`);
            session.cdp.close();
            session = await connectChatGPT(a.port, { newTab: true });
          }
        }
      }
    }
  } finally {
    session.cdp.close();
  }

  const reportPath = join(a.out, 'chatgpt-batch-report.json');
  writeFileSync(reportPath, JSON.stringify({ time: new Date().toISOString(), report }, null, 2));
  console.log(`[batch] 报告 ${reportPath}`);
  const failed = report.filter((r) => r.status === 'failed' || r.status === 'skipped-text');
  if (failed.length) process.exitCode = 1;
}

async function main() {
  let a;
  try {
    a = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    printHelp();
    process.exitCode = 1;
    return;
  }

  if (a.help || !a.cmd) {
    printHelp();
    return;
  }

  // Allow `node cli.mjs --dry-run` as alias for dry-run command
  if (a.dryRun && a.cmd !== 'dry-run') a.cmd = 'dry-run';

  try {
    if (a.cmd === 'dry-run') await cmdDryRun(a);
    else if (a.cmd === 'generate') await cmdGenerate(a);
    else if (a.cmd === 'batch') await cmdBatch(a);
    else {
      console.error(`未知命令：${a.cmd}`);
      printHelp();
      process.exitCode = 1;
    }
  } catch (e) {
    console.error(e.stack || e.message);
    process.exitCode = 1;
  }
}

main();
