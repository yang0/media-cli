#!/usr/bin/env python3
"""Open douyin user page in local Chrome (CDP 9221), scroll to load all posts, collect video IDs."""
import asyncio, json, sys, time, urllib.request

import websockets

PROFILE = "https://www.douyin.com/user/MS4wLjABAAAAXLPiXrJBKge_wuWzClm02caG1JrbPnG_kI0umJnygx8"

def http_json(url, method="GET", data=None):
    req = urllib.request.Request(url, method=method, data=data)
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read())

async def main():
    # open new tab
    tab = http_json(f"http://127.0.0.1:9221/json/new?{urllib.parse.quote(PROFILE, safe='')}", method="PUT")
    ws_url = tab["webSocketDebuggerUrl"]
    page_id = tab["id"]
    async with websockets.connect(ws_url, max_size=2**24) as ws:
        seq = 0
        async def cmd(method, params=None):
            nonlocal seq
            seq += 1
            await ws.send(json.dumps({"id": seq, "method": method, "params": params or {}}))
            while True:
                msg = json.loads(await ws.recv())
                if msg.get("id") == seq:
                    return msg.get("result", {})
        # enable Page + Runtime
        await cmd("Page.enable")
        await cmd("Runtime.enable")
        # wait for load
        await asyncio.sleep(6)
        # try scrolling a few times to trigger retry / load posts
        js_scroll = """
        (async () => {
          const ids = new Set();
          const grab = () => {
            document.querySelectorAll('a[href*="/video/"]').forEach(a => {
              const m = (a.getAttribute('href')||'').match(/\\/video\\/(\\d+)/);
              if (m) ids.add(m[1]);
            });
            document.querySelectorAll('a[href*="/note/"]').forEach(a => {
              const m = (a.getAttribute('href')||'').match(/\\/note\\/(\\d+)/);
              if (m) ids.add(m[1]);
            });
          };
          grab();
          let last = -1, stall = 0;
          for (let i = 0; i < 80; i++) {
            window.scrollBy(0, 1500);
            await new Promise(r => setTimeout(r, 900));
            grab();
            const y = window.scrollY;
            if (y === last) { stall++; if (stall > 4) break; } else stall = 0;
            last = y;
          }
          window.scrollTo(0, 0);
          return { count: ids.size, ids: [...ids] };
        })()
        """
        r = await cmd("Runtime.evaluate", {"expression": js_scroll, "awaitPromise": True, "returnByValue": True})
        val = r.get("result", {}).get("value")
        if val is None:
            print("EVAL_ERROR:", json.dumps(r, ensure_ascii=False)[:500])
        else:
            print(json.dumps(val, ensure_ascii=False))
    # close tab
    try:
        http_json(f"http://127.0.0.1:9221/json/close/{page_id}", method="PUT")
    except Exception:
        pass

import urllib.parse
asyncio.run(main())
