#!/usr/bin/env python3
"""Pure parsing helpers for Douyin account search and profile references.

Douyin changes the shape of its web JSON more often than its public concepts
(nickname, sec_uid, follower count, etc.).  The functions here accept the
common aliases seen in search results and fixtures while keeping the command
modules free of provider-specific parsing details.
"""

from __future__ import annotations

import html
import json
import re
from collections.abc import Iterable, Mapping
from html.parser import HTMLParser
from typing import Any
from urllib.parse import quote, unquote, urlparse


DOUYIN_BASE = "https://www.douyin.com"
_INVALID_FILENAME = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
_USER_PATH = re.compile(r"^/user/([^/?#]+)", re.IGNORECASE)
_COUNT = re.compile(
    r"^\s*([+-]?[\d,]+(?:\.\d+)?)\s*(十亿|亿|千万|百万|十万|万|千|百|[kKmMbB])?\s*(?:粉丝|获赞|点赞|作品|个)?\s*$"
)
_SEC_UID_KEYS = (
    "sec_uid",
    "secUserId",
    "sec_user_id",
    "secUserID",
    "secUid",
)
_URL_KEYS = ("profile_url", "profileUrl", "user_url", "userUrl", "url", "href")


class AccountInputError(ValueError):
    """Raised when a value is not a Douyin user profile reference."""


def parse_count(value: Any) -> int:
    """Convert common Douyin count strings (``1.2万``/``3.4K``) to integers."""

    if value is None or isinstance(value, bool):
        return 0
    if isinstance(value, (int, float)):
        return max(0, int(value))
    text = str(value).replace("\u00a0", " ").strip()
    if not text:
        return 0
    match = _COUNT.match(text.replace("，", ","))
    if not match:
        digits = re.sub(r"[^\d.]", "", text.replace(",", ""))
        try:
            return max(0, int(float(digits))) if digits else 0
        except ValueError:
            return 0
    number = float(match.group(1).replace(",", ""))
    unit = (match.group(2) or "").lower()
    multiplier = {
        "": 1,
        "k": 1_000,
        "千": 1_000,
        "m": 1_000_000,
        "b": 1_000_000_000,
        "万": 10_000,
        "亿": 100_000_000,
        "十万": 100_000,
        "百万": 1_000_000,
        "千万": 10_000_000,
    }.get(unit, 1)
    return max(0, int(round(number * multiplier)))


def clean_text(value: Any) -> str:
    """Return a compact, human-readable string for account fields."""

    if value is None:
        return ""
    if isinstance(value, (dict, list, tuple)):
        return ""
    return " ".join(html.unescape(str(value)).split())


def _first(mapping: Mapping[str, Any], keys: Iterable[str], default: Any = None) -> Any:
    for key in keys:
        if key in mapping and mapping[key] not in (None, ""):
            return mapping[key]
    return default


def _mapping(value: Any) -> Mapping[str, Any]:
    return value if isinstance(value, Mapping) else {}


def _nested_account(raw: Mapping[str, Any]) -> dict[str, Any]:
    """Merge nested user objects while letting the outer result win."""

    merged: dict[str, Any] = {}
    for key in ("user_info", "userInfo", "user", "author", "author_info", "authorInfo"):
        value = raw.get(key)
        if isinstance(value, Mapping):
            merged.update(value)
    merged.update(raw)
    return merged


def _profile_url_from(value: Any) -> str:
    if not isinstance(value, str):
        return ""
    text = value.strip()
    if not text:
        return ""
    try:
        parsed_url = urlparse(text)
        if parsed_url.scheme and parsed_url.netloc:
            text = parsed_url._replace(query="", fragment="").geturl()
        parsed = parse_profile_reference(text)
    except AccountInputError:
        return ""
    return parsed["url"]


