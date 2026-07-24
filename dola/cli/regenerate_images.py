#!/usr/bin/env python3
"""Regenerate specific episode images using dola-cli.

Reads episode image-prompts.md files from huobijueqi, extracts prompts,
submits them to Dola via dola-cli, and moves the generated images into the
episode visuals/images/story/ directory.
"""

import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

# Base directory of the huobijueqi project
HUOBIJUEQI_ROOT = Path("E:/projectHome/huobijueqi")
DOLA_CLI_ROOT = Path("E:/projectHome/dola-cli")
DOLA_CLI = DOLA_CLI_ROOT / "src" / "cli.js"

# Map shorthand episode id to episode directory name
EPISODE_MAP = {
    "ep04": "episodes/part-01-money-origin/ep04-paper-money-replaces-gold",
    "ep06": "episodes/part-02-banking-and-credit/ep06-what-did-banks-do-first",
    "ep08": "episodes/part-02-banking-and-credit/ep08-what-is-interest",
    "ep09": "episodes/part-02-banking-and-credit/ep09-why-bank-runs-are-dangerous",
    "ep11": "episodes/part-02-banking-and-credit/ep11-how-credit-creates-crises",
    "ep12": "episodes/part-03-bonds-and-state/ep12-why-states-borrow-money",
}

# Images to regenerate per episode
REQUESTED = {
    "ep04": [2, 13, 35],
    "ep06": [10, 15, 21, 25, 28],
    "ep08": [2, 11, 14, 18, 20],
    "ep09": [2, 5, 8, 14, 21, 26],
    "ep11": [30],
    "ep12": [25],
}


def extract_table_rows(text):
    """Extract rows from the 切图节奏总览 markdown table."""
    rows = {}
    in_table = False
    for line in text.splitlines():
        if "|---" in line and in_table:
            continue
        if line.strip().startswith("| 图号"):
            in_table = True
            continue
        if in_table and line.strip().startswith("|"):
            cells = [c.strip() for c in line.strip().split("|")]
            cells = [c for c in cells if c]
            if not cells:
                continue
            try:
                num = int(cells[0])
                content = cells[-1] if len(cells) >= 5 else ""
                rows[num] = content
            except ValueError:
                pass
    return rows


def extract_style_prompt(text):
    """Extract the unified generation requirements / style prompt."""
    # Look for sections titled 统一生成要求 or 逐张提示词
    m = re.search(r"##?\s*统一生成要求\s*\n+(.+?)(?=\n##|\Z)", text, re.S)
    if m:
        return m.group(1).strip()
    m = re.search(r"##?\s*逐张提示词\s*\n+(.+?)(?=\n###|\Z)", text, re.S)
    if m:
        return m.group(1).strip()
    return ""


def extract_detailed_prompts(text):
    """Extract per-image detailed prompts keyed by image number."""
    prompts = {}
    pattern = re.compile(r"###\s*(\d+)\s*[｜|].*?\n(.*?)(?=\n###\s*\d+\s*[｜|]|\Z)", re.S)
    for m in pattern.finditer(text):
        num = int(m.group(1))
        body = m.group(2).strip()
        prompts[num] = body
    return prompts


def build_ep04_prompt(image_num, table_rows, style_prompt):
    """EP04 only has a table; build a prompt from the content description."""
    content = table_rows.get(image_num, "")
    if not content:
        raise ValueError(f"EP04 image {image_num} not found in table")
    return f"{style_prompt}\n\n请生成一张图，内容是：{content}。横屏16:9，画面全程无文字、无标题、无水印，底部大面积留白留给后期字幕。"


