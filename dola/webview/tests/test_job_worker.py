from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path

WEBVIEW = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(WEBVIEW))

from job_store import JobStore  # noqa: E402
from job_worker import Worker  # noqa: E402


class JobWorkerTests(unittest.TestCase):
    def test_fake_webview_job_reaches_succeeded(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            profiles = root / "profiles"
            (profiles / "account-a").mkdir(parents=True)
            cookies = root / "cookies"
            cookies.mkdir()
            db = root / "jobs.sqlite3"
            store = JobStore(db)
            job, _ = store.submit(
                prompt="fake worker prompt",
                duration=15,
                jobs_root=root / "artifacts",
            )
            old_runner = os.environ.get("DOLA_INJECT_SHELL")
            old_probe = os.environ.get("DOLA_SKIP_FFPROBE")
            os.environ["DOLA_INJECT_SHELL"] = str(Path(__file__).with_name("fake_inject_shell.py"))
            os.environ["DOLA_SKIP_FFPROBE"] = "1"
            try:
                code = Worker(
                    db_path=db,
                    concurrency=3,
                    profiles_dir=profiles,
                    cookie_pool=cookies,
                    once=True,
                ).run()
            finally:
                if old_runner is None:
                    os.environ.pop("DOLA_INJECT_SHELL", None)
                else:
                    os.environ["DOLA_INJECT_SHELL"] = old_runner
                if old_probe is None:
                    os.environ.pop("DOLA_SKIP_FFPROBE", None)
                else:
                    os.environ["DOLA_SKIP_FFPROBE"] = old_probe
            self.assertEqual(code, 0)
            result = store.get(job["jobId"])
            self.assertEqual(result["state"], "succeeded")
            self.assertEqual(result["accountId"], "account-a")
            self.assertEqual(result["messageId"], "message-test")
            self.assertTrue(Path(result["outputFile"]).is_file())
            pool = store.pool_status(["account-a"])[0]
            self.assertEqual((pool["spent"], pool["reserved"]), (3, 0))


if __name__ == "__main__":
    unittest.main()
