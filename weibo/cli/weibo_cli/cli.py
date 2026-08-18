"""Command-line entry point for ``weibo-cli``."""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

from .auth import AuthError, auth_summary, resolve_auth
from .capture import CaptureError, capture, read_inputs
from .engine import SearchBlockedError, SearchEngine, SearchError
from .models import SearchOptions
from .query import QueryValidationError, validate_options


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="weibo-cli", description="模块化微博搜索与微博卡片截图工具")
    sub = parser.add_subparsers(dest="command", required=True)

    auth = sub.add_parser("auth", help="检查认证来源")
    auth_sub = auth.add_subparsers(dest="auth_command", required=True)
    check = auth_sub.add_parser("check", help="检查 Cookie 文件、环境变量或 Chrome CDP")
    _add_auth_args(check)

    search = sub.add_parser("search", help="搜索微博并导出 JSONL/CSV")
    search.add_argument("query", help="一个组合查询；多个词以空格分隔")
    search.add_argument("--limit", type=int, default=10, help="结果条数，默认 10；0 表示不限量")
    search.add_argument("--start", help="起始日期 YYYY-MM-DD（需与 --end 同时提供）")
    search.add_argument("--end", help="结束日期 YYYY-MM-DD（包含当天）")
    search.add_argument("--type", dest="weibo_type", choices=["all", "original", "hot", "following", "verified", "media", "opinion"], default="all")
    search.add_argument("--contains", choices=["any", "image", "video", "music", "link"], default="any")
    search.add_argument("--region", help="省/直辖市名称；不指定表示全部")
    search.add_argument("--threshold", type=int, default=46, help="分页细分阈值，默认 46")
    search.add_argument("--delay", type=float, default=10.0, help="请求间隔秒数，默认 10")
    search.add_argument("--format", dest="output_format", choices=["jsonl", "csv", "both"], default="both")
    search.add_argument("--output-dir", help="本次搜索输出目录")
    search.add_argument("--resume", dest="resume_dir", help="从已有搜索目录的 state.sqlite3 恢复")
    _add_auth_args(search)

    capture_parser = sub.add_parser("capture", help="截取指定微博卡片；长卡片自动分为 9:16 PNG")
    group = capture_parser.add_mutually_exclusive_group(required=True)
    group.add_argument("reference", nargs="?", help="微博详情 URL 或数字微博 ID")
    group.add_argument("--input", dest="input_path", help="每行一个微博详情 URL/ID 的文本文件")
    capture_parser.add_argument("--cdp-port", type=int, default=9221)
    capture_parser.add_argument("--wait", type=float, default=3.0, dest="wait_seconds")
    capture_parser.add_argument("--overlap", type=int, default=64, help="硬切分片的重叠像素，默认 64")
    capture_parser.add_argument("--viewport-width", type=int, default=900)
    capture_parser.add_argument("--viewport-height", type=int, default=1200)
    capture_parser.add_argument("--output-dir")
    capture_parser.add_argument("--cookie-file", help="可选 Cookie 文件；截图优先复用已登录 CDP")
    return parser


def _add_auth_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--cookie-file", help="Netscape、JSON 或原始 Cookie Header 文件")
    parser.add_argument("--cdp-port", type=int, default=9221)


def _auth_from_args(args: argparse.Namespace, *, required: bool = True):
    if required or args.cookie_file or os.environ.get("WEIBO_COOKIE"):
        return resolve_auth(cookie_file=args.cookie_file, cdp_port=args.cdp_port)
    return None


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.command == "auth":
            context = _auth_from_args(args, required=True)
            print(auth_summary(context))
            return 0
        if args.command == "search":
            options = SearchOptions(query=args.query, limit=args.limit, start=args.start, end=args.end, weibo_type=args.weibo_type, contains=args.contains, region=args.region, threshold=args.threshold, delay=args.delay, output_dir=args.output_dir, output_format=args.output_format, resume_dir=args.resume_dir, cdp_port=args.cdp_port, cookie_file=args.cookie_file)
            validate_options(options)
            context = _auth_from_args(args, required=True)
            run = SearchEngine(options, context, output_dir=args.output_dir or args.resume_dir).run()
            print(f"已写入 {run.count} 条微博：{run.output_dir}")
            return 3 if run.partial else 0
        if args.command == "capture":
            references = read_inputs(args.reference, args.input_path)
            context = _auth_from_args(args, required=False)
            output = capture(references, output_dir=args.output_dir, port=args.cdp_port, wait_seconds=args.wait_seconds, overlap=args.overlap, viewport_width=args.viewport_width, viewport_height=args.viewport_height, auth=context)
            import json

            manifest = json.loads((Path(output) / "manifest.json").read_text(encoding="utf-8"))
            print(f"已写入截图清单：{Path(output) / 'manifest.json'}")
            if manifest.get("success_count") == manifest.get("count"):
                return 0
            if manifest.get("success_count", 0) == 0 and any(item.get("error_kind") in {"blocked", "capture"} for item in manifest.get("items", [])):
                return 2
            return 3
    except (AuthError, QueryValidationError, SearchError, CaptureError, OSError, ValueError) as exc:
        print(f"执行失败：{exc}", file=sys.stderr)
        return 2
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
