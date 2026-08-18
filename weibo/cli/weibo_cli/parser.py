"""HTML parser for public Weibo search cards.

The selectors intentionally follow the selectors used by the authorised
reference project, with a few defensive fallbacks for the newer ``woo`` card
markup.  Parsing is dependency-light: lxml is used when available (it is a
Scrapy dependency), and a conservative regex fallback keeps fixture tests and
``auth``/CLI help usable before optional dependencies are installed.
"""

from __future__ import annotations

import html as html_lib
import re
from datetime import datetime, timedelta
from typing import Any, Iterable
from urllib.parse import urljoin, urlparse

from .models import SearchResult, WEIBO_FIELDS


class ParseError(ValueError):
    """Raised when a response cannot be parsed as a Weibo search page."""


def _clean(value: str | None) -> str:
    value = html_lib.unescape(value or "")
    value = value.replace("\u200b", "").replace("\ue627", "")
    return re.sub(r"\s+", " ", value).strip()


def standardize_date(value: str, *, now: datetime | None = None) -> str:
    """Normalize reference-project relative timestamps without losing data."""

    raw = _clean(value)
    text = raw.replace(" ", "")
    if not text:
        return ""
    now = now or datetime.now()
    try:
        if "刚刚" in text:
            return now.strftime("%Y-%m-%d %H:%M")
        match = re.match(r"(\d+)秒", text)
        if match:
            return (now - timedelta(seconds=int(match.group(1)))).strftime("%Y-%m-%d %H:%M")
        match = re.match(r"(\d+)分钟", text)
        if match:
            return (now - timedelta(minutes=int(match.group(1)))).strftime("%Y-%m-%d %H:%M")
        match = re.match(r"(\d+)小时", text)
        if match:
            return (now - timedelta(hours=int(match.group(1)))).strftime("%Y-%m-%d %H:%M")
        if text.startswith("今天"):
            return now.strftime("%Y-%m-%d ") + (raw[2:].strip() or text[2:])
        if re.fullmatch(r"\d{2}-\d{2}\s+\d{2}:\d{2}", raw):
            return f"{now.year}-{raw}"
        if re.fullmatch(r"\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}", raw):
            return raw
        if re.fullmatch(r"\d{4}年\d{1,2}月\d{1,2}日\s+\d{2}:\d{2}", raw):
            return datetime.strptime(raw, "%Y年%m月%d日 %H:%M").strftime("%Y-%m-%d %H:%M")
    except ValueError:
        return text
    return text


def extract_count(value: str | None) -> int:
    """Convert Weibo's ``万``/``亿`` counters to integers."""

    text = _clean(value).replace(",", "").replace("，", "")
    if not text or text in {"赞", "转发", "评论"}:
        return 0
    match = re.search(r"([\d.]+)\s*(亿|万)?", text)
    if not match:
        return 0
    try:
        number = float(match.group(1))
        multiplier = {"万": 10_000, "亿": 100_000_000}.get(match.group(2) or "", 1)
        return int(number * multiplier)
    except ValueError:
        return 0


def _class_has(node: Any, name: str) -> bool:
    return name in set(str(node.get("class", "")).split())


def _text(node: Any, xpath: str = ".") -> str:
    try:
        return _clean(" ".join(node.xpath(f"{xpath}//text()")))
    except (AttributeError, TypeError):
        return ""


def _first(node: Any, xpath: str) -> Any | None:
    try:
        values = node.xpath(xpath)
        return values[0] if values else None
    except (AttributeError, TypeError):
        return None


def _attr(node: Any, name: str) -> str:
    try:
        return str(node.get(name) or "")
    except AttributeError:
        return ""


def _href_id(href: str) -> str:
    parts = [part for part in urlparse(href).path.split("/") if part]
    return parts[-1] if parts else ""


def _canonical_status_link(node: Any) -> tuple[Any | None, str, str]:
    """Find a ``weibo.com/<uid>/<bid>`` link in modern nested cards."""

    fallback: tuple[Any | None, str, str] = (None, "", "")
    try:
        anchors = node.xpath(".//a[@href]")
    except AttributeError:
        return fallback
    for anchor in anchors:
        href = _attr(anchor, "href")
        absolute = "https:" + href if href.startswith("//") else urljoin("https://weibo.com", href)
        parsed = urlparse(absolute)
        parts = [part for part in parsed.path.split("/") if part]
        if not parsed.netloc.lower().endswith("weibo.com") or len(parts) != 2:
            continue
        uid, bid = parts
        if not uid.isdigit() or not re.fullmatch(r"[A-Za-z0-9]+", bid):
            continue
        candidate = (anchor, uid, bid)
        fallback = fallback if fallback[0] is not None else candidate
        if re.search(r"\d{1,2}[-月]\d{1,2}|\d{1,2}:\d{2}", _text(anchor)):
            return candidate
    return fallback