def parse_profile_reference(value: str) -> dict[str, str]:
    """Validate a Douyin homepage URL or bare ``sec_uid``.

    A search URL, video URL, arbitrary host, or query string is rejected.  A
    bare token is treated as a sec_uid only when it contains no path/control
    characters.  The return value always contains a canonical homepage URL.
    """

    if not isinstance(value, str):
        raise AccountInputError("账号输入必须是主页 URL 或 sec_uid")
    text = value.strip()
    if not text:
        raise AccountInputError("账号输入不能为空")

    if "://" not in text:
        if any(char in text for char in "/?#\r\n\t "):
            raise AccountInputError("只接受 sec_uid 或抖音 /user/ 主页 URL")
        sec_uid = unquote(text)
        if len(sec_uid) < 4:
            raise AccountInputError("sec_uid 太短，无法识别为账号")
        return {"sec_uid": sec_uid, "url": f"{DOUYIN_BASE}/user/{quote(sec_uid, safe='')}"}

    parsed = urlparse(text)
    host = (parsed.hostname or "").lower()
    if parsed.scheme.lower() not in {"http", "https"} or not (
        host == "douyin.com" or host.endswith(".douyin.com")
    ):
        raise AccountInputError("主页 URL 必须来自 douyin.com")
    match = _USER_PATH.match(parsed.path or "")
    if not match:
        raise AccountInputError("只接受抖音 /user/<sec_uid> 主页 URL")
    if parsed.query or parsed.fragment:
        # Query/fragment are not needed to identify the profile and can hide a
        # search route.  Reject them to keep capture inputs deterministic.
        raise AccountInputError("主页 URL 不应包含 query 或 fragment")
    sec_uid = unquote(match.group(1)).strip()
    if not sec_uid:
        raise AccountInputError("主页 URL 缺少 sec_uid")
    return {"sec_uid": sec_uid, "url": f"{DOUYIN_BASE}/user/{quote(sec_uid, safe='')}"}


def account_key(account: Mapping[str, Any]) -> str:
    """Return the stable deduplication key used by account search."""

    for key in _SEC_UID_KEYS:
        value = clean_text(account.get(key))
        if value:
            return f"sec:{value}"
    for key in ("uid", "user_id", "userId", "id"):
        value = clean_text(account.get(key))
        if value:
            return f"uid:{value}"
    url = clean_text(_first(account, _URL_KEYS, ""))
    if url:
        try:
            return f"url:{parse_profile_reference(url)['sec_uid']}"
        except AccountInputError:
            pass
    nickname = clean_text(_first(account, ("nickname", "nick_name", "name"), ""))
    return f"name:{nickname.lower()}" if nickname else "anonymous:{id(account)}"


def _post_items(raw: Mapping[str, Any]) -> list[Any]:
    for key in ("recent_posts", "recentPosts", "posts", "aweme_list", "awemeList", "videos", "works"):
        value = raw.get(key)
        if isinstance(value, list):
            return value
        if isinstance(value, Mapping):
            for nested_key in ("aweme_list", "items", "list", "data"):
                if isinstance(value.get(nested_key), list):
                    return value[nested_key]
    return []


def normalize_post(raw: Any) -> dict[str, Any]:
    """Normalize one recent-work object for ranking and reporting."""

    source = _mapping(raw)
    stats = _mapping(_first(source, ("statistics", "stats", "statistic"), {}))
    return {
        "aweme_id": clean_text(_first(source, ("aweme_id", "awemeId", "id"), "")),
        "desc": clean_text(_first(source, ("desc", "description", "title"), "")),
        "created_at": _first(source, ("create_time", "createTime", "created_at", "published_at"), 0) or 0,
        "digg": parse_count(_first(stats or source, ("digg_count", "diggCount", "likes", "like_count"), 0)),
        "comment": parse_count(_first(stats or source, ("comment_count", "commentCount", "comments"), 0)),
        "share": parse_count(_first(stats or source, ("share_count", "shareCount", "shares"), 0)),
        "collect": parse_count(_first(stats or source, ("collect_count", "collectCount", "收藏"), 0)),
        "play": parse_count(_first(stats or source, ("play_count", "playCount", "plays", "view_count"), 0)),
    }


