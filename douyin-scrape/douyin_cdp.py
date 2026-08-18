#!/usr/bin/env python3
"""Small, dependency-light Chrome DevTools Protocol helpers for Douyin.

The existing scraping scripts in this directory are intentionally left alone.
The two account commands use this module only for the common browser transport
and Netscape-cookie parsing.  It does not know anything about search or
screenshots, which keeps those workflows independent.
"""

from __future__ import annotations

import asyncio
import json
import time
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Iterable


class CdpError(RuntimeError):
    """Raised when Chrome cannot be reached or a CDP command fails."""


def http_json(
    url: str,
    *,
    method: str = "GET",
    data: bytes | None = None,
    timeout: float = 10,
) -> dict[str, Any] | list[Any]:
    """Call a local Chrome JSON endpoint and decode its response."""

    request = urllib.request.Request(url, method=method, data=data)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8", "replace"))
    except Exception as exc:  # pragma: no cover - exercised with a real Chrome
        raise CdpError(f"无法连接 Chrome CDP ({url}): {exc}") from exc


def cdp_endpoint(port: int = 9221, path: str = "json/version") -> str:
    """Return a loopback CDP HTTP endpoint without embedding a user path."""

    if not 1 <= int(port) <= 65535:
        raise ValueError("CDP 端口必须在 1-65535 之间")
    return f"http://127.0.0.1:{int(port)}/{path.lstrip('/')}"


def list_tabs(port: int = 9221) -> list[dict[str, Any]]:
    """List current Chrome targets."""

    result = http_json(cdp_endpoint(port, "json/list"))
    if not isinstance(result, list):
        raise CdpError("Chrome CDP /json/list 返回格式不正确")
    return [item for item in result if isinstance(item, dict)]


def open_tab(url: str, *, port: int = 9221) -> dict[str, Any]:
    """Open a new page target and return its target metadata."""

    encoded = urllib.parse.quote(url, safe="")
    result = http_json(
        cdp_endpoint(port, f"json/new?{encoded}"),
        method="PUT",
    )
    if not isinstance(result, dict) or not result.get("webSocketDebuggerUrl"):
        raise CdpError("Chrome CDP 未返回可连接的新页面")
    return result


def close_tab(page_id: str | None, *, port: int = 9221) -> None:
    """Best-effort close of a page target."""

    if not page_id:
        return
    try:
        http_json(cdp_endpoint(port, f"json/close/{urllib.parse.quote(page_id, safe='')}"), method="PUT")
    except CdpError:
        # Closing a tab is cleanup; preserve the original operation error.
        pass


def load_netscape_cookies(path: str | Path) -> list[dict[str, Any]]:
    """Load a Netscape cookie file without ever logging cookie values."""

    cookies: list[dict[str, Any]] = []
    source = Path(path)
    with source.open("r", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, 1):
            if not line.strip() or line.lstrip().startswith("#"):
                continue
            fields = line.rstrip("\r\n").split("\t")
            if len(fields) != 7:
                continue
            expires = 0
            try:
                expires = max(int(float(fields[4])), 0)
            except (TypeError, ValueError):
                pass
            cookies.append(
                {
                    "domain": fields[0],
                    "include_subdomains": fields[1].upper() == "TRUE",
                    "path": fields[2] or "/",
                    "secure": fields[3].upper() == "TRUE",
                    "expires": expires,
                    "name": fields[5],
                    "value": fields[6],
                    "line": line_number,
                }
            )
    return cookies


def cookie_header(cookies: Iterable[dict[str, Any]]) -> str:
    """Build a Cookie header; values are returned only to the caller."""

    return "; ".join(
        f"{item['name']}={item['value']}"
        for item in cookies
        if item.get("name")
    )


class CdpSession:
    """Async CDP command session with a response receiver.

    ``websockets`` is intentionally imported lazily so parser and CLI input
    tests can run without a browser dependency.  A fake session implementing
    ``command`` can be injected into either account command in tests.
    """

    def __init__(self, websocket_url: str, *, max_size: int = 2**27):
        self.websocket_url = websocket_url
        self.max_size = max_size
        self._ws: Any = None
        self._receiver: asyncio.Task[Any] | None = None
        self._sequence = 0
        self._pending: dict[int, asyncio.Future[dict[str, Any]]] = {}
        self._events: asyncio.Queue[dict[str, Any]] = asyncio.Queue()

    async def __aenter__(self) -> "CdpSession":
        try:
            import websockets

            self._ws = await websockets.connect(
                self.websocket_url,
                max_size=self.max_size,
                ping_interval=None,
            )
        except Exception as exc:  # pragma: no cover - requires local Chrome
            raise CdpError(f"无法连接 Chrome 页面 CDP: {exc}") from exc
        self._receiver = asyncio.create_task(self._receive_loop())
        return self

    async def __aexit__(self, exc_type: Any, exc: Any, traceback: Any) -> None:
        if self._receiver:
            self._receiver.cancel()
            try:
                await self._receiver
            except asyncio.CancelledError:
                pass
            self._receiver = None
        if self._ws is not None:
            try:
                await self._ws.close()
            finally:
                self._ws = None
        for future in self._pending.values():
            if not future.done():
                future.cancel()
        self._pending.clear()

    async def _receive_loop(self) -> None:
        try:
            async for raw in self._ws:
                message = json.loads(raw)
                if "id" in message:
                    future = self._pending.pop(int(message["id"]), None)
                    if future and not future.done():
                        if "error" in message:
                            future.set_exception(CdpError(str(message["error"])))
                        else:
                            future.set_result(message.get("result") or {})
                elif message.get("method"):
                    await self._events.put(message)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # pragma: no cover - requires local Chrome
            for future in self._pending.values():
                if not future.done():
                    future.set_exception(CdpError(f"CDP 接收失败: {exc}"))

    async def command(
        self,
        method: str,
        params: dict[str, Any] | None = None,
        *,
        timeout: float = 30,
    ) -> dict[str, Any]:
        """Send a CDP command and return its result object."""

        if self._ws is None:
            raise CdpError("CDP session 尚未连接")
        self._sequence += 1
        command_id = self._sequence
        loop = asyncio.get_running_loop()
        future: asyncio.Future[dict[str, Any]] = loop.create_future()
        self._pending[command_id] = future
        await self._ws.send(
            json.dumps(
                {"id": command_id, "method": method, "params": params or {}},
                ensure_ascii=False,
            )
        )
        try:
            return await asyncio.wait_for(future, timeout=timeout)
        except Exception:
            self._pending.pop(command_id, None)
            raise

    async def next_event(self, *, timeout: float = 30) -> dict[str, Any]:
        """Read the next unsolicited CDP event, if a caller needs it."""

        return await asyncio.wait_for(self._events.get(), timeout=timeout)


# Existing local scripts call their helper ``CDP``.  The alias eases gradual
# adoption without changing any of those scripts.
CDP = CdpSession


async def wait_for_page(
    session: CdpSession,
    *,
    seconds: float = 5,
    interval: float = 0.25,
) -> None:
    """Small cancellable load wait shared by account commands."""

    deadline = time.monotonic() + max(0, seconds)
    while time.monotonic() < deadline:
        await asyncio.sleep(min(interval, max(0, deadline - time.monotonic())))

