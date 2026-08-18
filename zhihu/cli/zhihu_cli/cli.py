"""Command-line entry point for zhihu-plus."""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

from .auth import AuthError, auth_summary, resolve_auth
from .browser import CdpError, TemporaryChrome
from .capture import CaptureError, capture
from .inputs import InputError, read_inputs


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="zhihu-plus", description="知乎回答与专栏文章证据截图工具")
    sub = parser.add_subparsers(dest="command", required=True)

    auth = sub.add_parser("auth", help="检查知乎认证来源")
    auth_sub = auth.add_subparsers(dest="auth_command", required=True)
    check = auth_sub.add_parser("check", help="检查 Cookie 文件、环境变量或 Chrome CDP")
    _add_auth_args(check)

    capture_parser = sub.add_parser("capture", help="截取明确指定的知乎回答或专栏文章")
    group = capture_parser.add_mutually_exclusive_group(required=True)
    group.add_argument("reference", nargs="?", help="知乎回答或专栏文章详情 URL")
    group.add_argument("--input", dest="input_path", help="每行一个知乎详情 URL 的文本文件")
    capture_parser.add_argument("--cdp-port", type=int, default=9221, help="已登录 Chrome CDP 端口（默认 9221）")
    capture_parser.add_argument("--wait", type=float, default=5.0, dest="wait_seconds", help="页面等待秒数（默认 5）")
    capture_parser.add_argument("--overlap", type=int, default=64, help="硬切分片重叠像素（默认 64）")
    capture_parser.add_argument("--viewport-width", type=int, default=900)
    capture_parser.add_argument("--viewport-height", type=int, default=1200)
    capture_parser.add_argument("--output-dir")
    capture_parser.add_argument("--cookie-file", help="Netscape、JSON 或原始 Cookie Header 文件")
    capture_parser.add_argument("--chrome", "--chrome-executable", dest="chrome_executable", help="临时 Chrome/Edge 可执行文件")
    return parser


def _add_auth_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--cookie-file", help="Netscape、JSON 或原始 Cookie Header 文件")
    parser.add_argument("--cdp-port", type=int, default=9221)


def _auth_from_args(args: argparse.Namespace, *, required: bool) -> object | None:
    return resolve_auth(cookie_file=args.cookie_file, cdp_port=args.cdp_port, required=required)


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.command == "auth":
            context = _auth_from_args(args, required=True)
            assert context is not None
            print(auth_summary(context))
            return 0
        if args.command == "capture":
            references = read_inputs(args.reference, args.input_path)
            # An existing logged-in CDP may be enough; an explicitly supplied
            # cookie is also what enables the temporary-Chrome fallback.
            context = _auth_from_args(args, required=False)
            output = capture(
                references,
                output_dir=args.output_dir,
                port=args.cdp_port,
                wait_seconds=args.wait_seconds,
                overlap=args.overlap,
                viewport_width=args.viewport_width,
                viewport_height=args.viewport_height,
                auth=context,
                browser_factory=(lambda: TemporaryChrome(executable=args.chrome_executable)) if args.chrome_executable else TemporaryChrome,
            )
            manifest_path = Path(output) / "manifest.json"
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            print(f"已写入截图清单：{manifest_path}")
            success = int(manifest.get("success_count", 0))
            count = int(manifest.get("count", 0))
            if success == count:
                return 0
            return 3 if success else 2
    except (AuthError, CdpError, CaptureError, InputError, OSError, ValueError) as exc:
        print(f"执行失败：{exc}", file=sys.stderr)
        return 2
    return 2
