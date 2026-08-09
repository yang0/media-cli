from __future__ import annotations

import re
import urllib.request
from pathlib import Path

OUT = Path(r"E:\projectHome\media-cli\dola\webview\_upload_probe")
UA = "Mozilla/5.0"
CDN = "https://sf-flow-web-cdn.ciciai.com/obj/ocean-flow-web-sg/dola_web/static/js/"


def fetch(url: str) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=60) as resp:
        return resp.read().decode("utf-8", "ignore")


def main() -> None:
    # Search local bundles first
    for p in list(OUT.glob("*.js")) + list(OUT.glob("chunk_*.js")):
        t = p.read_text(encoding="utf-8", errors="ignore")
        if "prepare_upload" in t or "PrepareUpload" in t or "CommitImageUpload" in t or "ApplyImageUpload" in t:
            print("LOCAL HIT", p.name)
            for kw in [
                "prepare_upload",
                "CommitImageUpload",
                "ApplyImageUpload",
                "finish_upload",
                "complete_upload",
                "resource/commit",
                "resource/finish",
                "resource/create",
                "resource/apply",
                "upload_auth",
                "StoreUri",
                "session_key",
                "SessionKey",
                "attachment",
                "key",
                "uri",
            ]:
                i = t.find(kw)
                if i >= 0:
                    print(f"  [{kw}] {t[max(0,i-120):i+200].replace(chr(10),' ')}")

    # Try to download more chunks by guessing from chat HTML and main bundles
    chat = (OUT / "bundle_02.js").read_text(encoding="utf-8", errors="ignore") if (OUT / "bundle_02.js").exists() else ""
    # webpack async chunk mapping often in runtime: find patterns like 96816:"abcd"
    maps = dict(re.findall(r'(\d{2,6}):"([a-f0-9]{6,})"', chat))
    print("map size", len(maps))
    # Also search lib-polyfill and 1345
    for name in ["bundle_01.js"]:
        p = OUT / name
        if p.exists():
            maps.update(dict(re.findall(r'(\d{2,6}):"([a-f0-9]{6,})"', p.read_text(encoding="utf-8", errors="ignore"))))
    print("map size2", len(maps))

    # Search all downloaded for alice/resource
    for p in OUT.glob("*.js"):
        t = p.read_text(encoding="utf-8", errors="ignore")
        for m in re.finditer(r"/alice/resource/[a-zA-Z0-9_./-]+", t):
            print(p.name, m.group(0))


if __name__ == "__main__":
    main()
