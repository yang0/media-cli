import path from 'node:path';
import { access, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function readJsonFile(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error(`Could not read JSON state file ${file}: ${error.message}`);
  }
}

export async function writeJsonFile(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const tempFile = `${file}.${process.pid}.tmp`;
  await writeFile(tempFile, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tempFile, file);
}

export async function normalizeFiles(files) {
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

export function safeFilePart(value, fallback) {
  return String(value || fallback).replace(/[\\/:*?"<>|\r\n]+/g, "-").replace(/\s+/g, " ").trim().slice(0, 90) || fallback;
}

export async function askRequired(question) {
  const rl = createInterface({ input, output });
  try {
    const answer = (await rl.question(question)).trim();
    if (!answer) throw new Error("Required input was empty.");
    return answer;
  } finally {
    rl.close();
  }
}

export async function inferCompletedOutput(outDir) {
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

export function extensionFromUrl(url, contentType) {
  const ext = path.extname(new URL(url).pathname).replace(".", "").toLowerCase();
  if (["png", "jpg", "jpeg", "webp", "gif", "mp4", "webm", "mov", "m4v"].includes(ext)) return ext;
  if (/mp4/i.test(contentType || "")) return "mp4";
  if (/webm/i.test(contentType || "")) return "webm";
  if (/quicktime/i.test(contentType || "")) return "mov";
  if (/png/i.test(contentType || "")) return "png";
  if (/webp/i.test(contentType || "")) return "webp";
  if (/gif/i.test(contentType || "")) return "gif";
  return "jpg";
}

export function accountDayKey(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}
