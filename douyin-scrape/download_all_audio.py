#!/usr/bin/env python3
"""Batch download all douyin videos (smallest full-mp4) and extract audio as mp3."""
import json, os, re, subprocess, sys, time, urllib.request, unicodedata

SRC = "douyin_posts.json"
OUT_DIR = "audio"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36"
REFERER = "https://www.douyin.com/"

def pick_smallest_mp4(it):
    """Pick bit_rate entry with smallest data_size whose primary url is a full CDN mp4 (not dash)."""
    v = it.get("video") or {}
    best = None
    for b in v.get("bit_rate") or []:
        urls = (b.get("play_addr") or {}).get("url_list") or []
        if not urls:
            continue
        u0 = urls[0]
        # dash urls are fragmented; skip them
        if "play/dash" in u0 or "aweme/v1/play" in u0:
            continue
        if not (u0.startswith("https://v") or u0.startswith("http://v")):
            continue
        size = b.get("data_size") or 10**12
        if best is None or size < best[0]:
            best = (size, b, u0)
    return best

def safe_name(title, idx, aid):
    t = re.split(r"[#＃]", title)[0].strip()
    t = re.sub(r'[\\/:*?"<>|\r\n]+', "_", t)
    t = re.sub(r"\s+", " ", t).strip()[:60]
    return f"{idx:02d}_{t}.mp3"

def download(url, dest):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Referer": REFERER})
    with urllib.request.urlopen(req, timeout=120) as r, open(dest, "wb") as f:
        while True:
            chunk = r.read(1 << 16)
            if not chunk:
                break
            f.write(chunk)

def extract_audio(mp4, mp3):
    r = subprocess.run(
        ["ffmpeg", "-y", "-v", "error", "-i", mp4, "-vn", "-acodec", "libmp3lame", "-b:a", "128k", mp3],
        capture_output=True, text=True)
    return r.returncode == 0, r.stderr[-300:]

def main():
    items = json.load(open(SRC, encoding="utf-8"))
    items.sort(key=lambda it: it.get("create_time", 0))
    os.makedirs(OUT_DIR, exist_ok=True)
    manifest = []
    ok = fail = skip = 0
    for idx, it in enumerate(items, 1):
        aid = it.get("aweme_id")
        title = (it.get("desc") or "untitled").replace("\n", " ")
        mp3name = safe_name(title, idx, aid)
        mp3path = os.path.join(OUT_DIR, mp3name)
        if os.path.exists(mp3path) and os.path.getsize(mp3path) > 10000:
            print(f"[{idx}/{len(items)}] SKIP exists: {mp3name}")
            skip += 1
            manifest.append([aid, title, it.get("create_time", 0), (it.get("video") or {}).get("duration", 0), mp3name, "skip"])
            continue
        pick = pick_smallest_mp4(it)
        if not pick:
            print(f"[{idx}/{len(items)}] FAIL no url: {title}")
            fail += 1
            manifest.append([aid, title, it.get("create_time", 0), 0, "", "no_url"])
            continue
        _, b, url = pick
        tmp = os.path.join(OUT_DIR, f"tmp_{aid}.mp4")
        try:
            t0 = time.time()
            download(url, tmp)
            size = os.path.getsize(tmp)
            good, err = extract_audio(tmp, mp3path)
            os.remove(tmp)
            if good and os.path.exists(mp3path):
                print(f"[{idx}/{len(items)}] OK {mp3name} ({size/1e6:.1f}MB -> {os.path.getsize(mp3path)/1e6:.1f}MB) {round(time.time()-t0,1)}s")
                ok += 1
                manifest.append([aid, title, it.get("create_time", 0), (it.get("video") or {}).get("duration", 0), mp3name, "ok"])
            else:
                print(f"[{idx}/{len(items)}] FAIL extract: {title} :: {err}")
                fail += 1
                manifest.append([aid, title, it.get("create_time", 0), 0, "", "extract_fail"])
        except Exception as e:
            print(f"[{idx}/{len(items)}] FAIL download: {title} :: {e}")
            fail += 1
            manifest.append([aid, title, it.get("create_time", 0), 0, "", f"dl:{e}"])
            if os.path.exists(tmp):
                os.remove(tmp)
        time.sleep(0.6)
    with open("manifest.csv", "w", encoding="utf-8-sig") as f:
        f.write("aweme_id,title,create_time,duration_ms,file,status\n")
        for row in manifest:
            f.write(",".join(str(x).replace(",", " ").replace('"', "") for x in row) + "\n")
    print(f"\nDONE ok={ok} fail={fail} skip={skip} total={len(items)}")

if __name__ == "__main__":
    main()
