#!/usr/bin/env python3
"""Test download one douyin video (smallest mp4 format) and extract audio."""
import json, subprocess, sys, time, urllib.request

def pick_smallest(it):
    v = it.get("video") or {}
    best = None
    for b in v.get("bit_rate") or []:
        if b.get("format") != "mp4":
            continue
        urls = (b.get("play_addr") or {}).get("url_list") or []
        if not urls:
            continue
        size = b.get("data_size") or 10**12
        if best is None or size < best[0]:
            best = (size, b, urls)
    return best

items = json.load(open("douyin_posts.json", encoding="utf-8"))
it = items[0]
size, b, urls = pick_smallest(it)
url = urls[0]
print("picked:", b.get("url_key"), "size:", size)
req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/150.0.0.0 Safari/537.36", "Referer": "https://www.douyin.com/"})
t0 = time.time()
with urllib.request.urlopen(req, timeout=60) as r, open("test_video.mp4", "wb") as f:
    total = 0
    while True:
        chunk = r.read(1 << 16)
        if not chunk:
            break
        f.write(chunk)
        total += len(chunk)
print("downloaded:", total, "bytes in", round(time.time() - t0, 1), "s")
# probe
r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration,size:stream=codec_type,codec_name", "-of", "json", "test_video.mp4"], capture_output=True, text=True)
print("PROBE:", r.stdout[:600])
