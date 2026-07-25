# -*- coding: utf-8 -*-
"""
Dola inject shell — mirrors reseller DoubaoAccountManager behaviour.

Opens WebView2 with a logged-in profile, injects:
  - dola_fifteen_seconds.js  (15s + seedance_v2.0 on ability_type=17)
  - dola_core.js             (no-watermark harvest + on-page download buttons)
  - dola_capture.js          (resource capture)

You generate video/image yourself in the page; inject adds 15s option + download buttons.
Downloads save to --out (default G:\\cookies\\dola\\..\\downloads or cli/downloads/inject).

Usage:
  python inject_shell.py --account GlynisWilliams9z0h
  python inject_shell.py --accounts ..\\google_mail.txt --index 0 --out ..\\cli\\downloads\\inject
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import re
import subprocess
import sys
import threading
import time
import traceback
import urllib.request
from datetime import datetime
from pathlib import Path
from urllib.parse import unquote, urlparse

import webview

from cookie_util import (
    DEFAULT_COOKIE_DIR,
    apply_cookies_to_webview_window,
    expand_cookies,
    filter_dola_related,
    find_account_cookie_file,
    has_session,
    load_account_netscape_cookies,
    load_cookies_from_webview2_profile,
)
from daily_profile_usage import (
    DAILY_CREDIT_LIMIT,
    credit_cost_for_duration,
    get_balance,
    mark_profile_used,
    spend_for_duration,
)
from debug_log import (
    get_log_path,
    log,
    log_debug,
    log_env,
    log_error,
    log_exc,
    log_step,
    log_warn,
    setup_logging,
)
from dola_webview import (
    DEFAULT_PROFILES,
    account_id_from_email,
    list_accounts,
    profile_dir,
    safe_account_id,
)
from login_flow import page_state, parse_accounts_file

ROOT = Path(__file__).resolve().parent
INJECT_DIR = ROOT / "inject"
DEFAULT_OUT = ROOT.parent / "cli" / "downloads" / "inject"
DEFAULT_URL = "https://www.dola.com/chat"
DEFAULT_COOKIE_POOL = DEFAULT_COOKIE_DIR

SCRIPT_ORDER = (
    "bridge.js",
    "dola_fifteen_seconds.js",
    "dola_core.js",
    "dola_capture.js",
)


def load_inject_scripts() -> list[tuple[str, str]]:
    scripts: list[tuple[str, str]] = []
    for name in SCRIPT_ORDER:
        path = INJECT_DIR / name
        if not path.is_file():
            raise FileNotFoundError(f"missing inject script: {path}")
        text = path.read_text(encoding="utf-8", errors="replace")
        scripts.append((name, text))
        log_debug(f"loaded script {name} bytes={len(text)} path={path}")
    return scripts


def safe_filename(name: str, fallback: str = "dola_file") -> str:
    name = unquote(name or "")
    name = re.sub(r"[\\/:*?\"<>|\r\n]+", "_", name).strip(" ._") or fallback
    return name[:120]


def guess_ext(url: str, content_type: str = "") -> str:
    path = urlparse(url).path.lower()
    for ext in (".mp4", ".webm", ".mov", ".m4v", ".png", ".jpg", ".jpeg", ".webp", ".gif"):
        if path.endswith(ext):
            return ext.lstrip(".")
    if "mp4" in (content_type or ""):
        return "mp4"
    if "webm" in (content_type or ""):
        return "webm"
    if "png" in (content_type or ""):
        return "png"
    if "jpeg" in (content_type or "") or "jpg" in (content_type or ""):
        return "jpg"
    if "webp" in (content_type or ""):
        return "webp"
    return "bin"


class HostApi:
    """JS → Python bridge for download / logging / credit tracking."""

    def __init__(
        self,
        out_dir: Path,
        *,
        account_id: str = "",
        on_title_update=None,
        on_credit_change=None,
    ):
        self.out_dir = out_dir
        self.out_dir.mkdir(parents=True, exist_ok=True)
        self.account_id = account_id
        self.on_title_update = on_title_update
        self.on_credit_change = on_credit_change
        self._lock = threading.Lock()
        self.downloads: list[dict] = []
        self.message_count = 0
        self.last_video_duration: int | None = None
        self._spent_for_submit_at: float = 0.0

    def on_message(self, payload):
        """Called from bridge.js with JSON string or dict-like."""
        self.message_count += 1
        n = self.message_count
        try:
            if isinstance(payload, str):
                data = json.loads(payload)
            elif isinstance(payload, dict):
                data = payload
            else:
                data = json.loads(str(payload))
        except Exception as exc:
            log_error(f"host#{n} parse failed: {exc} raw={str(payload)[:300]}")
            return {"ok": False, "error": "bad-json"}

        msg_type = data.get("type") or data.get("Type") or ""
        log_debug(f"host#{n} type={msg_type!r} keys={list(data.keys())}")

        if msg_type in ("log", "debug", "info", "warn", "error"):
            text = data.get("msg") or data.get("message") or data.get("text") or json.dumps(data, ensure_ascii=False)[:300]
            level_map = {"debug": log_debug, "warn": log_warn, "error": log_error}
            (level_map.get(msg_type) or log)(f"js[{msg_type}]: {text}")
            return {"ok": True}

        if msg_type == "videoSubmit":
            try:
                dur = int(data.get("duration") or 0)
            except (TypeError, ValueError):
                dur = 0
            if dur in (5, 10, 15):
                self.last_video_duration = dur
                log(f"videoSubmit duration={dur}s cost={credit_cost_for_duration(dur)} patched={data.get('patched')}")
            return {"ok": True, "duration": dur}

        if msg_type == "download":
            return self._handle_download(data)

        if msg_type == "newResource":
            inner = data.get("data") or {}
            url = inner.get("url") or data.get("url")
            rtype = inner.get("type") or data.get("resourceType") or "?"
            log(f"capture newResource type={rtype} url={(url or '')[:160]}")
            if url and rtype in ("video", "image"):
                fname = inner.get("filename") or f"dola_{rtype}_{int(time.time())}"
                return self._handle_download({"url": url, "filename": fname, "type": rtype})
            return {"ok": True, "ignored": True}

        if msg_type in ("pageChanged", "videoUrlUpdate", "videoDataExtracted"):
            detail = {k: data.get(k) for k in ("url", "href", "videoUrl", "vid", "messageId") if data.get(k)}
            log(f"event: {msg_type} {detail or ''}".strip())
            return {"ok": True}

        log(f"host#{n} message: {msg_type} {json.dumps(data, ensure_ascii=False)[:240]}")
        return {"ok": True}

    def _maybe_spend_video_credit(self, duration: int | None, reason: str) -> None:
        if not self.account_id:
            return
        dur = int(duration or self.last_video_duration or 0)
        if dur not in (5, 10, 15):
            # Prefer last submit; fall back to 15 only if unknown after a video result
            dur = self.last_video_duration or 15
        # Debounce: one spend per ~20s window (avoid multi-download same gen)
        now = time.time()
        if now - self._spent_for_submit_at < 20:
            log_debug(f"credit skip debounce account={self.account_id} dur={dur}")
            return
        try:
            bal = spend_for_duration(self.account_id, dur, reason=reason)
            self._spent_for_submit_at = now
            log(
                f"积分消耗 account={self.account_id} duration={dur}s cost={bal.get('cost')} "
                f"remaining={bal.get('remaining')}/{bal.get('limit')}"
            )
            if callable(self.on_credit_change):
                self.on_credit_change(bal)
            if callable(self.on_title_update):
                self.on_title_update()
        except ValueError as exc:
            log_warn(str(exc))
            if callable(self.on_title_update):
                self.on_title_update()
        except Exception as exc:
            log_exc("credit spend failed", exc)

    def _handle_download(self, data: dict) -> dict:
        url = data.get("url") or ""
        if not url or not str(url).startswith("http"):
            log_warn(f"download skipped bad url: {url!r}")
            return {"ok": False, "error": "bad-url"}
        filename = data.get("filename") or f"dola_{int(time.time())}"
        filename = safe_filename(str(filename))
        if "." not in filename:
            filename = f"{filename}.{guess_ext(url)}"
        out_path = self.out_dir / filename
        if out_path.exists():
            stem, suf = out_path.stem, out_path.suffix
            out_path = self.out_dir / f"{stem}_{int(time.time())}{suf}"
        t0 = time.time()
        try:
            log_step("download-start", f"-> {out_path.name} url={url[:160]}")
            req = urllib.request.Request(
                url,
                headers={
                    "User-Agent": (
                        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                        "(KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36 Edg/150.0.0.0"
                    ),
                    "Referer": "https://www.dola.com/",
                },
            )
            with urllib.request.urlopen(req, timeout=180) as resp:
                body = resp.read()
                ctype = resp.headers.get("Content-Type") or ""
                status = getattr(resp, "status", None) or resp.getcode()
            if out_path.suffix == ".bin":
                out_path = out_path.with_suffix("." + guess_ext(url, ctype))
            with self._lock:
                out_path.write_bytes(body)
                rec = {
                    "file": str(out_path),
                    "url": url[:200],
                    "bytes": len(body),
                    "contentType": ctype,
                    "status": status,
                    "elapsedSec": round(time.time() - t0, 2),
                    "at": datetime.now().isoformat(timespec="seconds"),
                }
                self.downloads.append(rec)
            log_step(
                "download-ok",
                f"{out_path} bytes={len(body)} ctype={ctype!r} status={status} "
                f"elapsed={time.time() - t0:.1f}s",
            )
            # Spend daily video credits when a video file is saved
            rtype = str(data.get("type") or "").lower()
            is_video = rtype == "video" or out_path.suffix.lower() in {
                ".mp4",
                ".webm",
                ".mov",
                ".m4v",
            }
            if is_video:
                dur = data.get("duration")
                try:
                    dur_i = int(dur) if dur is not None else None
                except (TypeError, ValueError):
                    dur_i = None
                self._maybe_spend_video_credit(dur_i, reason="video-download")
            return {"ok": True, "file": str(out_path), "bytes": len(body)}
        except Exception as exc:
            log_exc(f"download failed url={url[:120]}", exc)
            return {"ok": False, "error": str(exc)}

    def ping(self) -> str:
        log_debug("host api ping")
        return "pong"


def window_title_for(account_id: str) -> str:
    try:
        bal = get_balance(account_id)
        rem = int(bal.get("remaining") or 0)
        lim = int(bal.get("limit") or DAILY_CREDIT_LIMIT)
        return f"Dola 注入壳 — {account_id}  ·  积分 {rem}/{lim}"
    except Exception:
        return f"Dola 注入壳 — {account_id}  ·  积分 ?/{DAILY_CREDIT_LIMIT}"


def _is_error_page(href: str) -> bool:
    h = (href or "").lower()
    return (
        "chrome-error://" in h
        or "edge://crash" in h
        or "chrome://crash" in h
        or "chrome://dino" in h
    )


def inject_one(window, name: str, source: str, log_prefix: str = "inject") -> dict:
    """
    Inject one script via deferred <script> tag + base64.

    Critical safety rules (learned the hard way):
      - Do NOT nest full IIFE source inside evaluate_js expression (crashes renderer)
      - Do NOT run heavy DOM work synchronously during evaluate_js (freeze → 此页存在问题)
      - Do NOT call pywebview.api synchronously from inside evaluate_js (deadlock)
      - Schedule script body with setTimeout(0) so evaluate_js returns immediately
    """
    raw = source.encode("utf-8")
    b64 = base64.b64encode(raw).decode("ascii")
    expr = f"""
