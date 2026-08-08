#!/usr/bin/env bun
/**
 * volc-tts - 火山引擎口播稿转音频+字幕 CLI（media-cli 版）
 *
 * 迁移自 E:\projectHome\volc-tts（huobijueqi 项目 TTS 工具），对齐 media-cli 结构。
 *
 * 用法:
 *   bun src/cli.ts script.md                          # 输出 audio.mp3 + audio.srt
 *   bun src/cli.ts script.md -o output                # 指定输出文件名前缀
 *   bun src/cli.ts script.md --voice zh_female_qingxin # 指定音色
 *   bun src/cli.ts script.md --speed 1.2              # 语速 1.2x
 *   bun src/cli.ts multi script.md --langs zh,en,ja --align   # 多语种
 *
 * 环境变量:
 *   VOLC_API_KEY       火山引擎语音合成 API Key（必须，TTS+ASR）
 *   DASHSCOPE_API_KEY  通义千问 Key（multi 命令自动翻译用，可选）
 *
 * TTS 接口: POST https://openspeech.bytedance.com/api/v3/tts/unidirectional
 * ASR 接口: POST https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash
 */

import { Command } from "commander";
import { parseScript } from "./script";
import { textToSpeech, DEFAULT_VOICE } from "./tts";
import { audioToSubtitle } from "./asr";
import { translateText, LANGUAGES } from "./translate";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";

const pkg = await Bun.file(resolve(import.meta.dir, "../package.json")).json();

const program = new Command();

program
  .name("volc-tts")
  .description("火山引擎口播稿转音频+字幕 - 输入口播稿，一键生成配音 MP3 和 SRT 字幕")
  .version(pkg.version);

program
  .argument("<script>", "口播稿文件路径 (.md / .txt)")
  .option("-o, --output <path>", "输出文件前缀（默认: 与输入文件同名）")
  .option("--voice <type>", `音色 (默认: ${DEFAULT_VOICE})`, DEFAULT_VOICE)
  .option("--speed <ratio>", "语速比例", "1.0")
  .option("--lang <code>", "语种 (zh/en/ja/es-mx/id/pt-br/kr)")
  .option("--encoding <encoding>", "音频编码 (mp3/wav/pcm/opus)", "mp3")
  .option("--sample-rate <rate>", "音频采样率", "24000")
  .option("--skip-subtitle", "跳过字幕生成（只生成音频）")
  .option("--skip-tts", "跳过音频生成（只生成字幕，需已有音频）")
  .option("--audio-only", "只生成音频，不生成字幕")
  .option("--max-chars <n>", "每行字幕最大字符数", "20")
  .option("--verbose", "显示详细信息")
  .action(async (scriptPath, options) => {
    try {
      await run(scriptPath, options);
    } catch (err: any) {
      console.error(`\n❌ ${err.message}`);
      if (options.verbose && err.stack) {
        console.error(err.stack);
      }
      process.exit(1);
    }
  });

// doctor 命令 - 诊断可用的 TTS 服务
program
  .command("doctor")
  .description("诊断 TTS 服务")
  .action(async () => {
    console.log("\n  🔍 volc-tts 诊断\n");
    console.log(`  ${process.env.VOLC_API_KEY ? "✅" : "❌"} VOLC_API_KEY${process.env.VOLC_API_KEY ? " (已设置)" : " (未设置)"}`);
    console.log(`  ${process.env.DASHSCOPE_API_KEY ? "✅" : "❌"} DASHSCOPE_API_KEY${process.env.DASHSCOPE_API_KEY ? " (已设置)" : " (未设置)"}`);
    console.log("");
    console.log("  引擎: openspeech.bytedance.com (seed-tts-2.0)");
    console.log("  TTS: 需要 VOLC_API_KEY");
    console.log("  ASR 字幕: 需要 VOLC_API_KEY");
    console.log("  multi 自动翻译: 需要 DASHSCOPE_API_KEY（可选，有 script-{lang}.md 可跳过）");
    console.log("");
  });

