/**
 * 校验推文 URL 与回复文本合法性
 */
export function validateTweetUrl(url) {
  if (!url || typeof url !== "string") return false;
  return /https?:\/\/(twitter|x)\.com\/[^/]+\/status\/\d+/.test(url.trim());
}

export function extractTweetId(url) {
  const match = String(url).match(/status\/(\d+)/);
  return match ? match[1] : null;
}

export function validateReplyText(text) {
  if (!text || typeof text !== "string") return false;
  const trimmed = text.trim();
  return trimmed.length >= 2 && trimmed.length <= 1000;
}
