"""Search orchestration shared by the CLI and programmatic callers."""

from __future__ import annotations

import random
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping

from .auth import AuthContext
from .models import SearchOptions, SearchWindow
from .parser import ParseError, normalise_record, parse_search_page
from .query import QueryValidationError, build_search_url, initial_windows, validate_options
from .storage import RunStore, default_search_dir, options_manifest
from .windows import WindowDecision, decide_window
from .scrapy_transport import ScrapyFetcher


def randomized_delay(base: float, *, random_fn: Callable[[], float] = random.random) -> float:
    """Return Scrapy-compatible bounded jitter in the range [0.5x, 1.5x]."""

    if base <= 0:
        return 0.0
    sample = min(1.0, max(0.0, float(random_fn())))
    return float(base) * (0.5 + sample)


class SearchError(RuntimeError):
    """A non-recoverable search error (authentication or page parsing)."""


class SearchBlockedError(SearchError):
    """Weibo requested login, CAPTCHA, or a frequency verification."""


@dataclass(frozen=True)
class FetchResponse:
    text: str
    url: str
    status: int = 200


@dataclass(frozen=True)
class SearchRun:
    output_dir: Path
    count: int
    partial: bool
    truncated_windows: tuple[str, ...]


class RequestsFetcher:
    """Default HTTP fetcher; cookies are held in memory only."""

    def __init__(self, auth: AuthContext, *, timeout: float = 30):
        self.auth = auth
        self.timeout = timeout
        try:
            import requests

            self.session = requests.Session()
            self.session.headers.update(auth.headers)
        except ImportError as exc:
            raise SearchError("搜索需要 requests；请先安装项目依赖") from exc

    def fetch(self, url: str) -> FetchResponse:
        try:
            response = self.session.get(url, timeout=self.timeout)
        except Exception as exc:
            raise SearchError("请求微博搜索页失败") from exc
        if response.status_code in {401, 403, 418, 429}:
            raise SearchBlockedError(f"微博请求被限制（HTTP {response.status_code}），已停止以保留检查点")
        return FetchResponse(response.text, response.url, response.status_code)


def _coerce_fetch_response(value: Any, *, requested_url: str) -> FetchResponse:
    if isinstance(value, FetchResponse):
        return value
    if isinstance(value, str):
        return FetchResponse(value, requested_url)
    if isinstance(value, Mapping):
        return FetchResponse(str(value.get("text", value.get("body", ""))), str(value.get("url", requested_url)), int(value.get("status", 200)))
    if hasattr(value, "text"):
        return FetchResponse(str(value.text), str(getattr(value, "url", requested_url)), int(getattr(value, "status_code", 200)))
    raise SearchError("搜索 fetcher 返回了不支持的响应类型")


