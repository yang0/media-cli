from pathlib import Path
import re

t = Path(r"E:\projectHome\media-cli\dola\webview\_upload_probe\bundle_02.js").read_text(encoding="utf-8", errors="ignore")
# contexts
patterns = [
    r".{0,200}image_ori.{0,300}",
    r".{0,200}vlm_image.{0,300}",
    r".{0,200}file_name.{0,250}",
    r".{0,150}type:i\.R\.image.{0,250}",
    r".{0,200}attachment_block.{0,300}",
    r".{0,200}attachments:\s*\[.{0,200}",
    r".{0,150}resource_type.{0,200}",
    r".{0,150}rc_file_pc.{0,200}",
    r".{0,200}ImageUri.{0,250}",
    r".{0,200}upload_path_prefix.{0,200}",
]
for pat in patterns:
    print("====", pat[:40])
    count = 0
    for m in re.finditer(pat, t):
        print(m.group(0).replace("\n", " ")[:400])
        print("---")
        count += 1
        if count >= 5:
            break
    if count == 0:
        print("none")
