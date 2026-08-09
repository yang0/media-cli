"""Pure-HTTP image upload probe using free_protocol account cookies."""
from __future__ import annotations

import hashlib
import json
import mimetypes
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

from cookie_util import filter_dola_related, has_session, load_cookies_from_webview2_profile, parse_netscape
from free_protocol.registry import AccountRegistry
from free_protocol.template_patch import build_browser_headers, cookies_to_header
from free_protocol.video_api import _completion_url, client_profile_dict, load_account_cookies

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36 Edg/150.0.0.0"


def req_json(method: str, url: str, headers: dict, body: bytes | None = None, timeout: float = 60):
    r = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            raw = resp.read()
            ctype = resp.headers.get("Content-Type") or ""
            text = raw.decode("utf-8", "replace")
            return resp.status, ctype, text, raw
    except urllib.error.HTTPError as exc:
        raw = exc.read()
        text = raw.decode("utf-8", "replace")
        return exc.code, str(exc.headers.get("Content-Type") or ""), text, raw


def main() -> int:
    image = Path(sys.argv[1] if len(sys.argv) > 1 else r"E:\temp\avatar.webp")
    account = sys.argv[2] if len(sys.argv) > 2 else "AdoraCrosbytvzs5"
    rec = AccountRegistry().load(account)
    cookies = load_account_cookies(rec)
    if not has_session(cookies):
        print("no session")
        return 2
    cookie_header = cookies_to_header(cookies)
    profile = client_profile_dict(rec)
    common = build_browser_headers(
        cookie_header=cookie_header,
        client_profile=profile,
        content_type="application/json",
        referer="https://www.dola.com/chat",
        extra={"Origin": "https://www.dola.com"},
    )

    # mirror query params from completion URL style
    q = {
        "version_code": "20800",
        "language": profile.get("language") or "zh-CN",
        "device_platform": "web",
        "doubao_device_platform": "web",
        "aid": "495671",
        "real_aid": "495671",
        "pkg_type": "release_version",
        "device_id": str(profile.get("deviceId") or ""),
        "web_id": str(profile.get("webId") or ""),
        "tea_uuid": str(profile.get("teaUuid") or profile.get("webId") or ""),
        "region": str(profile.get("region") or "SG"),
        "sys_region": str(profile.get("sysRegion") or "SG"),
        "samantha_web": "1",
        "web_platform": "browser",
        "use-olympus-account": "1",
        "web_tab_id": str(uuid.uuid4()),
    }
    # drop empties
    q = {k: v for k, v in q.items() if v}
    qs = urllib.parse.urlencode(q)
    prepare_url = f"https://www.dola.com/alice/resource/prepare_upload?{qs}"
    body = json.dumps({"tenant_id": "5", "scene_id": "4", "resource_type": 2}, separators=(",", ":")).encode()
    print("[1] prepare_upload", prepare_url)
    status, ctype, text, _ = req_json("POST", prepare_url, common, body)
    print(" status", status, "resp", text[:1500])
    data = json.loads(text).get("data") or {}
    service_id = data.get("service_id")
    upload_host = data.get("upload_host")
    auth = data.get("upload_auth_token") or {}
    print(" service_id", service_id, "upload_host", upload_host)
    if not service_id or not upload_host:
        return 3

    raw = image.read_bytes()
    ext = image.suffix or ".webp"
    apply_q = {
        "Action": "ApplyImageUpload",
        "Version": "2018-08-01",
        "ServiceId": service_id,
        "FileSize": str(len(raw)),
        "FileExtension": ext,
        "s": uuid.uuid4().hex[:12],
    }
    apply_url = f"https://{upload_host}/?{urllib.parse.urlencode(apply_q)}"
    # ImageX needs AWS-style signing with STS keys — the browser SDK signs using access/secret/session.
    # Without signing, Apply may fail. Try with session token headers first.
    apply_headers = {
        "User-Agent": UA,
        "Origin": "https://www.dola.com",
        "Referer": "https://www.dola.com/",
        "Accept": "*/*",
        # Some SDKs pass these:
        "X-Amz-Security-Token": auth.get("session_token") or "",
        "X-Security-Token": auth.get("session_token") or "",
    }
    print("[2] ApplyImageUpload", apply_url)
    status, ctype, text, _ = req_json("GET", apply_url, apply_headers)
    print(" status", status, "resp", text[:2000])

    # If Apply fails, try POST empty
    if status >= 400:
        status, ctype, text, _ = req_json("POST", apply_url, {**apply_headers, "Content-Type": "application/json"}, b"{}")
        print("[2b] Apply POST status", status, text[:2000])

    out = Path(ROOT / "_upload_probe" / "http_upload_probe.json")
    out.write_text(
        json.dumps(
            {
                "prepare": data,
                "apply_status": status,
                "apply_text": text[:5000],
                "auth_keys": list(auth.keys()),
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    print("wrote", out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
