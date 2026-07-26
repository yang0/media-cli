# -*- coding: utf-8 -*-
"""JSON-oriented command bridge used by the Node dola CLI."""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

from job_store import (
    DEFAULT_COOKIE_POOL,
    DEFAULT_DB,
    DEFAULT_JOBS_ROOT,
    DEFAULT_PROFILES,
    TERMINAL_STATES,
    JobStore,
    discover_accounts,
    file_sha256,
    now_iso,
)

ROOT = Path(__file__).resolve().parent


def emit(value) -> None:
    print(json.dumps(value, ensure_ascii=False, indent=2), flush=True)


def start_worker(store: JobStore, concurrency: int, account_pool: Path, profiles: Path) -> dict:
    alive = [item for item in store.worker_status() if item["alive"] and not item["stopRequested"]]
    if alive:
        return {"started": False, "workers": alive}
    command = [
        sys.executable,
        str(ROOT / "job_worker.py"),
        "--db",
        str(store.db_path),
        "--concurrency",
        str(concurrency),
        "--account-pool",
        str(account_pool),
        "--profiles",
        str(profiles),
    ]
    log_path = store.db_path.with_name("worker-bootstrap.log")
    log_path.parent.mkdir(parents=True, exist_ok=True)
    if log_path.is_file() and log_path.stat().st_size > 2 * 1024 * 1024:
        log_path.write_text("", encoding="utf-8")
    last_pid = 0
    for attempt in range(1, 3):
        previous_ids = {item["workerId"] for item in store.worker_status()}
        log_handle = log_path.open("a", encoding="utf-8")
        log_handle.write(f"\n[{now_iso()}] bootstrap attempt={attempt}\n")
        log_handle.flush()
        kwargs = {
            "cwd": str(ROOT),
            "env": {**os.environ, "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"},
            "stdin": subprocess.DEVNULL,
            "stdout": log_handle,
            "stderr": subprocess.STDOUT,
            "close_fds": True,
        }
        if os.name == "nt":
            kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.DETACHED_PROCESS | subprocess.CREATE_NO_WINDOW
        try:
            process = subprocess.Popen(command, **kwargs)
            last_pid = process.pid
        finally:
            log_handle.close()
        deadline = time.time() + 6
        stable_since = 0.0
        while time.time() < deadline:
            alive = [
                item for item in store.worker_status()
                if item["alive"] and not item["stopRequested"] and item["workerId"] not in previous_ids
            ]
            if alive:
                if not stable_since:
                    stable_since = time.time()
                if time.time() - stable_since >= 2:
                    return {
                        "started": True,
                        "pid": last_pid,
                        "workers": alive,
                        "logFile": str(log_path),
                        "attempt": attempt,
                    }
            else:
                stable_since = 0.0
            time.sleep(0.2)
    return {
        "started": False,
        "pid": last_pid,
        "workers": [],
        "logFile": str(log_path),
        "error": "worker failed both startup stability checks",
    }


def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Dola video job command bridge")
    p.add_argument("--db", default=str(DEFAULT_DB))
    p.add_argument("--account-pool", default=str(DEFAULT_COOKIE_POOL))
    p.add_argument("--profiles", default=str(DEFAULT_PROFILES))
    sub = p.add_subparsers(dest="resource", required=True)

    video = sub.add_parser("video")
    vc = video.add_subparsers(dest="action", required=True)
    for name in ("submit", "generate"):
        cmd = vc.add_parser(name)
        prompt_group = cmd.add_mutually_exclusive_group(required=True)
        prompt_group.add_argument("--prompt")
        prompt_group.add_argument("--prompt-file")
        cmd.add_argument("--duration", type=int, choices=[5, 10, 15], default=5)
        cmd.add_argument("--file", action="append", default=[])
        cmd.add_argument("--aspect-ratio", default="9:16")
        cmd.add_argument("--model", default="")
        cmd.add_argument("--request-id", default="")
        cmd.add_argument("--account", default="")
        cmd.add_argument("--allow-account-fallback", action="store_true")
        cmd.add_argument("--out-root", default=str(DEFAULT_JOBS_ROOT))
        cmd.add_argument("--timeout", default="30m")
        cmd.add_argument("--concurrency", type=int, default=3)
        cmd.add_argument("--no-auto-worker", action="store_true")
        if name == "generate":
            cmd.add_argument("--wait", action="store_true", help="Compatibility flag; generate always waits")
    status = vc.add_parser("status")
    status.add_argument("job_id")
    wait = vc.add_parser("wait")
    wait.add_argument("job_id")
    wait.add_argument("--timeout", default="35m")
    download = vc.add_parser("download")
    download.add_argument("job_id")
    download.add_argument("--out", required=True)

    jobs = sub.add_parser("jobs")
    jc = jobs.add_subparsers(dest="action", required=True)
    listing = jc.add_parser("list")
    listing.add_argument("--limit", type=int, default=50)
    cancel = jc.add_parser("cancel")
    cancel.add_argument("job_id")
    cancel.add_argument("--reason", default="cancelled by user")
    cleanup = jc.add_parser("cleanup")
    cleanup.add_argument("--request-prefix", default="")
    cleanup.add_argument("--reason", default="cancelled by jobs cleanup")
    cleanup.add_argument("--yes", action="store_true", help="Confirm bulk cancellation")

    pool = sub.add_parser("pool")
    pool.add_subparsers(dest="action", required=True).add_parser("status")

    worker = sub.add_parser("worker")
    wc = worker.add_subparsers(dest="action", required=True)
    start = wc.add_parser("start")
    start.add_argument("--concurrency", type=int, default=3)
    wc.add_parser("status")
    wc.add_parser("stop")

    account = sub.add_parser("account")
    ac = account.add_subparsers(dest="action", required=True)
    open_account = ac.add_parser("open", help="open one account's isolated WebView")
    open_account.add_argument("account_id")
    open_account.add_argument("--url", default="https://www.dola.com/chat")
    return p


