#!/usr/bin/env python3
"""Split src/cli.monolith.backup.js into modular ESM files with safe imports."""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"
MONO = SRC / "cli.monolith.backup.js"
if not MONO.exists():
    MONO = SRC / "cli.js"

MODULES: dict[str, list[str]] = {
    "config.js": [
        "DEFAULT_CDP", "DEFAULT_SESSION", "DOLA_CHAT_HOME", "DOLA_IMAGE_HOME",
        "DEFAULT_OUT_DIR", "DEFAULT_SESSION_STATE", "DEFAULT_VIDEO_DURATION",
        "VIDEO_MODEL_SEEDANCE_V2", "VIDEO_ABILITY_TYPE", "DOLA_MEDIA_AID",
    ],
    "errors.js": ["DolaCliError"],
    "utils.js": [
        "sleep", "readJsonFile", "writeJsonFile", "normalizeFiles", "safeFilePart",
        "askRequired", "inferCompletedOutput", "extensionFromUrl", "accountDayKey",
    ],
    "args.js": ["usage", "parseArgs"],
    "cdp.js": [
        "cdpHttpUrl", "CdpClient", "findOrCreateTarget", "evaluate",
        "waitForPageReady", "waitForConcreteChatUrl", "waitForComposer",
        "pageSnapshot", "uiSnapshot",
    ],
    "session.js": [
        "normalizeSession", "isChatHomeUrl", "isConcreteChatUrl",
        "detectDolaLoginState", "startFreshChat", "openAccountSession",
    ],
    "accounts/cookies.js": [
        "normalizeCookieDomain", "loadNetscapeCookies", "inspectCookieFile", "applyAccountCookies",
    ],
    "accounts/pool.js": [
        "loadAccountPool", "loadPoolDayState", "markAccountBlocked", "bumpAccountUsage",
        "chooseAccount", "accountStateFields", "listAccountPoolStatus",
    ],
    "media/urls.js": [
        "isLikelyImageUrl", "isLikelyVideoUrl", "rewriteVideoNoWatermarkParams",
        "isWatermarkedUrl", "isPreferredRawUrl", "isPreferredVideoUrl", "imageKeyFromUrl",
        "normalizeImageKey", "collectImageUrls", "extractImageRecordsFromJson",
        "uniqueImageRecords", "rawUrlFromTrackKey", "messageIdFromRecord",
    ],
    "media/capture.js": [
        "installImageHook", "clearImageHook", "collectHookImages", "collectDomImages",
        "installNetworkImageCapture", "imageDebugSnapshot",
    ],
    "media/download.js": [
        "recordMatchesLastReply", "recordsFromLastReply", "chooseDownloadItems",
        "recoverPendingDownload", "waitForDownloadItems", "downloadImages",
    ],
    "chat/compose.js": [
        "attachFiles", "clickAttachmentButton", "waitForAttachments", "findSendButton",
        "syncInputText", "submitPrompt", "waitForResponseText", "sendCharacterContext",
    ],
    "chat/reply.js": [
        "lastReplySnapshot", "classifyImageGenerationTextError", "isAccountRestrictedError",
        "looksLikeImageGenerationProgress", "parseRemainingQuota", "looksLikePromptEcho",
        "imageGenerationUiSnapshot", "waitForImageGenerationComplete",
    ],
    "image/mode.js": ["ensureImageGenerationMode"],
    "video/mode.js": [
        "videoModeReadyExpression", "ensureVideoGenerationMode", "selectVideoOptions",
        "activateLatestVideoPlayer", "hoverLatestVideoCard", "openLatestVideoMoreMenu",
    ],
    "video/patch.js": [
        "resolveVideoGenConfig", "buildVideoCompletionPatchScript", "installVideoRequestPatch",
    ],
    "video/resolve.js": ["installVideoResolveHelpers", "collectDomVideos"],
    "prompts.js": ["loadPrompt", "loadBatchPrompts"],
    "main.js": ["main"],
}

# Node symbols that are easy false-positives inside identifier names or string text.
NODE_KEYS = {
    "access": ("node:fs/promises", "access"),
    "mkdir": ("node:fs/promises", "mkdir"),
    "readFile": ("node:fs/promises", "readFile"),
    "readdir": ("node:fs/promises", "readdir"),
    "rename": ("node:fs/promises", "rename"),
    "writeFile": ("node:fs/promises", "writeFile"),
    "fsConstants": ("node:fs", "constants as fsConstants"),
    "createInterface": ("node:readline/promises", "createInterface"),
    "input": ("node:process", "stdin as input"),
    "output": ("node:process", "stdout as output"),
    "createHash": ("node:crypto", "createHash"),
    "path": ("node:path", None),  # default
}

# Never treat these as cross-module imports when they appear as property/words.
SKIP_CROSS = {
    "main",   # mainUrl, etc.
    "usage",  # accountUsage property text
}


def extract_blocks(source: str) -> dict[str, str]:
    pattern = re.compile(
        r"^(?P<header>(?:async\s+)?function\s+(?P<fn>[A-Za-z0-9_]+)\b|"
        r"class\s+(?P<cls>[A-Za-z0-9_]+)\b|"
        r"const\s+(?P<const>[A-Z0-9_]+)\s*=)",
        re.M,
    )
    matches = list(pattern.finditer(source))
    blocks: dict[str, str] = {}
    for i, m in enumerate(matches):
        name = m.group("fn") or m.group("cls") or m.group("const")
        start = m.start()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(source)
        blocks[name] = source[start:end].rstrip() + "\n"
    return blocks


