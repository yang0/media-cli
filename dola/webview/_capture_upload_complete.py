"""Reliable capture of complete upload chain after successful attach."""
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

DISMISS = r"""(() => { const t=el=>String(el&&(el.innerText||el.textContent||'')||'').replace(/\s+/g,' ').trim(); const v=el=>{if(!el)return false;const r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'}; const clicked=[]; for(const el of document.querySelectorAll('button,[role=button],div,span')){ if(!v(el))continue; const x=t(el); if(x==='我知道了'||x==='知道了'||x==='Got it'){ try{el.click();clicked.push(x);}catch(e){} } } return clicked; })()"""

CAPTURE = r"""
(() => {
  if (window.__cap) return {reused:true,n:(window.__hits||[]).length};
  window.__hits=[]; window.__cap=true;
  const push=o=>{try{window.__hits.push(o); if(window.__hits.length>600)window.__hits.shift();}catch(e){}};
  const int=u=>/upload|image|file|alice|samantha|resource|imagex|tos|apply|commit|vodupload|bytevcloud|attachment/i.test(String(u||''));
  const pb=b=>{try{if(!b)return'';if(typeof b==='string')return b.slice(0,3000);if(b instanceof FormData)return 'FormData:'+Array.from(b.keys()).join(',');if(b instanceof Blob)return 'Blob:'+b.size;if(b&&b.byteLength!=null)return 'Bin:'+b.byteLength;return Object.prototype.toString.call(b);}catch(e){return''}};
  const of=window.fetch;
  window.fetch=async function(i,init){
    const url=typeof i==='string'?i:(i&&i.url)||''; const method=(init&&init.method)||'GET'; const body=pb(init&&init.body);
    const p=of.apply(this,arguments);
    if(int(url)||/FormData|Blob|Bin/.test(body)) p.then(async r=>{let tx='';try{tx=(await r.clone().text()).slice(0,10000)}catch(e){} push({t:Date.now(),k:'fetch',url,method,status:r.status,body,resp:tx});}).catch(e=>push({t:Date.now(),k:'fetch-err',url,error:String(e)}));
    return p;
  };
  const xo=XMLHttpRequest.prototype.open, xs=XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open=function(m,u){this.__m=m;this.__u=u;return xo.apply(this,arguments)};
  XMLHttpRequest.prototype.send=function(b){
    const url=this.__u||'', method=this.__m||'GET', body=pb(b);
    if(int(url)||/FormData|Blob|Bin/.test(body)) this.addEventListener('loadend',()=>push({t:Date.now(),k:'xhr',url,method,status:this.status,body,resp:String(this.responseText||'').slice(0,10000)}));
    return xs.apply(this,arguments);
  };
  return {ok:true};
})()
"""


def main() -> int:
    image = Path(sys.argv[1] if len(sys.argv) > 1 else r"E:\temp\avatar.webp")
    account = sys.argv[2] if len(sys.argv) > 2 else "AdoraCrosbytvzs5"
    rec = AccountRegistry().load(account)
    storage = Path(rec.profilePath)
    out = ROOT / "_upload_probe" / "capture_complete.json"
    box = {}

    def after():
        w = webview.windows[0]
        for _ in range(40):
            try:
                if "dola.com" in str(js_eval(w, "location.href") or ""):
                    break
            except Exception:
                pass
            time.sleep(0.4)
        time.sleep(2.0)
        print("dismiss", js_eval(w, DISMISS))
        time.sleep(0.6)
        print("cap", js_eval(w, CAPTURE))
        print("video", js_eval(w, JS_CLICK_VIDEO))
        time.sleep(2.5)
        print("dismiss2", js_eval(w, DISMISS))
        time.sleep(1.0)
        # wait for hidden file inputs
        for i in range(15):
            n = js_eval(w, "document.querySelectorAll('input[type=file]').length")
            print(f"file-inputs t={i} n={n}")
            if int(n or 0) > 0:
                break
            time.sleep(0.5)
        files = load_ref_files_b64([str(image)])
        att = js_eval(w, js_attach_files_b64(files))
        print("attach", att)
        box["attach"] = att
        for i in range(35):
            time.sleep(1)
            hits = js_eval(w, "window.__hits||[]") or []
            box["hits"] = hits
            urls = [str(h.get("url") or "") for h in hits]
            interesting = [u for u in urls if any(k in u.lower() for k in ("prepare_upload", "applyimage", "commitimage", "vodupload", "/alice/resource", "finish", "complete"))]
            print(f"+{i+1}s hits={len(hits)} interesting={len(interesting)}")
            for u in interesting[-6:]:
                print(" ", u[:180])
            joined = "\n".join(urls).lower()
            if "commitimageupload" in joined and i >= 8:
                # allow alice resource finalize
                if any("/alice/resource/" in u.lower() and "prepare_upload" not in u.lower() for u in urls) or i >= 15:
                    break
        out.parent.mkdir(exist_ok=True)
        out.write_text(json.dumps(box, ensure_ascii=False, indent=2), encoding="utf-8")
        print("wrote", out)
        try:
            w.destroy()
        except Exception:
            pass

    webview.create_window(f"complete:{rec.accountId}", "https://www.dola.com/chat", width=1280, height=900)
    webview.start(after, gui="edgechromium", debug=False, private_mode=False, storage_path=str(storage))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
