import path from 'node:path';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { classifyImageGenerationTextError, lastReplySnapshot, looksLikeImageGenerationProgress, looksLikePromptEcho, waitForImageGenerationComplete } from '../chat/reply.js';
import { DolaCliError } from '../errors.js';
import { collectDomImages, collectHookImages } from '../media/capture.js';
import { imageKeyFromUrl, isLikelyVideoUrl, isPreferredRawUrl, isPreferredVideoUrl, isWatermarkedUrl, messageIdFromRecord, normalizeImageKey, rewriteVideoNoWatermarkParams, uniqueImageRecords } from '../media/urls.js';
import { extensionFromUrl, safeFilePart, sleep } from '../utils.js';
import { activateLatestVideoPlayer } from '../video/mode.js';
import { collectDomVideos } from '../video/resolve.js';

export function recordMatchesLastReply(item, lastReply) {
  if (!lastReply) return true;
  const replyKeys = new Set(lastReply.imageKeys || []);
  const replyUrls = new Set([
    ...(lastReply.imageUrls || []),
    ...(lastReply.imageUrls || []).map(rewriteVideoNoWatermarkParams),
  ]);
  const itemKey = normalizeImageKey(item.key || item.url);
  if (itemKey && replyKeys.has(itemKey)) return true;
  if (item.url && (replyUrls.has(item.url) || replyUrls.has(rewriteVideoNoWatermarkParams(item.url)))) return true;
  // Video replies often lack message ids; accept items sourced from the last reply snapshot.
  if (item.source === "last-reply-video" || item.source === "last-reply") return true;
  const itemMessageId = messageIdFromRecord(item);
  if (lastReply.messageId && itemMessageId && String(itemMessageId) === String(lastReply.messageId)) return true;
  // If the last reply is clearly a finished video message and this is a playable video URL, keep it.
  if (/你的视频生成好了|video.*ready|生成好了/i.test(lastReply.text || "") && isLikelyVideoUrl(item.url)) return true;
  return false;
}

export function recordsFromLastReply(lastReply) {
  if (!lastReply) return [];
  return (lastReply.imageUrls || []).map((url, index) => {
    const rewritten = isLikelyVideoUrl(url) ? rewriteVideoNoWatermarkParams(url) : url;
    const watermarked = isWatermarkedUrl(rewritten);
    const video = isLikelyVideoUrl(rewritten);
    return {
      url: rewritten,
      key: lastReply.imageKeys?.[index] || imageKeyFromUrl(url),
      message_id: lastReply.messageId || "",
      raw: video ? (!watermarked && isPreferredVideoUrl(rewritten)) : isPreferredRawUrl(rewritten),
      watermarked,
      source: video ? "last-reply-video" : "last-reply",
      score: video ? (/video_gen_no_watermark|download=true/i.test(rewritten) ? 80 : 40) : 0,
    };
  });
}

