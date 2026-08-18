"""Minimal Chrome DevTools Protocol transport for Zhihu capture."""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import socket
import subprocess
import tempfile
import time
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any


class CdpError(RuntimeError):
    """Raised when the local Chrome CDP endpoint cannot be used."""


def _endpoint(port: int, path: str) -> str:
    if not 1 <= int(port) <= 65535:
        raise ValueError("CDP 端口必须在 1-65535 之间")
    return f"http://127.0.0.1:{int(port)}/{path.lstrip('/')}"


def http_json(url: str, *, method: str = "GET", data: bytes | None = None, timeout: float = 5) -> Any:
    request = urllib.request.Request(url, method=method, data=data)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8", "replace"))
    except Exception as exc:
        raise CdpError("无法连接 Chrome CDP") from exc


def list_tabs(port: int = 9221) -> list[dict[str, Any]]:
    result = http_json(_endpoint(port, "json/list"))
    if not isinstance(result, list):
        raise CdpError("Chrome CDP 返回的页面列表格式不正确")
    return [item for item in result if isinstance(item, dict) and item.get("webSocketDebuggerUrl")]


def open_tab(url: str, *, port: int = 9221) -> dict[str, Any]:
    encoded = urllib.parse.quote(str(url), safe="")
    result = http_json(_endpoint(port, f"json/new?{encoded}"), method="PUT")
    if not isinstance(result, dict) or not result.get("webSocketDebuggerUrl"):
        raise CdpError("Chrome CDP 未返回可连接的新页面")
    return result


def close_tab(page_id: str | None, *, port: int = 9221) -> None:
    if not page_id:
        return
    try:
        http_json(_endpoint(port, f"json/close/{urllib.parse.quote(page_id, safe='')}"), method="PUT")
    except CdpError:
        pass


def discover_browser_executable() -> str | None:
    candidates: list[Path] = []
    for name in ("ZHIHU_CHROME_EXECUTABLE", "CHROME_PATH", "PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA"):
        value = os.environ.get(name)
        if not value:
            continue
        root = Path(value)
        if name in {"ZHIHU_CHROME_EXECUTABLE", "CHROME_PATH"}:
            candidates.append(root)
        else:
            candidates.extend(
                [
                    root / "Google/Chrome/Application/chrome.exe",
                    root / "Microsoft/Edge/Application/msedge.exe",
                    root / "Chromium/Application/chrome.exe",
                ]
            )
    for candidate in candidates:
        try:
            if candidate.is_file():
                return str(candidate)
        except OSError:
            continue
    return None


def allocate_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


class CdpSession:
    def __init__(self, websocket_url: str, *, max_size: int = 2**28):
        self.websocket_url = websocket_url
        self.max_size = max_size
        self._ws: Any = None
        self._receiver: asyncio.Task[Any] | None = None
        self._sequence = 0
        self._pending: dict[int, asyncio.Future[dict[str, Any]]] = {}

    async def __aenter__(self) -> "CdpSession":
        try:
            import websockets

            self._ws = await websockets.connect(self.websocket_url, max_size=self.max_size, ping_interval=None)
        except Exception as exc:
            raise CdpError("无法连接 Chrome 页面 CDP") from exc
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
                if "id" not in message:
                    continue
                future = self._pending.pop(int(message["id"]), None)
                if future and not future.done():
                    if "error" in message:
                        future.set_exception(CdpError("Chrome CDP 命令失败"))
                    else:
                        future.set_result(message.get("result") or {})
        except asyncio.CancelledError:
            raise
        except Exception:
            for future in self._pending.values():
                if not future.done():
                    future.set_exception(CdpError("Chrome CDP 连接中断"))

    async def command(self, method: str, params: dict[str, Any] | None = None, *, timeout: float = 45) -> dict[str, Any]:
        if self._ws is None:
            raise CdpError("CDP session 尚未连接")
        self._sequence += 1
        command_id = self._sequence
        future: asyncio.Future[dict[str, Any]] = asyncio.get_running_loop().create_future()
        self._pending[command_id] = future
        await self._ws.send(json.dumps({"id": command_id, "method": method, "params": params or {}}, ensure_ascii=False))
        try:
            return await asyncio.wait_for(future, timeout=timeout)
        except Exception:
            self._pending.pop(command_id, None)
            raise


async def wait_for_page(session: CdpSession, *, seconds: float = 3, interval: float = 0.25) -> None:
    deadline = time.monotonic() + max(0, seconds)
    while time.monotonic() < deadline:
        await asyncio.sleep(min(interval, max(0, deadline - time.monotonic())))


def _result_value(result: dict[str, Any]) -> Any:
    return (result.get("result") or {}).get("value")


async def _read_cookies_async(port: int) -> str:
    tabs = list_tabs(port)
    target = next((tab for tab in tabs if "zhihu" in str(tab.get("url", "")).lower()), None)
    target = target or (tabs[0] if tabs else None)
    if not target or not target.get("webSocketDebuggerUrl"):
        raise CdpError("Chrome 中没有可用页面")
    async with CdpSession(str(target["webSocketDebuggerUrl"])) as session:
        result = await session.command("Network.getAllCookies")
    cookies = (result or {}).get("cookies") or []
    scoped = [
        item for item in cookies
        if isinstance(item, dict) and item.get("name") and "zhihu" in str(item.get("domain", "")).lower()
    ]
    if not scoped and "zhihu" in str(target.get("url", "")).lower():
        scoped = [item for item in cookies if isinstance(item, dict) and item.get("name")]
    return "; ".join(f"{item.get('name')}={item.get('value', '')}" for item in scoped)


def cdp_cookie_header(port: int = 9221) -> str:
    try:
        return asyncio.run(_read_cookies_async(int(port)))
    except RuntimeError as exc:
        raise CdpError("当前运行环境已有活动事件循环，无法读取 Chrome Cookie") from exc


class TemporaryChrome:
    """Chrome process and profile owned by one capture run."""

    def __init__(self, *, executable: str | None = None, port: int | None = None, profile_dir: str | Path | None = None):
        self.executable = executable or discover_browser_executable()
        self.port = int(port or allocate_free_port())
        self._owns_profile = profile_dir is None
        self.profile_dir = Path(profile_dir) if profile_dir else Path(tempfile.mkdtemp(prefix="zhihu-plus-chrome-"))
        self.process: subprocess.Popen[Any] | None = None

    def start(self) -> int:
        if not self.executable:
            raise CdpError("未发现 Chrome/Edge 可执行文件，无法启动临时浏览器")
        self.profile_dir.mkdir(parents=True, exist_ok=True)
        self.process = subprocess.Popen(
            [
                self.executable,
                f"--remote-debugging-port={self.port}",
                f"--user-data-dir={self.profile_dir}",
                "--remote-debugging-address=127.0.0.1",
                "--no-first-run",
                "--no-default-browser-check",
                "about:blank",
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        self.wait_ready()
        return self.port

    def wait_ready(self, *, timeout: float = 15, poll: float = 0.2) -> None:
        deadline = time.monotonic() + max(0.1, timeout)
        last_error: Exception | None = None
        while time.monotonic() < deadline:
            try:
                list_tabs(self.port)
                return
            except Exception as exc:
                last_error = exc
                time.sleep(poll)
        raise CdpError("临时 Chrome CDP 启动超时") from last_error

    def close(self) -> None:
        if self.process and self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()
        self.process = None
        if self._owns_profile:
            shutil.rmtree(self.profile_dir, ignore_errors=True)
