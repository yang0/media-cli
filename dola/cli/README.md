# dola-cli

Bun or Node CLI for Dola chat, image generation, video generation, attachments, downloads, account pools, and resumable batches.

```powershell
cd dola\cli
node src\cli.js --help
node src\cli.js --new-chat --image-gen --prompt "A green circle icon" --out .\downloads
node src\cli.js --video-gen --duration 5 --aspect-ratio 16:9 --prompt "A paper boat in rain" --out .\downloads
```

Start a logged-in Dola Chrome session with CDP port `9221`. Use `--new-chat`, `--session`, `--file`, `--batch-prompt-file`, `--resume`, and `--account-pool` as needed.

Session state is written to `.dola-cli-session.json`; do not commit it.
