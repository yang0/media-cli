import os
import tempfile
import unittest
from pathlib import Path

import test_support  # noqa: F401

from zhihu_cli.auth import AuthError, auth_summary, parse_cookie_text, redact_cookie, resolve_auth


class AuthTests(unittest.TestCase):
    def test_cookie_formats_and_redaction(self):
        netscape = ".zhihu.com\tTRUE\t/\tTRUE\t0\tz_c0\tsecret\n"
        self.assertEqual(parse_cookie_text(netscape), "z_c0=secret")
        self.assertEqual(parse_cookie_text("#HttpOnly_.zhihu.com\tTRUE\t/\tTRUE\t0\td_c0\tvalue\n"), "d_c0=value")
        self.assertEqual(parse_cookie_text('{"cookies":[{"name":"d_c0","value":"value"}]}'), "d_c0=value")
        self.assertEqual(redact_cookie("z_c0=secret; d_c0=value"), "<cookie:z_c0,d_c0>")
        summary = auth_summary(resolve_auth(env={"ZHIHU_COOKIE": "z_c0=secret"}, cdp_loader=lambda _: ""))
        self.assertEqual(summary, "认证可用：source=environment cookie_count=1")
        self.assertNotIn("secret", summary)
        self.assertNotIn("z_c0", summary)

    def test_precedence_file_then_environment_then_cdp(self):
        with tempfile.TemporaryDirectory() as temp:
            cookie_file = Path(temp) / "cookies.txt"
            cookie_file.write_text("Cookie: file_cookie=file-secret", encoding="utf-8")
            context = resolve_auth(cookie_file=cookie_file, env={"ZHIHU_COOKIE": "env_cookie=env-secret"}, cdp_loader=lambda _: "cdp_cookie=cdp-secret")
            self.assertEqual((context.source, context.cookie), ("cookie-file", "file_cookie=file-secret"))
        context = resolve_auth(env={"ZHIHU_COOKIE": "env_cookie=env-secret"}, cdp_loader=lambda _: "cdp_cookie=cdp-secret")
        self.assertEqual(context.source, "environment")
        context = resolve_auth(env={}, cdp_loader=lambda _: "cdp_cookie=cdp-secret")
        self.assertEqual(context.source, "cdp")

    def test_optional_auth_does_not_fail_when_cdp_is_unavailable(self):
        self.assertIsNone(resolve_auth(env={}, cdp_loader=lambda _: (_ for _ in ()).throw(AuthError("offline")), required=False))


if __name__ == "__main__":
    unittest.main()
