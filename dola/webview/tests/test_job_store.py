# -*- coding: utf-8 -*-
from __future__ import annotations

import sys
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch
from pathlib import Path

WEBVIEW = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(WEBVIEW))

from job_store import JobStore, day_key  # noqa: E402


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


if __name__ == "__main__":
    unittest.main()
