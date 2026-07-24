#!/usr/bin/env node
/**
 * 剧集批量生图编排（来自 E:\projectHome\jinqianxinglixue\generate_images.js）
 *
 * 职责：
 *  1. 从各集 narration-zh-merged.md 生成 higgsfield-prompts.txt
 *  2. 调用 media-cli/higgsfield/bot（higgsfield-bot）提交 CDP 生图并落盘
 *
 * 默认项目根目录：E:\projectHome\jinqianxinglixue
 * 可用 --root 或环境变量 JINQIAN_ROOT / HIGGSFIELD_PROJECT_ROOT 覆盖。
 *
 * 用法:
 *   node generate_images.js ep02
 *   node generate_images.js ep02 ep03 ep04
 *   node generate_images.js ep02,ep03,ep04
 *   node generate_images.js ep02-ep10
 *   node generate_images.js all
 *   node generate_images.js ep02 -k "自定义关键词"
 *   node generate_images.js ep02 -m "Nano Banana 3"
 *   node generate_images.js ep01 --dry-run
 *   node generate_images.js ep01 -c 2
 *   node generate_images.js ep01 --root "E:\\projectHome\\jinqianxinglixue"
 */

import { spawn, execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MEDIA_CLI_HIGGS = resolve(__dirname, "..");
const LOCAL_BOT = join(MEDIA_CLI_HIGGS, "bot", "higgsfield-bot.js");

/** 解析 higgsfield-bot 入口：优先本仓库 bot，其次全局 npm 包。 */
function resolveHiggsfieldBot() {
  if (existsSync(LOCAL_BOT)) return LOCAL_BOT;
  try {
    const npmPrefix = execSync("npm prefix -g", { encoding: "utf8" }).trim();
    const globalBot = join(npmPrefix, "node_modules", "higgsfield-bot", "higgsfield-bot.js");
    if (existsSync(globalBot)) return globalBot;
  } catch {
    // ignore
  }
  throw new Error(
    `找不到 higgsfield-bot。请确认存在：\n  ${LOCAL_BOT}\n或全局安装：npm install -g ${join(MEDIA_CLI_HIGGS, "bot")}`,
  );
}

const DEFAULT_ROOT =
  process.env.JINQIAN_ROOT ||
  process.env.HIGGSFIELD_PROJECT_ROOT ||
  "E:\\projectHome\\jinqianxinglixue";

// ── 金钱心理学剧集映射（与 jinqianxinglixue 一致）────────────────
const ALL_EPISODES = {
  ep01: "part-01-rethinking-money/ep01-why-smart-people-make-money-mistakes",
  ep02: "part-01-rethinking-money/ep02-success-luck-and-risk",
  ep03: "part-01-rethinking-money/ep03-why-more-is-never-enough",
  ep04: "part-01-rethinking-money/ep04-the-power-of-compounding",
  ep05: "part-01-rethinking-money/ep05-how-to-keep-wealth",
  ep06: "part-02-wealth-building/ep06-few-decisions-shape-wealth",
  ep07: "part-02-wealth-building/ep07-wealth-buys-optionality",
  ep08: "part-02-wealth-building/ep08-invisible-wealth",
  ep09: "part-02-wealth-building/ep09-why-saving-matters",
  ep10: "part-02-wealth-building/ep10-reasonable-over-perfect",
  ep11: "part-03-risk-and-uncertainty/ep11-why-simple-is-hard",
  ep12: "part-03-risk-and-uncertainty/ep12-why-we-try-to-predict",
  ep13: "part-03-risk-and-uncertainty/ep13-leave-room-for-error",
  ep14: "part-03-risk-and-uncertainty/ep14-future-self-will-change",
  ep15: "part-03-risk-and-uncertainty/ep15-the-price-of-returns",
  ep16: "part-04-meaning-and-freedom/ep16-your-own-financial-path",
  ep17: "part-04-meaning-and-freedom/ep17-why-bad-news-travels",
  ep18: "part-04-meaning-and-freedom/ep18-belief-and-bias",
  ep19: "part-04-meaning-and-freedom/ep19-what-the-rich-really-have",
  ep20: "part-04-meaning-and-freedom/ep20-what-money-is-for",
};

const REQUIRED_KEEP =
  "高品质3D动画电影风格，画面不出现任何文字、数字、字幕、标志或水印。根据字幕含义设计具有隐喻性和故事性的单一场景，通过角色动作、表情、视线、道具和环境关系准确传达概念，避免角色静站、正面讲解或简单摆拍。画面包含明确的前景、中景和背景，主体突出，空间层次丰富，构图简洁但不空洞。角色表演自然细腻，姿态具有动态感，场景中加入少量与主题相关的叙事细节和视觉对比。精致的动画电影角色设计，统一的材质与比例，柔和体积光，电影级布光，细腻阴影，适度景深，丰富但克制的色彩，干净背景，高完成度，高细节，视觉焦点清晰，适合作为口播视频配图。";

// ── parse args ────────────────────────────────────
const args = process.argv.slice(2);
const epKeys = [];
let model = "FLUX.2 Pro";
let extraKeep = "";
let dryRun = false;
let concurrency = "2";
let projectRoot = DEFAULT_ROOT;

function printHelp() {
  console.log(`
Higgsfield 剧集批量生图（源：jinqianxinglixue/generate_images.js）

用法:
  node generate_images.js <剧集> [剧集...] [选项]

剧集:
  ep01                    生成单集
  ep01 ep03               生成多集
  ep06-ep20               生成剧集范围
  all                     生成全部剧集

选项:
  --root <dir>            内容项目根目录（默认: ${DEFAULT_ROOT}）
  -m, --model <模型>       Higgsfield 模型，默认: FLUX.2 Pro
  -k, --keep <文本>        追加到每条提示词的固定约束
  -c, --concurrency <n>    并发数，必须为正整数，默认: 2
      --dry-run            只生成提示词，不提交生图任务
  -h, --help               显示帮助信息

示例:
  node generate_images.js ep01
  node generate_images.js ep06-ep20 -m "FLUX.2 Pro" -c 2
  node generate_images.js all --dry-run
  node generate_images.js ep01 --root "E:\\\\projectHome\\\\jinqianxinglixue"

底层引擎:
  ${LOCAL_BOT}
`);
}

if (args.includes("-h") || args.includes("--help") || args.length === 0) {
  printHelp();
  process.exit(args.length === 0 ? 1 : 0);
}

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "-m" || a === "--model") {
    model = args[++i];
  } else if (a === "-k" || a === "--keep") {
    extraKeep = args[++i] ?? "";
  } else if (a === "--dry-run") {
    dryRun = true;
  } else if (a === "--root") {
    projectRoot = resolve(args[++i]);
  } else if (a === "-c" || a === "--concurrency") {
    const value = Number(args[++i]);
    if (!Number.isInteger(value) || value < 1) {
      throw new Error("Higgsfield 生图并发数必须是正整数。");
    }
    concurrency = String(value);
  } else if (a === "-h" || a === "--help") {
    // already handled
  } else {
    for (const token of a.split(",")) {
      const t = token.trim().toLowerCase();
      if (t === "all") {
        epKeys.push(...Object.keys(ALL_EPISODES));
        break;
      }
      const range = t.match(/^ep(\d+)-ep(\d+)$/);
      if (range) {
        const s = Number(range[1]);
        const e = Number(range[2]);
        for (let n = s; n <= e; n++) {
          const key = `ep${String(n).padStart(2, "0")}`;
          if (ALL_EPISODES[key]) epKeys.push(key);
        }
      } else if (ALL_EPISODES[t]) {
        epKeys.push(t);
      } else {
        console.warn(`⚠ 未知剧集: ${t}，跳过`);
      }
    }
  }
}

