"""Upload reference images for image-to-video.

Pure ImageX ApplyImageUpload needs AWS-style signing. The Dola SPA already has
a working uploader, so we attach files inside a logged-in WebView (no chat
submit), capture CommitImageUpload results, then let free_protocol submit the
video task via external HTTP.

NEVER submit the composer message inside the WebView.
"""
from __future__ import annotations

import json
import mimetypes
import threading
import time
from pathlib import Path
from typing import Any, Callable, Optional

LogFn = Callable[[str], None]


def _log(log: Optional[LogFn], msg: str) -> None:
    text = f"[image_upload] {msg}"
    if log:
        log(text)
    else:
        print(text, flush=True)


def _build_attachment_from_commit(commit: dict[str, Any], *, name: str, local_path: str) -> dict[str, Any]:
    """Map ImageX CommitImageUpload Result → Dola completion attachment.

    Captured real UI shape (2026-08):
      type: 1 (int), identifier: uuid, image.{name,uri,image_ori{width,height,...}},
      parse_state/review_state/upload_status/progress/src
    """
    import uuid as _uuid

    result = commit.get("Result") or commit.get("result") or {}
    results = result.get("Results") or result.get("results") or []
    plugins = result.get("PluginResult") or result.get("pluginResult") or []
    uri = ""
    width = 0
    height = 0
    fmt = ""
    if results:
        first = results[0] if isinstance(results[0], dict) else {}
        uri = str(first.get("Uri") or first.get("uri") or "")
    if plugins:
        plug = plugins[0] if isinstance(plugins[0], dict) else {}
        uri = uri or str(plug.get("ImageUri") or plug.get("SourceUri") or plug.get("FileName") or "")
        width = int(plug.get("ImageWidth") or 0)
        height = int(plug.get("ImageHeight") or 0)
        fmt = str(plug.get("ImageFormat") or "")
    if not uri:
        raise RuntimeError(f"CommitImageUpload missing Uri for {name}: {json.dumps(commit)[:500]}")
    file_name = Path(name).name or Path(local_path).name or "image.webp"
    return {
        "type": 1,
        "identifier": str(_uuid.uuid4()),
        "image": {
            "name": file_name,
            "uri": uri,
            "image_ori": {
                "url": "",
                "width": width,
                "height": height,
                "format": fmt or "",
                "url_formats": {},
            },
        },
        "parse_state": 0,
        "review_state": 1,
        "upload_status": 1,
        "progress": 100,
        "src": "",
        # helpers for inject (not sent if stripped later)
        "key": uri,
        "name": file_name,
    }


