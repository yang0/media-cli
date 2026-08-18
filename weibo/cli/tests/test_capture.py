import base64
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import test_support  # noqa: F401

from PIL import Image

from weibo_cli.auth import AuthContext
from weibo_cli.browser import TemporaryChrome
from weibo_cli.capture import CaptureError, capture, capture_weibo_page, parse_weibo_reference, read_inputs


def png_bytes(width=900, height=3000):
    image = Image.new("RGB", (width, height), "white")
    stream = io.BytesIO()
    image.save(stream, format="PNG")
    return stream.getvalue()


class FakeSession:
    def __init__(self, websocket):
        self.data = base64.b64encode(png_bytes()).decode("ascii")
        self.commands = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return None

    async def command(self, method, params=None, **kwargs):
        self.commands.append((method, params or {}))
        if method == "Runtime.evaluate":
            return {"result": {"value": {"clip": {"x": 0, "y": 0, "width": 900, "height": 3000}, "boundaries": [], "title": "测试微博", "body": "正文", "cardFound": True}}}
        if method == "Page.captureScreenshot":
            return {"data": self.data}
        return {}


class CaptureTests(unittest.TestCase):
    def test_numeric_id_uses_mobile_detail_url(self):
        self.assertEqual(parse_weibo_reference("123")["url"], "https://m.weibo.cn/detail/123")

    def test_cookie_injection_is_sent_to_cdp_session(self):
        import asyncio

        session = FakeSession("fake")
        asyncio.run(capture_weibo_page(session, parse_weibo_reference("123"), wait_seconds=0, auth=AuthContext("SUB=secret", "cookie-file")))
        cookie_commands = [params for method, params in session.commands if method == "Network.setCookies"]
        self.assertEqual(cookie_commands[0]["cookies"][0]["name"], "SUB")
        self.assertEqual(cookie_commands[0]["cookies"][0]["value"], "secret")

    def test_card_location_failure_does_not_capture_viewport(self):
        import asyncio

        class NoCard(FakeSession):
            async def command(self, method, params=None, **kwargs):
                self.commands.append((method, params or {}))
                if method == "Runtime.evaluate":
                    return {"result": {"value": {"cardNotFound": True, "body": "推荐流"}}}
                return {}

        session = NoCard("fake")
        with self.assertRaises(CaptureError):
            asyncio.run(capture_weibo_page(session, parse_weibo_reference("123"), wait_seconds=0))
        self.assertFalse(any(method == "Page.captureScreenshot" for method, _ in session.commands))

    def test_temporary_chrome_closes_process_and_deletes_owned_profile(self):
        class FakeProcess:
            def __init__(self):
                self.terminated = False

            def poll(self):
                return None if not self.terminated else 0

            def terminate(self):
                self.terminated = True

            def wait(self, timeout=None):
                return 0

            def kill(self):
                self.terminated = True

        with tempfile.TemporaryDirectory() as temp:
            profile = Path(temp) / "owned-profile"
            with patch("weibo_cli.browser.tempfile.mkdtemp", return_value=str(profile)), patch("weibo_cli.browser.subprocess.Popen", return_value=FakeProcess()), patch("weibo_cli.browser.list_tabs", return_value=[]):
                browser = TemporaryChrome(executable="fake", port=23456)
                browser.start()
                self.assertTrue(profile.exists())
                browser.close()
                self.assertFalse(profile.exists())

    def test_long_card_manifest_has_multiple_ratio_safe_parts(self):
        def opener(url, *, port):
            return {"id": None, "webSocketDebuggerUrl": "fake"}

        with tempfile.TemporaryDirectory() as temp:
            output = capture(read_inputs("123"), output_dir=temp, wait_seconds=0, opener=opener, session_factory=FakeSession)
            manifest = json.loads((Path(output) / "manifest.json").read_text(encoding="utf-8"))
            item = manifest["items"][0]
            self.assertEqual(item["status"], "ok")
            self.assertGreater(item["part_count"], 1)
            self.assertTrue(all(part["height"] <= part["width"] * 16 / 9 for part in item["parts"]))
            self.assertTrue(all(Path(output, part["path"]).exists() for part in item["parts"]))


if __name__ == "__main__":
    unittest.main()