def open_account_webview(account_id: str, profiles: Path, cookie_pool: Path, url: str) -> dict:
    """Open a visible WebView bound to one account's isolated profile."""
    account_id = str(account_id).strip()
    if not account_id or account_id in {".", ".."} or any(part in account_id for part in ("/", "\\", "\x00")):
        raise ValueError("invalid account id")
    profile = profiles / account_id
    profile.mkdir(parents=True, exist_ok=True)
    executable = Path(sys.executable)
    if os.name == "nt":
        pythonw = executable.with_name("pythonw.exe")
        if pythonw.exists():
            executable = pythonw
    command = [
        str(executable),
        str(ROOT / "dola_webview.py"),
        "--account", account_id,
        "--profiles", str(profiles),
        "--out", str(cookie_pool),
        "--url", str(url),
    ]
    kwargs = {
        "cwd": str(ROOT),
        "stdin": subprocess.DEVNULL,
        "stdout": subprocess.DEVNULL,
        "stderr": subprocess.DEVNULL,
        "close_fds": True,
    }
    if os.name == "nt":
        # Keep the WebView window visible while detaching it from the CLI.
        kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.DETACHED_PROCESS
    process = subprocess.Popen(command, **kwargs)
    return {
        "opened": True,
        "accountId": account_id,
        "pid": process.pid,
        "profileDir": str(profile),
        "url": str(url),
    }


def parse_seconds(value: str) -> int:
    text = str(value).strip().lower()
    factor = 1
    if text.endswith("ms"):
        return max(1, int(float(text[:-2]) / 1000))
    if text.endswith("s"):
        text = text[:-1]
    elif text.endswith("m"):
        text, factor = text[:-1], 60
    elif text.endswith("h"):
        text, factor = text[:-1], 3600
    number = int(float(text) * factor)
    if number < 1:
        raise ValueError("timeout must be positive")
    return number


