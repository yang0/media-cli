"""Authentication source resolution with strict cookie redaction."""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable


class AuthError(RuntimeError):
    """Raised when no usable Weibo authentication source is available."""


@dataclass(frozen=True)
class AuthContext:
    cookie: str
    source: str

    @property
    def headers(self) -> dict[str, str]:
        return {
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8,en-US;q=0.7",
            "User-Agent": "weibo-cli/0.1 (+authorized automation)",
            "Cookie": self.cookie,
        }

    def redacted(self) -> dict[str, str]:
        return {"source": self.source, "cookie": redact_cookie(self.cookie)}


def redact_cookie(value: str) -> str:
    """Return a shape-only cookie description; never expose values."""

    names = []
    for piece in str(value or "").split(";"):
        name = piece.strip().split("=", 1)[0].strip()
        if name:
            names.append(name)
    return "<cookie:" + ",".join(names) + ">" if names else "<missing-cookie>"


def _cookie_from_json(value: Any) -> str:
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, dict):
        value = value.get("cookies", value.get("cookie", value))
    if isinstance(value, list):
        pieces = []
        for item in value:
            if isinstance(item, dict) and item.get("name"):
                pieces.append(f"{item['name']}={item.get('value', '')}")
        return "; ".join(pieces)
    return ""


def parse_cookie_text(text: str) -> str:
    """Accept raw Cookie headers, Netscape files, or simple JSON exports."""

    text = str(text or "").strip()
    if not text:
        return ""
    if text.startswith("{") or text.startswith("["):
        try:
            parsed = _cookie_from_json(json.loads(text))
            if parsed:
                return parsed
        except json.JSONDecodeError:
            pass
    if "\t" in text and any(line.count("\t") >= 6 for line in text.splitlines()):
        pieces = []
        for line in text.splitlines():
            if not line.strip() or line.lstrip().startswith("#"):
                continue
            fields = line.rstrip("\r\n").split("\t")
            if len(fields) >= 7 and fields[5].strip():
                pieces.append(f"{fields[5].strip()}={fields[6].strip()}")
        return "; ".join(pieces)
    # Browser exports sometimes prefix the header with ``Cookie:``.
    return re.sub(r"^cookie\s*:\s*", "", text, flags=re.IGNORECASE).strip()


def load_cookie_file(path: str | Path) -> str:
    source = Path(path)
    try:
        return parse_cookie_text(source.read_text(encoding="utf-8-sig"))
    except OSError as exc:
        raise AuthError(f"无法读取 Cookie 文件: {source}") from exc


def extract_cdp_cookie(port: int = 9221) -> str:
    """Extract cookies from an already running Chrome CDP page.

    The websocket dependency is optional at import time.  We only ask Chrome
    for cookies and return the resulting header to the caller; no cookie value
    is included in exceptions or logs.
    """

    try:
        from .browser import cdp_cookie_header

        return cdp_cookie_header(port)
    except Exception as exc:
        raise AuthError(f"无法从 Chrome CDP 获取微博 Cookie（端口 {int(port)}）") from exc


def resolve_auth(
    *,
    cookie_file: str | Path | None = None,
    env: dict[str, str] | None = None,
    cdp_port: int = 9221,
    cdp_loader: Callable[[int], str] | None = None,
) -> AuthContext:
    """Resolve credentials in the documented priority order."""

    environment = env if env is not None else os.environ
    if cookie_file:
        cookie = load_cookie_file(cookie_file)
        if cookie:
            return AuthContext(cookie, "cookie-file")
        raise AuthError("Cookie 文件为空")
    cookie = parse_cookie_text(environment.get("WEIBO_COOKIE", ""))
    if cookie:
        return AuthContext(cookie, "environment")
    loader = cdp_loader or extract_cdp_cookie
    cookie = parse_cookie_text(loader(int(cdp_port)))
    if cookie:
        return AuthContext(cookie, "cdp")
    raise AuthError("未找到微博 Cookie；请提供 --cookie-file、WEIBO_COOKIE 或已登录 Chrome CDP")


def auth_summary(context: AuthContext) -> str:
    """Human-readable, value-free authentication status."""

    return f"认证可用：source={context.source} {redact_cookie(context.cookie)}"
