/**
 * 口播稿解析 - 从 Markdown/TXT 中提取纯文本
 */

import { readFileSync } from "node:fs";

/**
 * 解析口播稿文件，提取需要朗读的纯文本
 * - 跳过 YAML frontmatter (--- ... ---)
 * - 跳过 Markdown 标题 (#)
 * - 跳过视觉提示等非口播内容
 * - 合并多行纯文本
 */
export function parseScript(filePath: string): string {
  const raw = readFileSync(filePath, "utf-8").replace(/^\uFEFF/, "");
  const lines = raw.split("\n");

  const result: string[] = [];
  // YAML frontmatter is valid only when the very first line is a fence.
  // Later `---` lines are ordinary Markdown section separators.
  let inFrontMatter = lines[0]?.trim() === "---";
  let inBlock = false;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const trimmed = line.trim();

    // Skip only the opening frontmatter fence at the top of the file.
    if (index === 0 && inFrontMatter) {
      continue;
    }
    // The next exact fence ends top-level frontmatter.
    if (inFrontMatter && trimmed === "---") {
      inFrontMatter = false;
      continue;
    }
    if (inFrontMatter) continue;

    // 跳过空行
    if (!trimmed) {
      if (inBlock) {
        result.push("");
        inBlock = false;
      }
      continue;
    }

    // 遇到视觉提示区块就停止（后面的内容不朗读）
    if (/^#{1,2}\s*(视觉提示|画面意图)/.test(trimmed)) break;

    // 跳过 Markdown 标题
    if (trimmed.startsWith("#")) continue;

    // 跳过水平线
    if (trimmed.startsWith("---") || trimmed.startsWith("***")) continue;
    if (trimmed.match(/^[*-]\s*(前面|开头|中间|结尾|纯色段)/)) continue;

    // 保留纯文本
    // 去掉 Markdown 粗体/斜体标记
    const clean = trimmed.replace(/\*\*(.+?)\*\*/g, "$1").replace(/\*(.+?)\*/g, "$1");
    
    // 去掉列表标记
    const text = clean.replace(/^[\s]*[-*+]\s+/, "").replace(/^\d+[.、]\s*/, "");
    
    if (text) {
      result.push(text);
      inBlock = true;
    }
  }

  // 合并
  return result
    .join("")
    .replace(/\n{2,}/g, "。")
    .replace(/\n/g, "")
    .replace(/[。]{2,}/g, "。")
    .replace(/^[。]/, "")
    .trim();
}
