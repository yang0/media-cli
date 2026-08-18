"""Query validation and URL construction.

The mapping values come from the authorised reference project's
``convert_weibo_type`` and ``convert_contain_type`` helpers.
"""

from __future__ import annotations

from dataclasses import replace
from datetime import date, datetime, timedelta
from urllib.parse import quote, urlencode

from .models import SearchOptions, SearchWindow


WEIBO_TYPE_PARAMS = {
    "all": "&typeall=1",
    "original": "&scope=ori",
    "hot": "&xsort=hot",
    "following": "&atten=1",
    "verified": "&vip=1",
    "media": "&category=4",
    "opinion": "&viewpoint=1",
}
CONTAIN_PARAMS = {
    "any": "&suball=1",
    "image": "&haspic=1",
    "video": "&hasvideo=1",
    "music": "&hasmusic=1",
    "link": "&haslink=1",
}

# Province/city codes used by the reference search site.  The province-level
# map is sufficient for the public CLI and avoids carrying a 700-line legacy
# region table into the new package.
REGION_CODES = {
    "北京": 11,
    "天津": 12,
    "河北": 13,
    "山西": 14,
    "内蒙古": 15,
    "辽宁": 21,
    "吉林": 22,
    "黑龙江": 23,
    "上海": 31,
    "江苏": 32,
    "浙江": 33,
    "安徽": 34,
    "福建": 35,
    "江西": 36,
    "山东": 37,
    "河南": 41,
    "湖北": 42,
    "湖南": 43,
    "广东": 44,
    "广西": 45,
    "海南": 46,
    "重庆": 50,
    "四川": 51,
    "贵州": 52,
    "云南": 53,
    "西藏": 54,
    "陕西": 61,
    "甘肃": 62,
    "青海": 63,
    "宁夏": 64,
    "新疆": 65,
    "台湾": 71,
    "香港": 81,
    "澳门": 82,
    "其他": 100,
    "海外": 400,
}


class QueryValidationError(ValueError):
    """Raised for invalid or ambiguous search options."""


def validate_options(options: SearchOptions) -> SearchOptions:
    query = str(options.query or "").strip()
    if not query:
        raise QueryValidationError("搜索关键词不能为空")
    if options.limit < 0:
        raise QueryValidationError("--limit 必须是大于等于 0 的整数")
    if options.threshold < 1:
        raise QueryValidationError("--threshold 必须是正整数")
    if options.delay < 0:
        raise QueryValidationError("--delay 不能为负数")
    if options.weibo_type not in WEIBO_TYPE_PARAMS:
        raise QueryValidationError(f"不支持的微博类型: {options.weibo_type}")
    if options.contains not in CONTAIN_PARAMS:
        raise QueryValidationError(f"不支持的内容筛选: {options.contains}")
    if options.output_format not in {"jsonl", "csv", "both"}:
        raise QueryValidationError("--format 只能是 jsonl、csv 或 both")
    if (options.start is None) != (options.end is None):
        raise QueryValidationError("--start 和 --end 必须同时提供")
    if options.start and options.end:
        start = parse_date(options.start)
        end = parse_date(options.end)
        if start > end:
            raise QueryValidationError("--start 必须早于或等于 --end")
    if options.region and options.region not in {"全部", "all", *REGION_CODES}:
        raise QueryValidationError(f"不支持的地区: {options.region}")
    return replace(options, query=query)


def parse_date(value: str) -> date:
    try:
        return datetime.strptime(str(value), "%Y-%m-%d").date()
    except ValueError as exc:
        raise QueryValidationError(f"日期必须是 YYYY-MM-DD: {value}") from exc


def encode_query(query: str) -> str:
    """Encode one combination query while preserving no user cookie data."""

    text = str(query).strip()
    if len(text) > 2 and text.startswith("#") and text.endswith("#"):
        text = f"%23{text[1:-1]}%23"
        return text
    return quote(text, safe="%")


def _scope_value(moment: datetime) -> str:
    # The reference project uses an unpadded hour in ``timescope`` values.
    return f"{moment:%Y-%m-%d}-{moment.hour}"


def build_search_url(query: str, *, options: SearchOptions, window: SearchWindow | None = None, page: int = 1) -> str:
    """Build the s.weibo.com URL for a single planned request."""

    options = validate_options(options)
    params = [WEIBO_TYPE_PARAMS[options.weibo_type], CONTAIN_PARAMS[options.contains]]
    region = window.region if window and window.region else options.region
    base = "https://s.weibo.com/weibo?q=" + encode_query(query)
    if region and region not in {"全部", "all"}:
        params.append(f"&region=custom:{REGION_CODES[region]}:1000")
    if window and window.start and window.end:
        params.append(f"&timescope=custom:{_scope_value(window.start)}:{_scope_value(window.end)}")
    if page > 1:
        params.append(f"&page={int(page)}")
    return base + "".join(params)


def initial_windows(options: SearchOptions) -> list[SearchWindow]:
    options = validate_options(options)
    if not options.start:
        return [SearchWindow(None, None, "all", None)]
    start = datetime.combine(parse_date(options.start), datetime.min.time())
    end_date = parse_date(options.end) + timedelta(days=1)
    end = datetime.combine(end_date, datetime.min.time())
    return [SearchWindow(start, end, "range", None)]


def split_day_windows(window: SearchWindow) -> list[SearchWindow]:
    if not window.start or not window.end:
        return [window]
    current = window.start.replace(hour=0, minute=0, second=0, microsecond=0)
    stop = window.end
    result: list[SearchWindow] = []
    while current < stop:
        next_day = current + timedelta(days=1)
        result.append(SearchWindow(current, min(next_day, stop), "day", window.region))
        current = next_day
    return result

def split_hour_windows(window: SearchWindow) -> list[SearchWindow]:
    if not window.start or not window.end:
        return [window]
    current = window.start.replace(minute=0, second=0, microsecond=0)
    result: list[SearchWindow] = []
    while current < window.end:
        next_hour = current + timedelta(hours=1)
        result.append(SearchWindow(current, min(next_hour, window.end), "hour", window.region))
        current = next_hour
    return result
