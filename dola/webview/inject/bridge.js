/**
 * Bridge original reseller inject scripts to pywebview host.
 * Original scripts call: window.chrome.webview.postMessage({type, url, filename, ...})
 * We also route to window.pywebview.api when available.
 */
(function () {
  if (window.__dolaBridgeLoaded) return;
  window.__dolaBridgeLoaded = true;

  function toHost(payload) {
    try {
      if (window.pywebview && window.pywebview.api && typeof window.pywebview.api.on_message === "function") {
        // pywebview may require string or plain object depending on version
        window.pywebview.api.on_message(typeof payload === "string" ? payload : JSON.stringify(payload));
      }
    } catch (e) {
      console.warn("[dola-bridge] pywebview.api failed", e);
    }
    try {
      if (window.chrome && window.chrome.webview && typeof window.chrome.webview.postMessage === "function") {
        window.chrome.webview.postMessage(payload);
      }
    } catch (e2) {}
  }

  // Ensure chrome.webview exists for original scripts
  if (!window.chrome) window.chrome = {};
  if (!window.chrome.webview) {
    window.chrome.webview = {
      postMessage: function (data) {
        toHost(data);
      },
    };
  } else {
    var orig = window.chrome.webview.postMessage.bind(window.chrome.webview);
    window.chrome.webview.postMessage = function (data) {
      toHost(data);
      try {
        return orig(data);
      } catch (e) {}
    };
  }

  // Status badge so user sees inject is active
  function showBadge() {
    if (document.getElementById("__dola_inject_badge")) return;
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
    document.addEventListener("DOMContentLoaded", showBadge);
  } else {
    showBadge();
  }

  console.log("[dola-bridge] ready");
})();
