import io
import tempfile
import unittest
from pathlib import Path

import test_support  # noqa: F401

from PIL import Image

from zhihu_cli.splitter import max_height_for_ratio, plan_slices, split_image_bytes


def image_bytes(width=900, height=3300):
    image = Image.new("RGB", (width, height), "white")
    stream = io.BytesIO()
    image.save(stream, format="PNG")
    return stream.getvalue()


class SplitterTests(unittest.TestCase):
    def test_short_image_is_one_piece(self):
        self.assertEqual(len(plan_slices(900, 1000)), 1)

    def test_ratio_limit_and_hard_cut_overlap(self):
        pieces = plan_slices(900, 3300, overlap=64)
        self.assertTrue(all(piece.height <= max_height_for_ratio(900) for piece in pieces))
        self.assertEqual(pieces[0].overlap, 64)
        self.assertEqual(pieces[1].top, pieces[0].bottom - 64)

    def test_semantic_boundary_preferred(self):
        pieces = plan_slices(900, 3300, boundaries=[800, 1500, 2200, 3000])
        self.assertEqual(pieces[0].bottom, 1500)
        self.assertEqual(pieces[0].mode, "semantic-boundary")
        self.assertEqual(pieces[0].overlap, 0)

    def test_last_piece_keeps_actual_height_and_hash(self):
        with tempfile.TemporaryDirectory() as temp:
            parts = split_image_bytes(image_bytes(900, 2000), output_dir=temp, zhihu_id="42")
            self.assertEqual(parts[-1]["height"], 2000 - parts[-1]["coordinates"]["y"])
            self.assertEqual(len(parts[-1]["sha256"]), 64)
            self.assertTrue((Path(temp) / parts[0]["filename"]).exists())

    def test_invalid_image_fails(self):
        with self.assertRaises(ValueError):
            split_image_bytes(b"not-an-image")


if __name__ == "__main__":
    unittest.main()
