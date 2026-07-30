# -*- coding: utf-8 -*-
from __future__ import annotations

import sys
import tempfile
import unittest
import os
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch
from pathlib import Path

WEBVIEW = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(WEBVIEW))

from job_store import JobStore, day_key, pid_alive  # noqa: E402
from job_store import normalize_aspect_ratio  # noqa: E402


class JobStoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.store = JobStore(self.root / "jobs.sqlite3")
        self.jobs = self.root / "artifacts"

    def tearDown(self):
        self.temp.cleanup()

    def submit(self, request_id="", duration=5, account=""):
        return self.store.submit(
            prompt=f"prompt-{request_id or duration}",
            duration=duration,
            request_id=request_id,
            requested_account=account,
            jobs_root=self.jobs,
        )

    def test_request_id_is_idempotent(self):
        first, created = self.submit("same")
        second, created_again = self.submit("same")
        self.assertTrue(created)
        self.assertFalse(created_again)
        self.assertEqual(first["jobId"], second["jobId"])
        self.assertEqual(len(self.store.list_jobs()), 1)

    def test_supported_aspect_ratios_are_normalized(self):
        for ratio in ("9:16", "16:9", "1:1", "3:4", "4:3", "21:9"):
            self.assertEqual(normalize_aspect_ratio(ratio), ratio)
        self.assertEqual(normalize_aspect_ratio("21/9"), "21:9")
        with self.assertRaises(ValueError):
            normalize_aspect_ratio("2:3")

    def test_pid_alive_distinguishes_current_and_missing_process(self):
        self.assertTrue(pid_alive(os.getpid()))
        self.assertFalse(pid_alive(2_000_000_000))

    def test_three_concurrent_claims_have_unique_accounts(self):
        for index in range(5):
            self.submit(f"job-{index}")
        claimed = [
            self.store.reserve_next(["a", "b", "c", "d"], "worker")
            for _ in range(3)
        ]
        self.assertEqual(len({job["account_id"] for job in claimed}), 3)
        self.assertEqual(sum(1 for job in self.store.list_jobs() if job["state"] == "reserved"), 3)

    def test_two_store_instances_claim_atomically(self):
        for index in range(5):
            self.submit(f"parallel-{index}")
        stores = [JobStore(self.root / "jobs.sqlite3") for _ in range(5)]
        with ThreadPoolExecutor(max_workers=5) as executor:
            claims = list(executor.map(
                lambda item: item[1].reserve_next(["a", "b", "c"], f"worker-{item[0]}"),
                enumerate(stores),
            ))
        claimed = [job for job in claims if job]
        self.assertEqual(len(claimed), 3)
        self.assertEqual(len({job["job_id"] for job in claimed}), 3)
        self.assertEqual(len({job["account_id"] for job in claimed}), 3)

    def test_duration_credit_cost_and_release_before_submit(self):
        job, _ = self.submit("fifteen", duration=15)
        claimed = self.store.reserve_next(["a"], "worker")
        self.assertEqual(claimed["job_id"], job["jobId"])
        status = self.store.pool_status(["a"])[0]
        self.assertEqual((status["spent"], status["reserved"], status["remaining"]), (0, 3, 1))
        self.store.fail(job["jobId"], "pre-submit", retry=True)
        status = self.store.pool_status(["a"])[0]
        self.assertEqual((status["spent"], status["reserved"], status["remaining"]), (0, 0, 4))

    def test_confirmed_submit_commits_credit_and_does_not_refund(self):
        job, _ = self.submit("ten", duration=10)
        self.store.reserve_next(["a"], "worker")
        self.store.mark_submitted(job["jobId"], {"sessionUrl": "https://www.dola.com/chat/1"})
        self.store.fail(job["jobId"], "crash", state="needs_review")
        status = self.store.pool_status(["a"])[0]
        self.assertEqual((status["spent"], status["reserved"], status["remaining"]), (2, 0, 2))
        self.assertEqual(self.store.get(job["jobId"])["state"], "needs_review")

    def test_requested_account_waits_without_fallback(self):
        first, _ = self.submit("first", account="a")
        second, _ = self.submit("second", account="a")
        claimed = self.store.reserve_next(["a", "b"], "worker")
        self.assertEqual(claimed["job_id"], first["jobId"])
        self.assertIsNone(self.store.reserve_next(["a", "b"], "worker"))
        self.store.fail(first["jobId"], "release", retry=False)
        claimed = self.store.reserve_next(["a", "b"], "worker")
        self.assertEqual(claimed["job_id"], second["jobId"])
        self.assertEqual(claimed["account_id"], "a")

    def test_daily_rows_are_scoped_by_day(self):
        self.submit("today", duration=15)
        self.store.reserve_next(["a"], "worker")
        rows = self.store.pool_status(["a"])
        self.assertEqual(rows[0]["day"], day_key())
        self.assertEqual(rows[0]["reserved"], 3)

    def test_midnight_before_submit_moves_charge_to_submit_day(self):
        job, _ = self.submit("midnight", duration=10)
        self.store.reserve_next(["a"], "worker")
        reserved_day = day_key()
        submit_day = "2099-01-02"
        with patch("job_store.day_key", return_value=submit_day):
            self.store.mark_submitted(job["jobId"], {})
            status = self.store.pool_status(["a"])[0]
        with self.store.connect() as con:
            old = con.execute(
                "SELECT reserved,spent FROM account_daily WHERE day=? AND account_id='a'",
                (reserved_day,),
            ).fetchone()
            new = con.execute(
                "SELECT reserved,spent FROM account_daily WHERE day=? AND account_id='a'",
                (submit_day,),
            ).fetchone()
        self.assertEqual((old["reserved"], old["spent"]), (0, 0))
        self.assertEqual((new["reserved"], new["spent"]), (0, 2))

    def test_cleanup_by_request_prefix_cancels_and_releases_only_matching_jobs(self):
        first, _ = self.submit("angle-01", duration=15)
        second, _ = self.submit("angle-02", duration=15)
        keep, _ = self.submit("keep-this", duration=15)
        self.store.reserve_next(["a", "b"], "worker")
        self.store.reserve_next(["a", "b"], "worker")
        cancelled = self.store.cleanup_unsubmitted(request_prefix="angle-")
        self.assertEqual({job["jobId"] for job in cancelled}, {first["jobId"], second["jobId"]})
        self.assertEqual(self.store.get(keep["jobId"])["state"], "queued")
        pool = self.store.pool_status(["a", "b"])
        self.assertTrue(all(item["reserved"] == 0 and item["busyJobId"] == "" for item in pool))

    def test_cancel_after_submit_does_not_refund_spent_credit(self):
        job, _ = self.submit("submitted-cancel", duration=10)
        self.store.reserve_next(["a"], "worker")
        self.store.mark_submitted(job["jobId"], {})
        cancelled = self.store.cancel(job["jobId"])
        self.assertEqual(cancelled["state"], "cancelled")
        usage = self.store.pool_status(["a"])[0]
        self.assertEqual((usage["spent"], usage["reserved"]), (2, 0))

    def test_job_list_hides_cancelled_unless_requested(self):
        visible, _ = self.submit("visible")
        hidden, _ = self.submit("hidden")
        self.store.cancel(hidden["jobId"])
        self.assertEqual(
            [job["jobId"] for job in self.store.list_jobs()],
            [visible["jobId"]],
        )
        all_ids = {job["jobId"] for job in self.store.list_jobs(include_cancelled=True)}
        self.assertEqual(all_ids, {visible["jobId"], hidden["jobId"]})
        cancelled = self.store.list_jobs(states=["cancelled"])
        self.assertEqual([job["jobId"] for job in cancelled], [hidden["jobId"]])

    def test_prune_is_preview_first_and_removes_cancelled_artifacts(self):
        job, _ = self.submit("old-cancelled")
        output_dir = Path(job["outputDir"])
        self.store.cancel(job["jobId"])
        with self.store.connect() as con:
            con.execute(
                "UPDATE jobs SET created_at=?,updated_at=?,completed_at=? WHERE job_id=?",
                ("2000-01-01T00:00:00.000+00:00",) * 3 + (job["jobId"],),
            )
        preview = self.store.prune_jobs(older_than_seconds=1)
        self.assertTrue(preview["dryRun"])
        self.assertEqual(preview["matchedCount"], 1)
        self.assertTrue(output_dir.is_dir())
        self.assertEqual(self.store.get(job["jobId"])["state"], "cancelled")

        applied = self.store.prune_jobs(older_than_seconds=1, apply=True)
        self.assertFalse(applied["dryRun"])
        self.assertEqual((applied["deletedCount"], applied["deletedFilesCount"]), (1, 1))
        self.assertFalse(output_dir.exists())
        with self.assertRaises(KeyError):
            self.store.get(job["jobId"])


if __name__ == "__main__":
    unittest.main()