(() => {{
  try {{
    const b64 = {json.dumps(b64)};
    const name = {json.dumps(name)};
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const code = new TextDecoder('utf-8').decode(bytes);
    // Defer so this evaluate_js call returns before any heavy script body runs
    setTimeout(function () {{
      try {{
        const s = document.createElement('script');
        s.setAttribute('data-dola-inject', name);
        s.textContent = code;
        const root = document.documentElement || document.head || document.body;
        if (!root) {{ console.error('[dola-inject] no-root', name); return; }}
        root.appendChild(s);
        try {{ s.remove(); }} catch (e) {{}}
      }} catch (e) {{
        console.error('[dola-inject] run failed', name, e);
      }}
    }}, 0);
    return {{ ok: true, name: name, bytes: code.length, deferred: true }};
  }} catch (e) {{
    return {{ ok: false, name: {json.dumps(name)}, error: String(e && e.message || e) }};
  }}
}})()
"""
    t0 = time.time()
    log_debug(f"{log_prefix}: inject_one {name} src_bytes={len(raw)} expr_len={len(expr)}")
    result = window.evaluate_js(expr)
    log(f"{log_prefix}: {name} -> {result!r} ({time.time() - t0:.2f}s)")
    return result if isinstance(result, dict) else {"ok": False, "raw": result}


def wait_inject_flags(window, timeout: float = 8.0, log_prefix: str = "inject") -> dict:
    """Poll until all inject markers appear (scripts run deferred)."""
    deadline = time.time() + timeout
    last: dict = {}
    n = 0
    while time.time() < deadline:
        n += 1
        try:
            last = window.evaluate_js(
                "(() => ({ bridge: !!window.__dolaBridgeLoaded, "
                "s15: !!window.__dola15sLoaded, core: !!window.__dolaCoreLoaded, "
                "cap: !!window.__dolaCaptorLoaded, href: location.href, "
                "title: document.title || '', ready: document.readyState }))()"
            ) or {}
        except Exception as exc:
            log_warn(f"{log_prefix}: flags poll {n} err: {exc}")
            time.sleep(0.3)
            continue
        if isinstance(last, dict):
            if _is_error_page(str(last.get("href") or "")):
                log_error(f"{log_prefix}: error page during flags wait: {last}")
                return last
            if last.get("bridge") and last.get("s15") and last.get("core") and last.get("cap"):
                log(f"{log_prefix}: all flags ok after poll={n}: {last}")
                return last
            if n % 5 == 0:
                log_debug(f"{log_prefix}: flags poll {n}: {last}")
        time.sleep(0.25)
    log_warn(f"{log_prefix}: flags incomplete after {timeout}s: {last}")
    return last if isinstance(last, dict) else {}


def inject_all(window, scripts: list[tuple[str, str]], log_prefix: str = "inject") -> bool:
    """Inject scripts one-by-one via safe deferred script-tag path."""
    ok_all = True
    log_step(f"{log_prefix}-begin", f"count={len(scripts)}")

    try:
        href = window.evaluate_js("(() => location.href)()")
        log_debug(f"{log_prefix}: pre-href={href!r}")
        if _is_error_page(str(href or "")):
            log_error(f"{log_prefix}: on error page, skip inject href={href}")
            return False
    except Exception as exc:
        log_warn(f"{log_prefix}: pre-href failed: {exc}")

    for name, source in scripts:
        t0 = time.time()
        try:
            result = inject_one(window, name, source, log_prefix=log_prefix)
            if not (isinstance(result, dict) and result.get("ok")):
                ok_all = False
                log_error(f"{log_prefix}: {name} not ok: {result!r}")
        except Exception as exc:
            ok_all = False
            log_exc(f"{log_prefix}: {name} failed after {time.time() - t0:.2f}s", exc)
            try:
                href = window.evaluate_js("(() => location.href)()")
                log_error(f"{log_prefix}: after-fail href={href!r}")
                if _is_error_page(str(href or "")) or not href:
                    log_error(f"{log_prefix}: renderer likely crashed; stop inject chain")
                    break
            except Exception as e2:
                log_error(f"{log_prefix}: cannot evaluate after fail ({e2}); stop inject chain")
                break
        time.sleep(0.08)

    # Scripts are deferred — wait for markers
    flags = wait_inject_flags(window, timeout=10.0, log_prefix=log_prefix)
    log(f"{log_prefix}: flags={flags}")
    if _is_error_page(str((flags or {}).get("href") or "")):
        ok_all = False
        log_error(f"{log_prefix}: still on error page after inject")
    for key in ("bridge", "s15", "core", "cap"):
        if not (flags or {}).get(key):
            ok_all = False
            log_warn(f"{log_prefix}: flag missing: {key}")

    # Host messages stay in a JS queue. Never call or wrap the native
    # chrome.webview.postMessage channel: pywebview owns it for internal RPC.
    try:
        enable = window.evaluate_js(
            "(() => { return { queueOnly: true, q: (window.__dolaMsgQueue||[]).length, "
            "href: location.href, title: document.title || '' }; })()"
        )
        log(f"{log_prefix}: host-bridge enabled: {enable}")
        if isinstance(enable, dict) and _is_error_page(str(enable.get("href") or "")):
            ok_all = False
            log_error(f"{log_prefix}: error page after enable host")
    except Exception as exc:
        ok_all = False
        log_exc(f"{log_prefix}: enable host / alive check failed", exc)
    log_step(f"{log_prefix}-end", f"ok={ok_all}")
    return ok_all


def drain_js_queue(window, api: "HostApi", log_prefix: str = "queue") -> int:
    """Pull queued JS messages without JS→Python re-entrancy during evaluate."""
    try:
        batch = window.evaluate_js(
            "(() => { const q = window.__dolaMsgQueue || []; "
            "window.__dolaMsgQueue = []; return q.slice(0, 50); })()"
        )
    except Exception as exc:
        log_debug(f"{log_prefix}: drain failed: {exc}")
        return 0
    if not isinstance(batch, list) or not batch:
        return 0
    for item in batch:
        try:
            api.on_message(item)
        except Exception as exc:
            log_warn(f"{log_prefix}: handle item failed: {exc}")
    return len(batch)


def _profile_lock_hint(storage: Path) -> list[str]:
    """Best-effort check for other WebView instances locking this profile."""
    hints: list[str] = []
    lock_candidates = [
        storage / "EBWebView" / "Default" / "LockFile",
        storage / "EBWebView" / "lockfile",
        storage / "EBWebView" / "SingletonLock",
    ]
    for p in lock_candidates:
        try:
            if p.exists():
                hints.append(f"exists:{p} size={p.stat().st_size}")
        except Exception as exc:
            hints.append(f"check-failed:{p}: {exc}")
    return hints


def _available_session_profiles(profiles_dir: Path, current_account: str) -> list[str]:
    """Return logged-in, unlocked profiles that can safely back a new window."""
    available: list[str] = []
    for name in list_accounts(profiles_dir):
        if name == current_account:
            continue
        storage = profile_dir(name, profiles_dir)
        if _profile_lock_hint(storage):
            log_debug(f"new-tab skip locked profile={name}")
            continue
        try:
            cookies = load_cookies_from_webview2_profile(storage)
            related = filter_dola_related(cookies) or cookies
            if has_session(related):
                available.append(name)
            else:
                log_debug(f"new-tab skip no-session profile={name}")
        except Exception as exc:
            log_warn(f"new-tab skip unreadable profile={name}: {exc}")
    return available


def run_shell(
    account_id: str,
    profiles_dir: Path,
    out_dir: Path,
    url: str = DEFAULT_URL,
    *,
    require_session: bool = True,
    auto: bool = False,
    prompt: str = "",
    files: list[str] | None = None,
    duration: int = 15,
    aspect_ratio: str = "9:16",
    model: str = "",
    timeout: float = 600,
    close_after: bool = False,
    cookie_test: bool = False,
) -> int:
    account_id = safe_account_id(account_id)
    storage = profile_dir(account_id, profiles_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    log_step(
        "run_shell",
        f"account={account_id} auto={auto} close_after={close_after} cookie_test={cookie_test}",
    )
    log(f"account={account_id}")
    log(f"storage={storage}")
    log(f"url={url}")
    log(f"download out={out_dir}")
    log(f"log file={get_log_path()}")

    lock_hints = _profile_lock_hint(storage)
    if lock_hints:
        log_warn(f"profile lock candidates: {lock_hints}")
    else:
        log_debug("no profile lock files detected")

    try:
        scripts = load_inject_scripts()
    except Exception as exc:
        log_exc("load_inject_scripts failed", exc)
        raise

    pending_cookie_import: list[dict] = []
    cookie_file_used: Path | None = None
    try:
        ck = load_cookies_from_webview2_profile(storage)
        related = filter_dola_related(ck) or ck
        sess = has_session(related)
        names = sorted({c.get("name") or c.get("Name") or "?" for c in (related or [])})[:40]
        log(f"session_cookies={'yes' if sess else 'NO'} total_ck={len(ck or [])} dola_ck={len(related or [])}")
        log_debug(f"cookie names sample: {names}")
    except Exception as exc:
        log_exc("cookie load failed", exc)
        sess = False
        if require_session:
            raise

    # Profile never opened before → no WebView session, but G:\cookies\dola may have Netscape export.
    # Import those cookies into WebView2 after the window starts (fixes "open then flash-close").
    # Refresh from the account cookie file whenever it exists. A profile DB can
    # contain stale session rows that WebView2 drops as soon as Dola loads.
    if not sess or find_account_cookie_file(account_id, DEFAULT_COOKIE_POOL):
        cookie_file_used = find_account_cookie_file(account_id, DEFAULT_COOKIE_POOL)
        file_ck = load_account_netscape_cookies(account_id, DEFAULT_COOKIE_POOL)
        file_rel = filter_dola_related(file_ck) or file_ck
        file_sess = has_session(file_rel)
        log(
            f"netscape cookie file={cookie_file_used} "
            f"count={len(file_ck)} session={'yes' if file_sess else 'NO'}"
        )
        if file_sess:
            pending_cookie_import = list(file_rel or file_ck)
            sess = True
            log(f"will refresh {len(pending_cookie_import)} cookies from file into WebView profile")
        elif file_ck:
            log_warn("cookie file exists but has no sessionid/sid_* — may need re-login/export")

    log("inject scripts: " + ", ".join(n for n, _ in scripts))
    if require_session and not sess:
        msg = (
            f"账号 {account_id} 没有可用登录态。\n"
            f"  WebView profile: {storage}\n"
            f"  Cookie 文件: {cookie_file_used or (DEFAULT_COOKIE_POOL / f'dola_{account_id}.txt')}\n"
            "请先用「打开 WebView 登录」登录并导出 cookie，或把有效的 dola_<账号>.txt 放到 G:\\cookies\\dola。"
        )
        log_error(msg)
        raise SystemExit(msg)

    # IMPORTANT: never call window.evaluate_js from threading.Timer — it crashes WebView2
    # and the window appears to "open then instantly close".
    inject_lock = threading.Lock()
    holder: dict = {
        "window": None,
        "injected": False,
        "auto_running": False,
        "pending_inject": False,
        "last_inject_url": "",
        "loaded_count": 0,
        "started_at": time.time(),
        "injecting": False,
        "cookie_import": list(pending_cookie_import),
    }

    def update_window_title() -> None:
        w = holder.get("window")
        title = window_title_for(account_id)
        if not w:
            return
        try:
            # pywebview Window.set_title if available
            if hasattr(w, "set_title"):
                w.set_title(title)
            else:
                w.title = title  # type: ignore[attr-defined]
        except Exception as exc:
            log_debug(f"set_title failed: {exc}")

    def on_credit_change(bal: dict) -> None:
        log(
            f"积分变更 account={account_id} remaining={bal.get('remaining')}/{bal.get('limit')} "
            f"spent={bal.get('spent')}"
        )
        update_window_title()

    try:
        mark_profile_used(account_id, reason="inject-shell")
    except Exception as exc:
        log_debug(f"mark_profile_used: {exc}")

    api = HostApi(
        out_dir,
        account_id=account_id,
        on_title_update=update_window_title,
        on_credit_change=on_credit_change,
    )
    log(f"今日积分: {window_title_for(account_id)}")

    def recover_if_error_page(w, reason: str = "") -> bool:
        """If renderer crashed to Edge error page, reload /chat. Returns True if recovered."""
        try:
            href = w.evaluate_js("(() => location.href)()") or ""
        except Exception as exc:
            log_warn(f"recover check failed ({reason}): {exc}")
            href = ""
        if not _is_error_page(str(href)) and "dola.com" in str(href):
            return False
        log_error(f"error/crash page detected ({reason}): href={href!r} → reload /chat")
        try:
            w.load_url(DEFAULT_URL)
        except Exception as exc:
            log_exc("recover load_url failed", exc)
            return False
        for i in range(40):
            time.sleep(0.5)
            try:
                href2 = w.evaluate_js("(() => location.href)()") or ""
                if "dola.com" in str(href2) and not _is_error_page(str(href2)):
                    log(f"recover ok i={i}: {href2}")
                    time.sleep(1.0)
                    return True
            except Exception:
                pass
        log_error("recover failed: still not on dola.com")
        return False

    def do_inject(reason: str = "") -> bool:
        w = holder.get("window")
        if not w:
            log_warn(f"do_inject skipped (no window) reason={reason}")
            return False
        if holder.get("auto_running") and reason.startswith("loaded"):
            log_debug(f"do_inject skip during auto reason={reason}")
            return False
        if not inject_lock.acquire(blocking=False):
            log_warn(f"do_inject skip (already injecting) reason={reason}")
            return False
        holder["injecting"] = True
        try:
            log_step("do_inject", reason)
            # Page must be settled; inject into half-loaded SPA crashes renderer
            time.sleep(0.4)
            recover_if_error_page(w, f"pre-{reason}")
            ok = inject_all(w, scripts, log_prefix=f"inject[{reason}]")
            if not ok:
                if recover_if_error_page(w, f"post-{reason}"):
                    log("retry inject after recover")
                    time.sleep(0.8)
                    ok = inject_all(w, scripts, log_prefix=f"inject[{reason}-retry]")
            holder["injected"] = ok
            try:
                holder["last_inject_url"] = w.get_current_url() or ""
                log_debug(f"last_inject_url={holder['last_inject_url']}")
            except Exception as exc:
                log_debug(f"get_current_url after inject: {exc}")
            return ok
        finally:
            holder["injecting"] = False
            inject_lock.release()

    def on_loaded():
        """Mark that inject is needed; actual inject runs on GUI thread via poller."""
        holder["loaded_count"] = int(holder.get("loaded_count") or 0) + 1
        try:
            u = holder["window"].get_current_url() if holder.get("window") else ""
        except Exception as exc:
            u = f"<err:{exc}>"
        log(f"loaded#{holder['loaded_count']}: {u}")
        # Skip during active inject / auto; also ignore chrome-error pages
        if holder.get("injecting") or holder.get("auto_running"):
            log_debug("loaded during inject/auto — no pending")
            return
        if u and "dola.com" in str(u) and not _is_error_page(str(u)):
            holder["pending_inject"] = True
            log_debug("pending_inject=True")

    result_box: dict = {"result": None, "error": None}

    def after_start():
        log_step("after_start", "GUI thread callback entered")
        w = holder.get("window")
        if not w:
            log_error("after_start: window is None — abort")
            return
        # wait until evaluate works and SPA root exists
        for i in range(60):
            try:
                st = w.evaluate_js(
                    "(() => ({ href: location.href, ready: document.readyState, "
                    "hasBody: !!document.body, title: document.title || '' }))()"
                )
                if isinstance(st, dict) and st.get("href") and st.get("hasBody"):
                    log(f"webview ready i={i}: {st}")
                    if _is_error_page(str(st.get("href") or "")):
                        recover_if_error_page(w, "warm-up")
                        continue
                    # SPA needs a beat after body
                    if st.get("ready") == "complete" or i >= 3:
                        break
            except Exception as exc:
                if i % 5 == 0:
                    log(f"warm-up {i}: {type(exc).__name__}: {exc}")
            time.sleep(0.4)
        else:
            log_warn("warm-up exhausted without ready body; continue anyway")

        try:
            title = w.get_current_url()
            log(f"current_url after warm-up: {title}")
        except Exception as exc:
            log_debug(f"get_current_url: {exc}")

        # Import Netscape cookies into this (possibly fresh) WebView2 profile
        import_list = list(holder.get("cookie_import") or [])
        if import_list:
            log_step("cookie-import", f"count={len(import_list)}")
            try:
                n = apply_cookies_to_webview_window(w, import_list, navigate_url=url)
                log(f"cookie-import applied={n}; navigation issued on UI thread")
                holder["cookie_import"] = []
                # Wait for page after navigation
                ready = False
                for i in range(50):
                    time.sleep(0.5)
                    try:
                        st = w.evaluate_js(
                            "(() => ({ href: location.href, ready: document.readyState, "
                            "hasBody: !!document.body, title: document.title||'' }))()"
                        )
                        if isinstance(st, dict) and st.get("hasBody") and "dola.com" in str(st.get("href") or ""):
                            if st.get("ready") in ("interactive", "complete") or i >= 4:
                                log(f"post-import ready i={i}: {st}")
                                ready = True
                                break
                    except Exception as exc:
                        if i % 5 == 0:
                            log_debug(f"post-import warm {i}: {exc}")
                if not ready:
                    log_warn("post-import page wait incomplete; continue to inject anyway")
                time.sleep(1.0)
                live_cookies = expand_cookies(w.get_cookies() or [])
                live_related = filter_dola_related(live_cookies) or live_cookies
                live_session = has_session(live_related)
                live_names = sorted(
                    {c.get("name") or c.get("Name") or "?" for c in live_related}
                )[:40]
                log(
                    f"post-import session={'yes' if live_session else 'NO'} "
                    f"total_ck={len(live_cookies)} dola_ck={len(live_related)}"
                )
                log_debug(f"post-import cookie names sample: {live_names}")
                if require_session and not live_session:
                    raise RuntimeError("cookie import completed but no live Dola session cookie was found")
            except Exception as exc:
                log_exc("cookie-import FAILED", exc)
                if require_session:
                    result_box["error"] = f"cookie import failed: {exc}"
                    log_error(
                        "无法把 G:\\cookies\\dola 的 cookie 写入 WebView；"
                        "请改用「打开 WebView 登录」先登录一次。"
                    )
                    try:
                        w.destroy()
                    except Exception:
                        pass
                    return

        # clear race pending from first loaded event
        holder["pending_inject"] = False
        time.sleep(0.8)
        ok_inject = do_inject("start")
        # Drain any queued JS messages now that inject evaluate chain is idle
        try:
            drained = drain_js_queue(w, api)
            log(f"initial queue drain: {drained}")
        except Exception as exc:
            log_debug(f"initial drain: {exc}")

        # Verify page is still the real chat UI (not crash page)
        try:
            check = w.evaluate_js(
                "(() => ({ href: location.href, title: document.title||'', "
                "bridge: !!window.__dolaBridgeLoaded, s15: !!window.__dola15sLoaded, "
                "core: !!window.__dolaCoreLoaded, cap: !!window.__dolaCaptorLoaded, "
                "bodyText: (document.body && document.body.innerText || '').slice(0, 80) }))()"
            )
            log(f"post-inject page check: {check}")
            body = str((check or {}).get("bodyText") or "")
            if "此页存在问题" in body or "crash" in body.lower() or _is_error_page(str((check or {}).get("href") or "")):
                log_error("page still broken after inject — attempting recover+reinject")
                if recover_if_error_page(w, "post-check") or True:
                    time.sleep(1.5)
                    # force reload even if not chrome-error URL (Chinese error page may keep same URL)
                    try:
                        w.load_url(DEFAULT_URL)
                    except Exception:
                        pass
                    time.sleep(2.5)
                    do_inject("recover")
                    drain_js_queue(w, api)
        except Exception as exc:
            log_exc("post-inject page check failed", exc)

        auth_state = page_state(w)
        if auth_state.get("hasLogin") and not auth_state.get("looksIn"):
            log_error(
                f"account={account_id} cookie rejected by Dola UI; "
                f"page still shows Log In; source={cookie_file_used}"
            )
            try:
                notice = json.dumps(
                    f"账号 {account_id} 的 Cookie 已失效或被 Dola 拒绝。"
                    "请返回启动器，使用“打开 WebView 登录”重新登录并导出 Cookie。",
                    ensure_ascii=False,
                )
                w.evaluate_js(
                    "(() => {"
                    "let el=document.getElementById('__dola_cookie_invalid');"
                    "if(!el){el=document.createElement('div');"
                    "el.id='__dola_cookie_invalid';document.body.appendChild(el);}"
                    f"el.textContent={notice};"
                    "Object.assign(el.style,{position:'fixed',left:'16px',right:'16px',top:'16px',"
                    "zIndex:'2147483647',padding:'12px 16px',borderRadius:'10px',"
                    "background:'#b42318',color:'#fff',fontSize:'15px',fontWeight:'600',"
                    "boxShadow:'0 8px 30px rgba(0,0,0,.28)',textAlign:'center'});"
                    "return true;})()"
                )
            except Exception as exc:
                log_debug(f"invalid-cookie notice failed: {exc}")

        if cookie_test:
            try:
                live_cookies = expand_cookies(w.get_cookies() or [])
                live_related = filter_dola_related(live_cookies) or live_cookies
                live_session = has_session(live_related)
                ui_state = page_state(w)
                ui_logged_in = bool(ui_state.get("looksIn")) and not bool(ui_state.get("hasLogin"))
                log(f"COOKIE_TEST page_state={ui_state}")
                log(
                    f"COOKIE_TEST account={account_id} "
                    f"cookies={'PASS' if live_session else 'FAIL'} "
                    f"ui={'PASS' if ui_logged_in else 'FAIL'} "
                    f"inject={'PASS' if ok_inject else 'FAIL'} "
                    f"total_ck={len(live_cookies)} dola_ck={len(live_related)}"
                )
                if require_session and not live_session:
                    raise RuntimeError("no live Dola session cookie")
                if require_session and not ui_logged_in:
                    raise RuntimeError("Dola rejected the session: the page still shows Log In")
                if not ok_inject:
                    raise RuntimeError("page script injection failed")
                result_box["result"] = {
                    "account": account_id,
                    "session": bool(live_session),
                    "uiLoggedIn": bool(ui_logged_in),
                    "injected": bool(ok_inject),
                    "cookies": len(live_related),
                }
            except Exception as exc:
                result_box["error"] = f"cookie test failed: {exc}"
                log_exc("COOKIE_TEST FAILED", exc)
            finally:
                try:
                    w.destroy()
                except Exception as exc:
                    log_debug(f"cookie-test destroy: {exc}")
            return

        if not auto:
            log("就绪：窗口会一直开着，请手动操作。")
            log(f"inject_ok={ok_inject}")
            log("操作：视频生成 → 传图(可空) → 时长选15s → 发提示词 → 点「⬇ 下载视频」")
            log("若看不到下载按钮：菜单 Dola注入 → 重新注入脚本")
            log(f"详细日志文件: {get_log_path()}")
            # Keep GUI thread alive: poll pending inject + drain JS message queue.
            # IMPORTANT: do not call evaluate_js from Timer threads.
            poll_n = 0
            while True:
                poll_n += 1
                try:
                    cur = w.get_current_url()
                except Exception as exc:
                    log_warn(f"window gone; stop keep-alive poller: {exc}")
                    break
                # Drain JS queue via evaluate (Python-initiated) — safe, no deadlock
                if not holder.get("injecting"):
                    try:
                        n = drain_js_queue(w, api)
                        if n:
                            log_debug(f"drained {n} js messages")
                    except Exception as exc:
                        log_debug(f"drain err: {exc}")
                if poll_n % 15 == 0:
                    # heartbeat ~12s + page health
                    try:
                        health = w.evaluate_js(
                            "(() => ({ href: location.href, title: (document.title||'').slice(0,40), "
                            "bridge: !!window.__dolaBridgeLoaded, "
                            "errText: /此页存在问题|Aw, Snap|crash/i.test(document.body&&document.body.innerText||'') }))()"
                        )
                    except Exception as exc:
                        health = {"error": str(exc)}
                    log(
                        f"heartbeat poll={poll_n} url={cur!r} health={health} "
                        f"injected={holder.get('injected')} msgs={api.message_count} "
                        f"downloads={len(api.downloads)} "
                        f"uptime={time.time() - holder['started_at']:.0f}s"
                    )
                    if isinstance(health, dict) and health.get("errText"):
                        log_error("heartbeat detected error page — recover")
                        try:
                            w.load_url(DEFAULT_URL)
                            time.sleep(2.0)
                            do_inject("heartbeat-recover")
                        except Exception as exc:
                            log_exc("heartbeat recover failed", exc)
                    elif isinstance(health, dict) and not health.get("bridge") and "dola.com" in str(health.get("href") or ""):
                        log_warn("bridge flag lost — reinject")
                        do_inject("heartbeat-reinject")
                if holder.get("pending_inject") and not holder.get("auto_running") and not holder.get("injecting"):
                    holder["pending_inject"] = False
                    log("pending inject after navigation")
                    time.sleep(0.8)
                    do_inject("nav")
                time.sleep(0.8)
            log_step("manual-poller-exit")
            return

        # ---- auto generate + download (WebView, no CDP) ----
        if not (prompt or "").strip():
            result_box["error"] = "--auto requires --prompt"
            log_error(result_box["error"])
            return
        try:
            from video_flow import run_video_generation

            holder["auto_running"] = True
            holder["pending_inject"] = False
            log_step(
                "auto-start",
                f"duration={duration}s ratio={aspect_ratio} "
                f"refs={len(files or [])} timeout={timeout}s model={model or '-'}",
            )
            for i, f in enumerate(files or []):
                p = Path(f)
                log(f"  ref[{i}]={f} exists={p.is_file()} size={p.stat().st_size if p.is_file() else 0}")
            log(f"  prompt={prompt[:200]!r}")
            time.sleep(1.0)
            do_inject("pre-auto")
            result = run_video_generation(
                w,
                prompt=prompt,
                ref_paths=list(files or []),
                duration=int(duration),
                aspect_ratio=aspect_ratio,
                model=model,
                out_dir=out_dir,
                timeout=float(timeout),
                log=log,
                close_when_done=False,
            )
            result_box["result"] = result
            log_step("auto-DONE", f"file={result.get('file')} size={result.get('size')}")
            # Auto gen success → spend credits for this duration
            try:
                api.last_video_duration = int(duration)
                api._spent_for_submit_at = 0  # force allow spend
                api._maybe_spend_video_credit(int(duration), reason="auto-video")
            except Exception as exc:
                log_debug(f"auto credit spend: {exc}")
            print(json.dumps(result, ensure_ascii=False, indent=2), flush=True)
            holder["auto_running"] = False
            if close_after:
                log("close_after=True → destroy window")
                try:
                    w.destroy()
                except Exception as exc:
                    log_exc("window.destroy failed", exc)
            else:
                log("auto finished; window stays open for manual download if needed")
                while True:
                    try:
                        _ = w.get_current_url()
                    except Exception as exc:
                        log_warn(f"post-auto poller: window gone: {exc}")
                        break
                    time.sleep(1.0)
        except Exception as exc:
            result_box["error"] = str(exc)
            log_exc("auto FAILED", exc)
            holder["auto_running"] = False
            if close_after:
                log("close_after=True after failure → destroy window")
                try:
                    w.destroy()
                except Exception as dexc:
                    log_exc("window.destroy failed", dexc)
            else:
                log("auto failed; window stays open — use menu 重新注入 / 手动操作")
                while True:
                    try:
                        _ = w.get_current_url()
                    except Exception:
                        break
                    time.sleep(1.0)

    def menu_reinject():
        log_step("menu", "重新注入脚本")
        do_inject("menu")

    def menu_open_out():
        import os
        import subprocess

        log_step("menu", f"打开下载目录 {out_dir}")
        os.makedirs(out_dir, exist_ok=True)
        try:
            os.startfile(str(out_dir))  # type: ignore[attr-defined]
        except Exception:
            subprocess.Popen(["explorer", str(out_dir)])

    def menu_home():
        w = holder.get("window")
        log_step("menu", f"回到 {DEFAULT_URL}")
        if w:
            try:
                w.load_url(DEFAULT_URL)
            except Exception as exc:
                log_exc("load_url home failed", exc)

    def menu_show_log():
        import os
        import subprocess

        lp = get_log_path()
        log_step("menu", f"打开日志 {lp}")
        if lp and lp.is_file():
            try:
                os.startfile(str(lp))  # type: ignore[attr-defined]
            except Exception:
                subprocess.Popen(["notepad", str(lp)])
        else:
            log_warn("log file not found")

    def menu_refresh():
        w = holder.get("window")
        log_step("menu", "刷新页面")
        if not w:
            return
        try:
            cur = ""
            try:
                cur = w.get_current_url() or ""
            except Exception:
                pass
            target = cur if (cur and "dola.com" in cur and not _is_error_page(cur)) else DEFAULT_URL
            w.load_url(target)
            holder["pending_inject"] = True
        except Exception as exc:
            log_exc("refresh failed", exc)

    def menu_show_credits():
        try:
            bal = get_balance(account_id)
            msg = (
                f"账号: {account_id}\n"
                f"今日剩余积分: {bal.get('remaining')}/{bal.get('limit')}\n"
                f"已用: {bal.get('spent')}\n"
                f"计费: 5s=1 / 10s=2 / 15s=3（每日上限 {DAILY_CREDIT_LIMIT}）"
            )
            log(msg.replace("\n", " | "))
            print(msg, flush=True)
            update_window_title()
        except Exception as exc:
            log_exc("show credits failed", exc)

    def _open_profile_process(target_account: str) -> None:
        """Open another independent inject shell for a different profile."""
        target_account = safe_account_id(target_account)
        if target_account == account_id:
            log("already this account")
            return
        py = sys.executable
        cmd = [
            py,
            "-u",
            str(Path(__file__).resolve()),
            "--account",
            target_account,
            "--profiles",
            str(profiles_dir),
            "--out",
            str(out_dir),
            "--url",
            DEFAULT_URL,
            "--log-dir",
            str(get_log_path().parent if get_log_path() else ROOT / "logs"),
        ]
        log_step("open-profile", f"{target_account} cmd={' '.join(cmd)}")
        try:
            subprocess.Popen(cmd, cwd=str(ROOT))
        except Exception as exc:
            log_exc(f"open profile {target_account} failed", exc)

    def _make_account_menu_actions() -> list:
        actions = []
        try:
            # show all profiles with session
            for name in list_accounts(profiles_dir):
                try:
                    ck = load_cookies_from_webview2_profile(profile_dir(name, profiles_dir))
                    if not has_session(filter_dola_related(ck) or ck):
                        continue
                except Exception:
                    continue
                try:
                    bal = get_balance(name)
                    rem = int(bal.get("remaining") or 0)
                    lim = int(bal.get("limit") or DAILY_CREDIT_LIMIT)
                    label = f"{name}  积分 {rem}/{lim}"
                except Exception:
                    label = f"{name}  积分 ?/{DAILY_CREDIT_LIMIT}"
                if name == account_id:
                    label = f"● {label}  (当前)"
                    actions.append(webview.menu.MenuAction(label, menu_show_credits))
                else:
                    # bind name correctly in closure
                    def _open(n=name):
                        _open_profile_process(n)

                    actions.append(webview.menu.MenuAction(label, _open))
        except Exception as exc:
            log_warn(f"account menu build failed: {exc}")
        if not actions:
            actions.append(webview.menu.MenuAction("(无可用账号)", lambda: None))
        return actions

    log_step("create_window", f"title={window_title_for(account_id)} storage={storage}")
    try:
        window = webview.create_window(
            title=window_title_for(account_id),
            url=url,
            width=1360,
            height=900,
            text_select=True,
            # Manual mode protects against accidental close. In auto mode this
            # would also intercept programmatic destroy() with a confirmation
            # dialog, leaving the Python/WebView2 processes alive after success.
            confirm_close=not (auto or cookie_test),
            js_api=api,
        )
    except Exception as exc:
        log_exc("webview.create_window FAILED", exc)
        raise

    holder["window"] = window
    try:
        window.events.loaded += on_loaded
        log_debug("bound window.events.loaded")
    except Exception as exc:
        log_exc("bind loaded event failed", exc)

    # closing / closed if available
    try:
        if hasattr(window.events, "closing"):

            def on_closing():
                log_step("event", "closing (user or destroy)")
                return True  # allow close; confirm_close still prompts

            window.events.closing += on_closing
        if hasattr(window.events, "closed"):

            def on_closed():
                log_step("event", "closed")

            window.events.closed += on_closed
    except Exception as exc:
        log_debug(f"bind close events: {exc}")

    menu = [
        webview.menu.Menu(
            "Dola注入",
            [
                webview.menu.MenuAction("刷新页面", menu_refresh),
                webview.menu.MenuAction("重新注入脚本", menu_reinject),
                webview.menu.MenuAction("打开下载目录", menu_open_out),
                webview.menu.MenuAction("打开日志文件", menu_show_log),
                webview.menu.MenuAction("回到 /chat", menu_home),
                webview.menu.MenuAction("查看今日积分", menu_show_credits),
            ],
        ),
        webview.menu.Menu("账号", _make_account_menu_actions()),
    ]

    log_step("webview.start", "gui=edgechromium private_mode=False")
    log(f"starting WebView (manual mode keeps window open until you close it); log={get_log_path()}")
    t_start = time.time()
    try:
        webview.start(
            after_start,
            gui="edgechromium",
            debug=False,
            private_mode=False,
            storage_path=str(storage),
            menu=menu,
            user_agent=(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36 Edg/150.0.0.0"
            ),
        )
    except Exception as exc:
        log_exc("webview.start CRASHED", exc)
        raise
    finally:
        log_step(
            "webview.exited",
            f"uptime={time.time() - t_start:.1f}s downloads={len(api.downloads)} "
            f"host_msgs={api.message_count} loaded_events={holder.get('loaded_count')}",
        )

    log(f"shell closed; downloads={len(api.downloads)}")
    if api.downloads:
        print(json.dumps({"downloads": api.downloads}, ensure_ascii=False, indent=2))
        log(f"downloads detail: {json.dumps(api.downloads, ensure_ascii=False)}")
    if (auto or cookie_test) and result_box.get("error"):
        log_error(f"exit code 1: {result_box['error']}")
        return 1
    if (auto or cookie_test) and not result_box.get("result"):
        log_error("exit code 2: no result (window closed early?)")
        return 2
    log("exit code 0")
    return 0


def main(argv: list[str] | None = None) -> int:
    argv = list(argv if argv is not None else sys.argv[1:])
    # Parse --log-dir early so setup happens before anything else
    log_dir = ROOT / "logs"
    filtered: list[str] = []
    i = 0
    while i < len(argv):
        if argv[i] == "--log-dir" and i + 1 < len(argv):
            log_dir = Path(argv[i + 1])
            i += 2
            continue
        if argv[i].startswith("--log-dir="):
            log_dir = Path(argv[i].split("=", 1)[1])
            i += 1
            continue
        filtered.append(argv[i])
        i += 1
    argv = filtered

    log_path = setup_logging("inject_shell", log_dir=log_dir)
    log_env(extra={"log_dir": str(log_dir), "log_path": str(log_path)})

    p = argparse.ArgumentParser(description="Dola WebView inject shell (15s + no-watermark download)")
    p.add_argument("--account", "-a", help="Profile name under profiles/")
    p.add_argument("--profiles", default=str(DEFAULT_PROFILES))
    p.add_argument("--accounts", help="google_mail.txt to resolve --index")
    p.add_argument("--index", type=int, default=0)
    p.add_argument("--out", default=str(DEFAULT_OUT), help="Download directory")
    p.add_argument("--url", default=DEFAULT_URL)
    p.add_argument("--allow-no-session", action="store_true", help="Open even without session cookies")
    p.add_argument("--list", action="store_true", help="List profiles and exit")
    p.add_argument("--auto", action="store_true", help="Auto: 视频生成 → attach 0-n → prompt → send → download")
    p.add_argument("--prompt", default="", help="Required with --auto")
    p.add_argument("--file", "--reference-image", action="append", dest="files", default=[], help="0-n ref images")
    p.add_argument("--duration", type=int, default=15, choices=[5, 10, 15])
    p.add_argument("--aspect-ratio", default="9:16")
    p.add_argument("--model", default="")
    p.add_argument("--timeout", type=float, default=600)
    p.add_argument("--close", action="store_true", help="Close window after --auto finishes")
    p.add_argument(
        "--cookie-test",
        action="store_true",
        help="Import/verify the account session cookie, then close without generating anything",
    )
    p.add_argument("--log-dir", default=str(log_dir), help="Directory for detailed log files")
    args = p.parse_args(argv)

    log(f"parsed args: {vars(args)}")

    profiles = Path(args.profiles)
    if args.list:
        print(f"# 视频积分: 每号每天 {DAILY_CREDIT_LIMIT}（5s=1 / 10s=2 / 15s=3）")
        print(f"# {'账号':<22}  {'积分(剩/总)':<12}  session  path")
        for name in list_accounts(profiles):
            storage = profile_dir(name, profiles)
            try:
                ck = load_cookies_from_webview2_profile(storage)
                sess = has_session(filter_dola_related(ck) or ck)
            except Exception as exc:
                sess = False
                log_debug(f"list {name}: cookie err {exc}")
            try:
                bal = get_balance(name)
                credit = f"{bal.get('remaining')}/{bal.get('limit')}"
            except Exception:
                credit = f"?/{DAILY_CREDIT_LIMIT}"
            line = f"{name:<22}  {credit:<12}  session={'yes' if sess else 'no'}  {storage}"
            print(line)
            log(line)
        return 0

    account_id = args.account or ""
    if args.accounts and not account_id:
        rows = parse_accounts_file(args.accounts)
        if args.index < 0 or args.index >= len(rows):
            raise SystemExit(f"--index out of range")
        email, _ = rows[args.index]
        account_id = account_id_from_email(email)
        log(f"accounts index={args.index} email={email} -> {account_id}")
    if not account_id:
        accs = list_accounts(profiles)
        log(f"available profiles ({len(accs)}): {accs}")
        picked = ""
        for name in accs:
            try:
                ck = load_cookies_from_webview2_profile(profile_dir(name, profiles))
                if has_session(filter_dola_related(ck) or ck):
                    picked = name
                    break
            except Exception as exc:
                log_debug(f"session check {name}: {exc}")
        account_id = picked or (accs[0] if accs else "")
        if not account_id:
            raise SystemExit("no profiles; login first")
        log(f"auto-picked account={account_id}")

    if args.auto and not (args.prompt or "").strip():
        raise SystemExit("--auto requires --prompt")
    files = [str(Path(f).resolve()) for f in (args.files or [])]
    for f in files:
        if not Path(f).is_file():
            raise SystemExit(f"file not found: {f}")

    try:
        return run_shell(
            account_id=account_id,
            profiles_dir=profiles,
            out_dir=Path(args.out),
            url=args.url,
            require_session=not args.allow_no_session,
            auto=bool(args.auto),
            prompt=args.prompt or "",
            files=files,
            duration=int(args.duration),
            aspect_ratio=args.aspect_ratio or "9:16",
            model=args.model or "",
            timeout=float(args.timeout),
            close_after=bool(args.close),
            cookie_test=bool(args.cookie_test),
        )
    except SystemExit:
        raise
    except Exception as exc:
        log_exc("main fatal", exc)
        print(f"FATAL: {exc}\n日志: {get_log_path()}", file=sys.stderr)
        print(traceback.format_exc(), file=sys.stderr)
        return 99


if __name__ == "__main__":
    raise SystemExit(main())
