"""Synchronous bridge to Scrapy for the CLI search transport.

Scrapy owns the real network request.  A short-lived worker process is used
per request because Twisted's reactor cannot be restarted in one Python
process.  This keeps the public search planner synchronous (and easy to test)
while ensuring the production CLI never silently falls back to ``requests``.
"""

from __future__ import annotations

import multiprocessing
from typing import Any

from .engine_types import FetchResponseProtocol


def _scrapy_worker(url: str, headers: dict[str, str], timeout: float, connection: Any) -> None:
    """Run one Scrapy request in a fresh process and send only safe response data."""

    try:
        import scrapy
        from scrapy.crawler import CrawlerProcess
        from scrapy.exceptions import CloseSpider

        class SingleRequestSpider(scrapy.Spider):
            name = "weibo_cli_single_request"

            custom_settings = {
                "LOG_ENABLED": False,
                "TELNETCONSOLE_ENABLED": False,
                "COOKIES_ENABLED": False,
                "DOWNLOAD_TIMEOUT": timeout,
                "ROBOTSTXT_OBEY": False,
                "CONCURRENT_REQUESTS": 1,
                "DOWNLOAD_DELAY": 0,
                "RANDOMIZE_DOWNLOAD_DELAY": True,
            }

            def _request(self):
                return scrapy.Request(url, headers=headers, callback=self.parse, errback=self.errback, dont_filter=True)

            async def start(self):
                """Scrapy 2.13+ entry point (``start_requests`` is no longer scheduled)."""

                yield self._request()

            def start_requests(self):
                """Compatibility entry point for older supported Scrapy releases."""

                yield self._request()

            def parse(self, response):
                connection.send({"ok": True, "text": response.text, "url": response.url, "status": response.status})
                raise CloseSpider("one request complete")

            def errback(self, failure):
                connection.send({"ok": False, "error": "Scrapy 请求失败"})
                raise CloseSpider("one request failed")

        process = CrawlerProcess(settings={
            "LOG_ENABLED": False,
            "TELNETCONSOLE_ENABLED": False,
            "COOKIES_ENABLED": False,
            "DOWNLOAD_TIMEOUT": timeout,
            "ROBOTSTXT_OBEY": False,
            "CONCURRENT_REQUESTS": 1,
            "DOWNLOAD_DELAY": 0,
            "RANDOMIZE_DOWNLOAD_DELAY": True,
        })
        process.crawl(SingleRequestSpider)
        process.start(stop_after_crawl=True)
    except Exception:
        try:
            connection.send({"ok": False, "error": "Scrapy 运行失败"})
        except Exception:
            pass
    finally:
        try:
            connection.close()
        except Exception:
            pass


class ScrapyFetcher:
    """Fetch one page through Scrapy while retaining a simple ``fetch`` API."""

    runtime = "scrapy"

    def __init__(self, auth: Any, *, timeout: float = 30, process_factory: Any | None = None):
        self.auth = auth
        self.timeout = float(timeout)
        self.process_factory = process_factory or multiprocessing.get_context("spawn").Process

    def fetch(self, url: str) -> FetchResponseProtocol:
        parent, child = multiprocessing.get_context("spawn").Pipe(duplex=False)
        process = self.process_factory(target=_scrapy_worker, args=(url, self.auth.headers, self.timeout, child))
        process.start()
        child.close()
        try:
            if not parent.poll(self.timeout + 10):
                process.terminate()
                process.join(timeout=5)
                raise RuntimeError("Scrapy 请求超时")
            payload = parent.recv()
        finally:
            parent.close()
            if process.is_alive():
                process.join(timeout=5)
        if not isinstance(payload, dict) or not payload.get("ok"):
            raise RuntimeError("Scrapy 请求失败")
        from .engine import FetchResponse

        return FetchResponse(str(payload.get("text", "")), str(payload.get("url", url)), int(payload.get("status", 200)))
