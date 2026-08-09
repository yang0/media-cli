#!/usr/bin/env bun
/**
 * Doubao / Volcengine Podcast TTS CLI
 *
 * Usage:
 *   bun src/podcast/cli.mjs --nlp-file dialogues.json --out downloads/test.mp3
 *   bun src/podcast/cli.mjs --text "女:你好\n男:你好啊" --out downloads/hi.mp3
 *   bun src/podcast/cli.mjs --action 4 --prompt "适度宽松货币政策" --out downloads/topic.mp3
 *
 * Env (.env next to package or cwd):
 *   DOUBAO_PODCAST_APP_ID
 *   DOUBAO_PODCAST_ACCESS_TOKEN
 *   DOUBAO_PODCAST_SECRET_KEY   (optional)
 */

import { readFile, access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_SPEAKERS,
  generatePodcastToFiles,
  loadCredentialsFromEnv,
} from "./client.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(__dirname, "../..");

async function loadDotEnv() {
  const candidates = [
    path.join(PKG_ROOT, ".env"),
    path.join(process.cwd(), ".env"),
  ];
  for (const p of candidates) {
    try {
      await access(p);
      const raw = await readFile(p, "utf8");
      for (const line of raw.split(/\r?\n/)) {
        const t = line.trim();
        if (!t || t.startsWith("#")) continue;
        const eq = t.indexOf("=");
        if (eq <= 0) continue;
        const key = t.slice(0, eq).trim();
        let val = t.slice(eq + 1).trim();
        if (
          (val.startsWith('"') && val.endsWith('"')) ||
          (val.startsWith("'") && val.endsWith("'"))
        ) {
          val = val.slice(1, -1);
        }
        if (process.env[key] === undefined) process.env[key] = val;
      }
      return p;
    } catch {
      /* try next */
    }
  }
  return null;
}

function printHelp() {
  console.log(`doubao-podcast — Volcengine Podcast TTS (websocket-v3)

USAGE
  bun src/podcast/cli.mjs [options]

MODES (action)
  --action 3   Direct dialogue from nlp_texts  (default; best for 口播稿)
  --action 0   Summarize long text / URL into podcast
  --action 4   Web-search topic → podcast (prompt_text)

INPUT
  --nlp-file <path>     JSON array [{ "text", "speaker" }, ...]  (action=3)
  --text <str>          Inline turns: lines "女:..." / "男:..." or plain alternating
  --input-text <str>    Long source text (action=0)
  --input-url <url>     Source URL/pdf (action=0)
  --prompt <str>        Topic prompt (action=4)

OUTPUT
  --out <path>          Audio path (also writes .texts.json + .srt)  [required]
  --format mp3|wav|ogg_opus   default mp3
  --sample-rate 24000
  --speech-rate 0       [-50,100]
  --head-music          enable intro sting
  --tail-music          enable outro sting
  --return-audio-url    ask server for downloadable full mp3 URL (event 363)
  --quiet               less logs

SPEAKERS (action=3 defaults)
  female  ${DEFAULT_SPEAKERS.female}
  male    ${DEFAULT_SPEAKERS.male}

ENV
  DOUBAO_PODCAST_APP_ID
  DOUBAO_PODCAST_ACCESS_TOKEN
  DOUBAO_PODCAST_SECRET_KEY
  DOUBAO_PODCAST_ENDPOINT   (optional)
  DOUBAO_PODCAST_RESOURCE_ID (optional)

EXAMPLES
  bun src/podcast/cli.mjs --nlp-file script.json --out downloads/show.mp3
  bun src/podcast/cli.mjs --text "女:大家好\\n男:欢迎收听" --out downloads/hi.mp3
`);
}

/**
 * @param {string[]} argv
 */
function parseArgs(argv) {
  /** @type {Record<string, string|boolean|number>} */
  const args = {
    action: 3,
    format: "mp3",
    sampleRate: 24000,
    speechRate: 0,
    headMusic: false,
    tailMusic: false,
    returnAudioUrl: false,
    quiet: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`Missing value after ${a}`);
      return v;
    };
    switch (a) {
      case "-h":
      case "--help":
        args.help = true;
        break;
      case "--action":
        args.action = Number(next());
        break;
      case "--nlp-file":
        args.nlpFile = next();
        break;
      case "--text":
        args.text = next();
        break;
      case "--input-text":
        args.inputText = next();
        break;
      case "--input-url":
        args.inputUrl = next();
        break;
      case "--prompt":
      case "--prompt-text":
        args.prompt = next();
        break;
      case "--out":
      case "--output":
        args.out = next();
        break;
      case "--format":
        args.format = next();
        break;
      case "--sample-rate":
        args.sampleRate = Number(next());
        break;
      case "--speech-rate":
        args.speechRate = Number(next());
        break;
      case "--head-music":
        args.headMusic = true;
        break;
      case "--tail-music":
        args.tailMusic = true;
        break;
      case "--return-audio-url":
        args.returnAudioUrl = true;
        break;
      case "--quiet":
        args.quiet = true;
        break;
      default:
        if (a.startsWith("-")) throw new Error(`Unknown flag: ${a}`);
        throw new Error(`Unexpected argument: ${a}`);
    }
  }
  return args;
}