def normalize_account(raw: Mapping[str, Any], *, source_rank: int | None = None) -> dict[str, Any]:
    """Normalize one raw account object into a stable JSON-friendly mapping."""

    if not isinstance(raw, Mapping):
        raise TypeError("账号对象必须是 mapping")
    source = _nested_account(raw)
    sec_uid = clean_text(_first(source, _SEC_UID_KEYS, ""))
    profile_url = _profile_url_from(_first(source, _URL_KEYS, ""))
    if not sec_uid and profile_url:
        try:
            sec_uid = parse_profile_reference(profile_url)["sec_uid"]
        except AccountInputError:
            pass
    uid = clean_text(_first(source, ("uid", "user_id", "userId", "id"), ""))
    nickname = clean_text(_first(source, ("nickname", "nick_name", "nickName", "name"), ""))
    bio = clean_text(_first(source, ("signature", "desc", "bio", "description"), ""))
    card_text = clean_text(_first(source, ("card_text", "cardText", "summary", "text"), ""))

    def metric(keys: Iterable[str], labels: Iterable[str]) -> int:
        value = parse_count(_first(source, keys, 0))
        if value or not card_text:
            return value
        for label in labels:
            match = re.search(
                rf"([+-]?[\d,]+(?:\.\d+)?\s*(?:十亿|亿|千万|百万|十万|万|千|百|[kKmMbB])?)\s*{re.escape(label)}",
                card_text,
                re.IGNORECASE,
            )
            if match:
                return parse_count(match.group(1))
        return 0

    followers = metric(
        ("follower_count", "followerCount", "followers", "fans", "fans_count"),
        ("粉丝", "followers", "fans"),
    )
    likes = metric(
        ("total_favorited", "totalFavorited", "liked_count", "likes", "like_count"),
        ("获赞", "点赞", "likes"),
    )
    post_count = metric(
        ("aweme_count", "awemeCount", "post_count", "postCount", "works_count"),
        ("作品", "works", "posts"),
    )
    verified_value = _first(source, ("verified", "is_verified", "isVerified", "custom_verify"), False)
    if isinstance(verified_value, str):
        verified = verified_value.strip().lower() not in {"", "0", "false", "no", "none"}
    else:
        verified = bool(verified_value)
    posts = [normalize_post(item) for item in _post_items(source) if isinstance(item, Mapping)]
    result: dict[str, Any] = {
        "sec_uid": sec_uid,
        "uid": uid,
        "nickname": nickname,
        "bio": bio,
        "followers": followers,
        "likes": likes,
        "post_count": post_count,
        "verified": verified,
        "profile_url": profile_url or (f"{DOUYIN_BASE}/user/{quote(sec_uid, safe='')}" if sec_uid else ""),
        "recent_posts": posts,
    }
    if source_rank is not None:
        result["search_rank"] = int(source_rank)
    return result


def _looks_like_account(raw: Mapping[str, Any]) -> bool:
    keys = set(raw)
    return bool(
        keys.intersection(_SEC_UID_KEYS)
        or keys.intersection(_URL_KEYS)
        or (
            keys.intersection({"nickname", "nick_name", "nickName", "name"})
            and keys.intersection({"follower_count", "followerCount", "followers", "fans"})
        )
    )


def extract_accounts_from_payload(payload: Any) -> list[dict[str, Any]]:
    """Find account-shaped mappings in nested search/API JSON.

    The traversal order is stable and represents the raw search ordering.  It
    intentionally does not perform ranking or deduplication; those are kept in
    ``account_ranking.py`` so callers can inspect the raw result order.
    """

    accounts: list[dict[str, Any]] = []
    visited: set[int] = set()

    def walk(value: Any) -> None:
        if isinstance(value, Mapping):
            marker = id(value)
            if marker in visited:
                return
            visited.add(marker)
            if _looks_like_account(value):
                try:
                    account = normalize_account(value, source_rank=len(accounts) + 1)
                    if account["nickname"] or account["sec_uid"] or account["profile_url"]:
                        accounts.append(account)
                except (TypeError, ValueError):
                    pass
            for child in value.values():
                walk(child)
        elif isinstance(value, (list, tuple)):
            for child in value:
                walk(child)

    walk(payload)
    return accounts


