#!/usr/bin/env python3
"""Test douyin web API with logged-in cookies (no X-Bogus)."""
import json, urllib.request, urllib.parse

SEC_UID = "MS4wLjABAAAAXLPiXrJBKge_wuWzClm02caG1JrbPnG_kI0umJnygx8"
COOKIE_FILE = "G:/cookies/douyin.txt"

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

params = {
    "device_platform": "webapp", "aid": "6383", "channel": "channel_pc_web",
    "sec_user_id": SEC_UID, "max_cursor": 0, "locate_query": "false",
    "show_live_replay_strategy": "1", "need_time_list": "1", "time_list_query": "0",
    "whale_cut_tag": "1", "version_name": "26.0.0", "version_code": "260000",
    "compatible_mode": "1", "is_collection": "0", "count": 18,
}
url = "https://www.douyin.com/aweme/v1/web/aweme/post/?" + urllib.parse.urlencode(params)
req = urllib.request.Request(url, headers={
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36",
    "Referer": "https://www.douyin.com/user/" + SEC_UID,
    "Accept": "application/json, text/plain, */*",
    "Cookie": load_cookies(COOKIE_FILE),
})
try:
    with urllib.request.urlopen(req, timeout=25) as r:
        raw = r.read().decode("utf-8", "replace")
        print("STATUS:", r.status, "LEN:", len(raw))
        try:
            d = json.loads(raw)
            print("status_code:", d.get("status_code"), "| items:", len(d.get("aweme_list") or []), "| has_more:", d.get("has_more"), "| cursor:", d.get("cursor"))
            for it in (d.get("aweme_list") or [])[:3]:
                print("  ", it.get("aweme_id"), "|", (it.get("desc") or "")[:40])
        except Exception:
            print("NON-JSON:", raw[:300])
except Exception as e:
    print("ERROR:", e)
