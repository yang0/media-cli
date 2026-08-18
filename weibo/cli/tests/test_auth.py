import tempfile
import unittest
from pathlib import Path

import test_support  # noqa: F401

from weibo_cli.auth import auth_summary, redact_cookie, resolve_auth


class AuthTests(unittest.TestCase):
    def test_priority_cookie_file_then_env_then_cdp(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "cookies.txt"
            path.write_text("# Netscape\n.weibo.com\tTRUE\t/\tFALSE\t0\tSUB\tfile-value\n", encoding="utf-8")
            context = resolve_auth(cookie_file=path, env={"WEIBO_COOKIE": "ENV=env-value"}, cdp_loader=lambda port: "CDP=cdp-value")
        self.assertEqual(context.source, "cookie-file")
        self.assertNotIn("file-value", auth_summary(context))
        self.assertIn("SUB", redact_cookie(context.cookie))

    def test_environment_then_cdp(self):
        self.assertEqual(resolve_auth(env={"WEIBO_COOKIE": "ENV=env-value"}, cdp_loader=lambda port: "CDP=cdp-value").source, "environment")
        self.assertEqual(resolve_auth(env={}, cdp_loader=lambda port: "CDP=cdp-value").source, "cdp")


if __name__ == "__main__":
    unittest.main()
