# -*- coding: utf-8 -*-
"""
WebView2 video generation automation (reseller-style).

Order:
  1) click 视频生成
  2) inject completion patch (5/10/15 + seedance for 15s + optional ratio)
  3) attach 0–n reference images via DataTransfer (no CDP)
  4) fill prompt + submit
  5) poll for video URL and download
"""
from __future__ import annotations

import base64
import json
import mimetypes
import re
import time
import urllib.request
from pathlib import Path
from typing import Any, Callable, Optional

from login_flow import js_eval

LogFn = Callable[[str], None]
ROOT = Path(__file__).resolve().parent
PATCH_JS = (ROOT / "video_patch.js").read_text(encoding="utf-8")


def _log(log: Optional[LogFn], msg: str) -> None:
    if log:
        log(msg)


def _plain_force_helpers() -> str:
    return r"""
  const plain = el => (el && (el.innerText || el.textContent || el.getAttribute('aria-label') || el.title || '') || '').replace(/\s+/g, ' ').trim();
  const visible = el => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
  };
  const forceClick = el => {
    if (!el) return false;
    try { el.scrollIntoView({ block: 'center' }); } catch (e) {}
    try { el.focus && el.focus(); } catch (e) {}
    const o = { bubbles: true, cancelable: true, view: window, buttons: 1 };
    for (const t of ['pointerdown','mousedown','pointerup','mouseup','click']) {
      try { el.dispatchEvent(new MouseEvent(t, o)); } catch (e) {}
    }
    try { el.click(); } catch (e) {}
    return true;
  };
"""


JS_CLICK_VIDEO = r"""
(() => {
""" + _plain_force_helpers() + r"""
  const labels = ['\u89c6\u9891\u751f\u6210', 'Create Video', 'Video Generation', 'Image to Video', 'Text to Video'];
  const nodes = Array.from(document.querySelectorAll('button, [role=button], [role=tab], a')).filter(visible);
  const hits = nodes
    .map(el => ({ el, t: plain(el), r: el.getBoundingClientRect() }))
    .filter(x => x.t && x.t.length <= 24 && labels.some(l => x.t === l || x.t.startsWith(l)))
    .sort((a, b) => (b.r.y - a.r.y) || ((b.r.width * b.r.height) - (a.r.width * a.r.height)));
  const item = hits[0];
  if (!item) {
    return { ok: false, reason: 'video-btn-missing', sample: nodes.map(n => plain(n)).filter(t => t && t.length <= 20).slice(0, 20) };
  }
  forceClick(item.el);
  return { ok: true, text: item.t };
})()
"""


def js_attach_files_b64(files: list[dict]) -> str:
    """files: [{name, mime, b64}, ...] — empty list is no-op."""
    payload = json.dumps(files, ensure_ascii=False)
    return f"""
(() => {{
  const files = {payload};
  if (!files || !files.length) return {{ ok: true, count: 0, skipped: true }};
  const input = document.querySelector('input[type=file]');
  if (!input) return {{ ok: false, reason: 'file-input-missing' }};
  try {{
    const dt = new DataTransfer();
    for (const f of files) {{
      const bin = atob(f.b64);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      const blob = new Blob([arr], {{ type: f.mime || 'application/octet-stream' }});
      dt.items.add(new File([blob], f.name || 'ref.png', {{ type: f.mime || 'image/png' }}));
    }}
    input.files = dt.files;
    input.dispatchEvent(new Event('input', {{ bubbles: true }}));
    input.dispatchEvent(new Event('change', {{ bubbles: true }}));
    return {{ ok: true, count: files.length, names: files.map(x => x.name) }};
  }} catch (e) {{
    return {{ ok: false, reason: String(e && e.message || e) }};
  }}
}})()
"""


