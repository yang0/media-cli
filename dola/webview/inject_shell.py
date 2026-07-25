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
import json
import re
import sys
import threading
import time
import urllib.request
from datetime import datetime
from pathlib import Path
from urllib.parse import unquote, urlparse

import webview

from cookie_util import filter_dola_related, has_session, load_cookies_from_webview2_profile
from dola_webview import (
    DEFAULT_PROFILES,
    account_id_from_email,
    list_accounts,
    log,
    profile_dir,
    safe_account_id,
)
from login_flow import parse_accounts_file

ROOT = Path(__file__).resolve().parent
INJECT_DIR = ROOT / "inject"
DEFAULT_OUT = ROOT.parent / "cli" / "downloads" / "inject"
DEFAULT_URL = "https://www.dola.com/chat"

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
        scripts.append((name, path.read_text(encoding="utf-8", errors="replace")))
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
    """JS → Python bridge for download / logging."""

    def __init__(self, out_dir: Path):
        self.out_dir = out_dir
        self.out_dir.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self.downloads: list[dict] = []

    def on_message(self, payload):
        """Called from bridge.js with JSON string or dict-like."""
        try:
            if isinstance(payload, str):
                data = json.loads(payload)
            elif isinstance(payload, dict):
                data = payload
            else:
                data = json.loads(str(payload))
        except Exception as exc:
            log(f"host message parse failed: {exc} raw={str(payload)[:200]}")
            return {"ok": False, "error": "bad-json"}

        msg_type = data.get("type") or data.get("Type") or ""
        if msg_type == "download":
            return self._handle_download(data)
        if msg_type == "newResource":
            # capture stream — also auto-save video/image if URL present
            inner = data.get("data") or {}
            url = inner.get("url") or data.get("url")
            if url and inner.get("type") in ("video", "image"):
                fname = inner.get("filename") or f"dola_{inner.get('type')}_{int(time.time())}"
                return self._handle_download({"url": url, "filename": fname, "type": inner.get("type")})
            log(f"capture: {json.dumps(inner, ensure_ascii=False)[:180]}")
            return {"ok": True, "ignored": True}
        if msg_type in ("pageChanged", "videoUrlUpdate", "videoDataExtracted"):
            log(f"event: {msg_type}")
            return {"ok": True}
        log(f"host message: {msg_type} {json.dumps(data, ensure_ascii=False)[:160]}")
        return {"ok": True}

    def _handle_download(self, data: dict) -> dict:
        url = data.get("url") or ""
        if not url or not str(url).startswith("http"):
            log(f"download skipped bad url: {url!r}")
            return {"ok": False, "error": "bad-url"}
        filename = data.get("filename") or f"dola_{int(time.time())}"
        filename = safe_filename(str(filename))
        if "." not in filename:
            filename = f"{filename}.{guess_ext(url)}"
        out_path = self.out_dir / filename
        # avoid overwrite
        if out_path.exists():
            stem, suf = out_path.stem, out_path.suffix
            out_path = self.out_dir / f"{stem}_{int(time.time())}{suf}"
        try:
            log(f"download start -> {out_path.name}")
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
            if out_path.suffix == ".bin":
                out_path = out_path.with_suffix("." + guess_ext(url, ctype))
            with self._lock:
                out_path.write_bytes(body)
                rec = {
                    "file": str(out_path),
                    "url": url[:200],
                    "bytes": len(body),
                    "at": datetime.now().isoformat(timespec="seconds"),
                }
                self.downloads.append(rec)
            log(f"download ok {out_path} ({len(body)} bytes)")
            return {"ok": True, "file": str(out_path), "bytes": len(body)}
        except Exception as exc:
            log(f"download failed: {exc}")
            return {"ok": False, "error": str(exc)}

    def ping(self) -> str:
        return "pong"


def inject_all(window, scripts: list[tuple[str, str]], log_prefix: str = "inject") -> bool:
    """Inject scripts one-by-one (more reliable than one giant evaluate)."""
    ok_all = True
    for name, source in scripts:
        try:
            # Scripts are self-invoking; wrap so pywebview treats them as expressions.
            expr = f"(function(){{ {source}\n; return '{name}:ok'; }})()"
            result = window.evaluate_js(expr)
            log(f"{log_prefix}: {name} -> {result!r}")
        except Exception as exc:
            ok_all = False
            log(f"{log_prefix}: {name} failed: {exc}")
    # Confirm markers
    try:
        flags = window.evaluate_js(
            "(() => ({ bridge: !!window.__dolaBridgeLoaded, "
            "s15: !!window.__dola15sLoaded, core: !!window.__dolaCoreLoaded, "
            "cap: !!window.__dolaCaptorLoaded }))()"
        )
        log(f"{log_prefix}: flags={flags}")
    except Exception as exc:
        log(f"{log_prefix}: flags failed: {exc}")
        ok_all = False
    return ok_all


