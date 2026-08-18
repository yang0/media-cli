#!/usr/bin/env python3
"""Transparent, deterministic account ranking helpers."""

from __future__ import annotations

import math
from datetime import datetime, timezone
from statistics import median
from typing import Any, Iterable, Mapping

try:  # direct ``python account_ranking.py``/CLI execution
    from account_parser import account_key, normalize_account, parse_count
except ImportError:  # package-style imports
    from .account_parser import account_key, normalize_account, parse_count


def post_engagement(post: Mapping[str, Any]) -> int:
    """Interaction score aligned with the existing video statistics script."""

    return (
        parse_count(post.get("digg", post.get("digg_count", 0)))
        + parse_count(post.get("collect", post.get("collect_count", 0))) * 2
        + parse_count(post.get("share", post.get("share_count", 0)))
        + parse_count(post.get("comment", post.get("comment_count", 0)))
    )


def recent_engagement_values(account: Mapping[str, Any], limit: int = 12) -> list[int]:
    posts = account.get("recent_posts") or account.get("posts") or []
    values = [post_engagement(post) for post in posts if isinstance(post, Mapping)]
    return values[: max(0, int(limit))]


def engagement_median(account: Mapping[str, Any], limit: int = 12) -> float:
    values = recent_engagement_values(account, limit)
    return float(median(values)) if values else 0.0


def _timestamp(value: Any) -> float:
    if isinstance(value, (int, float)):
        number = float(value)
        # Douyin create_time is normally seconds; tolerate milliseconds.
        return number / 1000 if number > 10_000_000_000 else number
    if isinstance(value, str):
        text = value.strip()
        if text.isdigit():
            return _timestamp(int(text))
        try:
            return datetime.fromisoformat(text.replace("Z", "+00:00")).timestamp()
        except ValueError:
            return 0.0
    return 0.0


def latest_post_timestamp(account: Mapping[str, Any]) -> float:
    posts = account.get("recent_posts") or account.get("posts") or []
    return max(
        (_timestamp(post.get("created_at", post.get("create_time", 0))) for post in posts if isinstance(post, Mapping)),
        default=0.0,
    )


def _log_component(value: float, maximum: float) -> float:
    if value <= 0 or maximum <= 0:
        return 0.0
    return min(100.0, max(0.0, math.log1p(value) / math.log1p(maximum) * 100.0))


def _freshness_component(timestamp: float, *, now: float) -> float:
    if timestamp <= 0:
        return 0.0
    age_days = max(0.0, (now - timestamp) / 86400)
    # 30 days is a useful, explainable activity window for recommendations.
    return max(0.0, min(100.0, 100.0 * (1.0 - age_days / 30.0)))


def score_account(
    account: Mapping[str, Any],
    *,
    max_followers: int | float = 0,
    max_likes: int | float = 0,
    max_search_rank: int = 0,
) -> dict[str, Any]:
    """Return a transparent hot score based only on search-card fields.

    Public search cards expose follower count, total likes, search position and
    sometimes verification.  The default score is 45% follower scale, 35%
    total likes, and 20% search visibility/authentication.  Counts use
    logarithmic scaling so a single very large account does not erase every
    other signal.  ``recent_posts`` remains parseable for other workflows but
    is deliberately not used here.
    """

    normalized = normalize_account(account, source_rank=account.get("search_rank"))
    followers = parse_count(normalized.get("followers", normalized.get("follower_count", 0)))
    likes = parse_count(normalized.get("likes", normalized.get("total_favorited", 0)))
    rank = parse_count(normalized.get("search_rank", 0))
    follower_component = _log_component(followers, float(max_followers or followers))
    likes_component = _log_component(likes, float(max_likes or likes))
    if max_search_rank and rank:
        rank_component = max(0.0, min(100.0, 100.0 * (1 - (rank - 1) / max(1, max_search_rank - 1))))
    elif rank:
        rank_component = max(0.0, 100.0 - rank)
    else:
        rank_component = 0.0
    verified_component = 100.0 if bool(normalized.get("verified")) else 0.0
    visibility_component = rank_component * 0.7 + verified_component * 0.3
    hot_score = (
        follower_component * 0.45
        + likes_component * 0.35
        + visibility_component * 0.20
    )
    result = dict(normalized)
    result.update(
        {
            "followers": followers,
            "likes": likes,
            "hot_score": round(hot_score, 4),
            "score_breakdown": {
                "followers": round(follower_component, 4),
                "likes": round(likes_component, 4),
                "search_visibility": round(visibility_component, 4),
                "weights": {
                    "followers": 0.45,
                    "likes": 0.35,
                    "search_visibility": 0.20,
                },
            },
        }
    )
    return result


