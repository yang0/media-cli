import { evaluate } from '../cdp.js';
import { extractImageRecordsFromJson, imageKeyFromUrl, isLikelyImageUrl, isPreferredRawUrl, isWatermarkedUrl, uniqueImageRecords } from '../media/urls.js';

export async function installImageHook(client) {
  await evaluate(client, `(() => {
    if (window.__dolaCliImageHookInstalled) return true;
    window.__dolaCliImageHookInstalled = true;
    window.__dolaCliImageRecords = [];
    const originalParse = JSON.parse;
    const okUrl = url => {
      try {
        const parsed = new URL(url || "");
        if (!/^https?:$/i.test(parsed.protocol)) return false;
        if (/\\/(api|web|passport)\\//i.test(parsed.pathname)) return false;
         if (/\\.(png|jpe?g|webp|gif|mp4|webm|mov|m4v)(\\?|$)/i.test(url)) return true;
        return /dola|byteimg|bytedance|volc|tos|cdn|image|img/i.test(parsed.hostname)
           && /image|img|video|mp4|webm|tplv|tos-|obj\\/|origin|raw|large|webp|jpeg|jpg|png/i.test(parsed.pathname)
          && /x-expires|expires|sign|signature|format|image|img|tplv|raw|origin|width|height/i.test(parsed.search);
      } catch { return false; }
    };
    const isWatermarked = url => /watermark|downsize_watermark|image_dld_watermark|image_pre_watermark|hcg_watermark|img_pre_mark|wm_|with[_-]?water|marked|logo/i.test(url || "");
    const isRaw = url => /(image_raw|raw|origin|original|ori|source|large|no[_-]?watermark|without[_-]?watermark)/i.test(url || "") && !isWatermarked(url);
    const imageKey = url => {
       const match = /rc_gen_(?:image|video)\\/([a-f0-9]{16,64})(?:preview)?\\.(?:jpeg|jpg|png|webp|mp4|webm)/i.exec(String(url || ""))
         || /rc_gen_(?:image|video)\\/([^~?/#]+)(?:~|\\?|$)/i.exec(String(url || ""));
      if (!match) return "";
      const filename = match[1].includes(".") ? match[1] : match[1] + ".jpeg";
       return /rc_gen_video/i.test(url) ? "rc_gen_video/" + filename.replace(/preview\\.(mp4|webm)$/i, ".$1") : "rc_gen_image/" + filename.replace(/preview\\.(jpeg|jpg|png|webp)$/i, ".$1");
    };
    const push = (url, context = {}) => {
      if (!okUrl(url)) return;
      if (!window.__dolaCliImageRecords.some(item => item.url === url)) {
        window.__dolaCliImageRecords.push({ ...context, url, key: context.key || imageKey(url), raw: isRaw(url), watermarked: isWatermarked(url) });
      }
    };
    const visit = (node, context = {}) => {
      if (!node || typeof node !== "object") return;
      const next = {
        conversation_id: node.conversation_id || node.conversationId || context.conversation_id || "",
        message_id: node.message_id || node.messageId || node.id || context.message_id || "",
        key: node.key || context.key || "",
        prompt: node.prompt || node.query || node.input || context.prompt || "",
      };
      for (const [key, item] of Object.entries(node)) {
         if (/url|uri|src|image|video|origin|original|raw|large|watermark/i.test(key)) {
          if (typeof item === "string") push(item, next);
          else visit(item, next);
        } else if (typeof item === "object") {
          visit(item, next);
        }
      }
    };
    JSON.parse = function dolaCliParse(text, reviver) {
      const data = originalParse.call(this, text, reviver);
      try {
         if (typeof text === "string" && /image|img|video|url|raw|origin|watermark/i.test(text)) visit(data);
      } catch {}
      return data;
    };
    return true;
  })()`);
}

export async function clearImageHook(client) {
  await evaluate(client, `(() => { window.__dolaCliImageRecords = []; return true; })()`);
}

export async function collectHookImages(client) {
  const records = await evaluate(client, `window.__dolaCliImageRecords || []`).catch(() => []);
  return Array.isArray(records) ? uniqueImageRecords(records) : [];
}

export async function collectDomImages(client) {
  const urls = await evaluate(client, `(() => {
    const out = Array.from(document.querySelectorAll('img[alt="image"][data-track-key], video, video source[src]'))
      .filter(media => media.tagName === "VIDEO" || media.naturalWidth >= 256 && media.naturalHeight >= 256)
      .map(media => {
        const src = media.currentSrc || media.src || media.getAttribute("src") || "";
        const key = media.getAttribute("data-track-key") || "";
        const rawUrl = (() => {
          if (!key || !src) return "";
          const path = key.replace(/^\d+_\d+_/, "");
          if (!path) return "";
          try { return new URL(path, new URL(src).origin).href; } catch { return ""; }
        })();
        return {
          url: rawUrl || src,
          key: key,
           width: media.videoWidth || media.naturalWidth || 0,
           height: media.videoHeight || media.naturalHeight || 0,
        };
      });
    return out;
  })()`).catch(() => []);
  return uniqueImageRecords((urls || []).filter(item => isLikelyImageUrl(item.url)).map(item => ({
    url: item.url,
    key: imageKeyFromUrl(item.key || item.url),
    raw: isPreferredRawUrl(item.url),
    watermarked: isWatermarkedUrl(item.url),
    width: item.width,
    height: item.height,
  })));
}

