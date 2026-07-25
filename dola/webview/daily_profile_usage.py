# -*- coding: utf-8 -*-
"""Process-safe daily account usage tracking for isolated WebView profiles."""
from __future__ import annotations

import json
import os
import time
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from typing import Iterator

ROOT = Path(__file__).resolve().parent
DEFAULT_STATE = ROOT / "daily_profile_usage.json"
DEFAULT_LOCK = ROOT / "daily_profile_usage.lock"


@contextmanager
def _state_lock(lock_path: Path = DEFAULT_LOCK, timeout: float = 5.0) -> Iterator[None]:
    """Lock one byte so separate WebView processes cannot reserve one account twice."""
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    handle = lock_path.open("a+b")
    try:
        handle.seek(0, os.SEEK_END)
        if handle.tell() == 0:
            handle.write(b"0")
            handle.flush()
        handle.seek(0)

        if os.name == "nt":
            import msvcrt

            deadline = time.monotonic() + timeout
            while True:
                try:
                    msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                    break
                except OSError:
                    if time.monotonic() >= deadline:
                        raise TimeoutError(f"daily usage lock timeout: {lock_path}")
                    time.sleep(0.05)
        yield
    finally:
        if os.name == "nt":
            try:
                import msvcrt

                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            except OSError:
                pass
        handle.close()


def _today() -> str:
    return datetime.now().astimezone().date().isoformat()


def _empty_state() -> dict:
    return {"date": _today(), "used": {}}


def _read_state(path: Path) -> dict:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        return _empty_state()
    if not isinstance(data, dict) or data.get("date") != _today():
        return _empty_state()
    used = data.get("used")
    if not isinstance(used, dict):
        data["used"] = {}
    return data


def _write_state(path: Path, state: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + f".{os.getpid()}.tmp")
    temp.write_text(json.dumps(state, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(temp, path)


def mark_profile_used(
    account_id: str,
    *,
    reason: str = "opened",
    state_path: Path = DEFAULT_STATE,
    lock_path: Path = DEFAULT_LOCK,
) -> dict:
    account_id = str(account_id or "").strip()
    if not account_id:
        raise ValueError("account_id is required")
    with _state_lock(lock_path):
        state = _read_state(state_path)
        record = {
            "openedAt": datetime.now().astimezone().isoformat(timespec="seconds"),
            "pid": os.getpid(),
            "reason": reason,
        }
        state["used"][account_id] = record
        _write_state(state_path, state)
        return record


def reserve_unused_profile(
    candidates: list[str],
    *,
    exclude: set[str] | None = None,
    reason: str = "new-tab",
    state_path: Path = DEFAULT_STATE,
    lock_path: Path = DEFAULT_LOCK,
) -> str | None:
    """Pick and immediately reserve the first candidate not used today."""
    excluded = {str(item) for item in (exclude or set())}
    ordered = sorted({str(item).strip() for item in candidates if str(item).strip()})
    with _state_lock(lock_path):
        state = _read_state(state_path)
        used = state["used"]
        selected = next(
            (account for account in ordered if account not in excluded and account not in used),
            None,
        )
        if not selected:
            return None
        used[selected] = {
            "openedAt": datetime.now().astimezone().isoformat(timespec="seconds"),
            "pid": os.getpid(),
            "reason": reason,
        }
        _write_state(state_path, state)
        return selected


def usage_snapshot(
    *,
    state_path: Path = DEFAULT_STATE,
    lock_path: Path = DEFAULT_LOCK,
) -> dict:
    with _state_lock(lock_path):
        state = _read_state(state_path)
        return json.loads(json.dumps(state))
