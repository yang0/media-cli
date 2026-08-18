import unittest

import test_support  # noqa: F401

from zhihu_cli.cli import build_parser


class CliTests(unittest.TestCase):
    def test_help_shape_has_auth_and_capture(self):
        parser = build_parser()
        self.assertEqual(parser.parse_args(["auth", "check", "--cdp-port", "9221"]).command, "auth")
        args = parser.parse_args(["capture", "https://zhuanlan.zhihu.com/p/1", "--overlap", "64"])
        self.assertEqual((args.command, args.overlap), ("capture", 64))
        self.assertEqual(args.wait_seconds, 5.0)
        args = parser.parse_args(["capture", "https://zhuanlan.zhihu.com/p/1", "--chrome", "chrome.exe"])
        self.assertEqual(args.chrome_executable, "chrome.exe")


if __name__ == "__main__":
    unittest.main()
