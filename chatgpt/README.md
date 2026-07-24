# ChatGPT Image CLI

Generate images through an already logged-in ChatGPT Chrome session exposed over CDP.

```powershell
cd chatgpt\cli
node src\cli.mjs dry-run --port 9221
node src\cli.mjs generate --prompt "A cinematic orange cat" --out .\downloads
```

Start Chrome with `--remote-debugging-port=9221` and log in to `https://chatgpt.com/` first. The CLI has no npm runtime dependencies and supports single prompts, prompt files, and batches.
