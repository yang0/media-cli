import { updateDraftStatus, deleteDraft, saveDrafts } from "../lib/draft-store.mjs";

export async function handleDraftApprove(args) {
  const id = args[0];
  if (!id) {
    console.error("❌ 请指定要批准的草稿 ID: node src/x-cli.mjs draft approve <id>");
    process.exit(1);
  }
  const draft = updateDraftStatus(id, "approved");
  if (!draft) {
    console.error(`❌ 未找到草稿 ID: ${id}`);
    process.exit(1);
  }
  console.log(`🟢 草稿 ${id} 已标记为已批准 (approved)`);
}

export async function handleDraftDelete(args) {
  const id = args[0];
  if (!id) {
    console.error("❌ 请指定要删除的草稿 ID: node src/x-cli.mjs draft delete <id>");
    process.exit(1);
  }
  const removed = deleteDraft(id);
  if (!removed) {
    console.error(`❌ 未找到草稿 ID: ${id}`);
    process.exit(1);
  }
  console.log(`🗑️ 草稿 ${id} 已从草稿箱中删除`);
}

export async function handleDraftClear() {
  saveDrafts([]);
  console.log("🧹 草稿箱已全部清空。");
}
