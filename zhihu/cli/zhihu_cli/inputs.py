"""Validation and batch input handling for explicit Zhihu references."""

from __future__ import annotations

import re
from pathlib import Path
from urllib.parse import urlparse

from .models import ZhihuReference


class InputError(ValueError):
    """Raised when a reference is not an explicit Zhihu answer/article."""


_ANSWER_PATH = re.compile(r"^/question/(?P<question>[0-9]+)/answer/(?P<answer>[0-9]+)/?$")
_ARTICLE_PATH = re.compile(r"^/p/(?P<article>[0-9]+)/?$")


def parse_reference(value: str) -> ZhihuReference:
    raw = str(value or "").strip()
    if not raw:
        raise InputError("知乎 URL 不能为空")
    parsed = urlparse(raw)
    if parsed.scheme not in {"http", "https"}:
        raise InputError("知乎截图只接受 http/https 详情 URL")
    hostname = (parsed.hostname or "").lower().rstrip(".")
    if hostname not in {"www.zhihu.com", "zhihu.com", "zhuanlan.zhihu.com"}:
        raise InputError("只接受 www.zhihu.com 或 zhuanlan.zhihu.com URL")
    path = parsed.path.rstrip("/") or "/"
    answer_match = _ANSWER_PATH.fullmatch(path)
    if answer_match and hostname in {"www.zhihu.com", "zhihu.com"}:
        question_id = answer_match.group("question")
        answer_id = answer_match.group("answer")
        canonical = f"https://www.zhihu.com/question/{question_id}/answer/{answer_id}"
        return ZhihuReference("answer", answer_id, canonical, raw, question_id)
    article_match = _ARTICLE_PATH.fullmatch(path)
    if article_match and hostname == "zhuanlan.zhihu.com":
        article_id = article_match.group("article")
        canonical = f"https://zhuanlan.zhihu.com/p/{article_id}"
        return ZhihuReference("article", article_id, canonical, raw)
    raise InputError("无法识别知乎回答 URL（/question/<id>/answer/<id>）或专栏文章 URL（/p/<id>）")


def read_inputs(reference: str | None = None, input_path: str | Path | None = None) -> list[ZhihuReference]:
    if bool(reference) == bool(input_path):
        raise InputError("请提供一个知乎详情 URL，或使用 --input 文本文件（二选一）")
    if reference:
        values = [str(reference).strip()]
    else:
        source = Path(input_path)  # type: ignore[arg-type]
        try:
            values = [
                line.strip()
                for line in source.read_text(encoding="utf-8-sig").splitlines()
                if line.strip() and not line.lstrip().startswith("#")
            ]
        except OSError as exc:
            raise InputError(f"无法读取 --input 文件：{source}") from exc
        if not values:
            raise InputError("--input 文件中没有可用知乎 URL")

    result: list[ZhihuReference] = []
    seen: set[str] = set()
    for value in values:
        parsed = parse_reference(value)
        if parsed.key in seen:
            continue
        seen.add(parsed.key)
        result.append(parsed)
    return result
