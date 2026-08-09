# doubao CLI

Two tools in one package:

1. **doubao-img** — Chrome CDP image download from a logged-in Doubao browser
2. **doubao-podcast** — Volcengine Podcast TTS (websocket-v3) with per-round timestamps

---

## Podcast TTS (`doubao-podcast`)

Docs: [播客 API websocket-v3](https://www.volcengine.com/docs/6561/1668014)

Synthesizes dual-speaker podcast audio and returns:

| File | Content |
|------|---------|
| `*.mp3` | Full concatenated audio |
| `*.texts.json` | `taskId`, duration, each turn's `start`/`end`/`duration` + speaker |
| `*.srt` | Subtitles with `[女]` / `[男]` labels |

### Setup

```bash
cd E:\projectHome\media-cli\doubao\cli
cp .env.example .env
# fill DOUBAO_PODCAST_APP_ID / ACCESS_TOKEN / SECRET_KEY
```

### Run

```bash
# action=3: scripted dialogue (口播稿) — recommended
bun src/podcast/cli.mjs ^
  --text "女:今天我们聊适度宽松。\n男:好，我们开始。" ^
  --out downloads/smoke.mp3

# from JSON file: [{ "text":"...", "speaker":"zh_female_..." }, ...]
bun src/podcast/cli.mjs --nlp-file script.json --out downloads/show.mp3

# action=4: topic → auto podcast
bun src/podcast/cli.mjs --action 4 --prompt "适度宽松货币政策" --out downloads/topic.mp3
```

Default speakers:

- 女 `zh_female_mizaitongxue_v2_saturn_bigtts`
- 男 `zh_male_dayixiansheng_v2_saturn_bigtts`

Timestamps come from server event **362 PodcastRoundEnd** (`start_time` / `end_time` / `audio_duration`).

---

## Image download (`doubao-img`)

Bun CLI for controlling an already logged-in Doubao browser through Chrome's CDP debug port, submitting a prompt, capturing generated image URLs, and downloading them locally.

It talks directly to `http://127.0.0.1:9222/json/*` and the page `webSocketDebuggerUrl`; Playwright is not required.

## Reference projects checked first

- [LauZzL/doubao-downloader](https://github.com/LauZzL/doubao-downloader): browser extension/userscript that extracts Doubao `creations` and prefers `image_ori_raw.url` for watermark-free downloads.
- [xjw2005/doubao-cdp-test](https://github.com/xjw2005/doubao-cdp-test): Playwright `connectOverCDP` scaffold for existing Doubao sessions.
- [Xuan8a1/DoubaoGrabber](https://github.com/Xuan8a1/DoubaoGrabber): Selenium/PyQt image URL capture idea, especially extracting raw image URLs from JSON.
- [iamtornado/playwright-automation](https://github.com/iamtornado/playwright-automation): Playwright automation pattern for Doubao-like pages.

## Install

```bash
bun install
```

Chrome must already be running with remote debugging enabled, for example:

```powershell
& "C:\Program Files\Google\Chrome\Application\chrome.exe" `
  --remote-debugging-port=9222 `
  --user-data-dir="D:\chrome-profiles\doubao-cdp" `
  "https://www.doubao.com/"
```

## Run

The CLI requires a chat session before it submits anything. You can pass a full URL or just the numeric id.

```bash
bun src/cli.js ^
  --session "https://www.doubao.com/chat/38433955186592514" ^
  --prompt "Generate a cyberpunk cat poster" ^
  --out downloads ^
  --count 1
```

If `--session` is omitted, it asks for it first. If `--prompt` is omitted, it asks for the prompt only after the session has been provided.

Submit an image question without waiting for generated images:

```bash
bun src/cli.js ^
  --session "https://www.doubao.com/chat/38433955186592514" ^
  --file "E:\temp\aa.png" ^
  --prompt "请解释图片" ^
  --no-download
```

Start from Doubao chat home and let Doubao create/redirect to a concrete chat URL. The CLI prints the redirected `finalUrl`:

```bash
bun src/cli.js ^
  --new-chat ^
  --file "E:\temp\aa.png" ^
  --prompt "请解释图片" ^
  --no-download
```

This equivalent form also works:

```bash
bun src/cli.js --session "https://www.doubao.com/chat" --prompt "Hello" --no-download
```

Validate the current 9222 browser without submitting:

```bash
bun src/cli.js --session "https://www.doubao.com/chat/38433955186592514" --dry-run
```

## Notes

- The browser must already be logged in to Doubao.
- The tool does not handle CAPTCHA, account prompts, or login dialogs.
- Image detection uses both network JSON capture and DOM image scanning because Doubao page internals can change.
