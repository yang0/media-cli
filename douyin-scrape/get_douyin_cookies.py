#!/usr/bin/env python3
"""Extract fresh douyin cookies from local Chrome (CDP port 9221) -> Netscape cookies.txt"""
import asyncio, json, sys, time, urllib.request

WS = None
try:
    import websockets
    WS = "websockets"
except ImportError:
    try:
        import websocket
        WS = "websocket-client"
    except ImportError:
        sys.exit("no websocket lib")

def http_json(url):
    with urllib.request.urlopen(url, timeout=5) as r:
        return json.loads(r.read())

async def main():
    tabs = http_json("http://127.0.0.1:9221/json/list")
    page = None
    for t in tabs:
        if t.get("type") == "page" and t.get("webSocketDebuggerUrl"):
            page = t
            break
    if not page:
        sys.exit("no page target found")
    ws_url = page["webSocketDebuggerUrl"]

    cookies = []
    if WS == "websockets":
        async with websockets.connect(ws_url, max_size=2**24) as ws:
            req = {"id": 1, "method": "Network.getCookies",
                   "params": {"urls": ["https://www.douyin.com/", "https://www.iesdouyin.com/"]}}
            await ws.send(json.dumps(req))
            while True:
                msg = json.loads(await ws.recv())
                if msg.get("id") == 1:
                    cookies = msg.get("result", {}).get("cookies", [])
                    break
    else:
        import websocket
        ws = websocket.create_connection(ws_url, timeout=10)
        ws.send(json.dumps({"id": 1, "method": "Network.getCookies",
                            "params": {"urls": ["https://www.douyin.com/", "https://www.iesdouyin.com/"]}}))
        while True:
            msg = json.loads(ws.recv())
            if msg.get("id") == 1:
                cookies = msg.get("result", {}).get("cookies", [])
                break
        ws.close()

    if not cookies:
        sys.exit("no douyin cookies found in Chrome")

    lines = ["# Netscape HTTP Cookie File", "# extracted from Chrome via CDP"]
    for c in cookies:
        dom = c["domain"]
        if "douyin.com" not in dom or not c.get("name"):
            continue
        if dom.startswith("."):
            inc_sub = "TRUE"
        else:
            inc_sub = "FALSE"
        secure = "TRUE" if c.get("secure") else "FALSE"
        expires = int(c.get("expires", 0) or 0)
        if expires < 0:
            expires = 0
        lines.append("\t".join([dom, inc_sub, c.get("path", "/"), secure, str(expires), c["name"], c["value"]]))

    out = "G:/cookies/douyin_fresh.txt"
    with open(out, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    print(f"wrote {len(lines)-2} cookies -> {out}")
    names = [c["name"] for c in cookies if "douyin.com" in c.get("domain", "")]
    print("names:", ",".join(names))

asyncio.run(main())
