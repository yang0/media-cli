export function isLikelyImageUrl(url) {
  if (!url || typeof url !== "string") return false;
  if (!/^https?:\/\//i.test(url)) return false;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (/\/(api|web|passport)\//i.test(parsed.pathname)) return false;
  if (/\.(png|jpe?g|webp|gif|mp4|webm|mov|m4v)(\?|$)/i.test(url)) return true;
  const hostLooksImage = /dola|byteimg|bytedance|volc|tos|cdn|image|img/i.test(parsed.hostname);
  const pathLooksImage = /image|img|video|mp4|webm|tplv|tos-|obj\/|origin|raw|large|webp|jpeg|jpg|png/i.test(parsed.pathname);
  const queryLooksSigned = /x-expires|expires|sign|signature|format|image|img|tplv|raw|origin|width|height/i.test(parsed.search);
  return hostLooksImage && pathLooksImage && queryLooksSigned;
}

export function isLikelyVideoUrl(url) {
  if (!url || typeof url !== "string" || !/^https?:\/\//i.test(url)) return false;
  try {
    const parsed = new URL(url);
    if (/\.(mp4|webm|mov|m4v)(\?|$)/i.test(url)) return true;
    if (/mime_type=video_|download=true/i.test(parsed.search)) return true;
    return /rc_gen_video|\/video\/|vid/i.test(parsed.pathname)
      && /dola|byte|bytedance|volc|tos|cdn/i.test(parsed.hostname);
  } catch {
    return false;
  }
}

export function rewriteVideoNoWatermarkParams(url) {
  if (!url || typeof url !== "string") return url;
  let next = url;
  if (/[?&]lr=/.test(next)) next = next.replace(/([?&])lr=[^&]*/g, "$1lr=video_gen_no_watermark");
  if (/watermark=1/i.test(next)) next = next.replace(/watermark=1/gi, "watermark=0");
  if (/[?&]logo=/.test(next)) next = next.replace(/([?&])logo=[^&]*/g, "$1");
  return next.replace(/\?&/, "?").replace(/&&+/g, "&").replace(/[?&]$/, "");
}

export function isWatermarkedUrl(url) {
  const text = String(url || "");
  if (/video_gen_no_watermark|no[_-]?watermark|watermark=0/i.test(text)) return false;
  return /watermark=1|downsize_watermark|image_dld_watermark|image_pre_watermark|hcg_watermark|img_pre_mark|wm_|with[_-]?water|marked|logo=/i.test(text)
    || (/watermark/i.test(text) && !/no[_-]?watermark|video_gen_no_watermark|watermark=0/i.test(text));
}

export function isPreferredRawUrl(url) {
  if (isWatermarkedUrl(url)) return false;
  if (/(image_raw|raw|origin|original|ori|source|large|no[_-]?watermark|without[_-]?watermark|video_gen_no_watermark)/i.test(url || "")) return true;
  if (/rc_gen_(?:image|video)\/[a-f0-9]{16,64}\.(jpeg|jpg|png|webp|mp4|webm)(\?|$)/i.test(url || "")) return true;
  return false;
}

/** Prefer no-watermark / original play URLs for video downloads (same intent as the desktop reseller tool). */

export function isPreferredVideoUrl(url) {
  if (!url || isWatermarkedUrl(url)) return false;
  if (/video_gen_no_watermark|no[_-]?watermark|original_media|watermark=0|\/(origin|raw)\//i.test(url)) return true;
  if (/mime_type=video_|download=true/i.test(url) && !isWatermarkedUrl(url)) return true;
  if (isLikelyVideoUrl(url) && !isWatermarkedUrl(url)) return true;
  return isPreferredRawUrl(url);
}

export function imageKeyFromUrl(url) {
  const text = String(url || "");
  const match = /rc_gen_(?:image|video)\/([a-f0-9]{16,64})(?:preview)?\.(?:jpeg|jpg|png|webp|mp4|webm)/i.exec(text)
    || /rc_gen_(?:image|video)\/([^~?/#]+)(?:~|\?|$)/i.exec(text);
  if (!match) return "";
  const filename = match[1].includes(".") ? match[1] : `${match[1]}.jpeg`;
  return text.match(/rc_gen_video/i) ? `rc_gen_video/${filename.replace(/preview\.(mp4|webm)$/i, ".$1")}` : `rc_gen_image/${filename.replace(/preview\.(jpeg|jpg|png|webp)$/i, ".$1")}`;
}

export function normalizeImageKey(value) {
  return imageKeyFromUrl(value) || String(value || "").replace(/^\d+_\d+_/, "");
}

export function collectImageUrls(value, found = new Set()) {
  if (!value) return found;
  if (typeof value === "string") {
    if (isLikelyImageUrl(value)) found.add(value);
    return found;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectImageUrls(item, found);
    return found;
  }
  if (typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (/url|uri|src|image|video|origin|original|raw|large|watermark/i.test(key)) collectImageUrls(item, found);
      else if (typeof item === "object") collectImageUrls(item, found);
    }
  }
  return found;
}

export function extractImageRecordsFromJson(value, records = []) {
  const visit = (node, context = {}) => {
    if (!node || typeof node !== "object") return;
    const next = {
      conversation_id: node.conversation_id || node.conversationId || context.conversation_id || "",
      message_id: node.message_id || node.messageId || node.id || context.message_id || "",
      key: node.key || context.key || "",
      prompt: node.prompt || node.query || node.input || context.prompt || "",
    };

    const urls = [];
    for (const [key, item] of Object.entries(node)) {
      if (/url|uri|src|image|video|origin|original|raw|large|watermark/i.test(key)) {
        for (const url of collectImageUrls(item)) urls.push(url);
      }
    }
    for (const url of urls) {
      records.push({ ...next, url, key: next.key || imageKeyFromUrl(url), raw: isPreferredRawUrl(url), watermarked: isWatermarkedUrl(url) });
    }

    for (const child of (Array.isArray(node) ? node : Object.values(node))) visit(child, next);
  };
  visit(value);
  return records;
}

export function uniqueImageRecords(records) {
  const byUrl = new Map();
  for (const item of records) {
    if (!item?.url || !isLikelyImageUrl(item.url)) continue;
    if (!byUrl.has(item.url)) byUrl.set(item.url, item);
  }
  return [...byUrl.values()];
}

export function rawUrlFromTrackKey(trackKey, origin) {
  if (!trackKey || !origin) return "";
  const path = String(trackKey).replace(/^\d+_\d+_/, "");
  if (!path) return "";
  try {
    return new URL(path, origin).href;
  } catch {
    return "";
  }
}

export function messageIdFromRecord(item) {
  if (!item) return 0;
  if (item.message_id && /^\d+$/.test(String(item.message_id))) return Number(item.message_id);
  const key = item.key || imageKeyFromUrl(item.url);
  const match = /^\d+_(\d+)_/.exec(String(key || ""));
  return match ? Number(match[1]) : 0;
}