def run_shell(
    account_id: str,
    profiles_dir: Path,
    out_dir: Path,
    url: str = DEFAULT_URL,
    *,
    require_session: bool = True,
) -> int:
    account_id = safe_account_id(account_id)
    storage = profile_dir(account_id, profiles_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    scripts = load_inject_scripts()

    ck = load_cookies_from_webview2_profile(storage)
    sess = has_session(filter_dola_related(ck) or ck)
    log(f"account={account_id}")
    log(f"storage={storage}")
    log(f"session_cookies={'yes' if sess else 'NO'}")
    log(f"download out={out_dir}")
    log("inject: bridge + fifteen_seconds + core + capture")
    if require_session and not sess:
        raise SystemExit(
            f"profile has no session: {storage}\n"
            "先用 login_one.cmd / dola_webview.py 登录并导出 cookie，再开注入壳。"
        )

    api = HostApi(out_dir)
    holder: dict = {"window": None, "injected": False}

    def do_inject(reason: str = ""):
        w = holder.get("window")
        if not w:
            return
        ok = inject_all(w, scripts, log_prefix=f"inject[{reason}]")
        holder["injected"] = ok

    def on_loaded():
        try:
            u = holder["window"].get_current_url() if holder.get("window") else ""
        except Exception:
            u = ""
        log(f"loaded: {u}")
        # re-inject after every navigation (SPA soft loads still fire sometimes)
        if u and "dola.com" in u:
            # small delay so SPA root mounts
            threading.Timer(0.8, lambda: do_inject("loaded")).start()
            threading.Timer(2.5, lambda: do_inject("loaded-retry")).start()

    def after_start():
        w = holder.get("window")
        if not w:
            return
        # wait until evaluate works
        for i in range(30):
            try:
                href = w.evaluate_js("(() => location.href)()")
                if href:
                    log(f"webview ready: {str(href)[:100]}")
                    break
            except Exception as exc:
                if i % 5 == 0:
                    log(f"warm-up {i}: {exc}")
            time.sleep(0.4)
        do_inject("start")
        log("就绪：在页面里自己选 视频生成 / 传图 / 发提示词；点「⬇ 下载视频」保存到 out 目录")
        log("时长菜单选 15s（或点我们注入的 15s）；请求会被改成 seedance_v2.0 + duration=15")

    def menu_reinject():
        do_inject("menu")

    def menu_open_out():
        import os
        import subprocess

        os.makedirs(out_dir, exist_ok=True)
        try:
            os.startfile(str(out_dir))  # type: ignore[attr-defined]
        except Exception:
            subprocess.Popen(["explorer", str(out_dir)])

    def menu_home():
        w = holder.get("window")
        if w:
            w.load_url(DEFAULT_URL)

    window = webview.create_window(
        title=f"Dola 注入壳 — {account_id}",
        url=url,
        width=1360,
        height=900,
        text_select=True,
        confirm_close=False,
        js_api=api,
    )
    holder["window"] = window
    window.events.loaded += on_loaded

    menu = [
        webview.menu.Menu(
            "Dola注入",
            [
                webview.menu.MenuAction("重新注入脚本", menu_reinject),
                webview.menu.MenuAction("打开下载目录", menu_open_out),
                webview.menu.MenuAction("回到 /chat", menu_home),
            ],
        )
    ]

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
    log(f"shell closed; downloads={len(api.downloads)}")
    if api.downloads:
        print(json.dumps({"downloads": api.downloads}, ensure_ascii=False, indent=2))
    return 0


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Dola WebView inject shell (15s + no-watermark download)")
    p.add_argument("--account", "-a", help="Profile name under profiles/")
    p.add_argument("--profiles", default=str(DEFAULT_PROFILES))
    p.add_argument("--accounts", help="google_mail.txt to resolve --index")
    p.add_argument("--index", type=int, default=0)
    p.add_argument("--out", default=str(DEFAULT_OUT), help="Download directory")
    p.add_argument("--url", default=DEFAULT_URL)
    p.add_argument("--allow-no-session", action="store_true", help="Open even without session cookies")
    p.add_argument("--list", action="store_true", help="List profiles and exit")
    args = p.parse_args(argv or sys.argv[1:])

    profiles = Path(args.profiles)
    if args.list:
        for name in list_accounts(profiles):
            storage = profile_dir(name, profiles)
            ck = load_cookies_from_webview2_profile(storage)
            sess = has_session(filter_dola_related(ck) or ck)
            print(f"{name}\tsession={'yes' if sess else 'no'}\t{storage}")
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
        # prefer a profile with session
        picked = ""
        for name in accs:
            ck = load_cookies_from_webview2_profile(profile_dir(name, profiles))
            if has_session(filter_dola_related(ck) or ck):
                picked = name
                break
        account_id = picked or (accs[0] if accs else "")
        if not account_id:
            raise SystemExit("no profiles; login first")
        log(f"auto-picked account={account_id}")

    return run_shell(
        account_id=account_id,
        profiles_dir=profiles,
        out_dir=Path(args.out),
        url=args.url,
        require_session=not args.allow_no_session,
    )


if __name__ == "__main__":
    raise SystemExit(main())
