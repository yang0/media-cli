import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from account_ranking import deduplicate_accounts, rank_accounts  # noqa: E402


class AccountRankingTests(unittest.TestCase):
    def setUp(self):
        self.accounts = [
            {
                "sec_uid": "small",
                "nickname": "小号",
                "followers": 1000,
                "likes": 10000,
                "search_rank": 2,
                "recent_posts": [{"digg": 100, "collect": 2, "share": 5, "comment": 3, "created_at": 1_700_000_000}],
            },
            {
                "sec_uid": "large",
                "nickname": "大号",
                "followers": 100000,
                "likes": 1000000,
                "search_rank": 1,
                "recent_posts": [{"digg": 200, "collect": 5, "share": 10, "comment": 8, "created_at": 1_700_000_000}],
            },
        ]

    def test_deduplicate_merges_richer_duplicate(self):
        rows = deduplicate_accounts([self.accounts[0], {**self.accounts[0], "followers": 2000}])
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["followers"], 2000)

    def test_hot_score_is_transparent_and_sortable(self):
        rows = rank_accounts(self.accounts, sort_by="hot")
        self.assertEqual(rows[0]["sec_uid"], "large")
        self.assertIn("score_breakdown", rows[0])
        self.assertEqual(rows[0]["score_breakdown"]["weights"]["followers"], 0.45)
        self.assertEqual(rows[0]["score_breakdown"]["weights"]["likes"], 0.35)

    def test_sort_modes(self):
        self.assertEqual(rank_accounts(self.accounts, sort_by="followers")[0]["sec_uid"], "large")
        self.assertEqual(rank_accounts(self.accounts, sort_by="likes")[0]["sec_uid"], "large")
        self.assertEqual(rank_accounts(self.accounts, sort_by="search")[0]["sec_uid"], "large")


if __name__ == "__main__":
    unittest.main()
