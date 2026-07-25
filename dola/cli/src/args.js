import { DEFAULT_ACCOUNT_POOL, DEFAULT_CDP, DEFAULT_OUT_DIR, DEFAULT_SESSION, DEFAULT_SESSION_STATE, DEFAULT_VIDEO_DURATION, DOLA_CHAT_HOME, VIDEO_MODEL_SEEDANCE_V2 } from './config.js';

export function usage() {
  console.log(`dola-cli

Submit a message, optionally with local image/file attachments, to Dola chat
through an existing Chrome session exposed on CDP port 9221.

Usage:
  dola --session <dola-chat-url|id> --prompt <text> [options]
  dola --new-chat --prompt <text> [options]
  dola --new-chat --batch-prompt-file <path> [options]
  dola --video-gen --prompt <text> [options]
  dola --video-gen --duration 15 --prompt <text> --out .\\downloads

Prerequisites:
  1. Start Chrome with --remote-debugging-port=9221.
  2. Log in to https://www.dola.com manually.
  3. Omit --session to reuse an open Dola chat or create one, or provide --session to use a specific chat.

Demos:
  dola --session "${DEFAULT_SESSION}" --dry-run
  dola --session "${DEFAULT_SESSION}" --file "E:\\temp\\aa.png" --prompt "璇锋弿杩拌繖寮犲浘鐗? --no-wait
  dola --file "E:\\temp\\aa.png" --prompt "What is in this image?"
  dola --character-image "E:\\temp\\avatar.png" \\
    --character-prompt "杩欐槸涓昏鐨勫舰璞★紝璇疯浣? --batch-prompt-file prompts.txt \\
    --character-batch-size 10 --out downloads
  dola --resume --new-chat --character-image "E:\\temp\\avatar.png" \\
    --character-prompt "杩欐槸涓昏鐨勫舰璞★紝璇疯浣? --batch-prompt-file prompts.txt \\
    --out downloads
  dola --account-pool "G:\\cookies\\dola" --resume --new-chat \\
    --character-image "E:\\temp\\avatar.png" \\
    --character-prompt "杩欐槸涓昏鐨勫舰璞★紝璇疯浣? --batch-prompt-file prompts.txt \\
    --out downloads

Options:
  --session <url|id>       Existing Dola chat URL/id, or ${DOLA_CHAT_HOME}.
  --new-chat               Start at ${DOLA_CHAT_HOME}.
  --resume                 Resume a batch from saved state/output files.
  --session-state <path>   Session/state file. Default: ${DEFAULT_SESSION_STATE}
  --account-pool <path>    Cookie directory or JSON account/CDP pool to rotate. Default: ${DEFAULT_ACCOUNT_POOL}
  --account-id <id>        Prefer this account id from the pool (example: dola_2).
  --list-accounts          Print account-pool status (cookies/health/usage) and exit.
  --prompt <text>          Prompt to submit. If omitted, the CLI asks interactively.
  --prompt-file <path>     Read prompt from a UTF-8 text file.
  --batch-prompt-file <path>
                           Generate images for each non-empty line in a UTF-8 text file.
  --from-line <n>         Start at this original prompt file line number.
  --to-line <n>           Stop at this original prompt file line number.
  --character-image <path> Fixed character reference image for batch generation.
  --character-prompt <text>
                           Prompt describing the fixed character reference image.
  --character-batch-size <n>
                           Re-upload the character image every n prompts. Default: 10
  --file <path>            Attach a local file before submitting. Can be repeated (0–n refs).
  --attach <path>          Alias for --file.
  --reference-image <path> Alias for --file in video mode. Can be repeated (0–n).
  --cdp <url>              Chrome CDP endpoint. Default: ${DEFAULT_CDP}
  --timeout <ms>           Max wait time after submit. Default: 120000
  --stable <ms>            Response text stability window. Default: 3000
  --max-retries <n>        Automatic retries after timeout/submit failure. Default: 2
  --image-gen              Enable Dola image generation and download images from the last reply only.
  --video-gen              Enable Dola video generation and download videos from the last reply only.
                           Flow (like reseller): 视频生成 → attach 0–n refs → prompt → send.
                           15s uses POST /chat/completion patch (ability_type=17 + seedance_v2.0).
  --duration <seconds>     Video duration: 5, 10, or 15 only (default: 5).
  --model <name>           Video model override (default: seedance_v2.0 when duration is 15).
  --aspect-ratio <ratio>   Video size/ratio, e.g. 16:9, 9:16, 1:1 (UI + completion patch).
  --out <path>             Image download directory. Default: ${DEFAULT_OUT_DIR}
  --count <n>              Number of images to download. Default: 1
  --no-download            Generate images without downloading them.
  --download-last-video    Download the newest video already generated in the current chat.
  --allow-watermark        Permit watermarked image/video URLs when no clean/no-watermark URL is available.
                           Video mode prefers get_play_info no-watermark URLs (same as the desktop reseller tool).
  --no-wait                Submit only; do not wait for response text.
  --debug-ui               Print visible input/button candidates and exit.
  --debug-images           Print captured image URLs and exit.
  --debug-video-menu        Open the newest video card's More menu and print UI diagnostics.
  --dry-run                Validate CDP/session only; do not submit a prompt.
  -h, --help               Show this help.

Image generation errors (non-zero exit):
  IMAGE_GENERATION_QUOTA_EXHAUSTED  The last reply indicates quota or usage exhaustion.
  ACCOUNT_RESTRICTED                The last reply indicates the account is restricted.
  IMAGE_GENERATION_REFUSED          The last reply indicates generation was refused.
  IMAGE_GENERATION_TEXT_RESPONSE    The last reply is text instead of an image.
  IMAGE_GENERATION_TIMEOUT          No image appeared in the last reply before timeout.
  IMAGE_GENERATION_NO_CLEAN_IMAGE   Only non-raw/watermarked image URLs were available.
  IMAGE_GENERATION_DUPLICATE_HASH   A downloaded image duplicated an earlier image.
  ACCOUNT_POOL_EXHAUSTED             Every account is restricted/quota-exhausted for today.
  ACCOUNT_COOKIE_INVALID             Cookie file missing session tokens or failed to load.
`);
}

