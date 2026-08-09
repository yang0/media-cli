"""Dismiss modals, enter video mode, open attach, inject file, capture upload APIs."""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

import webview
from free_protocol.registry import AccountRegistry
from video_flow import JS_CLICK_VIDEO, js_attach_files_b64, js_eval, load_ref_files_b64

DISMISS_JS = r"""
(() => {
  const text = el => String(el && (el.innerText || el.textContent || el.getAttribute('aria-label') || '') || '').replace(/\s+/g,' ').trim();
  const visible = el => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
  };
  const labels = ['我知道了', '知道了', '关闭', 'Close', 'Got it', 'OK', '好的', '同意', 'Accept'];
  const clicked = [];
  for (const el of Array.from(document.querySelectorAll('button, [role=button], a, div, span'))) {
    if (!visible(el)) continue;
    const t = text(el);
    if (!t || t.length > 12) continue;
    if (labels.some(l => t === l || t.includes(l))) {
      try { el.click(); clicked.push(t); } catch (e) {}
    }
  }
  return { ok: true, clicked };
})()
"""

CLICK_ATTACH_JS = r"""
(() => {
  const text = el => String(el && (el.innerText || el.textContent || el.getAttribute('aria-label') || el.title || el.getAttribute('data-testid') || '') || '').replace(/\s+/g,' ').trim();
  const visible = el => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
  };
  const words = /attach|upload|image|file|photo|添加|上传|图片|文件|附件|参考|ref/i;
  const nodes = Array.from(document.querySelectorAll('button, [role=button], [data-testid], label, div, span, input'));
  const hits = [];
  for (const el of nodes) {
    if (!visible(el)) continue;
    const t = text(el);
    const testid = el.getAttribute('data-testid') || '';
    if (words.test(t) || words.test(testid) || testid.includes('upload') || testid.includes('attach')) {
      hits.push({ t: t.slice(0,40), testid, tag: el.tagName });
    }
  }
  // prefer explicit upload_file_button
  let target = document.querySelector('[data-testid="upload_file_button"]');
  if (!target) {
    for (const el of nodes) {
      if (!visible(el)) continue;
      const t = text(el);
      const testid = el.getAttribute('data-testid') || '';
      if (testid.includes('upload') || testid.includes('attach') || t === '上传' || t === '附件' || t.includes('参考图')) {
        target = el; break;
      }
    }
  }
  if (!target) {
    // try plus / paperclip near composer
    for (const el of nodes) {
      if (!visible(el)) continue;
      const t = text(el);
      if (t === '+' || t === '＋' || /添加|附件|图片/.test(t)) { target = el; break; }
    }
  }
  if (target) {
    try { target.click(); } catch (e) {}
    return { ok: true, clicked: text(target).slice(0,40), testid: target.getAttribute('data-testid')||'', hits: hits.slice(0,30) };
  }
  return { ok: false, reason: 'attach-btn-missing', hits: hits.slice(0,40), labels: nodes.filter(visible).map(text).filter(t=>t&&t.length<=20).slice(0,50) };
})()
"""

CAPTURE_JS = r"""
(() => {
  if (window.__dolaUploadCaptureInstalled) return { ok:true, reused:true };
  window.__dolaUploadHits = [];
  window.__dolaUploadCaptureInstalled = true;
  const push = (row) => { try { window.__dolaUploadHits.push(row); if (window.__dolaUploadHits.length>400) window.__dolaUploadHits.shift(); } catch(e){} };
  const interesting = (url) => /upload|image|file|alice|samantha|resource|imagex|tos|apply|attachment|media|cloud|blob|vlm|rc_/i.test(String(url||''));
  const previewBody = (body) => {
    try {
      if (!body) return '';
      if (typeof body === 'string') return body.slice(0, 1200);
      if (body instanceof FormData) return 'FormData:' + Array.from(body.keys()).join(',');
      if (body instanceof Blob) return 'Blob:' + body.size + ':' + (body.type||'');
      if (body instanceof ArrayBuffer) return 'ArrayBuffer:' + body.byteLength;
      return Object.prototype.toString.call(body);
    } catch(e){ return ''; }
  };
  const origFetch = window.fetch;
  window.fetch = async function(input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const method = (init && init.method) || (input && input.method) || 'GET';
    const bodyPreview = previewBody(init && init.body);
    const p = origFetch.apply(this, arguments);
    if (interesting(url) || /FormData|Blob|ArrayBuffer/.test(bodyPreview)) {
      p.then(async (resp) => {
        let text = '';
        try { text = (await resp.clone().text()).slice(0, 5000); } catch(e){}
        push({ t:Date.now(), kind:'fetch', url, method, status: resp.status, bodyPreview, response:text, ctype: resp.headers.get('content-type')||'' });
      }).catch(e => push({ t:Date.now(), kind:'fetch-err', url, method, error:String(e) }));
    }
    return p;
  };
  const XO = XMLHttpRequest.prototype.open;
  const XS = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(method, url){ this.__m=method; this.__u=url; return XO.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function(body){
    const url=this.__u||'', method=this.__m||'GET', bodyPreview=previewBody(body);
    if (interesting(url) || /FormData|Blob|ArrayBuffer/.test(bodyPreview)) {
      this.addEventListener('loadend', () => {
        push({ t:Date.now(), kind:'xhr', url, method, status:this.status, bodyPreview, response:String(this.responseText||'').slice(0,5000), ctype:this.getResponseHeader('content-type')||'' });
      });
    }
    return XS.apply(this, arguments);
  };
  return { ok:true, installed:true };
})()
"""

