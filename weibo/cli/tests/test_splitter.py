import io
import unittest

import test_support  # noqa: F401

from PIL import Image

from weibo_cli.splitter import max_height_for_ratio, plan_slices, split_image_bytes


def image_bytes(width=900, height=3000):
    image = Image.new("RGB", (width, height), "white")
    stream = io.BytesIO()
    image.save(stream, format="PNG")
    return stream.getvalue()


class SplitterTests(unittest.TestCase):
    def test_short_card_is_one_piece(self):
        self.assertEqual(len(plan_slices(900, 1000)), 1)

    def test_long_card_hard_cuts_with_overlap_and_ratio(self):
        pieces = plan_slices(900, 3000, overlap=64)
        self.assertGreater(len(pieces), 1)
        self.assertTrue(all(piece.height <= max_height_for_ratio(900) for piece in pieces))
        self.assertEqual(pieces[0].overlap, 64)
        self.assertEqual(pieces[1].top, pieces[0].bottom - 64)

    def test_content_boundary_preferred(self):
        pieces = plan_slices(900, 3000, boundaries=[800, 1700, 2600])
        self.assertEqual(pieces[0].bottom, 800)
        self.assertEqual(pieces[0].mode, "content-boundary")

    def test_writes_numbered_png_and_sha(self):
        import tempfile
        from pathlib import Path

        with tempfile.TemporaryDirectory() as temp:
            result = split_image_bytes(image_bytes(), output_dir=Path(temp), weibo_id="abc")
            self.assertTrue(result[0]["filename"].startswith("weibo-abc-01-of-"))
            self.assertTrue((Path(temp) / result[0]["filename"]).exists())
            self.assertEqual(len(result[0]["sha256"]), 64)


if __name__ == "__main__":
    unittest.main()