def normalize_global_args(argv: list[str] | None) -> list[str] | None:
    """Allow global storage/account options before or after subcommands."""
    if argv is None:
        argv = sys.argv[1:]
    globals_out: list[str] = []
    rest: list[str] = []
    i = 0
    while i < len(argv):
        if argv[i] in {"--db", "--account-pool", "--profiles"}:
            if i + 1 >= len(argv):
                raise ValueError(f"missing value for {argv[i]}")
            globals_out.extend([argv[i], argv[i + 1]])
            i += 2
        else:
            rest.append(argv[i])
            i += 1
    return globals_out + rest


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(normalize_global_args(argv))
    store = JobStore(Path(args.db))
    account_pool = Path(args.account_pool)
    profiles = Path(args.profiles)
    if args.resource == "account" and args.action == "open":
        emit(open_account_webview(args.account_id, profiles, account_pool, args.url))
        return 0
    if args.resource == "video" and args.action in {"submit", "generate"}:
        prompt = args.prompt
        if args.prompt_file:
            prompt = Path(args.prompt_file).read_text(encoding="utf-8").strip()
        job, created = store.submit(
            prompt=prompt,
            duration=args.duration,
            refs=args.file,
            aspect_ratio=args.aspect_ratio,
            model=args.model,
            request_id=args.request_id,
            requested_account=args.account,
            allow_account_fallback=args.allow_account_fallback,
            jobs_root=Path(args.out_root),
            timeout_seconds=parse_seconds(args.timeout),
        )
        worker = None
        if not args.no_auto_worker:
            worker = start_worker(store, args.concurrency, account_pool, profiles)
        if args.action == "submit":
            emit({**job, "created": created, "worker": worker})
            return 0
        deadline = time.time() + parse_seconds(args.timeout) + 300
        while time.time() < deadline:
            job = store.get(job["jobId"])
            if job["state"] in TERMINAL_STATES:
                emit(job)
                return 0 if job["state"] == "succeeded" else 2
            time.sleep(2)
        emit(store.get(job["jobId"]))
        return 3
    if args.resource == "video" and args.action == "status":
        emit(store.get(args.job_id))
        return 0
    if args.resource == "video" and args.action == "wait":
        deadline = time.time() + parse_seconds(args.timeout)
        while time.time() < deadline:
            job = store.get(args.job_id)
            if job["state"] in TERMINAL_STATES:
                emit(job)
                return 0 if job["state"] == "succeeded" else 2
            time.sleep(2)
        emit(store.get(args.job_id))
        return 3
    if args.resource == "video" and args.action == "download":
        job = store.get(args.job_id)
        source = Path(job["outputFile"])
        if not source.is_file():
            if not job["accountId"] or not job["sessionUrl"] or not (job["vid"] or job["messageId"]):
                raise RuntimeError("job has no local video and lacks account/session/message metadata for recovery")
            source = Path(job["outputDir"]) / f"{job['jobId']}.mp4"
            command = [
                sys.executable,
                str(ROOT / "recover_download.py"),
                "--account",
                job["accountId"],
                "--profiles",
                str(profiles),
                "--session-url",
                job["sessionUrl"],
                "--message-id",
                job["messageId"],
                "--vid",
                job["vid"],
                "--out",
                str(source),
            ]
            recovered = subprocess.run(
                command,
                cwd=str(ROOT),
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0,
            )
            if recovered.returncode != 0 or not source.is_file():
                raise RuntimeError(f"video recovery failed: {(recovered.stdout or recovered.stderr)[-1000:]}")
            result = {
                "version": 1,
                "jobId": job["jobId"],
                "prompt": job["prompt"],
                "accountId": job["accountId"],
                "duration": job["duration"],
                "creditCost": job["creditCost"],
                "aspectRatio": job["aspectRatio"],
                "model": job["model"],
                "createdAt": job["createdAt"],
                "submittedAt": job["submittedAt"],
                "completedAt": now_iso(),
                "sessionUrl": job["sessionUrl"],
                "messageId": job["messageId"],
                "vid": job["vid"],
                "outputFile": str(source),
                "size": source.stat().st_size,
                "sha256": file_sha256(source),
            }
            manifest = Path(job["outputDir"]) / "result.json"
            result["manifestFile"] = str(manifest)
            manifest.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            job = store.finish(job["jobId"], result)
        target_dir = Path(args.out).resolve()
        target_dir.mkdir(parents=True, exist_ok=True)
        target = target_dir / source.name
        shutil.copy2(source, target)
        emit({**job, "downloadedFile": str(target)})
        return 0
    if args.resource == "jobs":
        if args.action == "list":
            emit({"jobs": store.list_jobs(args.limit)})
            return 0
        if args.action == "cancel":
            emit(store.cancel(args.job_id, args.reason))
            return 0
        if args.action == "cleanup":
            if not args.yes:
                raise ValueError("jobs cleanup requires --yes")
            cancelled = store.cleanup_unsubmitted(
                request_prefix=args.request_prefix,
                reason=args.reason,
            )
            emit({
                "cancelledCount": len(cancelled),
                "requestPrefix": args.request_prefix,
                "jobs": cancelled,
            })
            return 0
    if args.resource == "pool":
        emit({"accounts": store.pool_status(discover_accounts(profiles, account_pool))})
        return 0
    if args.resource == "worker" and args.action == "start":
        emit(start_worker(store, args.concurrency, account_pool, profiles))
        return 0
    if args.resource == "worker" and args.action == "status":
        emit({"workers": store.worker_status()})
        return 0
    if args.resource == "worker" and args.action == "stop":
        emit({"stopRequested": store.request_worker_stop()})
        return 0
    return 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        emit({"error": str(exc), "type": type(exc).__name__})
        raise SystemExit(1)
