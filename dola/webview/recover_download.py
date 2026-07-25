# -*- coding: utf-8 -*-
"""Re-resolve an expired Dola video URL from its original account/profile."""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import webview

from dola_webview import DEFAULT_PROFILES, profile_dir
from video_flow import download_url

ROOT = Path(__file__).resolve().parent
CORE_JS = (ROOT / "inject" / "dola_core.js").read_text(encoding="utf-8", errors="replace")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--account", required=True)
    parser.add_argument("--profiles", default=str(DEFAULT_PROFILES))
    parser.add_argument("--session-url", required=True)
    parser.add_argument("--message-id", default="")
    parser.add_argument("--vid", default="")
    parser.add_argument("--out", required=True)
    parser.add_argument("--timeout", type=float, default=120)
    args = parser.parse_args(argv)
    if not args.vid and not args.message_id:
        raise SystemExit("recovery needs vid or message-id")

    result: dict = {"error": "window closed before recovery completed"}
    holder: dict = {}

    def after_start():
        window = holder["window"]
        deadline = time.time() + args.timeout
        while time.time() < deadline:
            try:
                href = window.evaluate_js("location.href")
                if href and "dola.com" in str(href):
                    break
            except Exception:
                pass
            time.sleep(0.5)
        time.sleep(3)
        try:
            window.evaluate_js(CORE_JS)
            time.sleep(2)
            expression = f"""
            (() => {{
              const mid = {json.dumps(args.message_id)};
              let vid = {json.dumps(args.vid)};
              if (!vid && mid && window.__dolaGetVidByMessageId) vid = window.__dolaGetVidByMessageId(mid);
              if (/^https?:/i.test(vid || '')) vid = '';
              let resolved = vid && window.__dolaResolveVideoUrl ? window.__dolaResolveVideoUrl(vid) : null;
              let url = resolved && resolved.mainUrl || '';
              // The saved session belongs to one job. If Dola did not expose a
              // messageId/vid, reload that exact conversation and use its last
              // playable video, never a video from another chat/profile.
              if (!url) {{
                const videos = Array.from(document.querySelectorAll('video, video source[src]'));
                const item = videos.at(-1);
                url = item && (item.currentSrc || item.src || item.getAttribute('src')) || '';
                const match = url.match(/\\/(v0[a-zA-Z0-9_-]+)/);
                if (match && window.__dolaResolveVideoUrl) {{
                  vid = match[1];
                  resolved = window.__dolaResolveVideoUrl(vid);
                  url = resolved && resolved.mainUrl || url;
                }}
              }}
              return {{ vid: vid || '', url: url || '' }};
            }})()
            """
            resolved = window.evaluate_js(expression) or {}
            if not resolved.get("url"):
                raise RuntimeError("Dola did not return a recoverable URL for the saved messageId/vid")
            output = Path(args.out).resolve()
            download_url(str(resolved["url"]), output)
            result.clear()
            result.update({"ok": True, "file": str(output), "vid": resolved.get("vid") or args.vid, "url": resolved["url"]})
        except Exception as exc:
            result.clear()
            result.update({"error": str(exc)})
        finally:
            try:
                window.destroy()
            except Exception:
                pass

    storage = profile_dir(args.account, Path(args.profiles))
    window = webview.create_window(
        title=f"Dola download recovery - {args.account}",
        url=args.session_url,
        width=1000,
        height=760,
        confirm_close=False,
    )
    holder["window"] = window
    webview.start(after_start, gui="edgechromium", debug=False, private_mode=False, storage_path=str(storage))
    print(json.dumps(result, ensure_ascii=False), flush=True)
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
