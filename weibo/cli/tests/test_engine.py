import tempfile
import unittest
from datetime import datetime, timedelta
from pathlib import Path

import test_support  # noqa: F401

from weibo_cli.auth import AuthContext
from weibo_cli.engine import SearchBlockedError, SearchEngine, randomized_delay
from weibo_cli.models import SearchOptions
from weibo_cli.models import SearchWindow
from weibo_cli.storage import RunStore


def card(mid):
    return f"""<div class='card-wrap' mid='{mid}'><div class='info'><a href='/u/1' nick-name='u'>u</a></div><p class='txt'>text {mid}</p><div class='from'><a href='/u/1/{mid}'>2024-01-01 12:00</a><a>web</a></div></div>"""


class FakeFetcher:
    def __init__(self):
        self.urls = []

    def fetch(self, url):
        self.urls.append(url)
        return {"text": "<ul class='s-scroll'><li>x</li></ul>" + card("1") + card("1") + card("2"), "url": url}


class BlockedFetcher:
    def fetch(self, url):
        return {"text": "请输入验证码", "url": url}


class SaturatedFetcher:
    def fetch(self, url):
        pages = "<ul class='s-scroll'>" + "".join("<li>x</li>" for _ in range(46)) + "</ul>"
        return {"text": pages + card("1"), "url": url}


class EngineTests(unittest.TestCase):
    def test_default_transport_is_scrapy_and_delay_is_bounded(self):
        engine = SearchEngine(SearchOptions("x", delay=10), AuthContext("SUB=x", "test"), fetcher=FakeFetcher())
        # Explicit fetchers remain injectable, while the production default is
        # asserted without making a network request.
        from weibo_cli.scrapy_transport import ScrapyFetcher

        default = SearchEngine(SearchOptions("x", delay=10), AuthContext("SUB=x", "test"))
        self.assertIsInstance(default.fetcher, ScrapyFetcher)
        self.assertEqual(randomized_delay(10, random_fn=lambda: 0), 5)
        self.assertEqual(randomized_delay(10, random_fn=lambda: 1), 15)

    def test_default_limit_and_sqlite_dedup(self):
        with tempfile.TemporaryDirectory() as temp:
            fetcher = FakeFetcher()
            run = SearchEngine(SearchOptions("x", limit=10, delay=0), AuthContext("SUB=x", "test"), fetcher=fetcher, output_dir=Path(temp)).run()
            self.assertEqual(run.count, 2)
            self.assertTrue((Path(temp) / "results.jsonl").exists())
            self.assertTrue((Path(temp) / "results.csv").exists())
            self.assertTrue((Path(temp) / "state.sqlite3").exists())

    def test_finite_limit_is_not_partial_only_because_search_is_saturated(self):
        with tempfile.TemporaryDirectory() as temp:
            run = SearchEngine(SearchOptions("x", limit=1, delay=0), AuthContext("SUB=x", "test"), fetcher=SaturatedFetcher(), output_dir=Path(temp)).run()
            self.assertEqual(run.count, 1)
            self.assertFalse(run.partial)

    def test_resume_counts_existing_records_and_pending_windows(self):
        with tempfile.TemporaryDirectory() as temp:
            first = SearchEngine(SearchOptions("x", limit=10, delay=0), AuthContext("SUB=x", "test"), fetcher=FakeFetcher(), output_dir=Path(temp)).run()
            self.assertEqual(first.count, 2)
            second = SearchEngine(SearchOptions("x", limit=10, delay=0, resume_dir=temp), AuthContext("SUB=x", "test"), fetcher=FakeFetcher(), output_dir=Path(temp)).run()
            self.assertEqual(second.count, 2)
            self.assertEqual(len((Path(temp) / "results.jsonl").read_text(encoding="utf-8").splitlines()), 2)

    def test_resume_recovers_child_windows_saved_when_parent_split(self):
        with tempfile.TemporaryDirectory() as temp:
            parent = SearchWindow(datetime(2026, 1, 1), datetime(2026, 1, 2), "range")
            child = SearchWindow(datetime(2026, 1, 1), datetime(2026, 1, 2), "day")
            with RunStore(temp) as store:
                store.save_window(parent.key, "split", detail="threshold", window=parent, children=[child])
            with RunStore(temp, resume=True) as store:
                recovered = store.resume_windows()
            self.assertEqual([window.key for window in recovered], [child.key])

    def test_blocked_page_writes_checkpoint_without_cookie_values(self):
        with tempfile.TemporaryDirectory() as temp:
            with self.assertRaises(SearchBlockedError):
                SearchEngine(SearchOptions("x", delay=0), AuthContext("SUB=secret", "test"), fetcher=BlockedFetcher(), output_dir=Path(temp)).run()
            self.assertTrue((Path(temp) / "checkpoint.json").exists())
            manifest = (Path(temp) / "manifest.json").read_text(encoding="utf-8")
            self.assertNotIn("secret", manifest)


if __name__ == "__main__":
    unittest.main()
