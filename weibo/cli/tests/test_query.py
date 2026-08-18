import unittest
from datetime import datetime

import test_support  # noqa: F401

from weibo_cli.models import SearchOptions, SearchWindow
from weibo_cli.query import QueryValidationError, build_search_url, encode_query, initial_windows, split_day_windows, split_hour_windows, validate_options
from weibo_cli.windows import decide_window


class QueryTests(unittest.TestCase):
    def test_combination_and_topic_encoding(self):
        self.assertEqual(encode_query("人工智能 机器人"), "%E4%BA%BA%E5%B7%A5%E6%99%BA%E8%83%BD%20%E6%9C%BA%E5%99%A8%E4%BA%BA")
        self.assertEqual(encode_query("#人工智能#"), "%23人工智能%23")

    def test_filters_region_and_scope_match_reference_mapping(self):
        options = SearchOptions("财经", weibo_type="hot", contains="video", region="北京", start="2026-08-01", end="2026-08-01")
        url = build_search_url("财经", options=options, window=initial_windows(options)[0])
        self.assertIn("xsort=hot", url)
        self.assertIn("hasvideo=1", url)
        self.assertIn("region=custom:11:1000", url)
        self.assertIn("timescope=custom:2026-08-01-0:2026-08-02-0", url)

    def test_date_pair_and_order_validation(self):
        with self.assertRaises(QueryValidationError):
            validate_options(SearchOptions("x", start="2026-01-01"))
        with self.assertRaises(QueryValidationError):
            validate_options(SearchOptions("x", start="2026-01-02", end="2026-01-01"))

    def test_day_and_hour_refinement(self):
        window = SearchWindow(datetime(2026, 1, 1), datetime(2026, 1, 3), "range")
        days = split_day_windows(window)
        self.assertEqual(len(days), 2)
        self.assertEqual(len(split_hour_windows(days[0])), 24)
        self.assertEqual(decide_window(window, 46).action, "split-day")
        self.assertEqual(decide_window(days[0], 46).action, "split-hour")
        self.assertTrue(decide_window(split_hour_windows(days[0])[0], 46).partial)


if __name__ == "__main__":
    unittest.main()
