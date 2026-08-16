import { loadDrafts, updateDraftStatus } from "../lib/draft-store.mjs";
import { saveReplyToXOnlineDraft } from "../lib/x-online-draft.mjs";

/**
 * 将本地草稿推送到 X.com 官方线上草稿箱
 */
export async function handleDraftPushOnline(args) {
  const id = args[0];
  const portIdx = args.indexOf("--port");
  const port = portIdx !== -1 ? Number(args[portIdx + 1]) : 9221;

  const drafts = loadDrafts();
  let listToPush = [];

  if (id && id !== "all" && id !== "--all") {
    const target = drafts.find(d => d.id === id);
    if (!target) {
      console.error(`❌ 未找到草稿 ID: ${id}`);
      process.exit(1);
    }
    listToPush = [target];
  } else {
    // 默认推送所有待处理或未推送的草稿
    listToPush = drafts.filter(d => d.status !== "synced_online");
  }

  if (!listToPush.length) {
    console.log("ℹ️ 没有需要推送到 X 线上草稿箱的内容。");
    return;
  }

  console.log(`\n☁️ 准备将 ${listToPush.length} 条回复推送到 X.com 官方草稿箱 (端口: ${port})...\n`);

  let successCount = 0;
  for (let i = 0; i < listToPush.length; i++) {
    const draft = listToPush[i];
    console.log(`[${i + 1}/${listToPush.length}] 正在保存到 X 官方草稿箱...`);
    console.log(`  推文: ${draft.tweet_url}`);
    console.log(`  回复: ${draft.reply_text}`);

    try {
      await saveReplyToXOnlineDraft({
        tweetUrl: draft.tweet_url,
        replyText: draft.reply_text,
        port
      });

      updateDraftStatus(draft.id, "synced_online");
      console.log(`  ✅ 成功保存到 X 官方草稿箱！(ID: ${draft.id})\n`);
      successCount++;

      // 友好间隔
      if (i < listToPush.length - 1) {
        await new Promise(r => setTimeout(r, 4000));
      }
    } catch (err) {
      console.error(`  ❌ 保存失败 (${draft.id}):`, err.message, "\n");
    }
  }

  console.log(`✨ 全部完成！共成功推送 ${successCount}/${listToPush.length} 条回复到 X 官方草稿箱。`);
  console.log(`👉 你可以在网页版 X (https://x.com) 点击发帖框中的“未发送的帖子 (Unsent posts/Drafts)”直接查看！`);
}
