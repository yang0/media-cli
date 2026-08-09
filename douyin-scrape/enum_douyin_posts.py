#!/usr/bin/env python3
"""Enumerate ALL douyin user posts via web API pagination (logged-in cookies)."""
import json, time, urllib.request, urllib.parse

SEC_UID = "MS4wLjABAAAAXLPiXrJBKge_wuWzClm02caG1JrbPnG_kI0umJnygx8"
COOKIE_FILE = "G:/cookies/douyin.txt"
OUT = "douyin_posts.json"

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

def fetch(max_cursor=0, count=18):
    params = {
        "device_platform": "webapp", "aid": "6383", "channel": "channel_pc_web",
        "sec_user_id": SEC_UID, "max_cursor": max_cursor, "locate_query": "false",
        "show_live_replay_strategy": "1", "need_time_list": "1", "time_list_query": "0",
        "whale_cut_tag": "1", "version_name": "26.0.0", "version_code": "260000",
        "compatible_mode": "1", "is_collection": "0", "count": count,
    }
    url = "https://www.douyin.com/aweme/v1/web/aweme/post/?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36",
        "Referer": "https://www.douyin.com/user/" + SEC_UID,
        "Accept": "application/json, text/plain, */*",
        "Cookie": load_cookies(COOKIE_FILE),
    })
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode("utf-8", "replace"))

def main():
    all_items = []
    cursor = 0
    seen = set()
    for page in range(20):
        data = fetch(max_cursor=cursor)
        items = data.get("aweme_list") or []
        print(f"page {page}: items={len(items)} status={data.get('status_code')} has_more={data.get('has_more')} cursor={data.get('max_cursor', data.get('cursor'))}")
        for it in items:
            aid = it.get("aweme_id")
            if aid not in seen:
                seen.add(aid)
                all_items.append(it)
        nc = data.get("max_cursor") or data.get("cursor")
        if not data.get("has_more") or not items or nc is None:
            break
        cursor = nc
        time.sleep(0.5)
    print("TOTAL:", len(all_items))
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(all_items, f, ensure_ascii=False)
    print("saved", OUT)

    # summary + subtitle check
    subs = 0
    for it in all_items:
        v = it.get("video") or {}
        desc = (it.get("desc") or "").replace("\n", " ")[:50]
        has_sub = bool(v.get("subtitle") or it.get("caption_infos"))
        if has_sub:
            subs += 1
        print(it.get("aweme_id"), "|", it.get("create_time", 0), "| dur:", v.get("duration"), "|", desc)
    print("items with subtitle fields:", subs, "/", len(all_items))

main()
