import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DRAFTS_DIR, DRAFTS_FILE, HISTORY_FILE } from "./config.mjs";
import { extractTweetId } from "./validator.mjs";

function ensureDir() {
  if (!fs.existsSync(DRAFTS_DIR)) {
    fs.mkdirSync(DRAFTS_DIR, { recursive: true });
  }
}

export function loadDrafts() {
  ensureDir();
  if (!fs.existsSync(DRAFTS_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(DRAFTS_FILE, "utf8"));
  } catch {
    return [];
  }
}

export function saveDrafts(drafts) {
  ensureDir();
  fs.writeFileSync(DRAFTS_FILE, JSON.stringify(drafts, null, 2), "utf8");
}

export function loadHistory() {
  ensureDir();
  if (!fs.existsSync(HISTORY_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
  } catch {
    return [];
  }
}

export function recordSent(draft) {
  ensureDir();
  const history = loadHistory();
  history.push({
    ...draft,
    status: "sent",
    sent_at: new Date().toISOString()
  });
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2), "utf8");
}

/**
 * 统计指定博主今日已生成的回复数量（草稿箱 + 已发送历史）
 */
export function getAuthorReplyCountToday(author) {
  if (!author) return 0;
  const cleanAuthor = author.replace(/^@/, "").toLowerCase();
  const todayStr = new Date().toISOString().slice(0, 10);

  const drafts = loadDrafts();
  const history = loadHistory();

  let count = 0;
  for (const d of drafts) {
    const dAuthor = (d.author || "").replace(/^@/, "").toLowerCase();
    const dDate = (d.created_at || "").slice(0, 10);
    if (dAuthor === cleanAuthor && dDate === todayStr) {
      count++;
    }
  }

  for (const h of history) {
    const hAuthor = (h.author || "").replace(/^@/, "").toLowerCase();
    const hDate = (h.sent_at || h.created_at || "").slice(0, 10);
    if (hAuthor === cleanAuthor && hDate === todayStr) {
      count++;
    }
  }

  return count;
}

/**
 * 添加单条或多条回复草稿（单账号每日严格限制 ≤ 2 次）
 */
export function addDraft({ tweetUrl, replyText, author = "", topic = "", status = "pending" }) {
  const drafts = loadDrafts();
  const tweetId = extractTweetId(tweetUrl);
  
  // 1. 查重
  const existing = drafts.find(d => d.tweet_url === tweetUrl && d.reply_text === replyText);
  if (existing) {
    return { draft: existing, isNew: false, reason: "duplicate" };
  }

  // 2. 检查单账号每日回复上限（上限 2 次）
  if (author) {
    const todayCount = getAuthorReplyCountToday(author);
    if (todayCount >= 2) {
      return { draft: null, isNew: false, reason: "daily_cap_exceeded", count: todayCount };
    }
  }

  const newDraft = {
    id: randomUUID().slice(0, 8),
    tweet_id: tweetId,
    tweet_url: tweetUrl,
    author: author || "",
    topic: topic || "",
    reply_text: replyText.trim(),
    status: status,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };

  drafts.unshift(newDraft);
  saveDrafts(drafts);
  return { draft: newDraft, isNew: true };
}

export function updateDraftStatus(draftId, status) {
  const drafts = loadDrafts();
  const draft = drafts.find(d => d.id === draftId);
  if (!draft) return null;
  draft.status = status;
  draft.updated_at = new Date().toISOString();
  saveDrafts(drafts);
  return draft;
}

export function deleteDraft(draftId) {
  const drafts = loadDrafts();
  const idx = drafts.findIndex(d => d.id === draftId);
  if (idx === -1) return false;
  const removed = drafts.splice(idx, 1);
  saveDrafts(drafts);
  return removed[0];
}
