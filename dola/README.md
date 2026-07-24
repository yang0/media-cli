# Dola CLI

CLI for Dola chat, image generation, video generation, attachments, downloads, and resumable batches through Chrome CDP.

```powershell
cd dola\cli
node src\cli.js --help
node src\cli.js --new-chat --image-gen --prompt "A green circle icon" --out .\downloads
node src\cli.js --video-gen --duration 5 --aspect-ratio 16:9 --prompt "A paper boat in rain" --out .\downloads
```

Start Chrome with `--remote-debugging-port=9221` and log in to Dola. The CLI has no npm runtime dependencies; Bun or Node can run it.
