"""Minimal free_protocol.cli double used by job_worker unit tests."""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path


def argument(name: str, default: str = "") -> str:
    try:
        return sys.argv[sys.argv.index(name) + 1]
    except (ValueError, IndexError):
        return default


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    # Keep sys.argv compatible for argument() helper when called as -m.
    if argv is not sys.argv[1:]:
        sys.argv = [sys.argv[0], *argv]

    event_file = Path(os.environ["DOLA_JOB_EVENT_FILE"])
    job_id = os.environ["DOLA_JOB_ID"]
    out_dir = Path(argument("--out"))
    out_dir.mkdir(parents=True, exist_ok=True)

    def emit(event_type: str, **payload):
        with event_file.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps({"type": event_type, "jobId": job_id, **payload}) + "\n")

    emit("submitted", sessionUrl="https://www.dola.com/chat/test", mode="http-external-submit")
    emit(
        "generated",
        sessionUrl="https://www.dola.com/chat/test",
        messageId="message-test",
        vid="vid-test",
        url="https://example.invalid/video.mp4",
    )
    video = out_dir / "fake.mp4"
    video.write_bytes(b"\x00\x00\x00\x18ftypmp42" + b"x" * 4096)
    emit(
        "result",
        file=str(video),
        sessionUrl="https://www.dola.com/chat/test",
        messageId="message-test",
        vid="vid-test",
        url="https://example.invalid/video.mp4",
    )
    print(
        json.dumps(
            {
                "accepted": True,
                "messageId": "message-test",
                "vid": "vid-test",
                "file": str(video),
                "mode": "http-external-submit",
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
