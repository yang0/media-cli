# -*- coding: utf-8 -*-
"""Background worker for durable Dola video jobs."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import threading
import time
import uuid
from concurrent.futures import Future, ThreadPoolExecutor
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit, urlunsplit

from job_store import (
    DEFAULT_COOKIE_POOL,
    DEFAULT_DB,
    DEFAULT_PROFILES,
    JobStore,
    clean_vid,
    discover_accounts,
    now_iso,
)
from video_flow import download_url

ROOT = Path(__file__).resolve().parent
INJECT_SHELL = ROOT / "inject_shell.py"


def _account_fingerprint(account_id: str, profiles_dir: Path, cookie_pool: Path) -> str:
    candidates = []
    for name in (f"dola_{account_id}.txt", f"{account_id}.txt", f"dola-{account_id}.txt"):
        path = cookie_pool / name
        if path.is_file():
            candidates.append(path)
    profile = profiles_dir / account_id
    if profile.is_dir():
        for path in (
            profile / "EBWebView" / "Default" / "Network" / "Cookies",
            profile / "Default" / "Network" / "Cookies",
            profile / "Cookies",
        ):
            if path.is_file():
                candidates.append(path)
    bits = []
    for path in candidates:
        try:
            stat = path.stat()
            bits.append(f"{path}:{stat.st_size}:{stat.st_mtime_ns}")
        except OSError:
            pass
    return "|".join(sorted(bits))


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _append_log(path: Path, text: str) -> None:
    with path.open("a", encoding="utf-8", errors="replace") as handle:
        handle.write(text)
        if text and not text.endswith("\n"):
            handle.write("\n")


def _redact_log(text: str) -> str:
    """Keep URL hosts/paths useful while removing signed query parameters."""
    import re

    return re.sub(r"(https?://[^/\s?\"']+)[^\s\"']*\?[^\s\"']+", r"\1/<redacted>", text)


def _public_source_url(url: str) -> str:
    parts = urlsplit(str(url or ""))
    return urlunsplit((parts.scheme, parts.netloc, "/<redacted>", "", "")) if parts.scheme else ""


def _read_events(path: Path, seen: int) -> tuple[list[dict], int]:
    if not path.is_file():
        return [], seen
    lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    events: list[dict] = []
    for line in lines[seen:]:
        try:
            value = json.loads(line)
            if isinstance(value, dict):
                events.append(value)
        except ValueError:
            continue
    return events, len(lines)


class Worker:
    def __init__(
        self,
        *,
        db_path: Path,
        concurrency: int = 3,
        profiles_dir: Path = DEFAULT_PROFILES,
        cookie_pool: Path = DEFAULT_COOKIE_POOL,
        once: bool = False,
    ):
        self.store = JobStore(db_path)
        self.concurrency = max(1, int(concurrency))
        self.profiles_dir = Path(profiles_dir).resolve()
        self.cookie_pool = Path(cookie_pool).resolve()
        self.once = once
        self.worker_id = f"{os.getpid()}-{uuid.uuid4().hex[:8]}"
        self.stop = threading.Event()

    def run(self) -> int:
        if not self.store.register_worker(self.worker_id, os.getpid(), self.concurrency):
            return 0
        futures: dict[Future, str] = {}
        with ThreadPoolExecutor(max_workers=self.concurrency, thread_name_prefix="dola-job") as executor:
            idle_rounds = 0
            while not self.stop.is_set():
                if self.store.heartbeat_worker(self.worker_id):
                    self.stop.set()
                for future in list(futures):
                    if future.done():
                        job_id = futures.pop(future)
                        try:
                            future.result()
                        except Exception as exc:
                            try:
                                self.store.fail(job_id, f"worker exception: {exc}", state="needs_review")
                            except Exception:
                                pass
                claimed = False
                accounts = discover_accounts(self.profiles_dir, self.cookie_pool)
                for account_id in accounts:
                    self.store.refresh_account_health(
                        account_id,
                        _account_fingerprint(account_id, self.profiles_dir, self.cookie_pool),
                    )
                while len(futures) < self.concurrency and not self.stop.is_set():
                    job = self.store.reserve_next(
                        accounts,
                        self.worker_id,
                        global_limit=self.concurrency,
                    )
                    if not job:
                        break
                    claimed = True
                    future = executor.submit(self._run_job, job)
                    futures[future] = job["job_id"]
                idle_rounds = 0 if claimed or futures else idle_rounds + 1
                if self.once and not futures and idle_rounds >= 2:
                    break
                time.sleep(1.0)
            while futures:
                for future in list(futures):
                    if future.done():
                        futures.pop(future)
                if futures:
                    time.sleep(0.5)
        return 0

    def _run_job(self, job: dict) -> None:
        job_id = job["job_id"]
        out_dir = Path(job["output_dir"])
        out_dir.mkdir(parents=True, exist_ok=True)
        log_file = out_dir / "worker.log"
        event_file = Path(job["event_file"])
        refs = json.loads(job["refs_json"] or "[]")
        command = [
            sys.executable,
            str(Path(os.environ.get("DOLA_INJECT_SHELL") or INJECT_SHELL)),
            "--account",
            job["account_id"],
            "--profiles",
            str(self.profiles_dir),
            "--auto",
            "--close",
            "--prompt",
            job["prompt"],
            "--duration",
            str(job["duration"]),
            "--aspect-ratio",
            job["aspect_ratio"],
            "--timeout",
            str(job["timeout_seconds"]),
            "--out",
            str(out_dir),
            "--log-dir",
            str(out_dir),
        ]
        if job["model"]:
            command.extend(["--model", job["model"]])
        for ref in refs:
            command.extend(["--file", str(ref["file"])])
        env = os.environ.copy()
        env.update(
            {
                "DOLA_JOB_MANAGED": "1",
                "DOLA_JOB_ID": job_id,
                "DOLA_JOB_EVENT_FILE": str(event_file),
                "DOLA_ACCOUNT_POOL": str(self.cookie_pool),
                "PYTHONUTF8": "1",
                "PYTHONIOENCODING": "utf-8",
            }
        )
        creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0
        self.store.set_submitting(job_id)
        _append_log(log_file, f"[{now_iso()}] start account={job['account_id']} duration={job['duration']}s")
        process = subprocess.Popen(
            command,
            cwd=str(ROOT),
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            creationflags=creationflags,
        )
        output_chunks: list[str] = []

        def drain() -> None:
            assert process.stdout is not None
            for line in process.stdout:
                output_chunks.append(line)
                _append_log(log_file, _redact_log(line))

        drain_thread = threading.Thread(target=drain, daemon=True)
        drain_thread.start()
        seen_events = 0
        submitted = False
        result_event: dict[str, Any] | None = None
        generated_event: dict[str, Any] | None = None
        while process.poll() is None:
            self.store.heartbeat_lease(job_id, self.worker_id)
            events, seen_events = _read_events(event_file, seen_events)
            for event in events:
                if event.get("type") == "submitted" and not submitted:
                    self.store.mark_submitted(job_id, event)
                    submitted = True
                if event.get("type") == "result":
                    result_event = event
                if event.get("type") == "generated":
                    generated_event = event
                    if not submitted:
                        self.store.mark_submitted(job_id, event)
                        submitted = True
                    self.store.mark_generated(job_id, event)
            if self.stop.is_set() and not submitted:
                process.terminate()
            time.sleep(2.0)
        drain_thread.join(timeout=5)
        if process.stdout is not None:
            process.stdout.close()
        events, _ = _read_events(event_file, seen_events)
        for event in events:
            if event.get("type") == "submitted" and not submitted:
                self.store.mark_submitted(job_id, event)
                submitted = True
            if event.get("type") == "result":
                result_event = event
            if event.get("type") == "generated":
                generated_event = event
                if not submitted:
                    self.store.mark_submitted(job_id, event)
                    submitted = True
                self.store.mark_generated(job_id, event)

        recovered_path: Path | None = None
        if process.returncode != 0:
            tail = "".join(output_chunks)[-3000:]
            timed_out = "TimeoutError" in tail or "no video URL within" in tail
            cookie_error = any(token in tail.lower() for token in (
                "cookie invalid", "cookie has expired", "cookie import failed",
                "no live dola session cookie", "login looks active=false",
            ))
            if cookie_error:
                self.store.set_account_health(
                    job["account_id"],
                    False,
                    "cookie-invalid",
                    _account_fingerprint(job["account_id"], self.profiles_dir, self.cookie_pool),
                )
            if generated_event and not cookie_error:
                recovered_path = out_dir / f"{job_id}.mp4"
                direct_url = str(generated_event.get("url") or "")
                if direct_url:
                    for attempt in range(1, 4):
                        try:
                            download_url(direct_url, recovered_path)
                            _append_log(log_file, f"[{now_iso()}] direct download recovery succeeded attempt={attempt}")
                            result_event = {**generated_event, "file": str(recovered_path)}
                            break
                        except Exception as exc:
                            _append_log(log_file, f"[{now_iso()}] direct download recovery {attempt}/3: {type(exc).__name__}")
                            time.sleep(attempt * 2)
                for attempt in range(1, 4):
                    if recovered_path.is_file():
                        break
                    if not (generated_event.get("vid") or generated_event.get("messageId")):
                        break
                    recovery = subprocess.run(
                        [
                            sys.executable,
                            str(ROOT / "recover_download.py"),
                            "--account",
                            job["account_id"],
                            "--profiles",
                            str(self.profiles_dir),
                            "--session-url",
                            str(generated_event.get("sessionUrl") or ""),
                            "--message-id",
                            str(generated_event.get("messageId") or ""),
                            "--vid",
                            str(generated_event.get("vid") or ""),
                            "--out",
                            str(recovered_path),
                        ],
                        cwd=str(ROOT),
                        capture_output=True,
                        text=True,
                        encoding="utf-8",
                        errors="replace",
                        timeout=180,
                        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0,
                    )
                    _append_log(log_file, f"[{now_iso()}] download recovery {attempt}/3 exit={recovery.returncode}")
                    if recovery.returncode == 0 and recovered_path.is_file():
                        result_event = {**generated_event, "file": str(recovered_path)}
                        break
                    time.sleep(attempt * 2)
                if not recovered_path.is_file():
                    recovered_path = None
            if recovered_path is None:
                self.store.fail(
                    job_id,
                    tail or f"inject shell exited {process.returncode}",
                    state="timed_out" if timed_out else (
                        "generated_pending_download" if generated_event else ("needs_review" if submitted else "failed")
                    ),
                    retry=not submitted,
                )
                return

        payload = result_event or {}
        generated = recovered_path or Path(str(payload.get("file") or ""))
        if not generated.is_file():
            candidates = sorted(
                [p for p in out_dir.glob("*") if p.suffix.lower() in {".mp4", ".webm", ".mov", ".m4v"}],
                key=lambda p: p.stat().st_mtime,
                reverse=True,
            )
            generated = candidates[0] if candidates else Path()
        if not generated.is_file():
            self.store.fail(job_id, "generation exited successfully but no video file was found",
                            state="generated_pending_download" if submitted else "failed")
            return
        if not submitted:
            # A concrete generated artifact proves that the request was accepted,
            # even if the composer-cleared event was lost during a page reload.
            self.store.mark_submitted(job_id, result_event or {})
            submitted = True
        final_file = out_dir / f"{job_id}{generated.suffix.lower() or '.mp4'}"
        if generated.resolve() != final_file.resolve():
            if final_file.exists():
                final_file.unlink()
            generated.replace(final_file)
        digest = _sha256(final_file)
        ffprobe = None if os.environ.get("DOLA_SKIP_FFPROBE") == "1" else shutil.which("ffprobe")
        if ffprobe:
            probe = subprocess.run(
                [ffprobe, "-v", "error", "-show_entries", "format=duration", "-of", "json", str(final_file)],
                capture_output=True,
                text=True,
                timeout=30,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0,
            )
            if probe.returncode != 0:
                self.store.fail(job_id, f"ffprobe rejected downloaded video: {probe.stderr[-1000:]}",
                                state="generated_pending_download")
                return
        current = self.store.get(job_id)
        result = {
            "version": 1,
            "jobId": job_id,
            "prompt": job["prompt"],
            "accountId": job["account_id"],
            "duration": int(job["duration"]),
            "creditCost": int(job["credit_cost"]),
            "aspectRatio": job["aspect_ratio"],
            "model": job["model"],
            "createdAt": current["createdAt"],
            "submittedAt": current["submittedAt"],
            "completedAt": now_iso(),
            "sessionUrl": str(payload.get("sessionUrl") or current["sessionUrl"] or ""),
            "messageId": str(payload.get("messageId") or current["messageId"] or ""),
            "vid": clean_vid(payload.get("vid") or current["vid"]),
            "sourceUrl": _public_source_url(str(payload.get("url") or "")),
            "outputFile": str(final_file),
            "size": final_file.stat().st_size,
            "sha256": digest,
            "references": refs,
        }
        manifest = out_dir / "result.json"
        result["manifestFile"] = str(manifest)
        manifest.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        self.store.finish(job_id, {**result, "url": str(payload.get("url") or "")})
        try:
            event_file.unlink(missing_ok=True)
        except OSError:
            pass


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Dola durable video job worker")
    parser.add_argument("--db", default=str(DEFAULT_DB))
    parser.add_argument("--concurrency", type=int, default=3)
    parser.add_argument("--profiles", default=str(DEFAULT_PROFILES))
    parser.add_argument("--account-pool", default=str(DEFAULT_COOKIE_POOL))
    parser.add_argument("--once", action="store_true")
    args = parser.parse_args(argv)
    return Worker(
        db_path=Path(args.db),
        concurrency=args.concurrency,
        profiles_dir=Path(args.profiles),
        cookie_pool=Path(args.account_pool),
        once=args.once,
    ).run()


if __name__ == "__main__":
    raise SystemExit(main())
