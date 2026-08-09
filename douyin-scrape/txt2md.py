#!/usr/bin/env python3
"""Convert subtitles/*.txt -> subtitles/md/*.md with metadata header."""
import json, os, datetime

SRC_DIR = "subtitles"
OUT_DIR = os.path.join(SRC_DIR, "md")

def load():
    items = json.load(open("douyin_posts.json", encoding="utf-8"))
    meta = {}
    for it in items:
        v = it.get("video") or {}
        meta[it.get("aweme_id")] = {
            "title": (it.get("desc") or "").split("#")[0].split("#")[0].strip(),
            "create": it.get("create_time", 0),
            "duration": v.get("duration", 0),
            "stats": None,
        }
    try:
        for r in json.load(open("video_stats.json", encoding="utf-8")):
            if r["aweme_id"] in meta:
                meta[r["aweme_id"]]["stats"] = r
    except Exception:
        pass
    return meta

def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    meta = load()
    made = 0
    for fn in sorted(os.listdir(SRC_DIR)):
        if not fn.endswith(".txt"):
            continue
        base = fn[:-4]
        with open(os.path.join(SRC_DIR, fn), encoding="utf-8") as f:
            lines = [l.rstrip("\n") for l in f if l.strip()]
        title = base
        m = None
        for k, v in meta.items():
            if v["title"] and (v["title"] in base or base.endswith(v["title"][:10])):
                m = v
                break
        out = [f"# {title}", ""]
        if m:
            if m["create"]:
                out.append(f"- 发布时间：{datetime.datetime.fromtimestamp(m['create']).strftime('%Y-%m-%d')}")
            if m["duration"]:
                out.append(f"- 时长：{round(m['duration']/1000, 1)} 秒")
            s = m.get("stats")
            if s and s.get("digg"):
                out.append(f"- 点赞 {s['digg']} / 收藏 {s['collect']} / 转发 {s['share']} / 评论 {s['comment']}")
        out += ["", "---", ""]
        out += lines
        with open(os.path.join(OUT_DIR, base + ".md"), "w", encoding="utf-8") as f:
            f.write("\n".join(out) + "\n")
        made += 1
    print(f"converted {made} txt -> {OUT_DIR}")

main()
