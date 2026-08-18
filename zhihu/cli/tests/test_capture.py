import asyncio
import base64
import io
import json
import tempfile
import unittest
from pathlib import Path

import test_support  # noqa: F401

from PIL import Image

from zhihu_cli.auth import AuthContext
from zhihu_cli.capture import (
    MAX_DOM_BAND_HEIGHT,
    CaptureError,
    _PREPARE_SCRIPT,
    capture,
    capture_zhihu_page,
)
from zhihu_cli.inputs import parse_reference


def png_bytes(width=900, height=300):
    image = Image.new("RGB", (width, height), "white")
    stream = io.BytesIO()
    image.save(stream, format="PNG")
    return stream.getvalue()


class FakeSession:
    def __init__(self, websocket, *, height=12550):
        self.websocket = websocket
        self.height = height
        self.commands = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return None

    async def command(self, method, params=None, **kwargs):
        self.commands.append((method, params or {}))
        if method == "Runtime.evaluate":
            expression = (params or {}).get("expression", "")
            if "cardFound" in expression:
                return {
                    "result": {
                        "value": {
                            "cardFound": True,
                            "captureMode": "answer-question-title-and-answer",
                            "clip": {"x": 0, "y": 20, "width": 900, "height": self.height},
                            "boundaries": [{"y": 900}, {"y": 2300}, {"y": 12000}],
                            "title": "问题标题",
                            "author": "回答作者",
                            "body": "问题标题\n回答正文",
                        }
                    }
                }
            return {"result": {"value": {}}}
        if method == "Page.captureScreenshot":
            clip = (params or {}).get("clip", {})
            return {"data": base64.b64encode(png_bytes(int(clip.get("width", 900)), int(clip.get("height", 300)))).decode("ascii")}
        return {}


class NoCardSession(FakeSession):
    async def command(self, method, params=None, **kwargs):
        self.commands.append((method, params or {}))
        if method == "Runtime.evaluate" and "cardFound" in (params or {}).get("expression", ""):
            return {"result": {"value": {"cardNotFound": True, "candidateCount": 3}}}
        return {}


class MissingSession(FakeSession):
    async def command(self, method, params=None, **kwargs):
        self.commands.append((method, params or {}))
        if method == "Runtime.evaluate" and "cardFound" in (params or {}).get("expression", ""):
            return {"result": {"value": {"missing": True, "body": "内容不存在"}}}
        return {}


class FakeProcess:
    def __init__(self):
        self.terminated = False

    def poll(self):
        return 0 if self.terminated else None

    def terminate(self):
        self.terminated = True

    def wait(self, timeout=None):
        return 0

    def kill(self):
        self.terminated = True