DOM_JS = r"""
(() => {
  const text = el => String(el && (el.innerText || el.textContent || el.getAttribute('aria-label') || '') || '').replace(/\s+/g,' ').trim();
  const visible = el => { if(!el) return false; const r=el.getBoundingClientRect(); const s=getComputedStyle(el); return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'; };
  const inputs = Array.from(document.querySelectorAll('input[type=file]')).map(el => ({accept:el.accept||'', multiple:!!el.multiple, visible:visible(el), id:el.id||'', cls:String(el.className||'').slice(0,60)}));
  return {
    href: location.href,
    fileInputs: inputs,
    labels: Array.from(document.querySelectorAll('button,[role=button],[data-testid]')).filter(visible).map(el=>({t:text(el).slice(0,30), testid:el.getAttribute('data-testid')||''})).filter(x=>x.t||x.testid).slice(0,60)
  };
})()
"""


def main() -> int:
    image = Path(sys.argv[1] if len(sys.argv) > 1 else r"E:\temp\avatar.webp")
    account = sys.argv[2] if len(sys.argv) > 2 else "AdoraCrosbytvzs5"
    rec = AccountRegistry().load(account)
    print(f"[c3] account={rec.accountId} image={image}")
    storage = Path(rec.profilePath)
    out = ROOT / "_upload_probe" / "capture_hits3.json"
    box: dict = {}

    def after_start():
        w = webview.windows[0]
        for i in range(20):
            try:
                href = js_eval(w, "location.href")
                if href and "dola.com" in str(href):
                    break
            except Exception:
                pass
            time.sleep(0.5)
        time.sleep(2)
        box["dismiss1"] = js_eval(w, DISMISS_JS)
        print("[c3] dismiss1", box["dismiss1"])
        time.sleep(0.8)
        box["install"] = js_eval(w, CAPTURE_JS)
        print("[c3] install", box["install"])
        box["video"] = js_eval(w, JS_CLICK_VIDEO)
        print("[c3] video", box["video"])
        time.sleep(2)
        box["dismiss2"] = js_eval(w, DISMISS_JS)
        print("[c3] dismiss2", box["dismiss2"])
        time.sleep(1)
        box["dom1"] = js_eval(w, DOM_JS)
        print("[c3] dom1 files", (box["dom1"] or {}).get("fileInputs"), "labels", (box["dom1"] or {}).get("labels"))
        box["attach_btn"] = js_eval(w, CLICK_ATTACH_JS)
        print("[c3] attach_btn", box["attach_btn"])
        time.sleep(1.5)
        box["dom2"] = js_eval(w, DOM_JS)
        print("[c3] dom2 files", (box["dom2"] or {}).get("fileInputs"), "labels", (box["dom2"] or {}).get("labels"))
        files = load_ref_files_b64([str(image)])
        # try multiple attach attempts
        for attempt in range(3):
            att = js_eval(w, js_attach_files_b64(files))
            print(f"[c3] attach attempt {attempt}", att)
            box[f"attach{attempt}"] = att
            if isinstance(att, dict) and att.get("ok"):
                break
            js_eval(w, CLICK_ATTACH_JS)
            time.sleep(1)
        for i in range(20):
            time.sleep(1)
            hits = js_eval(w, "window.__dolaUploadHits||[]") or []
            box["hits"] = hits
            print(f"[c3] hits={len(hits)} +{i+1}s")
            for h in hits[-4:]:
                print(" ", h.get("kind"), h.get("status"), str(h.get("url") or "")[:140], str(h.get("bodyPreview") or "")[:60])
            # stop if we got a non-monitor upload-like success
            if any(
                h.get("status") in (200, 201)
                and any(k in str(h.get("url") or "").lower() for k in ("upload", "apply", "alice", "resource", "file", "image"))
                and "monitor" not in str(h.get("url") or "").lower()
                and "skill/pack" not in str(h.get("url") or "")
                for h in hits
            ):
                # give a couple more seconds for multi-step upload
                if i >= 3:
                    break
        out.parent.mkdir(exist_ok=True)
        out.write_text(json.dumps(box, ensure_ascii=False, indent=2), encoding="utf-8")
        print("[c3] wrote", out)
        try:
            w.destroy()
        except Exception:
            pass

    webview.create_window(f"c3:{rec.accountId}", "https://www.dola.com/chat", width=1280, height=900)
    webview.start(after_start, gui="edgechromium", debug=False, private_mode=False, storage_path=str(storage))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
