"""Typing-only protocols kept separate to avoid import cycles."""

from __future__ import annotations

from typing import Protocol


class FetchResponseProtocol(Protocol):
    text: str
    url: str
    status: int