const ROOT = resolve(projectRoot);
const HIGGSFIELD_BOT = resolveHiggsfieldBot();

function episodeTitle(epDir) {
  const scriptPath = join(epDir, "script.md");
  if (!existsSync(scriptPath)) return "本集口播主题";
  const heading = readFileSync(scriptPath, "utf8").match(/^#\s+(.+)$/m)?.[1]?.trim();
  if (!heading) return "本集口播主题";
  return heading.replace(/^第[一二三四五六七八九十百\d]+集\s*[｜|]\s*/, "");
}

function mergedSubtitles(mergedSubtitleFile) {
  const entries = [];
  for (const line of readFileSync(mergedSubtitleFile, "utf8").split(/\r?\n/)) {
    if (!line.startsWith("|")) continue;
    const columns = line.split("|").map((value) => value.trim());
    if (!/^\d+$/.test(columns[1] ?? "") || !columns[6]) continue;
    entries.push({ number: Number(columns[1]), subtitle: columns[6] });
  }
  if (entries.length === 0) {
    throw new Error(`未能从合并字幕读取 Markdown 表格记录：${mergedSubtitleFile}`);
  }
  return entries;
}

function buildHiggsfieldPrompts(mergedSubtitleFile, epDir, outputFile) {
  const theme = episodeTitle(epDir);
  const episodeCode = epDir.match(/(?:^|[\\/])(ep\d+)-/i)?.[1]?.toLowerCase() ?? "ep";
  const entries = mergedSubtitles(mergedSubtitleFile);
  const items = entries.map((entry, index) => {
    const previous = entries[index - 1]?.subtitle ?? "（本集开场）";
    const next = entries[index + 1]?.subtitle ?? "（本集结尾）";
    return {
      index: index + 1,
      subtitle: entry.subtitle,
      previous,
      next,
      prompt: `${episodeCode}_${String(index + 1).padStart(2, "0")} 当前字幕：${entry.subtitle} context:{主题：${theme} 上一句：${previous} 下一句：${next}}`,
    };
  });
  mkdirSync(dirname(outputFile), { recursive: true });
  writeFileSync(outputFile, `${items.map((item) => item.prompt).join("\n")}\n`, "utf8");
  writeFileSync(
    join(epDir, "visuals", "higgsfield-manifest.json"),
    `${JSON.stringify({ theme, items }, null, 2)}\n`,
    "utf8",
  );
  return entries.length;
}

function countEpisodeImages(outputDir) {
  if (!existsSync(outputDir)) return 0;
  return readdirSync(outputDir).filter((name) =>
    /^(?:ep\d+_)?\d+(?:_.*)?\.(?:webp|png|jpe?g)$/i.test(name),
  ).length;
}

const targets = [...new Set(epKeys)].sort();
if (targets.length === 0) {
  console.error("❌ 没有匹配的剧集");
  process.exit(1);
}

if (!existsSync(ROOT)) {
  console.error(`❌ 项目根目录不存在: ${ROOT}`);
  process.exit(1);
}

console.log(`\n🖼️  项目根: ${ROOT}`);
console.log(`🔧 higgsfield-bot: ${HIGGSFIELD_BOT}`);
console.log(`即将生成图片的剧集 (模型: ${model}，并发: ${concurrency}):`);
targets.forEach((k) => console.log(`  ${k} → ${ALL_EPISODES[k]}`));

let done = 0;
let processed = 0;
let skipped = 0;

for (const ep of targets) {
  done++;
  const partDir = ALL_EPISODES[ep];
  const epDir = join(ROOT, "episodes", partDir);
  const mergedSubtitleFile = join(epDir, "media", "audio", "narration-zh-merged.md");
  const outputDir = join(epDir, "visuals", "images");

  if (!existsSync(mergedSubtitleFile)) {
    skipped++;
    console.warn(`\n⚠ [${ep}] 合并字幕不存在: ${mergedSubtitleFile}，跳过`);
    continue;
  }

  mkdirSync(outputDir, { recursive: true });
  const promptFile = join(epDir, "visuals", "higgsfield-prompts.txt");
  const promptCount = buildHiggsfieldPrompts(mergedSubtitleFile, epDir, promptFile);
  const keep = [REQUIRED_KEEP, extraKeep].filter(Boolean).join(" ");

  console.log(`\n[${done}/${targets.length}] ===== ${ep} =====`);
  console.log(`  merged subtitles: ${mergedSubtitleFile}`);
  console.log(`  higgsfield prompt: ${promptFile} (${promptCount} 条)`);
  console.log(`  output: ${outputDir}`);

  if (dryRun) {
    console.log("  dry-run: 已生成提示词，未调用 Higgsfield。");
    processed++;
    continue;
  }

  for (;;) {
    try {
      await new Promise((resolvePromise, reject) => {
        const child = spawn(
          "node",
          [
            HIGGSFIELD_BOT,
            "-p",
            promptFile,
            "-m",
            model,
            "-k",
            keep,
            "-c",
            concurrency,
            "-o",
            outputDir,
          ],
          { cwd: ROOT, stdio: "inherit" },
        );
        let settled = false;
        const finish = (code) => {
          if (settled) return;
          settled = true;
          if (code === 0 || code === null) resolvePromise();
          else reject(new Error(`higgsfield-bot exited with code ${code}`));
        };
        child.once("exit", (code) => finish(code));
        child.once("close", (code) => finish(code));
        child.on("error", reject);
      });
      const imageCount = countEpisodeImages(outputDir);
      if (imageCount < promptCount) {
        throw new Error(`当前剧集仍缺少图片：${imageCount}/${promptCount}`);
      }
      console.log(`✅ 当前剧集图片已核对：${imageCount}/${promptCount}`);
      break;
    } catch (err) {
      console.error(`⚠️ Higgsfield 子进程失败：${err.message}；5 秒后重试当前剧集`);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  processed++;
}

console.log(`\n✅ 完成! 成功处理 ${processed} 集，跳过 ${skipped} 集`);
