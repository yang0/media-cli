"""Threshold-driven date/hour window planning."""

from __future__ import annotations

from dataclasses import dataclass

from .models import SearchWindow
from .query import split_day_windows, split_hour_windows


@dataclass(frozen=True)
class WindowDecision:
    action: str
    windows: tuple[SearchWindow, ...] = ()
    partial: bool = False
    reason: str = ""


def decide_window(window: SearchWindow, page_count: int, *, threshold: int = 46) -> WindowDecision:
    """Decide whether a saturated window should be refined.

    A range is split by day, a day by hour, and an already-hourly window is
    marked partial.  This preserves the reference project's 46-page safety
    threshold while making the incomplete result explicit in the manifest.
    """

    if page_count < threshold:
        return WindowDecision("fetch", (window,))
    if window.granularity in {"range", "all"} and window.start and window.end:
        return WindowDecision("split-day", tuple(split_day_windows(window)), reason="page threshold reached")
    if window.granularity == "day" and window.start and window.end:
        return WindowDecision("split-hour", tuple(split_hour_windows(window)), reason="page threshold reached")
    return WindowDecision("partial", (window,), partial=True, reason="hour window remains saturated at threshold")
