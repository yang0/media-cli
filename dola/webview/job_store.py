# -*- coding: utf-8 -*-
"""Durable SQLite state for the Dola video job queue."""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import sqlite3
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import urlsplit, urlunsplit

ROOT = Path(__file__).resolve().parent
PROJECT_ROOT = ROOT.parent
_USER_DATA_ROOT = Path(os.environ.get("LOCALAPPDATA") or (Path.home() / ".local" / "share")) / "dola-cli"
_LEGACY_DATA_ROOT = PROJECT_ROOT / "cli" / ".dola"
_LEGACY_JOBS_ROOT = PROJECT_ROOT / "cli" / "downloads" / "jobs"
DEFAULT_DATA_DIR = Path(
    os.environ.get("DOLA_DATA_DIR")
    or (_LEGACY_DATA_ROOT if _LEGACY_DATA_ROOT.exists() else _USER_DATA_ROOT)
)
DEFAULT_DB = Path(os.environ.get("DOLA_JOB_DB") or DEFAULT_DATA_DIR / "jobs.sqlite3")
DEFAULT_JOBS_ROOT = Path(
    os.environ.get("DOLA_JOBS_ROOT")
    or (_LEGACY_JOBS_ROOT if _LEGACY_JOBS_ROOT.exists() else Path.cwd() / "downloads" / "jobs")
)
DEFAULT_PROFILES = Path(
    os.environ.get("DOLA_PROFILES_DIR")
    or (ROOT / "profiles" if (ROOT / "profiles").is_dir() else _USER_DATA_ROOT / "profiles")
)
DEFAULT_COOKIE_POOL = Path(os.environ.get("DOLA_ACCOUNT_POOL") or r"G:\cookies\dola")
SHANGHAI = timezone(timedelta(hours=8))
DAILY_LIMIT = 4
DURATION_COST = {5: 1, 10: 2, 15: 3}
TERMINAL_STATES = {"succeeded", "failed", "timed_out", "needs_review", "cancelled"}


def pid_alive(pid: int) -> bool:
    """Return whether a recorded worker PID still exists."""
    try:
        value = int(pid)
    except (TypeError, ValueError):
        return False
    if value <= 0:
        return False
    if value == os.getpid():
        return True
    if os.name == "nt":
        try:
            import ctypes

            process_query_limited_information = 0x1000
            still_active = 259
            kernel32 = ctypes.windll.kernel32
            handle = kernel32.OpenProcess(process_query_limited_information, False, value)
            if not handle:
                return False
            try:
                exit_code = ctypes.c_ulong()
                if not kernel32.GetExitCodeProcess(handle, ctypes.byref(exit_code)):
                    return False
                return int(exit_code.value) == still_active
            finally:
                kernel32.CloseHandle(handle)
        except Exception:
            # Fall back to heartbeat-only semantics if Win32 inspection itself
            # is unavailable; false negatives can create duplicate workers.
            return True
    try:
        os.kill(value, 0)
        return True
    except PermissionError:
        return True
    except OSError:
        return False


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def day_key() -> str:
    return datetime.now(SHANGHAI).date().isoformat()


