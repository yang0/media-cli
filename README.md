# media-cli

CLI collection for image, video and audio generation through supported web services.

Each platform is isolated and can be installed or run from its own `cli/` directory.
Authentication is supplied by the user through a logged-in Chrome CDP session, a local cookie file, or an API key env var.

## Platforms

| Platform | Images | Video | TTS/Audio | Entry point |
|---|:---:|:---:|:---:|---|
| Jimeng | Yes | Yes | No | `jimeng/cli` |
| ChatGPT | Yes | No | No | `chatgpt/cli` |
| Dola | Yes | Yes | No | `dola/cli` |
| Doubao | Yes | No | No | `doubao/cli` |
| Google Flow | Yes | No | No | `flow/cli` |
| Volc-TTS | No | No | **Yes** | `volc-tts/cli` |
| Weibo | Search / Screenshot | No | No | `weibo/cli` |

## Quick start

```powershell
cd jimeng\cli
npm install
npm run build
node dist\cli.js --help
```

For browser-based CLIs, start Chrome with a dedicated user data directory and remote debugging enabled, then log in manually:

```powershell
chrome.exe --remote-debugging-port=9221 --user-data-dir="$PWD\.chrome-profile"
```

See the README in each platform directory for its port, authentication method, and commands.

微博 CLI：

```powershell
cd weibo\cli
python -m pip install -e .
weibo-cli search "人工智能 机器人"
weibo-cli capture "https://weibo.com/<uid>/<bid>"
```

搜索与截图是独立命令；长微博截图会按 9:16 比例自动分图。详见 [`weibo/cli/README.md`](weibo/cli/README.md)。

## Repository rules

- Runtime output goes to `downloads/` and is ignored by Git.
- Cookie files, browser profiles, session state, and local configuration must never be committed.
- Platform CLIs are independent; install dependencies in the platform's own `cli/` directory.
- The services are web/API integrations and may break when the provider changes its frontend or API.

## License

Each CLI retains its original license and provider terms. Check the provider's terms before automating an account.