def extract_prompt(ep_id, image_num):
    """Extract the full prompt for a specific episode image."""
    ep_dir = HUOBIJUEQI_ROOT / EPISODE_MAP[ep_id]
    prompts_file = ep_dir / "visuals" / "image-prompts.md"
    text = prompts_file.read_text(encoding="utf-8")

    style_prompt = extract_style_prompt(text)

    # Prefer detailed per-image prompts if available.
    detailed = extract_detailed_prompts(text)
    body = detailed.get(image_num)
    if body:
        if style_prompt and style_prompt not in body:
            return f"{style_prompt}\n\n{body}"
        return body

    # Fallback to the table-based prompt builder (legacy EP04 format).
    table_rows = extract_table_rows(text)
    if ep_id == "ep04":
        return build_ep04_prompt(image_num, table_rows, style_prompt)

    content = table_rows.get(image_num, "")
    if not content:
        raise ValueError(f"{ep_id} image {image_num} not found")
    return content


AVATAR_PATH = HUOBIJUEQI_ROOT / "avarta.png"

AVATAR_PROMPT = (
    "这是本系列视频的主角：阿币。一个圆滚滚大头、棕色丸子头、Q 版人偶，"
    "穿米白色针织毛衣，戴金色爱心耳钉，整体造型圆润无棱角。"
    "请记住这个主角形象，后续我让你生成的每一张图都要让阿币保持这个造型和气质，"
    "只在场景、动作和构图上按我的描述变化。"
)


def run_dola_cli(args, out_dir, label):
    """Run dola-cli and return the downloaded file path(s).

    `args` is a list of CLI arguments (excluding the leading 'bun src/cli.js').
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    cmd = ["bun", str(DOLA_CLI)] + args
    print(f"[run] bun src/cli.js {' '.join(args[:5])} ...")
    result = subprocess.run(cmd, cwd=DOLA_CLI_ROOT, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=400)
    print(result.stdout)
    if result.returncode != 0:
        print(result.stderr, file=sys.stderr)
        raise RuntimeError(f"dola-cli failed with exit code {result.returncode}")

    # Parse the JSON object from stdout. dola-cli prints one JSON object at the end.
    data = None
    text = result.stdout
    # Find the first top-level brace-delimited object
    for start in range(len(text)):
        if text[start] != "{":
            continue
        depth = 0
        in_string = False
        escape = False
        for i in range(start, len(text)):
            ch = text[i]
            if escape:
                escape = False
                continue
            if ch == "\\":
                escape = True
                continue
            if ch == '"':
                in_string = not in_string
                continue
            if in_string:
                continue
            if ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    try:
                        data = json.loads(text[start:i + 1])
                    except json.JSONDecodeError:
                        data = None
                    break
        if data is not None:
            break

    if not data:
        raise RuntimeError("dola-cli did not return JSON output")
    return data


def create_avatar_session():
    """Create a new Dola chat, upload the avatar, and return the session URL."""
    print("===== creating shared avatar session =====")
    out_dir = DOLA_CLI_ROOT / "downloads" / "regenerate"
    out_dir.mkdir(parents=True, exist_ok=True)
    prompt_file = out_dir / "avatar_prompt.txt"
    prompt_file.write_text(AVATAR_PROMPT, encoding="utf-8")
    data = run_dola_cli(
        [
            "--new-chat",
            "--file", str(AVATAR_PATH),
            "--prompt-file", str(prompt_file),
            "--out", str(out_dir),
            "--timeout", "60000",
            "--stable", "3000",
        ],
        out_dir,
        "avatar",
    )
    final_url = data.get("finalUrl")
    if not final_url:
        raise RuntimeError("could not create avatar session")
    print(f"[session] {final_url}")
    return final_url


def generate_image(session_url, prompt, out_dir, label):
    """Generate one image in the shared session and return the saved file path.

    The avatar image is attached on every generation so the protagonist's
    appearance stays consistent across the episode images.
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    prompt_file = out_dir / f"{label}.txt"
    # Make sure the model explicitly uses the attached avatar as reference.
    full_prompt = (
        "请参考我上传的附件图片：这是本系列主角阿币。"
        "生成时请让阿币保持附件中的造型、气质和配色，"
        "只按下面的场景描述改变动作、表情、构图和环境。\n\n"
        + prompt
    )
    prompt_file.write_text(full_prompt, encoding="utf-8")
    data = run_dola_cli(
        [
            "--session", session_url,
            "--image-gen",
            "--prompt-file", str(prompt_file),
            "--count", "1",
            "--out", str(out_dir),
            "--timeout", "300000",
            "--stable", "8000",
        ],
        out_dir,
        label,
    )
    downloaded = [item["file"] for item in data.get("downloaded", []) if item.get("file")]
    if not downloaded:
        raise RuntimeError("dola-cli did not report a downloaded file")
    return Path(downloaded[0])


