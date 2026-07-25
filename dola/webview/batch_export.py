# -*- coding: utf-8 -*-
"""Export all not-yet-exported Google accounts through one WebView session at a time."""
from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path

from login_flow import parse_accounts_file

ROOT = Path(__file__).resolve().parent
DEFAULT_ACCOUNTS = ROOT.parent / "google_mail.txt"
DEFAULT_OUT = Path(r"G:\cookies\dola")
SHELL = ROOT / "dola_webview.py"


def account_id_from_email(email: str) -> str:
    local = email.split("@", 1)[0].strip()
    return re.sub(r"[^a-zA-Z0-9._-]+", "_", local)[:48] or "user"


def exported_cookie(out_dir: Path, account_id: str) -> Path | None:
    path = out_dir / f"dola_{account_id}.txt"
    return path if path.is_file() and path.stat().st_size > 0 else None


def parse_args(argv: list[str]) -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Sequentially export Google accounts not already in the cookie directory")
    p.add_argument("--accounts", default=str(DEFAULT_ACCOUNTS), help="email|password account file (default: ../google_mail.txt)")
    p.add_argument("--out", default=str(DEFAULT_OUT), help="Cookie export directory")
    p.add_argument("--profiles", default=str(ROOT / "profiles"), help="WebView profile directory")
    p.add_argument("--login-timeout", type=float, default=300, help="Per-account login timeout in seconds")
    p.add_argument(
        "--account-timeout",
        type=float,
        default=None,
        help="Hard per-account watchdog in seconds (default: login timeout + 90)",
    )
    p.add_argument("--force", action="store_true", help="Also process accounts that already have cookie files")
    p.add_argument("--dry-run", action="store_true", help="Only print the accounts that would be processed")
    return p.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    accounts_file = Path(args.accounts).resolve()
    out_dir = Path(args.out)
    rows = parse_accounts_file(str(accounts_file))
    out_dir.mkdir(parents=True, exist_ok=True)
    account_timeout = args.account_timeout or max(float(args.login_timeout) + 90.0, 360.0)

    pending: list[tuple[int, str, str | None]] = []
    skipped = 0
    for index, (email, _password) in enumerate(rows):
        account_id = account_id_from_email(email)
        existing = exported_cookie(out_dir, account_id)
        if existing and not args.force:
            skipped += 1
            print(f"[batch-export] skip index={index} account={account_id}: {existing}", flush=True)
        else:
            pending.append((index, account_id, str(existing) if existing else None))

    print(f"[batch-export] accounts={len(rows)} pending={len(pending)} skipped={skipped} out={out_dir}", flush=True)
    if args.dry_run:
        for index, account_id, existing in pending:
            suffix = " (force re-export)" if existing else ""
            print(f"[batch-export] would run index={index} account={account_id}{suffix}", flush=True)
        return 0

    failed = 0
    for index, account_id, _existing in pending:
        print(f"[batch-export] start index={index} account={account_id}", flush=True)
        cmd = [
            sys.executable, str(SHELL), "--accounts", str(accounts_file), "--index", str(index),
            "--profiles", str(Path(args.profiles)), "--out", str(out_dir),
            "--auto-login", "--auto-export", "--close-after-export",
            "--login-timeout", str(args.login_timeout),
        ]
        process = subprocess.Popen(cmd, cwd=str(ROOT))
        try:
            exit_code = process.wait(timeout=account_timeout)
        except subprocess.TimeoutExpired:
            # pywebview starts a helper Python process on Windows. Kill the whole
            # process tree so an unresponsive page cannot block the remaining
            # accounts indefinitely.
            print(
                f"[batch-export] timeout index={index} account={account_id} after {account_timeout:.0f}s; stopping WebView tree",
                flush=True,
            )
            subprocess.run(
                ["taskkill", "/PID", str(process.pid), "/T", "/F"],
                check=False,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            exit_code = process.wait()
        created = exported_cookie(out_dir, account_id)
        if exit_code or not created:
            failed += 1
            print(f"[batch-export] failed index={index} account={account_id} exit={exit_code}", flush=True)
        else:
            print(f"[batch-export] exported index={index} account={account_id}: {created}", flush=True)

    print(f"[batch-export] done exported={len(pending) - failed} failed={failed} skipped={skipped}", flush=True)
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