JS_FILL_PROMPT = r"""
(() => {
  const text = %PROMPT%;
""" + _plain_force_helpers() + r"""
  const pick = () => {
    const sels = [
      "textarea:not([aria-hidden='true']):not([tabindex='-1'])",
      "[contenteditable='true']",
      "[role='textbox']",
      "textarea",
    ];
    for (const sel of sels) {
      const items = Array.from(document.querySelectorAll(sel)).filter(visible);
      if (items.length) return items[items.length - 1];
    }
    return null;
  };
  const el = pick();
  if (!el) return { ok: false, reason: 'prompt-missing' };
  forceClick(el);
  el.focus();
  if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
    const setter = Object.getOwnPropertyDescriptor(el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')?.set;
    setter?.call(el, text);
    el.value = text;
  } else {
    el.textContent = text;
  }
  el.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: text }));
  el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return { ok: true, len: text.length, tag: el.tagName };
})()
"""


JS_CLICK_SEND = r"""
(() => {
""" + _plain_force_helpers() + r"""
  const send = document.querySelector('#flow-end-msg-send');
  if (send && visible(send) && !send.disabled && send.getAttribute('aria-disabled') !== 'true') {
    forceClick(send);
    return { ok: true, via: '#flow-end-msg-send' };
  }
  const labels = ['\u53d1\u9001', '\u63d0\u4ea4', 'Send', 'Submit'];
  const nodes = Array.from(document.querySelectorAll('button, [role=button]')).filter(visible);
  const el = nodes.find(n => {
    const t = plain(n);
    if (!t || t.length > 12) return false;
    if (n.disabled || n.getAttribute('aria-disabled') === 'true') return false;
    return labels.some(l => t === l);
  });
  if (!el) {
    // Enter key fallback is done from Python host if needed
    return { ok: false, reason: 'send-missing', disabled: !!(send && send.disabled) };
  }
  forceClick(el);
  return { ok: true, via: 'label:' + plain(el) };
})()
"""


JS_SEND_STATE = r"""
(() => {
  const send = document.querySelector('#flow-end-msg-send');
  const disabled = !send || send.disabled || send.getAttribute('aria-disabled') === 'true';
  const ta = Array.from(document.querySelectorAll('textarea, [contenteditable=true], [role=textbox]')).filter(el => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }).at(-1);
  const text = ta ? (ta.value || ta.innerText || ta.textContent || '') : '';
  return {
    sendFound: !!send,
    sendEnabled: !disabled,
    promptLen: text.trim().length,
    url: location.href,
  };
})()
"""


JS_FIND_VIDEOS = r"""
(() => {
  const urls = new Set();
  const push = u => {
    if (!u || typeof u !== 'string') return;
    if (!/^https?:\/\//i.test(u)) return;
    if (/\.(mp4|webm|mov|m4v)(\?|$)/i.test(u) || /mime_type=video_|rc_gen_video|video_gen/i.test(u)) urls.add(u);
  };
  document.querySelectorAll('video, video source, a[href]').forEach(el => {
    push(el.currentSrc || el.src || el.href || el.getAttribute('src') || el.getAttribute('href') || '');
  });
  // records captured by fetch hook if present
  try {
    (window.__dolaCliImageRecords || []).forEach(r => push(r && r.url));
  } catch (e) {}
  try {
    if (window.__dolaCliLastVideoUrls) window.__dolaCliLastVideoUrls.forEach(push);
  } catch (e) {}
  return Array.from(urls).slice(0, 30);
})()
"""