def symbol_owner() -> dict[str, str]:
    owner: dict[str, str] = {}
    for mod, names in MODULES.items():
        for name in names:
            owner[name] = mod
    return owner


def used_local_symbols(code: str, known: set[str], self_names: set[str]) -> set[str]:
    found = set()
    for name in known:
        if name in self_names or name in SKIP_CROSS:
            continue
        # Avoid matching name as prefix of longer identifier: use word boundary both sides.
        if re.search(rf"(?<![A-Za-z0-9_]){re.escape(name)}(?![A-Za-z0-9_])", code):
            found.add(name)
    return found


def used_node_imports(code: str) -> list[str]:
    used_mods: dict[str, list[str]] = {}
    # path default
    if re.search(r"(?<![A-Za-z0-9_])path\.", code) or re.search(r"(?<![A-Za-z0-9_])path\b", code):
        # exclude path in strings roughly by requiring code-like usage
        if re.search(r"\bpath\.(resolve|join|basename|dirname|extname)\b", code) or re.search(r"\bpath\.sep\b", code):
            used_mods.setdefault("node:path", []).append("__default__")
    for key, (mod, imp) in NODE_KEYS.items():
        if key == "path":
            continue
        if key in {"input", "output"}:
            # only utils.askRequired needs these
            if re.search(rf"\bcreateInterface\b", code) and re.search(rf"\b{key}\b", code):
                used_mods.setdefault(mod, []).append(imp)
            continue
        if re.search(rf"(?<![A-Za-z0-9_]){re.escape(key)}(?![A-Za-z0-9_])", code):
            used_mods.setdefault(mod, []).append(imp)

    lines = []
    for mod, imps in used_mods.items():
        if mod == "node:path":
            lines.append("import path from 'node:path';")
            continue
        imps = sorted(set(imps))
        lines.append(f"import {{ {', '.join(imps)} }} from '{mod}';")
    return sorted(lines)


def rel_import(from_mod: str, to_mod: str) -> str:
    from_dir = Path(from_mod).parent
    target = Path(to_mod)
    rel = Path(os_path_rel(from_dir, target)).as_posix()
    if not rel.startswith("."):
        rel = "./" + rel
    if not rel.endswith(".js"):
        # Path may already include .js
        if not rel.endswith(".js"):
            pass
    return rel if rel.endswith(".js") else rel  # target already has .js


def os_path_rel(from_dir: Path, target: Path) -> str:
    # from_dir relative to src; target file path relative to src
    if str(from_dir) in ("", "."):
        return "./" + target.as_posix()
    up = "/".join([".."] * len(from_dir.parts))
    return f"{up}/{target.as_posix()}"


def main() -> None:
    source = MONO.read_text(encoding="utf-8")
    source = re.sub(r"^#!.*\n", "", source)
    source = re.sub(r"^(import .+\n)+", "", source, count=1, flags=re.M)

    blocks = extract_blocks(source)
    owner = symbol_owner()
    known = set(owner)
    missing = known - set(blocks)
    if missing:
        raise SystemExit(f"missing blocks: {sorted(missing)}")

    for mod in MODULES:
        (SRC / mod).parent.mkdir(parents=True, exist_ok=True)

    for mod, names in MODULES.items():
        self_names = set(names)
        body_parts = []
        for name in names:
            block = blocks[name]
            if name == "main":
                block = re.sub(r"\nmain\(\)\.catch\([\s\S]*$", "\n", block)
            if block.startswith(("class ", "async function ", "function ", "const ")):
                block = "export " + block
            body_parts.append(block.rstrip() + "\n")
        body = "\n".join(body_parts)

        used = used_local_symbols(body, known, self_names)
        imports_by_mod: dict[str, set[str]] = {}
        for sym in used:
            src_mod = owner[sym]
            if src_mod != mod:
                imports_by_mod.setdefault(src_mod, set()).add(sym)

        import_lines = used_node_imports(body)
        for src_mod, syms in sorted(imports_by_mod.items()):
            rel = os_path_rel(Path(mod).parent, Path(src_mod))
            if not rel.startswith("."):
                rel = "./" + rel
            import_lines.append(f"import {{ {', '.join(sorted(syms))} }} from '{rel}';")

        content = ("\n".join(import_lines) + "\n\n" if import_lines else "") + body
        if not content.endswith("\n"):
            content += "\n"
        (SRC / mod).write_text(content, encoding="utf-8", newline="\n")
        print(f"wrote {mod} exports={len(names)}")

    entry = """#!/usr/bin/env node
import { main } from './main.js';

main().catch(error => {
  const code = error.code || 'DOLA_CLI_ERROR';
  const details = error.details ? `\\n${JSON.stringify(error.details, null, 2)}` : '';
  console.error(`[dola-cli] failed (${code}): ${error.stack || error.message}${details}`);
  process.exit(1);
});
"""
    (SRC / "cli.js").write_text(entry, encoding="utf-8", newline="\n")
    print("wrote cli.js entry")


if __name__ == "__main__":
    main()
