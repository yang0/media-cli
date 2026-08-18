import asyncio
import contextlib
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import account_search  # noqa: E402


class AccountSearchTests(unittest.TestCase):
    def test_build_search_url_is_user_search_only(self):
        self.assertEqual(
            account_search.build_search_url("财经 账号"),
            "https://www.douyin.com/search/%E8%B4%A2%E7%BB%8F%20%E8%B4%A6%E5%8F%B7?type=user",
        )

    def test_run_search_writes_only_search_outputs(self):
        async def fake_searcher(query, **kwargs):
            return [
                {"sec_uid": "one", "nickname": "甲", "followers": 1000, "search_rank": 1},
                {"sec_uid": "two", "nickname": "乙", "followers": 500, "search_rank": 2},
            ]

        with tempfile.TemporaryDirectory() as temp:
            output = account_search.run_search(
                "财经",
                limit=10,
                top=2,
                output_dir=temp,
                searcher=fake_searcher,
            )
            self.assertTrue((output / "accounts.json").exists())
            self.assertTrue((output / "accounts.csv").exists())
            self.assertTrue((output / "report.md").exists())
            self.assertFalse(list(output.rglob("*.png")))
            data = json.loads((output / "accounts.json").read_text(encoding="utf-8"))
            self.assertEqual(len(data["accounts"]), 2)
            self.assertNotIn("recent_posts", data["accounts"][0])
            self.assertNotIn("recent_engagement_median", data["accounts"][0])
            report = (output / "report.md").read_text(encoding="utf-8")
            self.assertNotIn("近期作品互动", report)

    def test_cli_exposes_only_search_card_sort_modes(self):
        parser = account_search.build_parser()
        args = parser.parse_args(["财经", "--sort", "likes"])
        self.assertEqual(args.sort_by, "likes")
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            parser.parse_args(["财经", "--sort", "engagement"])


if __name__ == "__main__":
    unittest.main()
