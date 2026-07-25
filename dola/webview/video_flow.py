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
    else:
        print(f"[video_flow] {msg}", flush=True)


def _log_exc(log: Optional[LogFn], msg: str, exc: BaseException) -> None:
    import traceback

    text = f"{msg}: {exc}\n{traceback.format_exc()}"
    if log:
        log(text)
    else:
        print(f"[video_flow] {text}", flush=True)


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
    if (/\.(mp4|webm|mov|m4v)(\?|$)/i.test(u) || /mime_type=video_|rc_gen_video|video_gen|play/i.test(u)) urls.add(u);
  };
  document.querySelectorAll('video, video source, a[href]').forEach(el => {
    push(el.currentSrc || el.src || el.href || el.getAttribute('src') || el.getAttribute('href') || '');
  });
  try { (window.__dolaCliImageRecords || []).forEach(r => push(r && r.url)); } catch (e) {}
  try { (window.__dolaCliLastVideoUrls || []).forEach(push); } catch (e) {}

  // Reseller core: messageId → vid → get_play_info no-watermark URL
  try {
    const blocks = document.querySelectorAll(
      '[class*="block-video"], [class*="video-block"], [class*="VideoBlock"], [class*="video-container"], video'
    );
    blocks.forEach(el => {
      let mid = null;
      let cur = el;
      for (let i = 0; i < 22 && cur && cur !== document.body; i++, cur = cur.parentElement) {
        if (cur.dataset && (cur.dataset.messageId || cur.dataset.message_id)) {
          mid = cur.dataset.messageId || cur.dataset.message_id;
          break;
        }
        const attr = cur.getAttribute && (cur.getAttribute('data-message-id') || cur.getAttribute('data-messageId'));
        if (attr) { mid = attr; break; }
      }
      let vid = null;
      if (mid && window.__dolaGetVidByMessageId) vid = window.__dolaGetVidByMessageId(String(mid));
      if (!vid) {
        const v = el.tagName === 'VIDEO' ? el : el.querySelector && el.querySelector('video');
        const src = v && (v.currentSrc || v.src);
        if (src) {
          const m = src.match(/\/(v0[a-zA-Z0-9_-]+)/);
          if (m) vid = m[1];
        }
      }
      if (vid && window.__dolaResolveVideoUrl) {
        try {
          const r = window.__dolaResolveVideoUrl(vid);
          if (r && r.mainUrl) push(r.mainUrl);
        } catch (e) {}
      } else if (vid && window.__dolaGetVideoUrl) {
        push(window.__dolaGetVideoUrl(vid));
      }
    });
  } catch (e) {}
  return Array.from(urls).slice(0, 40);
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
    t_all = time.time()
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

    _log(
        log,
        f">>> video_flow begin duration={duration}s ratio={ratio} model={model or '-'} "
        f"refs={len(refs)} timeout={timeout}s out={out_dir}",
    )
    _log(log, f"prompt[{len(prompt)}]={prompt[:240]!r}")
    for i, rp in enumerate(refs):
        p = Path(rp)
        _log(log, f"  ref[{i}] path={rp} exists={p.is_file()} size={p.stat().st_size if p.is_file() else 0}")

    # Ensure on chat (and wait until evaluate works after navigation)
    def wait_eval_ok(seconds: float = 20) -> bool:
        deadline = time.time() + seconds
        n = 0
        while time.time() < deadline:
            n += 1
            try:
                href = window.evaluate_js("(() => location.href)()")
                if href and "dola.com" in str(href):
                    _log(log, f"wait_eval_ok ok after n={n} href={str(href)[:120]}")
                    return True
                if n % 10 == 0:
                    _log(log, f"wait_eval_ok n={n} href={href!r}")
            except Exception as exc:
                if n % 5 == 0:
                    _log(log, f"wait_eval_ok n={n} err={type(exc).__name__}: {exc}")
            time.sleep(0.4)
        _log(log, f"wait_eval_ok FAILED after {seconds}s n={n}")
        return False

    try:
        url = window.get_current_url() or ""
    except Exception as exc:
        url = ""
        _log(log, f"get_current_url failed: {exc}")
    on_chat = "dola.com" in (url or "") and "/chat" in (url or "") and "/auth/" not in (url or "")
    _log(log, f"nav check on_chat={on_chat} url={url[:120]!r}")
    if not on_chat:
        _log(log, f"navigate to /chat from {url[:80]!r}")
        try:
            window.load_url("https://www.dola.com/chat")
        except Exception as exc:
            _log_exc(log, "load_url warn", exc)
        if not wait_eval_ok(30):
            raise RuntimeError("WebView did not load dola.com/chat")
        time.sleep(2.0)
    else:
        _log(log, f"already on chat: {url[:100]}")
        if not wait_eval_ok(10):
            _log(log, "evaluate stale; reload /chat")
            try:
                window.load_url("https://www.dola.com/chat")
            except Exception as exc:
                _log_exc(log, "reload load_url", exc)
            if not wait_eval_ok(25):
                raise RuntimeError("WebView did not load dola.com/chat")
        time.sleep(1.0)

    # Duration preference for reseller fifteen_seconds inject (localStorage)
    if duration >= 15:
        rls = js_eval(
            window,
            "(() => { try { localStorage.setItem('dola_video_duration_choice','15'); return localStorage.getItem('dola_video_duration_choice'); } catch(e) { return String(e); } })()",
        )
        _log(log, f"localStorage duration choice -> {rls!r}")
    else:
        js_eval(
            window,
            "(() => { try { localStorage.removeItem('dola_video_duration_choice'); } catch(e) {} return true; })()",
        )

    # Always install lightweight completion patch (works with or without full inject shell)
    _log(log, f"inject video patch duration={duration}s model={model or '-'} ratio={ratio or '-'}")
    cfg = js_eval(
        window,
        f"(() => {{ window.__dolaVideoDuration={duration}; window.__dolaVideoModel={json.dumps(model)}; window.__dolaVideoRatio={json.dumps(ratio)}; return {{d:window.__dolaVideoDuration,m:window.__dolaVideoModel,r:window.__dolaVideoRatio}}; }})()",
    )
    _log(log, f"patch config: {cfg}")
    t0 = time.time()
    patch_res = js_eval(window, PATCH_JS)
    _log(log, f"patch: {patch_res} ({time.time() - t0:.2f}s)")
    hook_res = js_eval(window, JS_INSTALL_VIDEO_URL_HOOK)
    _log(log, f"url-hook: {hook_res}")

    # Step 1: video mode FIRST (before attach — matches reseller mental model)
    _log(log, ">>> step1: click 视频生成")
    r1 = js_eval(window, JS_CLICK_VIDEO)
    _log(log, f"video mode: {r1}")
    if isinstance(r1, dict) and not r1.get("ok"):
        _log(log, f"video-btn sample labels: {(r1 or {}).get('sample')}")
    time.sleep(2.0)

    # Step 2: attach 0-n images (DataTransfer — no CDP)
    _log(log, f">>> step2: attach refs count={len(refs)}")
    if refs:
        try:
            files = load_ref_files_b64(refs)
            total_b64 = sum(len(f.get("b64") or "") for f in files)
            _log(log, f"ref payload names={[f['name'] for f in files]} total_b64_chars={total_b64}")
        except Exception as exc:
            _log_exc(log, "load_ref_files_b64 failed", exc)
            raise
        t0 = time.time()
        r2 = js_eval(window, js_attach_files_b64(files))
        _log(log, f"attach: {r2} ({time.time() - t0:.2f}s)")
        if not (isinstance(r2, dict) and r2.get("ok")):
            raise RuntimeError(f"attach failed: {r2}")
        # Give SPA time to process large refs WITHOUT tight evaluate spam
        time.sleep(3.0)
        for i in range(50):
            try:
                st = js_eval(window, JS_SEND_STATE) or {}
            except Exception as exc:
                _log(log, f"send-state warm {i}: {exc}")
                time.sleep(0.8)
                continue
            if i % 5 == 0:
                _log(log, f"send-state poll[{i}]: {st}")
            if isinstance(st, dict) and st.get("sendEnabled"):
                _log(log, f"send enabled after attach (poll={i})")
                break
            time.sleep(0.6)
        else:
            _log(log, "send still disabled after attach wait; continue anyway")
        time.sleep(1.0)
    else:
        _log(log, "no reference images (text-only video)")

    # Step 3: prompt AFTER attach
    _log(log, ">>> step3: fill prompt")
    fill_js = JS_FILL_PROMPT.replace("%PROMPT%", json.dumps(prompt, ensure_ascii=False))
    r3 = None
    for i in range(8):
        r3 = js_eval(window, fill_js)
        _log(log, f"fill try {i}: {r3}")
        if isinstance(r3, dict) and r3.get("ok"):
            break
        time.sleep(1.0)
    if not (isinstance(r3, dict) and r3.get("ok")):
        raise RuntimeError(f"fill prompt failed: {r3}")
    time.sleep(0.8)

    # Step 4: submit
    _log(log, ">>> step4: submit")
    for attempt in range(1, 10):
        st = js_eval(window, JS_SEND_STATE) or {}
        _log(log, f"send-state: {st}")
        r4 = js_eval(window, JS_CLICK_SEND)
        _log(log, f"send click[{attempt}]: {r4}")
        time.sleep(1.5)
        st2 = js_eval(window, JS_SEND_STATE) or {}
        _log(log, f"send-state after click: {st2}")
        if isinstance(st2, dict) and int(st2.get("promptLen") or 0) < max(8, len(prompt) // 3):
            _log(log, "composer cleared — submit accepted")
            break
        time.sleep(1.0)
    else:
        _log(log, "warn: composer may still hold prompt; waiting for video anyway")

    # Step 5: wait video urls + download
    _log(log, f">>> step5: wait for video + download (timeout={timeout}s)")
    deadline = time.time() + timeout
    best_url = ""
    poll = 0
    while time.time() < deadline:
        poll += 1
        remaining = deadline - time.time()
        try:
            urls = js_eval(window, JS_FIND_VIDEOS) or []
        except Exception as exc:
            _log(log, f"find-videos poll[{poll}] err: {exc}")
            time.sleep(3.0)
            continue
        if isinstance(urls, list) and urls:
            best_url = prefer_video_url([str(u) for u in urls])
            _log(log, f"found {len(urls)} video url(s) poll={poll}; prefer={best_url[:160]}")
            for j, u in enumerate(urls[:8]):
                _log(log, f"  url[{j}]={str(u)[:180]}")
            if best_url:
                break
        elif poll % 5 == 0:
            _log(log, f"still waiting video… poll={poll} remaining={remaining:.0f}s")
        time.sleep(3.0)

    if not best_url:
        raise TimeoutError(f"no video URL within {timeout}s (polls={poll})")

    ext = "mp4"
    if ".webm" in best_url.lower():
        ext = "webm"
    out_path = out_dir / f"dola_video_{duration}s_{int(time.time())}.{ext}"
    _log(log, f"downloading -> {out_path}")
    t0 = time.time()
    try:
        download_url(best_url, out_path)
    except Exception as exc:
        _log_exc(log, "download_url failed", exc)
        raise
    size = out_path.stat().st_size
    _log(log, f"saved {out_path} ({size} bytes, {time.time() - t0:.1f}s)")

    if close_when_done:
        _log(log, "close_when_done → destroy window")
        try:
            window.destroy()
        except Exception as exc:
            _log_exc(log, "window.destroy", exc)

    result = {
        "ok": True,
        "file": str(out_path),
        "url": best_url,
        "duration": duration,
        "aspectRatio": ratio,
        "model": model,
        "refs": refs,
        "size": size,
        "elapsedSec": round(time.time() - t_all, 1),
    }
    _log(log, f">>> video_flow DONE elapsed={result['elapsedSec']}s file={out_path}")
    return result