def _merge_duplicate(existing: dict[str, Any], candidate: Mapping[str, Any]) -> dict[str, Any]:
    """Merge duplicate search results without losing the richest metrics."""

    merged = dict(existing)
    for key in ("sec_uid", "uid", "nickname", "bio", "profile_url"):
        if not merged.get(key) and candidate.get(key):
            merged[key] = candidate[key]
    for key in ("followers", "likes", "post_count"):
        if parse_count(candidate.get(key)) > parse_count(merged.get(key)):
            merged[key] = parse_count(candidate.get(key))
    merged["verified"] = bool(merged.get("verified") or candidate.get("verified"))
    posts: list[dict[str, Any]] = []
    seen_posts: set[str] = set()
    for post in list(merged.get("recent_posts") or []) + list(candidate.get("recent_posts") or []):
        if not isinstance(post, Mapping):
            continue
        key = str(post.get("aweme_id") or post.get("desc") or len(posts))
        if key in seen_posts:
            continue
        seen_posts.add(key)
        posts.append(dict(post))
    merged["recent_posts"] = posts
    old_rank = parse_count(merged.get("search_rank"))
    new_rank = parse_count(candidate.get("search_rank"))
    if not old_rank or (new_rank and new_rank < old_rank):
        merged["search_rank"] = new_rank
    return merged


def deduplicate_accounts(accounts: Iterable[Mapping[str, Any]]) -> list[dict[str, Any]]:
    """Deduplicate by sec_uid, then uid/profile URL, preserving first order."""

    result: list[dict[str, Any]] = []
    positions: dict[str, int] = {}
    for index, raw in enumerate(accounts, 1):
        if not isinstance(raw, Mapping):
            continue
        candidate = normalize_account(raw, source_rank=raw.get("search_rank", index))
        key = account_key(candidate)
        if key in positions:
            at = positions[key]
            result[at] = _merge_duplicate(result[at], candidate)
        else:
            positions[key] = len(result)
            result.append(candidate)
    return result


def rank_accounts(
    accounts: Iterable[Mapping[str, Any]],
    *,
    sort_by: str = "hot",
    limit: int | None = None,
) -> list[dict[str, Any]]:
    """Deduplicate, score, and sort account candidates."""

    if sort_by not in {"hot", "followers", "likes", "search"}:
        raise ValueError("sort_by 必须是 hot、followers、likes 或 search")
    unique = deduplicate_accounts(accounts)
    max_followers = max((parse_count(item.get("followers")) for item in unique), default=0)
    max_likes = max((parse_count(item.get("likes")) for item in unique), default=0)
    max_rank = max((parse_count(item.get("search_rank")) for item in unique), default=0)
    scored = [
        score_account(
            item,
            max_followers=max_followers,
            max_likes=max_likes,
            max_search_rank=max_rank,
        )
        for item in unique
    ]
    if sort_by == "followers":
        key = lambda item: (parse_count(item.get("followers")), -parse_count(item.get("search_rank", 0)))
    elif sort_by == "likes":
        key = lambda item: (parse_count(item.get("likes")), -parse_count(item.get("search_rank", 0)))
    elif sort_by == "search":
        key = lambda item: (
            parse_count(item.get("search_rank", 0)) == 0,
            parse_count(item.get("search_rank", 0)) or 10**12,
            -float(item.get("hot_score", 0)),
        )
    else:
        key = lambda item: (float(item.get("hot_score", 0)), -parse_count(item.get("search_rank", 0)))
    scored.sort(key=key, reverse=sort_by != "search")
    if limit is not None:
        return scored[: max(0, int(limit))]
    return scored