def target_image_path(ep_id, image_num):
    """Return the destination path for an episode image."""
    ep_dir = HUOBIJUEQI_ROOT / EPISODE_MAP[ep_id]
    return ep_dir / "visuals" / "images" / "story" / f"{image_num:03d}.png"


def backup_existing(path):
    """Rename an existing file to .bak if it exists."""
    if path.exists():
        bak = path.with_suffix(path.suffix + ".bak")
        counter = 1
        while bak.exists():
            bak = path.with_suffix(path.suffix + f".bak{counter}")
            counter += 1
        shutil.move(str(path), str(bak))
        print(f"[backup] {path} -> {bak}")


def parse_only_arg(raw):
    """Parse --only ep04:013,ep09:021,... into a dict."""
    selected = {}
    for part in raw.split(","):
        part = part.strip()
        if not part:
            continue
        if ":" not in part:
            raise ValueError(f"--only item must be ep:num, got: {part}")
        ep, nums = part.split(":", 1)
        selected[ep.strip()] = [int(n) for n in nums.split("+") if n.strip()]
    return selected


def main():
    work_dir = DOLA_CLI_ROOT / "downloads" / "regenerate"
    work_dir.mkdir(parents=True, exist_ok=True)

    only = None
    force = False
    for i, arg in enumerate(sys.argv[1:]):
        if arg == "--only" and i + 1 < len(sys.argv) - 1:
            only = parse_only_arg(sys.argv[i + 2])
        elif arg == "--force":
            force = True

    session_file = work_dir / "session_url.txt"
    if session_file.exists():
        session_url = session_file.read_text(encoding="utf-8").strip()
        print(f"[reuse session] {session_url}")
    else:
        # Create one shared session with the avatar reference
        session_url = create_avatar_session()
        session_file.write_text(session_url, encoding="utf-8")

    to_generate = only if only else REQUESTED
    results = []
    for ep_id, numbers in to_generate.items():
        for num in numbers:
            print(f"\n===== {ep_id} image {num:03d} =====")
            target = target_image_path(ep_id, num)
            if target.exists() and not force:
                print(f"[skip] {target} already exists")
                results.append({"ep": ep_id, "num": num, "ok": True, "file": str(target), "skipped": True})
                continue
            try:
                prompt = extract_prompt(ep_id, num)
                generated = generate_image(session_url, prompt, work_dir / ep_id, f"{ep_id}_{num:03d}")
                target.parent.mkdir(parents=True, exist_ok=True)
                backup_existing(target)
                shutil.copy2(str(generated), str(target))
                print(f"[saved] {generated} -> {target}")
                results.append({"ep": ep_id, "num": num, "ok": True, "file": str(target)})
            except Exception as e:
                print(f"[error] {ep_id} {num:03d}: {e}", file=sys.stderr)
                results.append({"ep": ep_id, "num": num, "ok": False, "error": str(e)})

    print("\n===== SUMMARY =====")
    for r in results:
        status = "OK" if r["ok"] else "FAIL"
        detail = r.get("file") if r["ok"] else r.get("error")
        print(f"{status}  {r['ep']} {r['num']:03d}: {detail}")


if __name__ == "__main__":
    main()
