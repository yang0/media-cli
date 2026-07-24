# jimeng-cli

[简体中文说明](./README.md)

API-first CLI for Jimeng image and video generation, credit lookup, model listing, and result download.

- npm: https://www.npmjs.com/package/@yang0/jimeng-cli
- GitHub: https://github.com/yang0/jimeng-cli

## Features

- Load authentication from a Netscape cookie file.
- Submit Jimeng image and video generation jobs over HTTP APIs.
- Wait for task completion automatically when downloading generated assets.
- Inspect current credit balance.
- List the image and video model aliases supported by this CLI.

## Install

### From npm

```bash
npm install -g @yang0/jimeng-cli
jimeng --help
```

### Local development

```bash
npm install
```

## Quick start

```bash
# verify cookies
jimeng auth check --cookie-file "G:\cookies\jimeng.txt"

# inspect credit balance
jimeng credit --cookie-file "G:\cookies\jimeng.txt"

# list supported model aliases
jimeng models

# submit image task only
jimeng image generate "A neon fox in a cyberpunk city" --cookie-file "G:\cookies\jimeng.txt"

# submit and download image results
jimeng image generate "A neon fox in a cyberpunk city" --download --cookie-file "G:\cookies\jimeng.txt"

# submit and download video results
jimeng video generate "A glowing ship flying over a futuristic skyline" --download --cookie-file "G:\cookies\jimeng.txt"

# inspect recent history without creating a new job
jimeng history list --limit 10 --cookie-file "G:\cookies\jimeng.txt"
```

## Usage notes

- `--download` means: submit the job, wait until it completes, then download outputs.
- Cookie input expects a Netscape-format cookie file, for example `G:\cookies\jimeng.txt`.
- You can export a Netscape-format cookie file with the Chrome extension **Get cookies.txt LOCALLY**.
- Default image generation uses a reverse-engineered Jimeng web interface path rather than an official public API.
- In current live verification, the default image path matched the web-side `5.0 Lite` behavior and did not reduce credits.
- The image model list shows API-facing aliases. The actual returned web-side model label can still appear as `5.0 Lite`.
- Browser tools may be used for debugging request changes, but the formal CLI runtime path is pure code.

## Common workflows

```bash
# check account login state
jimeng auth check --cookie-file "G:\cookies\jimeng.txt"

# generate and download a free-style web image
jimeng image generate "一只霓虹狐狸，赛博朋克风格" --download --cookie-file "G:\cookies\jimeng.txt"

# generate and download a video
jimeng video generate "赛博朋克城市上空掠过一艘发光飞船" --download --cookie-file "G:\cookies\jimeng.txt"

# inspect task history
jimeng history list --limit 10 --cookie-file "G:\cookies\jimeng.txt"
```

## Commands

- `auth check` — validate the cookie file against Jimeng account info.
- `credit` — print current gift / purchase / VIP / total credits.
- `models` — print supported image and video model aliases.
- `image generate` — submit an image generation job.
- `video generate` — submit a video generation job.
- `task get` / `task wait` — inspect or wait for an existing task.
- `history list` — fetch existing generation history.
- `download` — resolve and download outputs for an existing task.

## Packaging notes

- The npm bin entry points to `dist/cli.js`.
- `npm pack` / `npm publish` will trigger `prepack`, which builds the project first.
- Only built artifacts and README files are included in the package tarball.

## Browser debugging fallback

The implementation is API-first. If request shapes change and browser-side debugging is needed, use this Chrome profile:

```text
G:\chrome_data\remote_debug
```

Use that profile only for DevTools verification and payload recovery, not as the primary execution path.
