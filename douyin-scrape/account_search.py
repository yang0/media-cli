#!/usr/bin/env python3
"""Search and rank Douyin accounts.

This command deliberately has no screenshot code.  ``account_capture.py`` is
the separate entry point for capturing a profile supplied by the user.
"""

from __future__ import annotations

import argparse
import asyncio
import csv
import json
import sys
from datetime import datetime
from pathlib import Path
from typing import Any, Awaitable, Callable, Mapping
from urllib.parse import quote

try:  # direct ``python account_search.py`` execution
    from account_parser import extract_accounts_from_dom, extract_accounts_from_payload, payload_from_text, safe_filename
    from account_ranking import rank_accounts
    from douyin_cdp import CdpError, CdpSession, close_tab, open_tab, wait_for_page
except ImportError:  # package-style imports in external callers
    from .account_parser import extract_accounts_from_dom, extract_accounts_from_payload, payload_from_text, safe_filename
    from .account_ranking import rank_accounts
    from .douyin_cdp import CdpError, CdpSession, close_tab, open_tab, wait_for_page


class AccountSearchError(RuntimeError):
    """Raised when account search cannot produce trustworthy results."""


def build_search_url(query: str) -> str:
    """Build the user-only search URL used by the browser workflow."""

    text = str(query or "").strip()
    if not text:
        raise ValueError("搜索关键词不能为空")
    return f"https://www.douyin.com/search/{quote(text, safe='')}?type=user"


def parse_search_result(value: Any) -> list[dict[str, Any]]:
    """Parse a CDP JSON/DOM result without ranking or side effects."""

    if isinstance(value, str):
        text = value.strip()
        if text.startswith("<"):
            return extract_accounts_from_dom(text)
        value = payload_from_text(text)
    accounts = extract_accounts_from_payload(value)
    if accounts:
        return accounts
    if isinstance(value, str):
        return extract_accounts_from_dom(value)
    return []


_SEARCH_DOM_SCRIPT = r"""
(() => {
  const links = [...document.querySelectorAll(
    'div.search-result-card > a[href*="/user/"], a[href*="/user/"]'
  )];
  const seen = new Set();
  const text = (el) => (el && (el.innerText || el.textContent) || '')
    .replace(/\s+/g, ' ')
    .trim();
  const metricText = (spans, labels) => {
    const number = '[\\d,.]+(?:\\.\\d+)?\\s*(?:十亿|亿|千万|百万|十万|万|千|百|[kKmMbB])?';
    const label = labels.map(item => item.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')).join('|');
    for (const span of spans) {
      // Each statistic is read from its own span.  Do not use card/a.innerText:
      // the card also contains the Douyin ID and can concatenate unrelated
      // digits with a statistic.
      const value = text(span);
      if (!value || !labels.some(item => value.toLowerCase().includes(item.toLowerCase()))) continue;
      const beforeLabel = value.match(new RegExp('(' + number + ')\\s*(?:' + label + ')', 'i'));
      if (beforeLabel) return beforeLabel[1].replace(/\\s+/g, '');
      const afterLabel = value.match(new RegExp('(?:' + label + ')\\s*[:：]?\\s*(' + number + ')', 'i'));
      if (afterLabel) return afterLabel[1].replace(/\\s+/g, '');
    }
    return '';
  };
  return links.map((a) => {
    const href = a.getAttribute('href') || a.href || '';
    const absolute = new URL(href, document.baseURI || location.href);
    absolute.search = '';
    absolute.hash = '';
    const profileUrl = absolute.href;
    const m = profileUrl.match(/\/user\/([^/?#]+)/);
    if (!m || seen.has(m[1])) return null;
    seen.add(m[1]);
    const card = a.closest('div.search-result-card, .search-result-card')
      || a.closest('li, article') || a;
    // Current search cards are div.search-result-card > a.  The header div
    // contains the first p (nickname), while the bio is a direct p child.
    const nicknameNode = a.querySelector('p');
    const bioNode = a.querySelector(':scope > p');
    const spans = [...a.querySelectorAll('span')];
    const nickname = text(nicknameNode);
    if (!nickname) return null;
    const badge = a.querySelector(
      '[data-e2e="badge-role-name"], [class*="badge-role-name"], [class*="badgeRoleName"]'
    );
    return {
      sec_uid: decodeURIComponent(m[1]),
      profile_url: profileUrl,
      nickname,
      bio: text(bioNode),
      likes: metricText(spans, ['获赞', '点赞', 'likes']),
      followers: metricText(spans, ['粉丝', 'followers', 'fans']),
      post_count: metricText(spans, ['作品', 'works', 'posts']),
      verified: Boolean(badge) || text(card).includes('认证徽章')
    };
  }).filter(Boolean);
})()
"""

