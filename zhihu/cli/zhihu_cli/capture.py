"""Live DOM capture for explicit Zhihu answers and column articles."""

from __future__ import annotations

import asyncio
import base64
import binascii
import hashlib
import io
import json
import re
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, Mapping

from PIL import Image

from .auth import AuthContext
from .browser import CdpError, CdpSession, TemporaryChrome, close_tab, list_tabs, open_tab, wait_for_page
from .models import ZhihuReference
from .splitter import split_image_bytes


class CaptureError(RuntimeError):
    """Raised when a trusted Zhihu主体 cannot be captured."""


class CaptureBlockedError(CaptureError):
    """Raised when Zhihu asks for login or verification."""


MAX_DOM_BAND_HEIGHT = 12_000
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


_PREPARE_SCRIPT = r"""
(async () => {
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const text = el => ((el && (el.innerText || el.textContent)) || '').trim();
  const targetId = String(window.__zhihuPlusTargetId || '');
  const targetType = String(window.__zhihuPlusTargetType || '');
  const body = text(document.body);
  const blockedMarkers = ['请登录后查看', '登录后查看', '请先登录', '安全验证', '滑动验证', '验证码', '验证后继续'];
  if (location.pathname.includes('/signin') || blockedMarkers.some(marker => body.includes(marker))) {
    return {blocked: true, body: body.slice(0, 1200)};
  }
  if (['该内容已被删除', '内容不存在', '文章不存在', '问题不存在'].some(marker => body.includes(marker))) {
    return {missing: true, body: body.slice(0, 1200)};
  }
  const hide = root => {
    const selectors = [
      'nav', 'header[role="banner"]', '.Comments-container', '.Comments',
      '.CommentEditor', '[class*="CommentBox"]', '[class*="comment"]',
      '.Answer-footer', '.ContentItem-actions', '.RichContent-actions',
      '.Post-SideActions', '.Post-CommentButton', '[data-za-detail-view-element_name="Comments"]'
    ];
    for (const selector of selectors) {
      for (const node of root.querySelectorAll(selector)) {
        node.style.display = 'none';
      }
    }
  };
  const expand = root => {
    for (const node of root.querySelectorAll('button, a, [role="button"], span')) {
      const label = text(node);
      if (/^(全文|阅读全文|展开全文|显示全部|展开)$/.test(label) && node.offsetParent !== null) {
        try { node.click(); } catch (_) {}
      }
    }
  };
  const answerCandidates = Array.from(document.querySelectorAll('.ContentItem.AnswerItem, .AnswerItem'));
  const hasAnswerId = node => {
    const expected = `/answer/${targetId}`;
    for (const link of node.querySelectorAll('a[href]')) {
      const href = link.getAttribute('href') || '';
      if (href.includes(expected)) return true;
    }
    for (const name of ['data-zop', 'data-za-extra-module', 'data-id', 'data-item-id', 'id', 'name']) {
      const value = node.getAttribute(name) || '';
      if (value.includes(targetId)) return true;
    }
    return false;
  };
  let source = null;
  let title = null;
  if (targetType === 'answer') {
    source = answerCandidates.find(hasAnswerId) || null;
    title = document.querySelector('.QuestionHeader-title');
    if (!source) return {cardNotFound: true, body: body.slice(0, 1200), candidateCount: answerCandidates.length};
    if (!title) return {cardNotFound: true, body: body.slice(0, 1200), reason: 'question-title-not-found'};
    expand(source);
  } else if (targetType === 'article') {
    source = document.querySelector('article.Post-Main') || document.querySelector('.Post-Main');
    if (!source) return {cardNotFound: true, body: body.slice(0, 1200), reason: 'post-main-not-found'};
    expand(source);
  } else {
    return {cardNotFound: true, body: body.slice(0, 1200), reason: 'unsupported-type'};
  }
  await pause(700);

  // Zhihu keeps rich-content images lazy even after the answer/article has
  // been expanded.  A clone of the card does not inherit the browser's
  // decoded-image state, so copying it before materialising these images
  // leaves the reserved aspect-ratio boxes blank in later screenshot parts.
  const isPlaceholderSource = raw => {
    const value = String(raw || '').trim();
    if (!value) return true;
    const lower = value.toLowerCase();
    if (lower === 'about:blank' || lower === 'none' || lower.startsWith('data:')) return true;
    return /(?:^|[\/_.-])(placeholder|placehold|spacer|transparent|blank|loading|pixel|1x1)(?:[\/_.?&-]|$)/i.test(lower);
  };
  const toImageUrl = raw => {
    const value = String(raw || '').trim();
    if (isPlaceholderSource(value)) return '';
    try {
      const url = new URL(value, location.href);
      if (!['http:', 'https:'].includes(url.protocol)) return '';
      return url.href;
    } catch (_) {
      return '';
    }
  };
  const imageSources = image => {
    const values = [];
    const add = value => {
      const url = toImageUrl(value);
      if (url && !values.includes(url)) values.push(url);
    };
    add(image.currentSrc);
    add(image.getAttribute('src'));
    for (const name of [
      'data-original', 'data-actualsrc', 'data-src', 'data-lazy-src',
      'data-original-src', 'data-image-url', 'data-url'
    ]) add(image.getAttribute(name));
    for (const raw of [image.getAttribute('srcset'), image.getAttribute('data-srcset')]) {
      for (const entry of String(raw || '').split(',')) {
        add(entry.trim().split(/\s+/)[0]);
      }
    }
    return values;
  };
  const imageHasPixels = image => (
    image.complete && image.naturalWidth > 2 && image.naturalHeight > 2
  );
  const imageIsLoaded = (image, source) => (
    imageHasPixels(image) && toImageUrl(image.currentSrc || image.getAttribute('src')) === source
  );
  const waitForImage = (image, source) => new Promise(resolve => {
    let settled = false;
    const onLoad = () => finish(imageIsLoaded(image, source));
    const onError = () => finish(false);
    const finish = ok => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      image.removeEventListener('load', onLoad);
      image.removeEventListener('error', onError);
      resolve(Boolean(ok));
    };
    const timer = setTimeout(() => finish(imageIsLoaded(image, source)), 3500);
    image.addEventListener('load', onLoad);
    image.addEventListener('error', onError);
    image.loading = 'eager';
    image.removeAttribute('srcset');
    image.removeAttribute('data-srcset');
    image.setAttribute('src', source);
    pause(0).then(() => {
      if (imageIsLoaded(image, source)) finish(true);
    });
  });
  const materializeImage = async image => {
    const candidates = imageSources(image);
    for (const source of candidates) {
      if (imageIsLoaded(image, source)) {
        image.__zhihuPlusImageLoaded = true;
        image.__zhihuPlusImageSource = source;
        return true;
      }
      if (await waitForImage(image, source)) {
        image.__zhihuPlusImageLoaded = true;
        image.__zhihuPlusImageSource = source;
        return true;
      }
    }
    image.__zhihuPlusImageLoaded = false;
    image.__zhihuPlusImageSource = '';
    return false;
  };
  const clearImageSizing = node => {
    for (const property of ['height', 'min-height', 'max-height', 'aspect-ratio', 'background-image']) {
      node.style.removeProperty(property);
    }
  };
  const removeFailedImage = (image, root) => {
    image.removeAttribute('src');
    image.removeAttribute('srcset');
    let node = image;
    while (node && node !== root) {
      clearImageSizing(node);
      const parent = node.parentElement;
      const isPortal = node.matches('figure, [data-portal], [class*="portal" i]');
      const isImageOnlyContainer = node !== image && node.children.length <= 1 && !text(node);
      if ((isPortal || isImageOnlyContainer) && !text(node)) {
        node.remove();
        return;
      }
      node = parent;
    }
    image.remove();
  };
  const transferImageState = (original, clone, root) => {
    const originals = Array.from(original.querySelectorAll('img'));
    const clones = Array.from(clone.querySelectorAll('img'));
    clones.forEach((image, index) => {
      const source = originals[index];
      const actual = source && source.__zhihuPlusImageSource;
      if (!source || !source.__zhihuPlusImageLoaded || !actual) {
        removeFailedImage(image, root);
        return;
      }
      image.loading = 'eager';
      image.removeAttribute('srcset');
      image.removeAttribute('data-srcset');
      for (const name of [
        'data-original', 'data-actualsrc', 'data-src', 'data-lazy-src',
        'data-original-src', 'data-image-url', 'data-url'
      ]) image.removeAttribute(name);
      image.classList.remove('lazy', 'lazy-image', 'is-lazy');
      image.setAttribute('src', actual);
    });
  };
  const sourceImages = Array.from(source.querySelectorAll('img'));
  const originalScrollY = window.scrollY || window.pageYOffset || 0;
  for (const image of sourceImages) {
    image.loading = 'eager';
    try { image.scrollIntoView({block: 'center', inline: 'nearest'}); } catch (_) {}
    await pause(60);
  }
  await Promise.all(sourceImages.map(materializeImage));
  try { window.scrollTo(0, originalScrollY); } catch (_) {}

  const wrapper = document.createElement('div');
  wrapper.id = 'zhihu-plus-capture-root';
  wrapper.style.cssText = [
    'position:absolute', 'left:0', 'top:0',
    `width:${Math.max(320, Math.min(960, (document.documentElement.clientWidth || window.innerWidth || 900) - 48))}px`,
    'box-sizing:border-box', 'background:#fff', 'color:#18191c', 'z-index:2147483647',
    'padding:0 0 24px', 'overflow:visible'
  ].join(';');
  if (targetType === 'answer') {
    const titleClone = title.cloneNode(true);
    const answerClone = source.cloneNode(true);
    hide(titleClone);
    hide(answerClone);
    transferImageState(title, titleClone, wrapper);
    transferImageState(source, answerClone, wrapper);
    wrapper.append(titleClone, answerClone);
  } else {
    const articleClone = source.cloneNode(true);
    hide(articleClone);
    transferImageState(source, articleClone, wrapper);
    wrapper.append(articleClone);
  }
  document.body.append(wrapper);
  await pause(250);
  let images = Array.from(wrapper.querySelectorAll('img'));
  for (let attempt = 0; attempt < 24; attempt++) {
    if (images.every(imageHasPixels)) break;
    await pause(250);
  }
  const beforePruneImageCount = images.length;
  for (const image of images) {
    if (!imageHasPixels(image)) removeFailedImage(image, wrapper);
  }
  images = Array.from(wrapper.querySelectorAll('img'));
  const rootRect = wrapper.getBoundingClientRect();
  const pageY = window.scrollY || window.pageYOffset || 0;
  const clip = {
    x: Math.max(0, rootRect.left),
    y: Math.max(0, rootRect.top + pageY),
    width: Math.max(1, rootRect.width),
    height: Math.max(1, rootRect.height)
  };
  const boundarySelectors = [
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'blockquote', 'li',
    'pre', 'table', 'figure', 'img', '.RichContent-inner',
    '.QuestionAnswer-content', '.Post-RichTextContainer'
  ];
  const boundaries = [];
  for (const selector of boundarySelectors) {
    for (const node of wrapper.querySelectorAll(selector)) {
      const rect = node.getBoundingClientRect();
      if (rect.height > 1 && rect.bottom > rootRect.top) {
        boundaries.push({y: Math.round(rect.bottom - rootRect.top), kind: selector});
      }
    }
  }
  const titleText = targetType === 'answer'
    ? text(title)
    : text(wrapper.querySelector('.Post-Header-title, h1'));
  const authorNode = wrapper.querySelector(
    '.AuthorInfo-name .UserLink-link, .AuthorInfo-name, .Post-Author meta[itemprop="name"], meta[itemprop="name"]'
  );
  const authorText = text(authorNode) || ((authorNode && authorNode.getAttribute('content')) || '').trim();
  return {
    cardFound: true,
    wrapperId: wrapper.id,
    clip,
    boundaries,
    title: titleText,
    author: authorText,
    body: text(wrapper).slice(0, 1200),
    captureMode: targetType === 'answer' ? 'answer-question-title-and-answer' : 'article-post-main',
    documentHeight: Math.ceil(clip.height),
    imageCount: images.length,
    removedImageCount: Math.max(0, beforePruneImageCount - images.length),
    candidateCount: answerCandidates.length
  };
})()
"""


