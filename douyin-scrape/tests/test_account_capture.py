import base64
import json
import struct
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from account_capture import _PROFILE_SCRIPT, capture_profiles, read_profile_inputs  # noqa: E402
from account_parser import AccountInputError  # noqa: E402


class FakeSession:
    def __init__(self, websocket_url):
        self.commands = []
        self.command_records = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return None

    async def command(self, method, params=None, **kwargs):
        self.commands.append(method)
        self.command_records.append((method, params or {}))
        if method == "Runtime.evaluate":
            if params and params.get("expression") == "document.body ? document.body.innerText : ''":
                return {"result": {"value": "账号主页"}}
            return {"result": {"value": {"nickname": "测试账号", "page_title": "测试账号 - 抖音", "clip": {"x": 0, "y": 0, "width": 600, "height": 500}}}}
        if method == "Page.captureScreenshot":
            return {"data": base64.b64encode(b"\x89PNG\r\n\x1a\nfake-png").decode("ascii")}
        return {}


class BadPngSession(FakeSession):
    async def command(self, method, params=None, **kwargs):
        if method == "Page.captureScreenshot":
            return {"data": base64.b64encode(b"not-a-png").decode("ascii")}
        return await super().command(method, params, **kwargs)


def fake_png(width: int, height: int) -> bytes:
    """Enough PNG structure for the capture code to read the IHDR size."""

    return b"\x89PNG\r\n\x1a\n" + b"\x00\x00\x00\rIHDR" + struct.pack(">II", width, height)


class TwoRowSession(FakeSession):
    last_instance = None

    def __init__(self, websocket_url):
        super().__init__(websocket_url)
        type(self).last_instance = self

    async def command(self, method, params=None, **kwargs):
        if method == "Runtime.evaluate":
            self.commands.append(method)
            self.command_records.append((method, params or {}))
            if params and params.get("expression") == "document.body ? document.body.innerText : ''":
                return {"result": {"value": "账号主页"}}
            return {
                "result": {
                    "value": {
                        "nickname": "两排账号",
                        "page_title": "两排账号 - 抖音",
                        "post_rows": 2,
                        "post_cards_considered": 6,
                        "document_height": 1800,
                        "clip": {"x": 120, "y": 0, "width": 1320, "height": 1240},
                    }
                }
            }
        if method == "Page.captureScreenshot":
            self.commands.append(method)
            self.command_records.append((method, params or {}))
            return {"data": base64.b64encode(fake_png(1320, 1240)).decode("ascii")}
        return await super().command(method, params, **kwargs)


class AccountCaptureTests(unittest.TestCase):
    def test_input_accepts_one_reference_and_deduplicates_file(self):
        with tempfile.TemporaryDirectory() as temp:
            input_file = Path(temp) / "accounts.txt"
            input_file.write_text("# comment\nsec-one\nhttps://www.douyin.com/user/sec-one\nsec-two\n", encoding="utf-8")
            rows = read_profile_inputs(input_path=input_file)
        self.assertEqual([row["sec_uid"] for row in rows], ["sec-one", "sec-two"])
        with self.assertRaises(AccountInputError):
            read_profile_inputs("https://www.douyin.com/search/财经?type=user")

    def test_capture_writes_manifest_and_png_for_explicit_reference(self):
        def fake_open(url, *, port):
            return {"webSocketDebuggerUrl": "fake", "id": None}

        reference = read_profile_inputs("sec-one")
        with tempfile.TemporaryDirectory() as temp:
            output = capture_profiles(
                reference,
                output_dir=temp,
                wait_seconds=0,
                opener=fake_open,
                session_factory=FakeSession,
            )
            manifest = json.loads((output / "manifest.json").read_text(encoding="utf-8"))
            self.assertEqual(manifest["success_count"], 1)
            self.assertTrue(list((output / "images").glob("*.png")))
            self.assertEqual(manifest["items"][0]["capture_mode"], "profile-region")

    def test_capture_rejects_non_png_browser_data(self):
        def fake_open(url, *, port):
            return {"webSocketDebuggerUrl": "fake", "id": None}

        with tempfile.TemporaryDirectory() as temp:
            output = capture_profiles(
                read_profile_inputs("sec-one"),
                output_dir=temp,
                wait_seconds=0,
                opener=fake_open,
                session_factory=BadPngSession,
            )
            manifest = json.loads((output / "manifest.json").read_text(encoding="utf-8"))
            self.assertEqual(manifest["success_count"], 0)
            self.assertEqual(manifest["items"][0]["status"], "error")
            self.assertFalse(list((output / "images").glob("*.png")))

    def test_profile_script_groups_first_twelve_posts_and_can_preload_second_row(self):
        self.assertIn("slice(0, 12)", _PROFILE_SCRIPT)
        self.assertIn("groupRows", _PROFILE_SCRIPT)
        self.assertIn("firstTwoRows", _PROFILE_SCRIPT)
        self.assertIn("window.scrollTo", _PROFILE_SCRIPT)

    def test_capture_preserves_two_row_clip_height_and_png_dimensions(self):
        def fake_open(url, *, port):
            return {"webSocketDebuggerUrl": "fake", "id": None}

        with tempfile.TemporaryDirectory() as temp:
            output = capture_profiles(
                read_profile_inputs("sec-one"),
                output_dir=temp,
                wait_seconds=0,
                opener=fake_open,
                session_factory=TwoRowSession,
            )
            manifest = json.loads((output / "manifest.json").read_text(encoding="utf-8"))
            item = manifest["items"][0]
            self.assertEqual(item["status"], "ok")
            self.assertEqual(item["post_rows"], 2)
            self.assertEqual(item["post_cards_considered"], 6)
            self.assertEqual(item["image_width"], 1320)
            self.assertEqual(item["image_height"], 1240)
            screenshot_calls = [
                params for method, params in TwoRowSession.last_instance.command_records
                if method == "Page.captureScreenshot"
            ]
            self.assertEqual(len(screenshot_calls), 1)
            self.assertTrue(screenshot_calls[0]["captureBeyondViewport"])
            self.assertEqual(screenshot_calls[0]["clip"]["height"], 1240.0)


if __name__ == "__main__":
    unittest.main()
