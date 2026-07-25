import { evaluate } from '../cdp.js';
import { DOLA_MEDIA_AID } from '../config.js';
import { imageKeyFromUrl, isLikelyVideoUrl, isPreferredVideoUrl, isWatermarkedUrl, uniqueImageRecords } from '../media/urls.js';

export async function installVideoResolveHelpers(client) {
  // Always refresh collectors so logic updates apply without reloading the tab.
  await evaluate(client, `(() => {
    window.__dolaCliVideoUrlDb = window.__dolaCliVideoUrlDb || new Map();
    window.__dolaCliVideoByMessage = window.__dolaCliVideoByMessage || new Map();
    window.__dolaCliResolvedVideoRecords = window.__dolaCliResolvedVideoRecords || [];

    function decodeVideoUrl(encoded) {
      if (!encoded || typeof encoded !== "string") return null;
      if (encoded.indexOf("http") === 0 || encoded.indexOf("://") !== -1) return encoded;
      try {
        const decoded = atob(encoded);
        if (decoded.indexOf("http") === 0) return decoded;
        const decoded2 = atob(decoded);
        if (decoded2.indexOf("http") === 0) return decoded2;
      } catch {}
      return encoded;
    }

    function isWatermarked(url) {
      const text = String(url || "");
      if (/video_gen_no_watermark|no[_-]?watermark|watermark=0/i.test(text)) return false;
      return /watermark=1|hcg_watermark|downsize_watermark|with[_-]?water|logo=/i.test(text)
        || (/watermark/i.test(text) && !/no[_-]?watermark|video_gen_no_watermark|watermark=0/i.test(text));
    }

    function makeNoWatermarkUrl(videoUrl) {
      if (!videoUrl) return videoUrl;
      let url = videoUrl;
      if (url.indexOf("lr=") !== -1) url = url.replace(/lr=[^&]+/g, "lr=video_gen_no_watermark");
      if (url.indexOf("watermark") !== -1) {
        url = url.replace(/watermark=1/g, "watermark=0");
        url = url.replace(/~tplv-[^.?&]*watermark[^.?&]*/gi, "");
      }
      if (url.indexOf("logo=") !== -1) url = url.replace(/[&?]logo=[^&]*/g, "");
      return url;
    }

    function scoreCandidate(candidate) {
      if (!candidate || !candidate.url || typeof candidate.url !== "string") return -Infinity;
      if (candidate.url.indexOf("http") !== 0 && candidate.url.indexOf("://") === -1) {
        candidate.url = decodeVideoUrl(candidate.url);
      }
      if (!candidate.url || candidate.url.indexOf("http") !== 0) return -Infinity;
      const text = String(candidate.key || "") + " " + String(candidate.source || "") + " " + candidate.url;
      const lower = text.toLowerCase();
      let score = 0;
      if (String(candidate.source || "").includes("original_media_info")) score += 140;
      if (/no[_-]?watermark/.test(lower)) score += 130;
      if (lower.includes("video_gen_no_watermark") || /watermark=0/.test(lower)) score += 100;
      if (/\\b(original|origin|raw)\\b/.test(lower)) score += 90;
      if (/\\.(mp4|webm|mov)(\\?|$)/i.test(candidate.url)) score += 40;
      if (candidate.width && candidate.height) score += Math.min(40, Math.log2((candidate.width * candidate.height) / 10000 + 1) * 10);
      if (isWatermarked(candidate.url) || /watermark=1|hcg_watermark|downsize_watermark/.test(lower)) score -= 200;
      return score;
    }

    function chooseBest(candidates) {
      let best = null;
      let bestScore = -Infinity;
      for (const candidate of candidates || []) {
        const score = scoreCandidate(candidate);
        if (score > bestScore) {
          best = candidate;
          bestScore = score;
        }
      }
      if (!best || bestScore < 0) return null;
      const url = makeNoWatermarkUrl(best.url);
      return {
        url,
        width: best.width || 0,
        height: best.height || 0,
        score: bestScore,
        raw: !isWatermarked(url),
        watermarked: isWatermarked(url),
        source: best.source || "",
      };
    }

    function remember(vid, best, messageId) {
      if (!vid || !best || !best.url) return;
      const current = window.__dolaCliVideoUrlDb.get(vid);
      if (current && (current.score || 0) >= (best.score || 0)) {
        if (messageId) window.__dolaCliVideoByMessage.set(String(messageId), vid);
        return;
      }
      window.__dolaCliVideoUrlDb.set(vid, best);
      if (messageId) window.__dolaCliVideoByMessage.set(String(messageId), vid);
      const record = {
        url: best.url,
        key: vid,
        vid,
        message_id: messageId || "",
        width: best.width || 0,
        height: best.height || 0,
        raw: Boolean(best.raw),
        watermarked: Boolean(best.watermarked),
        source: best.source || "play_info",
        score: best.score || 0,
      };
      const list = window.__dolaCliResolvedVideoRecords;
      const existing = list.findIndex(item => item.vid === vid || item.url === best.url);
      if (existing >= 0) list[existing] = record;
      else list.push(record);
    }

    function collectCandidatesFromPlayData(data) {
      const candidates = [];
      if (!data || typeof data !== "object") return candidates;
      const om = data.original_media_info;
      if (om && om.main_url) {
        candidates.push({
          key: "main_url",
          source: "original_media_info",
          url: decodeVideoUrl(om.main_url),
          width: om.width || (om.meta && om.meta.width) || 0,
          height: om.height || (om.meta && om.meta.height) || 0,
        });
      }
      candidates.push({ key: "no_watermark_url", source: "data", url: decodeVideoUrl(data.no_watermark_url), width: data.width, height: data.height });
      candidates.push({ key: "original_url", source: "data", url: decodeVideoUrl(data.original_url), width: data.width, height: data.height });
      const playInfos = Array.isArray(data.play_infos) ? data.play_infos.slice() : [];
      if (data.play_info) playInfos.push(data.play_info);
      for (const p of playInfos) {
        if (!p || typeof p !== "object") continue;
        candidates.push({ key: "main", source: "play_info", url: decodeVideoUrl(p.main), width: p.width, height: p.height });
        candidates.push({ key: "main_url", source: "play_info", url: decodeVideoUrl(p.main_url), width: p.width, height: p.height });
      }
      const videoList = data.video_list || (data.video_info && data.video_info.data && data.video_info.data.video_list);
      if (videoList && typeof videoList === "object") {
        for (const key of Object.keys(videoList)) {
          const v = videoList[key];
          if (!v || !v.main_url) continue;
          candidates.push({ key: "main_" + key, source: "video_list", url: decodeVideoUrl(v.main_url), width: v.vwidth || v.width, height: v.vheight || v.height });
          if (v.backup_url_1) {
            candidates.push({ key: "bk1_" + key, source: "video_list", url: decodeVideoUrl(v.backup_url_1), width: v.vwidth || v.width, height: v.vheight || v.height });
          }
        }
      }
      return candidates;
    }

    function resolveViaPlayInfo(vid) {
      if (!vid) return null;
      const cached = window.__dolaCliVideoUrlDb.get(vid);
      if (cached && cached.url && cached.url.indexOf("http") === 0 && !cached.watermarked) return cached;
      const aid = location.hostname.indexOf("dola.com") !== -1 ? ${JSON.stringify(DOLA_MEDIA_AID)} : "497858";
      try {
        const xhr = new XMLHttpRequest();
        const uuid = "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
          const r = Math.random() * 16 | 0;
          return (c === "x" ? r : (r & 0x3 | 0x8)).toString(16);
        });
        xhr.open(
          "POST",
          location.origin + "/samantha/media/get_play_info?aid=" + aid
            + "&device_platform=web&samantha_web=1&use-olympus-account=1&version_code=20800&pkg_type=release_version&web_tab_id=" + uuid,
          false
        );
        xhr.setRequestHeader("accept", "application/json");
        xhr.setRequestHeader("content-type", "application/json");
        xhr.setRequestHeader("origin", location.origin);
        xhr.setRequestHeader("referer", location.href);
        xhr.send(JSON.stringify({ key: vid, type: "video" }));
        if (xhr.status !== 200) return cached || null;
        const j = JSON.parse(xhr.responseText);
        if (!(j && j.code === 0 && j.data)) return cached || null;
        const best = chooseBest(collectCandidatesFromPlayData(j.data));
        if (best && best.url) {
          remember(vid, best);
          return best;
        }
      } catch {}
      return cached || null;
    }

    function extractVid(value) {
      if (!value) return "";
      if (typeof value === "string") {
        const m = value.match(/\\b(v0[a-zA-Z0-9_-]{6,})\\b/);
        return m ? m[1] : "";
      }
      if (typeof value === "object") {
        return String(value.vid || value.video_id || value.key || value.media_id || "").trim();
      }
      return "";
    }

    function harvestNode(node, messageId) {
      if (!node || typeof node !== "object") return;
      const mid = String(node.message_id || node.messageId || messageId || "").trim();
      const video = node.video || node.video_info || null;
      const vid = extractVid(node.vid || node.video_id || (video && (video.vid || video.video_id)) || node.key);
      if (vid && mid) window.__dolaCliVideoByMessage.set(mid, vid);
      if (video && video.video_model) {
        const modelVid = extractVid(video.vid || vid);
        if (modelVid) {
          const candidates = collectCandidatesFromPlayData(video.video_model);
          if (video.video_model.main_url) candidates.push({ key: "model_main", source: "video_model", url: decodeVideoUrl(video.video_model.main_url), width: video.video_model.width, height: video.video_model.height });
          if (video.video_model.no_watermark_url) candidates.push({ key: "model_no_wm", source: "video_model", url: decodeVideoUrl(video.video_model.no_watermark_url), width: video.video_model.width, height: video.video_model.height });
          const best = chooseBest(candidates);
          if (best) remember(modelVid, best, mid);
        }
      }
      if (node.no_watermark_url || node.original_url || node.original_media_info) {
        const best = chooseBest(collectCandidatesFromPlayData(node));
        if (best && vid) remember(vid, best, mid);
      }
      if (Array.isArray(node)) {
        for (const item of node) harvestNode(item, mid);
        return;
      }
      for (const value of Object.values(node)) {
        if (value && typeof value === "object") harvestNode(value, mid);
      }
    }

    function harvestText(text) {
      if (!text || typeof text !== "string") return;
      if (!/video|vid|no_watermark|play_info|rc_gen_video|creation/i.test(text)) return;
      for (const block of text.split(/\\r?\\n\\r?\\n/)) {
        const dataLines = block.split(/\\r?\\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trim());
        const candidates = dataLines.length ? dataLines : [block.trim()];
        for (const raw of candidates) {
          if (!raw || raw === "[DONE]" || raw[0] !== "{") continue;
          try { harvestNode(JSON.parse(raw)); } catch {}
        }
      }
      if (text.trim()[0] === "{") {
        try { harvestNode(JSON.parse(text)); } catch {}
      }
    }

    // Hook JSON.parse once to harvest streaming chat payloads (vid + no_watermark fields).
    if (!window.__dolaCliVideoHarvestParse) {
      const originalParse = JSON.parse;
      JSON.parse = function dolaCliVideoParse(text, reviver) {
        const data = originalParse.call(this, text, reviver);
        try {
          if (typeof text === "string" && /video|vid|no_watermark|play_info|creation/i.test(text)) harvestNode(data);
        } catch {}
        return data;
      };
      window.__dolaCliVideoHarvestParse = true;
    }

    // Expose helpers so one-time XHR hooks always call the latest implementations.
    window.__dolaCliVideoChooseBest = chooseBest;
    window.__dolaCliVideoRemember = remember;
    window.__dolaCliVideoCollectPlayCandidates = collectCandidatesFromPlayData;
    window.__dolaCliVideoExtractVid = extractVid;

    // Hook XHR responses for get_play_info.
    if (!window.__dolaCliVideoHarvestXhr) {
      const proto = XMLHttpRequest.prototype;
      const originalOpen = proto.open;
      const originalSend = proto.send;
      proto.open = function (method, url) {
        this.__dolaCliPlayInfo = /get_play_info/i.test(String(url || ""));
        return originalOpen.apply(this, arguments);
      };
      proto.send = function () {
        if (this.__dolaCliPlayInfo) {
          this.addEventListener("load", function () {
            try {
              const j = JSON.parse(this.responseText);
              const pickBest = window.__dolaCliVideoChooseBest;
              const save = window.__dolaCliVideoRemember;
              const collect = window.__dolaCliVideoCollectPlayCandidates;
              const pickVid = window.__dolaCliVideoExtractVid;
              if (!pickBest || !save || !collect) return;
              const vid = j && j.data && (j.data.vid || j.data.key);
              const best = j && j.code === 0 ? pickBest(collect(j.data)) : null;
              if (best && (vid || best.url)) save(String(vid || pickVid(best.url) || ""), best);
            } catch {}
          });
        }
        return originalSend.apply(this, arguments);
      };
      window.__dolaCliVideoHarvestXhr = true;
    }

    window.__dolaCliResolveVideoUrl = function (vid) {
      return resolveViaPlayInfo(vid);
    };

    window.__dolaCliCollectResolvedVideos = function () {
      const out = [];
      const seen = new Set();
      const push = (item) => {
        if (!item || !item.url || typeof item.url !== "string" || item.url.indexOf("http") !== 0) return;
        const clean = makeNoWatermarkUrl(item.url);
        if (!clean || seen.has(clean)) return;
        seen.add(clean);
        const watermarked = item.watermarked != null ? Boolean(item.watermarked) : isWatermarked(clean);
        out.push({
          url: clean,
          key: item.key || item.vid || "",
          vid: item.vid || "",
          message_id: item.message_id || "",
          width: item.width || 0,
          height: item.height || 0,
          raw: !watermarked,
          watermarked,
          source: item.source || "",
          score: item.score || 0,
        });
      };

      // 1) Already resolved no-watermark records (JSON harvest + prior play_info).
      for (const item of window.__dolaCliResolvedVideoRecords.slice()) push(item);

      // 2) Resolve every visible player / message video id through get_play_info.
      const containers = Array.from(document.querySelectorAll(
        '[class*="block-video"], [class*="video-block"], [class*="VideoBlock"], [class*="video-container"], [data-message-id], video'
      ));
      for (const node of containers) {
        const video = node.tagName === "VIDEO" ? node : node.querySelector("video");
        const root = (node.closest && node.closest("[data-message-id]")) || (video && video.closest("[data-message-id]")) || null;
        const mid = root ? (root.getAttribute("data-message-id") || "") : "";
        let vid = mid ? (window.__dolaCliVideoByMessage.get(String(mid)) || "") : "";
        const src = video ? (video.currentSrc || video.src || "") : "";
        if (!vid && src) {
          const m = src.match(/\\/(v0[a-zA-Z0-9_-]+)/) || src.match(/\\b(v0[a-zA-Z0-9_-]{6,})\\b/);
          if (m) vid = m[1];
        }
        if (!vid && mid) {
          // Some cards expose vid-like ids in attributes/html.
          const html = (root && root.innerHTML) || "";
          const m = html.match(/\\b(v0[a-zA-Z0-9_-]{6,})\\b/);
          if (m) vid = m[1];
        }
        if (vid) {
          const resolved = resolveViaPlayInfo(vid);
          if (resolved && resolved.url) {
            push({
              url: resolved.url,
              key: vid,
              vid,
              message_id: mid,
              width: resolved.width,
              height: resolved.height,
              raw: resolved.raw,
              watermarked: resolved.watermarked,
              source: resolved.source || "play_info",
              score: resolved.score || 0,
            });
            continue;
          }
        }
        // 3) Last resort: page preview src — marked watermarked unless URL itself looks clean.
        if (src && src.indexOf("http") === 0 && !src.startsWith("blob:")) {
          const clean = makeNoWatermarkUrl(src);
          const watermarked = isWatermarked(clean);
          push({
            url: clean,
            key: vid || "",
            vid: vid || "",
            message_id: mid,
            width: video.videoWidth || 0,
            height: video.videoHeight || 0,
            raw: !watermarked,
            watermarked,
            source: "dom-preview",
            score: watermarked ? -50 : 10,
          });
        }
      }

      // 4) Network image-hook records that look like video files.
      for (const item of (window.__dolaCliImageRecords || [])) {
        if (!(item && item.url && /\\.(mp4|webm|mov)(\\?|$)|rc_gen_video|video/i.test(item.url))) continue;
        const clean = makeNoWatermarkUrl(item.url);
        const watermarked = item.watermarked != null ? Boolean(item.watermarked) : isWatermarked(clean);
        push({
          url: clean,
          key: item.key || "",
          message_id: item.message_id || "",
          width: item.width || 0,
          height: item.height || 0,
          raw: !watermarked && Boolean(item.raw),
          watermarked,
          source: "network-hook",
          score: watermarked ? -40 : 20,
        });
      }

      out.sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0) || (Number(b.raw) - Number(a.raw)));
      return out;
    };

    window.__dolaCliVideoResolveInstalled = true;
    return true;
  })()`);
}

