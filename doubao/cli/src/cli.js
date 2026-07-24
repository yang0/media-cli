#!/usr/bin/env bun
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { access, appendFile, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

const DEFAULT_CDP = "http://127.0.0.1:9221";
const DEFAULT_SESSION = "https://www.doubao.com/chat/38433955186592514";
const DOUBAO_CHAT_HOME = "https://www.doubao.com/chat";
const DEFAULT_OUT_DIR = "downloads";
const DEFAULT_SESSION_STATE = ".doubao-img-session.json";
const DEFAULT_DEBUG_LOG = "doubao-img-debug.log";

async function logDebug(label, data) {
  const timestamp = new Date().toISOString();
  let payload = "";
  try {
    payload = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  } catch (error) {
    payload = `[unserializable: ${error.message}]`;
  }
  const line = `[${timestamp}] [${label}] ${payload.replace(/\n/g, "\n  ")}\n`;
  await appendFile(DEFAULT_DEBUG_LOG, line).catch(() => {});
}

class DoubaoImgError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "DoubaoImgError";
    this.code = code;
    this.details = details;
  }
}

function usage() {
  console.log(`doubao-img

Submit a prompt to Doubao through Chrome CDP port 9221. It can use an existing
/chat/<id> session, or start from https://www.doubao.com/chat and return the
new URL after Doubao auto-redirects.

Usage:
  bun src/cli.js --session <doubao-chat-url|id> --prompt <text> [options]
  bun src/cli.js --new-chat --prompt <text> [options]
  bun src/cli.js --new-chat --batch-prompt-file <path> [options]

Prerequisites:
  1. Start Chrome with --remote-debugging-port=9221.
  2. Log in to https://www.doubao.com manually.
  3. Use --session for an existing chat, or --new-chat for Doubao chat home.

Demos:
  # Validate the current browser/session without submitting anything.
  bun src/cli.js --session "${DEFAULT_SESSION}" --dry-run

  # Submit one prompt and download one generated raw image.
  bun src/cli.js --session "${DEFAULT_SESSION}" --prompt "Generate a simple square icon of a yellow lemon on a clean white background" --out downloads --count 1

  # Start from Doubao chat home; Doubao creates/redirects to a new chat.
  bun src/cli.js --new-chat --prompt "Hello" --no-download

  # Equivalent: pass the chat home URL as --session.
  bun src/cli.js --session "${DOUBAO_CHAT_HOME}" --prompt "Hello" --no-download

  # Attach a local image and ask Doubao about it; finalUrl is printed.
  bun src/cli.js --new-chat --file "E:\\temp\\aa.png" --prompt "Explain the image" --no-download

  # Read a longer prompt from a UTF-8 text file.
  bun src/cli.js --session "${DEFAULT_SESSION}" --prompt-file prompt.txt --out downloads/batch --count 4

  # Batch-generate one image per non-empty line and save resume state.
  bun src/cli.js --new-chat --batch-prompt-file prompts.txt --out downloads --count 1

  # Resume a batch, skipping completed line-number/hash output files.
  bun src/cli.js --resume --new-chat --batch-prompt-file prompts.txt --out downloads

  # Use an account pool; accepts cookie directory or JSON {"accounts":[...]}.
  bun src/cli.js --account-pool accounts.json --resume --new-chat --batch-prompt-file prompts.txt --out downloads

Options:
  --session <url|id>       Existing Doubao chat URL/id, or ${DOUBAO_CHAT_HOME}.
  --new-chat               Start at ${DOUBAO_CHAT_HOME}; print the auto-redirected finalUrl.
  --resume                 Resume a batch from saved state/output files.
  --session-state <path>   Session/state file. Default: ${DEFAULT_SESSION_STATE}
  --account-pool <path>    Cookie directory or JSON account/CDP pool to rotate.
  --prompt <text>          Prompt to submit. If omitted, the CLI asks interactively.
  --prompt-file <path>     Read prompt from a UTF-8 text file.
  --batch-prompt-file <path>
                           Generate images for each non-empty line in a UTF-8 text file.
  --from-line <n>          Start at this original prompt file line number.
  --to-line <n>            Stop at this original prompt file line number.
  --character-image <path> Fixed character reference image for batch generation.
  --character-prompt <text>
                           Prompt describing the fixed character reference image.
  --character-batch-size <n>
                           Re-upload the character image every n prompts. Default: 10
  --character-wait <ms>    Wait after submitting character context. Default: 15000
  --file <path>            Attach a local file before submitting. Can be repeated.
  --attach <path>          Alias for --file.
  --cdp <url>              Chrome CDP endpoint. Default: ${DEFAULT_CDP}
  --out <dir>              Download directory. Default: ${DEFAULT_OUT_DIR}
  --count <n>              Stop after at least n raw images. Default: 1
  --timeout <ms>           Max wait time after submit. Default: 240000
  --stable <ms>            Wait for captured raw images to stop changing. Default: 10000
  --fallback-after <ms>    Use stable non-raw fallback images after this wait. Default: 45000
  --max-retries <n>        Automatic retries after timeout/submit failure. Default: 2
  --no-download            Submit only; do not wait for or download generated images.
  --dry-run                Validate CDP/session only; do not submit a prompt.
  --inspect-session <url>  Connect to a session and dump current images/creations/button state.
  -h, --help               Show this help.

Notes:
  - The CLI requires either --session or --new-chat before submitting any prompt.
  - It talks directly to Chrome's /json and page WebSocket CDP endpoints.
  - When opening a new Doubao session, it closes other Doubao tabs in the same browser.
  - Image generation submissions click the form's "图像生成" mode before typing.
  - If Doubao is still generating, the CLI keeps waiting in the current session instead of opening a new one.
  - It prefers creations[].image.image_ori_raw.url and falls back only if raw URLs are not found.
  - Attachments are set through CDP DOM.setFileInputFiles on Doubao's hidden file input.
  - Batch mode keeps Doubao-specific page parsing; only queue/state/account-pool logic is aligned with dola-cli.
`);
}


function parseArgs(argv) {
  const args = { cdp: DEFAULT_CDP, out: DEFAULT_OUT_DIR, count: 1, timeout: 240000, stable: 10000, fallbackAfter: 45000, characterWait: 15000, maxRetries: 2, files: [] };
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
    else if (arg === "--prompt") args.prompt = value();
    else if (arg === "--prompt-file") args.promptFile = value();
    else if (arg === "--batch-prompt-file") args.batchPromptFile = value();
    else if (arg === "--from-line") args.fromLine = Number(value());
    else if (arg === "--to-line") args.toLine = Number(value());
    else if (arg === "--character-image") args.characterImage = value();
    else if (arg === "--character-prompt") args.characterPrompt = value();
    else if (arg === "--character-batch-size") args.characterBatchSize = Number(value());
    else if (arg === "--character-wait") args.characterWait = Number(value());
    else if (arg === "--file" || arg === "--attach") args.files.push(value());
    else if (arg === "--cdp") args.cdp = value();
    else if (arg === "--out") args.out = value();
    else if (arg === "--count") args.count = Number(value());
    else if (arg === "--timeout") args.timeout = Number(value());
    else if (arg === "--stable") args.stable = Number(value());
    else if (arg === "--fallback-after") args.fallbackAfter = Number(value());
    else if (arg === "--max-retries") args.maxRetries = Number(value());
    else if (arg === "--no-download") args.noDownload = true;
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--inspect-session") args.inspectSession = value();
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!Number.isFinite(args.count) || args.count < 1) throw new Error("--count must be a positive number.");
  if (!Number.isFinite(args.timeout) || args.timeout < 1000) throw new Error("--timeout must be at least 1000.");
  if (!Number.isFinite(args.stable) || args.stable < 1000) throw new Error("--stable must be at least 1000.");
  if (!Number.isFinite(args.fallbackAfter) || args.fallbackAfter < 0) throw new Error("--fallback-after must be a non-negative number.");
  if (!Number.isInteger(args.maxRetries) || args.maxRetries < 0) throw new Error("--max-retries must be a non-negative integer.");
  if (args.fromLine !== undefined && (!Number.isInteger(args.fromLine) || args.fromLine < 1)) throw new Error("--from-line must be a positive integer.");
  if (args.toLine !== undefined && (!Number.isInteger(args.toLine) || args.toLine < 1)) throw new Error("--to-line must be a positive integer.");
  if (args.fromLine !== undefined && args.toLine !== undefined && args.fromLine > args.toLine) throw new Error("--from-line cannot be greater than --to-line.");
  if (args.characterBatchSize !== undefined && (!Number.isInteger(args.characterBatchSize) || args.characterBatchSize < 1)) {
    throw new Error("--character-batch-size must be a positive integer.");
  }
  if (!Number.isFinite(args.characterWait) || args.characterWait < 0) throw new Error("--character-wait must be a non-negative number.");
  const hasCharacterOption = Boolean(args.characterImage || args.characterPrompt || args.characterBatchSize !== undefined);
  if (hasCharacterOption) {
    if (!args.characterImage || !args.characterPrompt) throw new Error("--character-image and --character-prompt are both required for fixed-character batch generation.");
    if (!args.batchPromptFile) throw new Error("--character-image and --character-prompt require --batch-prompt-file.");
    if (args.count !== 1) throw new Error("Fixed-character batch generation only supports one image per prompt; omit --count or use --count 1.");
    args.characterBatchSize ??= 10;
  }
  if (args.batchPromptFile) {
    if (args.prompt || args.promptFile) throw new Error("--batch-prompt-file cannot be combined with --prompt or --prompt-file.");
  }
  if (args.resume && !args.batchPromptFile) throw new Error("--resume requires --batch-prompt-file.");
  return args;
}

async function askRequired(question) {
  const rl = createInterface({ input, output });
  try {
    const answer = (await rl.question(question)).trim();
    if (!answer) throw new Error("Required input was empty.");
    return answer;
  } finally {
    rl.close();
  }
}

function normalizeSession(session) {
  const value = String(session || "").trim();
  if (!value) throw new Error("chat session is required.");
  if (/^https?:\/\//i.test(value)) {
    const url = new URL(value);
    if (!/(^|\.)doubao\.com$/i.test(url.hostname)) throw new Error("session URL must be a doubao.com URL.");
    if (url.pathname.replace(/\/+$/, "") === "/chat") return DOUBAO_CHAT_HOME;
    return url.toString();
  }
  if (/^\d{8,}$/.test(value)) return `https://www.doubao.com/chat/${value}`;
  throw new Error("chat session must be a Doubao chat URL or numeric session id.");
}

function isChatHomeUrl(url) {
  try {
    const parsed = new URL(url);
    return /(^|\.)doubao\.com$/i.test(parsed.hostname) && parsed.pathname.replace(/\/+$/, "") === "/chat";
  } catch {
    return false;
  }
}

function isConcreteChatUrl(url) {
  try {
    const parsed = new URL(url);
    return /(^|\.)doubao\.com$/i.test(parsed.hostname) && /^\/chat\/\d+\/?$/.test(parsed.pathname);
  } catch {
    return false;
  }
}