def _result_value(result: Mapping[str, Any]) -> Any:
    return (result.get("result") or {}).get("value")


def _decode_png(value: Any) -> bytes:
    if not isinstance(value, str) or not value:
        raise CaptureError("Chrome 未返回截图数据")
    try:
        data = base64.b64decode(value, validate=True)
    except (ValueError, binascii.Error) as exc:
        raise CaptureError("Chrome 返回的截图数据无效") from exc
    if not data.startswith(PNG_SIGNATURE):
        raise CaptureError("Chrome 返回的数据不是 PNG")
    return data


def _png_size(data: bytes) -> tuple[int, int]:
    try:
        image = Image.open(io.BytesIO(data))
        image.load()
    except Exception as exc:
        raise CaptureError("截图不是有效 PNG") from exc
    return image.width, image.height


def _cookie_params(auth: AuthContext | None) -> list[dict[str, Any]]:
    if not auth:
        return []
    result = []
    for piece in auth.cookie.split(";"):
        if "=" not in piece:
            continue
        name, value = piece.strip().split("=", 1)
        if name:
            result.append({"name": name.strip(), "value": value, "domain": ".zhihu.com", "path": "/"})
    return result


def _bands(height: int, *, maximum: int = MAX_DOM_BAND_HEIGHT) -> list[tuple[int, int]]:
    if height <= 0:
        raise CaptureError("知乎主体高度无效")
    return [(top, min(height, top + maximum)) for top in range(0, height, maximum)]


