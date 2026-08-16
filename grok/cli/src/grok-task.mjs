#!/usr/bin/env node
/**
 * grok-task — fetch the latest Grok automation run result as a markdown file.
 *
 * Prerequisites:
 *   chrome.exe --remote-debugging-port=9221
 *   Log in to https://grok.com/ in that browser.
 *
 * Usage:
 *   node src/grok-task.mjs --id <automationId>
 *   node src/grok-task.mjs --id <uuid> -o ./downloads --name latest-run
 *   node src/grok-task.mjs --id <uuid> --dry-list
 */
import { resolve } from 'node:path';
import { DEFAULT_CDP_PORT, DEFAULT_OUT_DIR, DEFAULT_TIMEOUT_MS } from './lib/config.mjs';
import { fetchLatestAutomationRun } from './lib/automations/fetch-latest.mjs';
import { writeMarkdown } from './lib/output/write-markdown.mjs';

function printHelp() {
  console.log(`grok-task — 抓取 grok.com automation 最新运行结果（markdown）

前置：
  1. Chrome 开启远程调试，例如：
     chrome.exe --remote-debugging-port=9221 --user-data-dir="D:\\\\chrome-profiles\\\\grok"
  2. 在该浏览器中登录 https://grok.com/

用法：
  node src/grok-task.mjs --id <automationId>
  node src/grok-task.mjs --id <uuid> -o ./downloads --name latest-run
  node src/grok-task.mjs --id <uuid> --dry-list

选项：
  --id, --automation-id <uuid>  必填，automationId
  -o, --out <dir>               输出目录（默认 ./downloads）
  --name <basename>             输出文件名（无扩展名）
  --port <n>                    CDP 端口（默认 9221）
  --timeout <sec>               超时秒数（默认 120）
  --keep-open                   不关闭详情 tab
  --dry-list                    只列出 runs（JSON），不抓详情、不写盘
  -h, --help                    帮助
`);
}

function parseArgs(argv) {
  /** @type {Record<string, any>} */
  const a = {
    port: DEFAULT_CDP_PORT,
    out: resolve(DEFAULT_OUT_DIR),
    timeoutSec: DEFAULT_TIMEOUT_MS / 1000,
    keepOpen: false,
    dryList: false,
    help: false,
  };
  const rest = [...argv];
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
      case '--id':
      case '--automation-id':
        a.id = next();
        break;
      case '-o':
      case '--out':
        a.out = resolve(next());
        break;
      case '--name':
        a.name = next();
        break;
      case '--port':
        a.port = Number(next());
        break;
      case '--timeout':
        a.timeoutSec = Number(next());
        break;
      case '--keep-open':
        a.keepOpen = true;
        break;
      case '--dry-list':
        a.dryList = true;
        break;
      default:
        if (x.startsWith('-')) throw new Error(`未知参数：${x}`);
        // positional id
        if (!a.id) a.id = x;
        else throw new Error(`多余参数：${x}`);
    }
  }
  return a;
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(String(e.message || e));
    printHelp();
    process.exit(2);
  }

  if (args.help || !args.id) {
    printHelp();
    process.exit(args.help ? 0 : 2);
  }

  const cdp = `http://127.0.0.1:${args.port}`;
  const timeoutMs = Math.max(10, Number(args.timeoutSec) || 120) * 1000;

  try {
    const result = await fetchLatestAutomationRun({
      automationId: args.id,
      cdp,
      timeoutMs,
      keepOpen: args.keepOpen,
      dryList: args.dryList,
    });

    if (args.dryList) {
      console.log(
        JSON.stringify(
          {
            automationId: args.id,
            count: result.runs?.length || 0,
            latest: result.latest,
            runs: result.runs,
          },
          null,
          2,
        ),
      );
      return;
    }

    const written = writeMarkdown({
      outDir: args.out,
      name: args.name,
      markdown: result.markdown,
      automationId: args.id,
      runId: result.runId,
      sourceUrl: result.finalUrl,
    });

    // stdout: path only (script-friendly)
    console.log(written.path);
    console.error(
      `[grok-task] ok runId=${result.runId} bytes=${written.bytes} conversation=${result.conversationId}`,
    );
  } catch (e) {
    console.error('[grok-task] 失败:', e.message || e);
    process.exit(1);
  }
}

main();
