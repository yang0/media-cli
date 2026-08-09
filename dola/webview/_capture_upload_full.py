"""Capture full image upload chain after attach; wait long enough for Commit."""
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
  const visible = el => { if(!el) return false; const r=el.getBoundingClientRect(); const s=getComputedStyle(el); return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'; };
  const labels = ['我知道了','知道了','关闭','Got it','OK','好的'];
  const clicked=[];
  for (const el of Array.from(document.querySelectorAll('button,[role=button],div,span'))) {
    if (!visible(el)) continue;
    const t=text(el); if(!t||t.length>12) continue;
    if (labels.some(l=>t===l||t.includes(l))) { try{el.click(); clicked.push(t);}catch(e){} }
  }
  return {ok:true, clicked};
})()
"""

CAPTURE_JS = r"""
(() => {
  if (window.__dolaUploadCaptureInstalled) return {ok:true,reused:true};
  window.__dolaUploadHits=[]; window.__dolaUploadCaptureInstalled=true;
  const push=row=>{ try{ window.__dolaUploadHits.push(row); if(window.__dolaUploadHits.length>500) window.__dolaUploadHits.shift(); }catch(e){} };
  const interesting=url=>/upload|image|file|alice|samantha|resource|imagex|tos|apply|commit|attachment|media|cloud|blob|vodupload|bytevcloud/i.test(String(url||''));
  const previewBody=body=>{
    try{
      if(!body) return '';
      if(typeof body==='string') return body.slice(0,2000);
      if(body instanceof FormData) return 'FormData:'+Array.from(body.keys()).join(',');
      if(body instanceof Blob) return 'Blob:'+body.size+':'+ (body.type||'');
      if(body instanceof ArrayBuffer) return 'ArrayBuffer:'+body.byteLength;
      if(body && body.buffer) return 'TypedArray:'+body.byteLength;
      return Object.prototype.toString.call(body);
    }catch(e){return '';}
  };
  const origFetch=window.fetch;
  window.fetch=async function(input,init){
    const url=typeof input==='string'?input:(input&&input.url)||'';
    const method=(init&&init.method)||(input&&input.method)||'GET';
    const bodyPreview=previewBody(init&&init.body);
    const p=origFetch.apply(this,arguments);
    if(interesting(url)||/FormData|Blob|ArrayBuffer|TypedArray/.test(bodyPreview)){
      p.then(async resp=>{
        let text=''; try{ text=(await resp.clone().text()).slice(0,8000);}catch(e){}
        push({t:Date.now(),kind:'fetch',url,method,status:resp.status,bodyPreview,response:text,ctype:resp.headers.get('content-type')||''});
      }).catch(e=>push({t:Date.now(),kind:'fetch-err',url,method,error:String(e)}));
    }
    return p;
  };
  const XO=XMLHttpRequest.prototype.open, XS=XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open=function(method,url){ this.__m=method; this.__u=url; return XO.apply(this,arguments); };
  XMLHttpRequest.prototype.send=function(body){
    const url=this.__u||'', method=this.__m||'GET', bodyPreview=previewBody(body);
    if(interesting(url)||/FormData|Blob|ArrayBuffer|TypedArray/.test(bodyPreview)){
      this.addEventListener('loadend',()=>{
        push({t:Date.now(),kind:'xhr',url,method,status:this.status,bodyPreview,response:String(this.responseText||'').slice(0,8000),ctype:this.getResponseHeader('content-type')||''});
      });
    }
    return XS.apply(this,arguments);
  };
  return {ok:true,installed:true};
})()
"""


def main() -> int:
    image = Path(sys.argv[1] if len(sys.argv) > 1 else r"E:\temp\avatar.webp")
    account = sys.argv[2] if len(sys.argv) > 2 else "AdoraCrosbytvzs5"
    rec = AccountRegistry().load(account)
    storage = Path(rec.profilePath)
    out = ROOT / "_upload_probe" / "capture_hits_full.json"
    box: dict = {}

    def after_start():
        w = webview.windows[0]
        for _ in range(30):
            try:
                if "dola.com" in str(js_eval(w, "location.href") or ""):
                    break
            except Exception:
                pass
            time.sleep(0.5)
        time.sleep(2)
        js_eval(w, DISMISS_JS)
        time.sleep(0.5)
        box["install"] = js_eval(w, CAPTURE_JS)
        box["video"] = js_eval(w, JS_CLICK_VIDEO)
        time.sleep(2.5)
        js_eval(w, DISMISS_JS)
        time.sleep(0.8)
        files = load_ref_files_b64([str(image)])
        box["attach"] = js_eval(w, js_attach_files_b64(files))
        print("[full] attach", box["attach"])
        # wait long for multi-step upload
        for i in range(40):
            time.sleep(1)
            hits = js_eval(w, "window.__dolaUploadHits||[]") or []
            box["hits"] = hits
            interesting = [
                h for h in hits
                if any(k in str(h.get("url") or "").lower() for k in (
                    "prepare_upload", "applyimage", "commitimage", "vodupload", "resource", "upload"
                )) and "monitor" not in str(h.get("url") or "").lower()
            ]
            print(f"[full] +{i+1}s total={len(hits)} interesting={len(interesting)}")
            for h in interesting[-5:]:
                print(" ", h.get("kind"), h.get("status"), str(h.get("url") or "")[:160], str(h.get("bodyPreview") or "")[:50])
            urls = " ".join(str(h.get("url") or "").lower() for h in hits)
            if "commitimageupload" in urls and ("resource" in urls or "finish" in urls or "complete" in urls or "apply" in urls):
                # keep waiting a bit for final resource registration
                if i >= 8:
                    pass
            if any("commitimageupload" in str(h.get("url") or "").lower() for h in hits) and i >= 12:
                # check for post-commit alice calls
                if any("/alice/" in str(h.get("url") or "") and "prepare_upload" not in str(h.get("url") or "") for h in hits):
                    break
            if i >= 25 and any("commitimageupload" in str(h.get("url") or "").lower() for h in hits):
                break
        out.parent.mkdir(exist_ok=True)
        out.write_text(json.dumps(box, ensure_ascii=False, indent=2), encoding="utf-8")
        print("[full] wrote", out, "hits", len(box.get("hits") or []))
        try:
            w.destroy()
        except Exception:
            pass

    webview.create_window(f"full-upload:{rec.accountId}", "https://www.dola.com/chat", width=1280, height=900)
    webview.start(after_start, gui="edgechromium", debug=False, private_mode=False, storage_path=str(storage))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
