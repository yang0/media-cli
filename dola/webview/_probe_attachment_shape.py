"""Upload avatar.webp and dump any in-page objects that contain the StoreUri."""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

import webview
from free_protocol.image_upload import upload_images_via_webview
from free_protocol.registry import AccountRegistry
from video_flow import JS_CLICK_VIDEO, js_attach_files_b64, js_eval, load_ref_files_b64

# After upload, search page JS memory for URI references is hard; instead
# intercept the would-be completion body by patching fetch before a soft send probe.
# We do NOT click send; we only inspect composer internal stores if exposed.


DUMP_JS = r"""
(() => {
  const hits = window.__dolaI2VHits || [];
  const commits = [];
  for (const h of hits) {
    if (String(h.url||'').includes('CommitImageUpload') && h.status === 200) {
      try { commits.push(JSON.parse(h.response)); } catch (e) {}
    }
  }
  // Try common global stores
  const keys = Object.keys(window).filter(k => /store|state|dola|doubao|chat|upload|attachment/i.test(k)).slice(0, 80);
  const samples = {};
  for (const k of keys) {
    try {
      const v = window[k];
      const t = typeof v;
      if (t === 'string' && v.length < 200) samples[k] = v;
      else if (t === 'object' && v) samples[k] = Object.prototype.toString.call(v);
      else samples[k] = t;
    } catch (e) { samples[k] = 'err'; }
  }
  // Scan textContent of thumbnails
  const imgs = Array.from(document.querySelectorAll('img')).slice(0, 30).map(img => ({
    src: (img.src||'').slice(0, 180),
    alt: img.alt || '',
    w: img.naturalWidth,
    h: img.naturalHeight,
  }));
  return { commits: commits.slice(-2), keys, samples, imgs, href: location.href };
})()
"""


def main() -> int:
    account = sys.argv[1] if len(sys.argv) > 1 else "AdoraCrosbytvzs5"
    image = Path(sys.argv[2] if len(sys.argv) > 2 else r"E:\temp\avatar.webp")
    rec = AccountRegistry().load(account)
    print("uploading via helper...")
    atts = upload_images_via_webview(account, [str(image)], profile_path=rec.profilePath, timeout=90)
    print("attachments from helper:")
    print(json.dumps(atts, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
