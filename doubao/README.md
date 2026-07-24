# Doubao CLI

CLI for Doubao image generation and image-aware chat through Chrome CDP.

```powershell
cd doubao\cli
node src\cli.js --help
node src\cli.js --new-chat --prompt "A cyberpunk cat poster" --out .\downloads
```

Start Chrome with `--remote-debugging-port=9222` and log in to Doubao. Use `--file` for a local attachment and `--session` or `--new-chat` to select the conversation.
