// Reseller-aligned /chat/completion patch (ability_type=17).
// Injected into WebView page before submit.
(() => {
  const TARGET_DURATION = window.__dolaVideoDuration || 15;
  const TARGET_MODEL = window.__dolaVideoModel || (TARGET_DURATION >= 15 ? "seedance_v2.0" : "");
  const TARGET_RATIO = window.__dolaVideoRatio || "";
  const ABILITY_TYPE = 17;
  const MARK = "__dolaCliVideoPatch";

  function isCompletionUrl(input) {
    const raw = typeof input === "string" ? input : (input && (input.url || input.href)) || String(input || "");
    try {
      const url = new URL(raw, location.href);
      return /(^|\.)dola\.com$/i.test(url.hostname) && url.pathname === "/chat/completion";
    } catch {
      return /\/chat\/completion(?:\?|$)/.test(raw);
    }
  }

  function applyParam(param) {
    if (!param || typeof param !== "object") return false;
    if (TARGET_MODEL) param.model = TARGET_MODEL;
    param.duration = TARGET_DURATION;
    if (TARGET_RATIO) {
      param.ratio = TARGET_RATIO;
      if ("aspect_ratio" in param) param.aspect_ratio = TARGET_RATIO;
      if ("video_ratio" in param) param.video_ratio = TARGET_RATIO;
    }
    return true;
  }

  function patchDuration(obj, depth) {
    depth = depth || 0;
    if (depth > 20 || obj == null || typeof obj !== "object") return false;
    let changed = false;
    if (Array.isArray(obj)) {
      for (let i = 0; i < obj.length; i++) if (patchDuration(obj[i], depth + 1)) changed = true;
      return changed;
    }
    if (obj.chat_ability && Number(obj.chat_ability.ability_type) === ABILITY_TYPE) {
      const ability = obj.chat_ability;
      if (typeof ability.ability_param === "string") {
        try {
          const param = JSON.parse(ability.ability_param);
          if (applyParam(param)) {
            ability.ability_param = JSON.stringify(param);
            changed = true;
          }
        } catch (e) {}
      } else if (ability.ability_param && typeof ability.ability_param === "object") {
        if (applyParam(ability.ability_param)) changed = true;
      }
    }
    if (Object.prototype.hasOwnProperty.call(obj, "duration") && typeof obj.duration === "number" && obj.duration > 0 && obj.duration <= 60) {
      if (obj.duration !== TARGET_DURATION) {
        obj.duration = TARGET_DURATION;
        changed = true;
      }
      if (TARGET_MODEL && typeof obj.model === "string" && obj.model && obj.model !== TARGET_MODEL) {
        obj.model = TARGET_MODEL;
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
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return { changed: false, body: rawBody };
    }
    if (patchDuration(payload)) {
      window.__dolaCliLastVideoPatch = {
        at: Date.now(),
        duration: TARGET_DURATION,
        model: TARGET_MODEL || null,
        ratio: TARGET_RATIO || null,
      };
      return { changed: true, body: JSON.stringify(payload) };
    }
    return { changed: false, body: rawBody };
  }

  function patchFetch() {
    const currentFetch = window.fetch;
    if (!currentFetch || typeof currentFetch !== "function") return;
    const originalFetch = currentFetch.__dolaCliOriginalFetch || currentFetch;
    function patchedFetch(input, init) {
      try {
        if (!isCompletionUrl(input)) return originalFetch.apply(this, arguments);
        if (init && Object.prototype.hasOwnProperty.call(init, "body")) {
          const patched = patchBody(init.body);
          if (patched.changed) return originalFetch.call(this, input, Object.assign({}, init, { body: patched.body }));
        }
        if (window.Request && input instanceof window.Request && String(input.method || "").toUpperCase() === "POST") {
          return input
            .clone()
            .text()
            .then((text) => {
              const patched = patchBody(text);
              if (patched.changed) return originalFetch.call(this, new window.Request(input, { body: patched.body }), init);
              return originalFetch.call(this, input, init);
            });
        }
      } catch (e) {}
      return originalFetch.apply(this, arguments);
    }
    patchedFetch.__dolaCliVideoPatch = true;
    patchedFetch.__dolaCliOriginalFetch = originalFetch;
    window.fetch = patchedFetch;
  }

  function patchXhr() {
    const proto = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
    if (!proto || proto.__dolaCliVideoOpen) return;
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
      } catch (e) {}
      return originalSend.apply(this, arguments);
    };
    proto.__dolaCliVideoOpen = true;
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
  return window[MARK];
})();
