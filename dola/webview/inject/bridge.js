/**
 * Bridge original reseller inject scripts to pywebview host.
 *
 * CRITICAL: Do not replace chrome.webview.postMessage. pywebview uses that
 * native function for its own RPC protocol. Wrapping it makes business messages
 * recursively re-enter pywebview as ["on_message", ...] and eventually crashes
 * the renderer.
 *
 * Strategy:
 *  - All host messages go into window.__dolaMsgQueue
 *  - Python pulls this queue with evaluate_js from its GUI callback
 *  - The native WebView2 / pywebview bridge is left completely untouched
 */
(function () {
  if (window.__dolaBridgeLoaded) return;
  window.__dolaBridgeLoaded = true;

  window.__dolaMsgQueue = window.__dolaMsgQueue || [];
  function enqueue(payload) {
    try {
      // These are snapshots, not commands. Keeping only the newest pending
      // snapshot prevents generation-time DOM churn from filling the queue.
      var type = payload && typeof payload === "object" && payload.type;
      if (type === "videoUrlUpdate" || type === "imageDataExtracted") {
        for (var i = window.__dolaMsgQueue.length - 1; i >= 0; i--) {
          var queued = window.__dolaMsgQueue[i];
          if (queued && typeof queued === "object" && queued.type === type) {
            window.__dolaMsgQueue[i] = payload;
            return;
          }
        }
      }
      window.__dolaMsgQueue.push(payload);
      if (window.__dolaMsgQueue.length > 100) {
        window.__dolaMsgQueue.splice(0, window.__dolaMsgQueue.length - 100);
      }
    } catch (e) {}
  }

  function toHost(payload) {
    enqueue(payload);
  }

  window.__dolaToHost = toHost;
  window.__dolaPostMessage = toHost;

  function showBadge() {
    if (document.getElementById("__dola_inject_badge")) return;
    if (!document.body && !document.documentElement) return;
    var el = document.createElement("div");
    el.id = "__dola_inject_badge";
    el.textContent = "Dola注入壳 · 15s+无水印";
    el.style.cssText =
      "position:fixed;top:10px;left:50%;transform:translateX(-50%);z-index:2147483646;" +
      "background:rgba(16,185,129,0.92);color:#fff;padding:6px 14px;border-radius:999px;" +
      "font:12px/1.2 -apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC',sans-serif;" +
      "box-shadow:0 4px 14px rgba(0,0,0,.18);pointer-events:none;opacity:.95";
    (document.body || document.documentElement).appendChild(el);
    setTimeout(function () {
      if (el && el.parentNode) el.parentNode.removeChild(el);
    }, 4500);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
      setTimeout(showBadge, 0);
    });
  } else {
    setTimeout(showBadge, 0);
  }

  // Single ready log — only once per load
  enqueue({ type: "log", msg: "bridge ready href=" + (location && location.href) });
  console.log("[dola-bridge] ready");
})();
