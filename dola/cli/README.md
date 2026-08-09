# dola-cli

Bun or Node CLI for Dola chat, image generation, video generation, attachments, downloads, account pools, and resumable batches.

## Source layout

```text
src/
  cli.js                 # process entry
  job-command.js         # durable video/jobs/pool/worker command bridge
  main.js                # orchestration / batch / account rotation
  args.js                # --help + argv parser
  config.js              # constants (CDP port, Seedance, paths)
  errors.js              # DolaCliError
  utils.js               # fs/json/sleep helpers
  cdp.js                 # CDP client + page helpers
  session.js             # open session, new chat, login detect
  prompts.js             # prompt / batch file loaders
  accounts/
    cookies.js           # Netscape cookie load + inject
    pool.js              # pool load, health, usage, rotation state
  media/
    urls.js              # image/video URL classification
    capture.js           # page hooks + network capture
    download.js          # choose/download assets
  chat/
    compose.js           # attach / type / submit
    reply.js             # last reply, error classify, wait UI
  image/
    mode.js              # switch image generation mode
  video/
    mode.js              # switch video mode + duration UI
    patch.js             # duration injection disabled (native 5/10 UI only)
    resolve.js           # get_play_info no-watermark resolve
  cli.monolith.backup.js # pre-split backup (reference only)
webview/
  job_store.py           # SQLite jobs, leases, credits, manifests
  job_worker.py          # hidden concurrent WebView worker
  recover_download.py    # recover an expired video URL by job metadata
```

```powershell
cd dola\cli
node src\cli.js --help

# Async 15s generation; the first command returns a jobId immediately
$job = node src\cli.js video submit `
  --prompt "A paper boat sailing through rain" --duration 10 `
  --aspect-ratio 9:16 --file E:\temp\avatar.webp `
  --request-id demo-video-001 --json | ConvertFrom-Json
node src\cli.js video wait $job.jobId --timeout 35m --json
node src\cli.js video download $job.jobId --out E:\videos --json

# Synchronous convenience command
node src\cli.js video generate `
  --prompt "A girl turns toward the camera" --duration 10 `
  --file E:\temp\avatar.webp --wait --json

# Inspect scheduler state
node src\cli.js pool status --json
node src\cli.js jobs list --limit 20 --json
node src\cli.js jobs list --all --limit 20 --json
node src\cli.js jobs prune --older-than 30d --json
node src\cli.js jobs cancel <jobId> --json
node src\cli.js jobs cleanup --request-prefix angle- --yes --json
node src\cli.js worker status --json

# Re-open a manually closed account WebView; cookies/profile are reused
dola account open AureliaBronson1l5hd
```

Start a logged-in Dola Chrome session with CDP port `9221`. The CLI uses the account pool at `G:\cookies\dola` by default; override it with `--account-pool` or `DOLA_ACCOUNT_POOL`. Use `--new-chat`, `--session`, `--file`, `--batch-prompt-file`, and `--resume` as needed.

## AI/automation contract

Use `video submit` when the caller may disconnect while Dola is generating. It
returns a stable `jobId` immediately; `wait` and `download` can be called later.
All video commands accept `--json` and return `jobId`, `state`, `accountId`,
`duration`, `creditCost`, `prompt`, timestamps, `messageId`, `vid`,
`outputFile`, `manifestFile`, and `error`. A caller-provided `--request-id` is
an idempotency key: retrying the same key never creates a second job.

```powershell
$job = dola video submit --prompt "A paper boat sailing through rain" `
  --duration 5 --aspect-ratio 16:9 --file E:\temp\avatar.webp `
  --request-id agent-demo-001 --json | ConvertFrom-Json
dola video wait $job.jobId --timeout 35m --json
dola video download $job.jobId --out E:\videos --json
```

Use `--prompt-file` for long prompts and pass `--duration 15` explicitly when
needed. If a WebView is closed, run `dola jobs cleanup --yes --json` to release
unsubmitted leases; use `dola jobs prune --older-than 30d --yes --json` to
remove old cancelled/failed history while retaining successful videos.

## Durable concurrent video jobs

Video jobs use a SQLite queue, isolated WebView profiles, and a default global
concurrency of three. One account/profile can only own one active job. The
scheduler reserves the daily duration cost before opening WebView and commits it
when submission is confirmed.

```powershell
dola video submit --prompt "A girl turns toward camera" --duration 10 `
  --file E:\temp\avatar.webp --request-id demo-001 --json
dola video status <jobId> --json
dola video wait <jobId> --timeout 35m --json
dola video download <jobId> --out E:\videos --json
dola pool status
```

