from __future__ import annotations

import re
import urllib.request
from pathlib import Path

OUT = Path(r"E:\projectHome\media-cli\dola\webview\_upload_probe")
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36"
CDN = "https://sf-flow-web-cdn.ciciai.com/obj/ocean-flow-web-sg/dola_web/static/js/"


def fetch(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=60) as resp:
        return resp.read()


def main() -> None:
    chat = (OUT / "bundle_02.js").read_text(encoding="utf-8", errors="ignore")
    # webpack chunk mapping: look for numeric chunk ids near upload modules
    keywords = [
        "uploaderToken",
        "ApplyImage",
        "apply_image",
        "GetUploadAuth",
        "get_upload_token",
        "upload_auth",
        "ImageX",
        "imagex",
        "file_uri",
        "key_uri",
        "attachment_block",
        "uploadAuth",
        "UploadAuth",
        "prepareUpload",
        "PrepareUpload",
        "ApplyImageInfo",
        "UploadFile",
        "simpleFile",
        "chat.upload",
        "resource_id",
        "object_key",
        "tos-cn",
        "byteimg",
        "upload_url",
        "StoreUri",
        "store_uri",
        "InnerUrl",
        "main_url",
        "uri\":",
        "/alice/upload",
        "/samantha/upload",
        "upload/v1",
        "file/upload",
        "ImageUpload",
    ]
    print("=== keyword hits in chat bundle ===")
    for kw in keywords:
        idx = chat.find(kw)
        if idx >= 0:
            print(f"\n[{kw}] @{idx}")
            print(chat[max(0, idx - 100) : idx + 180].replace("\n", " "))

    # extract chunk file names referenced
    chunks = sorted(set(re.findall(r"""["'](\d+)\.([a-f0-9]{6,})\.js["']""", chat)))
    print(f"\nchunk refs count={len(chunks)}")
    # download likely upload-related chunks mentioned near upload words
    near_ids = set()
    for m in re.finditer(r".{0,40}upload.{0,40}", chat, re.I):
        for cid in re.findall(r"\b(\d{3,5})\b", m.group(0)):
            near_ids.add(cid)
    # also explicit module ids from earlier dump
    for cid in ["96816", "85167", "1085", "4419", "1298", "65415", "53311", "24352", "148564", "586593"]:
        near_ids.add(cid)

    # map chunk id -> hash from webpack runtime if present
    # common pattern: {96816:"hash", ...}
    mapping = dict(re.findall(r"""(\d{2,5}):\s*["']([a-f0-9]{6,})["']""", chat))
    print(f"mapping entries={len(mapping)} near_ids={len(near_ids)}")

    downloaded = []
    for cid in sorted(near_ids):
        h = mapping.get(cid)
        if not h:
            continue
        url = f"{CDN}{cid}.{h}.js"
        try:
            data = fetch(url)
        except Exception as exc:
            print(f"fail {cid}: {exc}")
            continue
        text = data.decode("utf-8", "ignore")
        path = OUT / f"chunk_{cid}.js"
        # keep if looks upload related
        if re.search(r"upload|attachment|file_uri|imagex|ApplyImage|uri|tos", text, re.I):
            path.write_text(text, encoding="utf-8", errors="replace")
            downloaded.append((cid, len(text), url))
            print(f"HIT chunk {cid} size={len(text)}")
            for kw in keywords:
                i = text.find(kw)
                if i >= 0:
                    print(f"  {kw}: {text[max(0,i-80):i+140].replace(chr(10),' ')}")

    print("downloaded", len(downloaded))
    # final path harvest from all downloaded chunks
    all_paths = set()
    for p in OUT.glob("chunk_*.js"):
        t = p.read_text(encoding="utf-8", errors="ignore")
        for path in re.findall(r"""["'`](/[a-zA-Z0-9_./-]{4,100})["'`]""", t):
            if any(k in path.lower() for k in ("upload", "image", "file", "alice", "samantha", "media", "apply", "resource", "tos")):
                all_paths.add(path)
        for path in re.findall(r"""["'`]((?:https?:)?//[^"'`]{8,160})["'`]""", t):
            if any(k in path.lower() for k in ("upload", "imagex", "tos", "byteimg", "alice", "samantha")):
                all_paths.add(path)
    (OUT / "chunk_paths.txt").write_text("\n".join(sorted(all_paths)), encoding="utf-8")
    print("paths:")
    for p in sorted(all_paths):
        print(p)


if __name__ == "__main__":
    main()
