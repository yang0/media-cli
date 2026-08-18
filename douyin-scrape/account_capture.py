#!/usr/bin/env python3
"""Capture specified Douyin profile pages.

This command intentionally accepts only a profile URL or sec_uid.  It does
not search, rank, or import the account-search workflow.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import binascii
import json
import struct
import sys
from datetime import datetime
from pathlib import Path
from typing import Any, Awaitable, Callable, Mapping

try:  # direct ``python account_capture.py`` execution
    from account_parser import AccountInputError, parse_profile_reference, safe_filename
    from douyin_cdp import CdpError, CdpSession, close_tab, open_tab, wait_for_page
except ImportError:  # package-style imports in external callers
    from .account_parser import AccountInputError, parse_profile_reference, safe_filename
    from .douyin_cdp import CdpError, CdpSession, close_tab, open_tab, wait_for_page


class AccountCaptureError(RuntimeError):
    """Raised when a profile cannot be captured as trustworthy evidence."""


class CaptureBlockedError(AccountCaptureError):
    """Raised when Douyin asks for a verification step."""


PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


def _timestamp_folder() -> str:
    return datetime.now().astimezone().strftime("%Y%m%d-%H%M%S")


def default_output_dir(*, root: str | Path = "downloads") -> Path:
    base = Path(root) / "account-screenshots" / _timestamp_folder()
    candidate = base
    suffix = 1
    while candidate.exists():
        candidate = Path(f"{base}-{suffix}")
        suffix += 1
    return candidate


def read_profile_inputs(reference: str | None = None, input_path: str | Path | None = None) -> list[dict[str, str]]:
    """Read and deduplicate explicit homepage references.

    Empty lines and comments are ignored.  Invalid lines raise immediately so
    a typo cannot accidentally navigate to a search or arbitrary page.
    """

    if bool(reference) == bool(input_path):
        raise ValueError("请提供一个主页 URL/sec_uid，或使用 --input URL文本文件（二选一）")
    values: list[str]
    if input_path:
        source = Path(input_path)
        values = [
            line.strip()
            for line in source.read_text(encoding="utf-8-sig").splitlines()
            if line.strip() and not line.lstrip().startswith("#")
        ]
        if not values:
            raise ValueError("--input 文件中没有可用的主页 URL/sec_uid")
    else:
        values = [str(reference).strip()]

    result: list[dict[str, str]] = []
    seen: set[str] = set()
    for value in values:
        parsed = parse_profile_reference(value)
        if parsed["sec_uid"] in seen:
            continue
        seen.add(parsed["sec_uid"])
        parsed["input"] = value
        result.append(parsed)
    return result


_PROFILE_SCRIPT = r"""
(async () => {
  const text = (el) => (el && (el.innerText || el.textContent) || '').trim();
  const first = (selectors) => selectors.map(s => document.querySelector(s)).find(Boolean);
  const pause = (milliseconds) => new Promise(resolve => setTimeout(resolve, milliseconds));
  const root = first([
    '[data-e2e="user-info"]',
    '[data-e2e="user-profile"]',
    '[data-e2e="user-info-container"]',
    'main'
  ]);
  // Profile counters can finish after the grid shell. Give them a short,
  // bounded chance to appear so the taller capture does not preserve a
  // half-loaded header containing labels without values.
  for (let attempt = 0; attempt < 8; attempt++) {
    const profileText = text(root || document.body);
    if (/(?:粉丝|获赞)\s*[\d,.]+|[\d,.]+\s*(?:万|亿)?\s*(?:粉丝|获赞)/.test(profileText)) break;
    await pause(250);
  }
  const postSelectors = [
    '[data-e2e="user-post-item"]',
    '[data-e2e="user-post-list"] a[href*="/video/"]',
    '[data-e2e="user-post-list"] a[href*="/note/"]'
  ];
  const collectPostRects = () => {
    const elements = [];
    const seenElements = new Set();
    for (const selector of postSelectors) {
      for (const element of document.querySelectorAll(selector)) {
        if (!seenElements.has(element)) {
          seenElements.add(element);
          elements.push(element);
        }
      }
    }
    const seenRects = new Set();
    return elements.map(element => element.getBoundingClientRect())
      .filter(rect => rect.width > 0 && rect.height > 0 && rect.bottom > 0)
      .filter(rect => {
        // Some Douyin versions expose both the card and its inner link.  Do
        // not let that duplicate make one visual card count as two posts.
        const key = [rect.left, rect.top, rect.width, rect.height]
          .map(value => Math.round(value * 10) / 10).join(':');
        if (seenRects.has(key)) return false;
        seenRects.add(key);
        return true;
      })
      .sort((left, right) => left.top - right.top || left.left - right.left);
  };
  const groupRows = (rects) => {
    if (!rects.length) return [];
    const heights = rects.map(rect => rect.height).sort((left, right) => left - right);
    const middle = Math.floor(heights.length / 2);
    const medianHeight = heights.length % 2
      ? heights[middle]
      : (heights[middle - 1] + heights[middle]) / 2;
    const tolerance = Math.max(8, Math.min(36, medianHeight * 0.2));
    const rows = [];
    for (const rect of rects) {
      let row = rows.find(candidate => Math.abs(candidate.top - rect.top) <= tolerance);
      if (!row) {
        row = {top: rect.top, rects: []};
        rows.push(row);
      }
      row.rects.push(rect);
    }
    return rows.sort((left, right) => left.top - right.top);
  };

  // The profile grid is lazy-loaded.  If the first viewport exposes only one
  // row, make one bounded scroll to trigger the next row, then return to the
  // top before measuring so the header and the first two rows share a clip.
  let postRects = collectPostRects();
  if (postRects.length > 0 && groupRows(postRects.slice(0, 12)).length < 2) {
    const currentY = window.scrollY || window.pageYOffset || 0;
    const viewportHeight = Math.max(document.documentElement.clientHeight || window.innerHeight || 1000, 1);
    const documentHeight = Math.max(
      document.documentElement.scrollHeight || 0,
      document.body ? document.body.scrollHeight : 0,
      viewportHeight
    );
    const maxY = Math.max(0, documentHeight - viewportHeight);
    const scrollBy = Math.min(Math.max(360, viewportHeight * 0.45), 640);
    const targetY = Math.min(maxY, currentY + scrollBy);
    if (targetY > currentY) {
      window.scrollTo(0, targetY);
      await pause(700);
    }
    window.scrollTo(0, 0);
    await pause(600);
    postRects = collectPostRects();
  }

  const rect = root ? root.getBoundingClientRect() : null;
  // Inspect at most the first twelve cards.  That is enough for a normal
  // three-column grid and prevents a profile-region clip from becoming a
  // full-page screenshot when a page exposes an unusually large DOM.
  const firstTwelvePosts = postRects.slice(0, 12);
  const rows = groupRows(firstTwelvePosts);
  const firstTwoRows = rows.slice(0, 2);
  const firstTwoRowsBottom = firstTwoRows.length >= 2
    ? Math.max(...firstTwoRows.flatMap(row => row.rects).map(rect => rect.bottom))
    : (firstTwelvePosts.length ? Math.max(...firstTwelvePosts.map(rect => rect.bottom)) : 0);
  const firstRowLeft = firstTwelvePosts.length ? Math.min(...firstTwelvePosts.slice(0, 3).map(rect => rect.left)) : null;
  const width = Math.max(document.documentElement.clientWidth || window.innerWidth || 1440, 1);
  const viewportHeight = Math.max(document.documentElement.clientHeight || window.innerHeight || 1000, 1);
  const documentHeight = Math.max(
    document.documentElement.scrollHeight || 0,
    document.body ? document.body.scrollHeight : 0,
    viewportHeight
  );
  // A ``main`` fallback can span the whole document; cap its contribution to
  // the header portion and let the two-row card boundary determine the rest.
  const headerBottom = rect ? Math.min(rect.bottom, viewportHeight * 0.8) : 0;
  const bottom = Math.min(
    Math.max(firstTwoRowsBottom + 24, headerBottom + 24, 360),
    documentHeight
  );
  // The info text block can start to the right of the avatar.  Include the
  // first post column as a stable proxy for the full profile content edge.
  const left = Math.max(0, Math.min(
    rect ? rect.left : width,
    firstRowLeft === null ? width : firstRowLeft
  ));
  const top = rect ? Math.max(0, rect.top) : 0;
  const profile = first([
    '[data-e2e="user-info"] h1',
    '[data-e2e="user-info"] [data-e2e="user-nickname"]',
    '[data-e2e="user-profile"] h1',
    'h1'
  ]);
  const body = text(document.body);
  return {
    nickname: text(profile) || document.title.replace(/[-|].*$/, '').trim(),
    page_title: document.title,
    body_excerpt: body.slice(0, 1200),
    post_rows: firstTwoRows.length,
    post_cards_considered: firstTwelvePosts.length,
    clip: {
      x: left,
      y: top,
      width: Math.max(1, width - left),
      height: Math.max(1, bottom - top)
    },
    document_height: documentHeight
  };
})()
"""

_BODY_TEXT_SCRIPT = "document.body ? document.body.innerText : ''"


def _result_value(result: Mapping[str, Any]) -> Any:
    return (result.get("result") or {}).get("value")


def _valid_clip(
    value: Any,
    *,
    viewport_width: int,
    viewport_height: int,
    document_height: int | float | None = None,
) -> dict[str, float] | None:
    if not isinstance(value, Mapping):
        return None
    try:
        x = max(0.0, float(value.get("x", 0)))
        y = max(0.0, float(value.get("y", 0)))
        width = min(float(value.get("width", 0)), float(viewport_width) - x)
        # ``captureBeyondViewport`` lets the profile region include the
        # second row while retaining a fixed browser viewport.  Older callers
        # without document_height keep the previous viewport-bound behavior.
        height_limit = float(document_height) if document_height is not None else float(viewport_height)
        height_limit = max(height_limit, float(viewport_height))
        height = min(float(value.get("height", 0)), height_limit - y)
    except (TypeError, ValueError):
        return None
    if width <= 1 or height <= 1 or x >= viewport_width or y >= viewport_height:
        return None
    return {"x": x, "y": y, "width": width, "height": height, "scale": 1}


def _png_dimensions(image: bytes) -> tuple[int, int] | None:
    """Read PNG dimensions when Chrome returned a complete PNG IHDR chunk."""

    if len(image) < 24 or not image.startswith(PNG_SIGNATURE) or image[12:16] != b"IHDR":
        return None
    try:
        width, height = struct.unpack(">II", image[16:24])
    except struct.error:
        return None
    if width <= 0 or height <= 0:
        return None
    return width, height


async def capture_profile_page(
    session: Any,
    reference: Mapping[str, str],
    *,
    viewport_width: int = 1440,
    viewport_height: int = 1000,
    wait_seconds: float = 5,
) -> tuple[bytes, dict[str, Any]]:
    """Navigate one explicit profile and capture its header and first two rows.

    ``session`` only needs an async ``command`` method, which makes this
    function straightforward to unit test with a fake CDP session.
    """

    await session.command("Page.enable")
    await session.command("Runtime.enable")
    await session.command(
        "Emulation.setDeviceMetricsOverride",
        {
            "width": int(viewport_width),
            "height": int(viewport_height),
            "deviceScaleFactor": 1,
            "mobile": False,
        },
    )
    await session.command("Page.navigate", {"url": reference["url"]})
    await wait_for_page(session, seconds=wait_seconds)
    body_result = await session.command(
        "Runtime.evaluate",
        {"expression": _BODY_TEXT_SCRIPT, "returnByValue": True},
    )
    body = str(_result_value(body_result) or "")
    if any(marker in body for marker in ("请输入验证码", "安全验证", "滑动验证", "验证后继续")):
        raise CaptureBlockedError("抖音页面要求验证码/安全验证；请在 Chrome 中手动完成后重试")
    if "用户不存在" in body or "该用户不存在" in body:
        raise AccountCaptureError("抖音主页不存在或已不可见")
    profile_result = await session.command(
        "Runtime.evaluate",
        {"expression": _PROFILE_SCRIPT, "awaitPromise": True, "returnByValue": True},
    )
    profile = _result_value(profile_result)
    if not isinstance(profile, Mapping):
        profile = {"nickname": "", "page_title": "", "body_excerpt": body[:1200], "clip": None}
    clip = _valid_clip(
        profile.get("clip"),
        viewport_width=viewport_width,
        viewport_height=viewport_height,
        document_height=profile.get("document_height"),
    )
    if not clip:
        raise AccountCaptureError("无法安全定位账号资料区域；页面结构可能已变化")
    params: dict[str, Any] = {
        "format": "png",
        "fromSurface": True,
        "captureBeyondViewport": True,
        "clip": clip,
    }
    mode = "profile-region"
    screenshot_result = await session.command("Page.captureScreenshot", params)
    encoded = screenshot_result.get("data")
    if not isinstance(encoded, str) or not encoded:
        raise AccountCaptureError("Chrome 未返回 PNG 截图数据")
    try:
        image = base64.b64decode(encoded, validate=True)
    except (ValueError, binascii.Error) as exc:
        raise AccountCaptureError("Chrome 返回的截图不是有效 PNG 数据") from exc
    if not image:
        raise AccountCaptureError("Chrome 返回空截图")
    if not image.startswith(PNG_SIGNATURE):
        raise AccountCaptureError("Chrome 返回的数据不是有效 PNG 图片")
    png_dimensions = _png_dimensions(image)
    image_width, image_height = png_dimensions or (
        int(round(clip["width"])),
        int(round(clip["height"])),
    )
    metadata = {
        "nickname": str(profile.get("nickname") or "").strip(),
        "page_title": str(profile.get("page_title") or "").strip(),
        "body_excerpt": str(profile.get("body_excerpt") or body[:1200]),
        "source_url": reference["url"],
        "sec_uid": reference["sec_uid"],
        "viewport": {"width": viewport_width, "height": viewport_height},
        "capture_mode": mode,
        "post_rows": int(profile.get("post_rows") or 0),
        "post_cards_considered": int(profile.get("post_cards_considered") or 0),
        "image_width": image_width,
        "image_height": image_height,
    }
    return image, metadata


async def capture_profiles_async(
    references: list[Mapping[str, str]],
    *,
    output_dir: str | Path,
    port: int = 9221,
    wait_seconds: float = 5,
    viewport_width: int = 1440,
    viewport_height: int = 1000,
    opener: Callable[..., Mapping[str, Any]] = open_tab,
    session_factory: Callable[[str], Any] = CdpSession,
) -> Path:
    """Capture each explicit reference and write a manifest."""

    output = Path(output_dir)
    images_dir = output / "images"
    images_dir.mkdir(parents=True, exist_ok=True)
    items: list[dict[str, Any]] = []
    generated_at = datetime.now().astimezone().isoformat(timespec="seconds")
    for index, reference in enumerate(references, 1):
        target: Mapping[str, Any] | None = None
        base_item: dict[str, Any] = {
            "input": reference.get("input", reference.get("url", "")),
            "source_url": reference.get("url", ""),
            "sec_uid": reference.get("sec_uid", ""),
            "captured_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        }
        try:
            target = opener(reference["url"], port=port)
            websocket_url = target.get("webSocketDebuggerUrl")
            if not websocket_url:
                raise AccountCaptureError("Chrome 未返回主页连接")
            async with session_factory(str(websocket_url)) as session:
                image, metadata = await capture_profile_page(
                    session,
                    reference,
                    viewport_width=viewport_width,
                    viewport_height=viewport_height,
                    wait_seconds=wait_seconds,
                )
            nickname = safe_filename(metadata.get("nickname"), fallback=reference["sec_uid"], limit=48)
            filename = f"{index:02d}-{nickname}-{safe_filename(reference['sec_uid'], limit=32)}.png"
            image_path = images_dir / filename
            image_path.write_bytes(image)
            base_item.update(
                {
                    "status": "ok",
                    "screenshot": str(Path("images") / filename),
                    "capture_mode": metadata["capture_mode"],
                    "viewport": metadata["viewport"],
                    "post_rows": metadata["post_rows"],
                    "post_cards_considered": metadata["post_cards_considered"],
                    "image_width": metadata["image_width"],
                    "image_height": metadata["image_height"],
                    "nickname": metadata["nickname"],
                    "page_title": metadata["page_title"],
                }
            )
        except (AccountCaptureError, CdpError, OSError, asyncio.TimeoutError) as exc:
            base_item.update({"status": "error", "error": str(exc)})
        finally:
            close_tab((target or {}).get("id"), port=port)
        items.append(base_item)

    manifest = {
        "generated_at": generated_at,
        "viewport": {"width": viewport_width, "height": viewport_height},
        "count": len(items),
        "success_count": sum(item.get("status") == "ok" for item in items),
        "items": items,
    }
    (output / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    return output


def capture_profiles(
    references: list[Mapping[str, str]],
    *,
    output_dir: str | Path | None = None,
    port: int = 9221,
    wait_seconds: float = 5,
    viewport_width: int = 1440,
    viewport_height: int = 1000,
    opener: Callable[..., Mapping[str, Any]] = open_tab,
    session_factory: Callable[[str], Any] = CdpSession,
) -> Path:
    """Synchronous API for explicit profile references."""

    if not references:
        raise ValueError("至少需要一个主页 URL/sec_uid")
    output = Path(output_dir) if output_dir else default_output_dir()
    return asyncio.run(
        capture_profiles_async(
            references,
            output_dir=output,
            port=port,
            wait_seconds=wait_seconds,
            viewport_width=viewport_width,
            viewport_height=viewport_height,
            opener=opener,
            session_factory=session_factory,
        )
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="截取指定抖音账号主页（不搜索、不评分）")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("reference", nargs="?", help="抖音 /user/<sec_uid> 主页 URL 或 sec_uid")
    group.add_argument("--input", dest="input_path", help="每行一个主页 URL/sec_uid 的文本文件")
    parser.add_argument("--cdp-port", type=int, default=9221, help="已登录 Chrome 的 CDP 端口（默认 9221）")
    parser.add_argument("--wait", dest="wait_seconds", type=float, default=5, help="页面加载等待秒数（默认 5）")
    parser.add_argument("--viewport-width", type=int, default=1440)
    parser.add_argument("--viewport-height", type=int, default=1000)
    parser.add_argument("--output-dir", help="直接指定本次输出目录；默认 downloads/account-screenshots/<时间>")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        references = read_profile_inputs(args.reference, args.input_path)
        output = capture_profiles(
            references,
            output_dir=args.output_dir,
            port=args.cdp_port,
            wait_seconds=args.wait_seconds,
            viewport_width=args.viewport_width,
            viewport_height=args.viewport_height,
        )
    except (AccountInputError, AccountCaptureError, CdpError, OSError, ValueError) as exc:
        print(f"截图失败：{exc}", file=sys.stderr)
        return 2
    manifest_path = output / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    print(f"已写入截图清单：{manifest_path}")
    return 0 if manifest.get("success_count") == manifest.get("count") else 2


if __name__ == "__main__":
    raise SystemExit(main())
