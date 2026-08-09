#!/usr/bin/env python3
"""Launch isolated Chrome (port 9222), inject douyin cookies, load profile, scroll, intercept API."""
import asyncio, json, os, re, subprocess, sys, time, urllib.request, urllib.parse

import websockets

PROFILE = "https://www.douyin.com/user/MS4wLjABAAAAXLPiXrJBKge_wuWzClm02caG1JrbPnG_kI0umJnygx8"
COOKIE_FILE = "G:/cookies/douyin_fresh.txt"
CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
DATA_DIR = r"G:\tmp\chrome-cdp-douyin"

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

    async def cmd(self, method, params=None):
        self.seq += 1
        fut = asyncio.get_event_loop().create_future()
        self.pending[self.seq] = fut
        await self.ws.send(json.dumps({"id": self.seq, "method": method, "params": params or {}}))
        return await asyncio.wait_for(fut, timeout=30)

def load_cookies(path):
    out = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            if line.startswith("#") or not line.strip():
                continue
            p = line.rstrip("\n").split("\t")
            if len(p) == 7:
                out.append({
                    "name": p[5], "value": p[6], "domain": p[0],
                    "path": p[2], "secure": p[3] == "TRUE",
                    "expires": max(int(p[4]), 0) if p[4].isdigit() else 0,
                })
    return out

async def main():
    # launch chrome
    subprocess.Popen([CHROME, f"--remote-debugging-port=9222", f"--user-data-dir={DATA_DIR}",
                      "--no-first-run", "--no-default-browser-check", "--window-size=1400,900", "about:blank"])
    # wait for port
    for _ in range(30):
        try:
            http_json("http://127.0.0.1:9222/json/version")
            break
        except Exception:
            time.sleep(1)
    else:
        sys.exit("chrome 9222 not up")

    # new tab
    tab = http_json("http://127.0.0.1:9222/json/new?about:blank", method="PUT")
    ws_url = tab["webSocketDebuggerUrl"]
    page_id = tab["id"]
    async with websockets.connect(ws_url, max_size=2**27) as ws:
        cdp = CDP(ws)
        lt = asyncio.create_task(cdp.loop())
        await cdp.cmd("Page.enable")
        await cdp.cmd("Runtime.enable")
        await cdp.cmd("Network.enable")

        # inject cookies
        cookies = load_cookies(COOKIE_FILE)
        ok = 0
        for c in cookies:
            r = await cdp.cmd("Network.setCookie", {
                "name": c["name"], "value": c["value"], "domain": c["domain"],
                "path": c["path"], "secure": c["secure"], "expires": c["expires"],
                "url": f"https://{c['domain'].lstrip('.')}/",
            })
            if r.get("success"):
                ok += 1
        print(f"cookies injected: {ok}/{len(cookies)}")

        # navigate
        await cdp.cmd("Page.navigate", {"url": PROFILE})
        await asyncio.sleep(8)

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
          for (let i = 0; i < 160; i++) {
            window.scrollBy(0, 1500 + Math.random()*500);
            await new Promise(r => setTimeout(r, 800));
            grab();
            const y = window.scrollY;
            if (y === last) { stall++; if (stall > 8) break; } else stall = 0;
            last = y;
          }
          const counter = document.body.innerText.match(/作品\\s*(\\d+)/);
          const postList = document.querySelector('[data-e2e="user-post-list"]');
          window.scrollTo(0, 0);
          return { count: ids.size, ids: [...ids], counter: counter ? counter[0] : null, listErr: postList ? postList.innerText.slice(0,60) : null };
        })()
        """
        r = await cdp.cmd("Runtime.evaluate", {"expression": js_scroll, "awaitPromise": True, "returnByValue": True})
        val = r.get("result", {}).get("value")
        print("RESULT:", json.dumps(val, ensure_ascii=False)[:1500])
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
                api_ids.append((it.get("aweme_id"), (it.get("desc") or "")[:50], it.get("create_time", 0), it.get("video", {}).get("duration", 0)))
        seen = set()
        uniq = []
        for x in api_ids:
            if x[0] not in seen:
                seen.add(x[0]); uniq.append(x)
        print("API_PARSED:", len(uniq))
        for x in sorted(uniq, key=lambda t: t[2], reverse=True):
            print(x[0], "|", x[1], "|", x[2], "| dur:", x[3])
        with open("douyin_ids.json", "w", encoding="utf-8") as f:
            json.dump(uniq, f, ensure_ascii=False, indent=1)
        print("saved douyin_ids.json")
    try:
        http_json(f"http://127.0.0.1:9222/json/close/{page_id}", method="PUT")
    except Exception:
        pass

asyncio.run(main())
