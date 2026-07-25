# -*- coding: utf-8 -*-
"""
Dola WebView2 shell (pywebview / Edge Chromium).

Login first, export cookies only after session is ready.

Usage:
  # Manual login window (menu export after you finish Google login)
  python dola_webview.py --account dola_acc1

  # Auto login with email/password, then export if session ok
  python dola_webview.py --account dola_acc1 --email a@x.com --password secret --auto-login --auto-export

  # Batch from google_mail.txt (one account per run recommended)
  python dola_webview.py --accounts ..\\google_mail.txt --index 0 --auto-login --auto-export
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import threading
import time
from datetime import datetime
from pathlib import Path

import webview

from cookie_util import (
    expand_cookies,
    filter_dola_related,
    has_session,
    load_cookies_from_webview2_profile,
    write_netscape,
)
from login_flow import is_logged_in, page_state, parse_accounts_file, run_google_login

ROOT = Path(__file__).resolve().parent
DEFAULT_PROFILES = ROOT / "profiles"
DEFAULT_COOKIE_OUT = Path(r"G:\cookies\dola")
DEFAULT_URL = "https://www.dola.com/"
STATE_FILE = ROOT / "accounts.json"


def log(msg: str) -> None:
    print(f"[dola-webview] {msg}", flush=True)


def load_state() -> dict:
    if STATE_FILE.exists():
        try:
            return json.loads(STATE_FILE.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {"accounts": {}}


def save_state(state: dict) -> None:
    STATE_FILE.write_text(json.dumps(state, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def safe_account_id(name: str) -> str:
    s = re.sub(r"[^a-zA-Z0-9._-]+", "_", (name or "").strip())
    return s[:48] or f"acc_{int(time.time())}"


def account_id_from_email(email: str) -> str:
    local = (email or "user").split("@", 1)[0]
    return safe_account_id(local)


def profile_dir(account_id: str, base: Path) -> Path:
    p = base / account_id
    p.mkdir(parents=True, exist_ok=True)
    return p


def list_accounts(base: Path) -> list[str]:
    if not base.exists():
        return []
    return sorted([p.name for p in base.iterdir() if p.is_dir()])


def collect_window_cookies(window, profile_path: Path | None = None) -> list[dict]:
    """Prefer live get_cookies(); fall back to decrypting WebView2 profile SQLite."""
    out: list[dict] = []
    try:
        raw = window.get_cookies() or []
        out = expand_cookies(raw)
    except Exception as exc:
        log(f"get_cookies failed: {exc}")
        out = []
    if out and has_session(out):
        return out
    # Profile DB may be locked while WebView is running; still try (works after close / when unlocked)
    if profile_path:
        try:
            from_db = load_cookies_from_webview2_profile(profile_path)
            if from_db:
                if not out:
                    log(f"cookies from profile DB: {len(from_db)}")
                    return from_db
                bag = {(c["domain"], c["name"]): c for c in out}
                for c in from_db:
                    bag[(c["domain"], c["name"])] = c
                out = list(bag.values())
                log(f"merged profile DB cookies -> {len(out)}")
                return out
        except Exception as exc:
            log(f"profile cookie read failed: {exc}")
    return out


def has_session_cookies(window, profile_path: Path | None = None) -> bool:
    """True only when real session cookies exist (sessionid/sid_*/uid_tt)."""
    cookies = collect_window_cookies(window, profile_path)
    related = filter_dola_related(cookies)
    return bool(has_session(cookies) or has_session(related))


def session_ready(window, profile_path: Path | None = None, *, allow_ui_only: bool = False) -> bool:
    """
    Login/export gate.
    Default requires real session cookies — guest chat UI (composer without 登录)
    must NOT count as logged-in (that produced weak cookie exports).
    """
    if has_session_cookies(window, profile_path):
        return True
    if allow_ui_only and is_logged_in(window):
        return True
    return False


def log_cookie_summary(window, profile_path: Path | None = None, prefix: str = "cookies") -> None:
    cookies = collect_window_cookies(window, profile_path)
    names = sorted({c.get("name") or "" for c in cookies if c.get("name")})
    related = filter_dola_related(cookies)
    log(
        f"{prefix}: total={len(cookies)} related={len(related)} "
        f"session={has_session(cookies) or has_session(related)} "
        f"names={names[:40]}"
    )


def export_cookies_from_window(
    window,
    account_id: str,
    out_dir: Path,
    *,
    require_session: bool = True,
    profile_path: Path | None = None,
) -> Path | None:
    """Export only after login when require_session=True."""
    if require_session and not session_ready(window, profile_path):
        log("skip export: not logged in yet (login first)")
        st = page_state(window)
        log(f"page: {st.get('url', '')} body={str(st.get('body', ''))[:160]}")
        return None

    normalized = collect_window_cookies(window, profile_path)
    related = filter_dola_related(normalized)
    export = related if related else normalized
    if not export:
        log("no cookies to export")
        return None

    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"dola_{account_id}.txt"
    write_netscape(out_path, export)
    sess = has_session(export) or has_session(normalized)
    log(f"exported {len(export)} cookie(s) -> {out_path} (session={'yes' if sess else 'weak/missing'})")

    state = load_state()
    state.setdefault("accounts", {})[account_id] = {
        "id": account_id,
        "cookieFile": str(out_path),
        "cookieCount": len(export),
        "hasSession": bool(sess),
        "exportedAt": datetime.now().isoformat(timespec="seconds"),
    }
    save_state(state)
    return out_path


def make_menu(
    window_holder: dict,
    account_id: str,
    out_dir: Path,
    home_url: str,
    creds: dict | None,
    profile_path: Path | None = None,
):
    def do_export():
        w = window_holder.get("window")
        if not w:
            return
        path = export_cookies_from_window(
            w, account_id, out_dir, require_session=True, profile_path=profile_path
        )
        if not path:
            log("export blocked until login succeeds")

    def do_home():
        w = window_holder.get("window")
        if w:
            w.load_url(home_url)

    def do_login_auto():
        w = window_holder.get("window")
        if not w:
            return
        if not creds or not creds.get("email") or not creds.get("password"):
            log("no --email/--password; use manual Google login, then export")
            return
        result = run_google_login(
            w,
            creds["email"],
            creds["password"],
            timeout=240,
            log=log,
            cookies_probe=lambda: session_ready(w, profile_path),
        )
        log(f"login result: ok={result.ok} stage={result.stage} msg={result.message}")
        if result.ok:
            export_cookies_from_window(
                w, account_id, out_dir, require_session=True, profile_path=profile_path
            )

    def do_login_hint():
        w = window_holder.get("window")
        if not w:
            return
        from login_flow import JS_CLICK_GOOGLE, JS_CLICK_LOGIN, js_eval

        log(f"click login: {js_eval(w, JS_CLICK_LOGIN)}")
        time.sleep(1.2)
        log(f"click google: {js_eval(w, JS_CLICK_GOOGLE)}")

    def do_clear():
        w = window_holder.get("window")
        if not w:
            return
        try:
            w.clear_cookies()
            log("cookies cleared for this profile")
            w.load_url(home_url)
        except Exception as exc:
            log(f"clear cookies failed: {exc}")

    items = [
        webview.menu.MenuAction("打开 Dola 首页", do_home),
        webview.menu.MenuAction("尝试点 Log In / Google", do_login_hint),
    ]
    if creds and creds.get("email"):
        items.append(webview.menu.MenuAction("自动 Google 登录", do_login_auto))
    items.extend(
        [
            webview.menu.MenuAction("导出 Cookie（需已登录）", do_export),
            webview.menu.MenuAction("清理本账号会话 Cookie", do_clear),
        ]
    )
    return [webview.menu.Menu("Dola", items)]


def run_shell(
    account_id: str,
    profiles_dir: Path,
    out_dir: Path,
    url: str,
    *,
    email: str = "",
    password: str = "",
    auto_login: bool = False,
    auto_export: bool = False,
    export_only: bool = False,
    close_after_export: bool = False,
    login_timeout: float = 240,
) -> int:
    account_id = safe_account_id(account_id)
    storage = profile_dir(account_id, profiles_dir)
    log(f"account={account_id}")
    log(f"storage={storage}")
    log(f"cookie out={out_dir}")
    log("gui=edgechromium (WebView2)  private_mode=False")
    if email:
        log(f"login email={email} auto_login={auto_login} auto_export={auto_export}")

    window_holder: dict = {}
    creds = {"email": email, "password": password} if email and password else None

    def on_loaded():
        try:
            u = window_holder["window"].get_current_url()
        except Exception:
            u = ""
        log(f"loaded: {u}")

    def after_start():
        w = window_holder.get("window")
        if not w:
            return
        time.sleep(2.5)

        if export_only:
            path = export_cookies_from_window(
                w, account_id, out_dir, require_session=True, profile_path=storage
            )
            if not path:
                # last resort: close browser lock, read profile DB
                log("live export empty — retry from profile DB after brief wait")
                time.sleep(1.0)
                path = export_cookies_from_window(
                    w, account_id, out_dir, require_session=False, profile_path=storage
                )
                if path and not has_session(
                    filter_dola_related(load_cookies_from_webview2_profile(storage) or [])
                ):
                    # if still no session cookie, don't claim success with junk
                    if not session_ready(w, storage):
                        log("export-only: not logged in — complete login in window, then use menu export")
                        path = None
            if path and close_after_export:
                try:
                    w.destroy()
                except Exception:
                    pass
                time.sleep(0.8)
                # rewrite from profile after unlock for fullest cookie set
                try:
                    from_db = load_cookies_from_webview2_profile(storage)
                    rel = filter_dola_related(from_db)
                    if rel and has_session(rel):
                        write_netscape(out_dir / f"dola_{account_id}.txt", rel)
                        log(f"rewrote export from profile DB: {len(rel)} cookies")
                except Exception as exc:
                    log(f"post-close rewrite warn: {exc}")
            elif not path:
                log("export-only: not logged in — complete login in window, then use menu export")
            return

        if auto_login and email and password:
            def _probe() -> bool:
                return session_ready(w, storage)

            result = run_google_login(
                w,
                email,
                password,
                timeout=login_timeout,
                log=log,
                cookies_probe=_probe,
            )
            log(f"login finished: ok={result.ok} stage={result.stage} msg={result.message}")
            log_cookie_summary(w, storage, "post-login")
            if not result.ok:
                log("login failed — export skipped (need session cookies)")
                if close_after_export:
                    try:
                        w.destroy()
                    except Exception:
                        pass
                else:
                    log("window stays open for manual finish; use menu export after login")
                return
            # SPA may set cookies a beat after UI looks ready
            for _ in range(8):
                if session_ready(w, storage):
                    break
                time.sleep(1.0)
            log_cookie_summary(w, storage, "pre-export")
            if auto_export:
                path = export_cookies_from_window(
                    w, account_id, out_dir, require_session=True, profile_path=storage
                )
                if path and close_after_export:
                    time.sleep(1)
                    try:
                        w.destroy()
                    except Exception:
                        pass
            return

        # Manual mode: just open shell; user logs in then exports via menu
        if session_ready(w, storage):
            log("profile already has a session; you can export cookies from menu")
            if auto_export:
                export_cookies_from_window(
                    w, account_id, out_dir, require_session=True, profile_path=storage
                )
        else:
            log("manual mode: Log In → Continue with Google → then menu「导出 Cookie（需已登录）」")

    window = webview.create_window(
        title=f"Dola WebView — {account_id}",
        url=url,
        width=1280,
        height=860,
        text_select=True,
        confirm_close=False,
    )
    window_holder["window"] = window
    window.events.loaded += on_loaded

    menu = make_menu(window_holder, account_id, out_dir, url, creds, profile_path=storage)

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
    log("shell closed")
    return 0


def parse_args(argv: list[str]) -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Dola WebView2: login first, then export cookies")
    p.add_argument("--account", "-a", help="Account id / profile name")
    p.add_argument("--profiles", default=str(DEFAULT_PROFILES), help="Profile root directory")
    p.add_argument("--out", default=str(DEFAULT_COOKIE_OUT), help="Cookie export directory")
    p.add_argument("--url", default=DEFAULT_URL, help="Start URL")
    p.add_argument("--list", action="store_true", help="List local profiles")
    p.add_argument("--email", help="Google email for auto login")
    p.add_argument("--password", help="Google password for auto login")
    p.add_argument("--accounts", help="Account file email|password per line")
    p.add_argument("--index", type=int, default=0, help="Index in --accounts file")
    p.add_argument("--auto-login", action="store_true", help="Run Google login after open")
    p.add_argument("--auto-export", action="store_true", help="Export cookies only after login success")
    p.add_argument(
        "--skip-if-exported",
        action="store_true",
        help="Exit without opening WebView when this account already has a non-empty exported cookie file",
    )
    p.add_argument("--export-only", action="store_true", help="Only try export if already logged in")
    p.add_argument("--close-after-export", action="store_true", help="Close window after successful export")
    p.add_argument("--login-timeout", type=float, default=240, help="Login timeout seconds")
    return p.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    profiles = Path(args.profiles)
    profiles.mkdir(parents=True, exist_ok=True)
    out_dir = Path(args.out)

    if args.list:
        accs = list_accounts(profiles)
        state = load_state().get("accounts", {})
        print(
            json.dumps(
                {
                    "profilesDir": str(profiles),
                    "accounts": [{"id": a, **(state.get(a) or {})} for a in accs],
                },
                ensure_ascii=False,
                indent=2,
            )
        )
        return 0

    email = args.email or ""
    password = args.password or ""
    if args.accounts:
        rows = parse_accounts_file(args.accounts)
        if args.index < 0 or args.index >= len(rows):
            raise SystemExit(f"--index {args.index} out of range (0..{len(rows)-1})")
        email, password = rows[args.index]
        if not args.account:
            args.account = account_id_from_email(email)
        log(f"accounts file index={args.index} email={email}")

    if not args.account:
        existing = list_accounts(profiles)
        args.account = account_id_from_email(email) if email else f"dola_acc{len(existing) + 1}"
        log(f"using account id {args.account}")

    if args.auto_login and (not email or not password):
        raise SystemExit("--auto-login requires --email/--password or --accounts")

    account_id = safe_account_id(args.account)
    existing_cookie = out_dir / f"dola_{account_id}.txt"
    if args.skip_if_exported and existing_cookie.is_file() and existing_cookie.stat().st_size > 0:
        log(f"skip {account_id}: cookie already exported -> {existing_cookie}")
        return 0

    return run_shell(
        account_id=account_id,
        profiles_dir=profiles,
        out_dir=out_dir,
        url=args.url,
        email=email,
        password=password,
        auto_login=bool(args.auto_login),
        auto_export=bool(args.auto_export),
        export_only=bool(args.export_only),
        close_after_export=bool(args.close_after_export),
        login_timeout=float(args.login_timeout),
    )


if __name__ == "__main__":
    raise SystemExit(main())
