# -*- coding: utf-8 -*-
"""Cookie helpers: pywebview cookies <-> Netscape for dola-cli account pool.

Also reads/decrypts Edge WebView2 profile Cookies SQLite when get_cookies() is empty.
"""
from __future__ import annotations

import base64
import json
import shutil
import sqlite3
import tempfile
import time
from pathlib import Path
from typing import Any, Iterable, List, Mapping


def _cookie_attr(cookie: Any, *names: str, default: Any = None) -> Any:
    if isinstance(cookie, Mapping):
        for name in names:
            if name in cookie:
                return cookie[name]
        return default
    for name in names:
        if hasattr(cookie, name):
            return getattr(cookie, name)
    # http.cookiejar.Cookie style
    mapping = {
        "name": "name",
        "value": "value",
        "domain": "domain",
        "path": "path",
        "secure": "secure",
        "expires": "expires",
        "httpOnly": "has_nonstandard_attr",
    }
    return default


def _parse_expires(expires: Any) -> int:
    if expires in (None, "", "Session", 0, "0", False):
        return 0
    try:
        expires_i = int(float(expires))
    except Exception:
        try:
            from email.utils import parsedate_to_datetime

            expires_i = int(parsedate_to_datetime(str(expires)).timestamp())
        except Exception:
            return 0
    if expires_i > 10_000_000_000:  # ms
        expires_i //= 1000
    return expires_i


def normalize_morsel(name: str, morsel: Any) -> dict | None:
    """Normalize http.cookies.Morsel (pywebview Edge returns SimpleCookie of these)."""
    if not name:
        return None
    try:
        value = morsel.value if hasattr(morsel, "value") else morsel.get(name, "")
    except Exception:
        value = getattr(morsel, "value", "") or ""
    domain = ""
    path = "/"
    secure = False
    http_only = False
    expires = 0
    try:
        domain = morsel.get("domain") or morsel.get("Domain") or ""
        path = morsel.get("path") or morsel.get("Path") or "/"
        secure = str(morsel.get("secure") or "").lower() not in ("", "false", "0", "none")
        # SimpleCookie marks HttpOnly as a flag key with empty value
        http_only = "httponly" in {k.lower() for k in getattr(morsel, "keys", lambda: [])()}
        if not http_only:
            http_only = bool(morsel.get("httponly") or morsel.get("HttpOnly"))
        expires = morsel.get("expires") or morsel.get("Expires") or 0
    except Exception:
        pass
    if not domain:
        return None
    return {
        "name": str(name),
        "value": "" if value is None else str(value),
        "domain": str(domain).strip(),
        "path": str(path or "/"),
        "secure": bool(secure),
        "httpOnly": bool(http_only),
        "expires": _parse_expires(expires),
    }


def expand_cookies(raw: Any) -> List[dict]:
    """Expand pywebview get_cookies() payload into normalized dicts."""
    if not raw:
        return []
    items = raw if isinstance(raw, (list, tuple)) else [raw]
    out: List[dict] = []
    for item in items:
        # Edge/pywebview: each entry is http.cookies.SimpleCookie with one Morsel
        try:
            from http.cookies import SimpleCookie, Morsel
        except Exception:
            SimpleCookie = tuple()  # type: ignore
            Morsel = tuple()  # type: ignore

        if SimpleCookie and isinstance(item, SimpleCookie):
            for key, morsel in item.items():
                c = normalize_morsel(key, morsel)
                if c:
                    out.append(c)
            continue
        if Morsel and isinstance(item, Morsel):
            key = getattr(item, "key", None) or ""
            c = normalize_morsel(str(key), item)
            if c:
                out.append(c)
            continue
        c = normalize_cookie(item)
        if c:
            out.append(c)
    return out


