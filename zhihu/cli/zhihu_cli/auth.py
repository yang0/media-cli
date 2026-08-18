"""Cookie resolution with strict value redaction."""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable


class AuthError(RuntimeError):
    """Raised when no usable Zhihu authentication source is available."""


@dataclass(frozen=True)
class AuthContext:
    cookie: str
    source: str

    def redacted(self) -> dict[str, str]:
        return {"source": self.source, "cookie": redact_cookie(self.cookie)}


def redact_cookie(value: str) -> str:
    names: list[str] = []
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
        return "; ".join(
            f"{item['name']}={item.get('value', '')}"
            for item in value
            if isinstance(item, dict) and item.get("name")
        )
    return ""


def parse_cookie_text(text: str) -> str:
    value = str(text or "").strip()
    if not value:
        return ""
    if value.startswith("{") or value.startswith("["):
        try:
            parsed = _cookie_from_json(json.loads(value))
            if parsed:
                return parsed
        except json.JSONDecodeError:
            pass
    if "\t" in value and any(line.count("\t") >= 6 for line in value.splitlines()):
        parts: list[str] = []
        for line in value.splitlines():
            stripped = line.lstrip()
            if not line.strip() or (stripped.startswith("#") and not stripped.startswith("#HttpOnly_")):
                continue
            fields = line.rstrip("\r\n").split("\t")
            if len(fields) >= 7 and fields[5].strip():
                parts.append(f"{fields[5].strip()}={fields[6].strip()}")
        return "; ".join(parts)
    return re.sub(r"^cookie\s*:\s*", "", value, flags=re.IGNORECASE).strip()


def load_cookie_file(path: str | Path) -> str:
    source = Path(path)
    try:
        cookie = parse_cookie_text(source.read_text(encoding="utf-8-sig"))
    except OSError as exc:
        raise AuthError(f"无法读取 Cookie 文件：{source}") from exc
    if not cookie:
        raise AuthError("Cookie 文件为空")
    return cookie


def extract_cdp_cookie(port: int = 9221) -> str:
    from .browser import cdp_cookie_header

    try:
        return cdp_cookie_header(port)
    except Exception as exc:
        raise AuthError(f"无法从 Chrome CDP 获取知乎 Cookie（端口 {int(port)}）") from exc


def resolve_auth(
    *,
    cookie_file: str | Path | None = None,
    env: dict[str, str] | None = None,
    cdp_port: int = 9221,
    cdp_loader: Callable[[int], str] | None = None,
    required: bool = True,
) -> AuthContext | None:
    """Resolve ``--cookie-file`` > ``ZHIHU_COOKIE`` > Chrome CDP."""

    environment = env if env is not None else os.environ
    if cookie_file:
        return AuthContext(load_cookie_file(cookie_file), "cookie-file")
    cookie = parse_cookie_text(environment.get("ZHIHU_COOKIE", ""))
    if cookie:
        return AuthContext(cookie, "environment")
    loader = cdp_loader or extract_cdp_cookie
    try:
        cookie = parse_cookie_text(loader(int(cdp_port)))
    except AuthError:
        if required:
            raise
        return None
    if cookie:
        return AuthContext(cookie, "cdp")
    if required:
        raise AuthError("未找到知乎 Cookie；请提供 --cookie-file、ZHIHU_COOKIE 或已登录 Chrome CDP")
    return None


def auth_summary(context: AuthContext) -> str:
    count = sum(bool(piece.strip().split("=", 1)[0].strip()) for piece in context.cookie.split(";"))
    return f"认证可用：source={context.source} cookie_count={count}"
