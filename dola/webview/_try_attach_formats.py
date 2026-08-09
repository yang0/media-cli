"""Try several attachment payload shapes via submit_video_task."""
from __future__ import annotations

import json
import sys
import time
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

import free_protocol.completion_builder as cb_mod
import free_protocol.video_api as video_api_mod
from free_protocol.completion_builder import build_video_completion_body
from free_protocol.image_upload import inject_attachments_into_completion, upload_images_via_webview
from free_protocol.registry import AccountRegistry
from free_protocol.video_api import submit_video_task


def try_submit(record, prompt: str, attachments: list[dict]) -> dict:
    orig = cb_mod.build_video_completion_body

    def wrapped(**kwargs):
        body = orig(**kwargs)
        return inject_attachments_into_completion(body, attachments)

    cb_mod.build_video_completion_body = wrapped  # type: ignore
    video_api_mod.build_video_completion_body = wrapped  # type: ignore
    try:
        return submit_video_task(
            record,
            prompt=prompt,
            duration=5,
            aspect_ratio="9:16",
            model="",
            attachments=attachments,
            timeout=60,
        )
    finally:
        cb_mod.build_video_completion_body = orig  # type: ignore
        video_api_mod.build_video_completion_body = orig  # type: ignore


def main() -> int:
    account = sys.argv[1] if len(sys.argv) > 1 else "AdoraCrosbytvzs5"
    image = Path(sys.argv[2] if len(sys.argv) > 2 else r"E:\temp\avatar.webp")
    rec = AccountRegistry().load(account)
    print("upload...")
    atts_full = upload_images_via_webview(account, [str(image)], profile_path=rec.profilePath, timeout=90)
    att = atts_full[0]
    uri = att["key"]
    name = att["name"]
    w = att["image"].get("width") or 0
    h = att["image"].get("height") or 0
    print("uri", uri, "size", w, h)

    variants = [
        ("A_simple_image", [{"type": "image", "key": uri, "name": name}]),
        ("B_vlm_image", [{"type": "vlm_image", "key": uri, "name": name, "identifier": str(uuid.uuid4())}]),
        (
            "C_image_ori",
            [
                {
                    "type": "image",
                    "key": uri,
                    "name": name,
                    "image": {"key": uri, "image_ori": {"url": "", "width": w, "height": h}},
                }
            ],
        ),
        (
            "D_entity",
            [
                {
                    "type": "vlm_image",
                    "identifier": str(uuid.uuid4()),
                    "name": name,
                    "key": uri,
                    "url": "",
                    "option": {"width": w, "height": h},
                }
            ],
        ),
        (
            "E_nested_image",
            [
                {
                    "type": "image",
                    "key": uri,
                    "name": name,
                    "url": "",
                    "image": {
                        "type": "image",
                        "key": uri,
                        "uri": uri,
                        "name": name,
                        "width": w,
                        "height": h,
                    },
                }
            ],
        ),
        ("F_key_only", [{"key": uri, "name": name, "type": "image", "url": None}]),
        ("G_resource_type2", [{"type": "image", "key": uri, "name": name, "resource_type": 2}]),
    ]

    prompt = "基于参考图轻微运动，保持人物一致"
    for label, attachments in variants:
        try:
            res = try_submit(rec, prompt, attachments)
            accept = res.get("accept") or {}
            print(
                "====",
                label,
                "accepted=",
                accept.get("accepted"),
                "status=",
                res.get("status"),
                "msg=",
                (accept.get("message") or "")[:120],
                "vids=",
                res.get("vids"),
            )
            # dump raw snippet if present
            if not accept.get("accepted"):
                # submit_video_task raises on failure usually
                pass
            else:
                print("SUCCESS", label)
                Path(ROOT / "_upload_probe" / "winning_attachment.json").write_text(
                    json.dumps({"label": label, "attachments": attachments, "result": res}, ensure_ascii=False, indent=2),
                    encoding="utf-8",
                )
                return 0
        except Exception as exc:
            print("====", label, "ERR", str(exc)[:300])
        time.sleep(1.2)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