_BODY_TEXT_SCRIPT = "document.body ? document.body.innerText : ''"


async def search_in_browser(
    query: str,
    *,
    port: int = 9221,
    wait_seconds: float = 5,
    limit: int = 30,
) -> list[dict[str, Any]]:
    """Open the user search page and return raw account candidates.

    The function uses the user's existing Chrome login.  It does not inject
    cookies, search arbitrary APIs, or open profile screenshots.
    """

    url = build_search_url(query)
    target: Mapping[str, Any] | None = None
    try:
        target = open_tab(url, port=port)
        websocket_url = target.get("webSocketDebuggerUrl")
        if not websocket_url:
            raise AccountSearchError("Chrome 未返回搜索页面连接")
        async with CdpSession(str(websocket_url)) as session:
            await session.command("Page.enable")
            await session.command("Runtime.enable")
            await wait_for_page(session, seconds=wait_seconds)
            body_result = await session.command(
                "Runtime.evaluate",
                {"expression": _BODY_TEXT_SCRIPT, "returnByValue": True},
            )
            body = str((body_result.get("result") or {}).get("value") or "")
            if any(marker in body for marker in ("请输入验证码", "安全验证", "滑动验证", "验证后继续")):
                raise AccountSearchError("抖音页面要求验证码/安全验证；请在 Chrome 中手动完成后重试")
            # User search is lazy-loaded in groups. Scroll the last visible
            # card into view until the requested candidate count is present
            # or the page stops growing.
            previous_count = -1
            stalls = 0
            for _ in range(max(2, min(20, (int(limit) + 9) // 10 + 3))):
                count_result = await session.command(
                    "Runtime.evaluate",
                    {
                        "expression": """(() => {
                          const links = [...document.querySelectorAll('div.search-result-card > a[href*="/user/"]')];
                          const last = links[links.length - 1];
                          if (last) last.scrollIntoView({block: 'end'});
                          window.scrollTo(0, document.documentElement.scrollHeight || document.body.scrollHeight);
                          return new Set(links.map(a => (a.getAttribute('href') || '').match(/\\/user\\/([^/?#]+)/)?.[1]).filter(Boolean)).size;
                        })()""",
                        "returnByValue": True,
                    },
                )
                count = int((count_result.get("result") or {}).get("value") or 0)
                if count >= limit:
                    break
                stalls = stalls + 1 if count == previous_count else 0
                if stalls >= 2:
                    break
                previous_count = count
                await asyncio.sleep(1)
            result = await session.command(
                "Runtime.evaluate",
                {
                    "expression": _SEARCH_DOM_SCRIPT,
                    "awaitPromise": True,
                    "returnByValue": True,
                },
            )
            value = (result.get("result") or {}).get("value")
            accounts = parse_search_result(value)
            if not accounts:
                # A frontend markup change should be visible to the caller, not
                # silently turned into an empty popularity report.
                raise AccountSearchError("未从搜索结果页面解析到账号；可能需要登录或页面结构已变化")
            return accounts
    except CdpError as exc:
        raise AccountSearchError(str(exc)) from exc
    finally:
        close_tab((target or {}).get("id"), port=port)


def _timestamp_folder() -> str:
    return datetime.now().astimezone().strftime("%Y%m%d-%H%M%S")


def default_output_dir(query: str, *, root: str | Path = "downloads") -> Path:
    """Return a new timestamped search output directory."""

    base = Path(root) / "account-search" / f"{_timestamp_folder()}-{safe_filename(query, limit=48)}"
    candidate = base
    suffix = 1
    while candidate.exists():
        candidate = Path(f"{base}-{suffix}")
        suffix += 1
    return candidate


def _json_safe(value: Any) -> Any:
    if isinstance(value, Mapping):
        return {str(key): _json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_safe(item) for item in value]
    return value


def write_search_outputs(
    query: str,
    accounts: list[Mapping[str, Any]],
    *,
    output_dir: str | Path,
    sort_by: str,
    candidate_count: int | None = None,
) -> Path:
    """Write JSON/CSV/Markdown evidence for one search run."""

    output = Path(output_dir)
    output.mkdir(parents=True, exist_ok=True)
    generated_at = datetime.now().astimezone().isoformat(timespec="seconds")
    # ``recent_posts`` is supported by the generic parser for other workflows,
    # but it is not a field obtained by this public search-card command.
    public_accounts = [
        {
            key: value
            for key, value in dict(item).items()
            if key not in {"recent_posts", "post_count"}
        }
        for item in accounts
    ]
    json_payload = {
        "query": query,
        "generated_at": generated_at,
        "sort": sort_by,
        "candidate_count": candidate_count if candidate_count is not None else len(accounts),
        "accounts": [_json_safe(item) for item in public_accounts],
    }
    (output / "accounts.json").write_text(
        json.dumps(json_payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    with (output / "accounts.csv").open("w", encoding="utf-8-sig", newline="") as handle:
        fields = [
            "rank",
            "nickname",
            "sec_uid",
            "profile_url",
            "followers",
            "likes",
            "search_rank",
            "hot_score",
            "verified",
            "bio",
        ]
        writer = csv.DictWriter(handle, fieldnames=fields, extrasaction="ignore")
        writer.writeheader()
        for rank, account in enumerate(accounts, 1):
            row = dict(account)
            row["rank"] = rank
            writer.writerow({key: row.get(key, "") for key in fields})

    lines = [
        f"# 抖音账号搜索：{query}",
        "",
        f"- 采集时间：{generated_at}",
        f"- 排序：`{sort_by}`",
        f"- 输出账号数：{len(accounts)}",
        "- 说明：搜索结果与账号公开字段的快照；本命令不生成截图。",
        "",
    ]
    if not accounts:
        lines.append("未找到可核验的账号。"); lines.append("")
    for rank, account in enumerate(accounts, 1):
        nickname = account.get("nickname") or "未命名账号"
        lines.extend(
            [
                f"## {rank}. {nickname}",
                "",
                f"- 主页：{account.get('profile_url') or '未知'}",
                f"- sec_uid：`{account.get('sec_uid') or '未知'}`",
                f"- 粉丝：{account.get('followers', 0):,}",
                f"- 获赞：{account.get('likes', 0):,}",
                f"- 搜索排名：{account.get('search_rank') or '未知'}",
                f"- 综合热度：{account.get('hot_score', 0):.2f}",
                f"- 认证：{'是' if account.get('verified') else '否'}",
                f"- 简介：{account.get('bio') or '未提供'}",
                "",
            ]
        )
    (output / "report.md").write_text("\n".join(lines), encoding="utf-8")
    return output


async def _run_search_async(
    query: str,
    *,
    limit: int,
    top: int,
    sort_by: str,
    port: int,
    wait_seconds: float,
    output_dir: str | Path | None,
    searcher: Callable[..., Awaitable[list[dict[str, Any]]]] = search_in_browser,
) -> Path:
    raw = await searcher(query, port=port, wait_seconds=wait_seconds, limit=limit)
    candidates = raw[: max(0, int(limit))]
    ranked = rank_accounts(candidates, sort_by=sort_by, limit=top)
    output = Path(output_dir) if output_dir else default_output_dir(query)
    return write_search_outputs(query, ranked, output_dir=output, sort_by=sort_by, candidate_count=len(raw))


def run_search(
    query: str,
    *,
    limit: int = 30,
    top: int = 10,
    sort_by: str = "hot",
    port: int = 9221,
    wait_seconds: float = 5,
    output_dir: str | Path | None = None,
    searcher: Callable[..., Awaitable[list[dict[str, Any]]]] = search_in_browser,
) -> Path:
    """Synchronous API used by the CLI and unit tests."""

    if limit < 1 or top < 1:
        raise ValueError("limit、top 必须大于 0")
    return asyncio.run(
        _run_search_async(
            query,
            limit=limit,
            top=top,
            sort_by=sort_by,
            port=port,
            wait_seconds=wait_seconds,
            output_dir=output_dir,
            searcher=searcher,
        )
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="搜索并排序抖音热门账号（不截图）")
    parser.add_argument("query", help="搜索关键词，例如：财经")
    parser.add_argument("--limit", type=int, default=30, help="最多读取多少个原始候选（默认 30）")
    parser.add_argument("--top", type=int, default=10, help="输出多少个账号（默认 10）")
    parser.add_argument("--sort", dest="sort_by", choices=("hot", "followers", "likes", "search"), default="hot")
    parser.add_argument("--cdp-port", type=int, default=9221, help="已登录 Chrome 的 CDP 端口（默认 9221）")
    parser.add_argument("--wait", dest="wait_seconds", type=float, default=5, help="页面加载等待秒数（默认 5）")
    parser.add_argument("--output-dir", help="直接指定本次输出目录；默认 downloads/account-search/<时间>-<关键词>")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        output = run_search(
            args.query,
            limit=args.limit,
            top=args.top,
            sort_by=args.sort_by,
            port=args.cdp_port,
            wait_seconds=args.wait_seconds,
            output_dir=args.output_dir,
        )
    except (AccountSearchError, CdpError, OSError, ValueError) as exc:
        print(f"搜索失败：{exc}", file=sys.stderr)
        return 2
    print(f"已写入搜索结果：{output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