async def _capture_band(session: Any, clip: Mapping[str, Any], top: int, bottom: int) -> bytes:
    params = {
        "format": "png",
        "fromSurface": True,
        "captureBeyondViewport": True,
        "clip": {
            "x": float(clip["x"]),
            "y": float(clip["y"]) + top,
            "width": float(clip["width"]),
            "height": float(bottom - top),
            "scale": 1,
        },
    }
    result = await session.command("Page.captureScreenshot", params)
    return _decode_png(result.get("data") if isinstance(result, Mapping) else None)


def _stitch_bands(bands: list[tuple[int, int, bytes]]) -> tuple[bytes, list[dict[str, Any]]]:
    if not bands:
        raise CaptureError("没有可用截图分带")
    images: list[Image.Image] = []
    records: list[dict[str, Any]] = []
    try:
        for top, bottom, data in bands:
            image = Image.open(io.BytesIO(data)).convert("RGBA")
            images.append(image)
            records.append({
                "top": top,
                "bottom": bottom,
                "height_css": bottom - top,
                "width": image.width,
                "height": image.height,
                "sha256": hashlib.sha256(data).hexdigest(),
            })
        width = images[0].width
        if any(image.width != width for image in images):
            raise CaptureError("Chrome 分带宽度不一致，无法安全拼接")
        canvas = Image.new("RGBA", (width, sum(image.height for image in images)), (255, 255, 255, 255))
        cursor = 0
        for image in images:
            canvas.paste(image, (0, cursor))
            cursor += image.height
        output = io.BytesIO()
        canvas.save(output, format="PNG")
        return output.getvalue(), records
    finally:
        for image in images:
            image.close()