def json_dump(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def json_load(value: str | None, fallback: Any) -> Any:
    try:
        return json.loads(value or "")
    except (TypeError, ValueError):
        return fallback


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def credit_cost(duration: int) -> int:
    if duration not in DURATION_COST:
        raise ValueError("duration must be one of 5, 10, or 15")
    return DURATION_COST[duration]


def clean_vid(value: Any) -> str:
    text = str(value or "").strip()
    if text.lower().startswith(("http://", "https://")):
        return ""
    return text[:512]


def timestamp_rank(value: Any) -> float:
    text = str(value or "").strip()
    if not text:
        return 0.0
    try:
        return datetime.fromisoformat(text).timestamp()
    except ValueError:
        return 0.0


def discover_accounts(
    profiles_dir: Path = DEFAULT_PROFILES,
    cookie_pool: Path = DEFAULT_COOKIE_POOL,
) -> list[str]:
    names: set[str] = set()
    if profiles_dir.is_dir():
        names.update(p.name for p in profiles_dir.iterdir() if p.is_dir())
    if cookie_pool.is_dir():
        for path in cookie_pool.iterdir():
            if not path.is_file() or path.suffix.lower() not in {".txt", ".json", ".cookie", ".cookies"}:
                continue
            name = path.stem
            if name.lower().startswith(("dola_", "dola-")):
                name = name[5:]
            if name:
                names.add(name)
    return sorted(names)


class ClosingConnection(sqlite3.Connection):
    """sqlite context manager that also closes its Windows file handle."""

    def __exit__(self, exc_type, exc_value, traceback):
        try:
            return super().__exit__(exc_type, exc_value, traceback)
        finally:
            self.close()


class JobStore:
    def __init__(self, db_path: Path = DEFAULT_DB):
        self.db_path = Path(db_path).resolve()
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self.init_schema()

    def connect(self) -> sqlite3.Connection:
        con = sqlite3.connect(
            self.db_path,
            timeout=15,
            isolation_level=None,
            factory=ClosingConnection,
        )
        con.row_factory = sqlite3.Row
        con.execute("PRAGMA journal_mode=WAL")
        con.execute("PRAGMA synchronous=NORMAL")
        con.execute("PRAGMA busy_timeout=15000")
        return con

    def init_schema(self) -> None:
        with self.connect() as con:
            con.executescript(
                """
                CREATE TABLE IF NOT EXISTS jobs (
                  job_id TEXT PRIMARY KEY,
                  request_id TEXT UNIQUE,
                  state TEXT NOT NULL,
                  prompt TEXT NOT NULL,
                  duration INTEGER NOT NULL,
                  credit_cost INTEGER NOT NULL,
                  aspect_ratio TEXT NOT NULL,
                  model TEXT NOT NULL DEFAULT '',
                  refs_json TEXT NOT NULL DEFAULT '[]',
                  requested_account TEXT NOT NULL DEFAULT '',
                  allow_account_fallback INTEGER NOT NULL DEFAULT 0,
                  account_id TEXT NOT NULL DEFAULT '',
                  charge_day TEXT NOT NULL DEFAULT '',
                  created_at TEXT NOT NULL,
                  reserved_at TEXT,
                  submitted_at TEXT,
                  completed_at TEXT,
                  updated_at TEXT NOT NULL,
                  session_url TEXT NOT NULL DEFAULT '',
                  message_id TEXT NOT NULL DEFAULT '',
                  vid TEXT NOT NULL DEFAULT '',
                  source_url TEXT NOT NULL DEFAULT '',
                  output_dir TEXT NOT NULL,
                  output_file TEXT NOT NULL DEFAULT '',
                  manifest_file TEXT NOT NULL DEFAULT '',
                  file_size INTEGER NOT NULL DEFAULT 0,
                  sha256 TEXT NOT NULL DEFAULT '',
                  error TEXT NOT NULL DEFAULT '',
                  attempt INTEGER NOT NULL DEFAULT 0,
                  max_attempts INTEGER NOT NULL DEFAULT 2,
                  timeout_seconds INTEGER NOT NULL DEFAULT 1800,
                  worker_id TEXT NOT NULL DEFAULT '',
                  event_file TEXT NOT NULL DEFAULT ''
                );
                CREATE INDEX IF NOT EXISTS jobs_state_created_idx ON jobs(state, created_at);
                CREATE TABLE IF NOT EXISTS account_daily (
                  day TEXT NOT NULL,
                  account_id TEXT NOT NULL,
                  spent INTEGER NOT NULL DEFAULT 0,
                  reserved INTEGER NOT NULL DEFAULT 0,
                  last_assigned_at TEXT,
                  PRIMARY KEY(day, account_id)
                );
                CREATE TABLE IF NOT EXISTS account_leases (
                  account_id TEXT PRIMARY KEY,
                  job_id TEXT NOT NULL UNIQUE,
                  worker_id TEXT NOT NULL,
                  heartbeat_at TEXT NOT NULL,
                  lease_until TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS account_health (
                  account_id TEXT PRIMARY KEY,
                  healthy INTEGER NOT NULL DEFAULT 1,
                  reason TEXT NOT NULL DEFAULT '',
                  fingerprint TEXT NOT NULL DEFAULT '',
                  updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS workers (
                  worker_id TEXT PRIMARY KEY,
                  pid INTEGER NOT NULL,
                  concurrency INTEGER NOT NULL,
                  started_at TEXT NOT NULL,
                  heartbeat_at TEXT NOT NULL,
                  stop_requested INTEGER NOT NULL DEFAULT 0
                );
                CREATE TABLE IF NOT EXISTS job_events (
                  id INTEGER PRIMARY KEY AUTOINCREMENT,
                  job_id TEXT NOT NULL,
                  type TEXT NOT NULL,
                  at TEXT NOT NULL,
                  payload_json TEXT NOT NULL DEFAULT '{}'
                );
                CREATE TABLE IF NOT EXISTS metadata (
                  key TEXT PRIMARY KEY,
                  value TEXT NOT NULL
                );
                """
            )
            columns = {row["name"] for row in con.execute("PRAGMA table_info(account_health)").fetchall()}
            if "fingerprint" not in columns:
                con.execute("ALTER TABLE account_health ADD COLUMN fingerprint TEXT NOT NULL DEFAULT ''")
            bad_vid_rows = con.execute(
                "SELECT manifest_file FROM jobs WHERE lower(vid) LIKE 'http://%' OR lower(vid) LIKE 'https://%'"
            ).fetchall()
            con.execute("UPDATE jobs SET vid='' WHERE lower(vid) LIKE 'http://%' OR lower(vid) LIKE 'https://%'")
            for row in bad_vid_rows:
                manifest = Path(row["manifest_file"] or "")
                if not manifest.is_file():
                    continue
                try:
                    value = json.loads(manifest.read_text(encoding="utf-8"))
                    value["vid"] = ""
                    raw_url = str(value.pop("url", "") or "")
                    if raw_url:
                        parts = urlsplit(raw_url)
                        value["sourceUrl"] = urlunsplit((parts.scheme, parts.netloc, parts.path, "", ""))
                    manifest.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
                except (OSError, ValueError, TypeError):
                    pass
            for row in con.execute("SELECT manifest_file FROM jobs WHERE manifest_file<>''").fetchall():
                manifest = Path(row["manifest_file"] or "")
                if not manifest.is_file():
                    continue
                try:
                    value = json.loads(manifest.read_text(encoding="utf-8"))
                    raw_url = str(value.pop("url", "") or value.get("sourceUrl") or "")
                    if raw_url:
                        parts = urlsplit(raw_url)
                        value["sourceUrl"] = (
                            urlunsplit((parts.scheme, parts.netloc, "/<redacted>", "", ""))
                            if parts.scheme else "<redacted>"
                        )
                    manifest.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
                except (OSError, ValueError, TypeError):
                    pass
            for row in con.execute("SELECT event_file FROM jobs WHERE state='succeeded' AND event_file<>''").fetchall():
                try:
                    Path(row["event_file"]).unlink(missing_ok=True)
                except OSError:
                    pass
            for row in con.execute("SELECT output_dir FROM jobs WHERE state='succeeded'").fetchall():
                output_dir = Path(row["output_dir"] or "")
                if not output_dir.is_dir():
                    continue
                for log_file in output_dir.glob("*.log"):
                    try:
                        text = log_file.read_text(encoding="utf-8", errors="replace")
                        clean = re.sub(
                            r"(https?://[^/\s?\"']+)[^\s\"']*\?[^\s\"']+",
                            r"\1/<redacted>",
                            text,
                        )
                        if clean != text:
                            log_file.write_text(clean, encoding="utf-8")
                    except OSError:
                        pass
            self._migrate_legacy_daily_usage(con)

    def _migrate_legacy_daily_usage(self, con: sqlite3.Connection) -> None:
        key = "legacy_daily_profile_usage_imported_v1"
        if con.execute("SELECT 1 FROM metadata WHERE key=?", (key,)).fetchone():
            return
        legacy = ROOT / "daily_profile_usage.json"
        imported: dict[str, Any] = {"file": str(legacy), "accounts": 0}
        try:
            value = json.loads(legacy.read_text(encoding="utf-8"))
            legacy_day = str(value.get("date") or "")
            accounts = value.get("accounts") if isinstance(value.get("accounts"), dict) else {}
            if legacy_day:
                for account_id, record in accounts.items():
                    spent = max(0, int((record or {}).get("spent") or 0))
                    con.execute(
                        """
                        INSERT INTO account_daily(day,account_id,spent,reserved,last_assigned_at)
                        VALUES(?,?,?,0,?)
                        ON CONFLICT(day,account_id) DO UPDATE SET spent=MAX(spent,excluded.spent)
                        """,
                        (legacy_day, str(account_id), spent, (record or {}).get("openedAt")),
                    )
                    imported["accounts"] += 1
                imported["day"] = legacy_day
        except (OSError, ValueError, TypeError):
            imported["missingOrInvalid"] = True
        con.execute("INSERT INTO metadata(key,value) VALUES(?,?)", (key, json_dump(imported)))

    def submit(
        self,
        *,
        prompt: str,
        duration: int,
        refs: Iterable[str] = (),
        aspect_ratio: str = "9:16",
        model: str = "",
        request_id: str = "",
        requested_account: str = "",
        allow_account_fallback: bool = False,
        jobs_root: Path = DEFAULT_JOBS_ROOT,
        timeout_seconds: int = 1800,
    ) -> tuple[dict, bool]:
        prompt = str(prompt or "").strip()
        if not prompt:
            raise ValueError("prompt is required")
        duration = int(duration)
        cost = credit_cost(duration)
        if duration >= 15 and not model:
            model = "seedance_v2.0"
        request_id = str(request_id or "").strip()
        with self.connect() as con:
            if request_id:
                existing = con.execute("SELECT * FROM jobs WHERE request_id=?", (request_id,)).fetchone()
                if existing:
                    return self._public(existing), False

        job_id = uuid.uuid4().hex
        created_at = now_iso()
        local_day = datetime.now(SHANGHAI).date().isoformat()
        output_dir = Path(jobs_root).resolve() / local_day / job_id
        refs_dir = output_dir / "references"
        refs_dir.mkdir(parents=True, exist_ok=False)
        copied_refs: list[dict] = []
        for index, raw in enumerate(refs):
            source = Path(raw).resolve()
            if not source.is_file():
                raise FileNotFoundError(str(source))
            safe_name = f"{index + 1:02d}_{source.name}"
            target = refs_dir / safe_name
            shutil.copy2(source, target)
            copied_refs.append(
                {
                    "source": str(source),
                    "file": str(target),
                    "name": source.name,
                    "size": target.stat().st_size,
                    "sha256": file_sha256(target),
                }
            )
        request_manifest = {
            "version": 1,
            "jobId": job_id,
            "requestId": request_id,
            "prompt": prompt,
            "duration": duration,
            "creditCost": cost,
            "aspectRatio": aspect_ratio,
            "model": model,
            "requestedAccount": requested_account,
            "allowAccountFallback": bool(allow_account_fallback),
            "createdAt": created_at,
            "references": copied_refs,
        }
        request_file = output_dir / "request.json"
        request_file.write_text(json.dumps(request_manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        event_file = output_dir / "events.jsonl"
        try:
            with self.connect() as con:
                con.execute("BEGIN IMMEDIATE")
                if request_id:
                    existing = con.execute("SELECT * FROM jobs WHERE request_id=?", (request_id,)).fetchone()
                    if existing:
                        con.rollback()
                        shutil.rmtree(output_dir, ignore_errors=True)
                        return self._public(existing), False
                con.execute(
                    """
                    INSERT INTO jobs (
                      job_id, request_id, state, prompt, duration, credit_cost, aspect_ratio, model,
                      refs_json, requested_account, allow_account_fallback, created_at, updated_at,
                      output_dir, timeout_seconds, event_file
                    ) VALUES (?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        job_id,
                        request_id or None,
                        prompt,
                        duration,
                        cost,
                        aspect_ratio or "9:16",
                        model or "",
                        json_dump(copied_refs),
                        requested_account or "",
                        int(bool(allow_account_fallback)),
                        created_at,
                        created_at,
                        str(output_dir),
                        int(timeout_seconds),
                        str(event_file),
                    ),
                )
                self._event(con, job_id, "queued", {"requestFile": str(request_file)})
                row = con.execute("SELECT * FROM jobs WHERE job_id=?", (job_id,)).fetchone()
                con.commit()
            return self._public(row), True
        except Exception:
            shutil.rmtree(output_dir, ignore_errors=True)
            raise

    def reserve_next(
        self,
        accounts: list[str],
        worker_id: str,
        lease_seconds: int = 45,
        global_limit: int = 3,
    ) -> dict | None:
        accounts = sorted({str(a).strip() for a in accounts if str(a).strip()})
        if not accounts:
            return None
        now = now_iso()
        lease_until = (datetime.now(timezone.utc) + timedelta(seconds=lease_seconds)).isoformat(timespec="seconds")
        day = day_key()
        with self.connect() as con:
            con.execute("BEGIN IMMEDIATE")
            self._recover_expired_locked(con, now)
            active_count = con.execute("SELECT COUNT(*) AS n FROM account_leases").fetchone()["n"]
            if int(active_count) >= max(1, int(global_limit)):
                con.commit()
                return None
            jobs = con.execute("SELECT * FROM jobs WHERE state='queued' ORDER BY created_at, job_id").fetchall()
            for job in jobs:
                candidates = list(accounts)
                preferred = job["requested_account"]
                if preferred:
                    candidates = [preferred] if not job["allow_account_fallback"] else [preferred] + [a for a in accounts if a != preferred]
                ranked: list[tuple[int, float, str]] = []
                for account_id in candidates:
                    if account_id not in accounts:
                        continue
                    health = con.execute("SELECT healthy FROM account_health WHERE account_id=?", (account_id,)).fetchone()
                    if health and not health["healthy"]:
                        continue
                    if con.execute("SELECT 1 FROM account_leases WHERE account_id=?", (account_id,)).fetchone():
                        continue
                    usage = con.execute(
                        "SELECT spent,reserved,last_assigned_at FROM account_daily WHERE day=? AND account_id=?",
                        (day, account_id),
                    ).fetchone()
                    spent = int(usage["spent"]) if usage else 0
                    reserved = int(usage["reserved"]) if usage else 0
                    if DAILY_LIMIT - spent - reserved < int(job["credit_cost"]):
                        continue
                    last = timestamp_rank(usage["last_assigned_at"]) if usage else 0.0
                    ranked.append((spent + reserved, last, account_id))
                if not ranked:
                    continue
                _, _, account_id = sorted(ranked, key=lambda item: (item[0], item[1], item[2]))[0]
                con.execute(
                    """
                    INSERT INTO account_daily(day,account_id,spent,reserved,last_assigned_at)
                    VALUES(?,?,0,?,?)
                    ON CONFLICT(day,account_id) DO UPDATE SET
                      reserved=reserved+excluded.reserved,last_assigned_at=excluded.last_assigned_at
                    """,
                    (day, account_id, int(job["credit_cost"]), now),
                )
                con.execute(
                    "INSERT INTO account_leases(account_id,job_id,worker_id,heartbeat_at,lease_until) VALUES(?,?,?,?,?)",
                    (account_id, job["job_id"], worker_id, now, lease_until),
                )
                con.execute(
                    """
                    UPDATE jobs SET state='reserved',account_id=?,charge_day=?,reserved_at=?,updated_at=?,
                      worker_id=?,attempt=attempt+1,error=''
                    WHERE job_id=?
                    """,
                    (account_id, day, now, now, worker_id, job["job_id"]),
                )
                self._event(con, job["job_id"], "reserved", {"accountId": account_id, "day": day})
                row = con.execute("SELECT * FROM jobs WHERE job_id=?", (job["job_id"],)).fetchone()
                con.commit()
                return dict(row)
            con.commit()
        return None

    def set_submitting(self, job_id: str) -> bool:
        """Move a reserved job to submitting unless it was cancelled meanwhile."""
        with self.connect() as con:
            con.execute("BEGIN IMMEDIATE")
            cur = con.execute(
                "UPDATE jobs SET state='submitting',updated_at=? WHERE job_id=? AND state='reserved'",
                (now_iso(), job_id),
            )
            if cur.rowcount:
                self._event(con, job_id, "submitting", {})
            con.commit()
            return bool(cur.rowcount)

    def mark_submitted(self, job_id: str, payload: dict | None = None) -> None:
        payload = payload or {}
        now = now_iso()
        with self.connect() as con:
            con.execute("BEGIN IMMEDIATE")
            job = con.execute("SELECT * FROM jobs WHERE job_id=?", (job_id,)).fetchone()
            if not job or job["submitted_at"]:
                con.commit()
                return
            charge_day = str(job["charge_day"] or "")
            submit_day = day_key()
            cost = int(job["credit_cost"])
            if charge_day != submit_day:
                con.execute(
                    "UPDATE account_daily SET reserved=MAX(0,reserved-?) WHERE day=? AND account_id=?",
                    (cost, charge_day, job["account_id"]),
                )
                current = con.execute(
                    "SELECT spent,reserved FROM account_daily WHERE day=? AND account_id=?",
                    (submit_day, job["account_id"]),
                ).fetchone()
                spent = int(current["spent"]) if current else 0
                reserved = int(current["reserved"]) if current else 0
                if DAILY_LIMIT - spent - reserved < cost:
                    raise RuntimeError(
                        f"account {job['account_id']} lacks {cost} credits on submit day {submit_day}"
                    )
                con.execute(
                    """
                    INSERT INTO account_daily(day,account_id,spent,reserved,last_assigned_at)
                    VALUES(?,?,0,?,?)
                    ON CONFLICT(day,account_id) DO UPDATE SET
                      reserved=reserved+excluded.reserved,last_assigned_at=excluded.last_assigned_at
                    """,
                    (submit_day, job["account_id"], cost, now),
                )
                con.execute("UPDATE jobs SET charge_day=? WHERE job_id=?", (submit_day, job_id))
                charge_day = submit_day
            usage = con.execute(
                "SELECT reserved FROM account_daily WHERE day=? AND account_id=?",
                (charge_day, job["account_id"]),
            ).fetchone()
            reserved = int(usage["reserved"]) if usage else 0
            if reserved < cost:
                raise RuntimeError(f"credit reservation missing for job {job_id}")
            con.execute(
                "UPDATE account_daily SET reserved=reserved-?,spent=spent+? WHERE day=? AND account_id=?",
                (cost, cost, charge_day, job["account_id"]),
            )
            con.execute(
                """
                UPDATE jobs SET state='running',submitted_at=?,updated_at=?,session_url=?,
                  message_id=?,vid=? WHERE job_id=?
                """,
                (
                    now,
                    now,
                    str(payload.get("sessionUrl") or ""),
                    str(payload.get("messageId") or ""),
                    clean_vid(payload.get("vid")),
                    job_id,
                ),
            )
            self._event(con, job_id, "submitted", payload)
            con.commit()

    def mark_generated(self, job_id: str, payload: dict | None = None) -> None:
        payload = payload or {}
        with self.connect() as con:
            con.execute("BEGIN IMMEDIATE")
            con.execute(
                """
                UPDATE jobs SET state='generated_pending_download',updated_at=?,session_url=?,
                  message_id=?,vid=?,source_url=? WHERE job_id=?
                """,
                (
                    now_iso(),
                    str(payload.get("sessionUrl") or ""),
                    str(payload.get("messageId") or ""),
                    clean_vid(payload.get("vid")),
                    str(payload.get("url") or ""),
                    job_id,
                ),
            )
            self._event(con, job_id, "generated", payload)
            con.commit()

    def finish(self, job_id: str, result: dict) -> dict:
        now = now_iso()
        with self.connect() as con:
            con.execute("BEGIN IMMEDIATE")
            con.execute(
                """
                UPDATE jobs SET state='succeeded',completed_at=?,updated_at=?,session_url=?,
                  message_id=?,vid=?,source_url=?,output_file=?,manifest_file=?,file_size=?,sha256=?,error=''
                WHERE job_id=?
                """,
                (
                    now,
                    now,
                    str(result.get("sessionUrl") or ""),
                    str(result.get("messageId") or ""),
                    clean_vid(result.get("vid")),
                    str(result.get("url") or ""),
                    str(result.get("outputFile") or ""),
                    str(result.get("manifestFile") or ""),
                    int(result.get("size") or 0),
                    str(result.get("sha256") or ""),
                    job_id,
                ),
            )
            self._release_lease_locked(con, job_id, release_credit=False)
            self._event(con, job_id, "succeeded", result)
            row = con.execute("SELECT * FROM jobs WHERE job_id=?", (job_id,)).fetchone()
            con.commit()
            return self._public(row)

    def fail(self, job_id: str, error: str, *, state: str = "failed", retry: bool = False) -> dict:
        if state not in {"failed", "timed_out", "needs_review", "generated_pending_download", "queued"}:
            raise ValueError(f"invalid failure state: {state}")
        now = now_iso()
        with self.connect() as con:
            con.execute("BEGIN IMMEDIATE")
            job = con.execute("SELECT * FROM jobs WHERE job_id=?", (job_id,)).fetchone()
            if not job:
                raise KeyError(job_id)
            submitted = bool(job["submitted_at"])
            next_state = "queued" if retry and not submitted and int(job["attempt"]) < int(job["max_attempts"]) else state
            con.execute("UPDATE jobs SET state=?,updated_at=?,completed_at=?,error=? WHERE job_id=?",
                        (next_state, now, None if next_state == "queued" else now, str(error)[:4000], job_id))
            self._release_lease_locked(con, job_id, release_credit=not submitted)
            self._event(con, job_id, next_state, {"error": str(error)[:1000]})
            row = con.execute("SELECT * FROM jobs WHERE job_id=?", (job_id,)).fetchone()
            con.commit()
            return self._public(row)

    def heartbeat_lease(self, job_id: str, worker_id: str, lease_seconds: int = 45) -> None:
        now = now_iso()
        until = (datetime.now(timezone.utc) + timedelta(seconds=lease_seconds)).isoformat(timespec="seconds")
        with self.connect() as con:
            con.execute(
                "UPDATE account_leases SET heartbeat_at=?,lease_until=? WHERE job_id=? AND worker_id=?",
                (now, until, job_id, worker_id),
            )

    def get(self, job_id: str) -> dict:
        with self.connect() as con:
            row = con.execute("SELECT * FROM jobs WHERE job_id=?", (job_id,)).fetchone()
        if not row:
            raise KeyError(job_id)
        return self._public(row)

    def list_jobs(self, limit: int = 50) -> list[dict]:
        with self.connect() as con:
            rows = con.execute("SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?", (max(1, min(limit, 500)),)).fetchall()
        return [self._public(row) for row in rows]

    def cancel(self, job_id: str, reason: str = "cancelled by user") -> dict:
        """Cancel one job and refund only an unconfirmed credit reservation."""
        now = now_iso()
        with self.connect() as con:
            con.execute("BEGIN IMMEDIATE")
            job = con.execute("SELECT * FROM jobs WHERE job_id=?", (job_id,)).fetchone()
            if not job:
                raise KeyError(job_id)
            if job["state"] in TERMINAL_STATES:
                con.commit()
                return self._public(job)
            submitted = bool(job["submitted_at"])
            con.execute(
                "UPDATE jobs SET state='cancelled',updated_at=?,completed_at=?,error=? WHERE job_id=?",
                (now, now, str(reason)[:4000], job_id),
            )
            self._release_lease_locked(con, job_id, release_credit=not submitted)
            self._event(
                con,
                job_id,
                "cancelled",
                {"reason": str(reason)[:1000], "creditReleased": not submitted},
            )
            row = con.execute("SELECT * FROM jobs WHERE job_id=?", (job_id,)).fetchone()
            con.commit()
            return self._public(row)

    def cleanup_unsubmitted(
        self,
        *,
        request_prefix: str = "",
        reason: str = "cancelled by jobs cleanup",
    ) -> list[dict]:
        """Cancel queued/in-flight jobs that have no confirmed remote submission."""
        now = now_iso()
        with self.connect() as con:
            con.execute("BEGIN IMMEDIATE")
            sql = """
                SELECT * FROM jobs
                WHERE state IN ('queued','reserved','submitting')
                  AND (submitted_at IS NULL OR submitted_at='')
            """
            params: list[Any] = []
            if request_prefix:
                sql += " AND request_id LIKE ?"
                params.append(f"{request_prefix}%")
            sql += " ORDER BY created_at,job_id"
            jobs = con.execute(sql, params).fetchall()
            cancelled: list[dict] = []
            for job in jobs:
                con.execute(
                    "UPDATE jobs SET state='cancelled',updated_at=?,completed_at=?,error=? WHERE job_id=?",
                    (now, now, str(reason)[:4000], job["job_id"]),
                )
                self._release_lease_locked(con, job["job_id"], release_credit=True)
                self._event(
                    con,
                    job["job_id"],
                    "cancelled",
                    {"reason": str(reason)[:1000], "creditReleased": True},
                )
                row = con.execute("SELECT * FROM jobs WHERE job_id=?", (job["job_id"],)).fetchone()
                cancelled.append(self._public(row))
            con.commit()
            return cancelled

    def pool_status(self, accounts: list[str]) -> list[dict]:
        day = day_key()
        with self.connect() as con:
            out = []
            for account_id in sorted(accounts):
                usage = con.execute("SELECT * FROM account_daily WHERE day=? AND account_id=?", (day, account_id)).fetchone()
                lease = con.execute("SELECT * FROM account_leases WHERE account_id=?", (account_id,)).fetchone()
                health = con.execute("SELECT * FROM account_health WHERE account_id=?", (account_id,)).fetchone()
                spent = int(usage["spent"]) if usage else 0
                reserved = int(usage["reserved"]) if usage else 0
                out.append({
                    "accountId": account_id,
                    "day": day,
                    "limit": DAILY_LIMIT,
                    "spent": spent,
                    "reserved": reserved,
                    "remaining": max(0, DAILY_LIMIT - spent - reserved),
                    "busyJobId": lease["job_id"] if lease else "",
                    "healthy": bool(health["healthy"]) if health else True,
                    "healthReason": health["reason"] if health else "",
                    "lastAssignedAt": usage["last_assigned_at"] if usage else None,
                })
            return out

    def set_account_health(self, account_id: str, healthy: bool, reason: str = "", fingerprint: str = "") -> None:
        with self.connect() as con:
            con.execute(
                """
                INSERT INTO account_health(account_id,healthy,reason,fingerprint,updated_at) VALUES(?,?,?,?,?)
                ON CONFLICT(account_id) DO UPDATE SET healthy=excluded.healthy,
                  reason=excluded.reason,fingerprint=excluded.fingerprint,updated_at=excluded.updated_at
                """,
                (account_id, int(bool(healthy)), str(reason)[:1000], fingerprint, now_iso()),
            )

    def refresh_account_health(self, account_id: str, fingerprint: str) -> None:
        """A replaced cookie/profile automatically clears an old health block."""
        if not fingerprint:
            return
        with self.connect() as con:
            row = con.execute("SELECT healthy,fingerprint FROM account_health WHERE account_id=?", (account_id,)).fetchone()
            if row and not row["healthy"] and row["fingerprint"] and row["fingerprint"] != fingerprint:
                con.execute(
                    "UPDATE account_health SET healthy=1,reason='',fingerprint=?,updated_at=? WHERE account_id=?",
                    (fingerprint, now_iso(), account_id),
                )

    def register_worker(self, worker_id: str, pid: int, concurrency: int) -> bool:
        now = now_iso()
        with self.connect() as con:
            con.execute("BEGIN IMMEDIATE")
            rows = con.execute(
                "SELECT worker_id,pid,heartbeat_at,stop_requested FROM workers WHERE worker_id<>?",
                (worker_id,),
            ).fetchall()
            current = datetime.now(timezone.utc)
            if any(
                not row["stop_requested"]
                and pid_alive(row["pid"])
                and (current - datetime.fromisoformat(row["heartbeat_at"])).total_seconds() < 35
                for row in rows
            ):
                con.commit()
                return False
            con.execute(
                """
                INSERT INTO workers(worker_id,pid,concurrency,started_at,heartbeat_at,stop_requested)
                VALUES(?,?,?,?,?,0)
                ON CONFLICT(worker_id) DO UPDATE SET pid=excluded.pid,concurrency=excluded.concurrency,
                  started_at=excluded.started_at,heartbeat_at=excluded.heartbeat_at,stop_requested=0
                """,
                (worker_id, pid, concurrency, now, now),
            )
            con.commit()
            return True

    def heartbeat_worker(self, worker_id: str) -> bool:
        with self.connect() as con:
            con.execute("UPDATE workers SET heartbeat_at=? WHERE worker_id=?", (now_iso(), worker_id))
            row = con.execute("SELECT stop_requested FROM workers WHERE worker_id=?", (worker_id,)).fetchone()
        return bool(row and row["stop_requested"])

    def request_worker_stop(self) -> int:
        with self.connect() as con:
            cur = con.execute("UPDATE workers SET stop_requested=1")
            return cur.rowcount

    def worker_status(self) -> list[dict]:
        with self.connect() as con:
            rows = con.execute("SELECT * FROM workers ORDER BY started_at DESC").fetchall()
        now = datetime.now(timezone.utc)
        return [{
            "workerId": row["worker_id"],
            "pid": row["pid"],
            "concurrency": row["concurrency"],
            "startedAt": row["started_at"],
            "heartbeatAt": row["heartbeat_at"],
            "alive": (
                pid_alive(row["pid"])
                and (now - datetime.fromisoformat(row["heartbeat_at"])).total_seconds() < 35
            ),
            "stopRequested": bool(row["stop_requested"]),
        } for row in rows]

    def _set_state(self, job_id: str, state: str) -> None:
        with self.connect() as con:
            con.execute("BEGIN IMMEDIATE")
            con.execute("UPDATE jobs SET state=?,updated_at=? WHERE job_id=?", (state, now_iso(), job_id))
            self._event(con, job_id, state, {})
            con.commit()

    def _recover_expired_locked(self, con: sqlite3.Connection, now: str) -> None:
        expired = con.execute(
            """
            SELECT j.* FROM jobs j JOIN account_leases l ON l.job_id=j.job_id
            WHERE l.lease_until < ?
            """,
            (now,),
        ).fetchall()
        for job in expired:
            if job["submitted_at"]:
                con.execute(
                    "UPDATE jobs SET state='needs_review',updated_at=?,completed_at=?,error=? WHERE job_id=?",
                    (now, now, "worker lease expired after submission; automatic resubmit disabled", job["job_id"]),
                )
                self._release_lease_locked(con, job["job_id"], release_credit=False)
            else:
                con.execute(
                    "UPDATE jobs SET state='queued',updated_at=?,error=? WHERE job_id=?",
                    (now, "worker lease expired before confirmed submission; requeued", job["job_id"]),
                )
                self._release_lease_locked(con, job["job_id"], release_credit=True)

    def _release_lease_locked(self, con: sqlite3.Connection, job_id: str, *, release_credit: bool) -> None:
        job = con.execute("SELECT * FROM jobs WHERE job_id=?", (job_id,)).fetchone()
        if not job:
            return
        if release_credit and job["charge_day"] and job["account_id"]:
            con.execute(
                """
                UPDATE account_daily SET reserved=MAX(0,reserved-?)
                WHERE day=? AND account_id=?
                """,
                (int(job["credit_cost"]), job["charge_day"], job["account_id"]),
            )
        con.execute("DELETE FROM account_leases WHERE job_id=?", (job_id,))

    @staticmethod
    def _event(con: sqlite3.Connection, job_id: str, event_type: str, payload: dict) -> None:
        con.execute(
            "INSERT INTO job_events(job_id,type,at,payload_json) VALUES(?,?,?,?)",
            (job_id, event_type, now_iso(), json_dump(payload)),
        )

    @staticmethod
    def _public(row: sqlite3.Row | dict) -> dict:
        item = dict(row)
        return {
            "jobId": item["job_id"],
            "requestId": item.get("request_id") or "",
            "state": item["state"],
            "accountId": item.get("account_id") or "",
            "duration": int(item["duration"]),
            "creditCost": int(item["credit_cost"]),
            "prompt": item["prompt"],
            "aspectRatio": item.get("aspect_ratio") or "",
            "model": item.get("model") or "",
            "createdAt": item.get("created_at"),
            "submittedAt": item.get("submitted_at"),
            "completedAt": item.get("completed_at"),
            "messageId": item.get("message_id") or "",
            "vid": item.get("vid") or "",
            "sessionUrl": item.get("session_url") or "",
            "outputFile": item.get("output_file") or "",
            "manifestFile": item.get("manifest_file") or "",
            "sha256": item.get("sha256") or "",
            "size": int(item.get("file_size") or 0),
            "error": item.get("error") or "",
            "attempt": int(item.get("attempt") or 0),
            "outputDir": item.get("output_dir") or "",
        }