export function parseArgs(argv) {
  const args = { accountPool: DEFAULT_ACCOUNT_POOL, cdp: DEFAULT_CDP, out: DEFAULT_OUT_DIR, count: 1, timeout: 120000, stable: 3000, maxRetries: 2, files: [] };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (!next) throw new Error(`Missing value for ${arg}`);
      return next;
    };
    if (arg === "-h" || arg === "--help") args.help = true;
    else if (arg === "--session") args.session = value();
    else if (arg === "--new-chat") args.newChat = true;
    else if (arg === "--resume") args.resume = true;
    else if (arg === "--session-state") args.sessionState = value();
    else if (arg === "--account-pool") args.accountPool = value();
    else if (arg === "--account-id") args.accountId = value();
    else if (arg === "--list-accounts") args.listAccounts = true;
    else if (arg === "--image-gen" || arg === "--image-generation") args.imageGen = true;
    else if (arg === "--video-gen" || arg === "--video-generation") args.videoGen = true;
    else if (arg === "--duration" || arg === "--video-duration") args.duration = value();
    else if (arg === "--model" || arg === "--video-model") args.model = value();
    else if (arg === "--aspect-ratio" || arg === "--ratio") args.aspectRatio = value();
    else if (arg === "--prompt") args.prompt = value();
    else if (arg === "--prompt-file") args.promptFile = value();
    else if (arg === "--batch-prompt-file") args.batchPromptFile = value();
    else if (arg === "--from-line") args.fromLine = Number(value());
    else if (arg === "--to-line") args.toLine = Number(value());
    else if (arg === "--character-image") args.characterImage = value();
    else if (arg === "--character-prompt") args.characterPrompt = value();
    else if (arg === "--character-batch-size") args.characterBatchSize = Number(value());
    else if (arg === "--file" || arg === "--attach" || arg === "--reference-image") args.files.push(value());
    else if (arg === "--cdp") {
      args.cdp = value();
      args.cdpExplicit = true;
    }
    else if (arg === "--out") args.out = value();
    else if (arg === "--count") args.count = Number(value());
    else if (arg === "--timeout") args.timeout = Number(value());
    else if (arg === "--stable") args.stable = Number(value());
    else if (arg === "--max-retries") args.maxRetries = Number(value());
    else if (arg === "--no-wait") args.noWait = true;
    else if (arg === "--no-download") args.noDownload = true;
    else if (arg === "--download-last-video") args.downloadLastVideo = true;
    else if (arg === "--allow-watermark") args.allowWatermark = true;
    else if (arg === "--debug-ui") args.debugUi = true;
    else if (arg === "--debug-images") args.debugImages = true;
    else if (arg === "--debug-video-menu") args.debugVideoMenu = true;
    else if (arg === "--dry-run") args.dryRun = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!Number.isFinite(args.count) || args.count < 1) throw new Error("--count must be a positive number.");
  if (!Number.isFinite(args.timeout) || args.timeout < 1000) throw new Error("--timeout must be at least 1000.");
  if (!Number.isFinite(args.stable) || args.stable < 500) throw new Error("--stable must be at least 500.");
  if (!Number.isInteger(args.maxRetries) || args.maxRetries < 0) throw new Error("--max-retries must be a non-negative integer.");
  if (args.characterBatchSize !== undefined && (!Number.isInteger(args.characterBatchSize) || args.characterBatchSize < 1)) {
    throw new Error("--character-batch-size must be a positive integer.");
  }
  if (args.fromLine !== undefined && (!Number.isInteger(args.fromLine) || args.fromLine < 1)) {
    throw new Error("--from-line must be a positive integer.");
  }
  if (args.toLine !== undefined && (!Number.isInteger(args.toLine) || args.toLine < 1)) {
    throw new Error("--to-line must be a positive integer.");
  }
  if (args.fromLine !== undefined && args.toLine !== undefined && args.fromLine > args.toLine) {
    throw new Error("--from-line cannot be greater than --to-line.");
  }
  const hasCharacterOption = Boolean(args.characterImage || args.characterPrompt || args.characterBatchSize !== undefined);
  if (hasCharacterOption) {
    if (!args.characterImage || !args.characterPrompt) throw new Error("--character-image and --character-prompt are both required for fixed-character batch generation.");
    if (!args.batchPromptFile) throw new Error("--character-image and --character-prompt require --batch-prompt-file.");
    if (args.count !== 1) throw new Error("Fixed-character batch generation only supports one image per prompt; omit --count or use --count 1.");
    args.characterBatchSize ??= 10;
    args.imageGen = true;
  }
  if (args.batchPromptFile) {
    if (args.prompt || args.promptFile) throw new Error("--batch-prompt-file cannot be combined with --prompt or --prompt-file.");
    if (args.noWait) throw new Error("--batch-prompt-file cannot be combined with --no-wait.");
    args.imageGen = true;
  }
  if (args.downloadLastVideo) args.videoGen = true;
  if (args.imageGen && args.videoGen) throw new Error("--image-gen and --video-gen cannot be combined.");
  if ((args.duration !== undefined || args.aspectRatio !== undefined || args.model !== undefined) && !args.videoGen) {
    throw new Error("--duration, --model, and --aspect-ratio require --video-gen.");
  }
  if (args.videoGen) {
    if (args.duration === undefined) args.duration = DEFAULT_VIDEO_DURATION;
    const duration = Number(args.duration);
    const allowed = new Set([5, 10, 15]);
    if (!Number.isFinite(duration) || !allowed.has(Math.round(duration))) {
      throw new Error("--duration must be one of 5, 10, or 15 seconds.");
    }
    args.duration = String(Math.round(duration));
    args.durationSeconds = Math.round(duration);
    if (args.model !== undefined) {
      const model = String(args.model || "").trim();
      if (!model) throw new Error("--model must be a non-empty model id (example: seedance_v2.0).");
      args.model = model;
    } else if (args.durationSeconds >= 15) {
      // Reseller tool: 15s only with Seedance v2 on ability_type=17.
      args.model = VIDEO_MODEL_SEEDANCE_V2;
    }
    // Normalize empty file list (0 refs is valid).
    if (!Array.isArray(args.files)) args.files = [];
  }
  if (args.videoGen && args.aspectRatio !== undefined && !/^\d+(?::\d+|\/\d+)$/.test(String(args.aspectRatio).trim())) {
    throw new Error("--aspect-ratio must look like 16:9, 9:16, or 1:1.");
  }
  if (args.videoGen && args.aspectRatio) {
    args.aspectRatio = String(args.aspectRatio).trim().replace("/", ":");
  }
  // Dola normally finishes video generation in 1-5 minutes. Keep the image
  // default for existing commands, while giving video jobs a practical window.
  // 15s Seedance jobs often need longer than short 5s clips.
  if (args.videoGen && args.timeout === 120000) {
    args.timeout = args.durationSeconds >= 15 ? 600000 : 360000;
  }
  if (args.resume && !args.batchPromptFile) throw new Error("--resume requires --batch-prompt-file.");
  return args;
}