JS_INSTALL_VIDEO_URL_HOOK = r"""
(() => {
  if (window.__dolaVideoUrlHook) return { ok: true, reused: true };
  window.__dolaVideoUrlHook = true;
  window.__dolaCliLastVideoUrls = window.__dolaCliLastVideoUrls || [];
  const push = u => {
    if (!u || typeof u !== 'string' || !/^https?:\/\//i.test(u)) return;
    if (!(/\.(mp4|webm|mov|m4v)(\?|$)/i.test(u) || /mime_type=video_|rc_gen_video|video_gen|play/i.test(u))) return;
    if (!window.__dolaCliLastVideoUrls.includes(u)) window.__dolaCliLastVideoUrls.push(u);
  };
  const visit = (node, depth) => {
    if (depth > 12 || node == null) return;
    if (typeof node === 'string') { push(node); return; }
    if (typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(x => visit(x, depth + 1)); return; }
    for (const [k, v] of Object.entries(node)) {
      if (/url|uri|src|video|play|download|origin|raw/i.test(k)) visit(v, depth + 1);
      else if (v && typeof v === 'object') visit(v, depth + 1);
    }
  };
  const _parse = JSON.parse;
  JSON.parse = function (text, reviver) {
    const data = _parse.call(this, text, reviver);
    try {
      if (typeof text === 'string' && /video|mp4|play|rc_gen/i.test(text)) visit(data, 0);
    } catch (e) {}
    return data;
  };
  return { ok: true, reused: false };
})()
"""


def load_ref_files_b64(paths: list[str]) -> list[dict]:
    out = []
    for p in paths:
        path = Path(p)
        if not path.is_file():
            raise FileNotFoundError(str(path))
        raw = path.read_bytes()
        # Keep under ~8MB each for evaluate_js payload
        if len(raw) > 12 * 1024 * 1024:
            raise ValueError(f"reference image too large for WebView inject: {path} ({len(raw)} bytes)")
        mime = mimetypes.guess_type(path.name)[0] or "image/png"
        out.append(
            {
                "name": path.name,
                "mime": mime,
                "b64": base64.b64encode(raw).decode("ascii"),
            }
        )
    return out


def prefer_video_url(urls: list[str]) -> str:
    if not urls:
        return ""
    scored = []
    for u in urls:
        score = 0
        if re.search(r"video_gen_no_watermark|no[_-]?watermark|watermark=0", u, re.I):
            score += 100
        if re.search(r"rc_gen_video|\.mp4", u, re.I):
            score += 40
        if re.search(r"watermark=1|logo=", u, re.I):
            score -= 50
        scored.append((score, u))
    scored.sort(key=lambda x: -x[0])
    return scored[0][1]


def download_url(url: str, out_path: Path, timeout: int = 180) -> Path:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36",
            "Referer": "https://www.dola.com/",
        },
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        data = resp.read()
    out_path.write_bytes(data)
    return out_path