// multi 命令 - 多语种音轨生成
program
  .command("multi")
  .description("从中文口播稿生成多语种音频+字幕 (zh/en/ja)")
  .argument("<script>", "口播稿文件路径 (.md / .txt)")
  .option("-o, --output <path>", "输出目录（默认: 与输入文件同目录）")
  .option("--langs <list>", "目标语言（逗号分隔，默认: zh,en,ja）", "zh,en,ja")
  .option("--voice-zh <type>", "中文音色", "zh_female_vv_uranus_bigtts")
  .option("--voice-en <type>", "英文音色", "zh_female_vv_uranus_bigtts")
  .option("--voice-ja <type>", "日语音色", "zh_female_vv_uranus_bigtts")
  .option("--speed <ratio>", "语速比例", "1.0")
  .option("--align", "对齐各语种音频时长（以第一个语种为基准）")
  .option("--verbose", "显示详细信息")
  .action(async (scriptArg, options) => {
    const scriptFile = resolve(process.cwd(), scriptArg);
    if (!existsSync(scriptFile)) throw new Error(`❌ 文件不存在: ${scriptFile}`);

    const outputDir = options.output
      ? resolve(process.cwd(), options.output)
      : dirname(scriptFile);

    const langs = options.langs.split(",").map((s: string) => s.trim());
    const speed = parseFloat(options.speed);

    console.log("\n  ╭──────────────────────────────────────╮");
    console.log("  │  🌍 多语种音轨生成                   │");
    console.log("  ╰──────────────────────────────────────╯\n");
    console.log(`  📄 口播稿: ${scriptFile}`);
    console.log(`  🌐 目标语言: ${langs.join(", ")}`);
    console.log(`  📁 输出目录: ${outputDir}\n`);

    // Step 1: 提取中文核心文本
    console.log("  [1/4] 解析口播稿...");
    const zhText = parseScript(scriptFile);
    if (!zhText) throw new Error("口播稿内容为空");
    console.log(`  ✅ 中文: ${zhText.length} 字\n`);

    // Step 2: 获取译文（优先找翻译好的文件，没有则尝试自动翻译）
    console.log("  [2/4] 获取译文...");
    const texts: Record<string, string> = { zh: zhText };
    for (const lang of langs) {
      if (lang === "zh") continue;
      // 先找同目录下的 script-{lang}.md
      const langFile = scriptFile.replace(/\.(md|txt)$/i, `-${lang}.md`);
      if (existsSync(langFile)) {
        texts[lang] = parseScript(langFile);
        console.log(`  ✅ ${lang}: 从 ${langFile} 读取 (${texts[lang].length} 字)`);
      } else {
        console.log(`  🌐 ${lang} 自动翻译中...`);
        try {
          texts[lang] = await translateText(zhText, lang);
          console.log(`  ✅ ${lang}: 翻译完成 (${texts[lang].length} 字)`);
        } catch (e: any) {
          console.log(`  ⚠️  自动翻译失败: ${e.message}`);
          console.log(`  📄 请准备 script-${lang}.md 放入同目录后重试`);
          continue;
        }
      }
    }
    console.log("");

    // Step 3: TTS + ASR for each language
    console.log("  [3/4] TTS 语音合成...");
    const voiceKey = (lang: string) => `voice${lang}`;
    for (const lang of langs) {
      const voice = options[voiceKey(lang)] || DEFAULT_VOICE;
      const text = texts[lang];
      if (!text) { console.log(`  ⚠️  ${lang} 无文本，跳过`); continue; }
      const prefix = `${outputDir}\\narration-${lang}`;
      console.log(`  🎤 ${lang.toUpperCase()} (${text.length}字, 音色: ${voice})`);

      try {
      // Split long text into chunks
      const MAX_CHUNK = 180;
      let chunks: string[] = [];
      if (text.length <= MAX_CHUNK) {
        chunks = [text];
      } else {
        const sentences = text.split(/(?<=[。！？.!?\n])/);
        let current = "";
        for (const s of sentences) {
          const t = s.trim();
          if (!t) continue;
          if ((current + t).length > MAX_CHUNK && current) {
            chunks.push(current);
            current = t;
          } else {
            current += t;
          }
        }
        if (current) chunks.push(current);
      }

      const buffers: Buffer[] = [];
      for (let i = 0; i < chunks.length; i++) {
        process.stdout.write(`    段 ${i + 1}/${chunks.length}... `);
        const result = await textToSpeech({
          apiKey: process.env.VOLC_API_KEY,
          text: chunks[i],
          voiceType: voice,
          speedRatio: speed,
          language: lang === "en" ? "en" : lang === "ja" ? "ja" : undefined,
        });
        buffers.push(Buffer.from(result.audio));
        console.log(`✅ ${(result.audio.length / 1024).toFixed(0)} KB`);
      }

      const total = Buffer.concat(buffers);
      await Bun.write(`${prefix}.mp3`, total);
      console.log(`  ✅ 音频已保存: ${prefix}.mp3 (${(total.length / 1024 / 1024).toFixed(1)} MB)`);

      // 字幕: ASR
      console.log(`  📝 ${lang.toUpperCase()} 字幕生成中...`);
      if (process.env.VOLC_API_KEY) {
        const srtContent = await audioToSubtitle({
          audioPath: `${prefix}.mp3`,
          apiKey: process.env.VOLC_API_KEY,
          maxChars: 20,
        });
        await Bun.write(`${prefix}.srt`, srtContent);
        const lineCount = srtContent.split("\n").filter((l) => l.trim() && !l.includes("-->") && /^\d+$/.test(l)).length;
        console.log(`  ✅ 字幕已保存: ${prefix}.srt (${lineCount} 条)`);
      } else {
        console.log(`  ⚠️  无 VOLC_API_KEY，字幕未生成`);
      }
      console.log("");
      } catch (e: any) {
        console.log(`  ⚠️  ${lang} 失败: ${e.message}`);
      }
    }

    // Step 4: 对齐时长 (以第一个语种为基准)
    if (options.align && langs.length > 1) {
      console.log("  [4/4] 对齐音频时长...");
      const firstPrefix = `${outputDir}\\narration-${langs[0]}`;
      const targetDur = await getAudioDuration(`${firstPrefix}.mp3`);
      console.log(`  📏 ${langs[0].toUpperCase()} 基准: ${targetDur.toFixed(1)}s`);

      for (const lang of langs.slice(1)) {
        const prefix = `${outputDir}\\narration-${lang}`;
        const dur = await getAudioDuration(`${prefix}.mp3`);
        if (dur <= 0) continue;
        const atempo = dur / targetDur;
        if (atempo < 0.5 || atempo > 2.0) {
          console.log(`  ⚠️ ${lang.toUpperCase()} ${dur.toFixed(1)}s → atempo=${atempo.toFixed(2)}x 超出范围，跳过`);
          continue;
        }
        if (Math.abs(atempo - 1) < 0.03) {
          console.log(`  ✅ ${lang.toUpperCase()} 已对齐 (${dur.toFixed(1)}s ≈ ${targetDur.toFixed(1)}s)`);
          continue;
        }
        const tmp = `${prefix}.align.mp3`;
        spawnSync("ffmpeg", ["-y", "-i", `${prefix}.mp3`, "-filter:a", `atempo=${atempo.toFixed(4)}`, "-q:a", "0", tmp], { stdio: "pipe" });
        await Bun.write(`${prefix}.mp3`, Bun.file(tmp));
        try { (await import("node:fs")).unlinkSync(tmp); } catch {}
        const nd = await getAudioDuration(`${prefix}.mp3`);

        // 同步缩放字幕时间轴
        const srtPath = `${prefix}.srt`;
        if (existsSync(srtPath)) {
          const srt = await Bun.file(srtPath).text();
          const adjusted = srt.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, (match) => {
            const [h, m, s, ms] = [match.slice(0,2), match.slice(3,5), match.slice(6,8), match.slice(9,12)].map(Number);
            const totalMs = (h * 3600 + m * 60 + s) * 1000 + ms;
            const newMs = Math.round(totalMs / atempo);
            const nh = Math.floor(newMs / 3600000);
            const nm = Math.floor((newMs % 3600000) / 60000);
            const ns = Math.floor((newMs % 60000) / 1000);
            const nms = newMs % 1000;
            return `${String(nh).padStart(2,'0')}:${String(nm).padStart(2,'0')}:${String(ns).padStart(2,'0')},${String(nms).padStart(3,'0')}`;
          });
          await Bun.write(srtPath, adjusted);
          console.log(`  ✅ ${lang.toUpperCase()} ${dur.toFixed(1)}s → ${nd.toFixed(1)}s + 字幕已对齐 (x${atempo.toFixed(3)})`);
        }
      }
      console.log("");
    }
    console.log("  ✅ 完成!\n");
    for (const lang of langs) {
      const prefix = `${outputDir}\\narration-${lang}`;
      console.log(`  🌐 ${LANGUAGES[lang]?.name || lang}`);
      console.log(`     🔊 ${prefix}.mp3`);
      console.log(`     📝 ${prefix}.srt`);
    }
    console.log("");
  });

