# -*- coding: utf-8 -*-
"""
Process-safe daily credit tracking for Dola WebView profiles.

Rules (product):
  - Each account has 4 credits per calendar day (local timezone)
  - 5s video  = 1 credit
  - 10s video = 2 credits
  - 15s video = 3 credits
"""
from __future__ import annotations

import json
import os
import time
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from typing import Any, Iterator

ROOT = Path(__file__).resolve().parent
DEFAULT_STATE = ROOT / "daily_profile_usage.json"
DEFAULT_LOCK = ROOT / "daily_profile_usage.lock"

DAILY_CREDIT_LIMIT = 4
DURATION_COST = {5: 1, 10: 2, 15: 3}


@contextmanager
def _state_lock(lock_path: Path = DEFAULT_LOCK, timeout: float = 5.0) -> Iterator[None]:
    """Lock one byte so separate WebView processes cannot race the same JSON file."""
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


def _now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def credit_cost_for_duration(duration: int | float | str | None) -> int:
    try:
        d = int(duration or 0)
    except (TypeError, ValueError):
        d = 0
    if d in DURATION_COST:
        return DURATION_COST[d]
    # nearest known tier
    if d >= 15:
        return DURATION_COST[15]
    if d >= 10:
        return DURATION_COST[10]
    if d >= 5:
        return DURATION_COST[5]
    return 0


def _empty_state() -> dict:
    return {"date": _today(), "accounts": {}, "used": {}}


def _normalize_account(rec: Any) -> dict:
    """Normalize one account record (supports legacy used-mark format)."""
    if not isinstance(rec, dict):
        return {"spent": 0, "events": [], "openedAt": None, "pid": None, "reason": None}
    spent = rec.get("spent")
    try:
        spent_i = max(0, int(spent if spent is not None else 0))
    except (TypeError, ValueError):
        spent_i = 0
    events = rec.get("events")
    if not isinstance(events, list):
        events = []
    # Legacy: mere presence in `used` with openedAt and no spent → treat as opened only
    return {
        "spent": spent_i,
        "events": events,
        "openedAt": rec.get("openedAt"),
        "pid": rec.get("pid"),
        "reason": rec.get("reason"),
    }


def _read_state(path: Path) -> dict:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        return _empty_state()
    if not isinstance(data, dict) or data.get("date") != _today():
        return _empty_state()

    accounts = data.get("accounts")
    if not isinstance(accounts, dict):
        accounts = {}

    # Migrate legacy `used` map into accounts (opened-only, 0 spent)
    used = data.get("used")
    if isinstance(used, dict):
        for name, rec in used.items():
            if name not in accounts:
                if isinstance(rec, dict):
                    accounts[name] = {
                        "spent": int(rec.get("spent") or 0),
                        "events": rec.get("events") if isinstance(rec.get("events"), list) else [],
                        "openedAt": rec.get("openedAt"),
                        "pid": rec.get("pid"),
                        "reason": rec.get("reason") or "opened",
                    }
                else:
                    accounts[name] = {"spent": 0, "events": [], "openedAt": None, "pid": None, "reason": "opened"}

    data["accounts"] = {str(k): _normalize_account(v) for k, v in accounts.items()}
    data["used"] = data.get("used") if isinstance(data.get("used"), dict) else {}
    return data


