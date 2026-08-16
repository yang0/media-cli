import { loadDrafts, loadHistory } from "../lib/draft-store.mjs";

export async function handleDraftList(args) {
  const isHistory = args.includes("--history") || args.includes("-h");
  const filterStatus = args.includes("--status") ? args[args.indexOf("--status") + 1] : null;

  if (isHistory) {
    const history = loadHistory();
    console.log(`\n=== X 回复已发送历史记录 (${history.length} 条) ===\n`);
    if (!history.length) {
      console.log("暂无已发送历史记录。\n");
      return;
    }
    history.forEach((h, i) => {
      console.log(`[${i + 1}] ID: ${h.id} | 发送时间: ${h.sent_at || h.updated_at}`);
      console.log(`    推文: ${h.tweet_url}`);
      console.log(`    作者: ${h.author || "未知"} | 主题: ${h.topic || "无"}`);
      console.log(`    回复: ${h.reply_text}\n`);
    });
    return;
  }

  let drafts = loadDrafts();
  if (filterStatus) {
    drafts = drafts.filter(d => d.status === filterStatus);
  }

  console.log(`\n=== X 回复草稿箱 (${drafts.length} 条待处理) ===\n`);
  if (!drafts.length) {
    console.log("草稿箱为空。\n");
    return;
  }

  drafts.forEach((d, i) => {
    const statusIcon = d.status === "approved" ? "🟢" : (d.status === "pending" ? "🟡" : "⚪");
    console.log(`[${i + 1}] ${statusIcon} ID: ${d.id} | 状态: ${d.status}`);
    console.log(`    推文: ${d.tweet_url}`);
    console.log(`    作者: ${d.author || "未知"} | 主题: ${d.topic || "无"}`);
    console.log(`    回复: ${d.reply_text}`);
    console.log(`    创建时间: ${d.created_at}\n`);
  });
}
