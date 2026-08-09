from pathlib import Path
import re

out = Path(r"E:\projectHome\media-cli\dola\webview\_upload_probe")
for name in ["bundle_01.js", "bundle_02.js", "hits.txt", "paths.txt"]:
    p = out / name
    if not p.exists():
        continue
    t = p.read_text(encoding="utf-8", errors="ignore")
    print("====", name, len(t))
    paths = set(
        re.findall(
            r"[\"'/][a-zA-Z0-9_./-]{0,40}(?:upload|Upload|file_uri|key_uri|imagex|ImageX|ApplyImage|attachment|resource|ApplyImageInfo|GetUploadAuth|prepare_upload)[a-zA-Z0-9_./-]{0,80}",
            t,
        )
    )
    for x in sorted(paths)[:150]:
        print(x)
    print("--- nearby interesting ---")
    count = 0
    for m in re.finditer(r".{0,80}(?:upload|attachment_block|file_uri|key_uri|imagex|/alice/|/samantha/).{0,120}", t, re.I):
        s = m.group(0).replace("\n", " ")
        if any(k in s.lower() for k in ["/", "api", "http", "url", "path", "auth", "token", "apply", "file", "uri"]):
            print(s[:220])
            count += 1
            if count >= 80:
                break
