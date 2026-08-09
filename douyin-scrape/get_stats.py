#!/usr/bin/env python3
"""Fetch per-video interaction stats (digg/comment/share/collect) via aweme/detail API."""
import json, time, urllib.parse, urllib.request

COOKIE_FILE = "G:/cookies/douyin.txt"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36"

def load_cookies(path):
    out = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            if line.startswith("#") or not line.strip():
                continue
            p = line.rstrip("\n").split("\t")
            if len(p) == 7:
                out.append(f"{p[5]}={p[6]}")
    return "; ".join(out)

def detail(aweme_id, cookies):
    params = {
        "device_platform": "webapp", "aid": "6383", "channel": "channel_pc_web",
        "aweme_id": aweme_id, "version_name": "26.0.0", "version_code": "260000",
    }
    url = "https://www.douyin.com/aweme/v1/web/aweme/detail/?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={
        "User-Agent": UA, "Referer": "https://www.douyin.com/",
        "Accept": "application/json, text/plain, */*", "Cookie": cookies,
    })
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read().decode("utf-8", "replace"))

def main():
    cookies = load_cookies(COOKIE_FILE)
    items = json.load(open("douyin_posts.json", encoding="utf-8"))
    rows = []
    for i, it in enumerate(items, 1):
        aid = it.get("aweme_id")
        try:
            d = detail(aid, cookies)
            det = d.get("aweme_detail") or {}
            st = det.get("statistics") or {}
            rows.append({
                "aweme_id": aid, "desc": (it.get("desc") or "")[:60],
                "digg": st.get("digg_count", 0), "comment": st.get("comment_count", 0),
                "share": st.get("share_count", 0), "collect": st.get("collect_count", 0),
                "play": st.get("play_count", 0),
            })
            print(f"[{i}/{len(items)}] {aid} digg={rows[-1]['digg']} cmt={rows[-1]['comment']} shr={rows[-1]['share']} col={rows[-1]['collect']} | {rows[-1]['desc'][:30]}")
        except Exception as e:
            print(f"[{i}/{len(items)}] {aid} ERROR {e}")
        time.sleep(0.3)
    rows.sort(key=lambda r: (r["digg"] + r["collect"] * 2 + r["share"] + r["comment"]), reverse=True)
    with open("video_stats.json", "w", encoding="utf-8") as f:
        json.dump(rows, f, ensure_ascii=False, indent=1)
    print("\n=== TOP 10 综合流量 ===")
    for r in rows[:10]:
        print(r["aweme_id"], "digg=", r["digg"], "cmt=", r["comment"], "shr=", r["share"], "col=", r["collect"], "|", r["desc"])
    print("\nsaved video_stats.json")

main()