def normalize_cookie(cookie: Any) -> dict | None:
    """Normalize pywebview / http.cookies / jar cookie into a plain dict."""
    name = value = domain = path = None
    secure = False
    http_only = False
    expires = 0

    # Single Morsel
    try:
        from http.cookies import Morsel, SimpleCookie

        if isinstance(cookie, SimpleCookie):
            # Should be expanded via expand_cookies; take first if misused
            for key, morsel in cookie.items():
                return normalize_morsel(key, morsel)
            return None
        if isinstance(cookie, Morsel):
            return normalize_morsel(getattr(cookie, "key", "") or "", cookie)
    except Exception:
        pass

    if isinstance(cookie, Mapping):
        # Mapping that is actually a SimpleCookie-like {name: Morsel}
        if cookie and all(hasattr(v, "value") and hasattr(v, "key") for v in list(cookie.values())[:1]):
            try:
                key = next(iter(cookie.keys()))
                return normalize_morsel(str(key), cookie[key])
            except Exception:
                pass
        name = cookie.get("name") or cookie.get("Name")
        value = cookie.get("value") or cookie.get("Value")
        domain = cookie.get("domain") or cookie.get("Domain")
        path = cookie.get("path") or cookie.get("Path") or "/"
        secure = bool(cookie.get("secure") or cookie.get("Secure"))
        http_only = bool(
            cookie.get("httpOnly")
            or cookie.get("HttpOnly")
            or cookie.get("http_only")
            or cookie.get("httponly")
        )
        expires = cookie.get("expires") or cookie.get("Expires") or cookie.get("expiry") or 0
    else:
        # http.cookiejar.Cookie
        name = getattr(cookie, "name", None)
        value = getattr(cookie, "value", None)
        domain = getattr(cookie, "domain", None)
        path = getattr(cookie, "path", None) or "/"
        secure = bool(getattr(cookie, "secure", False))
        try:
            http_only = bool(
                cookie.has_nonstandard_attr("HttpOnly")
                or cookie.get_nonstandard_attr("HttpOnly")
                or cookie.has_nonstandard_attr("httponly")
            )
        except Exception:
            http_only = bool(
                getattr(cookie, "HttpOnly", False)
                or getattr(cookie, "httpOnly", False)
                or getattr(cookie, "httponly", False)
            )
        expires = getattr(cookie, "expires", None) or 0
        if name is None and hasattr(cookie, "get"):
            try:
                return normalize_cookie(dict(cookie))
            except Exception:
                pass

    if not name or domain is None:
        return None

    domain_s = str(domain).strip()
    return {
        "name": str(name),
        "value": "" if value is None else str(value),
        "domain": domain_s,
        "path": str(path or "/"),
        "secure": secure,
        "httpOnly": http_only,
        "expires": _parse_expires(expires),
    }


def filter_dola_related(cookies: Iterable[Any]) -> List[dict]:
    out: List[dict] = []
    for raw in cookies or []:
        c = normalize_cookie(raw)
        if not c:
            continue
        bag = f"{c['domain']} {c['name']}".lower()
        if any(
            key in bag
            for key in (
                "dola.com",
                "bytedance",
                "byteoversea",
                "tiktok",
                "snssdk",
                "capcut",
                "ttwid",
                "passport",
                "sessionid",
                "sid_",
                "uid_tt",
                "msToken",
                "odin_tt",
            )
        ):
            out.append(c)
    return out


def to_netscape(cookies: Iterable[dict]) -> str:
    lines = [
        "# Netscape HTTP Cookie File",
        "# https://curl.haxx.se/rfc/cookie_spec.html",
        "# Generated by dola-webview",
        "",
    ]
    now = int(time.time())
    for c in cookies:
        domain = c.get("domain") or ""
        if not domain or not c.get("name"):
            continue
        include_sub = "TRUE" if domain.startswith(".") else "FALSE"
        path = c.get("path") or "/"
        secure = "TRUE" if c.get("secure") else "FALSE"
        expires = int(c.get("expires") or 0)
        # Keep session cookies with far-future expiry so CLI loaders accept them
        if expires <= 0:
            expires = now + 180 * 24 * 3600
        prefix = "#HttpOnly_" if c.get("httpOnly") else ""
        lines.append(
            f"{prefix}{domain}\t{include_sub}\t{path}\t{secure}\t{expires}\t{c['name']}\t{c.get('value','')}"
        )
    return "\n".join(lines) + "\n"


def has_session(cookies: Iterable[dict]) -> bool:
    names = {c.get("name") for c in cookies}
    return bool(names & {"sessionid", "sessionid_ss", "sid_tt", "sid_guard", "uid_tt", "sid_ucp_v1"})


def write_netscape(path: str | Path, cookies: Iterable[dict]) -> Path:
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(to_netscape(cookies), encoding="utf-8")
    return p


def _chrome_expiry_to_unix(expires_utc: int) -> int:
    """Chromium expires_utc: microseconds since 1601-01-01 → unix seconds."""
    if not expires_utc:
        return 0
    try:
        return int(expires_utc / 1_000_000 - 11_644_473_600)
    except Exception:
        return 0


def _load_v10_key(local_state_path: Path) -> bytes | None:
    try:
        import win32crypt  # type: ignore
    except Exception:
        return None
    try:
        data = json.loads(local_state_path.read_text(encoding="utf-8"))
        enc = base64.b64decode(data["os_crypt"]["encrypted_key"])
        if enc[:5] != b"DPAPI":
            return None
        return win32crypt.CryptUnprotectData(enc[5:], None, None, None, 0)[1]
    except Exception:
        return None


