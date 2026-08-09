#!/usr/bin/env python3
"""Transcribe one audio file with faster-whisper (CUDA), output SRT + TXT."""
import sys, os, json

def fmt_ts(sec):
    ms = int(round(sec * 1000))
    h, rem = divmod(ms, 3600000)
    m, rem = divmod(rem, 60000)
    s, ms = divmod(rem, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"

def main(audio, out_base, model="large-v3"):
    from faster_whisper import WhisperModel
    print(f"loading model {model} on cuda (first run downloads ~3GB)...", flush=True)
    m = WhisperModel(model, device="cuda", compute_type="float16")
    print("model ready, transcribing...", flush=True)
    segments, info = m.transcribe(audio, language="zh", vad_filter=True,
                                  beam_size=5, word_timestamps=True)
    segs = []
    for s in segments:
        segs.append({"start": s.start, "end": s.end, "text": s.text.strip()})
        print(f"  [{s.start:7.2f} -> {s.end:7.2f}] {s.text.strip()}", flush=True)
    # SRT
    srt_path = out_base + ".srt"
    with open(srt_path, "w", encoding="utf-8") as f:
        for i, s in enumerate(segs, 1):
            f.write(f"{i}\n{fmt_ts(s['start'])} --> {fmt_ts(s['end'])}\n{s['text']}\n\n")
    # TXT
    txt_path = out_base + ".txt"
    with open(txt_path, "w", encoding="utf-8") as f:
        f.write("\n".join(s["text"] for s in segs) + "\n")
    # JSON (with word timestamps)
    json_path = out_base + ".words.json"
    words_out = []
    for s in segs:
        for w in (s.get("words") or []):
            words_out.append({"start": w.start, "end": w.end, "word": w.word})
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump({"audio": audio, "language": info.language, "duration": info.duration,
                   "segments": segs, "words": words_out}, f, ensure_ascii=False, indent=1)
    print(f"\nDONE {len(segs)} segments, {len(words_out)} words")
    print("SRT :", srt_path)
    print("TXT :", txt_path)
    print("JSON:", json_path)

if __name__ == "__main__":
    audio = sys.argv[1]
    out_base = sys.argv[2] if len(sys.argv) > 2 else os.path.splitext(audio)[0]
    model = sys.argv[3] if len(sys.argv) > 3 else "large-v3"
    main(audio, out_base, model)