async def capture_zhihu_page(
    session: Any,
    reference: ZhihuReference,
    *,
    wait_seconds: float = 5,
    auth: AuthContext | None = None,
    viewport_width: int = 900,
    viewport_height: int = 1200,
) -> tuple[bytes, dict[str, Any]]:
    """Capture only the isolated live-DOM Zhihu主体."""

    if viewport_width < 320 or viewport_height < 320:
        raise ValueError("viewport 尺寸过小")
    await session.command("Page.enable")
    await session.command("Runtime.enable")
    await session.command("Network.enable")
    await session.command(
        "Emulation.setDeviceMetricsOverride",
        {"width": viewport_width, "height": viewport_height, "deviceScaleFactor": 1, "mobile": False},
    )
    cookies = _cookie_params(auth)
    if cookies:
        await session.command("Network.setCookies", {"cookies": cookies})
    await session.command("Page.navigate", {"url": reference.url})
    await wait_for_page(session, seconds=wait_seconds)
    await session.command(
        "Runtime.evaluate",
        {"expression": f"window.__zhihuPlusTargetId={json.dumps(reference.id)};window.__zhihuPlusTargetType={json.dumps(reference.type)};", "returnByValue": True},
    )
    prepared = await session.command("Runtime.evaluate", {"expression": _PREPARE_SCRIPT, "awaitPromise": True, "returnByValue": True})
    value = _result_value(prepared)
    if not isinstance(value, Mapping):
        raise CaptureError("知乎页面没有返回主体定位结果")
    if value.get("blocked"):
        raise CaptureBlockedError("知乎页面要求登录或验证码；请在 Chrome 中手动完成后重试")
    if value.get("missing"):
        raise CaptureError("知乎内容不存在、已删除或当前账号无权查看")
    if value.get("cardNotFound") or not value.get("cardFound"):
        raise CaptureError("无法定位精确知乎回答/专栏文章主体；已拒绝整页截图")
    clip = value.get("clip")
    if not isinstance(clip, Mapping) or float(clip.get("width", 0)) <= 1 or float(clip.get("height", 0)) <= 1:
        raise CaptureError("知乎主体没有有效裁剪区域；已拒绝整页截图")
    height = int(round(float(clip["height"])))
    cleanup = "document.getElementById('zhihu-plus-capture-root')?.remove();delete window.__zhihuPlusTargetId;delete window.__zhihuPlusTargetType;"
    try:
        bands: list[tuple[int, int, bytes]] = []
        for top, bottom in _bands(height):
            bands.append((top, bottom, await _capture_band(session, clip, top, bottom)))
        image, band_records = _stitch_bands(bands)
    finally:
        try:
            await session.command("Runtime.evaluate", {"expression": cleanup, "returnByValue": True})
        except Exception:
            pass
    metadata = {
        "source_url": reference.url,
        "zhihu_type": reference.type,
        "zhihu_id": reference.id,
        "capture_mode": str(value.get("captureMode") or reference.type),
        "title": str(value.get("title") or "").strip(),
        "author": str(value.get("author") or "").strip(),
        "clip": dict(clip),
        "dom_height_css": height,
        "boundaries": list(value.get("boundaries") or []),
        "bands": band_records,
        "image_count": int(value.get("imageCount") or 0),
        "removed_image_count": int(value.get("removedImageCount") or 0),
        "viewport": {"width": viewport_width, "height": viewport_height},
        "body_excerpt": str(value.get("body") or ""),
    }
    return image, metadata