/**
 * Parse "女:xxx" / "男:xxx" / alternating plain lines into nlp_texts.
 * @param {string} text
 * @returns {{text:string,speaker:string}[]}
 */
function parseDialogueText(text) {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const out = [];
  let alt = 0;
  for (const line of lines) {
    const m = line.match(/^(女|男|female|male|F|M)\s*[:：]\s*(.+)$/i);
    if (m) {
      const tag = m[1].toLowerCase();
      const speaker =
        tag === "女" || tag === "female" || tag === "f"
          ? DEFAULT_SPEAKERS.female
          : DEFAULT_SPEAKERS.male;
      out.push({ text: m[2].trim(), speaker });
      continue;
    }
    // bare speaker ids
    const m2 = line.match(/^(zh_[a-z0-9_]+)\s*[:：]\s*(.+)$/i);
    if (m2) {
      out.push({ text: m2[2].trim(), speaker: m2[1] });
      continue;
    }
    out.push({
      text: line,
      speaker: alt % 2 === 0 ? DEFAULT_SPEAKERS.female : DEFAULT_SPEAKERS.male,
    });
    alt++;
  }
  return out;
}

async function main() {
  const envPath = await loadDotEnv();
  const args = parseArgs(process.argv.slice(2));
  if (args.help || process.argv.length <= 2) {
    printHelp();
    process.exit(args.help ? 0 : 1);
  }
  if (!args.out) {
    console.error("Error: --out <path> is required");
    process.exit(1);
  }

  const credentials = loadCredentialsFromEnv();
  const log = args.quiet ? () => {} : (line) => console.error(`[podcast] ${line}`);
  if (envPath) log(`loaded env ${envPath}`);

  /** @type {import('./client.mjs').GenerateOptions & { output: string }} */
  const options = {
    action: /** @type {0|3|4} */ (Number(args.action)),
    output: String(args.out),
    format: String(args.format),
    sampleRate: Number(args.sampleRate),
    speechRate: Number(args.speechRate),
    useHeadMusic: Boolean(args.headMusic),
    useTailMusic: Boolean(args.tailMusic),
    returnAudioUrl: Boolean(args.returnAudioUrl),
    onLog: log,
  };

  if (options.action === 3) {
    if (args.nlpFile) {
      const raw = await readFile(String(args.nlpFile), "utf8");
      const parsed = JSON.parse(raw);
      const list = Array.isArray(parsed)
        ? parsed
        : parsed.nlp_texts || parsed.texts || parsed.dialogues;
      if (!Array.isArray(list) || !list.length) {
        throw new Error("nlp-file must be a non-empty array of {text,speaker}");
      }
      options.nlpTexts = list.map((t) => ({
        text: t.text,
        speaker:
          t.speaker ||
          (t.role === "女" || t.role === "female"
            ? DEFAULT_SPEAKERS.female
            : t.role === "男" || t.role === "male"
              ? DEFAULT_SPEAKERS.male
              : DEFAULT_SPEAKERS.female),
      }));
    } else if (args.text) {
      options.nlpTexts = parseDialogueText(String(args.text));
    } else {
      throw new Error("action=3 needs --nlp-file or --text");
    }
  } else if (options.action === 0) {
    options.inputText = args.inputText ? String(args.inputText) : undefined;
    options.inputUrl = args.inputUrl ? String(args.inputUrl) : undefined;
    if (!options.inputText && !options.inputUrl) {
      throw new Error("action=0 needs --input-text or --input-url");
    }
  } else if (options.action === 4) {
    if (!args.prompt) throw new Error("action=4 needs --prompt");
    options.promptText = String(args.prompt);
  }

  const result = await generatePodcastToFiles(credentials, options);

  const summary = {
    status: "success",
    taskId: result.taskId,
    audioPath: result.audioPath,
    textsPath: result.textsPath,
    srtPath: result.srtPath,
    duration: result.textsJson.duration,
    duration_ts: result.textsJson.duration_ts,
    turns: result.textsJson.turns,
    audioBytes: result.audio.length,
    audioUrl: result.audioUrl || null,
    usage: result.usage || null,
  };
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  console.error(JSON.stringify({ status: "error", error: String(err?.stack || err) }));
  process.exit(1);
});
