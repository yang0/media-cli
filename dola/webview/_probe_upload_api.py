"""Probe Dola frontend bundles and account APIs for image-upload endpoints."""
from __future__ import annotations

import json
import re
import urllib.request
from pathlib import Path

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36"
OUT = Path(__file__).resolve().parent / "_upload_probe"
OUT.mkdir(exist_ok=True)


def fetch(url: str, headers: dict | None = None) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": UA, **(headers or {})})
    with urllib.request.urlopen(req, timeout=45) as resp:
        return resp.read()


def main() -> None:
    html = fetch("https://www.dola.com/chat").decode("utf-8", "ignore")
    (OUT / "chat.html").write_text(html, encoding="utf-8")
    scripts = re.findall(r'(?:src|href)="([^"]+\.js[^"]*)"', html)
    scripts += re.findall(r'https?://[^"\']+\.js[^"\']*', html)
    # dedupe
    seen = set()
    urls = []
    for s in scripts:
        if s.startswith("//"):
            s = "https:" + s
        elif s.startswith("/"):
            s = "https://www.dola.com" + s
        if s not in seen and s.endswith(".js") or ".js?" in s:
            seen.add(s)
            urls.append(s)
    print(f"scripts={len(urls)}")
    patterns = re.compile(
        r"(upload|attachment|file_uri|key_uri|imagex|ImageX|ApplyImage|prepare[_-]?upload|"
        r"get[_-]?upload|resource_id|/alice/|/samantha/|tos-|byteimg|ApplyImageInfo|"
        r"content_block|attachment_block|UploadAuth|GetToken|sts_token|object_key)",
        re.I,
    )
    hits = []
    for i, url in enumerate(urls[:40]):
        try:
            data = fetch(url)
        except Exception as exc:
            print(f"fail {url}: {exc}")
            continue
        text = data.decode("utf-8", "ignore")
        name = f"bundle_{i:02d}.js"
        # only keep if interesting
        if patterns.search(text):
            (OUT / name).write_text(text, encoding="utf-8", errors="replace")
            print(f"HIT {name} size={len(text)} url={url[:120]}")
            for m in patterns.finditer(text):
                start = max(0, m.start() - 80)
                end = min(len(text), m.end() + 120)
                snippet = text[start:end].replace("\n", " ")
                hits.append(snippet)
        else:
            print(f"skip {url[:100]} size={len(text)}")

    # also scan all unique short path-like tokens from hits
    path_like = set()
    for h in hits:
        for p in re.findall(r"[/][a-zA-Z0-9_./-]{4,80}", h):
            if any(k in p.lower() for k in ("upload", "image", "file", "alice", "samantha", "media", "tos", "apply")):
                path_like.add(p)
    (OUT / "hits.txt").write_text("\n\n".join(hits[:200]), encoding="utf-8")
    (OUT / "paths.txt").write_text("\n".join(sorted(path_like)), encoding="utf-8")
    print("paths:")
    for p in sorted(path_like)[:80]:
        print(p)


if __name__ == "__main__":
    main()