def _decrypt_chromium_value(encrypted_value: bytes, key: bytes) -> str:
    if not encrypted_value:
        return ""
    # Prefer AES-GCM v10/v11/v20
    if encrypted_value[:3] in (b"v10", b"v11", b"v20") and key:
        try:
            from Crypto.Cipher import AES  # type: ignore

            nonce = encrypted_value[3:15]
            ciphertext = encrypted_value[15:-16]
            tag = encrypted_value[-16:]
            plain = AES.new(key, AES.MODE_GCM, nonce=nonce).decrypt_and_verify(ciphertext, tag)
            # Edge/Chromium host-bound cookies: 32-byte SHA256 prefix + value
            if len(plain) > 32:
                try:
                    return plain[32:].decode("utf-8")
                except Exception:
                    pass
            return plain.decode("utf-8", errors="replace")
        except Exception:
            pass
    # Legacy DPAPI whole-blob
    try:
        import win32crypt  # type: ignore

        return win32crypt.CryptUnprotectData(encrypted_value, None, None, None, 0)[1].decode(
            "utf-8", errors="replace"
        )
    except Exception:
        return ""


def find_webview2_user_data(profile_dir: str | Path) -> Path | None:
    """Locate EBWebView user-data root under a pywebview storage_path."""
    p = Path(profile_dir)
    candidates = [
        p / "EBWebView",
        p,
        p / "Default",
    ]
    for c in candidates:
        if (c / "Local State").exists() and (c / "Default" / "Network" / "Cookies").exists():
            return c
        if (c / "Network" / "Cookies").exists() and (c.parent / "Local State").exists():
            return c.parent
    # recursive shallow search
    if p.exists():
        for ls in p.rglob("Local State"):
            root = ls.parent
            if (root / "Default" / "Network" / "Cookies").exists():
                return root
    return None


def load_cookies_from_webview2_profile(profile_dir: str | Path) -> List[dict]:
    """Decrypt cookies from Edge WebView2 profile SQLite (fallback when get_cookies empty)."""
    root = find_webview2_user_data(profile_dir)
    if not root:
        return []
    cookies_db = root / "Default" / "Network" / "Cookies"
    local_state = root / "Local State"
    if not cookies_db.exists() or not local_state.exists():
        return []

    key = _load_v10_key(local_state)
    if not key:
        return []

    # Copy DB — live WebView may lock the file
    tmp = Path(tempfile.gettempdir()) / f"dola_wv2_cookies_{int(time.time() * 1000)}.db"
    try:
        shutil.copy2(cookies_db, tmp)
        # Also copy -journal/-wal if present for consistency
        for suffix in ("-journal", "-wal", "-shm"):
            side = Path(str(cookies_db) + suffix)
            if side.exists():
                try:
                    shutil.copy2(side, Path(str(tmp) + suffix))
                except Exception:
                    pass
    except Exception:
        return []

    out: List[dict] = []
    try:
        con = sqlite3.connect(f"file:{tmp}?mode=ro", uri=True)
        try:
            rows = con.execute(
                "SELECT host_key, name, value, encrypted_value, path, expires_utc, "
                "is_secure, is_httponly FROM cookies"
            ).fetchall()
        finally:
            con.close()
    except Exception:
        rows = []
    finally:
        try:
            tmp.unlink(missing_ok=True)
            for suffix in ("-journal", "-wal", "-shm"):
                Path(str(tmp) + suffix).unlink(missing_ok=True)
        except Exception:
            pass

    for host, name, value, enc, path, expires_utc, is_secure, is_httponly in rows:
        if not name or not host:
            continue
        val = (value or "").strip()
        if not val and enc:
            val = _decrypt_chromium_value(bytes(enc), key)
        if not val:
            continue
        out.append(
            {
                "name": str(name),
                "value": val,
                "domain": str(host),
                "path": str(path or "/"),
                "secure": bool(is_secure),
                "httpOnly": bool(is_httponly),
                "expires": _chrome_expiry_to_unix(int(expires_utc or 0)),
            }
        )
    return out


def parse_netscape(path: str | Path) -> List[dict]:
    text = Path(path).read_text(encoding="utf-8", errors="replace")
    out: List[dict] = []
    now = int(time.time())
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        http_only = False
        if line.startswith("#HttpOnly_"):
            http_only = True
            line = line[len("#HttpOnly_") :]
        elif line.startswith("#"):
            continue
        parts = line.split("\t")
        if len(parts) < 7:
            parts = line.split()
        if len(parts) < 7:
            continue
        domain, _flag, path, secure, expires, name, value = parts[:6] + ["\t".join(parts[6:])]
        try:
            exp = int(float(expires))
        except Exception:
            exp = 0
        if exp > 0 and exp < now:
            continue
        out.append(
            {
                "domain": domain,
                "path": path or "/",
                "secure": str(secure).upper() == "TRUE",
                "expires": exp,
                "name": name,
                "value": value,
                "httpOnly": http_only,
            }
        )
    return out
