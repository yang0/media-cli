import { loadDrafts, updateDraftStatus, recordSent, deleteDraft } from "../lib/draft-store.mjs";
import { sendReplyViaCdp } from "../lib/cdp-reply.mjs";

export async function handleDraftSend(args) {
  const id = args[0];
  const portIdx = args.indexOf("--port");
  const port = portIdx !== -1 ? Number(args[portIdx + 1]) : 9221;
  const keepInDrafts = args.includes("--keep");

  const drafts = loadDrafts();
  let targetDraft = null;

  if (id && id !== "all" && id !== "--all") {
    targetDraft = drafts.find(d => d.id === id);
    if (!targetDraft) {
      console.error(`❌ 未找到草稿 ID: ${id}`);
      process.exit(1);
    }
  }

  const listToSend = targetDraft ? [targetDraft] : drafts.filter(d => d.status === "approved");

  if (!listToSend.length) {
    console.log("ℹ️ 没有可发送的草稿（指定 ID 或状态为 approved 的草稿）。");
    return;
  }

  console.log(`\n🚀 准备通过 Chrome CDP (${port}) 发送 ${listToSend.length} 条回复...\n`);

  for (const draft of listToSend) {
    console.log(`[发送中] ID: ${draft.id} -> 推文: ${draft.tweet_url}`);
    console.log(`         内容: ${draft.reply_text}`);
    try {
      await sendReplyViaCdp({
        tweetUrl: draft.tweet_url,
        replyText: draft.reply_text,
        port
      });

      console.log(`✅ 发送成功: ${draft.id}`);
      recordSent(draft);

      if (!keepInDrafts) {
        deleteDraft(draft.id);
      } else {
        updateDraftStatus(draft.id, "sent");
      }

      // 人性化间隔 5 秒
      await new Promise(r => setTimeout(r, 5000));
    } catch (err) {
      console.error(`❌ 发送失败 (${draft.id}):`, err.message);
    }
  }

  console.log("\n✨ 发送流程结束。");
}