def _write_state(path: Path, state: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    out = {
        "date": state.get("date") or _today(),
        "accounts": state.get("accounts") or {},
        # keep legacy key for older readers (opened markers only)
        "used": {
            k: {
                "openedAt": v.get("openedAt"),
                "pid": v.get("pid"),
                "reason": v.get("reason"),
                "spent": v.get("spent", 0),
            }
            for k, v in (state.get("accounts") or {}).items()
        },
    }
    temp = path.with_suffix(path.suffix + f".{os.getpid()}.tmp")
    temp.write_text(json.dumps(out, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(temp, path)


def _balance_from_rec(account_id: str, rec: dict) -> dict:
    spent = int(rec.get("spent") or 0)
    remaining = max(0, DAILY_CREDIT_LIMIT - spent)
    return {
        "account": account_id,
        "date": _today(),
        "limit": DAILY_CREDIT_LIMIT,
        "spent": spent,
        "remaining": remaining,
        "canUse": remaining > 0,
        "openedAt": rec.get("openedAt"),
        "events": list(rec.get("events") or []),
    }


def get_balance(
    account_id: str,
    *,
    state_path: Path = DEFAULT_STATE,
    lock_path: Path = DEFAULT_LOCK,
) -> dict:
    account_id = str(account_id or "").strip()
    if not account_id:
        raise ValueError("account_id is required")
    with _state_lock(lock_path):
        state = _read_state(state_path)
        rec = state["accounts"].get(account_id) or _normalize_account({})
        return _balance_from_rec(account_id, rec)


def list_balances(
    account_ids: list[str] | None = None,
    *,
    state_path: Path = DEFAULT_STATE,
    lock_path: Path = DEFAULT_LOCK,
) -> list[dict]:
    with _state_lock(lock_path):
        state = _read_state(state_path)
        names = account_ids
        if names is None:
            names = sorted(state["accounts"].keys())
        out = []
        for name in names:
            name = str(name or "").strip()
            if not name:
                continue
            rec = state["accounts"].get(name) or _normalize_account({})
            out.append(_balance_from_rec(name, rec))
        return out


def mark_profile_used(
    account_id: str,
    *,
    reason: str = "opened",
    state_path: Path = DEFAULT_STATE,
    lock_path: Path = DEFAULT_LOCK,
) -> dict:
    """Record that a profile window was opened (does not spend credits)."""
    account_id = str(account_id or "").strip()
    if not account_id:
        raise ValueError("account_id is required")
    with _state_lock(lock_path):
        state = _read_state(state_path)
        rec = state["accounts"].get(account_id) or _normalize_account({})
        rec["openedAt"] = _now_iso()
        rec["pid"] = os.getpid()
        rec["reason"] = reason
        state["accounts"][account_id] = rec
        _write_state(state_path, state)
        return _balance_from_rec(account_id, rec)


def spend_credits(
    account_id: str,
    cost: int,
    *,
    duration: int | None = None,
    reason: str = "video",
    state_path: Path = DEFAULT_STATE,
    lock_path: Path = DEFAULT_LOCK,
    allow_overdraft: bool = False,
) -> dict:
    """
    Spend daily credits. Raises ValueError if insufficient (unless allow_overdraft).
    Returns balance dict after spend, with extra keys: cost, ok.
    """
    account_id = str(account_id or "").strip()
    if not account_id:
        raise ValueError("account_id is required")
    cost_i = int(cost)
    if cost_i <= 0:
        bal = get_balance(account_id, state_path=state_path, lock_path=lock_path)
        bal.update({"ok": True, "cost": 0, "duration": duration, "reason": reason})
        return bal

    with _state_lock(lock_path):
        state = _read_state(state_path)
        rec = state["accounts"].get(account_id) or _normalize_account({})
        spent = int(rec.get("spent") or 0)
        remaining = DAILY_CREDIT_LIMIT - spent
        if remaining < cost_i and not allow_overdraft:
            raise ValueError(
                f"积分不足: {account_id} remaining={max(0, remaining)} need={cost_i} "
                f"(今日上限 {DAILY_CREDIT_LIMIT}，5s=1 / 10s=2 / 15s=3)"
            )
        rec["spent"] = spent + cost_i
        events = list(rec.get("events") or [])
        events.append(
            {
                "at": _now_iso(),
                "cost": cost_i,
                "duration": duration,
                "reason": reason,
                "pid": os.getpid(),
            }
        )
        rec["events"] = events[-50:]  # keep last 50
        state["accounts"][account_id] = rec
        _write_state(state_path, state)
        bal = _balance_from_rec(account_id, rec)
        bal.update({"ok": True, "cost": cost_i, "duration": duration, "reason": reason})
        return bal


def spend_for_duration(
    account_id: str,
    duration: int,
    *,
    reason: str = "video",
    state_path: Path = DEFAULT_STATE,
    lock_path: Path = DEFAULT_LOCK,
    allow_overdraft: bool = False,
) -> dict:
    cost = credit_cost_for_duration(duration)
    return spend_credits(
        account_id,
        cost,
        duration=int(duration),
        reason=reason,
        state_path=state_path,
        lock_path=lock_path,
        allow_overdraft=allow_overdraft,
    )


def can_afford(
    account_id: str,
    duration: int,
    *,
    state_path: Path = DEFAULT_STATE,
    lock_path: Path = DEFAULT_LOCK,
) -> dict:
    bal = get_balance(account_id, state_path=state_path, lock_path=lock_path)
    cost = credit_cost_for_duration(duration)
    bal["cost"] = cost
    bal["affordable"] = bal["remaining"] >= cost
    return bal


def reserve_unused_profile(
    candidates: list[str],
    *,
    exclude: set[str] | None = None,
    reason: str = "new-tab",
    min_remaining: int = 1,
    state_path: Path = DEFAULT_STATE,
    lock_path: Path = DEFAULT_LOCK,
) -> str | None:
    """Pick first candidate with remaining credits >= min_remaining and mark opened."""
    excluded = {str(item) for item in (exclude or set())}
    ordered = sorted({str(item).strip() for item in candidates if str(item).strip()})
    with _state_lock(lock_path):
        state = _read_state(state_path)
        selected = None
        for account in ordered:
            if account in excluded:
                continue
            rec = state["accounts"].get(account) or _normalize_account({})
            remaining = DAILY_CREDIT_LIMIT - int(rec.get("spent") or 0)
            if remaining >= min_remaining:
                selected = account
                rec["openedAt"] = _now_iso()
                rec["pid"] = os.getpid()
                rec["reason"] = reason
                state["accounts"][account] = rec
                break
        if not selected:
            return None
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


def format_balance_line(bal: dict) -> str:
    return (
        f"{bal.get('account')}\t"
        f"remaining={bal.get('remaining')}/{bal.get('limit')}\t"
        f"spent={bal.get('spent')}"
    )