program.parse(process.argv);

async function run(scriptArg: string, options: any) {
  // ---- 1. 解析参数 ----
  const scriptFile = resolve(process.cwd(), scriptArg);
  if (!existsSync(scriptFile)) {
    throw new Error(`❌ 文件不存在: ${scriptFile}`);
  }

  const outputPrefix = options.output
    ? resolve(process.cwd(), options.output)
    : scriptFile.replace(/\.(md|txt)$/i, "");

  const audioFile = `${outputPrefix}.mp3`;
  const srtFile = `${outputPrefix}.srt`;

  const apiKey = process.env.VOLC_API_KEY || "";
  const needsTts = !options.skipTts;
  const needsAsr = !options.skipSubtitle && !options.audioOnly;

  if (needsTts && !apiKey) throw new Error("❌ 缺少 VOLC_API_KEY");

  const speedRatio = parseFloat(options.speed) || 1.0;
  const maxChars = parseInt(options.maxChars) || 20;
  const sampleRate = parseInt(options.sampleRate) || 24000;
  const language = options.lang || "";

  console.log("");
  console.log("  ╭──────────────────────────────────────╮");
  console.log("  │  火山引擎 · 口播稿转音频+字幕        │");
  console.log("  ╰──────────────────────────────────────╯");
  console.log("");
  console.log(`  📄 口播稿: ${scriptFile}`);
  console.log(`  🔊 输出音频: ${audioFile}`);
  console.log(`  📝 输出字幕: ${srtFile}`);
  console.log(`  🎙️  音色: ${options.voice}`);
  console.log(`  ⚡ 语速: ${speedRatio}x`);
  console.log("");

  // ---- 2. 解析口播稿 ----
  console.log("  [1/3] 解析口播稿...");
  const text = parseScript(scriptFile);
  if (!text) throw new Error("❌ 口播稿内容为空");
  console.log(`  ✅ 提取 ${text.length} 字`);
  if (options.verbose) {
    console.log(`  ── 内容预览 ──`);
    console.log(`  ${text.slice(0, 200)}...`);
    console.log(`  ──────────────`);
  }

  // ---- 3. 语音合成 (TTS) ----
  if (!options.skipTts) {
    console.log("  [2/3] 语音合成中...");

    // 如果文本太长 (>200字)，分段合成后合并
    const MAX_CHUNK = 180; // API 建议单次不超过 200 字
    let chunks: string[] = [];
    if (text.length <= MAX_CHUNK) {
      chunks = [text];
    } else {
      // 按段落/句子拆分
      const sentences = text.split(/(?<=[。！？.!?\n])/);
      let current = "";
      for (const s of sentences) {
        const trimmed = s.trim();
        if (!trimmed) continue;
        if ((current + trimmed).length > MAX_CHUNK && current) {
          chunks.push(current);
          current = trimmed;
        } else {
          current += trimmed;
        }
      }
      if (current) chunks.push(current);
    }

    console.log(`  📦 ${chunks.length} 段待合成`);

    // 合成每一段
    const audioBuffers: Buffer[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      process.stdout.write(`  🎤 第 ${i+1}/${chunks.length} 段 (${chunk.length} 字)... `);

      const result = await textToSpeech({
        apiKey,
        text: chunk,
        voiceType: options.voice,
        encoding: options.encoding,
        speedRatio,
        language,
      });

      audioBuffers.push(Buffer.from(result.audio));
      console.log(`✅ ${(result.audio.length / 1024).toFixed(0)} KB`);
    }

    // 合并音频
    const totalAudio = Buffer.concat(audioBuffers);
    await Bun.write(audioFile, totalAudio);
    console.log(`  ✅ 音频已保存: ${audioFile} (${(totalAudio.length / 1024 / 1024).toFixed(1)} MB)`);
  }

  // ---- 4. 语音识别生成字幕 (ASR) ----
  if (!options.skipSubtitle && !options.audioOnly) {
    console.log("  [3/3] 语音识别生成字幕中...");

    // ASR 使用 VOLC_API_KEY (x-api-key 格式)
    if (!apiKey) throw new Error("❌ 缺少 ASR API Key (设置 VOLC_API_KEY)");

    const srtContent = await audioToSubtitle({
      audioPath: audioFile,
      apiKey,
      maxChars,
      verbose: options.verbose,
    });

    await Bun.write(srtFile, srtContent);
    const lineCount = srtContent.split("\n").filter(l => l.trim() && !l.includes("-->") && /^\d+$/.test(l)).length;
    console.log(`  ✅ 字幕已保存: ${srtFile} (${lineCount} 条)`);
  }

  // ---- 5. 完成 ----
  console.log("");
  console.log("  ╭──────────────────────────────────────╮");
  console.log("  │  ✅  完成!                            │");
  console.log("  ╰──────────────────────────────────────╯");
  console.log("");
  console.log(`  🔊 音频: ${audioFile}`);
  if (!options.audioOnly) {
    console.log(`  📝 字幕: ${srtFile}`);
  }
  console.log("");
}

/** 获取音频时长 (秒) */
async function getAudioDuration(filePath: string): Promise<number> {
  try {
    const result = spawnSync("ffprobe", [
      "-v", "quiet",
      "-show_entries", "format=duration",
      "-of", "csv=p=0",
      filePath,
    ], { stdio: "pipe", timeout: 10000 });
    if (result.status === 0 && result.stdout) {
      return parseFloat(result.stdout.toString().trim()) || 0;
    }
  } catch {}
  return 0;
}
