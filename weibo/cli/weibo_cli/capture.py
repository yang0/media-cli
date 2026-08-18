"""Capture a specified Weibo card and split long cards into 9:16 PNGs."""

from __future__ import annotations

import argparse
import asyncio
import base64
import binascii
import json
import re
from datetime import datetime
from pathlib import Path
from typing import Any, Awaitable, Callable, Mapping
from urllib.parse import urlparse

from .auth import AuthContext
from .browser import CdpError, CdpSession, TemporaryChrome, close_tab, list_tabs, open_tab, wait_for_page
from .splitter import split_image_bytes
from .storage import safe_slug, timestamp_folder


class CaptureError(RuntimeError):
    """Raised when a trusted Weibo card cannot be captured."""


class CaptureBlockedError(CaptureError):
    """Raised when Weibo requests verification or login."""


def parse_weibo_reference(value: str) -> dict[str, str]:
    raw = str(value or "").strip()
    if not raw:
        raise ValueError("微博 URL/数字 ID 不能为空")
    if raw.isdigit():
        return {"id": raw, "url": f"https://m.weibo.cn/detail/{raw}", "input": raw}
    parsed = urlparse(raw)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc or "weibo" not in parsed.netloc.lower():
        raise ValueError("只接受 weibo.com 或 m.weibo.cn 的微博详情 URL，或纯数字微博 ID")
    path_parts = [part for part in parsed.path.split("/") if part]
    bid = ""
    for marker in ("detail", "status"):
        if marker in path_parts:
            index = path_parts.index(marker)
            if index + 1 < len(path_parts):
                bid = path_parts[index + 1]
                break
    if not bid and len(path_parts) >= 2:
        bid = path_parts[-1]
    if not bid or not re.fullmatch(r"[A-Za-z0-9_-]+", bid):
        raise ValueError("无法从微博链接识别微博 ID")
    return {"id": bid, "url": raw, "input": raw}


def read_inputs(reference: str | None = None, input_path: str | Path | None = None) -> list[dict[str, str]]:
    if bool(reference) == bool(input_path):
        raise ValueError("请提供一个微博 URL/ID，或使用 --input 文本文件（二选一）")
    values = [str(reference).strip()] if reference else [
        line.strip()
        for line in Path(input_path).read_text(encoding="utf-8-sig").splitlines()
        if line.strip() and not line.lstrip().startswith("#")
    ]
    if not values:
        raise ValueError("--input 文件中没有可用微博")
    result: list[dict[str, str]] = []
    seen: set[str] = set()
    for value in values:
        parsed = parse_weibo_reference(value)
        if parsed["id"] in seen:
            continue
        seen.add(parsed["id"])
        result.append(parsed)
    return result


def safe_filename(value: str, *, fallback: str = "weibo", limit: int = 64) -> str:
    return safe_slug(value, limit=limit) or safe_slug(fallback, limit=limit)


_CAPTURE_SCRIPT = r"""
(async () => {
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const text = el => ((el && (el.innerText || el.textContent)) || '').trim();
  const targetId = String(window.__weiboCliTargetId || '');
  const selectors = ['button', 'a', '[role="button"]'];
  for (const selector of selectors) {
    for (const el of document.querySelectorAll(selector)) {
      const value = text(el);
      if (value === '全文' || value === '展开全文') { try { el.click(); } catch (_) {} }
    }
  }
  await pause(650);
  const body = text(document.body);
  const blocked = ['请输入验证码', '安全验证', '滑动验证', '登录后查看'];
  if (blocked.some(marker => body.includes(marker))) return {blocked: true, body: body.slice(0, 1000)};
  if (body.includes('微博不存在') || body.includes('内容已被删除')) return {missing: true, body: body.slice(0, 1000)};
  for (const selector of ['nav', 'aside', '.gn_header', '.WB_global_nav', '.comment', '.WB_feed_handle']) {
    for (const el of document.querySelectorAll(selector)) { el.dataset.weiboCliHidden = '1'; el.style.display = 'none'; }
  }
  const candidates = [];
  if (targetId) {
    candidates.push(`[mid="${CSS.escape(targetId)}"]`, `[data-mid="${CSS.escape(targetId)}"]`);
  }
  candidates.push('.WB_detail', 'article[role="article"]', 'article', '[data-testid="post"]', '.WB_feed_type', '.card');
  let card = null;
  for (const selector of candidates) {
    const nodes = Array.from(document.querySelectorAll(selector));
    card = nodes.find(el => {
      const rect = el.getBoundingClientRect();
      const hasText = el.querySelector('.WB_text, .txt, .weibo-text, .wbpro-feed-content, .wbpro-feed-ogText, .wbpro-feed-reText, [class*="_wbtext_"], [data-testid="postText"], [node-type="feed_list_content"], [node-type="feed_list_content_full"]');
      const exact = !targetId || el.getAttribute('mid') === targetId || el.getAttribute('data-mid') === targetId || el.getAttribute('data-id') === targetId || Array.from(el.querySelectorAll('a[href]')).some(link => link.getAttribute('href').includes(targetId));
      const uniqueDetail = targetId && location.href.includes(targetId) && nodes.length === 1 && ['.WB_detail', 'article[role="article"]', 'article', '[data-testid="post"]'].includes(selector);
      return (exact || uniqueDetail) && rect.width > 200 && rect.height > 80 && Boolean(hasText);
    });
    if (card) break;
  }
  if (!card) return {cardNotFound: true, body: body.slice(0, 1000)};
  const cardMedia = [];
  for (const selector of ['img', 'video']) {
    for (const el of card.querySelectorAll(selector)) cardMedia.push(el);
  }
  for (let attempt = 0; attempt < 20; attempt++) {
    const ready = cardMedia.every(el => el.tagName === 'IMG' ? el.complete && el.naturalWidth > 0 : el.readyState >= 2);
    if (ready) break;
    await pause(250);
  }
  const pageY = window.scrollY || window.pageYOffset || 0;
  const rect = card.getBoundingClientRect();
  const clip = {x: Math.max(0, rect.left), y: Math.max(0, rect.top + pageY), width: Math.max(1, rect.width), height: Math.max(1, rect.height)};
  const boundaries = [];
  for (const selector of ['.WB_text', '.txt', '.wbpro-feed-ogText', '.wbpro-feed-reText', '[class*="_wbtext_"]', '.media-piclist', '.WB_media_wrap', '.card-comment', '[class*="_retweet_"]', '.WB_feed_detail p', 'img', 'video']) {
    for (const el of card.querySelectorAll(selector)) {
      const item = el.getBoundingClientRect();
      if (item.height > 1) boundaries.push({y: Math.round(item.bottom + pageY - clip.y), kind: selector});
    }
  }
  const title = text(card.querySelector('a[nick-name], .name, h1')) || document.title;
  return {clip, boundaries, title, body: body.slice(0, 1000), cardFound: true};
})()
"""


