"""Semantic 9:16 PNG slicing for captured Zhihu cards."""

from __future__ import annotations

import hashlib
import io
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

from PIL import Image


@dataclass(frozen=True)
class CropSlice:
    index: int
    total: int
    top: int
    bottom: int
    overlap: int
    mode: str

    @property
    def height(self) -> int:
        return self.bottom - self.top


def max_height_for_ratio(width: int, *, ratio_width: int = 9, ratio_height: int = 16) -> int:
    if width <= 0:
        raise ValueError("图片宽度必须为正数")
    return max(1, math.floor(width * ratio_height / ratio_width))


def _boundary_value(boundary: Any) -> int | None:
    if isinstance(boundary, (int, float)):
        return int(boundary)
    if isinstance(boundary, dict):
        for key in ("y", "bottom", "end"):
            if key in boundary:
                try:
                    return int(float(boundary[key]))
                except (TypeError, ValueError):
                    return None
    return None


def plan_slices(width: int, height: int, boundaries: Iterable[Any] = (), *, overlap: int = 64) -> list[CropSlice]:
    """Plan monotonic crops at or below the 9:16 height limit."""

    if width <= 0 or height <= 0:
        raise ValueError("图片尺寸必须为正数")
    if overlap < 0:
        raise ValueError("重叠像素不能为负数")
    maximum = max_height_for_ratio(width)
    points = sorted({max(1, min(height - 1, value)) for value in (_boundary_value(item) for item in boundaries) if value is not None})
    if height <= maximum:
        return [CropSlice(1, 1, 0, height, 0, "single")]

    slices: list[tuple[int, int, int, str]] = []
    current = 0
    while current < height:
        limit = min(height, current + maximum)
        if limit == height:
            end = height
            next_current = height
            used_overlap = 0
            mode = "final"
        else:
            # Prefer the latest safe semantic boundary in the latter half of
            # the band. Very early cuts create unreadable tiny fragments.
            candidates = [
                point for point in points
                if current + maximum // 2 <= point <= limit and point > current
            ]
            if candidates:
                end = max(candidates)
                next_current = end
                used_overlap = 0
                mode = "semantic-boundary"
            else:
                end = limit
                used_overlap = min(overlap, max(0, end - current - 1))
                next_current = max(current + 1, end - used_overlap)
                mode = "hard-cut"
        if end <= current:
            raise ValueError("无法生成单调递增的截图分片")
        slices.append((current, end, used_overlap, mode))
        current = next_current
    total = len(slices)
    return [CropSlice(i, total, top, bottom, used_overlap, mode) for i, (top, bottom, used_overlap, mode) in enumerate(slices, 1)]


def split_image_bytes(
    image_bytes: bytes,
    boundaries: Iterable[Any] = (),
    *,
    overlap: int = 64,
    output_dir: str | Path | None = None,
    zhihu_id: str = "zhihu",
) -> list[dict[str, Any]]:
    """Split a PNG/JPEG and optionally write numbered PNG pieces."""

    if not image_bytes:
        raise ValueError("截图数据为空")
    try:
        image = Image.open(io.BytesIO(image_bytes))
        image.load()
    except Exception as exc:
        raise ValueError("截图不是有效图片") from exc
    pieces = plan_slices(image.width, image.height, boundaries, overlap=overlap)
    output = Path(output_dir) if output_dir else None
    if output:
        output.mkdir(parents=True, exist_ok=True)
    result: list[dict[str, Any]] = []
    for piece in pieces:
        cropped = image.crop((0, piece.top, image.width, piece.bottom))
        stream = io.BytesIO()
        cropped.save(stream, format="PNG")
        data = stream.getvalue()
        filename = f"zhihu-{zhihu_id}-{piece.index:02d}-of-{piece.total:02d}.png"
        path = output / filename if output else None
        if path:
            path.write_bytes(data)
        result.append(
            {
                "filename": filename,
                "path": str(path) if path else None,
                "width": cropped.width,
                "height": cropped.height,
                "coordinates": {"x": 0, "y": piece.top, "width": cropped.width, "height": cropped.height},
                "overlap": piece.overlap,
                "mode": piece.mode,
                "sha256": hashlib.sha256(data).hexdigest(),
                "data": data if output is None else None,
            }
        )
    return result
