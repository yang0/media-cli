import { evaluate } from '../cdp.js';
import { DEFAULT_VIDEO_DURATION, VIDEO_ABILITY_TYPE, VIDEO_MODEL_SEEDANCE_V2 } from '../config.js';

export function resolveVideoGenConfig(options = {}) {
  const durationSeconds = Number(options.durationSeconds ?? options.duration ?? DEFAULT_VIDEO_DURATION);
  const duration = Number.isFinite(durationSeconds) && durationSeconds > 0
    ? Math.round(durationSeconds)
    : Number(DEFAULT_VIDEO_DURATION);
  let model = options.model ? String(options.model).trim() : "";
  // Same as reseller tool: 15s requires seedance_v2.0 on ability_type=17.
  if (!model && duration >= 15) model = VIDEO_MODEL_SEEDANCE_V2;
  const aspectRatio = options.aspectRatio ? String(options.aspectRatio).trim().replace("/", ":") : "";
  return {
    duration,
    model,
    aspectRatio,
    /** Always patch completion body when generating video so duration/model stick. */
    patchCompletion: true,
  };
}

export function buildVideoCompletionPatchScript(config) {
  const duration = Number(config.duration) || 5;
  const model = String(config.model || "");
  const aspectRatio = String(config.aspectRatio || "");
  const abilityType = VIDEO_ABILITY_TYPE;
  // Injected into the Dola page. Keep it self-contained (no outer closures).
  // Mirrors _extracted/dola_fifteen_seconds.js: patch ability_type=17 ability_param.
  return `(() => {
    const TARGET_DURATION = ${JSON.stringify(duration)};
    const TARGET_MODEL = ${JSON.stringify(model)};
    const TARGET_RATIO = ${JSON.stringify(aspectRatio)};
    const ABILITY_TYPE = ${JSON.stringify(abilityType)};
    const MARK = "__dolaCliVideoPatch";
    if (window[MARK]
      && window[MARK].duration === TARGET_DURATION
      && window[MARK].model === TARGET_MODEL
      && window[MARK].aspectRatio === TARGET_RATIO) {
      return { ok: true, reused: true, ...window[MARK] };
    }

    function isCompletionUrl(input) {
      const raw = typeof input === "string" ? input : (input && (input.url || input.href)) || String(input || "");
      try {
        const url = new URL(raw, location.href);
        return /(^|\\.)dola\\.com$/i.test(url.hostname) && url.pathname === "/chat/completion";
      } catch {
        return /\\/chat\\/completion(?:\\?|$)/.test(raw);
      }
    }

    function patchDuration(obj, depth) {
      depth = depth || 0;
      if (depth > 20 || obj == null || typeof obj !== "object") return false;
      let changed = false;
      if (Array.isArray(obj)) {
        for (let i = 0; i < obj.length; i += 1) {
          if (patchDuration(obj[i], depth + 1)) changed = true;
        }
        return changed;
      }
      if (obj.chat_ability && Number(obj.chat_ability.ability_type) === ABILITY_TYPE) {
        const ability = obj.chat_ability;
        const applyParam = param => {
          if (!param || typeof param !== "object") return false;
          if (TARGET_MODEL) param.model = TARGET_MODEL;
          param.duration = TARGET_DURATION;
          // Common ratio field names used by dola video ability.
          if (TARGET_RATIO) {
            if ("ratio" in param || !("aspect_ratio" in param)) param.ratio = TARGET_RATIO;
            if ("aspect_ratio" in param) param.aspect_ratio = TARGET_RATIO;
            if ("video_ratio" in param) param.video_ratio = TARGET_RATIO;
            if (!("ratio" in param) && !("aspect_ratio" in param) && !("video_ratio" in param)) {
              param.ratio = TARGET_RATIO;
            }
          }
          return true;
        };
        if (typeof ability.ability_param === "string") {
          try {
            const param = JSON.parse(ability.ability_param);
            if (applyParam(param)) {
              ability.ability_param = JSON.stringify(param);
              changed = true;
            }
          } catch {}
        } else if (ability.ability_param && typeof ability.ability_param === "object") {
          if (applyParam(ability.ability_param)) changed = true;
        }
      }
      // Also handle nested / alternate field shapes seen in some clients.
      if (Object.prototype.hasOwnProperty.call(obj, "duration") && typeof obj.duration === "number" && obj.duration > 0 && obj.duration <= 60) {
        if (obj.duration !== TARGET_DURATION) {
          obj.duration = TARGET_DURATION;
          changed = true;
        }
        if (TARGET_MODEL && typeof obj.model === "string" && obj.model && obj.model !== TARGET_MODEL) {
          obj.model = TARGET_MODEL;
          changed = true;
        }
        if (TARGET_RATIO && typeof obj.ratio === "string" && obj.ratio !== TARGET_RATIO) {
          obj.ratio = TARGET_RATIO;
          changed = true;
        }
      }
      for (const key of Object.keys(obj)) {
        if (key === "chat_ability") continue;
        if (patchDuration(obj[key], depth + 1)) changed = true;
      }
      return changed;
    }

    function patchBody(rawBody) {
      if (typeof rawBody !== "string" || !rawBody.trim()) return { changed: false, body: rawBody };
      let payload;
      try { payload = JSON.parse(rawBody); } catch { return { changed: false, body: rawBody }; }
      if (patchDuration(payload)) {
        window.__dolaCliLastVideoPatch = {
          at: Date.now(),
          duration: TARGET_DURATION,
          model: TARGET_MODEL || null,
          aspectRatio: TARGET_RATIO || null,
        };
        return { changed: true, body: JSON.stringify(payload) };
      }
      return { changed: false, body: rawBody };
    }

    function patchFetch() {
      const currentFetch = window.fetch;
      if (!currentFetch || typeof currentFetch !== "function") return;
      if (currentFetch.__dolaCliVideoPatch) {
        // Re-wrap so the latest duration/model always apply.
      }
      const originalFetch = currentFetch.__dolaCliOriginalFetch || currentFetch;
      function patchedFetch(input, init) {
        try {
          if (!isCompletionUrl(input)) return originalFetch.apply(this, arguments);
          if (init && Object.prototype.hasOwnProperty.call(init, "body")) {
            const patched = patchBody(init.body);
            if (patched.changed) return originalFetch.call(this, input, Object.assign({}, init, { body: patched.body }));
            return originalFetch.apply(this, arguments);
          }
          if (window.Request && input instanceof window.Request && String(input.method || "").toUpperCase() === "POST") {
            return input.clone().text().then(text => {
              const patched = patchBody(text);
              if (patched.changed) return originalFetch.call(this, new window.Request(input, { body: patched.body }), init);
              return originalFetch.call(this, input, init);
            });
          }
        } catch {}
        return originalFetch.apply(this, arguments);
      }
      patchedFetch.__dolaCliVideoPatch = true;
      patchedFetch.__dolaCliOriginalFetch = originalFetch;
      window.fetch = patchedFetch;
    }

    function patchXhr() {
      const proto = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
      if (!proto) return;
      if (!proto.__dolaCliVideoOpen) {
        const originalOpen = proto.open;
        const originalSend = proto.send;
        proto.open = function (method, url) {
          this.__dolaCliVideoMethod = method;
          this.__dolaCliVideoUrl = url;
          return originalOpen.apply(this, arguments);
        };
        proto.send = function (body) {
          try {
            if (String(this.__dolaCliVideoMethod || "").toUpperCase() === "POST" && isCompletionUrl(this.__dolaCliVideoUrl)) {
              const patched = patchBody(body);
              if (patched.changed) return originalSend.call(this, patched.body);
            }
          } catch {}
          return originalSend.apply(this, arguments);
        };
        proto.__dolaCliVideoOpen = true;
      }
    }

    if (!window.__dolaCliVideoFetchGuard) {
      window.__dolaCliVideoFetchGuard = setInterval(() => {
        if (typeof window.fetch !== "function" || !window.fetch.__dolaCliVideoPatch) patchFetch();
      }, 1500);
    }

    patchFetch();
    patchXhr();
    window[MARK] = {
      duration: TARGET_DURATION,
      model: TARGET_MODEL,
      aspectRatio: TARGET_RATIO,
      abilityType: ABILITY_TYPE,
      at: Date.now(),
    };
    return { ok: true, reused: false, ...window[MARK] };
  })()`;
}

export async function installVideoRequestPatch(client, options = {}) {
  if (!options.videoGen) return null;
  const config = resolveVideoGenConfig(options);
  if (!config.patchCompletion) return null;
  const expression = buildVideoCompletionPatchScript(config);
  // Survive SPA navigations / soft reloads inside the chat shell.
  await client.send("Page.addScriptToEvaluateOnNewDocument", { source: expression }).catch(() => {});
  const result = await evaluate(client, expression).catch(error => ({ ok: false, error: error.message }));
  if (!result?.ok) {
    throw new Error(`Failed to install video completion patch: ${result?.error || "unknown error"}`);
  }
  console.log(
    `[dola-cli] video completion patch ready: duration=${config.duration}s`
    + (config.model ? ` model=${config.model}` : "")
    + (config.aspectRatio ? ` ratio=${config.aspectRatio}` : "")
    + (result.reused ? " (reused)" : "")
  );
  return config;
}