def upload_images_via_webview(
    account_id: str,
    ref_paths: list[str],
    *,
    profile_path: str | Path,
    timeout: float = 90,
    log: Optional[LogFn] = None,
) -> list[dict[str, Any]]:
    """Attach local images in WebView, capture CommitImageUpload, return attachments."""
    if not ref_paths:
        return []
    paths = [Path(p) for p in ref_paths]
    for p in paths:
        if not p.is_file():
            raise FileNotFoundError(str(p))

    # Import lazily so t2v HTTP path does not need GUI deps until i2v.
    import sys

    webview_root = Path(__file__).resolve().parents[1]
    # Prefer the real webview package tree (video_patch.js lives next to video_flow.py).
    if str(webview_root) not in sys.path:
        sys.path.insert(0, str(webview_root))
    # Drop accidental site-packages shadow of video_flow if present.
    for mod in list(sys.modules):
        if mod == "video_flow" or mod.startswith("video_flow."):
            del sys.modules[mod]

    import webview

    from video_flow import JS_CLICK_VIDEO, js_attach_files_b64, js_eval, load_ref_files_b64

    dismiss_js = r"""
(() => {
  const text = el => String(el && (el.innerText || el.textContent || '') || '').replace(/\s+/g,' ').trim();
  const visible = el => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
  };
  const clicked = [];
  for (const el of Array.from(document.querySelectorAll('button, [role=button], div, span'))) {
    if (!visible(el)) continue;
    const t = text(el);
    if (t === '我知道了' || t === '知道了' || t === 'Got it' || t === 'Close') {
      try { el.click(); clicked.push(t); } catch (e) {}
    }
  }
  return { ok: true, clicked };
})()
"""
    capture_js = r"""
(() => {
  if (window.__dolaI2VCapture) return { ok: true, reused: true };
  window.__dolaI2VHits = [];
  window.__dolaI2VCapture = true;
  const push = (row) => {
    try {
      window.__dolaI2VHits.push(row);
      if (window.__dolaI2VHits.length > 200) window.__dolaI2VHits.shift();
    } catch (e) {}
  };
  const interesting = (url) => /prepare_upload|ApplyImageUpload|CommitImageUpload|vodupload|\/upload\/v1\//i.test(String(url || ''));
  const XO = XMLHttpRequest.prototype.open;
  const XS = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__m = method; this.__u = url;
    return XO.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (body) {
    const url = this.__u || '';
    const method = this.__m || 'GET';
    if (interesting(url)) {
      this.addEventListener('loadend', () => {
        push({
          t: Date.now(),
          kind: 'xhr',
          url,
          method,
          status: this.status,
          response: String(this.responseText || '').slice(0, 20000),
        });
      });
    }
    return XS.apply(this, arguments);
  };
  const origFetch = window.fetch;
  window.fetch = async function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const method = (init && init.method) || (input && input.method) || 'GET';
    const p = origFetch.apply(this, arguments);
    if (interesting(url)) {
      p.then(async (resp) => {
        let text = '';
        try { text = (await resp.clone().text()).slice(0, 20000); } catch (e) {}
        push({ t: Date.now(), kind: 'fetch', url, method, status: resp.status, response: text });
      }).catch(() => {});
    }
    return p;
  };
  return { ok: true, installed: true };
})()
"""

    box: dict[str, Any] = {"error": None, "attachments": [], "hits": []}
    storage = Path(profile_path)
    done = threading.Event()

    def after_start() -> None:
        try:
            w = webview.windows[0]
            deadline = time.time() + min(40.0, timeout)
            while time.time() < deadline:
                try:
                    href = js_eval(w, "location.href")
                    if href and "dola.com" in str(href):
                        break
                except Exception:
                    pass
                time.sleep(0.4)
            time.sleep(1.5)
            js_eval(w, dismiss_js)
            time.sleep(0.4)
            _log(log, f"install capture: {js_eval(w, capture_js)}")
            _log(log, f"video mode: {js_eval(w, JS_CLICK_VIDEO)}")
            time.sleep(2.0)
            js_eval(w, dismiss_js)
            # wait for file inputs created by video skill UI
            for i in range(20):
                n = js_eval(w, "document.querySelectorAll('input[type=file]').length")
                if int(n or 0) > 0:
                    _log(log, f"file inputs ready count={n} poll={i}")
                    break
                time.sleep(0.4)
            else:
                raise RuntimeError("video mode file input never appeared (dismiss overlays / re-login?)")

            files = load_ref_files_b64([str(p) for p in paths])
            attach = js_eval(w, js_attach_files_b64(files))
            _log(log, f"attach: {attach}")
            if not (isinstance(attach, dict) and attach.get("ok")):
                raise RuntimeError(f"attach failed: {attach}")

            # Wait for CommitImageUpload for each file
            need = len(paths)
            end = time.time() + max(30.0, timeout - 20)
            commits: list[dict[str, Any]] = []
            while time.time() < end and len(commits) < need:
                hits = js_eval(w, "window.__dolaI2VHits || []") or []
                box["hits"] = hits
                commits = []
                for h in hits:
                    url = str(h.get("url") or "")
                    if "CommitImageUpload" not in url:
                        continue
                    if int(h.get("status") or 0) not in (200, 201):
                        continue
                    try:
                        payload = json.loads(h.get("response") or "{}")
                    except Exception:
                        continue
                    commits.append(payload)
                if len(commits) >= need:
                    break
                time.sleep(0.6)

            if len(commits) < need:
                raise RuntimeError(
                    f"timed out waiting CommitImageUpload ({len(commits)}/{need}); "
                    f"hits={len(box.get('hits') or [])}"
                )

            attachments = []
            for idx, path in enumerate(paths):
                commit = commits[idx] if idx < len(commits) else commits[-1]
                attachments.append(
                    _build_attachment_from_commit(
                        commit,
                        name=path.name,
                        local_path=str(path),
                    )
                )
            box["attachments"] = attachments
            _log(log, f"uploaded attachments={len(attachments)} uris={[a.get('key') for a in attachments]}")
        except Exception as exc:
            box["error"] = f"{type(exc).__name__}: {exc}"
            _log(log, box["error"])
        finally:
            try:
                webview.windows[0].destroy()
            except Exception:
                pass
            done.set()

    webview.create_window(
        f"dola-i2v-upload:{account_id}",
        "https://www.dola.com/chat",
        width=1100,
        height=800,
    )
    # start blocks until window closes
    webview.start(
        after_start,
        gui="edgechromium",
        debug=False,
        private_mode=False,
        storage_path=str(storage),
    )
    if box.get("error"):
        raise RuntimeError(box["error"])
    atts = list(box.get("attachments") or [])
    if not atts:
        raise RuntimeError("image upload produced no attachments")
    return atts


