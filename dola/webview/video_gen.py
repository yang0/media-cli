# -*- coding: utf-8 -*-
"""
WebView2 video generation (reseller-style), no Chrome CDP.

Uses an already-exported / logged-in profile under profiles/<account>.

Examples:
  python video_gen.py --account AureliaBronson1l5hd --duration 15 --aspect-ratio 9:16 ^
    --file E:\\temp\\avarta.png --prompt "..." --out ..\\cli\\downloads\\wv_video

  # 0 reference images
  python video_gen.py --account GlynisWilliams9z0h --duration 5 --prompt "一只猫走路" --out .\\out

  # multi refs
  python video_gen.py --account X --duration 10 --file a.png --file b.png --prompt "..." --out .\\out
"""
from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

import webview

from cookie_util import filter_dola_related, has_session, load_cookies_from_webview2_profile
from dola_webview import (
    DEFAULT_PROFILES,
    account_id_from_email,
    list_accounts,
    log,
    profile_dir,
    safe_account_id,
    session_ready,
)
from login_flow import parse_accounts_file
from video_flow import run_video_generation

ROOT = Path(__file__).resolve().parent
DEFAULT_OUT = ROOT.parent / "cli" / "downloads" / "webview_video"


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Dola WebView2 video gen (0-n refs, 5/10/15s, aspect ratio)")
    p.add_argument("--account", "-a", help="Profile / account id under profiles/")
    p.add_argument("--profiles", default=str(DEFAULT_PROFILES))
    p.add_argument("--accounts", help="google_mail.txt — pick by --index if --account omitted")
    p.add_argument("--index", type=int, default=0)
    p.add_argument("--prompt", required=True)
    p.add_argument("--file", "--reference-image", action="append", dest="files", default=[], help="Repeatable ref image (0-n)")
    p.add_argument("--duration", type=int, default=15, choices=[5, 10, 15])
    p.add_argument("--aspect-ratio", default="9:16")
    p.add_argument("--model", default="", help="Override model (default seedance_v2.0 for 15s)")
    p.add_argument("--out", default=str(DEFAULT_OUT))
    p.add_argument("--timeout", type=float, default=600, help="Seconds to wait for video URL")
    p.add_argument("--url", default="https://www.dola.com/chat")
    p.add_argument("--close", action="store_true", help="Close window after success")
    p.add_argument("--require-session", action="store_true", default=True)
    args = p.parse_args(argv or sys.argv[1:])

    profiles = Path(args.profiles)
    account_id = args.account or ""
    if args.accounts and not account_id:
        rows = parse_accounts_file(args.accounts)
        if args.index < 0 or args.index >= len(rows):
            raise SystemExit(f"--index out of range 0..{len(rows)-1}")
        email, _pw = rows[args.index]
        account_id = account_id_from_email(email)
        log(f"accounts index={args.index} email={email} -> account={account_id}")
    if not account_id:
        accs = list_accounts(profiles)
        if not accs:
            raise SystemExit("no profiles; pass --account or --accounts")
        account_id = accs[0]
        log(f"default account={account_id}")
    account_id = safe_account_id(account_id)
    storage = profile_dir(account_id, profiles)
    out_dir = Path(args.out)
    files = [str(Path(f).resolve()) for f in (args.files or [])]
    for f in files:
        if not Path(f).is_file():
            raise SystemExit(f"file not found: {f}")

    # Preflight session cookies from profile DB
    ck = load_cookies_from_webview2_profile(storage)
    if args.require_session and not has_session(filter_dola_related(ck) or ck):
        raise SystemExit(
            f"profile has no session cookies: {storage}\n"
            f"Login/export first: login_one.cmd or dola_webview.py --auto-login --auto-export"
        )
    log(f"account={account_id}")
    log(f"storage={storage}")
    log(f"refs={len(files)} duration={args.duration}s ratio={args.aspect_ratio} out={out_dir}")

    holder: dict = {}
    result_box: dict = {"result": None, "error": None}

    def after_start():
        w = holder.get("window")
        if not w:
            return
        # Wait until WebView runtime accepts evaluate_js (cold start can take a few seconds).
        ready = False
        for i in range(40):
            try:
                val = w.evaluate_js("(() => location.href || document.readyState || 'ok')()")
                if val:
                    log(f"webview ready ({i}): {str(val)[:120]}")
                    ready = True
                    break
            except Exception as exc:
                if i % 5 == 0:
                    log(f"webview warm-up {i}: {exc}")
            time.sleep(0.5)
        if not ready:
            result_box["error"] = "WebView failed to become ready for evaluate_js"
            log(result_box["error"])
            return
        time.sleep(1.5)
        try:
            if not session_ready(w, storage):
                log("warning: live session_ready=false; continuing with profile cookies")
            result = run_video_generation(
                w,
                prompt=args.prompt,
                ref_paths=files,
                duration=args.duration,
                aspect_ratio=args.aspect_ratio,
                model=args.model,
                out_dir=out_dir,
                timeout=args.timeout,
                log=log,
                close_when_done=bool(args.close),
            )
            result_box["result"] = result
            log(f"DONE ok file={result.get('file')} size={result.get('size')}")
            print(json_dumps(result), flush=True)
            if args.close:
                try:
                    w.destroy()
                except Exception:
                    pass
        except Exception as exc:
            result_box["error"] = str(exc)
            log(f"FAILED: {exc}")
            if args.close:
                try:
                    w.destroy()
                except Exception:
                    pass

    def json_dumps(obj) -> str:
        import json

        return json.dumps(obj, ensure_ascii=False, indent=2)

    window = webview.create_window(
        title=f"Dola Video — {account_id}",
        url=args.url,
        width=1280,
        height=900,
        text_select=True,
        confirm_close=False,
    )
    holder["window"] = window
    webview.start(
        after_start,
        gui="edgechromium",
        debug=False,
        private_mode=False,
        storage_path=str(storage),
        user_agent=(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36 Edg/150.0.0.0"
        ),
    )
    log("shell closed")
    if result_box["error"]:
        print(f"ERROR: {result_box['error']}", file=sys.stderr)
        return 1
    if not result_box["result"]:
        print("ERROR: no result (window closed early?)", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
