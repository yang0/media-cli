#!/usr/bin/env python3
"""Batch transcribe all mp3 in audio/ -> subtitles/ (SRT + TXT + JSON), skip existing."""
import os, sys, json, time

AUDIO_DIR = "audio"
OUT_DIR = "subtitles"

def fmt_ts(sec):
    ms = int(round(sec * 1000))
    h, rem = divmod(ms, 3600000)
    m, rem = divmod(rem, 60000)
    s, ms = divmod(rem, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"

def main():
    from faster_whisper import WhisperModel
    files = sorted(f for f in os.listdir(AUDIO_DIR) if f.lower().endswith(".mp3"))
    os.makedirs(OUT_DIR, exist_ok=True)
    todo = []
    for f in files:
        base = os.path.splitext(f)[0]
        if not os.path.exists(os.path.join(OUT_DIR, base + ".srt")):
            todo.append((f, base))
    print(f"total={len(files)} todo={len(todo)} skip={len(files)-len(todo)}", flush=True)
    if not todo:
        print("nothing to do")
        return
    print("loading large-v3 on cuda...", flush=True)
    model = WhisperModel("large-v3", device="cuda", compute_type="float16")
    ok = fail = 0
    t_start = time.time()
    for i, (f, base) in enumerate(todo, 1):
        src = os.path.join(AUDIO_DIR, f)
        t0 = time.time()
        try:
            segments, info = model.transcribe(src, language="zh", vad_filter=True,
                                              beam_size=5, word_timestamps=True)
            segs = []
            for s in segments:
                segs.append({"start": s.start, "end": s.end, "text": s.text.strip()})
            with open(os.path.join(OUT_DIR, base + ".srt"), "w", encoding="utf-8") as fo:
                for j, s in enumerate(segs, 1):
                    fo.write(f"{j}\n{fmt_ts(s['start'])} --> {fmt_ts(s['end'])}\n{s['text']}\n\n")
            with open(os.path.join(OUT_DIR, base + ".txt"), "w", encoding="utf-8") as fo:
                fo.write("\n".join(s["text"] for s in segs) + "\n")
            with open(os.path.join(OUT_DIR, base + ".words.json"), "w", encoding="utf-8") as fo:
                json.dump({"audio": f, "language": info.language, "duration": info.duration,
                           "segments": segs}, fo, ensure_ascii=False, indent=1)
            ok += 1
            print(f"[{i}/{len(todo)}] OK {base} ({len(segs)} segs) {round(time.time()-t0,1)}s", flush=True)
        except Exception as e:
            fail += 1
            print(f"[{i}/{len(todo)}] FAIL {base} :: {e}", flush=True)
        if ok % 5 == 0 and ok:
            el = time.time() - t_start
            print(f"  ...progress {ok}/{len(todo)} elapsed {round(el/60,1)}min", flush=True)
    print(f"\nDONE ok={ok} fail={fail} elapsed={round((time.time()-t_start)/60,1)}min", flush=True)

if __name__ == "__main__":
    main()