export function chooseDownloadItems(records, beforeUrls, options) {
  const fresh = uniqueImageRecords(records)
    .filter(item => !beforeUrls.has(item.url))
    .filter(item => !options.videoGen || isLikelyVideoUrl(item.url) || item.vid || /rc_gen_video|video/i.test(item.url || ""))
    .filter(item => {
      const key = normalizeImageKey(item.key || item.url);
      return !key || !options.beforeImageKeys?.has(key);
    })
    .filter(item => recordMatchesLastReply(item, options.lastReply));
  const rawByKey = new Map();
  for (const item of fresh) {
    const key = normalizeImageKey(item.key || item.vid || item.url);
    if (key && item.raw && !item.watermarked) rawByKey.set(key, item);
  }
  const resolved = fresh.map(item => {
    const key = normalizeImageKey(item.key || item.vid || item.url);
    if (item.watermarked && key && rawByKey.has(key)) return rawByKey.get(key);
    return item;
  });
  // Normalize video candidates: rewrite lr=/watermark params toward no-watermark play URLs.
  const normalized = resolved.map(item => {
    if (!options.videoGen) return item;
    const rewritten = rewriteVideoNoWatermarkParams(item.url);
    const watermarked = isWatermarkedUrl(rewritten);
    const raw = !watermarked && (item.raw || isPreferredVideoUrl(rewritten) || /play_info|original_media|video_model|no_watermark/i.test(item.source || ""));
    return {
      ...item,
      url: rewritten,
      watermarked,
      raw,
      score: (Number(item.score) || 0) + (raw ? 50 : 0) + (/video_gen_no_watermark|download=true/i.test(rewritten) ? 30 : 0),
    };
  });
  // Video: drop explicit watermark marks unless allowed; keep normal playable mp4 links.
  const clean = normalized.filter(item => {
    if (item.watermarked) return Boolean(options.allowWatermark || options.watermarkFallback);
    if (options.videoGen) return isLikelyVideoUrl(item.url) || item.raw || item.vid;
    return true;
  });
  const generated = clean.filter(item => options.videoGen
    ? (isLikelyVideoUrl(item.url) || item.vid || /rc_gen_video|\/video\//i.test(item.url || ""))
    : item.key || /rc_gen_(?:image|video)/i.test(item.url));
  const preferred = clean.filter(item => item.raw || (options.videoGen && isPreferredVideoUrl(item.url)));
  const allowDirty = Boolean(options.allowWatermark || options.watermarkFallback);
  const fallbackAny = allowDirty ? normalized.filter(item => item.watermarked) : [];
  // Sort: no-watermark/raw first, then recent message id.
  const sortByRecent = items => [...items].sort((a, b) => {
    const scoreDiff = (Number(b.score) || 0) - (Number(a.score) || 0);
    if (scoreDiff) return scoreDiff;
    const rawDiff = Number(Boolean(b.raw)) - Number(Boolean(a.raw));
    if (rawDiff) return rawDiff;
    return messageIdFromRecord(b) - messageIdFromRecord(a);
  });
  const ordered = [
    ...sortByRecent(generated.filter(item => item.raw || isPreferredVideoUrl(item.url))),
    ...sortByRecent(generated.filter(item => !(item.raw || isPreferredVideoUrl(item.url)))),
    ...sortByRecent(preferred.filter(item => !generated.includes(item))),
    ...sortByRecent(clean.filter(item => !item.raw && !generated.includes(item))),
    ...fallbackAny,
  ];
  return uniqueImageRecords(ordered).slice(0, options.count);
}

export async function recoverPendingDownload(client, capturedRecords, inFlight, options) {
  const beforeUrls = new Set(inFlight?.beforeUrls || []);
  const beforeImageKeys = new Set(inFlight?.beforeImageKeys || []);
  const started = Date.now();
  let lastReply = null;
  while (Date.now() - started < Math.min(options.timeout, 120000)) {
    lastReply = await lastReplySnapshot(client);
    capturedRecords.push(...recordsFromLastReply(lastReply));
    capturedRecords.push(...await collectHookImages(client));
    capturedRecords.push(...await collectDomImages(client));
    if (options.videoGen) capturedRecords.push(...await collectDomVideos(client));
    const selected = chooseDownloadItems(capturedRecords, beforeUrls, {
      ...options,
      beforeImageKeys,
      lastReply,
    });
    if (selected.length >= options.count && selected.some(item => item.key || /rc_gen_(?:image|video)/i.test(item.url))) return selected;
    await sleep(1000);
  }
  // Fallback: collect the most recent generated images visible on the page.
  // This handles the case where images were already generated before the process was interrupted.
  const domRecords = (await collectDomImages(client))
    .filter(url => /rc_gen_(?:image|video)/i.test(url) && !beforeUrls.has(url))
    .map(url => ({
      url,
      key: imageKeyFromUrl(url),
      message_id: "",
      conversation_id: "",
      raw: isPreferredRawUrl(url),
      watermarked: isWatermarkedUrl(url),
    }));
  const candidateMap = new Map();
  for (const item of uniqueImageRecords([...capturedRecords, ...domRecords])) {
    if (!/rc_gen_(?:image|video)/i.test(item.url) || beforeUrls.has(item.url)) continue;
    const key = normalizeImageKey(item.key || item.url);
    if (!key) continue;
    const existing = candidateMap.get(key);
    if (!existing || (item.raw && !existing.raw) || (!item.watermarked && existing.watermarked)) {
      candidateMap.set(key, item);
    }
  }
  const fallback = Array.from(candidateMap.values())
    .sort((a, b) => messageIdFromRecord(b) - messageIdFromRecord(a))
    .slice(0, options.count);
  if (fallback.length) return fallback;
  return null;
}

export async function waitForDownloadItems(client, beforeUrls, capturedRecords, options) {
  await waitForImageGenerationComplete(client, options);
  const started = Date.now();
  const pollMs = options.videoGen ? 60000 : 1000;
  let pollCount = 0;
  let lastChange = Date.now();
  let lastCount = 0;
  // Anchor the reply once generation is complete. Dola can reorder/virtualize
  // old message nodes while raw URLs arrive, which must not change the scope.
  const anchoredReply = await lastReplySnapshot(client);
  let lastReply = anchoredReply;
  let lastReplyChange = Date.now();
  while (Date.now() - started < options.timeout) {
    if (options.videoGen && pollCount > 0) {
      console.log(`[dola-cli] video generation poll ${pollCount}: checking the current form reply`);
    }
    if (!lastReply?.imageKeys?.length) {
      const replyWithImages = await lastReplySnapshot(client);
      if (replyWithImages?.imageKeys?.length) {
        lastReply = replyWithImages;
        lastReplyChange = Date.now();
        console.log(`[dola-cli] anchored last reply images=${lastReply.imageKeys.length} messageId=${lastReply.messageId || "unknown"}`);
      }
    }
    if (options.videoGen) await activateLatestVideoPlayer(client);
    capturedRecords.push(...recordsFromLastReply(lastReply));
    capturedRecords.push(...await collectHookImages(client));
    capturedRecords.push(...await collectDomImages(client));
    if (options.videoGen) capturedRecords.push(...await collectDomVideos(client));
    const scopedOptions = { ...options, lastReply };
    const selected = chooseDownloadItems(capturedRecords, beforeUrls, scopedOptions);
    const freshRecords = uniqueImageRecords(capturedRecords).filter(item => !beforeUrls.has(item.url));
    const freshCount = freshRecords.length;
    if (freshCount !== lastCount) {
      lastCount = freshCount;
      lastChange = Date.now();
      const generated = freshRecords.filter(item => item.key || /rc_gen_(?:image|video)/i.test(item.url)).length;
      const raw = freshRecords.filter(item => item.raw && !item.watermarked).length;
      const watermarked = freshRecords.filter(item => item.watermarked).length;
      console.log(`[dola-cli] captured ${freshCount} image URL(s), generated=${generated}, raw=${raw}, watermarked=${watermarked}, selected=${selected.length}`);
    }
    const hasGenerated = selected.some(item => options.videoGen ? isLikelyVideoUrl(item.url) : item.key || /rc_gen_(?:image|video)/i.test(item.url));
    if (selected.length >= options.count && hasGenerated && Date.now() - lastChange >= options.stable) return selected;
    // Fallback: if no item was matched against the last reply but fresh generated images exist,
    // return the best available candidates. This handles cases where Dola's reply/image
    // association cannot be detected reliably.
    if (selected.length === 0 && Date.now() - lastChange >= options.stable) {
      const generatedRecords = freshRecords.filter(item => options.videoGen ? isLikelyVideoUrl(item.url) : item.key || /rc_gen_(?:image|video)/i.test(item.url));
      if (generatedRecords.length) {
        const candidateMap = new Map();
        for (const item of generatedRecords) {
          const key = normalizeImageKey(item.key || item.url);
          if (!key) continue;
          const existing = candidateMap.get(key);
          if (!existing || (item.raw && !existing.raw) || (!item.watermarked && existing.watermarked)) {
            candidateMap.set(key, item);
          }
        }
        const fallback = Array.from(candidateMap.values())
          .sort((a, b) => messageIdFromRecord(b) - messageIdFromRecord(a))
          .slice(0, options.count);
        if (fallback.length) {
          console.log(`[dola-cli] using fallback image selection: ${fallback.length} candidate(s)`);
          return fallback;
        }
      }
    }
    const replyIsFinalText = lastReply?.signature
      && lastReply.signature !== options.beforeLastReply?.signature
      && !lastReply.imageKeys?.length
      && lastReply.text
      && Date.now() - lastReplyChange >= options.stable;
    if (replyIsFinalText) {
      const code = classifyImageGenerationTextError(lastReply.text);
      const progressOnly = code === "IMAGE_GENERATION_TEXT_RESPONSE"
        && looksLikeImageGenerationProgress(lastReply.text);
      const echo = looksLikePromptEcho(lastReply.text, options.promptText);
      if (!echo && !progressOnly) {
        throw new DolaCliError(code, `Image generation returned text instead of images: ${lastReply.text.slice(0, 300)}`, { lastReply });
      }
    }
    pollCount += 1;
    await sleep(pollMs);
  }
  const finalReply = await lastReplySnapshot(client);
  capturedRecords.push(...recordsFromLastReply(finalReply));
  const scopedOptions = { ...options, lastReply: finalReply.signature ? finalReply : lastReply };
  const selected = chooseDownloadItems(capturedRecords, beforeUrls, scopedOptions);
  const hasGenerated = selected.some(item => options.videoGen ? isLikelyVideoUrl(item.url) : item.key || /rc_gen_(?:image|video)/i.test(item.url));
  if (selected.length && hasGenerated) return selected;
  const reply = scopedOptions.lastReply;
  if (reply?.signature && reply.signature !== options.beforeLastReply?.signature && !reply.imageKeys?.length && reply.text) {
    const code = classifyImageGenerationTextError(reply.text);
    const progressOnly = code === "IMAGE_GENERATION_TEXT_RESPONSE"
      && looksLikeImageGenerationProgress(reply.text);
    if (!looksLikePromptEcho(reply.text, options.promptText) && !progressOnly) {
      throw new DolaCliError(code, `Image generation returned text instead of images: ${reply.text.slice(0, 300)}`, { lastReply: reply });
    }
  }
  throw new DolaCliError(
    options.allowWatermark || options.watermarkFallback ? "IMAGE_GENERATION_TIMEOUT" : "IMAGE_GENERATION_NO_CLEAN_IMAGE",
    options.allowWatermark || options.watermarkFallback
      ? `Timed out after ${options.timeout}ms without generated image URLs in the last reply.`
      : `Timed out after ${options.timeout}ms without clean/raw image URLs in the last reply. Use --allow-watermark to permit fallback URLs.`,
    { lastReply: reply || null }
  );
}

export async function downloadImages(items, outDir, options = {}) {
  await mkdir(outDir, { recursive: true });
  const results = [];
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (item.watermarked && !options.allowWatermark && !options.watermarkFallback) {
      throw new Error(`Refusing to download watermarked URL without --allow-watermark: ${item.url}`);
    }
    let response;
    let lastDownloadError;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        response = await fetch(item.url, { headers: { "user-agent": "Mozilla/5.0", accept: "video/mp4,video/webm,image/avif,image/webp,image/apng,image/*,*/*;q=0.8", referer: "https://www.dola.com/" } });
        if (response.ok) break;
        lastDownloadError = new Error(`Download failed ${response.status}: ${item.url}`);
      } catch (error) {
        lastDownloadError = error;
      }
      if (attempt < 3) {
        console.log(`[dola-cli] image download retry ${attempt + 1}/3: ${lastDownloadError?.message || "unknown error"}`);
        await sleep(attempt * 1000);
      }
    }
    if (!response?.ok) {
      console.error(`[dola-cli] image download failed for ${item.url}: ${lastDownloadError?.message || "unknown error"}`);
      throw lastDownloadError || new Error(`Download failed: ${item.url}`);
    }
    const ext = extensionFromUrl(item.url, response.headers.get("content-type"));
    const bytes = Buffer.from(await response.arrayBuffer());
    const hash = createHash("sha256").update(bytes).digest("hex");
    const shortHash = hash.slice(0, 12);
    if (options.seenHashes?.has(hash)) {
      const first = options.seenHashes.get(hash);
      throw new DolaCliError(
        "IMAGE_GENERATION_DUPLICATE_HASH",
        `Downloaded image content duplicates an earlier image (hash ${shortHash}).`,
        { hash, shortHash, line: options.lineNumber, firstLine: first?.line, firstFile: first?.file }
      );
    }
    const stem = options.hashNaming
      ? [safeFilePart(options.lineNumber, "line"), shortHash]
      : ["dola", item.conversation_id, item.message_id, item.key, item.raw ? "raw" : "clean", String(i + 1).padStart(2, "0")]
        .filter(Boolean)
        .map(part => safeFilePart(part, "item"))
        .join("-");
    const file = path.resolve(outDir, `${stem}.${ext}`);
    await writeFile(file, bytes);
    options.seenHashes?.set(hash, { line: options.lineNumber, file });
    results.push({ ...item, file, hash, shortHash, line: options.lineNumber });
    console.log(`[dola-cli] saved ${file}`);
  }
  return results;
}
