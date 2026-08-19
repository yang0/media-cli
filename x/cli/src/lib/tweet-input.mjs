/**
 * Normalize a tweet URL or numeric status ID for the capture command.
 *
 * X has several hostnames in the wild. We deliberately accept only X's
 * public status URL shapes and never attempt to infer a tweet from a search
 * or timeline URL.
 */
const ALLOWED_HOSTS = new Set(["x.com", "twitter.com", "mobile.x.com"]);
const STATUS_PATH = /\/status\/(\d+)(?:[/?#]|$)/i;

export function parseTweetReference(input) {
  const source = String(input ?? "").trim();
  if (!source) {
    throw new Error("推文不能为空，请传入 X 推文 URL 或纯数字 status ID");
  }

  if (/^\d+$/.test(source)) {
    return {
      sourceUrl: source,
      canonicalUrl: `https://x.com/i/status/${source}`,
      tweetId: source,
    };
  }

  let url;
  try {
    url = new URL(source.includes("://") ? source : `https://${source}`);
  } catch {
    throw new Error("推文必须是 x.com/twitter.com 的 status URL 或纯数字 ID");
  }

  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (!ALLOWED_HOSTS.has(host)) {
    throw new Error("只支持 x.com、twitter.com 或 mobile.x.com 的推文 URL");
  }

  const match = url.pathname.match(STATUS_PATH);
  if (!match) {
    throw new Error("URL 中未找到精确的 /status/<数字ID> 路径");
  }

  const tweetId = match[1];
  return {
    sourceUrl: source,
    canonicalUrl: `https://x.com/i/status/${tweetId}`,
    tweetId,
  };
}

export function isTweetId(value) {
  return /^\d+$/.test(String(value ?? ""));
}