async function loadPrompt(args) {
  if (args.promptFile) return (await readFile(args.promptFile, "utf8")).trim();
  if (args.prompt) return String(args.prompt).trim();
  return askRequired("Prompt to submit: ");
}

async function loadBatchPrompts(file) {
  const text = await readFile(file, "utf8");
  const prompts = text
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((line, index) => ({ text: line.trim(), line: index + 1 }))
    .filter(item => item.text);
  if (!prompts.length) throw new Error(`No non-empty prompts found in batch file: ${file}`);
  return prompts;
}

async function readJsonFile(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error(`Could not read JSON state file ${file}: ${error.message}`);
  }
}

async function writeJsonFile(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const tempFile = `${file}.${process.pid}.tmp`;
  await writeFile(tempFile, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tempFile, file);
}

function accountDayKey(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

async function loadAccountPool(file) {
  const absoluteFile = path.resolve(file);
  try {
    const entries = await readdir(absoluteFile, { withFileTypes: true });
    const cookieFiles = entries
      .filter(entry => entry.isFile() && /\.(txt|cookies?|json)$/i.test(entry.name))
      .map(entry => path.join(absoluteFile, entry.name))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    if (!cookieFiles.length) throw new Error(`No cookie files found in account pool directory: ${file}`);
    return cookieFiles.map((cookieFile, index) => ({
      id: path.basename(cookieFile, path.extname(cookieFile)) || `account-${index + 1}`,
      cdp: DEFAULT_CDP,
      session: "",
      cookieFile,
    }));
  } catch (error) {
    if (error?.code !== "ENOTDIR") throw error;
  }

  const value = await readJsonFile(absoluteFile);
  const entries = Array.isArray(value) ? value : value?.accounts;
  if (!Array.isArray(entries) || !entries.length) {
    throw new Error(`Account pool must contain a non-empty JSON array or {"accounts": [...]}: ${file}`);
  }
  const accounts = entries.map((entry, index) => {
    if (!entry || typeof entry !== "object") throw new Error(`Account pool entry ${index + 1} must be an object.`);
    const id = String(entry.id || entry.name || `account-${index + 1}`).trim();
    if (!id) throw new Error(`Account pool entry ${index + 1} has an empty id.`);
    const cdp = String(entry.cdp || DEFAULT_CDP).trim();
    const session = entry.session ? normalizeSession(entry.session) : "";
    const cookieFile = entry.cookieFile || entry.cookies || entry.cookie
      ? path.resolve(String(entry.cookieFile || entry.cookies || entry.cookie))
      : "";
    return { id, cdp, session, cookieFile };
  });
  const ids = new Set();
  for (const account of accounts) {
    if (ids.has(account.id)) throw new Error(`Duplicate account id in pool: ${account.id}`);
    ids.add(account.id);
  }
  return accounts;
}

async function loadNetscapeCookies(file) {
  const text = await readFile(file, "utf8");
  if (file.toLowerCase().endsWith(".json")) {
    const value = JSON.parse(text);
    const entries = Array.isArray(value) ? value : value.cookies;
    if (!Array.isArray(entries)) throw new Error(`Cookie JSON must be an array or contain cookies: ${file}`);
    return entries.map(cookie => ({ ...cookie }));
  }
  return text.split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && (!line.startsWith("#") || line.startsWith("#HttpOnly_")))
    .map(line => ({ httpOnly: line.startsWith("#HttpOnly_"), parts: (line.startsWith("#HttpOnly_") ? line.slice("#HttpOnly_".length) : line).split("\t") }))
    .filter(item => item.parts.length >= 7)
    .map(({ parts, httpOnly }) => {
      const [domain, includeSubdomains, cookiePath, secure, expires, name, value] = parts;
      return {
        domain,
        path: cookiePath || "/",
        secure: String(secure).toUpperCase() === "TRUE",
        ...(Number(expires) > 0 ? { expires: Number(expires) } : {}),
        name,
        value,
        httpOnly,
        sameSite: "Lax",
        includeSubdomains: String(includeSubdomains).toUpperCase() === "TRUE",
      };
    });
}

async function applyAccountCookies(client, account) {
  if (!account?.cookieFile) return;
  const cookies = await loadNetscapeCookies(account.cookieFile);
  if (!cookies.length) throw new Error(`No cookies found in account file: ${account.cookieFile}`);
  await client.send("Network.clearBrowserCookies");
  await client.send("Network.setCookies", { cookies });
  console.log(`[doubao-img] loaded ${cookies.length} cookie(s) for account ${account.id}`);
}

function restrictedAccountSet(savedState, day) {
  const values = savedState?.restrictedAccounts?.[day];
  return new Set(Array.isArray(values) ? values.map(String) : []);
}

function chooseAccount(accounts, restricted, preferredId = "") {
  const preferred = accounts.find(account => account.id === preferredId && !restricted.has(account.id));
  const next = preferred || accounts.find(account => !restricted.has(account.id));
  if (!next) {
    throw new DoubaoImgError("ACCOUNT_POOL_EXHAUSTED", "All accounts in the pool are restricted for today.", {
      day: accountDayKey(),
      restrictedAccounts: [...restricted],
    });
  }
  return next;
}

function accountStateFields(accountPoolFile, activeAccount, restricted) {
  if (!accountPoolFile) return {};
  return {
    accountPoolFile: path.resolve(accountPoolFile),
    accountId: activeAccount?.id || "",
    restrictedAccounts: { [accountDayKey()]: [...restricted].sort() },
  };
}

async function inferCompletedOutput(outDir) {
  const completed = [];
  let names = [];
  try {
    names = await readdir(outDir);
  } catch (error) {
    if (error?.code === "ENOENT") return completed;
    throw error;
  }
  for (const name of names) {
    const match = /^(\d+),([a-f0-9]{12})\.(png|jpe?g|webp|gif)$/i.exec(name);
    if (!match) continue;
    const file = path.resolve(outDir, name);
    const bytes = await readFile(file);
    const hash = createHash("sha256").update(bytes).digest("hex");
    completed.push({ line: Number(match[1]), hash, shortHash: hash.slice(0, 12), file });
  }
  return completed;
}