class SearchEngine:
    """Threshold-aware search engine with resumable SQLite state."""

    def __init__(
        self,
        options: SearchOptions,
        auth: AuthContext,
        *,
        fetcher: Any | None = None,
        output_dir: str | Path | None = None,
        sleep: Callable[[float], None] = time.sleep,
    ):
        self.options = validate_options(options)
        self.auth = auth
        if fetcher is None:
            self.fetcher = ScrapyFetcher(auth)
        else:
            self.fetcher = fetcher
        self.output_dir = Path(output_dir or self.options.resume_dir or default_search_dir(self.options.query))
        self.sleep = sleep
        self.random_fn = random.random
        self._count = 0
        self._partial = False
        self._truncated: list[str] = []
        self._completed: list[str] = []
        self._pending: list[str] = []

    def _fetch(self, url: str) -> FetchResponse:
        try:
            target = self.fetcher.fetch(url) if hasattr(self.fetcher, "fetch") else self.fetcher(url)
        except SearchError:
            raise
        except Exception as exc:
            raise SearchError("Scrapy 请求微博搜索页失败") from exc
        response = _coerce_fetch_response(target, requested_url=url)
        body = response.text.lower()
        if any(marker in body for marker in ("请输入验证码", "安全验证", "滑动验证", "访问频繁", "登录后查看")):
            raise SearchBlockedError("微博页面要求登录或安全验证；请在 Chrome 中手动完成后重试")
        return response

    def _wait_between_requests(self) -> None:
        if self.options.delay:
            self.sleep(randomized_delay(self.options.delay, random_fn=self.random_fn))

    def _parse(self, response: FetchResponse, *, requested_url: str) -> dict[str, Any]:
        try:
            return parse_search_page(response.text, query=self.options.query, source_url=response.url or requested_url)
        except ParseError as exc:
            raise SearchError("无法解析微博搜索页；页面结构可能已变化") from exc

    def _fetch_leaf(self, window: SearchWindow, store: RunStore) -> None:
        page = 1
        while True:
            if self.options.limit > 0 and self._count >= self.options.limit:
                return
            url = build_search_url(self.options.query, options=self.options, window=window, page=page)
            if page > 1:
                self._wait_between_requests()
            response = self._fetch(url)
            if response.status >= 400:
                raise SearchError(f"微博搜索页返回 HTTP {response.status}")
            parsed = self._parse(response, requested_url=url)
            for item in parsed["items"]:
                if self.options.limit > 0 and self._count >= self.options.limit:
                    break
                normalised = normalise_record(item, query=self.options.query, source_url=response.url or url)
                if store.add(normalised):
                    self._count += 1
            next_url = parsed.get("next_url")
            if not next_url or not parsed["items"]:
                break
            page += 1
        store.save_window(window.key, "completed", page_count=int(parsed.get("page_count") or 0), window=window)
        self._completed.append(window.key)

    def run(self) -> SearchRun:
        output_dir = self.output_dir
        output_dir.mkdir(parents=True, exist_ok=True)
        with RunStore(output_dir, output_format=self.options.output_format, resume=bool(self.options.resume_dir)) as store:
            if self.options.resume_dir:
                self._count = store.count_seen()
                queue = store.resume_windows() or list(initial_windows(self.options))
            else:
                queue = list(initial_windows(self.options))
            seen_queue: set[str] = set()
            error: str | None = None
            try:
                while queue and (self.options.limit == 0 or self._count < self.options.limit):
                    window = queue.pop(0)
                    if window.key in seen_queue:
                        continue
                    seen_queue.add(window.key)
                    self._pending = [window.key, *[item.key for item in queue]]
                    if store.window_status(window.key) == "completed":
                        self._completed.append(window.key)
                        continue
                    store.save_window(window.key, "pending", window=window)
                    url = build_search_url(self.options.query, options=self.options, window=window, page=1)
                    if self._completed:
                        self._wait_between_requests()
                    response = self._fetch(url)
                    parsed = self._parse(response, requested_url=url)
                    # Saturation refinement is a completeness mechanism. A
                    # finite query only promises the requested record count.
                    decision = (
                        decide_window(window, int(parsed.get("page_count") or 0), threshold=self.options.threshold)
                        if self.options.limit == 0
                        else WindowDecision("fetch", (window,))
                    )
                    if decision.action in {"split-day", "split-hour"}:
                        store.save_window(window.key, "split", page_count=int(parsed.get("page_count") or 0), detail=decision.reason, window=window, children=decision.windows)
                        queue[0:0] = list(decision.windows)
                        continue
                    if decision.partial:
                        self._partial = True
                        self._truncated.append(window.key)
                        store.save_window(window.key, "partial", page_count=int(parsed.get("page_count") or 0), detail=decision.reason, window=window)
                    # Process the already-fetched first response, then follow
                    # its pagination chain while preserving the same checkpoint.
                    for item in parsed["items"]:
                        if self.options.limit > 0 and self._count >= self.options.limit:
                            break
                        normalised = normalise_record(item, query=self.options.query, source_url=response.url or url)
                        if store.add(normalised):
                            self._count += 1
                    if parsed.get("next_url") and (self.options.limit == 0 or self._count < self.options.limit):
                        next_url = parsed["next_url"]
                        while next_url and (self.options.limit == 0 or self._count < self.options.limit):
                            self._wait_between_requests()
                            next_response = self._fetch(next_url)
                            next_parsed = self._parse(next_response, requested_url=next_url)
                            for item in next_parsed["items"]:
                                if self.options.limit > 0 and self._count >= self.options.limit:
                                    break
                                if store.add(normalise_record(item, query=self.options.query, source_url=next_response.url or next_url)):
                                    self._count += 1
                            next_url = next_parsed.get("next_url")
                    if not decision.partial:
                        store.save_window(window.key, "completed", page_count=int(parsed.get("page_count") or 0), window=window)
                        self._completed.append(window.key)
            except SearchError as exc:
                # Persist a checkpoint and value-free manifest before surfacing
                # the error.  A blocked page can then be resumed safely.
                self._partial = True
                error = str(exc)
                store.checkpoint(pending=[item for item in self._pending if item not in self._completed], completed=self._completed, truncated=self._truncated, count=self._count)
                store.write_manifest(self._manifest(error=error))
                raise
            store.checkpoint(pending=[item for item in self._pending if item not in self._completed], completed=self._completed, truncated=self._truncated, count=self._count)
            store.write_manifest(self._manifest(error=error))
        return SearchRun(output_dir, self._count, self._partial, tuple(self._truncated))

    def _manifest(self, *, error: str | None = None) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "schema_version": 1,
            "generated_at": __import__("datetime").datetime.now().astimezone().isoformat(timespec="seconds"),
            "status": "partial" if self._partial else "complete",
            "count": self._count,
            "partial": self._partial,
            "truncated_windows": self._truncated,
            "options": options_manifest(self.options),
            "auth_source": self.auth.source,
            "files": {
                "jsonl": "results.jsonl" if self.options.output_format in {"jsonl", "both"} else None,
                "csv": "results.csv" if self.options.output_format in {"csv", "both"} else None,
                "checkpoint": "checkpoint.json",
                "state": "state.sqlite3",
            },
        }
        if error:
            payload["error"] = error
        return payload


class ScrapySearchEngine(SearchEngine):
    """Compatibility entry point for callers that explicitly request Scrapy.

    The planner/parser/storage are independent from the transport, so the
    default engine works in minimal environments while an installed Scrapy
    project can subclass this class and inject its Request scheduler/fetcher.
    """

    runtime = "scrapy"