def safe_filename(value: str, *, fallback: str = "zhihu", limit: int = 64) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9_-]+", "-", str(value or "")).strip("-")
    return (cleaned[:limit] or fallback[:limit])


def default_capture_dir(root: str | Path = "downloads") -> Path:
    timestamp = datetime.now().astimezone().strftime("%Y%m%d-%H%M%S")
    base = Path(root) / "zhihu" / "captures" / timestamp
    candidate = base
    suffix = 1
    while candidate.exists():
        candidate = Path(f"{base}-{suffix}")
        suffix += 1
    return candidate


async def capture_async(
    references: list[ZhihuReference],
    *,
    output_dir: str | Path,
    port: int = 9221,
    wait_seconds: float = 5,
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
        base: dict[str, Any] = {
            "input": reference.input,
            "source_url": reference.url,
            "zhihu_type": reference.type,
            "zhihu_id": reference.id,
            "question_id": reference.question_id,
            "captured_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        }
        try:
            target = opener(reference.url, port=port)
            websocket = target.get("webSocketDebuggerUrl")
            if not websocket:
                raise CaptureError("Chrome 未返回知乎页面连接")
            async with session_factory(str(websocket)) as session:
                image, metadata = await capture_zhihu_page(
                    session,
                    reference,
                    wait_seconds=wait_seconds,
                    auth=auth,
                    viewport_width=viewport_width,
                    viewport_height=viewport_height,
                )
            pieces = split_image_bytes(
                image,
                metadata.get("boundaries", []),
                overlap=overlap,
                output_dir=image_dir,
                zhihu_id=safe_filename(f"{reference.type}-{reference.id}", fallback="zhihu", limit=56),
            )
            for piece in pieces:
                piece.pop("data", None)
                if piece.get("path"):
                    piece["path"] = str(Path(piece["path"]).relative_to(output))
            base.update({
                "status": "ok",
                "capture_mode": metadata["capture_mode"],
                "title": metadata["title"],
                "author": metadata["author"],
                "clip": metadata["clip"],
                "dom_height_css": metadata["dom_height_css"],
                "bands": metadata["bands"],
                "image_count": metadata["image_count"],
                "removed_image_count": metadata["removed_image_count"],
                "viewport": metadata["viewport"],
                "part_count": len(pieces),
                "parts": pieces,
            })
        except CaptureBlockedError as exc:
            base.update({"status": "error", "error": str(exc), "error_kind": "blocked"})
        except (CaptureError, CdpError, OSError, ValueError, asyncio.TimeoutError) as exc:
            base.update({"status": "error", "error": str(exc), "error_kind": "capture"})
        finally:
            close_tab((target or {}).get("id"), port=port)
        items.append(base)
    manifest = {
        "schema_version": 1,
        "generated_at": generated_at,
        "count": len(items),
        "success_count": sum(item.get("status") == "ok" for item in items),
        "failed_count": sum(item.get("status") != "ok" for item in items),
        "status": "complete" if all(item.get("status") == "ok" for item in items) else "partial",
        "ratio": "9:16",
        "max_dom_band_height_css": MAX_DOM_BAND_HEIGHT,
        "overlap": overlap,
        "items": items,
    }
    (output / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    return output


def capture(
    references: list[ZhihuReference],
    *,
    output_dir: str | Path | None = None,
    port: int = 9221,
    wait_seconds: float = 5,
    overlap: int = 64,
    viewport_width: int = 900,
    viewport_height: int = 1200,
    auth: AuthContext | None = None,
    opener: Callable[..., Mapping[str, Any]] = open_tab,
    session_factory: Callable[[str], Any] = CdpSession,
    browser_factory: Callable[[], TemporaryChrome] = TemporaryChrome,
) -> Path:
    if not references:
        raise ValueError("至少需要一条知乎 URL")
    temporary: TemporaryChrome | None = None
    actual_port = int(port)
    try:
        if opener is open_tab:
            try:
                list_tabs(actual_port)
            except CdpError:
                if auth is None:
                    raise CdpError("Chrome CDP 不可用且没有 Cookie，无法启动已认证截图")
                temporary = browser_factory()
                actual_port = temporary.start()
        return asyncio.run(
            capture_async(
                references,
                output_dir=output_dir or default_capture_dir(),
                port=actual_port,
                wait_seconds=wait_seconds,
                overlap=overlap,
                viewport_width=viewport_width,
                viewport_height=viewport_height,
                auth=auth,
                opener=opener,
                session_factory=session_factory,
            )
        )
    finally:
        if temporary is not None:
            temporary.close()