def run_video_generation(
    window,
    *,
    prompt: str,
    ref_paths: list[str] | None = None,
    duration: int = 15,
    aspect_ratio: str = "9:16",
    model: str = "",
    out_dir: str | Path = "downloads",
    timeout: float = 600,
    log: Optional[LogFn] = None,
    close_when_done: bool = False,
) -> dict[str, Any]:
    """Drive full video gen inside an already-open WebView window (logged-in profile)."""
    prompt = (prompt or "").strip()
    if not prompt:
        raise ValueError("prompt is required")
    duration = int(duration)
    if duration not in (5, 10, 15):
        raise ValueError("duration must be 5, 10, or 15")
    ratio = (aspect_ratio or "").strip().replace("/", ":")
    if not model and duration >= 15:
        model = "seedance_v2.0"
    refs = list(ref_paths or [])
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    # Ensure on chat (and wait until evaluate works after navigation)
    def wait_eval_ok(seconds: float = 20) -> bool:
        deadline = time.time() + seconds
        while time.time() < deadline:
            try:
                href = window.evaluate_js("(() => location.href)()")
                if href and "dola.com" in str(href):
                    return True
            except Exception:
                pass
            time.sleep(0.4)
        return False

    try:
        url = window.get_current_url() or ""
    except Exception:
        url = ""
    if "dola.com" not in (url or "") or "/auth/" in (url or "") or "/chat" not in (url or ""):
        window.load_url("https://www.dola.com/chat")
    else:
        window.load_url("https://www.dola.com/chat")
    if not wait_eval_ok(25):
        raise RuntimeError("WebView did not load dola.com/chat")
    time.sleep(1.5)

    # Configure patch globals + inject
    _log(log, f"inject video patch duration={duration}s model={model or '-'} ratio={ratio or '-'}")
    js_eval(
        window,
        f"(() => {{ window.__dolaVideoDuration={duration}; window.__dolaVideoModel={json.dumps(model)}; window.__dolaVideoRatio={json.dumps(ratio)}; return true; }})()",
    )
    patch_res = js_eval(window, PATCH_JS)
    _log(log, f"patch: {patch_res}")
    hook_res = js_eval(window, JS_INSTALL_VIDEO_URL_HOOK)
    _log(log, f"url-hook: {hook_res}")

    # Step 1: video mode
    _log(log, "step1: click 视频生成")
    r1 = js_eval(window, JS_CLICK_VIDEO)
    _log(log, f"video mode: {r1}")
    time.sleep(1.5)

    # Step 2: attach 0-n images
    _log(log, f"step2: attach refs count={len(refs)}")
    if refs:
        files = load_ref_files_b64(refs)
        # large payload: attach one-by-one if many, single DataTransfer if few
        r2 = js_eval(window, js_attach_files_b64(files))
        _log(log, f"attach: {r2}")
        if not (isinstance(r2, dict) and r2.get("ok")):
            raise RuntimeError(f"attach failed: {r2}")
        # wait for send to enable / upload settle — poll lightly
        for i in range(40):
            st = js_eval(window, JS_SEND_STATE) or {}
            if isinstance(st, dict) and st.get("sendEnabled"):
                _log(log, f"send enabled after attach ({i})")
                break
            time.sleep(0.5)
        else:
            _log(log, "send still disabled after attach wait; continue anyway")
    else:
        _log(log, "no reference images")

    # Step 3: prompt
    _log(log, "step3: fill prompt")
    fill_js = JS_FILL_PROMPT.replace("%PROMPT%", json.dumps(prompt, ensure_ascii=False))
    r3 = js_eval(window, fill_js)
    _log(log, f"fill: {r3}")
    if not (isinstance(r3, dict) and r3.get("ok")):
        raise RuntimeError(f"fill prompt failed: {r3}")
    time.sleep(0.6)

    # Step 4: submit
    _log(log, "step4: submit")
    for attempt in range(1, 8):
        st = js_eval(window, JS_SEND_STATE) or {}
        _log(log, f"send-state: {st}")
        r4 = js_eval(window, JS_CLICK_SEND)
        _log(log, f"send click[{attempt}]: {r4}")
        time.sleep(1.2)
        st2 = js_eval(window, JS_SEND_STATE) or {}
        if isinstance(st2, dict) and int(st2.get("promptLen") or 0) < max(8, len(prompt) // 3):
            _log(log, "composer cleared — submit accepted")
            break
        time.sleep(1.0)
    else:
        _log(log, "warn: composer may still hold prompt; waiting for video anyway")

    # Step 5: wait video urls + download
    _log(log, "step5: wait for video + download")
    deadline = time.time() + timeout
    best_url = ""
    while time.time() < deadline:
        urls = js_eval(window, JS_FIND_VIDEOS) or []
        if isinstance(urls, list) and urls:
            best_url = prefer_video_url([str(u) for u in urls])
            _log(log, f"found {len(urls)} video url(s); prefer={best_url[:120]}")
            if best_url:
                break
        time.sleep(3.0)

    if not best_url:
        raise TimeoutError(f"no video URL within {timeout}s")

    ext = "mp4"
    if ".webm" in best_url.lower():
        ext = "webm"
    out_path = out_dir / f"dola_video_{duration}s_{int(time.time())}.{ext}"
    _log(log, f"downloading -> {out_path}")
    download_url(best_url, out_path)
    _log(log, f"saved {out_path} ({out_path.stat().st_size} bytes)")

    if close_when_done:
        try:
            window.destroy()
        except Exception:
            pass

    return {
        "ok": True,
        "file": str(out_path),
        "url": best_url,
        "duration": duration,
        "aspectRatio": ratio,
        "model": model,
        "refs": refs,
        "size": out_path.stat().st_size,
    }
