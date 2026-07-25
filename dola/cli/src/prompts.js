import { readFile } from 'node:fs/promises';
import { askRequired } from './utils.js';

export async function loadPrompt(args) {
  if (args.promptFile) return (await readFile(args.promptFile, "utf8")).trim();
  if (args.prompt) return String(args.prompt).trim();
  return askRequired("Prompt to submit: ");
}

export async function loadBatchPrompts(file) {
  const text = await readFile(file, "utf8");
  const prompts = text
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((line, index) => ({ text: line.trim(), line: index + 1 }))
    .filter(item => item.text);
  if (!prompts.length) throw new Error(`No non-empty prompts found in batch file: ${file}`);
  return prompts;
}
