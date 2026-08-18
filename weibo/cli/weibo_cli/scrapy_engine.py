"""Optional Scrapy adapter for the modular search planner.

The normal CLI uses :class:`~weibo_cli.engine.SearchEngine`, which keeps
offline tests and minimal installations usable.  Projects embedding this
package can use ``ScrapySearchSpider`` to feed the same parser and records into
their own Scrapy pipelines; no legacy database/image pipelines are enabled.
"""

from __future__ import annotations

from typing import Any

from .models import SearchOptions, SearchWindow
from .parser import parse_search_page
from .query import build_search_url


try:
    import scrapy
except ImportError:  # pragma: no cover - exercised only without optional dep
    scrapy = None


if scrapy is not None:

    class ScrapySearchSpider(scrapy.Spider):
        name = "weibo_cli_search"
        allowed_domains = ["s.weibo.com", "weibo.com"]

        def __init__(self, options: SearchOptions, *, window: SearchWindow | None = None, cookie: str = "", **kwargs: Any):
            super().__init__(**kwargs)
            self.options = options
            self.window = window
            self.cookie = cookie

        def _request(self):
            url = build_search_url(self.options.query, options=self.options, window=self.window)
            headers = {"Cookie": self.cookie} if self.cookie else {}
            return scrapy.Request(url, headers=headers, callback=self.parse)

        async def start(self):
            yield self._request()

        def start_requests(self):
            yield self._request()

        def parse(self, response):
            page = parse_search_page(response.text, query=self.options.query, source_url=response.url)
            for item in page["items"]:
                yield item
            if page.get("next_url"):
                yield scrapy.Request(page["next_url"], headers={"Cookie": self.cookie} if self.cookie else {}, callback=self.parse)

else:

    class ScrapySearchSpider:  # type: ignore[no-redef]
        """Import-safe placeholder when Scrapy is not installed."""

        name = "weibo_cli_search"

        def __init__(self, *args: Any, **kwargs: Any):
            raise RuntimeError("Scrapy 未安装；请运行 pip install -e .")
