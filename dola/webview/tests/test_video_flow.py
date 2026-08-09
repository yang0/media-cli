# -*- coding: utf-8 -*-
from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest.mock import patch

WEBVIEW = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(WEBVIEW))

import video_flow  # noqa: E402


class VideoFlowOptionTests(unittest.TestCase):
    def test_aspect_ratio_selects_native_control_and_option(self):
        for ratio in ("16:9", "3:4", "4:3", "21:9"):
            with self.subTest(ratio=ratio):
                scripts: list[str] = []
                replies = iter([
                    {"ok": True, "key": "video-ratio", "text": "9:16"},
                    {"ok": True, "text": ratio},
                ])

                def fake_eval(_window, script):
                    scripts.append(script)
                    return next(replies)

                with (
                    patch.object(video_flow, "js_eval", side_effect=fake_eval),
                    patch.object(video_flow.time, "sleep"),
                ):
                    selected = video_flow.select_video_ui_option(
                        object(),
                        control_keys=["video-ratio", "aspect-ratio"],
                        value=ratio,
                    )

                self.assertTrue(selected)
                self.assertIn('"video-ratio"', scripts[0])
                self.assertIn(f'"{ratio}"', scripts[1])
                self.assertIn("data-input-engine-actionbar-control-key", scripts[0])
                self.assertIn("menuitemradio", scripts[1])
                self.assertEqual(len(scripts), 2)


if __name__ == "__main__":
    unittest.main()
