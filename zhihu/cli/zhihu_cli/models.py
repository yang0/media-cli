"""Small data models shared by input parsing and capture output."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal


ZhihuType = Literal["answer", "article"]


@dataclass(frozen=True)
class ZhihuReference:
    """A validated, explicit Zhihu answer or column article reference."""

    type: ZhihuType
    id: str
    url: str
    input: str
    question_id: str | None = None

    @property
    def key(self) -> str:
        return f"{self.type}:{self.id}"
