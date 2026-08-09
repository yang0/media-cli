from __future__ import annotations

import re
import urllib.request
from pathlib import Path

OUT = Path(r"E:\projectHome\media-cli\dola\webview\_upload_probe")
OUT.mkdir(exist_ok=True)
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36"


def fetch(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=60) as resp:
        return resp.read()


def main() -> None:
    html = fetch("https://www.dola.com/chat").decode("utf-8", "ignore")
    (OUT / "chat2.html").write_text(html, encoding="utf-8")
    # any script-ish
    urls = set(re.findall(r"""(?:src|href)=["']([^"']+)["']""", html))
    urls |= set(re.findall(r"""https?://[^"'\\s>]+\.js[^"'\\s>]*""", html))
    print("raw urls", len(urls))
    for u in sorted(urls):
        if ".js" in u or "static" in u:
            print(u)

    # try common entry names on same CDN path
    base = "https://sf-flow-web-cdn.ciciai.com/obj/ocean-flow-web-sg/dola_web/static/js/"
    # extract hashes from already downloaded bundles for runtime
    chat = (OUT / "bundle_02.js").read_text(encoding="utf-8", errors="ignore")
    # look for publicPath / chunkFilename
    for m in re.finditer(r".{0,40}chunk.{0,80}", chat, re.I):
        s = m.group(0)
        if "js" in s or "hash" in s or "static" in s:
            print("chunkctx", s[:160])

    # search for path strings with upload in all files under OUT
    for p in OUT.glob("*.js"):
        t = p.read_text(encoding="utf-8", errors="ignore")
        # Find API path constants near Upload keywords more carefully
        for m in re.finditer(
            r"""(?:url|path|api|endpoint|URI|Uri)\s*[:=]\s*["'`]([^"'`]{4,120})["'`]""",
            t,
            re.I,
        ):
            val = m.group(1)
            if any(k in val.lower() for k in ("upload", "image", "file", "alice", "samantha", "resource", "apply", "tos")):
                print(p.name, "=>", val)

        # template strings with /alice or /samantha
        for m in re.finditer(r"""[`'"](/alice/[^`'"]+| /samantha/[^`'"]+)[`'"]""", t):
            print(p.name, "path", m.group(1))
        for m in re.finditer(r"""/(?:alice|samantha)/[a-zA-Z0-9_./-]{3,80}""", t):
            s = m.group(0)
            if any(k in s.lower() for k in ("upload", "file", "image", "media", "resource", "apply", "auth", "token")):
                print(p.name, "api", s)


if __name__ == "__main__":
    main()