class CaptureTests(unittest.TestCase):
    def test_dom_script_requires_exact_answer_and_isolation(self):
        self.assertIn(".ContentItem.AnswerItem", _PREPARE_SCRIPT)
        self.assertIn(".QuestionHeader-title", _PREPARE_SCRIPT)
        self.assertIn("source = answerCandidates.find(hasAnswerId)", _PREPARE_SCRIPT)
        self.assertIn("source.cloneNode(true)", _PREPARE_SCRIPT)
        self.assertNotIn("Page.captureScreenshot", _PREPARE_SCRIPT)

    def test_dom_script_promotes_lazy_image_sources_before_clone(self):
        self.assertIn("image.currentSrc", _PREPARE_SCRIPT)
        self.assertIn("'data-original'", _PREPARE_SCRIPT)
        self.assertIn("'data-actualsrc'", _PREPARE_SCRIPT)
        self.assertIn("image.scrollIntoView", _PREPARE_SCRIPT)
        self.assertIn("image.loading = 'eager'", _PREPARE_SCRIPT)
        self.assertIn("__zhihuPlusImageSource", _PREPARE_SCRIPT)
        self.assertIn("transferImageState(source, answerClone, wrapper)", _PREPARE_SCRIPT)

    def test_dom_script_rejects_placeholders_and_collapses_failed_image_boxes(self):
        self.assertIn("isPlaceholderSource", _PREPARE_SCRIPT)
        self.assertIn("naturalWidth > 2 && image.naturalHeight > 2", _PREPARE_SCRIPT)
        self.assertIn("removeFailedImage", _PREPARE_SCRIPT)
        self.assertIn("figure, [data-portal], [class*=\"portal\" i]", _PREPARE_SCRIPT)
        self.assertIn("'min-height'", _PREPARE_SCRIPT)
        self.assertIn("beforePruneImageCount", _PREPARE_SCRIPT)

    def test_dom_script_keeps_loaded_images_using_actual_url(self):
        self.assertIn("image.setAttribute('src', actual)", _PREPARE_SCRIPT)
        self.assertIn("'data-original', 'data-actualsrc'", _PREPARE_SCRIPT)
        self.assertIn("image.classList.remove('lazy', 'lazy-image', 'is-lazy')", _PREPARE_SCRIPT)

    def test_page_capture_injects_cookie_and_splits_dom_bands(self):
        reference = parse_reference("https://www.zhihu.com/question/1/answer/2")
        session = FakeSession("fake")
        image, metadata = asyncio.run(capture_zhihu_page(session, reference, wait_seconds=0, auth=AuthContext("z_c0=secret", "cookie-file")))
        self.assertEqual(metadata["capture_mode"], "answer-question-title-and-answer")
        self.assertGreater(metadata["dom_height_css"], MAX_DOM_BAND_HEIGHT)
        self.assertEqual(len(metadata["bands"]), 2)
        self.assertTrue(all(record["height_css"] <= MAX_DOM_BAND_HEIGHT for record in metadata["bands"]))
        self.assertTrue(any(method == "Network.setCookies" for method, _ in session.commands))
        self.assertEqual(Image.open(io.BytesIO(image)).height, 12550)

    def test_missing_card_refuses_any_screenshot(self):
        reference = parse_reference("https://www.zhihu.com/question/1/answer/2")
        session = NoCardSession("fake")
        with self.assertRaises(CaptureError):
            asyncio.run(capture_zhihu_page(session, reference, wait_seconds=0))
        self.assertFalse(any(method == "Page.captureScreenshot" for method, _ in session.commands))

    def test_deleted_content_is_reported_without_screenshot(self):
        reference = parse_reference("https://zhuanlan.zhihu.com/p/9")
        session = MissingSession("fake")
        with self.assertRaises(CaptureError):
            asyncio.run(capture_zhihu_page(session, reference, wait_seconds=0))
        self.assertFalse(any(method == "Page.captureScreenshot" for method, _ in session.commands))

    def test_capture_writes_manifest_and_parts(self):
        reference = parse_reference("https://www.zhihu.com/question/1/answer/9")

        def opener(url, *, port):
            return {"id": "tab-1", "webSocketDebuggerUrl": "fake"}

        with tempfile.TemporaryDirectory() as temp:
            output = capture([reference], output_dir=temp, wait_seconds=0, opener=opener, session_factory=FakeSession)
            manifest = json.loads((Path(output) / "manifest.json").read_text(encoding="utf-8"))
            item = manifest["items"][0]
            self.assertEqual(item["status"], "ok")
            self.assertEqual(item["zhihu_type"], "answer")
            self.assertEqual(item["question_id"], "1")
            self.assertEqual(item["author"], "回答作者")
            self.assertEqual(item["capture_mode"], "answer-question-title-and-answer")
            self.assertGreater(item["part_count"], 1)
            self.assertTrue(all(Path(output, part["path"]).exists() for part in item["parts"]))
            self.assertTrue(all(part["height"] <= part["width"] * 16 / 9 for part in item["parts"]))
            self.assertIn("bands", item)
            self.assertEqual(item["image_count"], 0)
            self.assertEqual(item["removed_image_count"], 0)
            self.assertTrue(all(part["filename"].startswith("zhihu-answer-9-") for part in item["parts"]))

    def test_batch_partial_failure_is_preserved_in_manifest(self):
        good = parse_reference("https://www.zhihu.com/question/1/answer/2")
        bad = parse_reference("https://zhuanlan.zhihu.com/p/9")

        def opener(url, *, port):
            return {"id": url, "webSocketDebuggerUrl": url}

        def factory(websocket):
            return NoCardSession(websocket) if websocket.endswith("/p/9") else FakeSession(websocket, height=500)

        with tempfile.TemporaryDirectory() as temp:
            output = capture([good, bad], output_dir=temp, wait_seconds=0, opener=opener, session_factory=factory)
            manifest = json.loads((Path(output) / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual((manifest["count"], manifest["success_count"], manifest["failed_count"]), (2, 1, 1))
        self.assertEqual(manifest["status"], "partial")

    def test_temporary_chrome_closes_owned_profile(self):
        from unittest.mock import patch

        from zhihu_cli.browser import TemporaryChrome

        with tempfile.TemporaryDirectory() as temp:
            profile = Path(temp) / "profile"
            with patch("zhihu_cli.browser.tempfile.mkdtemp", return_value=str(profile)), patch("zhihu_cli.browser.subprocess.Popen", return_value=FakeProcess()), patch("zhihu_cli.browser.list_tabs", return_value=[]):
                browser = TemporaryChrome(executable="fake", port=23456)
                browser.start()
                self.assertTrue(profile.exists())
                browser.close()
                self.assertFalse(profile.exists())

    def test_temporary_chrome_is_closed_when_start_fails(self):
        from unittest.mock import patch

        from zhihu_cli.browser import CdpError

        reference = parse_reference("https://www.zhihu.com/question/1/answer/2")

        class FailingBrowser:
            def __init__(self):
                self.closed = False

            def start(self):
                raise CdpError("start failed")

            def close(self):
                self.closed = True

        browser = FailingBrowser()
        with patch("zhihu_cli.capture.list_tabs", side_effect=CdpError("offline")):
            with self.assertRaises(CdpError):
                capture(
                    [reference],
                    auth=AuthContext("z_c0=secret", "cookie-file"),
                    browser_factory=lambda: browser,
                )
        self.assertTrue(browser.closed)


if __name__ == "__main__":
    unittest.main()