class _AccountLinkParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.accounts: list[dict[str, Any]] = []
        self._current: dict[str, Any] | None = None
        self._stack: list[dict[str, Any]] = []
        self._anchor_index: int | None = None

    @staticmethod
    def _attrs(attrs: list[tuple[str, str | None]]) -> dict[str, str]:
        return {key.lower(): value or "" for key, value in attrs}

    @staticmethod
    def _metric(text: str) -> tuple[str, int] | None:
        """Extract one metric from an independent statistic span."""

        number = r"[+-]?[\d,]+(?:\.\d+)?\s*(?:十亿|亿|千万|百万|十万|万|千|百|[kKmMbB])?"
        labels = r"获赞|点赞|likes|粉丝|followers|fans|作品|works|posts"
        match = re.search(rf"({number})\s*({labels})", text, re.IGNORECASE)
        if match:
            label = match.group(2).lower()
            value = parse_count(match.group(1))
        else:
            match = re.search(rf"({labels})\s*[:：]?\s*({number})", text, re.IGNORECASE)
            if not match:
                return None
            label = match.group(1).lower()
            value = parse_count(match.group(2))
        if label in {"粉丝", "followers", "fans"}:
            return "followers", value
        if label in {"获赞", "点赞", "likes"}:
            return "likes", value
        return "post_count", value

    def _inside_anchor(self) -> bool:
        return self._current is not None and self._anchor_index is not None

    def _append_data(self, data: str) -> None:
        if not self._inside_anchor():
            return
        assert self._current is not None
        assert self._anchor_index is not None
        self._current["_anchor_text"].append(data)
        for entry in self._stack[self._anchor_index + 1 :]:
            entry["text"].append(data)

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        tag_name = tag.lower()
        attributes = self._attrs(attrs)
        if tag_name == "a" and self._current is None:
            href = attributes.get("href") or ""
            if "/user/" in href:
                try:
                    if href.startswith("//"):
                        raw_url = f"https:{href}"
                    else:
                        raw_url = href if "://" in href else f"{DOUYIN_BASE}{href}"
                    parsed_url = urlparse(raw_url)
                    # Search cards sometimes append tracking query parameters.
                    # They do not identify a different account.
                    clean_url = parsed_url._replace(query="", fragment="").geturl()
                    reference = parse_profile_reference(clean_url)
                except AccountInputError:
                    reference = None
                if reference:
                    self._current = {
                        "sec_uid": reference["sec_uid"],
                        "profile_url": reference["url"],
                        "nickname": "",
                        "bio": "",
                        "followers": 0,
                        "likes": 0,
                        "post_count": 0,
                        "verified": False,
                        "_anchor_text": [],
                        "_first_p_seen": False,
                    }
                    self._anchor_index = len(self._stack)

        relative = None
        if self._inside_anchor():
            assert self._anchor_index is not None
            relative = len(self._stack) - self._anchor_index
            classes = attributes.get("class", "")
            data_e2e = attributes.get("data-e2e", "")
            if (
                data_e2e == "badge-role-name"
                or "badge-role-name" in classes
                or "badgeRoleName" in classes
            ):
                assert self._current is not None
                self._current["verified"] = True
        self._stack.append({"tag": tag_name, "attrs": attributes, "text": [], "relative": relative})

    def handle_data(self, data: str) -> None:
        self._append_data(data)
        if self._current is not None and "认证徽章" in data:
            self._current["verified"] = True

    def handle_endtag(self, tag: str) -> None:
        tag_name = tag.lower()
        match_index = next(
            (index for index in range(len(self._stack) - 1, -1, -1) if self._stack[index]["tag"] == tag_name),
            None,
        )
        if match_index is None:
            return
        entry = self._stack[match_index]
        if self._inside_anchor() and self._anchor_index is not None and match_index > self._anchor_index:
            assert self._current is not None
            value = clean_text(" ".join(entry["text"]))
            if tag_name == "p" and value:
                if not self._current["_first_p_seen"]:
                    # Mirrors a.querySelector('p') in the browser script.
                    self._current["nickname"] = value
                    self._current["_first_p_seen"] = True
                if entry["relative"] == 1 and not self._current["bio"]:
                    # Mirrors a.querySelector(':scope > p') in the browser script.
                    self._current["bio"] = value
            elif tag_name == "span" and value:
                metric = self._metric(value)
                if metric:
                    key, metric_value = metric
                    self._current[key] = max(parse_count(self._current.get(key)), metric_value)
        if self._current is not None and self._anchor_index == match_index and tag_name == "a":
            nickname = clean_text(self._current.get("nickname"))
            if not nickname:
                # Keep the old simple-fixture behavior for cards without p,
                # while real cards use the first p and never this fallback.
                for chunk in self._current["_anchor_text"]:
                    candidate = clean_text(chunk)
                    if candidate and not re.search(r"抖音号|获赞|粉丝|作品|likes|followers|posts", candidate, re.IGNORECASE):
                        nickname = candidate
                        break
                self._current["nickname"] = nickname
            self._current["card_text"] = clean_text(" ".join(self._current["_anchor_text"]))
            raw = {key: value for key, value in self._current.items() if not key.startswith("_")}
            account = normalize_account(raw, source_rank=len(self.accounts) + 1)
            self.accounts.append(account)
            self._current = None
            self._anchor_index = None
        del self._stack[match_index:]

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.handle_starttag(tag, attrs)
        self.handle_endtag(tag)


def extract_accounts_from_dom(markup: str) -> list[dict[str, Any]]:
    """Parse account links from a captured search-result HTML fixture."""

    parser = _AccountLinkParser()
    parser.feed(markup or "")
    return parser.accounts


def payload_from_text(text: str) -> Any:
    """Decode JSON text when possible, otherwise return the original string."""

    try:
        return json.loads(text)
    except (TypeError, json.JSONDecodeError):
        return text


def safe_filename(value: Any, *, fallback: str = "account", limit: int = 80) -> str:
    """Create a filesystem-safe, deterministic filename component."""

    text = clean_text(value)
    text = _INVALID_FILENAME.sub("_", text).strip(" .")
    text = re.sub(r"\s+", "_", text)
    return (text or fallback)[: max(1, limit)]