def _normalize_image_url(value: str, *, base_url: str = "https://weibo.com") -> str:
    value = html_lib.unescape(_clean(value))
    if not value:
        return ""
    if value.startswith("//"):
        return "https:" + value
    return urljoin(base_url, value)


def _topics_and_users(node: Any) -> tuple[list[str], list[str]]:
    topics: list[str] = []
    users: list[str] = []
    try:
        for anchor in node.xpath(".//a"):
            text = _text(anchor)
            href = _attr(anchor, "href")
            if text.startswith("#") or "topic" in href.lower():
                if text and text not in topics:
                    topics.append(text)
            if text.startswith("@") or "u/" in href or "weibo.com" in href and "n/" in href:
                if text and text not in users:
                    users.append(text)
    except AttributeError:
        pass
    return topics, users


def _text_and_location(node: Any) -> tuple[str, str]:
    text = _text(node)
    # Weibo appends location as a small ``[地点]`` marker.  Keep the marker in
    # the text only when no reliable location can be separated.
    location = ""
    match = re.search(r"(?:来自|发布于|地点)[:：]\s*([^\s]+)", text)
    if match:
        location = match.group(1)
    return text, location


def _parse_node(node: Any, *, query: str, source_url: str, now: datetime | None = None, retweet_id: str = "") -> dict[str, Any] | None:
    mid = _attr(node, "mid") or _attr(node, "data-mid") or _attr(node, "id").removeprefix("M_")
    from_link = _first(node, ".//div[contains(@class,'from')]//a[1]")
    from_href = _attr(from_link, "href") if from_link is not None else ""
    bid = _href_id(from_href)
    status_link, status_user_id, status_bid = _canonical_status_link(node)
    if not bid:
        bid = status_bid
    if from_link is None and status_link is not None:
        from_link = status_link
    info = _first(node, ".//*[contains(concat(' ',normalize-space(@class),' '),' info ')]")
    user_link = _first(node, ".//a[@nick-name or contains(@href,'/u/') or contains(@href,'/n/')]")
    user_href = _attr(user_link, "href") if user_link is not None else ""
    user_id = _href_id(user_href)
    if not user_id:
        user_id = status_user_id
    screen_name = _attr(user_link, "nick-name") if user_link is not None else ""
    if not screen_name and user_link is not None:
        screen_name = _text(user_link)
    txt = _first(node, ".//p[contains(concat(' ',normalize-space(@class),' '),' txt ') and not(contains(@node-type,'full'))]")
    full = _first(node, ".//p[@node-type='feed_list_content_full']")
    text_node = full if full is not None else txt
    if text_node is None:
        text_node = _first(node, ".//*[contains(@class,'txt')]")
    if text_node is None or not (mid or bid):
        return None
    text, location = _text_and_location(text_node)
    article_url = ""
    try:
        for anchor in text_node.xpath(".//a"):
            href = _attr(anchor, "href")
            if "article" in href or "toutiao" in href:
                article_url = urljoin(source_url, href)
                break
    except AttributeError:
        pass
    topics, at_users = _topics_and_users(text_node)
    pics: list[str] = []
    for image in node.xpath(".//div[contains(@class,'media-piclist')]//img/@src | .//img[contains(@class,'pic')]/@src"):
        value = _normalize_image_url(str(image), base_url=source_url)
        if value and value not in pics:
            pics.append(value)
    video_urls: list[str] = []
    for video in node.xpath(".//video/@src | .//video-player/@src | .//video-player/@data-src"):
        value = html_lib.unescape(str(video))
        if value.startswith("//"):
            value = "https:" + value
        elif value.startswith("://"):
            value = "https" + value
        if value and value not in video_urls:
            video_urls.append(value)
    if not video_urls:
        for match in re.findall(r"src\s*:\s*['\"](.*?)['\"]", "".join(node.xpath(".//video-player//text()"))):
            value = html_lib.unescape(match)
            if value.startswith("//"):
                value = "https:" + value
            elif value.startswith("http:"):
                pass
            elif value.startswith("/"):
                value = urljoin(source_url, value)
            if value and value not in video_urls:
                video_urls.append(value)
    from_text = _text(from_link) if from_link is not None else ""
    source = ""
    try:
        from_links = node.xpath(".//div[contains(@class,'from')]//a")
        if len(from_links) > 1:
            source = _text(from_links[1])
    except AttributeError:
        pass
    auth = "普通用户"
    auth_svg = _first(node, ".//*[local-name()='svg']/@id")
    auth_key = str(auth_svg or "")
    auth = {"woo_svg_vblue": "蓝V", "woo_svg_vyellow": "黄V", "woo_svg_vorange": "红V", "woo_svg_vgold": "金V"}.get(auth_key, auth)
    values: dict[str, Any] = {
        "id": mid or bid,
        "bid": bid,
        "url": (f"https://weibo.com/{user_id}/{bid}" if user_id and bid else f"https://weibo.com/detail/{mid or bid}"),
        "query": query,
        "user_id": user_id,
        "screen_name": screen_name,
        "text": text,
        "article_url": article_url,
        "pics": pics,
        "video_urls": video_urls,
        "location": location,
        "created_at": standardize_date(from_text, now=now),
        "reposts_count": extract_count(_text(_first(node, ".//a[@action-type='feed_list_forward']"))),
        "comments_count": extract_count(_text(_first(node, ".//a[@action-type='feed_list_comment']"))),
        "attitudes_count": extract_count(_text(_first(node, ".//a[@action-type='feed_list_like']"))),
        "source": source,
        "topics": topics,
        "at_users": at_users,
        "retweet_id": retweet_id,
        "ip": "",
        "user_authentication": auth,
        "vip_type": "",
        "vip_level": 0,
        "captured_at": (now or datetime.now()).astimezone().isoformat(timespec="seconds") if (now or datetime.now()).tzinfo else datetime.now().astimezone().isoformat(timespec="seconds"),
    }
    return SearchResult(values).as_dict()


