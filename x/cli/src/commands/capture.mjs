import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { parseTweetReference } from "../lib/tweet-input.mjs";
import { captureTweet, TweetCaptureError } from "../lib/tweet-capture.mjs";
import { connectCdp } from "../lib/x-cdp.mjs";

function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}
function valueAfter(args, index, name) {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} 需要一个值`);
  return value;
}

export function parseCaptureArgs(args = []) {
  const positionals = [];
  const options = { port: 9221, width: 598, wait: 5, cutStats: false, outputDir: null };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--cut-stats" || arg === "--cutStats") { options.cutStats = true; continue; }
    if (arg === "--port" || arg === "--width" || arg === "--wait" || arg === "--output-dir") {
      const raw = valueAfter(args, i, arg); i += 1;
      if (arg === "--output-dir") options.outputDir = raw;
      else {
        const key = arg.slice(2);
        const number = Number(raw);
        if (!Number.isInteger(number) || number <= 0) throw new Error(`${arg} 必须是正整数`);
        options[key === "port" ? "port" : key] = number;
      }
      continue;
    }
    if (arg.startsWith("--")) throw new Error(`未知 capture 选项: ${arg}`);
    positionals.push(arg);
  }
  if (positionals.length !== 1) throw new Error("capture 需要且只能需要一个推文 URL 或纯数字 ID");
  return { input: positionals[0], options };
}

function defaultRunDir() {
  return path.resolve(process.cwd(), "downloads", "x", "captures", timestamp());
}

async function writeManifest(runDir, manifest) {
  await fs.mkdir(runDir, { recursive: true });
  await fs.writeFile(path.join(runDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

export async function handleCapture(args, { connect = connectCdp, capture = captureTweet } = {}) {
  let parsed;
  try { parsed = parseCaptureArgs(args); }
  catch (error) { console.error(`❌ ${error.message}`); process.exitCode = 2; return { ok: false, error }; }

  const reference = (() => {
    try { return parseTweetReference(parsed.input); }
    catch (error) { console.error(`❌ ${error.message}`); process.exitCode = 2; return null; }
  })();
  if (!reference) return { ok: false };

  const runDir = path.resolve(parsed.options.outputDir || defaultRunDir());
  const imagesDir = path.join(runDir, "images");
  const manifest = {
    source_url: reference.sourceUrl,
    canonical_url: reference.canonicalUrl,
    tweet_id: reference.tweetId,
    author_handle: null,
    captured_at: new Date().toISOString(),
    width: null,
    height: null,
    cut_stats: parsed.options.cutStats,
    sha256: null,
    image: null,
    error: null,
  };
  try {
    await fs.mkdir(imagesDir, { recursive: true });
    const cdp = await connect({ port: parsed.options.port });
    try {
      const result = await capture({ cdp, reference, ...parsed.options });
      const imagePath = path.join(imagesDir, `x-${reference.tweetId}.png`);
      await fs.writeFile(imagePath, result.png);
      manifest.author_handle = result.authorHandle || null;
      manifest.width = result.width;
      manifest.height = result.height;
      manifest.sha256 = result.sha256 || crypto.createHash("sha256").update(result.png).digest("hex");
      manifest.image = path.relative(runDir, imagePath).replaceAll(path.sep, "/");
      await writeManifest(runDir, manifest);
      console.log(`✅ 截图已保存: ${imagePath}`);
      console.log(`   尺寸: ${manifest.width} x ${manifest.height}`);
      process.exitCode = 0;
      return { ok: true, runDir, imagePath, manifest };
    } finally { cdp?.close?.(); }
  } catch (error) {
    const normalized = error instanceof TweetCaptureError ? error : new TweetCaptureError(error?.message || String(error), "cdp-unavailable");
    manifest.error_code = normalized.code;
    manifest.error = normalized.message;
    await writeManifest(runDir, manifest).catch(() => {});
    console.error(`❌ 截图失败: ${normalized.message}`);
    process.exitCode = 2;
    return { ok: false, runDir, manifest, error: normalized };
  }
}
