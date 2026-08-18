"""Shared data contracts for the Weibo CLI.

The data shape intentionally mirrors the fields exposed by the authorised
``dataabc/weibo-search`` project while keeping list fields as real JSON lists.
This makes JSONL useful for downstream processing and lets the CSV writer
perform the only required flattening at the boundary.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any


WEIBO_FIELDS = (
    "id",
    "bid",
    "url",
    "query",
    "user_id",
    "screen_name",
    "text",
    "article_url",
    "pics",
    "video_urls",
    "location",
    "created_at",
    "reposts_count",
    "comments_count",
    "attitudes_count",
    "source",
    "topics",
    "at_users",
    "retweet_id",
    "ip",
    "user_authentication",
    "vip_type",
    "vip_level",
    "captured_at",
)


@dataclass(frozen=True)
class SearchOptions:
    """Validated options for one combination query."""

    query: str
    limit: int = 10
    start: str | None = None
    end: str | None = None
    weibo_type: str = "all"
    contains: str = "any"
    region: str | None = None
    threshold: int = 46
    delay: float = 10.0
    output_dir: str | None = None
    output_format: str = "both"
    resume_dir: str | None = None
    cdp_port: int = 9221
    cookie_file: str | None = None


@dataclass(frozen=True)
class SearchWindow:
    """An inclusive/exclusive search time window."""

    start: datetime | None
    end: datetime | None
    granularity: str = "all"
    region: str | None = None

    @property
    def key(self) -> str:
        left = self.start.isoformat(timespec="hours") if self.start else "all"
        right = self.end.isoformat(timespec="hours") if self.end else "all"
        return f"{self.granularity}:{left}:{right}:{self.region or ''}"


@dataclass
class SearchResult:
    """A normalised result with the reference project's public fields."""

    values: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        for name in WEIBO_FIELDS:
            if name not in self.values:
                self.values[name] = [] if name in {"pics", "video_urls", "topics", "at_users"} else ""

    @property
    def id(self) -> str:
        return str(self.values.get("id") or "")

    def as_dict(self) -> dict[str, Any]:
        return {name: self.values.get(name, "") for name in WEIBO_FIELDS}