`dola video generate ...` is the blocking convenience form. Job artifacts are
stored under `downloads/jobs/<date>/<jobId>/`, including the exact request,
copied references, result metadata, log, video SHA-256, account, message ID and
video ID. The SQLite state and global WebView profiles live in the user data
directory (`%LOCALAPPDATA%\dola-cli` on Windows). Existing simple
`dola --video-gen ...` calls are routed through this durable path.

To re-open any account directly from any working directory, run
`dola account open <accountId>`. The WebView uses that account's isolated
profile. Its **Dola** menu includes **刷新当前页面** to reload the current URL
without creating another profile.

## Account pool

Cookie directory or JSON pool for multi-account rotation:

```powershell
# Inspect pool health / usage / blocked status
node src\cli.js --account-pool "G:\cookies\dola" --list-accounts

# Prefer a specific account
node src\cli.js --account-pool "G:\cookies\dola" --account-id dola_2 --video-gen --duration 10 --prompt "..." --out .\downloads

# Auto-rotate on quota / restricted / bad cookies
node src\cli.js --account-pool "G:\cookies\dola" --new-chat --video-gen --duration 10 --prompt "..." --out .\downloads
```

Pool behavior:

- Loads Netscape / JSON cookie files, normalizes domains for CDP
- Skips expired cookies and accounts missing session tokens
- Picks **least-used healthy** account for the day (not always the first file)
- On `ACCOUNT_RESTRICTED` / quota exhausted / login-failed: mark for today and switch
- Opens a clean chat tab after switch and re-injects cookies
- Persists `restrictedAccounts`, `accountBlockReasons`, `accountUsage` in `.dola-cli-session.json`

## Video generation (reseller-aligned)

Pipeline (aligned with DoubaoAccountManager after the 10s patch):

1. Click **视频生成** on `/chat`
2. Set duration / aspect ratio in the **native UI only** (5s / 10s)
3. Attach **0–n** reference images (optional)
4. Fill prompt → send
5. **Do not** rewrite `/chat/completion` duration/model (15s injection disabled)

| Flag | Meaning |
|------|---------|
| `--video-gen` | Enable video mode + download |
| `--duration 5\|10` | Native UI length only (default `5`) |
| `--model` | Optional metadata only (no completion rewrite) |
| `--aspect-ratio 16:9` | Ratio: 9:16, 16:9, 1:1, 3:4, 4:3, or 21:9 |
| `--reference-image` / `--file` | Repeatable, **0–n** refs |

```powershell
# text-only 5s
node src\cli.js --account-pool "G:\cookies\dola" --new-chat --video-gen --duration 5 --prompt "..." --out .\downloads

# one ref image + 10s + 9:16
node src\cli.js --account-pool "G:\cookies\dola" --new-chat --video-gen --duration 10 --aspect-ratio 9:16 --reference-image E:\temp\avatar.png --prompt "..." --out .\downloads

# multi ref images
node src\cli.js --account-pool "G:\cookies\dola" --new-chat --video-gen --duration 10 --file a.png --file b.png --prompt "..." --out .\downloads
```

### No-watermark video downloads

Video mode **prefers clean play URLs**, matching the desktop reseller tool:

1. Harvest `vid` / `no_watermark_url` from chat stream JSON  
2. Call `POST /samantha/media/get_play_info`  
3. Score candidates (`original_media_info` > `no_watermark_url` > other play infos)  
4. Rewrite params (`lr=video_gen_no_watermark`, `watermark=0`)  
5. Skip page preview `<video src>` unless no clean URL exists  

Use `--allow-watermark` only if you explicitly accept watermarked/preview files.

Session state is written to `.dola-cli-session.json`; do not commit it.
