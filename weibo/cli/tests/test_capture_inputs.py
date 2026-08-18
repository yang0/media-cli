import tempfile
import unittest
from pathlib import Path

import test_support  # noqa: F401

from weibo_cli.capture import parse_weibo_reference, read_inputs


class CaptureInputTests(unittest.TestCase):
    def test_accepts_url_numeric_id_and_deduplicates(self):
        self.assertEqual(parse_weibo_reference("123")["id"], "123")
        self.assertEqual(parse_weibo_reference("https://weibo.com/42/AbC")["id"], "AbC")
        with tempfile.TemporaryDirectory() as temp:
            source = Path(temp) / "urls.txt"
            source.write_text("123\nhttps://weibo.com/42/AbC\nhttps://weibo.com/42/AbC\n", encoding="utf-8")
            self.assertEqual(len(read_inputs(input_path=source)), 2)


if __name__ == "__main__":
    unittest.main()
