# chatgpt-img

Node.js CLI for generating images through an already logged-in ChatGPT Chrome CDP session.

```powershell
cd chatgpt\cli
npm install
node src\cli.mjs --help
node src\cli.mjs dry-run --port 9221
node src\cli.mjs generate --prompt "A cinematic orange cat" --out .\downloads
```

Start Chrome with `--remote-debugging-port=9221` and log in to `https://chatgpt.com/` first. The CLI supports single prompts, prompt files, and batches.
