# Dola CLI

CLI for Dola chat, image generation, video generation, attachments, downloads, and resumable batches through Chrome CDP.

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
dola video submit --prompt "A girl turns toward the camera" --duration 15 `
  --file E:\temp\avatar.webp --request-id demo-001 --json
dola video status <jobId> --json
dola video wait <jobId> --timeout 35m --json
dola video download <jobId> --out E:\videos --json
dola jobs cleanup --request-prefix angle- --yes --json
dola jobs prune --older-than 30d --json
dola pool status --json
dola account open AureliaBronson1l5hd
```

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
node src\cli.js --video-gen --duration 15 --prompt "Cinematic drone shot over misty mountains" --out .\downloads
```

Start Chrome with `--remote-debugging-port=9221` and log in to Dola. The CLI has no npm runtime dependencies; Bun or Node can run it.

Account pool example:

```powershell
node src\cli.js --account-pool "G:\cookies\dola" --list-accounts
node src\cli.js --account-pool "G:\cookies\dola" --account-id dola_2 --new-chat --video-gen --duration 15 --prompt "..." --out .\downloads
```

## Video generation (5s / 10s / 15s)

Dola's official UI only exposes **5s** and **10s**. Longer clips (especially **15s**) work the same way the Dola reseller desktop tools do:

1. Switch the composer into video mode.
2. Inject a page script that hooks `fetch` / `XMLHttpRequest`.
3. On `POST /chat/completion`, rewrite video ability params:
   - `chat_ability.ability_type === 17`
   - `ability_param.duration = <seconds>`
   - `ability_param.model = seedance_v2.0` when duration is 15 (or when you pass `--model`)
4. After the reply appears, resolve download URLs via DOM video nodes and `/samantha/media/get_play_info` (no-watermark preference).

Examples:

```powershell
# Official UI duration
node src\cli.js --video-gen --duration 5 --aspect-ratio 16:9 --prompt "Ocean waves at sunset" --out .\downloads

# 15s via completion patch + Seedance v2.0 (default model for duration >= 15)
node src\cli.js --video-gen --duration 15 --prompt "Slow push-in on a neon alley" --out .\downloads

# Explicit model override
node src\cli.js --video-gen --duration 15 --model seedance_v2.0 --prompt "..." --out .\downloads

# Image-to-video reference frame
node src\cli.js --video-gen --duration 10 --reference-image .\frame.png --prompt "Camera pans left" --out .\downloads
```

Default timeout is 6 minutes for short clips and 10 minutes for 15s jobs. Override with `--timeout`.

> Note: Request rewriting uses the logged-in account's normal Dola session. It does not bypass billing, quotas, or server-side policy. If the backend rejects a duration/model pair, generation will fail.