def _result_value(result: Mapping[str, Any]) -> Any:
    return (result.get("result") or {}).get("value")


async def capture_weibo_page(
    session: Any,
    reference: Mapping[str, str],
    *,
    viewport_width: int = 900,
    viewport_height: int = 1200,
    wait_seconds: float = 3,
    auth: AuthContext | None = None,
) -> tuple[bytes, dict[str, Any]]:
    await session.command("Page.enable")
    await session.command("Runtime.enable")
    await session.command("Network.enable")
    await session.command("Emulation.setDeviceMetricsOverride", {"width": viewport_width, "height": viewport_height, "deviceScaleFactor": 1, "mobile": False})
    if auth:
        cookie_domain = ".weibo.cn" if "weibo.cn" in urlparse(reference["url"]).netloc.lower() else ".weibo.com"
        cookies = []
        for piece in auth.cookie.split(";"):
            if "=" not in piece:
                continue
            name, value = piece.strip().split("=", 1)
            if name:
                cookies.append({"name": name.strip(), "value": value, "domain": cookie_domain, "path": "/"})
        if cookies:
            await session.command("Network.setCookies", {"cookies": cookies})
    await session.command("Page.navigate", {"url": reference["url"]})
    await wait_for_page(session, seconds=wait_seconds)
    await session.command("Runtime.evaluate", {"expression": f"window.__weiboCliTargetId = {json.dumps(str(reference['id']), ensure_ascii=False)};", "returnByValue": True})
    result = await session.command("Runtime.evaluate", {"expression": _CAPTURE_SCRIPT, "awaitPromise": True, "returnByValue": True})
    value = _result_value(result)
    if not isinstance(value, Mapping):
        raise CaptureError("微博页面没有返回可定位的卡片")
    body = str(value.get("body") or "")
    if value.get("blocked"):
        raise CaptureBlockedError("微博页面要求验证码或登录；请在 Chrome 中手动完成后重试")
    if value.get("missing"):
        raise CaptureError("微博不存在、已删除或当前账号无权查看")
    if value.get("cardNotFound") or not value.get("cardFound"):
        raise CaptureError("无法定位真实微博详情卡片；已拒绝整页截图")
    clip = value.get("clip") if isinstance(value.get("clip"), Mapping) else None
    params: dict[str, Any] = {"format": "png", "fromSurface": True, "captureBeyondViewport": True}
    mode = "card"
    if clip and float(clip.get("width", 0)) > 1 and float(clip.get("height", 0)) > 1:
        params["clip"] = {"x": float(clip["x"]), "y": float(clip["y"]), "width": float(clip["width"]), "height": float(clip["height"]), "scale": 1}
    else:
        raise CaptureError("微博详情卡片没有有效裁剪区域；已拒绝整页截图")
    screenshot = await session.command("Page.captureScreenshot", params)
    encoded = screenshot.get("data") if isinstance(screenshot, Mapping) else None
    if not isinstance(encoded, str) or not encoded:
        raise CaptureError("Chrome 未返回截图数据")
    try:
        image = base64.b64decode(encoded, validate=True)
    except (ValueError, binascii.Error) as exc:
        raise CaptureError("Chrome 返回的截图数据无效") from exc
    if not image.startswith(b"\x89PNG\r\n\x1a\n"):
        raise CaptureError("Chrome 返回的数据不是 PNG")
    metadata = {
        "source_url": reference["url"],
        "weibo_id": reference["id"],
        "capture_mode": mode,
        "title": str(value.get("title") or "").strip(),
        "body_excerpt": body,
        "clip": dict(clip) if clip else None,
        "boundaries": list(value.get("boundaries") or []),
        "viewport": {"width": viewport_width, "height": viewport_height},
    }
    return image, metadata