async function normalizeFiles(files) {
  const resolved = [];
  for (const file of files || []) {
    const fullPath = path.resolve(file);
    await access(fullPath, fsConstants.R_OK).catch(() => {
      throw new Error(`Attachment is not readable: ${fullPath}`);
    });
    resolved.push(fullPath);
  }
  return resolved;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function cdpHttpUrl(cdp, pathname) {
  const base = new URL(cdp);
  return `${base.origin}${pathname}`;
}

class CdpClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.id = 1;
    this.pending = new Map();
    this.events = new Map();
  }

  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    this.ws.onmessage = event => this.handleMessage(String(event.data));
    this.ws.onerror = () => {};
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`CDP WebSocket timeout: ${this.wsUrl}`)), 15000);
      this.ws.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      this.ws.onclose = () => {
        clearTimeout(timer);
        reject(new Error(`CDP WebSocket closed before opening: ${this.wsUrl}`));
      };
    });
  }

  handleMessage(raw) {
    const msg = JSON.parse(raw);
    if (msg.id && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else resolve(msg.result || {});
      return;
    }
    if (msg.method && this.events.has(msg.method)) {
      for (const fn of this.events.get(msg.method)) fn(msg.params || {});
    }
  }

  on(method, fn) {
    if (!this.events.has(method)) this.events.set(method, new Set());
    this.events.get(method).add(fn);
  }

  send(method, params = {}) {
    const id = this.id++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command timed out: ${method}`));
      }, 30000);
      this.pending.set(id, {
        resolve: result => {
          clearTimeout(timer);
          resolve(result);
        },
        reject: error => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
  }

  close() {
    this.ws?.close();
  }
}

async function findOrCreateTarget(cdp, sessionUrl, forceNew = false) {
  const targets = await fetch(cdpHttpUrl(cdp, "/json/list")).then(r => r.json());
  if (!forceNew) {
    let target = targets.find(item => item.type === "page" && item.url === sessionUrl);
    if (!target && isChatHomeUrl(sessionUrl)) {
      target = targets.find(item => item.type === "page" && item.url.replace(/\/+$/, "") === DOUBAO_CHAT_HOME);
    }
    if (!target && !isChatHomeUrl(sessionUrl)) {
      target = targets.find(item => item.type === "page" && /doubao\.com\/chat\//i.test(item.url));
    }
    if (target) return target;
  }

  const created = await fetch(cdpHttpUrl(cdp, `/json/new?${encodeURIComponent(sessionUrl)}`), { method: "PUT" })
    .then(r => r.ok ? r.json() : fetch(cdpHttpUrl(cdp, `/json/new?${encodeURIComponent(sessionUrl)}`)).then(rr => rr.json()));
  await closeOtherDoubaoTargets(cdp, created.id);
  return created;
}

function isDoubaoPageTarget(target) {
  if (target?.type !== "page") return false;
  try {
    const url = new URL(target.url || "about:blank");
    return /(^|\.)doubao\.com$/i.test(url.hostname);
  } catch {
    return false;
  }
}

async function closeOtherDoubaoTargets(cdp, keepTargetId) {
  const targets = await fetch(cdpHttpUrl(cdp, "/json/list")).then(r => r.json());
  const closing = targets.filter(target => isDoubaoPageTarget(target) && target.id !== keepTargetId);
  for (const target of closing) {
    await fetch(cdpHttpUrl(cdp, `/json/close/${encodeURIComponent(target.id)}`)).catch(() => {});
  }
  if (closing.length) {
    console.log(`[doubao-img] closed ${closing.length} other Doubao tab(s)`);
  }
}

async function waitForConcreteChatUrl(client, initialUrl, timeoutMs = 60000) {
  const started = Date.now();
  let lastUrl = initialUrl;
  while (Date.now() - started < timeoutMs) {
    lastUrl = await evaluate(client, "location.href").catch(() => lastUrl);
    if (isConcreteChatUrl(lastUrl)) return lastUrl;
    await sleep(1000);
  }
  return lastUrl;
}

async function evaluate(client, expression, awaitPromise = true) {
  const result = await client.send("Runtime.evaluate", {
    expression,
    awaitPromise,
    returnByValue: true,
    userGesture: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || "Runtime.evaluate failed.");
  }
  return result.result?.value;
}

async function attachFiles(client, files) {
  if (!files.length) return [];
  await client.send("DOM.enable");
  await waitForDoubaoEditorReady(client, 30000);

  let inputResult = { nodeId: 0 };
  for (let attempt = 1; attempt <= 30; attempt += 1) {
    inputResult = await findDoubaoFileInputNode(client);
    if (inputResult.nodeId) break;
    if (attempt === 1 || attempt % 5 === 0) {
      await clickDoubaoAttachmentButton(client).catch(() => {});
    }
    await sleep(1000);
  }
  if (!inputResult.nodeId) throw new Error("No Doubao file input found.");

  await client.send("DOM.setFileInputFiles", {
    nodeId: inputResult.nodeId,
    files,
  });

  const names = files.map(file => path.basename(file));
  const started = Date.now();
  while (Date.now() - started < 15000) {
    const state = await evaluate(client, `(() => {
      const names = ${JSON.stringify(names)};
      const body = document.body.innerText || "";
      const selected = Array.from(document.querySelector("input[type=file]")?.files || []).map(file => file.name);
      return {
        selected,
        seen: names.filter(name => body.includes(name)),
        uploading: /uploading|processing/i.test(body),
        bodyTail: body.slice(-1200)
      };
    })()`);
    if (state?.seen?.length === names.length && !state.uploading) {
      console.log(`[doubao-img] attached ${names.join(", ")}`);
      return names;
    }
    if (state?.selected?.length === names.length && names.every(name => state.selected.includes(name))) {
      await sleep(3000);
      console.log(`[doubao-img] attached ${names.join(", ")}`);
      return names;
    }
    await sleep(1000);
  }

  console.log(`[doubao-img] attached ${names.join(", ")} (file input set; page upload status not confirmed)`);
  return names;
}

async function waitForDoubaoEditorReady(client, timeoutMs = 30000) {
  const started = Date.now();
  let lastState = null;
  while (Date.now() - started < timeoutMs) {
    lastState = await evaluate(client, `(() => {
      const hasBody = Boolean(document.body);
      const bodyTextLength = document.body?.innerText?.length || 0;
      const fileInputs = Array.from(document.querySelectorAll("input[type=file]"));
      const editors = Array.from(document.querySelectorAll("textarea, [contenteditable='true'], [role='textbox']"));
      const visibleEditors = editors.filter(el => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      });
      return {
        href: location.href,
        readyState: document.readyState,
        hasBody,
        bodyTextLength,
        fileInputCount: fileInputs.length,
        visibleEditorCount: visibleEditors.length,
      };
    })()`).catch(error => ({ error: error.message }));
    if (lastState?.fileInputCount > 0 || (lastState?.readyState === "complete" && lastState?.visibleEditorCount > 0)) {
      return lastState;
    }
    await sleep(1000);
  }
  console.log(`[doubao-img] page not fully ready before upload: ${JSON.stringify(lastState)}`);
  return lastState;
}

async function findDoubaoFileInputNode(client) {
  const result = await client.send("Runtime.evaluate", {
    expression: `document.querySelector("input[type=file]")`,
    returnByValue: false,
  });
  const objectId = result.result?.objectId;
  if (objectId) {
    try {
      const node = await client.send("DOM.requestNode", { objectId });
      if (node.nodeId) return { nodeId: node.nodeId };
    } catch {}
  }

  const documentResult = await client.send("DOM.getDocument", { depth: -1, pierce: true });
  const rootNodeId = documentResult.root?.nodeId;
  if (!rootNodeId) return { nodeId: 0 };
  return client.send("DOM.querySelector", {
    nodeId: rootNodeId,
    selector: "input[type=file]",
  });
}

async function clickDoubaoAttachmentButton(client) {
  const button = await evaluate(client, `(() => {
    const visible = el => {
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    const words = /upload|attach|file|image|photo|上传|附件|文件|图片|照片|添加/i;
    const candidates = Array.from(document.querySelectorAll("button, [role='button'], label, [aria-label], [title]"))
      .filter(visible)
      .map(el => ({
        el,
        text: [el.innerText, el.textContent, el.getAttribute("aria-label"), el.title, el.className, el.id].join(" "),
        rect: el.getBoundingClientRect(),
      }))
      .filter(item => words.test(item.text) || (item.rect.y > window.innerHeight * 0.55 && item.rect.width <= 80 && item.rect.height <= 80))
      .sort((a, b) => (b.rect.y - a.rect.y) || (a.rect.x - b.rect.x));
    const item = candidates[0];
    if (!item) return null;
    return { x: item.rect.x + item.rect.width / 2, y: item.rect.y + item.rect.height / 2, text: item.text.slice(0, 120) };
  })()`);
  if (!button) throw new Error("No visible Doubao attachment button found.");
  await client.send("Input.dispatchMouseEvent", { type: "mousePressed", x: button.x, y: button.y, button: "left", clickCount: 1 });
  await client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: button.x, y: button.y, button: "left", clickCount: 1 });
  return button;
}

function isLikelyImageUrl(url) {
  if (!url || typeof url !== "string") return false;
  if (!/^https?:\/\//i.test(url)) return false;
  const parsed = new URL(url);
  if (/\/passport\//i.test(parsed.pathname)) return false;
  if (/\/api\//i.test(parsed.pathname) || /\/web\//i.test(parsed.pathname)) return false;
  if (/\/(icon|avatar|logo|emoji|sticker)\//i.test(parsed.pathname)) return false;
  if (/\/rc\/icon\//i.test(parsed.pathname)) return false;
  // 直接以图片扩展名结尾
  if (/\.(png|jpe?g|webp|gif)(\?|$)/i.test(url)) return true;
  // 常见图片 CDN / 对象存储域名
  const imageHost = /byteimg|bytedance|volc|volces|tos|doubao|oss|cdn|s3|cos|qiniucs|aliyuncs/i.test(parsed.hostname);
  // 路径或查询串里出现图片相关标记
  const imagePath = /image|img|tplv|tos-|obj\/|web\.image|photo|pic|upload\/|media\//i.test(parsed.pathname);
  const imageQuery = /x-expires|format|tplv|image|sign|x-oss-process|imageView/i.test(parsed.search);
  return imageHost && (imagePath || imageQuery || /\.(png|jpe?g|webp|gif)(\?|$)/i.test(parsed.search));
}

function collectImageUrls(value, found = new Set()) {
  if (!value) return found;
  if (typeof value === "string") {
    if (isLikelyImageUrl(value)) found.add(value);
    return found;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectImageUrls(item, found);
    return found;
  }
  if (typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (/url|uri|src|image|origin|raw|large/i.test(key)) collectImageUrls(item, found);
      else if (typeof item === "object") collectImageUrls(item, found);
    }
  }
  return found;
}

function extractCreationsFromJson(value, records = []) {
  const pickImageUrl = image => {
    if (!image || typeof image !== "object") return "";
    // 尝试多种可能的图片 URL 字段，按清晰度从高到低
    const candidates = [
      image?.image_ori_raw?.url,
      image?.image_ori?.url,
      image?.origin?.url,
      image?.raw?.url,
      image?.large?.url,
      image?.url,
      image?.image_preview?.url,
      image?.preview?.url,
      image?.image_thumb?.url,
      image?.thumb?.url,
      image?.cover?.url,
    ];
    for (const url of candidates) {
      if (isLikelyImageUrl(url)) return url;
    }
    return "";
  };
  const visit = (node, context = {}) => {
    if (!node || typeof node !== "object") return;
    const next = {
      conversation_id: node.conversation_id || context.conversation_id || "",
      message_id: node.message_id || context.message_id || "",
      bot_reply_message_id: node.bot_reply_message_id || context.bot_reply_message_id || "",
      index_in_conv: node.index_in_conv ?? context.index_in_conv ?? "",
      create_time: node.create_time ? Number(node.create_time) * 1000 : context.create_time || "",
      tts_content: node.tts_content || context.tts_content || "",
    };
    if (Array.isArray(node.creations)) {
      for (const creation of node.creations.flat(Infinity)) {
        const image = creation?.image || creation?.video?.cover;
        const url = pickImageUrl(image);
        if (url) {
          records.push({
            ...next,
            type: creation?.video ? "video-cover" : "image",
            key: image?.key || "",
            prompt: image?.gen_params?.prompt || creation?.video?.gen_params?.prompt || "",
            url,
          });
        }
      }
    }
    for (const child of (Array.isArray(node) ? node : Object.values(node))) visit(child, next);
  };
  visit(value);
  return records;
}

async function installCreationHook(client) {
  await evaluate(client, `(() => {
    if (window.__doubaoImgHookInstalled) return true;
    window.__doubaoImgHookInstalled = true;
    window.__doubaoImgCreations = [];
    const originalParse = JSON.parse;
    const okUrl = url => {
      try {
        const parsed = new URL(url || "");
        if (!/^https?:$/i.test(parsed.protocol)) return false;
        if (/\\/passport\\//i.test(parsed.pathname) || /\\/api\\//i.test(parsed.pathname) || /\\/web\\//i.test(parsed.pathname)) return false;
        if (/\\/(icon|avatar|logo|emoji|sticker)\\//i.test(parsed.pathname)) return false;
        if (/\\/rc\\/icon\\//i.test(parsed.pathname)) return false;
        if (/\\.(png|jpe?g|webp|gif)(\\?|$)/i.test(url)) return true;
        const imageHost = /byteimg|bytedance|volc|volces|tos|doubao|oss|cdn|s3|cos|qiniucs|aliyuncs/i.test(parsed.hostname);
        const imagePath = /image|img|tplv|tos-|obj\\/|web\\.image|photo|pic|upload\\/|media\\//i.test(parsed.pathname);
        const imageQuery = /x-expires|format|tplv|image|sign|x-oss-process|imageView/i.test(parsed.search);
        return imageHost && (imagePath || imageQuery || /\\.(png|jpe?g|webp|gif)(\\?|$)/i.test(parsed.search));
      } catch { return false; }
    };
    const pickImageUrl = image => {
      if (!image || typeof image !== "object") return "";
      const candidates = [
        image?.image_ori_raw?.url,
        image?.image_ori?.url,
        image?.origin?.url,
        image?.raw?.url,
        image?.large?.url,
        image?.url,
        image?.image_preview?.url,
        image?.preview?.url,
        image?.image_thumb?.url,
        image?.thumb?.url,
        image?.cover?.url,
      ];
      for (const url of candidates) if (okUrl(url)) return url;
      return "";
    };
    const push = record => {
      if (!record?.url || !okUrl(record.url)) return;
      if (!window.__doubaoImgCreations.some(item => item.url === record.url)) window.__doubaoImgCreations.push(record);
    };
    const visit = (node, context = {}) => {
      if (!node || typeof node !== "object") return;
      const next = {
        conversation_id: node.conversation_id || context.conversation_id || "",
        message_id: node.message_id || context.message_id || "",
        bot_reply_message_id: node.bot_reply_message_id || context.bot_reply_message_id || "",
        index_in_conv: node.index_in_conv ?? context.index_in_conv ?? "",
        create_time: node.create_time ? Number(node.create_time) * 1000 : context.create_time || "",
        tts_content: node.tts_content || context.tts_content || "",
      };
      if (Array.isArray(node.creations)) {
        for (const creation of node.creations.flat(Infinity)) {
          const image = creation?.image || creation?.video?.cover;
          const url = pickImageUrl(image);
          if (url) push({ ...next, type: creation?.video ? "video-cover" : "image", key: image?.key || "", prompt: image?.gen_params?.prompt || creation?.video?.gen_params?.prompt || "", url });
        }
      }
      for (const child of (Array.isArray(node) ? node : Object.values(node))) visit(child, next);
    };
    JSON.parse = function doubaoImgParse(text, reviver) {
      const data = originalParse.call(this, text, reviver);
      try { if (typeof text === "string" && text.includes("creations")) visit(data); } catch {}
      return data;
    };
    const tryParseAndVisit = text => {
      if (typeof text !== "string" || !text.includes("creations")) return;
      try { visit(originalParse(text)); } catch {}
    };
    // 拦截 fetch，很多接口现在用 fetch().json()，不会走 window.JSON.parse
    const originalFetch = window.fetch;
    window.fetch = async function doubaoImgFetch(...args) {
      const response = await originalFetch.apply(this, args);
      try {
        const clone = response.clone();
        const text = await clone.text();
        tryParseAndVisit(text);
      } catch {}
      return response;
    };
    // 拦截 XMLHttpRequest，兜底部分旧接口或 SSE
    const originalXHR = window.XMLHttpRequest;
    window.XMLHttpRequest = function doubaoImgXHR() {
      const xhr = new originalXHR();
      const originalSend = xhr.send;
      let method = "";
      let url = "";
      xhr.open = function(m, u, ...rest) { method = m; url = String(u || ""); return originalXHR.prototype.open.apply(this, [m, u, ...rest]); };
      xhr.send = function(...sendArgs) {
        const onReady = () => {
          if (xhr.readyState === 4 && xhr.responseText) {
            tryParseAndVisit(xhr.responseText);
          }
        };
        xhr.addEventListener("load", onReady);
        xhr.addEventListener("readystatechange", onReady);
        return originalSend.apply(this, sendArgs);
      };
      return xhr;
    };
    return { installed: true, existingCount: window.__doubaoImgCreations.length };
  })()`);
}

async function clearHookCreations(client) {
  await evaluate(client, `(() => { window.__doubaoImgCreations = []; return true; })()`);
}

async function collectDomImages(client) {
  const urls = await evaluate(client, `(() => {
    const out = [];
    const push = value => { if (value && /^https?:\\/\\//i.test(value)) out.push(value); };
    document.querySelectorAll("img[src], a[href], source[src], [style]").forEach(el => {
      if (el.tagName === "IMG") {
        const rect = el.getBoundingClientRect();
        const w = el.naturalWidth || rect.width || 0;
        const h = el.naturalHeight || rect.height || 0;
        if (w >= 256 && h >= 256) push(el.currentSrc || el.src || el.href);
      } else {
        push(el.currentSrc || el.src || el.href);
      }
      const style = el.getAttribute("style") || "";
      for (const match of style.matchAll(/url\\(["']?([^"')]+)["']?\\)/g)) push(match[1]);
    });
    return out;
  })()`);
  return new Set((urls || []).filter(isLikelyImageUrl));
}

async function collectHookCreations(client) {
  const records = await evaluate(client, `window.__doubaoImgCreations || []`);
  return Array.isArray(records) ? records.filter(item => isLikelyImageUrl(item.url)) : [];
}

async function ensureImageGenerationMode(client) {
  await waitForDoubaoEditorReady(client, 30000);

  // 先聚焦输入框，触发 Doubao 显示输入工具栏（含图像生成模式按钮）
  const inputInfo = await evaluate(client, `(() => {
    const visible = el => {
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    const selectors = ["#input-engine-container textarea", "textarea:not([aria-hidden='true']):not([tabindex='-1'])", "[contenteditable='true']", "[role='textbox']", "div[contenteditable='true']", "textarea"];
    for (const selector of selectors) {
      const items = Array.from(document.querySelectorAll(selector)).filter(visible);
      if (items.length) {
        const el = items[items.length - 1];
        el.focus();
        const rect = el.getBoundingClientRect();
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      }
    }
    return null;
  })()`).catch(() => null);
  if (inputInfo) {
    await client.send("Input.dispatchMouseEvent", { type: "mousePressed", x: inputInfo.x, y: inputInfo.y, button: "left", clickCount: 1 });
    await client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: inputInfo.x, y: inputInfo.y, button: "left", clickCount: 1 });
    await sleep(500);
  }

  const findModeButton = () => evaluate(client, `(() => {
    const visible = el => {
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    const labelOf = el => [
      el.innerText,
      el.textContent,
      el.getAttribute("aria-label"),
      el.title,
      el.id,
      el.className,
    ].join(" ");
    const candidates = Array.from(document.querySelectorAll("button, [role='button'], label, [aria-label], [title]"))
      .filter(visible)
      .map(el => ({ el, text: labelOf(el), rect: el.getBoundingClientRect() }))
      .filter(item => /(?:\u56fe\u50cf|\u56fe\u7247)\s*\u751f\u6210|image\s*generation|generate\s*image|image\s*gen/i.test(item.text))
      .filter(item => !/\u89c6\u9891\s*\u751f\u6210|video\s*generation|generate\s*video|video\s*gen/i.test(item.text))
      .filter(item => item.rect.y > window.innerHeight * 0.45)
      .sort((a, b) => (b.rect.y - a.rect.y) || (a.rect.x - b.rect.x));
    const item = candidates[0];
    if (!item) {
      const snapshot = Array.from(document.querySelectorAll("button, [role='button'], label, [aria-label], [title]"))
        .filter(visible)
        .map(el => {
          const rect = el.getBoundingClientRect();
          return {
            tag: el.tagName,
            id: el.id || "",
            text: labelOf(el).trim().slice(0, 80),
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            w: Math.round(rect.width),
            h: Math.round(rect.height),
          };
        })
        .filter(item => item.y > window.innerHeight * 0.45)
        .slice(-16);
      return { ok: false, error: "No visible Doubao image generation mode button found.", snapshot };
    }
    const selected = item.el.getAttribute("aria-pressed") === "true"
      || item.el.getAttribute("aria-selected") === "true"
      || /active|selected|checked/i.test(String(item.el.className));
    return {
      ok: true,
      selected,
      text: item.text.trim().slice(0, 120),
      x: item.rect.x + item.rect.width / 2,
      y: item.rect.y + item.rect.height / 2,
    };
  })()`);

  // 先滚动到底部，确保模式选择器在可视区域
  await evaluate(client, `window.scrollTo(0, document.body.scrollHeight)`).catch(() => {});
  await sleep(300);

  let modeButton = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    modeButton = await findModeButton();
    if (modeButton?.ok) break;
    console.log(`[doubao-img] image generation mode button not found attempt=${attempt}/3; retrying after scroll`);
    await evaluate(client, `window.scrollTo(0, document.body.scrollHeight)`).catch(() => {});
    await sleep(800);
  }

  if (!modeButton?.ok) {
    // 如果之前已经成功进入图像生成模式，且当前仍有可用输入框，
    // 大概率仍处在图像生成模式（按钮只是被滚动或 UI 状态遮挡）。
    if (client.imageModeSelected) {
      const hasEditor = await evaluate(client, `(() => {
        const visible = el => {
          if (!el) return false;
          const rect = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
        };
        return Array.from(document.querySelectorAll("textarea, [contenteditable='true'], [role='textbox']")).some(visible);
      })()`);
      if (hasEditor) {
        console.log("[doubao-img] image generation mode button not visible; assuming still in image mode from previous turn");
        return { ok: true, selected: true, text: "(assumed)", x: 0, y: 0 };
      }
    }
    console.log(`[doubao-img] image generation mode button not found snapshot=${JSON.stringify(modeButton?.snapshot || [])}`);
    throw new DoubaoImgError("IMAGE_GENERATION_MODE_NOT_FOUND", modeButton?.error || "No visible Doubao image generation mode button found.");
  }

  if (!modeButton.selected) {
    await client.send("Input.dispatchMouseEvent", { type: "mousePressed", x: modeButton.x, y: modeButton.y, button: "left", clickCount: 1 });
    await client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: modeButton.x, y: modeButton.y, button: "left", clickCount: 1 });
    await sleep(800);
  }
  client.imageModeSelected = true;
  console.log(`[doubao-img] image generation mode ${modeButton.selected ? "confirmed" : "selected"}: "${previewText(modeButton.text, 40)}"`);
  return modeButton;
}

async function readVisibleEditorText(client) {
  return evaluate(client, `(() => {
    const visible = el => {
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    const selectors = [
      "#input-engine-container textarea",
      "textarea:not([aria-hidden='true']):not([tabindex='-1'])",
      "[contenteditable='true']",
      "[role='textbox']",
      "div[contenteditable='true']",
      "textarea"
    ];
    for (const selector of selectors) {
      const items = Array.from(document.querySelectorAll(selector)).filter(visible);
      if (!items.length) continue;
      const el = items[items.length - 1];
      return "value" in el ? (el.value || "") : (el.innerText || el.textContent || "");
    }
    return "";
  })()`).catch(() => "");
}

function previewText(value, max = 80) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

async function submitPrompt(client, promptText) {
  console.log(`[doubao-img] submit begin len=${promptText.length} preview="${previewText(promptText)}"`);
  const inputInfo = await evaluate(client, `(() => {
    const visible = el => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    const pickLastVisible = selectors => {
      for (const selector of selectors) {
        const items = Array.from(document.querySelectorAll(selector)).filter(visible);
        if (items.length) return { el: items[items.length - 1], selector };
      }
      return null;
    };
    const input = pickLastVisible([
      "#input-engine-container textarea",
      "textarea:not([aria-hidden='true']):not([tabindex='-1'])",
      "[contenteditable='true']",
      "[role='textbox']",
      "div[contenteditable='true']",
      "textarea"
    ]);
    if (!input) return { ok: false, error: "No visible Doubao input box found." };
    input.el.focus();
    if (input.el.tagName === "TEXTAREA" || input.el.tagName === "INPUT") {
      const descriptor = Object.getOwnPropertyDescriptor(input.el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, "value");
      descriptor?.set?.call(input.el, "");
    } else {
      input.el.textContent = "";
    }
    input.el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward", data: null }));
    const rect = input.el.getBoundingClientRect();
    return {
      ok: true,
      selector: input.selector,
      tag: input.el.tagName,
      contenteditable: input.el.getAttribute("contenteditable") || "",
      x: rect.x + rect.width / 2,
      y: rect.y + rect.height / 2,
    };
  })()`);

  if (!inputInfo?.ok) throw new Error(inputInfo?.error || "No visible Doubao input box found.");
  console.log(`[doubao-img] input target selector=${inputInfo.selector} tag=${inputInfo.tag} contenteditable=${inputInfo.contenteditable || "no"} x=${Math.round(inputInfo.x)} y=${Math.round(inputInfo.y)}`);
  await evaluate(client, `window.scrollTo(0, document.body.scrollHeight)`).catch(() => {});
  await client.send("Input.dispatchMouseEvent", { type: "mousePressed", x: inputInfo.x, y: inputInfo.y, button: "left", clickCount: 1 });
  await client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: inputInfo.x, y: inputInfo.y, button: "left", clickCount: 1 });
  await client.send("Input.insertText", { text: promptText });
  await sleep(500);
  const afterInsert = await readVisibleEditorText(client);
  console.log(`[doubao-img] input after insert len=${afterInsert.length} containsPrompt=${afterInsert.includes(promptText)}`);

  const findButton = async () => evaluate(client, `(() => {
    const visible = el => {
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    const describeButton = button => {
      const rect = button.getBoundingClientRect();
      return {
        ok: true,
        id: button.id || "",
        text: (button.innerText || button.textContent || button.getAttribute("aria-label") || "").trim(),
        disabled: button.disabled || button.getAttribute("aria-disabled"),
        className: String(button.className || "").slice(0, 120),
        x: rect.x + rect.width / 2,
        y: rect.y + rect.height / 2,
      };
    };

    // 1. 经典发送按钮 ID
    let button = document.querySelector("#flow-end-msg-send");
    if (visible(button)) return describeButton(button);

    // 2. 文本/类名匹配
    let candidates = Array.from(document.querySelectorAll("button, [role='button']"))
      .filter(visible)
      .map(el => ({ el, text: (el.innerText || el.textContent || el.getAttribute("aria-label") || el.title || "").trim(), className: String(el.className), rect: el.getBoundingClientRect() }))
      .filter(item => /send|submit|generate|发送|提交|生成/i.test(item.text) || /send-msg|send|generate/i.test(item.el.id + " " + item.className))
      .sort((a, b) => (b.rect.y - a.rect.y) || (b.rect.x - a.rect.x));
    button = candidates[0]?.el;
    if (visible(button)) return describeButton(button);

    // 3. fallback: 输入框容器内最右侧的可见按钮（发送按钮通常在右下角）
    const inputContainer = document.querySelector("#input-engine-container") || document.querySelector("[contenteditable='true']")?.closest("div");
    if (inputContainer) {
      const containerButtons = Array.from(inputContainer.querySelectorAll("button, [role='button']"))
        .filter(visible)
        .filter(el => {
          const text = (el.innerText || el.textContent || el.getAttribute("aria-label") || el.title || "").trim();
          return !/篇幅|智能推荐|设置|表情|更多/i.test(text);
        })
        .map(el => ({ el, rect: el.getBoundingClientRect() }))
        .filter(item => item.rect.x > window.innerWidth * 0.55)
        .sort((a, b) => (b.rect.x - a.rect.x) || (b.rect.y - a.rect.y));
      if (containerButtons.length) return describeButton(containerButtons[0].el);
    }

    // 4. fallback: 页面右下角附近的按钮
    const cornerCandidates = Array.from(document.querySelectorAll("button, [role='button']"))
      .filter(visible)
      .filter(el => {
        const text = (el.innerText || el.textContent || el.getAttribute("aria-label") || el.title || "").trim();
        return !/篇幅|智能推荐|设置|表情|更多/i.test(text);
      })
      .map(el => ({ el, rect: el.getBoundingClientRect() }))
      .filter(item => item.rect.y > window.innerHeight * 0.72 && item.rect.x > window.innerWidth * 0.6)
      .sort((a, b) => (b.rect.y - a.rect.y) || (b.rect.x - a.rect.x));
    button = cornerCandidates[0]?.el;
    if (visible(button)) return describeButton(button);

    const snapshot = Array.from(document.querySelectorAll("button, [role='button']"))
      .filter(visible)
      .map(el => {
        const rect = el.getBoundingClientRect();
        return {
          id: el.id || "",
          text: (el.innerText || el.textContent || el.getAttribute("aria-label") || el.title || "").trim().slice(0, 60),
          className: String(el.className || "").slice(0, 80),
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          w: Math.round(rect.width),
          h: Math.round(rect.height),
        };
      })
      .filter(item => item.y > window.innerHeight * 0.55)
      .slice(-12);
    return { ok: false, error: "No visible send button found after typing.", snapshot };
  })()`);

  const clickSendButtonInPage = async () => evaluate(client, `(() => {
    const visible = el => {
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };

    let button = document.querySelector("#flow-end-msg-send");
    if (visible(button)) {
      button.click();
      return { ok: true, id: button.id || "", text: (button.innerText || button.textContent || button.getAttribute("aria-label") || "").trim() };
    }

    let candidates = Array.from(document.querySelectorAll("button, [role='button']"))
      .filter(visible)
      .map(el => ({ el, text: (el.innerText || el.textContent || el.getAttribute("aria-label") || el.title || "").trim(), className: String(el.className), rect: el.getBoundingClientRect() }))
      .filter(item => /send|submit|generate|发送|提交|生成/i.test(item.text) || /send-msg|send/i.test(item.el.id + " " + item.className))
      .sort((a, b) => (b.rect.y - a.rect.y) || (b.rect.x - a.rect.x));
    button = candidates[0]?.el;
    if (visible(button)) {
      button.click();
      return { ok: true, id: button.id || "", text: (button.innerText || button.textContent || button.getAttribute("aria-label") || "").trim() };
    }

    const inputContainer = document.querySelector("#input-engine-container") || document.querySelector("[contenteditable='true']")?.closest("div");
    if (inputContainer) {
      const containerButtons = Array.from(inputContainer.querySelectorAll("button, [role='button']"))
        .filter(visible)
        .filter(el => {
          const text = (el.innerText || el.textContent || el.getAttribute("aria-label") || el.title || "").trim();
          return !/篇幅|智能推荐|设置|表情|更多/i.test(text);
        })
        .map(el => ({ el, rect: el.getBoundingClientRect() }))
        .filter(item => item.rect.x > window.innerWidth * 0.55)
        .sort((a, b) => (b.rect.x - a.rect.x) || (b.rect.y - a.rect.y));
      if (containerButtons.length) {
        button = containerButtons[0].el;
        button.click();
        return { ok: true, id: button.id || "", text: (button.innerText || button.textContent || button.getAttribute("aria-label") || "").trim() };
      }
    }

    const cornerCandidates = Array.from(document.querySelectorAll("button, [role='button']"))
      .filter(visible)
      .filter(el => {
        const text = (el.innerText || el.textContent || el.getAttribute("aria-label") || el.title || "").trim();
        return !/篇幅|智能推荐|设置|表情|更多/i.test(text);
      })
      .map(el => ({ el, rect: el.getBoundingClientRect() }))
      .filter(item => item.rect.y > window.innerHeight * 0.72 && item.rect.x > window.innerWidth * 0.6)
      .sort((a, b) => (b.rect.y - a.rect.y) || (b.rect.x - a.rect.x));
    button = cornerCandidates[0]?.el;
    if (visible(button)) {
      button.click();
      return { ok: true, id: button.id || "", text: (button.innerText || button.textContent || button.getAttribute("aria-label") || "").trim() };
    }

    return { ok: false, error: "No visible send button for page click." };
  })()`).catch(error => ({ ok: false, error: error.message }));

  let buttonInfo = null;
  const sendByEnter = async () => {
    await client.send("Input.dispatchKeyEvent", { type: "keyDown", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, key: "Enter", code: "Enter" }).catch(() => {});
    await client.send("Input.dispatchKeyEvent", { type: "keyUp", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, key: "Enter", code: "Enter" }).catch(() => {});
    await sleep(1200);
    const stillThere = await readVisibleEditorText(client);
    console.log(`[doubao-img] input after enter fallback len=${stillThere.length} containsPrompt=${stillThere.includes(promptText)}`);
    return !stillThere.includes(promptText);
  };

  for (let attempt = 1; attempt <= 8; attempt += 1) {
    buttonInfo = await findButton();
    if (!buttonInfo?.ok) {
      console.log(`[doubao-img] send button not ready attempt=${attempt}/8 error="${buttonInfo?.error || "unknown"}" snapshot=${JSON.stringify(buttonInfo?.snapshot || [])}`);
      if (attempt === 4) {
        if (await sendByEnter()) return { selector: inputInfo.selector, method: "enter-key", buttonId: "", buttonText: "", attempts: attempt };
      }
      if (attempt === 8) {
        const error = new Error(buttonInfo?.error || "No visible send button found.");
        error.code = "SEND_BUTTON_NOT_FOUND";
        throw error;
      }
      const waitMs = Math.min(6000, 800 * attempt);
      await evaluate(client, `window.scrollTo(0, document.body.scrollHeight)`).catch(() => {});
      await client.send("Input.dispatchMouseEvent", { type: "mousePressed", x: inputInfo.x, y: inputInfo.y, button: "left", clickCount: 1 });
      await client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: inputInfo.x, y: inputInfo.y, button: "left", clickCount: 1 });
      await sleep(waitMs);
      continue;
    }
    console.log(`[doubao-img] send button attempt=${attempt}/8 id=${buttonInfo.id || "-"} text="${previewText(buttonInfo.text, 40)}" disabled=${buttonInfo.disabled || "false"} x=${Math.round(buttonInfo.x)} y=${Math.round(buttonInfo.y)}`);
    if (buttonInfo.disabled === true || buttonInfo.disabled === "true") {
      await sleep(1000);
      continue;
    }

    await client.send("Input.dispatchMouseEvent", { type: "mousePressed", x: buttonInfo.x, y: buttonInfo.y, button: "left", clickCount: 1 });
    await client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: buttonInfo.x, y: buttonInfo.y, button: "left", clickCount: 1 });
    const pageClick = await clickSendButtonInPage();
    console.log(`[doubao-img] page click ok=${Boolean(pageClick?.ok)} id=${pageClick?.id || "-"} error="${pageClick?.error || ""}"`);
    await sleep(1200);

    const stillThere = await readVisibleEditorText(client);
    console.log(`[doubao-img] input after submit attempt=${attempt} len=${stillThere.length} containsPrompt=${stillThere.includes(promptText)}`);
    if (!stillThere.includes(promptText)) {
      return { selector: inputInfo.selector, method: "cdp-mouse", buttonId: buttonInfo.id, buttonText: buttonInfo.text, attempts: attempt };
    }
    console.log(`[doubao-img] submit click did not clear input; retry ${attempt}/8`);
  }

  const stillThere = await readVisibleEditorText(client);
  if (stillThere.includes(promptText)) {
    throw new Error("Prompt text is still in the input after clicking send; Doubao did not accept the submit click.");
  }
  return { selector: inputInfo.selector, method: "cdp-mouse", buttonId: buttonInfo.id, buttonText: buttonInfo.text };
}

async function waitForImages(client, before, captured, options) {
  const started = Date.now();
  let lastChange = Date.now();
  let lastSize = 0;
  while (Date.now() - started < options.timeout) {
    for (const url of await collectDomImages(client)) captured.add(url);
    for (const record of await collectHookCreations(client)) captured.add(record.url);
    const fresh = [...captured].filter(url => !before.has(url));
    if (fresh.length !== lastSize) {
      lastSize = fresh.length;
      lastChange = Date.now();
      console.log(`[doubao-img] captured ${fresh.length} new image URL(s)`);
    }
    if (fresh.length >= options.count && Date.now() - lastChange >= options.stable) return fresh;
    await sleep(1000);
  }
  const fresh = [...captured].filter(url => !before.has(url));
  if (fresh.length) return fresh;
  throw new Error(`Timed out after ${options.timeout}ms without new image URLs.`);
}

function isRawCreationUrl(url) {
  return /image_raw|image_ori_raw|raw/i.test(url || "") && !/watermark/i.test(url || "");
}

function promptFingerprint(prompt) {
  const text = String(prompt || "").replace(/\s+/g, " ").trim();
  // Doubao 返回的 creation prompt 通常只保留 【场景标签】 后的正文描述，
  // 而不会把短标签（如【机构场景】）写回。因此用标签后的正文做匹配更可靠。
  const lastLabelMatch = text.match(/.*\u3010([^\u3011]+)\u3011\s*(.*)$/);
  const scene = lastLabelMatch ? lastLabelMatch[2].trim() : text.slice(Math.max(0, text.length - 700));
  const compact = scene.replace(/[^\u4e00-\u9fffA-Za-z0-9]/g, "");
  const grams = new Set();
  for (let size = 3; size <= 6; size += 1) {
    for (let index = 0; index <= compact.length - size; index += 1) grams.add(compact.slice(index, index + size));
  }
  return { scene: previewText(scene, 80), grams, minScore: Math.min(4, compact.length) };
}

function promptMatchScore(generatedPrompt, expectedFingerprint) {
  const compact = String(generatedPrompt || "").replace(/[^\u4e00-\u9fffA-Za-z0-9]/g, "");
  if (!compact || !expectedFingerprint?.grams?.size) return 0;
  let matched = 0;
  for (const gram of expectedFingerprint.grams) {
    if (compact.includes(gram)) matched = Math.max(matched, gram.length);
  }
  return matched;
}

async function waitForDownloadItems(client, beforeDom, beforeCreations, captured, options) {
  const started = Date.now();
  let deadline = started + options.timeout;
  let extensions = 0;
  let lastChange = Date.now();
  let lastRawSize = 0;
  let lastFallbackSize = 0;
  let lastRejectedSize = 0;
  const expectedFingerprint = promptFingerprint(options.expectedPrompt);
  const ignoredUrls = options.ignoredUrls || new Set();

  while (Date.now() < deadline) {
    for (const url of await collectDomImages(client)) captured.add(url);
    const records = await collectHookCreations(client);
    for (const record of records) captured.add(record.url);

    const allFreshRawRecords = records
      .filter(record => !beforeCreations.has(record.url))
      .filter(record => !ignoredUrls.has(record.url))
      .filter(record => isRawCreationUrl(record.url));
    const freshRawRecords = allFreshRawRecords.filter(record => !record.prompt || promptMatchScore(record.prompt, expectedFingerprint) >= expectedFingerprint.minScore);
    const rejectedRawRecords = allFreshRawRecords.filter(record => record.prompt && !freshRawRecords.includes(record));
    const freshFallback = [...captured].filter(url => !beforeDom.has(url) && !ignoredUrls.has(url));

    if (freshRawRecords.length !== lastRawSize || freshFallback.length !== lastFallbackSize || rejectedRawRecords.length !== lastRejectedSize) {
      lastRawSize = freshRawRecords.length;
      lastFallbackSize = freshFallback.length;
      lastRejectedSize = rejectedRawRecords.length;
      lastChange = Date.now();
      console.log(`[doubao-img] captured raw=${freshRawRecords.length}, rejected=${rejectedRawRecords.length}, fallback=${freshFallback.length}, scene="${expectedFingerprint.scene}"`);
      await logDebug("CAPTURE_STATE", {
        lineNumber: options.lineNumber,
        elapsed: Date.now() - started,
        raw: freshRawRecords.length,
        rejected: rejectedRawRecords.length,
        fallback: freshFallback.length,
        scene: expectedFingerprint.scene,
        matched: freshRawRecords.map(r => ({ url: r.url, prompt: previewText(r.prompt, 80) })),
        rejectedDetails: rejectedRawRecords.map(r => ({ url: r.url, score: promptMatchScore(r.prompt, expectedFingerprint), minScore: expectedFingerprint.minScore, prompt: previewText(r.prompt, 80) })),
        fallbackCandidates: freshFallback.slice(0, 12),
      });
    }

    if (freshRawRecords.length >= options.count && Date.now() - lastChange >= options.stable) {
      return freshRawRecords.slice(0, options.count);
    }
    if (!allFreshRawRecords.length && freshFallback.length >= options.count && Date.now() - started >= options.fallbackAfter && Date.now() - lastChange >= options.stable) {
      return freshFallback.slice(0, options.count).map(url => ({ url }));
    }
    await sleep(1000);

    if (Date.now() >= deadline) {
      const pageState = await getDoubaoGenerationState(client).catch(() => ({}));
      const hasAnyCandidate = freshRawRecords.length > 0 || freshFallback.length > 0;
      await logDebug("DEADLINE_CHECK", { lineNumber: options.lineNumber, elapsed: Date.now() - started, pageState, hasAnyCandidate, extensions });
      if ((pageState.busy || hasAnyCandidate) && extensions < Math.max(1, options.maxRetries || 0)) {
        extensions += 1;
        deadline += options.timeout;
        console.log(`[doubao-img] generation still pending in current session; extending wait ${extensions}/${Math.max(1, options.maxRetries || 0)}`);
      }
    }
  }

  for (const url of await collectDomImages(client)) captured.add(url);
  const records = await collectHookCreations(client);
  for (const record of records) captured.add(record.url);
  const freshRawRecords = records
    .filter(record => !beforeCreations.has(record.url))
    .filter(record => !ignoredUrls.has(record.url))
    .filter(record => isRawCreationUrl(record.url));
  const matchingRawRecords = freshRawRecords.filter(record => !record.prompt || promptMatchScore(record.prompt, expectedFingerprint) >= expectedFingerprint.minScore);
  if (matchingRawRecords.length) return matchingRawRecords.slice(0, options.count);

  const fallback = [...captured].filter(url => !beforeDom.has(url) && !ignoredUrls.has(url)).map(url => ({ url }));
  await logDebug("FINAL_FALLBACK", { lineNumber: options.lineNumber, matchingRaw: matchingRawRecords.length, fallback: fallback.length, freshRaw: freshRawRecords.length });
  if (!freshRawRecords.length && fallback.length) return fallback.slice(0, options.count);
  if (freshRawRecords.length) {
    throw new DoubaoImgError("IMAGE_GENERATION_MISMATCH", "Received image creations for a different prompt; refusing to download a stale image.", {
      expectedScene: expectedFingerprint.scene,
      receivedPrompts: freshRawRecords.map(record => previewText(record.prompt)),
    });
  }
  throw new DoubaoImgError("IMAGE_GENERATION_TIMEOUT", `Timed out after ${options.timeout}ms without new image URLs.`);
}

async function getDoubaoGenerationState(client) {
  return evaluate(client, `(() => {
    const body = document.body?.innerText || "";
    const visible = el => {
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    const sendButton = document.querySelector("#flow-end-msg-send");
    const stopButton = Array.from(document.querySelectorAll("button, [role='button']"))
      .filter(visible)
      .some(el => /停止|取消|stop|cancel/i.test([el.innerText, el.textContent, el.getAttribute("aria-label"), el.title, el.id, el.className].join(" ")));
    const busyText = /正在|生成中|排队|创作中|请稍候|loading|generating|processing|queued/i.test(body);
    const spinners = Array.from(document.querySelectorAll("[class*='spin'], [class*='loading'], [aria-busy='true'], [data-loading='true']")).filter(visible).length;
    const visibleLargeImages = Array.from(document.querySelectorAll("img")).filter(img => {
      const rect = img.getBoundingClientRect();
      return visible(img) && (img.naturalWidth || rect.width) >= 256 && (img.naturalHeight || rect.height) >= 256;
    }).length;
    return {
      busy: Boolean(stopButton || busyText || spinners > 0 || sendButton?.disabled || sendButton?.getAttribute("aria-disabled") === "true"),
      stopButton,
      busyText,
      spinners,
      visibleLargeImages,
      bodyTail: body.slice(-500),
    };
  })()`);
}

async function inspectSession(client, captureState) {
  const visible = `el => {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
  }`;
  const modeButtons = await evaluate(client, `(() => {
    const visible = ${visible};
    return Array.from(document.querySelectorAll("button, [role='button'], label, [aria-label], [title]"))
      .filter(visible)
      .map(el => ({
        tag: el.tagName,
        id: el.id || "",
        text: [el.innerText, el.textContent, el.getAttribute("aria-label"), el.title].join(" ").trim().slice(0, 80),
        pressed: el.getAttribute("aria-pressed") === "true" || el.getAttribute("aria-selected") === "true",
        x: Math.round(el.getBoundingClientRect().x),
        y: Math.round(el.getBoundingClientRect().y),
      }))
      .filter(item => item.y > window.innerHeight * 0.45)
      .slice(-20);
  })()`).catch(() => []);
  const sendButton = await evaluate(client, `(() => {
    const visible = ${visible};
    const btn = document.querySelector("#flow-end-msg-send");
    if (!visible(btn)) return null;
    const rect = btn.getBoundingClientRect();
    return { id: btn.id, text: (btn.innerText || btn.textContent || "").trim(), disabled: btn.disabled || btn.getAttribute("aria-disabled"), x: Math.round(rect.x), y: Math.round(rect.y) };
  })()`).catch(() => null);
  const editors = await evaluate(client, `(() => {
    const visible = ${visible};
    return Array.from(document.querySelectorAll("textarea, [contenteditable='true'], [role='textbox']"))
      .filter(visible)
      .map(el => ({ tag: el.tagName, selector: el.id ? "#" + el.id : el.className?.slice(0, 60) || "", text: (el.value || el.innerText || "").trim().slice(0, 120) }));
  })()`).catch(() => []);
  const domImages = await collectDomImages(client);
  const hookCreations = await collectHookCreations(client);
  const pageState = await getDoubaoGenerationState(client).catch(() => ({}));
  return {
    url: await evaluate(client, "location.href").catch(() => ""),
    modeButtons,
    sendButton,
    editors,
    domImages: [...domImages],
    networkImages: [...(captureState?.captured || new Set())].filter(url => !domImages.has(url)).slice(0, 50),
    hookCreations,
    pageState,
  };
}

function extensionFromUrl(url, contentType) {
  const ext = path.extname(new URL(url).pathname).replace(".", "").toLowerCase();
  if (["png", "jpg", "jpeg", "webp", "gif"].includes(ext)) return ext;
  if (/png/i.test(contentType || "")) return "png";
  if (/webp/i.test(contentType || "")) return "webp";
  if (/gif/i.test(contentType || "")) return "gif";
  return "jpg";
}

function safeFilePart(value, fallback) {
  return String(value || fallback).replace(/[\\/:*?"<>|\r\n]+/g, "-").replace(/\s+/g, " ").trim().slice(0, 90) || fallback;
}

async function downloadImages(items, outDir, options = {}) {
  await mkdir(outDir, { recursive: true });
  const results = [];
  for (let i = 0; i < items.length; i += 1) {
    const item = typeof items[i] === "string" ? { url: items[i] } : items[i];
    let response;
    let lastError;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        response = await fetch(item.url, {
          headers: {
            "user-agent": "Mozilla/5.0",
            accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
            referer: "https://www.doubao.com/",
          },
        });
        if (response.ok) break;
        lastError = new Error(`Download failed ${response.status}: ${item.url}`);
      } catch (error) {
        lastError = error;
      }
      if (attempt < 3) {
        console.log(`[doubao-img] image download retry ${attempt + 1}/3: ${lastError?.message || "unknown error"}`);
        await sleep(attempt * 1000);
      }
    }
    if (!response?.ok) throw lastError || new Error(`Download failed: ${item.url}`);
    const ext = extensionFromUrl(item.url, response.headers.get("content-type"));
    const bytes = Buffer.from(await response.arrayBuffer());
    const hash = createHash("sha256").update(bytes).digest("hex");
    const shortHash = hash.slice(0, 12);
    if (options.seenHashes?.has(hash)) {
      const first = options.seenHashes.get(hash);
      throw new DoubaoImgError("IMAGE_GENERATION_DUPLICATE_HASH", `Downloaded image content duplicates an earlier image (hash ${shortHash}).`, {
        hash,
        shortHash,
        line: options.lineNumber,
        firstLine: first?.line,
        firstFile: first?.file,
      });
    }
    const stem = options.hashNaming
      ? [safeFilePart(options.lineNumber, "line"), shortHash].join(",")
      : ["doubao", item.conversation_id, item.message_id, item.key, String(i + 1).padStart(2, "0")]
        .filter(Boolean)
        .map(part => safeFilePart(part, "item"))
        .join("-");
    const file = path.resolve(outDir, `${stem}.${ext}`);
    await writeFile(file, bytes);
    options.seenHashes?.set(hash, { line: options.lineNumber, file });
    results.push({ ...item, file, hash, shortHash, line: options.lineNumber });
    console.log(`[doubao-img] saved ${file}`);
  }
  return results;
}

function installNetworkImageCapture(client, state) {
  const requestBodies = new Map();
  client.on("Network.responseReceived", params => {
    const url = params.response?.url;
    const mimeType = params.response?.mimeType || "";
    // 明确图片 mimeType，或 URL 本身一看就是图片，都 capturing
    if ((/^image\//i.test(mimeType) || /\.(png|jpe?g|webp|gif)(\?|$)/i.test(url)) && isLikelyImageUrl(url)) state.captured?.add(url);
    if (/json|text|event-stream|octet-stream|binary/i.test(mimeType)) requestBodies.set(params.requestId, true);
  });
  client.on("Network.loadingFinished", async params => {
    if (!requestBodies.has(params.requestId)) return;
    requestBodies.delete(params.requestId);
    try {
      const body = await client.send("Network.getResponseBody", { requestId: params.requestId });
      const text = body.base64Encoded
        ? Buffer.from(body.body || "", "base64").toString("utf8")
        : body.body || "";
      if (!/image|creations|url|raw|origin/i.test(text)) return;
      const chunks = text.trim().startsWith("{")
        ? [text.trim()]
        : text.split(/\r?\n\r?\n/).flatMap(block => block.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trim()));
      for (const raw of chunks) {
        if (!raw || raw === "[DONE]" || !raw.startsWith("{")) continue;
        try {
          const json = JSON.parse(raw);
          for (const url of collectImageUrls(json)) state.captured?.add(url);
          for (const record of extractCreationsFromJson(json)) state.captured?.add(record.url);
        } catch {}
      }
    } catch {}
  });
}

async function openDoubaoSession(cdp, sessionUrl, forceNew, resume, account) {
  const target = await findOrCreateTarget(cdp, sessionUrl, forceNew);
  if (!target?.webSocketDebuggerUrl) throw new Error("No page CDP target found.");
  const client = new CdpClient(target.webSocketDebuggerUrl);
  await client.connect();
  await client.send("Runtime.enable");
  await client.send("Page.enable");
  await client.send("Network.enable");
  await client.send("Page.bringToFront").catch(() => {});
  await applyAccountCookies(client, account);

  let currentUrl = await evaluate(client, "location.href");
  if (currentUrl !== sessionUrl) {
    await client.send("Page.navigate", { url: sessionUrl });
    await sleep(3000);
    currentUrl = await evaluate(client, "location.href");
  } else if (resume) {
    await client.send("Page.reload", { ignoreCache: false }).catch(() => {});
    await sleep(3000);
    currentUrl = await evaluate(client, "location.href").catch(() => currentUrl);
  }
  await waitForDoubaoEditorReady(client, 30000);
  const hookStatus = await installCreationHook(client);
  console.log(`[doubao-img] creation hook installed, existingCount=${hookStatus?.existingCount ?? 0}`);
  await logDebug("HOOK_INSTALL", { currentUrl, hookStatus });
  return { client, currentUrl };
}

async function submitOnePrompt(client, sessionUrl, currentUrl, promptText, files, args, captureState, downloadOptions = {}) {
  const shouldWaitForRedirect = args.newChat || isChatHomeUrl(sessionUrl);
  await logDebug("SUBMIT_START", { lineNumber: downloadOptions.lineNumber, currentUrl, promptLength: promptText.length, promptPreview: previewText(promptText, 120) });
  await clearHookCreations(client);
  if (!args.noDownload || args.forceImageMode) await ensureImageGenerationMode(client);
  const attached = await attachFiles(client, files);
  const before = await collectDomImages(client);
  const beforeCreationUrls = new Set((await collectHookCreations(client)).map(record => record.url));
  captureState.captured = new Set(before);
  await logDebug("SUBMIT_BEFORE", { lineNumber: downloadOptions.lineNumber, beforeDomCount: before.size, beforeCreationCount: beforeCreationUrls.size, attached });

  const submit = await submitPrompt(client, promptText);
  console.log(`[doubao-img] submitted via ${submit.method} (${submit.selector})`);
  await logDebug("SUBMIT_SENT", { lineNumber: downloadOptions.lineNumber, method: submit.method, selector: submit.selector, buttonText: submit.buttonText });
  const finalUrl = shouldWaitForRedirect
    ? await waitForConcreteChatUrl(client, currentUrl)
    : await evaluate(client, "location.href").catch(() => currentUrl);
  if (shouldWaitForRedirect) console.log(`[doubao-img] finalUrl ${finalUrl}`);

  if (args.noDownload) {
    await logDebug("SUBMIT_NODOWNLOAD", { lineNumber: downloadOptions.lineNumber, finalUrl });
    return { finalUrl, prompt: promptText, attached, submit, downloaded: [] };
  }
  const downloadItems = await waitForDownloadItems(client, before, beforeCreationUrls, captureState.captured, {
    ...args,
    expectedPrompt: promptText,
    ignoredUrls: captureState.ignoredUrls || new Set(),
  });
  await logDebug("SUBMIT_DOWNLOAD_ITEMS", { lineNumber: downloadOptions.lineNumber, count: downloadItems.length, items: downloadItems.map(item => ({ url: item.url, promptPreview: previewText(item.prompt, 80) })) });
  const downloaded = await downloadImages(downloadItems, path.resolve(args.out), downloadOptions);
  await logDebug("SUBMIT_DONE", { lineNumber: downloadOptions.lineNumber, finalUrl, downloadedCount: downloaded.length, files: downloaded.map(d => d.file) });
  return { finalUrl, prompt: promptText, attached, submit, downloaded };
}

async function sendCharacterContext(client, imagePath, characterPrompt, args, captureState) {
  console.log("[doubao-img] refreshing character context");
  await submitOnePrompt(client, DOUBAO_CHAT_HOME, await evaluate(client, "location.href").catch(() => DOUBAO_CHAT_HOME), characterPrompt, [imagePath], {
    ...args,
    noDownload: true,
    newChat: false,
  }, captureState);
  if (args.characterWait > 0) {
    console.log(`[doubao-img] waiting ${args.characterWait}ms for character context`);
    await sleep(args.characterWait);
  }
  const staleUrls = new Set([
    ...await collectDomImages(client),
    ...(await collectHookCreations(client)).map(record => record.url),
  ]);
  captureState.ignoredUrls = new Set([...(captureState.ignoredUrls || []), ...staleUrls]);
  await clearHookCreations(client);
  console.log(`[doubao-img] character context complete; ignored ${staleUrls.size} pre-existing image URL(s)`);
}

function isAccountRestrictedError(error) {
  return ["ACCOUNT_RESTRICTED", "IMAGE_GENERATION_QUOTA_EXHAUSTED"].includes(error?.code);
}

async function main() {
  const args = parseArgs(process.argv);
  await writeFile(DEFAULT_DEBUG_LOG, `[${new Date().toISOString()}] [START] argv=${JSON.stringify(process.argv.slice(2))}\n`).catch(() => {});
  await logDebug("ARGS", { ...args, characterPrompt: args.characterPrompt ? "[redacted]" : undefined });
  if (args.help) return usage();

  const sessionStateFile = path.resolve(args.sessionState || DEFAULT_SESSION_STATE);
  const savedState = await readJsonFile(sessionStateFile);
  const accountPoolFile = args.accountPool ? path.resolve(args.accountPool) : "";
  let accountPool = accountPoolFile ? await loadAccountPool(accountPoolFile) : [];
  const accountDay = accountDayKey();
  const restrictedAccounts = restrictedAccountSet(savedState, accountDay);
  let activeAccount = accountPool.length ? chooseAccount(accountPool, restrictedAccounts, savedState?.accountId || "") : null;

  if (activeAccount) {
    args.cdp = activeAccount.cdp;
    args.session = args.newChat ? DOUBAO_CHAT_HOME : (activeAccount.session || args.session || savedState?.lastSessionUrl);
  }
  if (args.newChat) args.session = DOUBAO_CHAT_HOME;
  if (!args.session && !args.newChat && savedState?.lastSessionUrl) {
    args.session = savedState.lastSessionUrl;
    console.log(`[doubao-img] resuming remembered session ${args.session}`);
  }
  if (!args.session) {
    args.session = await askRequired(`Doubao chat session URL or id (required, example ${DEFAULT_SESSION}): `);
  }

  let sessionUrl = normalizeSession(args.session);
  const allPromptEntries = args.dryRun
    ? []
    : args.batchPromptFile
      ? await loadBatchPrompts(args.batchPromptFile)
      : [{ text: await loadPrompt(args), line: null }];
  const promptEntries = allPromptEntries.filter(item => {
    if (item.line === null) return true;
    if (args.fromLine !== undefined && item.line < args.fromLine) return false;
    if (args.toLine !== undefined && item.line > args.toLine) return false;
    return true;
  });
  const files = args.dryRun ? [] : await normalizeFiles(args.files);
  const characterImage = args.dryRun || !args.characterImage ? [] : await normalizeFiles([args.characterImage]);
  if (!args.dryRun && !promptEntries.length) throw new Error("prompt is required.");

  const outputDir = path.resolve(args.out);
  const inferredCompleted = args.resume ? await inferCompletedOutput(outputDir) : [];
  const savedCompleted = args.resume && Array.isArray(savedState?.completed) ? savedState.completed : [];
  const completedByLine = new Map();
  for (const item of [...inferredCompleted, ...savedCompleted]) {
    if (item?.line && item?.file) completedByLine.set(Number(item.line), item);
  }
  if (args.resume && savedState?.batchPromptFile && path.resolve(savedState.batchPromptFile) !== path.resolve(args.batchPromptFile)) {
    throw new Error(`--resume state belongs to a different batch prompt file: ${savedState.batchPromptFile}`);
  }
  if (args.resume && savedState?.characterImage && path.resolve(savedState.characterImage) !== path.resolve(args.characterImage)) {
    throw new Error(`--resume state belongs to a different character image: ${savedState.characterImage}`);
  }
  if (args.resume && savedState?.accountPoolFile && path.resolve(savedState.accountPoolFile) !== accountPoolFile) {
    throw new Error(`--resume state belongs to a different account pool: ${savedState.accountPoolFile}`);
  }

  console.log(`[doubao-img] connecting CDP ${args.cdp}`);
  let opened = await openDoubaoSession(args.cdp, sessionUrl, Boolean(args.newChat || activeAccount), args.resume, activeAccount);
  let client = opened.client;
  let currentUrl = opened.currentUrl;
  const captureState = { captured: new Set() };
  installNetworkImageCapture(client, captureState);
  const poolState = () => accountStateFields(accountPoolFile, activeAccount, restrictedAccounts);
  let forceCharacterContext = Boolean(args.characterImage && (args.newChat || activeAccount));

  console.log(`[doubao-img] session ${currentUrl}`);
  if (args.dryRun) {
    console.log(JSON.stringify({ sessionUrl, currentUrl, accountId: activeAccount?.id || "", dryRun: true }, null, 2));
    client.close();
    return;
  }

  if (args.inspectSession) {
    const inspectUrl = normalizeSession(args.inspectSession);
    if (inspectUrl !== currentUrl) {
      await client.send("Page.navigate", { url: inspectUrl });
      await sleep(3000);
      await waitForDoubaoEditorReady(client, 30000);
      const hookStatus = await installCreationHook(client);
      console.log(`[doubao-img] creation hook installed, existingCount=${hookStatus?.existingCount ?? 0}`);
    }
    console.log("[doubao-img] inspecting session, waiting a few seconds for network images to settle...");
    await sleep(5000);
    const report = await inspectSession(client, captureState);
    console.log(JSON.stringify(report, null, 2));
    client.close();
    return;
  }

  const results = [];
  const seenHashes = new Map();
  for (const item of completedByLine.values()) {
    if (item.hash) seenHashes.set(item.hash, { line: item.line, file: item.file });
  }

  const switchRestrictedAccount = async (error, lineNumber) => {
    if (!accountPool.length || !activeAccount || !isAccountRestrictedError(error)) return false;
    if (accountPool.length === 1) return false;
    restrictedAccounts.add(activeAccount.id);
    await writeJsonFile(sessionStateFile, {
      ...(savedState || {}),
      ...poolState(),
      version: 1,
      lastSessionUrl: currentUrl,
      failedLine: lineNumber,
      updatedAt: new Date().toISOString(),
    });
    if (accountPoolFile) accountPool = await loadAccountPool(accountPoolFile);
    activeAccount = chooseAccount(accountPool, restrictedAccounts, "");
    args.cdp = activeAccount.cdp;
    sessionUrl = normalizeSession(args.newChat ? DOUBAO_CHAT_HOME : (activeAccount.session || sessionUrl));
    console.log(`[doubao-img] account restricted; switching to ${activeAccount.id}`);
    client.close();
    opened = await openDoubaoSession(args.cdp, sessionUrl, true, false, activeAccount);
    client = opened.client;
    currentUrl = opened.currentUrl;
    captureState.captured = new Set();
    installNetworkImageCapture(client, captureState);
    forceCharacterContext = Boolean(args.characterImage);
    return true;
  };

  for (const [index, promptEntry] of promptEntries.entries()) {
    const promptText = promptEntry.text;
    const lineNumber = promptEntry.line;
    const completed = lineNumber ? completedByLine.get(lineNumber) : null;
    if (args.resume && completed?.file && await access(completed.file, fsConstants.R_OK).then(() => true).catch(() => false)) {
      if (completed.hash) seenHashes.set(completed.hash, { line: lineNumber, file: completed.file });
      console.log(`[doubao-img] resume skip line ${lineNumber}: ${completed.file}`);
      results.push({ index: index + 1, line: lineNumber, prompt: promptText, skipped: true, downloaded: [{ ...completed }] });
      continue;
    }

    let attempt = 0;
    while (true) {
      try {
        if (args.characterImage && (forceCharacterContext || index % args.characterBatchSize === 0 || attempt > 0)) {
          await sendCharacterContext(client, characterImage[0], args.characterPrompt, args, captureState);
          forceCharacterContext = false;
        }
        await writeJsonFile(sessionStateFile, {
          ...(savedState || {}),
          ...poolState(),
          version: 1,
          lastSessionUrl: currentUrl,
          batchPromptFile: args.batchPromptFile ? path.resolve(args.batchPromptFile) : "",
          characterImage: args.characterImage ? path.resolve(args.characterImage) : "",
          characterPrompt: args.characterPrompt || "",
          characterBatchSize: args.characterBatchSize || null,
          completed: [...completedByLine.values()].filter(value => value.line && value.file),
          inFlight: { line: lineNumber, prompt: promptText, sessionUrl: currentUrl, accountId: activeAccount?.id || "" },
          updatedAt: new Date().toISOString(),
        });

        if (args.batchPromptFile) console.log(`[doubao-img] batch prompt line ${lineNumber} (${index + 1}/${promptEntries.length})`);
        const result = await submitOnePrompt(client, sessionUrl, currentUrl, promptText, files, args, captureState, {
          lineNumber,
          hashNaming: Boolean(args.batchPromptFile),
          seenHashes,
        });
        currentUrl = result.finalUrl;
        sessionUrl = currentUrl || sessionUrl;
        for (const downloaded of result.downloaded || []) {
          if (lineNumber && downloaded.file) {
            completedByLine.set(Number(lineNumber), {
              line: lineNumber,
              hash: downloaded.hash,
              shortHash: downloaded.shortHash,
              file: downloaded.file,
              prompt: promptText,
            });
          }
        }
        await writeJsonFile(sessionStateFile, {
          ...poolState(),
          version: 1,
          lastSessionUrl: currentUrl,
          batchPromptFile: args.batchPromptFile ? path.resolve(args.batchPromptFile) : "",
          characterImage: args.characterImage ? path.resolve(args.characterImage) : "",
          characterPrompt: args.characterPrompt || "",
          characterBatchSize: args.characterBatchSize || null,
          completed: [...completedByLine.values()].filter(value => value.line && value.file),
          inFlight: null,
          updatedAt: new Date().toISOString(),
        });
        results.push({ index: index + 1, line: lineNumber, ...result });

        // 刷新页面以清理 Doubao 图像生成后的状态。
        // 实测发现：同一会话连续生成时，第二张图片容易出现模式漂移（例如变成
        // PPT 生成）或发送按钮变回语音输入按钮。每次成功后刷新当前页面，可以
        // 让下一张图片在干净的页面状态下重新选择图像生成模式并提交。
        if (args.batchPromptFile) {
          console.log("[doubao-img] reloading page to reset generation state for next prompt");
          await logDebug("RELOAD", { lineNumber, reason: "post-success", currentUrl });
          await client.send("Page.reload", { ignoreCache: false }).catch(() => {});
          await sleep(8000);
          await waitForDoubaoEditorReady(client, 30000);
          await installCreationHook(client);
          console.log("[doubao-img] creation hook re-installed after reload");
          client.imageModeSelected = false;
          // 注意：这里不再把 forceCharacterContext 设回 true，避免每次刷新都重新
          // 上传三视图/角色图。刷新后同一会话的聊天记录仍在，由 characterBatchSize
          // 控制周期性强化的上传频率。
        }

        break;
      } catch (error) {
        await logDebug("ERROR", { lineNumber, attempt, code: error.code || error.name, message: error.message, stack: error.stack, details: error.details });
        if (await switchRestrictedAccount(error, lineNumber)) {
          attempt = 0;
          continue;
        }
        // 图像生成模式按钮找不到时，先尝试刷新当前页面重试，避免每次成功都刷新。
        if (error.code === "IMAGE_GENERATION_MODE_NOT_FOUND" && attempt < args.maxRetries) {
          attempt += 1;
          console.log(`[doubao-img] image generation mode not found; reloading page and retrying line ${lineNumber} (${attempt}/${args.maxRetries})`);
          await logDebug("RELOAD", { lineNumber, reason: "image-mode-not-found", attempt });
          await client.send("Page.reload", { ignoreCache: false }).catch(() => {});
          await sleep(8000);
          await waitForDoubaoEditorReady(client, 30000);
          await installCreationHook(client);
          console.log("[doubao-img] creation hook re-installed after error-recovery reload");
          client.imageModeSelected = false;
          forceCharacterContext = Boolean(args.characterImage);
          continue;
        }
        const retryable = args.batchPromptFile && ["IMAGE_GENERATION_DUPLICATE_HASH", "ECONNRESET", "SEND_BUTTON_NOT_FOUND"].includes(error.code || error.name);
        if (retryable && attempt < args.maxRetries) {
          attempt += 1;
          console.log(`[doubao-img] retrying line ${lineNumber} (${attempt}/${args.maxRetries}) in a new Doubao tab`);
          await logDebug("NEW_TAB_RETRY", { lineNumber, attempt, code: error.code || error.name });
          client.close();
          opened = await openDoubaoSession(args.cdp, DOUBAO_CHAT_HOME, true, false, activeAccount);
          client = opened.client;
          currentUrl = opened.currentUrl;
          sessionUrl = currentUrl;
          captureState.captured = new Set();
          installNetworkImageCapture(client, captureState);
          forceCharacterContext = Boolean(args.characterImage);
          continue;
        }
        if (args.batchPromptFile && error instanceof DoubaoImgError) {
          error.details = { ...(error.details || {}), failedLine: lineNumber, failedPrompt: promptText };
        }
        throw error;
      }
    }
  }

  const output = args.batchPromptFile
    ? {
      sessionUrl,
      imageGeneration: true,
      batchPromptFile: path.resolve(args.batchPromptFile),
      ...(accountPoolFile ? {
        accountPoolFile,
        accountId: activeAccount?.id || "",
        restrictedAccounts: { [accountDay]: [...restrictedAccounts].sort() },
      } : {}),
      submitted: results.filter(item => !item.skipped).length,
      skipped: results.filter(item => item.skipped).length,
      results,
    }
    : {
      sessionUrl,
      ...(accountPoolFile ? { accountPoolFile, accountId: activeAccount?.id || "" } : {}),
      submitted: true,
      ...results[0],
    };
  console.log(JSON.stringify(output, null, 2));
  client.close();
}

main().catch(error => {
  const code = error.code || "DOUBAO_IMG_ERROR";
  const details = error.details ? `\n${JSON.stringify(error.details, null, 2)}` : "";
  console.error(`[doubao-img] failed (${code}): ${error.stack || error.message}${details}`);
  process.exit(1);
});