export function installNetworkImageCapture(client, capturedRecords) {
  const requestBodies = new Map();
  client.on("Network.responseReceived", params => {
    const url = params.response?.url;
    const mime = params.response?.mimeType || "";
    if ((/^image\//i.test(mime) || /^video\//i.test(mime)) && isLikelyImageUrl(url)) {
      capturedRecords.push({ url, key: imageKeyFromUrl(url), raw: isPreferredRawUrl(url), watermarked: isWatermarkedUrl(url) });
    }
    if (/json|text|event-stream/i.test(mime)) requestBodies.set(params.requestId, true);
  });
  client.on("Network.loadingFinished", async params => {
    if (!requestBodies.has(params.requestId)) return;
    requestBodies.delete(params.requestId);
    try {
      const body = await client.send("Network.getResponseBody", { requestId: params.requestId });
      const text = body.base64Encoded
        ? Buffer.from(body.body || "", "base64").toString("utf8")
        : body.body || "";
      if (!/image|img|video|url|raw|origin|watermark/i.test(text)) return;
      for (const block of text.split(/\r?\n\r?\n/)) {
        const dataLines = block.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trim());
        const candidates = dataLines.length ? dataLines : [block.trim()];
        for (const raw of candidates) {
          if (!raw || raw === "[DONE]" || !raw.startsWith("{")) continue;
          try {
            capturedRecords.push(...extractImageRecordsFromJson(JSON.parse(raw)));
          } catch {}
        }
      }
      if (text.trim().startsWith("{")) {
        try {
          capturedRecords.push(...extractImageRecordsFromJson(JSON.parse(text)));
        } catch {}
      }
    } catch {}
  });
}

export async function imageDebugSnapshot(client) {
  return evaluate(client, `(() => {
    const visible = el => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    const rectOf = el => {
      const rect = el.getBoundingClientRect();
      return { x: rect.x, y: rect.y, w: rect.width, h: rect.height };
    };
    const nearbyText = el => {
      let cur = el;
      for (let i = 0; cur && i < 8; i += 1, cur = cur.parentElement) {
        const text = (cur.innerText || cur.textContent || "").trim();
        if (text) return text.slice(0, 300);
      }
      return "";
    };
    const ancestry = el => {
      const out = [];
      let cur = el;
      for (let i = 0; cur && i < 8; i += 1, cur = cur.parentElement) {
        out.push({
          tag: cur.tagName,
          id: cur.id || "",
          className: String(cur.className || "").slice(0, 160),
          attrs: Array.from(cur.attributes || []).filter(attr => /^data-|^aria-/.test(attr.name)).slice(0, 8).map(attr => [attr.name, attr.value]).slice(0, 8),
        });
      }
      return out;
    };
    return {
      url: location.href,
      textTail: (document.body.innerText || "").slice(-1000),
      generatedActions: Array.from(document.querySelectorAll('img[alt="image"][data-track-key]'))
        .flatMap(img => {
          const box = img.closest('[class*="image-box-grid-item"], [class*="container-"], [class*="image-wrapper"]')?.parentElement?.parentElement?.parentElement || img.parentElement;
          const buttons = Array.from((box || document).querySelectorAll("button, [role='button']"));
          return buttons.map(button => ({
            text: (button.innerText || button.textContent || button.getAttribute("aria-label") || button.title || "").trim(),
            aria: button.getAttribute("aria-label") || "",
            title: button.title || "",
            className: String(button.className || "").slice(0, 200),
            html: button.outerHTML.slice(0, 500),
            rect: rectOf(button),
          }));
        })
        .slice(0, 40),
      images: Array.from(document.querySelectorAll("img"))
        .map(img => ({
          visible: visible(img),
          src: img.currentSrc || img.src || "",
          alt: img.alt || "",
          natural: { w: img.naturalWidth, h: img.naturalHeight },
          rect: rectOf(img),
          nearbyText: nearbyText(img),
          ancestry: ancestry(img),
        }))
        .filter(item => item.src && !item.src.startsWith("data:image/svg+xml"))
        .slice(0, 120),
      videos: Array.from(document.querySelectorAll("video, video source, a[href]"))
        .map(el => ({
          tag: el.tagName,
          src: el.currentSrc || el.src || el.href || el.getAttribute("src") || "",
          text: (el.innerText || el.textContent || el.getAttribute("aria-label") || el.title || "").trim().slice(0, 180),
          visible: visible(el),
          rect: rectOf(el),
          ancestry: ancestry(el),
        }))
        .filter(item => item.src && (/video|mp4|webm|mov|download|涓嬭浇/i.test(item.src + " " + item.text)))
        .slice(0, 80),
      videoActions: Array.from(document.querySelectorAll('[class*="block-video"], [class*="video-hover"]'))
        .filter(visible)
        .map(box => ({
          text: (box.innerText || box.textContent || "").trim().slice(0, 300),
          html: box.outerHTML.slice(0, 1600),
          buttons: Array.from(box.querySelectorAll("button, [role='button'], a"))
            .map(el => ({ text: (el.innerText || el.textContent || el.getAttribute("aria-label") || el.title || "").trim(), aria: el.getAttribute("aria-label") || "", title: el.title || "", href: el.href || "" }))
            .slice(0, 20),
        }))
        .slice(-4),
      videoResources: performance.getEntriesByType("resource")
        .map(entry => entry.name)
        .filter(url => /video|\.mp4|\.webm|watermark|origin|raw|download/i.test(url))
        .slice(-120),
    };
  })()`);
}