def default_capture_dir(root: str | Path = "downloads") -> Path:
    base = Path(root) / "weibo" / "captures" / timestamp_folder()
    candidate = base
    index = 1
    while candidate.exists():
        candidate = Path(f"{base}-{index}")
        index += 1
    return candidate


async def capture_async(
    references: list[Mapping[str, str]],
    *,
    output_dir: str | Path,
    port: int = 9221,
    wait_seconds: float = 3,
    overlap: int = 64,
    viewport_width: int = 900,
    viewport_height: int = 1200,
    auth: AuthContext | None = None,
    opener: Callable[..., Mapping[str, Any]] = open_tab,
    session_factory: Callable[[str], Any] = CdpSession,
) -> Path:
    output = Path(output_dir)
    image_dir = output / "images"
    image_dir.mkdir(parents=True, exist_ok=True)
    generated_at = datetime.now().astimezone().isoformat(timespec="seconds")
    items: list[dict[str, Any]] = []
    for reference in references:
        target: Mapping[str, Any] | None = None
        base = {"input": reference.get("input", reference.get("url", "")), "source_url": reference.get("url", ""), "weibo_id": reference.get("id", ""), "captured_at": datetime.now().astimezone().isoformat(timespec="seconds")}
        try:
            target = opener(reference["url"], port=port)
            websocket = target.get("webSocketDebuggerUrl")
            if not websocket:
                raise CaptureError("Chrome 未返回微博页面连接")
            async with session_factory(str(websocket)) as session:
                image, metadata = await capture_weibo_page(session, reference, viewport_width=viewport_width, viewport_height=viewport_height, wait_seconds=wait_seconds, auth=auth)
            pieces = split_image_bytes(image, metadata.get("boundaries", []), overlap=overlap, output_dir=image_dir, weibo_id=safe_filename(reference["id"], fallback="weibo", limit=48))
            for piece in pieces:
                piece.pop("data", None)
                if piece.get("path"):
                    piece["path"] = str(Path(piece["path"]).relative_to(output))
            base.update({"status": "ok", "capture_mode": metadata["capture_mode"], "title": metadata["title"], "viewport": metadata["viewport"], "clip": metadata["clip"], "part_count": len(pieces), "parts": pieces})
        except CaptureBlockedError as exc:
            base.update({"status": "error", "error": str(exc), "error_kind": "blocked"})
        except (CaptureError, CdpError, OSError, ValueError, asyncio.TimeoutError) as exc:
            base.update({"status": "error", "error": str(exc), "error_kind": "capture"})
        finally:
            close_tab((target or {}).get("id"), port=port)
        items.append(base)
    manifest = {"schema_version": 1, "generated_at": generated_at, "count": len(items), "success_count": sum(item.get("status") == "ok" for item in items), "status": "complete" if all(item.get("status") == "ok" for item in items) else "partial", "overlap": overlap, "ratio": "9:16", "items": items}
    (output / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    return output


def capture(references: list[Mapping[str, str]], *, output_dir: str | Path | None = None, port: int = 9221, wait_seconds: float = 3, overlap: int = 64, viewport_width: int = 900, viewport_height: int = 1200, auth: AuthContext | None = None, opener: Callable[..., Mapping[str, Any]] = open_tab, session_factory: Callable[[str], Any] = CdpSession, browser_factory: Callable[[], TemporaryChrome] = TemporaryChrome) -> Path:
    if not references:
        raise ValueError("至少需要一条微博")
    temporary: TemporaryChrome | None = None
    actual_port = port
    actual_opener = opener
    if auth is not None and opener is open_tab:
        try:
            # Reuse the user's existing browser whenever its CDP endpoint is
            # reachable; an empty tab list is still a usable endpoint.
            list_tabs(port)
        except CdpError:
            temporary = browser_factory()
    try:
        if temporary is not None:
            actual_port = temporary.start()
        return asyncio.run(capture_async(references, output_dir=output_dir or default_capture_dir(), port=actual_port, wait_seconds=wait_seconds, overlap=overlap, viewport_width=viewport_width, viewport_height=viewport_height, auth=auth, opener=actual_opener, session_factory=session_factory))
    finally:
        if temporary is not None:
            temporary.close()
