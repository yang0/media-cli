# dola-cli

Bun or Node CLI for Dola chat, image generation, video generation, attachments, downloads, account pools, and resumable batches.

## Source layout

```text
src/
  cli.js                 # process entry
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
    patch.js             # /chat/completion 15s + seedance patch
    resolve.js           # get_play_info no-watermark resolve
  cli.monolith.backup.js # pre-split backup (reference only)
```

```powershell
cd dola\cli
node src\cli.js --help
node src\cli.js --new-chat --image-gen --prompt "A green circle icon" --out .\downloads
node src\cli.js --video-gen --duration 5 --aspect-ratio 16:9 --prompt "A paper boat in rain" --out .\downloads
node src\cli.js --video-gen --duration 15 --prompt "Cinematic drone shot" --out .\downloads
```

Start a logged-in Dola Chrome session with CDP port `9221`. The CLI uses the account pool at `G:\cookies\dola` by default; override it with `--account-pool` or `DOLA_ACCOUNT_POOL`. Use `--new-chat`, `--session`, `--file`, `--batch-prompt-file`, and `--resume` as needed.

## Account pool

Cookie directory or JSON pool for multi-account rotation:

```powershell
# Inspect pool health / usage / blocked status
node src\cli.js --account-pool "G:\cookies\dola" --list-accounts

# Prefer a specific account
node src\cli.js --account-pool "G:\cookies\dola" --account-id dola_2 --video-gen --duration 15 --prompt "..." --out .\downloads

# Auto-rotate on quota / restricted / bad cookies
node src\cli.js --account-pool "G:\cookies\dola" --new-chat --video-gen --duration 15 --prompt "..." --out .\downloads
```

Pool behavior:

- Loads Netscape / JSON cookie files, normalizes domains for CDP
- Skips expired cookies and accounts missing session tokens
- Picks **least-used healthy** account for the day (not always the first file)
- On `ACCOUNT_RESTRICTED` / quota exhausted / login-failed: mark for today and switch
- Opens a clean chat tab after switch and re-injects cookies
- Persists `restrictedAccounts`, `accountBlockReasons`, `accountUsage` in `.dola-cli-session.json`

## Video generation (reseller-aligned)

Pipeline (same intent as desktop reseller tools):

1. Click **视频生成** on `/chat`
2. Set duration / aspect ratio (UI when available)
3. Attach **0–n** reference images (optional)
4. Fill prompt → send
5. For **15s**: patch `POST /chat/completion` (`ability_type=17`, `duration=15`, `model=seedance_v2.0`)

| Flag | Meaning |
|------|---------|
| `--video-gen` | Enable video mode + download |
| `--duration 5\|10\|15` | Length only (default `5`) |
| `--model seedance_v2.0` | Override model (auto for 15s) |
| `--aspect-ratio 16:9` | Size/ratio (UI + completion patch) |
| `--reference-image` / `--file` | Repeatable, **0–n** refs |

```powershell
# text-only 5s
node src\cli.js --account-pool "G:\cookies\dola" --new-chat --video-gen --duration 5 --prompt "..." --out .\downloads

# one ref image + 15s + 9:16
node src\cli.js --account-pool "G:\cookies\dola" --new-chat --video-gen --duration 15 --aspect-ratio 9:16 --reference-image E:\temp\avarta.png --prompt "..." --out .\downloads

# multi ref images
node src\cli.js --account-pool "G:\cookies\dola" --new-chat --video-gen --duration 10 --file a.png --file b.png --prompt "..." --out .\downloads
```

For **15s**, the CLI does **not** rely on a missing UI menu item. It patches the completion request body (same as reseller inject scripts):

- match `POST https://*.dola.com/chat/completion`
- find `chat_ability.ability_type === 17`
- set `duration` / `model` / optional `ratio`

### No-watermark video downloads

Video mode **prefers clean play URLs**, matching the desktop reseller tool:

1. Harvest `vid` / `no_watermark_url` from chat stream JSON  
2. Call `POST /samantha/media/get_play_info`  
3. Score candidates (`original_media_info` > `no_watermark_url` > other play infos)  
4. Rewrite params (`lr=video_gen_no_watermark`, `watermark=0`)  
5. Skip page preview `<video src>` unless no clean URL exists  

Use `--allow-watermark` only if you explicitly accept watermarked/preview files.

Session state is written to `.dola-cli-session.json`; do not commit it.
