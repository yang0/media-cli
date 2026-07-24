# doubao-img

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