export async function collectDomVideos(client) {
  await installVideoResolveHelpers(client);
  const resolved = await evaluate(client, `(() => {
    try { return window.__dolaCliCollectResolvedVideos ? window.__dolaCliCollectResolvedVideos() : []; }
    catch (error) { return { error: String(error && error.message || error) }; }
  })()`).catch(() => []);
  if (resolved && resolved.error) {
    console.log(`[dola-cli] video resolve helpers failed: ${resolved.error}`);
  }
  const list = Array.isArray(resolved) ? resolved : [];
  if (list.length) {
    const mapped = list
      .filter(item => item?.url && (isLikelyVideoUrl(item.url) || /^https?:\/\//i.test(item.url)))
      .map(item => {
        const url = item.url;
        const watermarked = item.watermarked != null ? Boolean(item.watermarked) : isWatermarkedUrl(url);
        const raw = !watermarked && (item.raw != null ? Boolean(item.raw) : isPreferredVideoUrl(url));
        return {
          url,
          key: imageKeyFromUrl(item.key || item.vid || item.url),
          message_id: item.message_id || "",
          raw,
          watermarked,
          width: item.width,
          height: item.height,
          vid: item.vid || "",
          source: item.source || "",
          score: item.score || 0,
        };
      });
    const clean = mapped.filter(item => !item.watermarked);
    if (clean.length) {
      console.log(`[dola-cli] resolved ${clean.length} no-watermark video URL(s)` + (mapped.length > clean.length ? ` (skipped ${mapped.length - clean.length} watermarked/preview)` : ""));
      return uniqueImageRecords(clean);
    }
    console.log(`[dola-cli] only watermarked/preview video URL(s) available (${mapped.length}); waiting for play_info no-watermark`);
    return uniqueImageRecords(mapped);
  }
  const urls = await evaluate(client, `Array.from(document.querySelectorAll("video, video source"))
    .map(el => el.currentSrc || el.src || el.getAttribute("src") || "")
    .filter(Boolean)`).catch(() => []);
  return (urls || []).filter(isLikelyVideoUrl).map(url => ({
    url,
    key: imageKeyFromUrl(url),
    raw: isPreferredVideoUrl(url),
    watermarked: isWatermarkedUrl(url) || !isPreferredVideoUrl(url),
    source: "dom-preview",
  }));
}