def _parse_with_lxml(markup: str, *, query: str, source_url: str) -> tuple[list[dict[str, Any]], int, str | None, bool]:
    try:
        from lxml import html as lxml_html
    except ImportError as exc:
        raise ParseError("解析搜索页需要 lxml（安装 Scrapy 后会自动获得）") from exc
    document = lxml_html.fromstring(markup or "<html></html>")
    cards = document.xpath("//div[contains(concat(' ',normalize-space(@class),' '),' card-wrap ')]")
    if not cards:
        cards = document.xpath("//article[contains(@class,'card-wrap') or @data-mid]")
    results: list[dict[str, Any]] = []
    for card in cards:
        item = _parse_node(card, query=query, source_url=source_url)
        if item:
            # Reference behaviour stores the embedded retweet as a separate
            # record.  Keep the parent and relationship in this pass; nested
            # card extraction is handled by the dedicated helper below.
            nested = _first(card, ".//div[contains(concat(' ',normalize-space(@class),' '),' card-comment ')]")
            if nested is not None:
                retweet = _parse_node(nested, query=query, source_url=source_url)
                if retweet and retweet.get("id") and retweet["id"] != item.get("id"):
                    item["retweet_id"] = retweet["id"]
                    results.append(retweet)
            results.append(item)
    page_count = len(document.xpath("//ul[contains(concat(' ',normalize-space(@class),' '),' s-scroll ')]/li"))
    if not page_count:
        page_count = len(cards)
    next_href = _attr(_first(document, "//a[contains(concat(' ',normalize-space(@class),' '),' next ')]"), "href")
    empty = bool(document.xpath("//div[contains(@class,'card-no-result')]") or not cards)
    return results, page_count, urljoin(source_url, next_href) if next_href else None, empty


def parse_search_page(markup: str, *, query: str = "", source_url: str = "https://s.weibo.com") -> dict[str, Any]:
    """Parse one search response into records and pagination metadata."""

    if not isinstance(markup, str):
        raise ParseError("搜索响应必须是 HTML 文本")
    try:
        results, page_count, next_url, empty = _parse_with_lxml(markup, query=query, source_url=source_url)
    except (ImportError, ParseError):
        # Very small fallback for environments that intentionally omit lxml.
        ids = re.findall(r"(?:mid|data-mid)=[\"']([^\"']+)", markup)
        results = [SearchResult({"id": value, "bid": value, "url": f"https://weibo.com/detail/{value}", "query": query, "text": ""}).as_dict() for value in dict.fromkeys(ids)]
        next_match = re.search(r"<a[^>]+class=[\"'][^\"']*next[^\"']*[\"'][^>]+href=[\"']([^\"']+)", markup, re.I)
        next_url = urljoin(source_url, next_match.group(1)) if next_match else None
        page_count = len(re.findall(r"<li\b", markup, re.I))
        empty = not results
    return {"items": results, "page_count": page_count, "next_url": next_url, "empty": empty}


def normalise_record(record: dict[str, Any], *, query: str = "", source_url: str = "") -> dict[str, Any]:
    """Fill the public schema for records supplied by custom fetchers."""

    values = dict(record)
    values.setdefault("query", query)
    values.setdefault("url", source_url)
    values.setdefault("captured_at", datetime.now().astimezone().isoformat(timespec="seconds"))
    for field in WEIBO_FIELDS:
        if field not in values:
            values[field] = [] if field in {"pics", "video_urls", "topics", "at_users"} else ""
    return SearchResult(values).as_dict()