def inject_attachments_into_completion(payload: dict[str, Any], attachments: list[dict[str, Any]]) -> dict[str, Any]:
    """Inject refs as a separate block_type=10052 message before the text message.

    Real UI order (captured):
      messages[0] = attachment-only (block_type 10052)
      messages[1] = text (block_type 10000, "生成视频：...")
    """
    if not attachments:
        return payload
    import uuid as _uuid

    # Strip helper keys not present in live UI payload.
    clean_atts: list[dict[str, Any]] = []
    for att in attachments:
        if not isinstance(att, dict):
            continue
        item = {
            "type": int(att.get("type") or 1),
            "identifier": str(att.get("identifier") or _uuid.uuid4()),
            "image": att.get("image")
            or {
                "name": att.get("name") or "image.webp",
                "uri": att.get("key") or att.get("uri") or "",
                "image_ori": {"url": "", "width": 0, "height": 0, "format": "", "url_formats": {}},
            },
            "parse_state": int(att.get("parse_state") or 0),
            "review_state": int(att.get("review_state") or 1),
            "upload_status": int(att.get("upload_status") or 1),
            "progress": int(att.get("progress") or 100),
            "src": str(att.get("src") or ""),
        }
        clean_atts.append(item)

    attach_msg = {
        "local_message_id": str(_uuid.uuid4()),
        "content_block": [
            {
                "block_type": 10052,
                "content": {
                    "attachment_block": {"attachments": clean_atts},
                    "pc_event_block": "",
                },
                "block_id": str(_uuid.uuid4()),
                "parent_id": "",
                "meta_info": [],
                "append_fields": [],
            }
        ],
        "message_status": 0,
    }

    messages = payload.get("messages")
    if not isinstance(messages, list):
        payload["messages"] = [attach_msg]
        return payload

    # Prepend attachment message; keep existing text message(s) after.
    # If the first message already is 10052, replace its attachments.
    if messages:
        first = messages[0]
        blocks = first.get("content_block") if isinstance(first, dict) else None
        if (
            isinstance(blocks, list)
            and blocks
            and isinstance(blocks[0], dict)
            and int(blocks[0].get("block_type") or 0) == 10052
        ):
            content = blocks[0].setdefault("content", {})
            if isinstance(content, dict):
                content["attachment_block"] = {"attachments": clean_atts}
            return payload
    payload["messages"] = [attach_msg, *messages]
    return payload
