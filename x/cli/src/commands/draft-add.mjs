import fs from "node:fs";
import { addDraft } from "../lib/draft-store.mjs";
import { validateTweetUrl, validateReplyText } from "../lib/validator.mjs";

/**
 * 命令行添加草稿
 * 支持单条命令行参数输入，或传入 markdown 文件批量解析入库
 */
export async function handleDraftAdd(args) {
  const fileIdx = args.indexOf("--file");
  if (fileIdx !== -1 && args[fileIdx + 1]) {
    const filePath = args[fileIdx + 1];
    if (!fs.existsSync(filePath)) {
      console.error(`❌ 文件不存在: ${filePath}`);
      process.exit(1);
    }
    const content = fs.readFileSync(filePath, "utf8");
    return importFromMarkdown(content, filePath);
  }

  const urlIdx = args.indexOf("--url");
  const textIdx = args.indexOf("--text");
  const authorIdx = args.indexOf("--author");
  const topicIdx = args.indexOf("--topic");

  const tweetUrl = urlIdx !== -1 ? args[urlIdx + 1] : null;
  const replyText = textIdx !== -1 ? args[textIdx + 1] : null;
  const author = authorIdx !== -1 ? args[authorIdx + 1] : "";
  const topic = topicIdx !== -1 ? args[topicIdx + 1] : "";

  if (!tweetUrl || !replyText) {
    console.error("❌ 缺少必要参数: --url <推文链接> --text <回复内容>");
    console.log("用法示例: node src/x-cli.mjs draft add --url \"https://x.com/...\" --text \"这是回复内容\"");
    process.exit(1);
  }

  if (!validateTweetUrl(tweetUrl)) {
    console.error(`❌ 非法推文链接: ${tweetUrl}`);
    process.exit(1);
  }

  if (!validateReplyText(replyText)) {
    console.error("❌ 回复内容过短或过长 (需在 2~1000 字符之间)");
    process.exit(1);
  }

  const { draft, isNew } = addDraft({ tweetUrl, replyText, author, topic });
  if (isNew) {
    console.log(`✅ 草稿已添加成功 (ID: ${draft.id})`);
  } else {
    console.log(`ℹ️ 已存在相同草稿 (ID: ${draft.id})，无需重复添加`);
  }
}

/**
 * 从 Markdown 文档中智能解析并批量导入草稿
 */
export function importFromMarkdown(markdownContent, sourcePath = "") {
  // 匹配类似:
  // - **原推链接**：https://x.com/...
  // 或 [https://x.com/...](https://x.com/...)
  // ### 💡 回复建议
  // > 回复内容...
  const sections = markdownContent.split(/\n(?=## |\n---\n)/);
  let importedCount = 0;

  for (const sec of sections) {
    const urlMatch = sec.match(/https?:\/\/(twitter|x)\.com\/[^/\s)]+\/status\/\d+/);
    const authorMatch = sec.match(/@(\w+)/);
    const topicMatch = sec.match(/##\s*\d*\.?\s*([^\n]+)/);

    // 提取回复内容（匹配 > 引用块或 ### 💡 回复建议 下面的引用）
    const replyMatch = sec.match(/###\s*💡\s*回复建议\s*\n+>\s*([^\n]+(?:\n>[^\n]+)*)/) ||
                       sec.match(/💡\s*回复\s*[：:]\s*\n+>\s*([^\n]+(?:\n>[^\n]+)*)/) ||
                       sec.match(/>\s*([^\n]+(?:\n>[^\n]+)*)/);

    if (urlMatch && replyMatch) {
      const tweetUrl = urlMatch[0];
      const replyText = replyMatch[1].replace(/^>\s*/gm, "").trim();
      const author = authorMatch ? `@${authorMatch[1]}` : "";
      const topic = topicMatch ? topicMatch[1].trim() : "";

      if (validateTweetUrl(tweetUrl) && validateReplyText(replyText)) {
        const { isNew } = addDraft({ tweetUrl, replyText, author, topic });
        if (isNew) importedCount++;
      }
    }
  }

  console.log(`✅ 成功从 ${sourcePath || "Markdown"} 导入 ${importedCount} 条回复草稿进入草稿箱！`);
  return importedCount;
}
