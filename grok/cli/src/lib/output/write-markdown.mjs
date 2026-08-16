// Write a clean markdown file for an automation run result.
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { DEFAULT_OUT_DIR } from '../config.mjs';

/**
 * @param {{
 *   outDir?: string,
 *   name?: string,
 *   markdown: string,
 *   automationId?: string,
 *   runId?: string,
 *   sourceUrl?: string,
 *   includeSourceComment?: boolean,
 * }} opts
 * @returns {{ path: string, bytes: number }}
 */
export function writeMarkdown({
  outDir = DEFAULT_OUT_DIR,
  name,
  markdown,
  automationId,
  runId,
  sourceUrl,
  includeSourceComment = true,
} = {}) {
  if (!markdown || !String(markdown).trim()) {
    throw new Error('markdown 正文为空，拒绝写盘');
  }

  const dir = resolve(outDir || DEFAULT_OUT_DIR);
  mkdirSync(dir, { recursive: true });

  const base =
    (name && String(name).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim()) ||
    defaultBasename(automationId, runId);

  const filePath = join(dir, base.endsWith('.md') ? base : `${base}.md`);

  const lines = [];
  if (includeSourceComment && sourceUrl) {
    lines.push(`<!-- source: ${sourceUrl} -->`);
    lines.push('');
  }
  lines.push(String(markdown).trim());
  lines.push('');

  const body = lines.join('\n');
  writeFileSync(filePath, body, 'utf8');
  return { path: filePath, bytes: Buffer.byteLength(body, 'utf8') };
}

/**
 * @param {string} [automationId]
 * @param {string} [runId]
 */
function defaultBasename(automationId, runId) {
  const a = (automationId || 'task').slice(0, 8);
  const r = (runId || stamp()).slice(0, 8);
  return `task-${a}-${r}`;
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}`;
}
