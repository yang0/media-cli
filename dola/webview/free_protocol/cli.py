"""CLI for dola-free style account import + external HTTP video submit.

CRITICAL:
  Do NOT submit video/chat inside the Dola WebView window.
  Login in WebView only; submit via `video generate` / `video submit15`.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any

WEBVIEW_ROOT = Path(__file__).resolve().parents[1]
if str(WEBVIEW_ROOT) not in sys.path:
    sys.path.insert(0, str(WEBVIEW_ROOT))

from free_protocol.generate import generate_video_api
from free_protocol.registry import AccountRegistry


def _print(obj: Any) -> None:
    if isinstance(obj, (dict, list)):
        print(json.dumps(obj, ensure_ascii=False, indent=2))
    else:
        print(obj)


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Dola free-style account import + HTTP video")
    p.add_argument("--data-dir", default="", help="Registry root (default %%LOCALAPPDATA%%/dola-cli)")
    p.add_argument("--profiles", default="", help="WebView profiles directory")
    p.add_argument("--account-pool", default="", help="Netscape cookie pool directory")
    sub = p.add_subparsers(dest="resource")

    account = sub.add_parser("account")
    ac = account.add_subparsers(dest="action")
    ac.add_parser("list")

    video = sub.add_parser("video")
    vc = video.add_subparsers(dest="action")
    gen = vc.add_parser("generate", help="External HTTP video submit (never uses Dola window composer)")
    gen.add_argument("--account", "-a", required=True)
    gen.add_argument("--prompt", required=True)
    gen.add_argument("--duration", type=int, default=5)
    gen.add_argument("--aspect-ratio", default="9:16")
    gen.add_argument("--model", default="")
    gen.add_argument("--file", action="append", dest="files", default=[])
    gen.add_argument("--out", default=str(WEBVIEW_ROOT.parent / "cli" / "downloads" / "api_video"))
    gen.add_argument("--timeout", type=float, default=600)
    gen.add_argument("--no-wait", action="store_true")

    s15 = vc.add_parser("submit15", help="Alias: external 15s Seedance submit")
    s15.add_argument("--account", "-a", required=True)
    s15.add_argument("--prompt", required=True)
    s15.add_argument("--aspect-ratio", default="9:16")
    s15.add_argument("--model", default="seedance_v2.0")
    s15.add_argument("--file", action="append", dest="files", default=[])
    s15.add_argument("--out", default=str(WEBVIEW_ROOT.parent / "cli" / "downloads" / "api_video"))
    s15.add_argument("--timeout", type=float, default=600)
    s15.add_argument("--no-wait", action="store_true")

    args = p.parse_args(argv)
    reg_kwargs = {}
    if args.data_dir:
        reg_kwargs["data_dir"] = args.data_dir
    if args.profiles:
        reg_kwargs["profiles_dir"] = args.profiles
    if args.account_pool:
        reg_kwargs["cookie_pool"] = args.account_pool
    registry = AccountRegistry(**reg_kwargs)

    if args.resource == "account" and args.action == "list":
        rows = []
        for rec in registry.list_accounts():
            rows.append(
                {
                    "accountId": rec.accountId,
                    "hasSession": rec.hasSession,
                    "health": rec.dolaHealthStatus,
                    "protocolReady": bool(rec.protocol and rec.protocol.ready_for_video()),
                }
            )
        _print(rows)
        return 0

    if args.resource == "video" and args.action in ("generate", "submit15"):
        duration = 15 if args.action == "submit15" else int(args.duration)
        model = args.model or ("seedance_v2.0" if duration >= 15 else "")
        result = generate_video_api(
            args.account,
            prompt=args.prompt,
            duration=duration,
            aspect_ratio=args.aspect_ratio,
            model=model,
            refs=list(args.files or []),
            out_dir=args.out,
            timeout=float(args.timeout),
            wait_download=not bool(getattr(args, "no_wait", False)),
            registry=registry,
        )
        _print(result)
        return 0 if result.get("accepted") else 1

    p.print_help()
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
