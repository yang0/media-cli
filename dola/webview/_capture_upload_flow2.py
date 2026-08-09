"""Capture Dola image-upload protocol via logged-in WebView + XHR/fetch hooks."""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

import webview

from free_protocol.registry import AccountRegistry
from video_flow import (
    JS_CLICK_VIDEO,
    js_attach_files_b64,
    js_eval,
    load_ref_files_b64,
)

CAPTURE_JS = r"""
(() => {
  if (window.__dolaUploadCaptureInstalled) {
    return { ok: true, reused: true, count: (window.__dolaUploadHits||[]).length };
  }
  window.__dolaUploadHits = [];
  window.__dolaUploadCaptureInstalled = true;
  const push = (row) => {
    try {
      window.__dolaUploadHits.push(row);
      if (window.__dolaUploadHits.length > 300) window.__dolaUploadHits.shift();
    } catch (e) {}
  };
  const interesting = (url) => /upload|image|file|alice|samantha|resource|imagex|tos|apply|attachment|media|cloud|blob/i.test(String(url||''));
  const previewBody = (body) => {
    try {
      if (!body) return '';
      if (typeof body === 'string') return body.slice(0, 800);
      if (body instanceof FormData) return 'FormData:' + Array.from(body.keys()).join(',');
      if (body instanceof Blob) return 'Blob:' + body.size + ':' + (body.type||'');
      if (body instanceof ArrayBuffer) return 'ArrayBuffer:' + body.byteLength;
      return Object.prototype.toString.call(body);
    } catch (e) { return ''; }
  };
  const origFetch = window.fetch;
  window.fetch = async function(input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const method = (init && init.method) || (input && input.method) || 'GET';
    const bodyPreview = previewBody(init && init.body);
    const p = origFetch.apply(this, arguments);
    if (interesting(url) || interesting(bodyPreview)) {
      p.then(async (resp) => {
        let text = '';
        try { text = (await resp.clone().text()).slice(0, 4000); } catch (e) {}
        push({ t: Date.now(), kind: 'fetch', url, method, status: resp.status, bodyPreview, response: text, ctype: resp.headers.get('content-type')||'' });
      }).catch((e) => push({ t: Date.now(), kind: 'fetch-err', url, method, error: String(e) }));
    }
    return p;
  };
  const XO = XMLHttpRequest.prototype.open;
  const XS = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(method, url) {
    this.__dola_m = method; this.__dola_u = url;
    return XO.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function(body) {
    const url = this.__dola_u || '';
    const method = this.__dola_m || 'GET';
    const bodyPreview = previewBody(body);
    if (interesting(url) || interesting(bodyPreview)) {
      this.addEventListener('loadend', () => {
        push({ t: Date.now(), kind: 'xhr', url, method, status: this.status, bodyPreview, response: String(this.responseText||'').slice(0, 4000), ctype: this.getResponseHeader('content-type')||'' });
      });
    }
    return XS.apply(this, arguments);
  };
  return { ok: true, installed: true };
})()
"""

PROBE_DOM_JS = r"""
(() => {
  const text = el => String(el && (el.innerText || el.textContent || el.getAttribute('aria-label') || el.title) || '').replace(/\s+/g,' ').trim();
  const visible = el => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
  };
  const inputs = Array.from(document.querySelectorAll('input[type=file]')).map(el => ({
    accept: el.accept || '',
    multiple: !!el.multiple,
    visible: visible(el),
    cls: el.className || '',
  }));
  const labels = Array.from(document.querySelectorAll('button, [role=button], [role=tab]'))
    .filter(visible)
    .map(text)
    .filter(t => t && t.length <= 24)
    .slice(0, 40);
  return {
    href: location.href,
    title: document.title,
    fileInputs: inputs,
    labels,
    readyState: document.readyState,
  };
})()
"""


def main() -> int:
    image = Path(sys.argv[1] if len(sys.argv) > 1 else r"E:\temp\avatar.webp")
    account = sys.argv[2] if len(sys.argv) > 2 else "AdoraCrosbytvzs5"
    if not image.is_file():
        print(json.dumps({"error": f"missing image: {image}"}))
        return 2

    registry = AccountRegistry()
    rec = registry.load(account)
    print(f"[capture2] account={rec.accountId} session={rec.hasSession} image={image}")
    storage = Path(rec.profilePath)
    out_path = ROOT / "_upload_probe" / "capture_hits2.json"
    box: dict = {}

    def after_start():
        w = webview.windows[0]
        # wait for SPA
        for i in range(60):
            try:
                dom = js_eval(w, PROBE_DOM_JS) or {}
            except Exception as exc:
                print(f"[capture2] wait {i}: {exc}")
                time.sleep(1)
                continue
            print(f"[capture2] wait {i}: href={dom.get('href')} files={len(dom.get('fileInputs') or [])} labels={dom.get('labels')}")
            if "dola.com" in str(dom.get("href") or "") and dom.get("readyState") == "complete":
                if i >= 3:
                    break
            time.sleep(1)
        time.sleep(2)
        box["install"] = js_eval(w, CAPTURE_JS)
        print("[capture2] install", box["install"])
        box["dom_before"] = js_eval(w, PROBE_DOM_JS)
        print("[capture2] dom_before", json.dumps(box["dom_before"], ensure_ascii=False)[:1000])
        box["video"] = js_eval(w, JS_CLICK_VIDEO)
        print("[capture2] video", box["video"])
        time.sleep(2.5)
        box["dom_video"] = js_eval(w, PROBE_DOM_JS)
        print("[capture2] dom_video", json.dumps(box["dom_video"], ensure_ascii=False)[:1200])
        files = load_ref_files_b64([str(image)])
        box["attach"] = js_eval(w, js_attach_files_b64(files))
        print("[capture2] attach", box["attach"])
        for i in range(25):
            time.sleep(1)
            hits = js_eval(w, "window.__dolaUploadHits || []") or []
            box["hits"] = hits
            print(f"[capture2] hits={len(hits)} t+{i+1}s")
            if hits:
                for h in hits[-3:]:
                    print("  ", h.get("kind"), h.get("status"), str(h.get("url") or "")[:120])
        out_path.parent.mkdir(exist_ok=True)
        out_path.write_text(json.dumps(box, ensure_ascii=False, indent=2), encoding="utf-8")
        print("[capture2] wrote", out_path)
        try:
            w.destroy()
        except Exception:
            pass

    webview.create_window(
        f"upload-capture2:{rec.accountId}",
        "https://www.dola.com/chat",
        width=1280,
        height=900,
    )
    webview.start(
        after_start,
        gui="edgechromium",
        debug=False,
        private_mode=False,
        storage_path=str(storage),
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
