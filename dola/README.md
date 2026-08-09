# Dola CLI

CLI for Dola chat, image generation, video generation, attachments, downloads, and resumable batches.

**2026-08 redesign (aligned with `E:\\tools\\dola-free`):** account import is WebView login + cookie/fingerprint export; video generation prefers captured `POST /chat/completion` HTTP replay (not forced 15s UI patches). See `webview/README.md` →「新架构」.

Code is modular under `cli/src/` (entry `cli/src/cli.js`, orchestration `main.js`, domain folders for accounts / media / video / chat).

## Install globally

From a checkout, install the package once. The `dola` command is then available
from any directory. The installer includes the WebView worker and creates a
private Python environment for pywebview on Windows.

```powershell
npm install -g E:\projectHome\media-cli\dola
dola --help
```

The global package keeps mutable state outside the npm installation directory:

- Windows data/profile root: `%LOCALAPPDATA%\dola-cli`
- Job artifacts: `downloads\jobs` under the directory where the command is run
- Cookie pool: `G:\cookies\dola` by default, or `DOLA_ACCOUNT_POOL`

Useful global commands:

```powershell
dola video submit --prompt "A girl turns toward the camera" --duration 10 `
  --file E:\temp\avatar.webp --request-id demo-001 --json
dola video status <jobId> --json
dola video wait <jobId> --timeout 35m --json
dola video download <jobId> --out E:\videos --json
dola jobs cleanup --request-prefix angle- --yes --json
dola jobs prune --older-than 30d --json
dola pool status --json
dola account open AureliaBronson1l5hd
```

### Copy/paste video demo

The durable commands are safe to call from an AI agent: `submit` returns
immediately, while the worker continues in the background. Save the returned
`jobId`, then wait and download that exact job (never “the latest video”):

```powershell
$job = dola video submit `
  --prompt "一个小女孩在草地上奔跑，电影感镜头" `
  --duration 5 --aspect-ratio 16:9 `
  --file E:\temp\avatar.webp `
  --request-id demo-20260803-001 --json | ConvertFrom-Json
dola video status $job.jobId --json
dola video wait $job.jobId --timeout 35m --json
dola video download $job.jobId --out E:\videos --json
```

For a prompt file or a 15-second job:

```powershell
dola video submit `
  --prompt-file E:\projectHome\seedance-prompts\prompt.txt `
  --duration 15 --aspect-ratio 9:16 `
  --file E:\temp\avatar.webp --json
```

`--json` is intended for scripts and AI callers. It returns stable fields such
as `jobId`, `state`, `accountId`, `prompt`, `messageId`, `vid`, `outputFile`,
`manifestFile`, and `error`. Use the same `--request-id` when retrying a
request; the original job is returned instead of generating a duplicate.

If a WebView was closed and stale jobs remain queued, clean only unsubmitted
jobs and release their leases with `dola jobs cleanup --yes --json`. To remove
old cancelled/failed history (successful videos are retained), preview first
with `dola jobs prune --older-than 30d --json`, then add `--yes`.

`dola account open <accountId>` reopens a selected account's visible WebView
with its isolated profile and cookies. Use the WebView **Dola** menu's refresh
action to reload the current page.

If WebView windows are closed while jobs are being submitted, use
`dola jobs cancel <jobId>` for one task or `dola jobs cleanup --yes` for all
unsubmitted pending tasks. Cleanup releases account leases and unused credit
reservations. Add `--request-prefix` to limit cleanup to one known batch.

`dola jobs list` shows 20 recent non-cancelled jobs by default. Use `--all` or
`--state cancelled` to inspect cancelled history. `dola jobs prune
--older-than 30d` only previews old cancelled/failed/timed-out jobs; add `--yes`
to remove those database records and job directories. Successful videos are
never pruned.

If Python is installed in a non-standard location, set `DOLA_PYTHON` before
installing. To use an existing pywebview environment, set `DOLA_PYTHON` before
running `dola`.

### WebView2 登录壳（推荐，少 Chrome 弹窗）

```bat
cd webview
start.cmd
```

用 Edge WebView2 打开 dola、手动 Google 登录后，菜单导出 Cookie 到 `G:\cookies\dola`，再交给 CLI 号池。详见 `webview/README.md`。

```powershell
cd dola\cli
node src\cli.js --help
node src\cli.js --new-chat --image-gen --prompt "A green circle icon" --out .\downloads
node src\cli.js --video-gen --duration 5 --aspect-ratio 16:9 --prompt "A paper boat in rain" --out .\downloads
node src\cli.js --video-gen --duration 10 --prompt "Cinematic drone shot over misty mountains" --out .\downloads
```

Start Chrome with `--remote-debugging-port=9221` and log in to Dola. The CLI has no npm runtime dependencies; Bun or Node can run it.

Account pool example:

```powershell
node src\cli.js --account-pool "G:\cookies\dola" --list-accounts
node src\cli.js --account-pool "G:\cookies\dola" --account-id dola_2 --new-chat --video-gen --duration 10 --prompt "..." --out .\downloads
```

## Video generation (5s / 10s native UI)

Dola's official UI exposes **5s** and **10s**. After the 2026-03 backend update, **15s completion injection is disabled** (same as the DoubaoAccountManager 10s patch): forcing `duration=15` / `seedance_v2.0` often shows a max-10s dialog and can fall back to a 5s clip.

Current flow:

1. Switch the composer into video mode.
2. Select duration and aspect ratio via the **native UI only** (no `/chat/completion` duration rewrite).
3. Attach 0–n reference images (optional), fill prompt, submit.
4. Resolve download URLs via DOM / `/samantha/media/get_play_info` (no-watermark preference still works).

Examples:

```powershell
# Official UI duration
node src\cli.js --video-gen --duration 5 --aspect-ratio 16:9 --prompt "Ocean waves at sunset" --out .\downloads

# 10s via native UI
node src\cli.js --video-gen --duration 10 --prompt "Slow push-in on a neon alley" --out .\downloads

# Image-to-video reference frame
node src\cli.js --video-gen --duration 10 --reference-image .\frame.png --prompt "Camera pans left" --out .\downloads
```

Default timeout is about 6 minutes for 5s and ~8 minutes for 10s. Override with `--timeout`.

> Note: IP / cookie risk checks are stricter now. Prefer a stable browser login that can generate video before driving the local tool. Temporary Google accounts still drop sessions often.
