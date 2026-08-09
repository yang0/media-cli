"""Open logged-in WebView, attach a local image, capture upload network traffic.

Does NOT submit the chat message (avoid captcha). Prints captured requests.
"""
from __future__ import annotations

import base64
import json
import mimetypes
import sys
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

import webview  # noqa: E402

from free_protocol.registry import AccountRegistry  # noqa: E402

CAPTURE_JS = r"""
(() => {
  if (window.__dolaUploadCapture) return window.__dolaUploadCapture.dump();
  const hits = [];
  const push = (kind, info) => {
    try {
      hits.push({ t: Date.now(), kind, ...info });
      if (hits.length > 200) hits.shift();
    } catch (e) {}
  };
  const interesting = (url) => /upload|image|file|alice|samantha|resource|imagex|tos|apply|attachment|media/i.test(String(url||''));
  const origFetch = window.fetch;
  window.fetch = async function(input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const method = (init && init.method) || (input && input.method) || 'GET';
    let bodyPreview = '';
    try {
      if (init && init.body) {
        if (typeof init.body === 'string') bodyPreview = init.body.slice(0, 500);
        else if (init.body instanceof FormData) bodyPreview = 'FormData:' + Array.from(init.body.keys()).join(',');
        else bodyPreview = String(init.body).slice(0, 200);
      }
    } catch (e) {}
    const p = origFetch.apply(this, arguments);
    if (interesting(url)) {
      p.then(async (resp) => {
        let text = '';
        try { text = (await resp.clone().text()).slice(0, 2000); } catch (e) {}
        push('fetch', { url, method, status: resp.status, bodyPreview, response: text });
      }).catch((e) => push('fetch-err', { url, method, error: String(e) }));
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
    let bodyPreview = '';
    try {
      if (typeof body === 'string') bodyPreview = body.slice(0, 500);
      else if (body instanceof FormData) bodyPreview = 'FormData:' + Array.from(body.keys()).join(',');
      else if (body) bodyPreview = Object.prototype.toString.call(body);
    } catch (e) {}
    if (interesting(url)) {
      this.addEventListener('loadend', () => {
        push('xhr', { url, method, status: this.status, bodyPreview, response: String(this.responseText||'').slice(0, 2000) });
      });
    }
    return XS.apply(this, arguments);
  };
  window.__dolaUploadCapture = {
    dump() { return JSON.parse(JSON.stringify(hits)); },
    clear() { hits.length = 0; return true; }
  };
  return { ok: true, installed: true };
})()
"""

ATTACH_JS_TMPL = r"""
(() => {
  const files = __FILES__;
  const input = document.querySelector('input[type=file]');
  if (!input) return { ok: false, reason: 'file-input-missing' };
  const dt = new DataTransfer();
  for (const f of files) {
    const bin = atob(f.b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    const blob = new Blob([arr], { type: f.mime || 'image/png' });
    dt.items.add(new File([blob], f.name || 'ref.png', { type: f.mime || 'image/png' }));
  }
  input.files = dt.files;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return { ok: true, count: files.length, names: files.map(x => x.name) };
})()
"""

VIDEO_MODE_JS = r"""
(() => {
  const labels = ['视频生成', 'Create Video', 'Video Generation', 'Image to Video', 'Text to Video'];
  const nodes = Array.from(document.querySelectorAll('button, [role="button"], div, span'));
  for (const el of nodes) {
    const t = (el.innerText || el.textContent || '').trim();
    if (!t) continue;
    for (const lab of labels) {
      if (t === lab || t.includes(lab)) {
        el.click();
        return { ok: true, text: t.slice(0, 40) };
      }
    }
  }
  return { ok: false, reason: 'video-mode-missing' };
})()
"""


def load_file(path: Path) -> dict:
    raw = path.read_bytes()
    mime = mimetypes.guess_type(path.name)[0] or "image/webp"
    return {
        "name": path.name,
        "mime": mime,
        "b64": base64.b64encode(raw).decode("ascii"),
    }


def main() -> int:
    image = Path(sys.argv[1] if len(sys.argv) > 1 else r"E:\temp\avatar.webp")
    account = sys.argv[2] if len(sys.argv) > 2 else ""
    if not image.is_file():
        print(json.dumps({"error": f"missing image: {image}"}))
        return 2

    registry = AccountRegistry()
    rec = None
    if account:
        try:
            rec = registry.load(account)
        except Exception as exc:
            print(json.dumps({"error": f"load account failed: {exc}"}))
            return 2
    if rec is None:
        # pick first ready account with session
        for r in registry.list_accounts():
            proto = r.protocol
            ready = bool(proto and getattr(proto, "hasVideoAbility", False))
            if r.hasSession and ready:
                rec = r
                break
        if rec is None:
            for r in registry.list_accounts():
                if r.hasSession:
                    rec = r
                    break
    if rec is None:
        print(json.dumps({"error": "no account with session"}))
        return 2

    print(f"[capture] account={rec.accountId} image={image} size={image.stat().st_size}")
    profile = Path(rec.profilePath)
    storage = profile if profile.is_dir() else ROOT / "profiles" / rec.accountId
    result_box: dict = {"hits": [], "attach": None, "video": None}

    def after_start():
        w = webview.windows[0]
        deadline = time.time() + 40
        while time.time() < deadline:
            try:
                href = w.evaluate_js("location.href")
                if href and "dola.com" in str(href):
                    break
            except Exception:
                pass
            time.sleep(0.5)
        time.sleep(2)
        try:
            result_box["video"] = w.evaluate_js(VIDEO_MODE_JS)
            print("[capture] video mode:", result_box["video"])
        except Exception as exc:
            print("[capture] video mode err", exc)
        time.sleep(1.5)
        try:
            result_box["install"] = w.evaluate_js(CAPTURE_JS)
            print("[capture] install:", result_box["install"])
        except Exception as exc:
            print("[capture] install err", exc)
        time.sleep(0.5)
        files = [load_file(image)]
        js = ATTACH_JS_TMPL.replace("__FILES__", json.dumps(files, ensure_ascii=False))
        try:
            result_box["attach"] = w.evaluate_js(js)
            print("[capture] attach:", result_box["attach"])
        except Exception as exc:
            print("[capture] attach err", exc)
            result_box["attach_error"] = str(exc)
        # wait for upload network
        for i in range(30):
            time.sleep(1)
            try:
                hits = w.evaluate_js("window.__dolaUploadCapture ? window.__dolaUploadCapture.dump() : []")
                result_box["hits"] = hits or []
                if hits:
                    print(f"[capture] hits={len(hits)} after {i+1}s")
                    # stop early if we got a successful upload-ish response
                    for h in hits:
                        url = str(h.get("url") or "")
                        resp = str(h.get("response") or "")
                        if h.get("status") in (200, 201) and any(
                            k in (url + resp).lower() for k in ("uri", "resource", "attachment", "upload", "key")
                        ):
                            print("[capture] promising hit, continuing a bit more...")
            except Exception as exc:
                print("[capture] dump err", exc)
        out = ROOT / "_upload_probe" / "capture_hits.json"
        out.parent.mkdir(exist_ok=True)
        out.write_text(json.dumps(result_box, ensure_ascii=False, indent=2), encoding="utf-8")
        print("[capture] wrote", out)
        print(json.dumps(result_box, ensure_ascii=False, indent=2)[:8000])
        try:
            w.destroy()
        except Exception:
            pass

    webview.create_window(
        f"dola-upload-capture:{rec.accountId}",
        "https://www.dola.com/chat",
        width=1200,
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
