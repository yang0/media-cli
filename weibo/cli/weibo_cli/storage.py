"""Resumable run storage and JSONL/CSV output."""

from __future__ import annotations

import csv
import hashlib
import json
import re
import sqlite3
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable

from .models import SearchOptions, SearchResult, SearchWindow, WEIBO_FIELDS


def safe_slug(value: str, *, limit: int = 80) -> str:
    text = re.sub(r"[^\w\-\u4e00-\u9fff]+", "-", str(value or "").strip(), flags=re.UNICODE).strip("-")
    return (text or "query")[:limit]


def timestamp_folder() -> str:
    return datetime.now().astimezone().strftime("%Y%m%d-%H%M%S")


def default_search_dir(query: str, *, root: str | Path = "downloads") -> Path:
    base = Path(root) / "weibo" / "search" / f"{timestamp_folder()}-{safe_slug(query)}"
    candidate = base
    index = 1
    while candidate.exists():
        candidate = Path(f"{base}-{index}")
        index += 1
    return candidate


def flatten_csv(value: Any) -> str:
    if isinstance(value, (list, tuple, set)):
        return ";".join(str(item) for item in value)
    if value is None:
        return ""
    return str(value)


class RunStore:
    """Persist a search run without turning SQLite into a user data export."""

    def __init__(self, output_dir: str | Path, *, output_format: str = "both", resume: bool = False):
        self.output_dir = Path(output_dir)
        self.output_dir.mkdir(parents=True, exist_ok=True)
        self.output_format = output_format
        self.resume = resume
        self.db = sqlite3.connect(self.output_dir / "state.sqlite3")
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.executescript(
            """
            CREATE TABLE IF NOT EXISTS seen_ids (
                id TEXT PRIMARY KEY,
                saved_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS windows (
                window_key TEXT PRIMARY KEY,
                status TEXT NOT NULL,
                page_count INTEGER NOT NULL DEFAULT 0,
                updated_at TEXT NOT NULL,
                detail TEXT NOT NULL DEFAULT '',
                start TEXT,
                end TEXT,
                granularity TEXT,
                region TEXT
            );
            """
        )
        # State files created by early development builds may not have the
        # window specification columns.  Migrate those small local files in
        # place without touching any user result files.
        existing_columns = {row[1] for row in self.db.execute("PRAGMA table_info(windows)").fetchall()}
        for name in ("start", "end", "granularity", "region"):
            if name not in existing_columns:
                self.db.execute(f"ALTER TABLE windows ADD COLUMN {name} TEXT")
        self.db.commit()
        self.jsonl_path = self.output_dir / "results.jsonl"
        self.csv_path = self.output_dir / "results.csv"
        self.checkpoint_path = self.output_dir / "checkpoint.json"
        self.manifest_path = self.output_dir / "manifest.json"
        self._csv_handle = None
        self._csv_writer = None
        if output_format in {"csv", "both"}:
            csv_exists = self.csv_path.exists() and self.csv_path.stat().st_size > 0
            self._csv_handle = self.csv_path.open("a", encoding="utf-8-sig", newline="")
            self._csv_writer = csv.DictWriter(self._csv_handle, fieldnames=list(WEIBO_FIELDS))
            if not csv_exists:
                self._csv_writer.writeheader()

    def close(self) -> None:
        if self._csv_handle:
            self._csv_handle.flush()
            self._csv_handle.close()
            self._csv_handle = None
        self.db.commit()
        self.db.close()

    def __enter__(self) -> "RunStore":
        return self

    def __exit__(self, exc_type: Any, exc: Any, traceback: Any) -> None:
        self.close()

    def seen(self, record_id: str) -> bool:
        row = self.db.execute("SELECT 1 FROM seen_ids WHERE id=?", (str(record_id),)).fetchone()
        return row is not None

    def count_seen(self) -> int:
        row = self.db.execute("SELECT COUNT(*) FROM seen_ids").fetchone()
        return int(row[0] if row else 0)

    def add(self, record: dict[str, Any] | SearchResult) -> bool:
        values = record.as_dict() if isinstance(record, SearchResult) else dict(record)
        result = SearchResult(values).as_dict()
        record_id = str(result.get("id") or result.get("bid") or "")
        if not record_id:
            record_id = hashlib.sha256(json.dumps(result, ensure_ascii=False, sort_keys=True).encode("utf-8")).hexdigest()
        if self.seen(record_id):
            return False
        self.db.execute("INSERT INTO seen_ids(id,saved_at) VALUES (?,?)", (record_id, datetime.now().astimezone().isoformat(timespec="seconds")))
        self.db.commit()
        if self.output_format in {"jsonl", "both"}:
            with self.jsonl_path.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(result, ensure_ascii=False, separators=(",", ":")) + "\n")
        if self._csv_writer:
            self._csv_writer.writerow({field: flatten_csv(result.get(field)) for field in WEIBO_FIELDS})
            self._csv_handle.flush()
        return True

    def window_status(self, key: str) -> str | None:
        row = self.db.execute("SELECT status FROM windows WHERE window_key=?", (key,)).fetchone()
        return str(row[0]) if row else None

    def save_window(self, key: str, status: str, *, page_count: int = 0, detail: str = "", window: SearchWindow | None = None, children: Iterable[SearchWindow] = ()) -> None:
        children = list(children)
        if children:
            detail = json.dumps({"reason": detail, "children": [self._window_dict(item) for item in children]}, ensure_ascii=False, separators=(",", ":"))
        self.db.execute(
            "INSERT INTO windows(window_key,status,page_count,updated_at,detail,start,end,granularity,region) VALUES(?,?,?,?,?,?,?,?,?) "
            "ON CONFLICT(window_key) DO UPDATE SET status=excluded.status,page_count=excluded.page_count,updated_at=excluded.updated_at,detail=excluded.detail,start=excluded.start,end=excluded.end,granularity=excluded.granularity,region=excluded.region",
            (key, status, int(page_count), datetime.now().astimezone().isoformat(timespec="seconds"), str(detail), self._window_value(window.start if window else None), self._window_value(window.end if window else None), window.granularity if window else None, window.region if window else None),
        )
        self.db.commit()

    @staticmethod
    def _window_value(value: Any) -> str | None:
        return value.isoformat() if value else None

    @staticmethod
    def _window_dict(window: SearchWindow) -> dict[str, Any]:
        return {"start": RunStore._window_value(window.start), "end": RunStore._window_value(window.end), "granularity": window.granularity, "region": window.region}

    @staticmethod
    def _window_from_dict(value: dict[str, Any]) -> SearchWindow | None:
        try:
            from datetime import datetime

            start = datetime.fromisoformat(value["start"]) if value.get("start") else None
            end = datetime.fromisoformat(value["end"]) if value.get("end") else None
            return SearchWindow(start, end, str(value.get("granularity") or "all"), value.get("region"))
        except (KeyError, TypeError, ValueError):
            return None

    def resume_windows(self) -> list[SearchWindow]:
        """Return persisted pending/partial child windows in stable order."""

        rows = self.db.execute("SELECT status,detail,start,end,granularity,region FROM windows ORDER BY updated_at, rowid").fetchall()
        result: list[SearchWindow] = []
        seen: set[str] = set()
        for status, detail, start, end, granularity, region in rows:
            if status == "split":
                try:
                    payload = json.loads(detail or "{}")
                except json.JSONDecodeError:
                    payload = {}
                candidates = payload.get("children", []) if isinstance(payload, dict) else []
                for candidate in candidates:
                    window = self._window_from_dict(candidate) if isinstance(candidate, dict) else None
                    if window and window.key not in seen and self.window_status(window.key) != "completed":
                        result.append(window)
                        seen.add(window.key)
            elif status in {"pending", "partial"}:
                window = self._window_from_dict({"start": start, "end": end, "granularity": granularity, "region": region})
                if window and window.key not in seen:
                    result.append(window)
                    seen.add(window.key)
        return result

    def checkpoint(self, *, pending: Iterable[str] = (), completed: Iterable[str] = (), truncated: Iterable[str] = (), count: int = 0) -> None:
        payload = {
            "updated_at": datetime.now().astimezone().isoformat(timespec="seconds"),
            "pending_windows": list(pending),
            "completed_windows": list(completed),
            "truncated_windows": list(truncated),
            "count": int(count),
        }
        self.checkpoint_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    def write_manifest(self, payload: dict[str, Any]) -> None:
        # Caller supplies only value-free options and parsed result metadata.
        self.manifest_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def options_manifest(options: SearchOptions) -> dict[str, Any]:
    return {
        "query": options.query,
        "limit": options.limit,
        "start": options.start,
        "end": options.end,
        "type": options.weibo_type,
        "contains": options.contains,
        "region": options.region,
        "threshold": options.threshold,
        "delay": options.delay,
        "format": options.output_format,
        "cdp_port": options.cdp_port,
    }
