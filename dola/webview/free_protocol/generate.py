"""Video generation entry with image-to-video support."""
from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any, Callable, Optional

from free_protocol.completion_builder import DEFAULT_MODEL_15, build_video_completion_body
from free_protocol.image_upload import inject_attachments_into_completion, upload_images_via_webview
from free_protocol.registry import AccountRegistry
from free_protocol.video_api import (
    _emit_job_event,
    generate_video_api as generate_video_api_t2v,
    submit_video_task,
    wait_and_download_from_vids,
)

LogFn = Callable[[str], None]


def generate_video_api(
    account_id: str,
    *,
    prompt: str,
    duration: int = 5,
    aspect_ratio: str = "9:16",
    model: str = "",
    refs: list[str] | None = None,
    out_dir: str | Path = "downloads",
    timeout: float = 600,
    wait_download: bool = True,
    registry: AccountRegistry | None = None,
    log: Optional[LogFn] = None,
) -> dict[str, Any]:
    """Generate video; image-to-video uploads refs via WebView then HTTP submit."""
    refs = list(refs or [])
    if not refs:
        return generate_video_api_t2v(
            account_id,
            prompt=prompt,
            duration=duration,
            aspect_ratio=aspect_ratio,
            model=model,
            refs=None,
            out_dir=out_dir,
            timeout=timeout,
            wait_download=wait_download,
            registry=registry,
            log=log,
        )

    registry = registry or AccountRegistry()
    record = registry.load(account_id)
    profile = record.profilePath
    if not profile:
        raise RuntimeError(f"account {account_id} has no profilePath for WebView upload")

    def _log(msg: str) -> None:
        if log:
            log(msg)
        else:
            print(msg, flush=True)

    _log(f"[generate] image-to-video refs={len(refs)} account={account_id}")
    attachments = upload_images_via_webview(
        account_id,
        refs,
        profile_path=profile,
        timeout=min(120.0, float(timeout)),
        log=log,
    )
    _log(f"[generate] got {len(attachments)} attachment descriptor(s)")

    # Wrap body builder so attachment_block is always present (builtin skeleton lacks it).
    import free_protocol.video_api as video_api_mod
    import free_protocol.completion_builder as cb_mod

    orig_build = cb_mod.build_video_completion_body

    def build_with_atts(**kwargs):
        body = orig_build(**kwargs)
        return inject_attachments_into_completion(body, attachments)

    cb_mod.build_video_completion_body = build_with_atts  # type: ignore[assignment]
    video_api_mod.build_video_completion_body = build_with_atts  # type: ignore[assignment]
    t0 = time.time()
    try:
        submit = submit_video_task(
            record,
            prompt=prompt,
            duration=duration,
            aspect_ratio=aspect_ratio,
            model=model,
            attachments=attachments,
            log=log,
        )
    finally:
        cb_mod.build_video_completion_body = orig_build  # type: ignore[assignment]
        video_api_mod.build_video_completion_body = orig_build  # type: ignore[assignment]

    registry.save(record)
    conversation_id = str(submit.get("conversationId") or "")
    message_id = str(submit.get("messageId") or "")
    accept = submit.get("accept") or {}
    accepted = bool(accept.get("accepted") or conversation_id)
    if not accepted:
        raise RuntimeError("Dola completion returned no accepted ACK; task was not confirmed submitted")

    session_url = f"https://www.dola.com/chat/{conversation_id}" if conversation_id else "https://www.dola.com/chat"
    out_dir_p = Path(out_dir)
    out_dir_p.mkdir(parents=True, exist_ok=True)
    _emit_job_event(
        "submitted",
        sessionUrl=session_url,
        messageId=message_id,
        mode="http-external-submit",
    )
    result: dict[str, Any] = {
        "accountId": record.accountId,
        "duration": duration,
        "aspectRatio": aspect_ratio,
        "model": model or (DEFAULT_MODEL_15 if duration >= 15 else ""),
        "mode": "http-external-submit",
        "accepted": accepted,
        "status": submit.get("status"),
        "vids": submit.get("vids") or [],
        "conversationId": conversation_id,
        "messageId": message_id,
        "sessionUrl": session_url,
        "accept": accept,
        "elapsedSec": round(time.time() - t0, 2),
        "attachments": attachments,
        "prompt": prompt,
        "note": "Image-to-video: refs uploaded via WebView (no in-window submit), task submitted over HTTP.",
    }

    vids = list(submit.get("vids") or [])
    if wait_download and vids:
        try:
            dl = wait_and_download_from_vids(
                vids,
                cookie_header=str(submit.get("cookieHeader") or ""),
                client_profile=submit.get("clientProfile") or {},
                out_dir=out_dir_p,
                timeout=float(timeout),
                log=log,
            )
            result.update(dl)
        except Exception as exc:
            result["downloadError"] = str(exc)
            result["note"] = (result.get("note") or "") + f" Download deferred: {exc}"
    elif wait_download and not vids:
        # Fall back to CDP/page watch like t2v path when ACK has no vid yet.
        try:
            from free_protocol.cdp_result_watch import capture_and_download

            captured = capture_and_download(
                account_id,
                conversation_id,
                message_id,
                out_dir=out_dir_p,
                prompt=prompt,
                timeout=float(timeout),
                registry=registry,
                duration=int(duration),
                aspect_ratio=str(aspect_ratio),
            )
            if isinstance(captured, dict):
                result.update(captured)
        except Exception as exc:
            result["downloadError"] = str(exc)
            result["note"] = (result.get("note") or "") + f" No immediate vid; page watch: {exc}"

    if result.get("file") or result.get("outputFile") or result.get("vid"):
        _emit_job_event(
            "result",
            **{
                k: result.get(k)
                for k in (
                    "file",
                    "outputFile",
                    "vid",
                    "url",
                    "sessionUrl",
                    "messageId",
                    "conversationId",
                    "sha256",
                    "size",
                )
                if result.get(k) is not None
            },
        )

    # persist ack for debugging
    try:
        ack_path = out_dir_p / f"submit_ack_{int(time.time())}.json"
        ack_path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        result["ackFile"] = str(ack_path)
    except Exception:
        pass
    return result
