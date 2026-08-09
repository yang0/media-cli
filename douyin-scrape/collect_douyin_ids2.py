#!/usr/bin/env python3
"""Open douyin user page in local Chrome (CDP 9221), scroll (python-driven), intercept /aweme/post API.
Avoids background-tab timer throttling by issuing short Runtime.evaluate calls."""
import asyncio, json, time, urllib.request, urllib.parse

import websockets

PROFILE = "https://www.douyin.com/user/MS4wLjABAAAAXLPiXrJBKge_wuWzClm02caG1JrbPnG_kI0umJnygx8"

def http_json(url, method="GET"):
    req = urllib.request.Request(url, method=method)
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read())

class CDP:
    def __init__(self, ws):
        self.ws = ws
        self.seq = 0
        self.pending = {}
        self.captured = []

    async def loop(self):
        async for raw in self.ws:
            msg = json.loads(raw)
            if "id" in msg:
                fut = self.pending.pop(msg["id"], None)
                if fut and not fut.done():
                    fut.set_result(msg.get("result", {}))
                continue
            if msg.get("method") == "Network.responseReceived":
                u = msg.get("params", {}).get("response", {}).get("url", "")
                if "aweme/post" in u:
                    rid = msg.get("params", {}).get("requestId")
                    try:
                        body = await self.cmd("Network.getResponseBody", {"requestId": rid})
                        self.captured.append({"url": u, "body": body.get("body", "")})
                    except Exception as e:
                        self.captured.append({"url": u, "body": f"ERR {e}"})

    async def cmd(self, method, params=None, timeout=30):
        self.seq += 1
        fut = asyncio.get_event_loop().create_future()
        self.pending[self.seq] = fut
        await self.ws.send(json.dumps({"id": self.seq, "method": method, "params": params or {}}))
        return await asyncio.wait_for(fut, timeout=timeout)

async def main():
    # close leftover douyin profile tabs
    try:
        for t in http_json("http://127.0.0.1:9221/json/list"):
            if "douyin.com/user" in t.get("url", "") and t.get("id"):
                try:
                    http_json(f"http://127.0.0.1:9221/json/close/{t['id']}", method="PUT")
                except Exception:
                    pass
    except Exception:
        pass
    tab = http_json(f"http://127.0.0.1:9221/json/new?{urllib.parse.quote(PROFILE, safe='')}", method="PUT")
    ws_url = tab["webSocketDebuggerUrl"]
    page_id = tab["id"]
    async with websockets.connect(ws_url, max_size=2**27) as ws:
        cdp = CDP(ws)
        lt = asyncio.create_task(cdp.loop())
        await cdp.cmd("Page.enable")
        await cdp.cmd("Runtime.enable")
        await cdp.cmd("Network.enable")
        await asyncio.sleep(7)

        # python-driven scroll loop
        last = -1
        stall = 0
        ids = set()
        for i in range(120):
            await cdp.cmd("Runtime.evaluate", {"expression": "window.scrollBy(0, 1500 + Math.random()*500)"})
            if i % 3 == 0:
                r = await cdp.cmd("Runtime.evaluate", {
                    "expression": "[...new Set([...document.querySelectorAll('a[href*=\"/video/\"], a[href*=\"/note/\"]')].map(a => (a.getAttribute('href')||'').match(/\\/(video|note)\\/(\\d+)/)).filter(m => m).map(m => m[2]))]",
                    "returnByValue": True})
                v = r.get("result", {}).get("value") or []
                ids.update(v)
                y = await cdp.cmd("Runtime.evaluate", {"expression": "window.scrollY", "returnByValue": True})
                yv = (y.get("result", {}).get("value") or 0)
                if yv == last:
                    stall += 1
                    if stall > 4:
                        break
                else:
                    stall = 0
                last = yv
            await asyncio.sleep(0.8)
        # final grab + counter
        r = await cdp.cmd("Runtime.evaluate", {
            "expression": "(() => { const ids=[...new Set([...document.querySelectorAll('a[href*=\"/video/\"], a[href*=\"/note/\"]')].map(a => (a.getAttribute('href')||'').match(/\\/(video|note)\\/(\\d+)/)).filter(m => m).map(m => m[2]))]; const c=document.body.innerText.match(/作品\\s*(\\d+)/); const pl=document.querySelector('[data-e2e=\"user-post-list\"]'); return { ids, counter: c?c[0]:null, listErr: pl?pl.innerText.slice(0,50):null }; })()",
            "returnByValue": True})
        val = r.get("result", {}).get("value") or {}
        print("DOM_IDS:", len(val.get("ids", [])), "| counter:", val.get("counter"), "| listErr:", val.get("listErr"))
        await asyncio.sleep(2)
        lt.cancel()
        try:
            await lt
        except asyncio.CancelledError:
            pass
        print("API_RESPONSES:", len(cdp.captured))
        api_ids = []
        for c in cdp.captured:
            try:
                d = json.loads(c["body"])
            except Exception:
                continue
            for it in d.get("aweme_list", []) or []:
                api_ids.append((it.get("aweme_id"), (it.get("desc") or "")[:60], it.get("create_time", 0), it.get("video", {}).get("duration", 0)))
        seen = set()
        uniq = []
        for x in api_ids:
            if x[0] not in seen:
                seen.add(x[0])
                uniq.append(x)
        print("API_PARSED:", len(uniq))
        for x in sorted(uniq, key=lambda t: t[2], reverse=True):
            print(x[0], "|", x[1], "|", x[2], "| dur:", x[3])
        with open("douyin_ids.json", "w", encoding="utf-8") as f:
            json.dump(uniq, f, ensure_ascii=False, indent=1)
        print("saved douyin_ids.json")
    try:
        http_json(f"http://127.0.0.1:9221/json/close/{page_id}", method="PUT")
    except Exception:
        pass

asyncio.run(main())
