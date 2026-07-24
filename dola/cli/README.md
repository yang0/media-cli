# dola-cli

Small Bun CLI for driving Dola through an existing Chrome CDP session.

It follows the same browser-control approach as `E:\projectHome\doubao-img`:
connect to Chrome on port `9221`, open or reuse a Dola chat session, attach local
files, submit prompts, create new sessions, switch to image generation, and
download generated images.

## Prerequisites

Start Chrome with remote debugging enabled on port 9221 and log in to Dola manually:

```powershell
chrome.exe --remote-debugging-port=9221
```

## Chat

```powershell
bun src\cli.js --session "https://www.dola.com/chat/38415631468262161" --file "E:\temp\aa.png" --prompt "Describe this image"
```

## New Session

```powershell
bun src\cli.js --prompt "Hello" --no-wait
```

When `--session` is omitted, the CLI reuses an open Dola chat tab when one
exists, or creates a new session when none is open. Use `--new-chat` to force a
new session, `--session` for an existing chat, and `--resume` for a saved batch session. The
JSON output includes `finalUrl`, for example `https://www.dola.com/chat/<id>`.

## Video Generation

Generate a video with optional duration, aspect ratio, and zero or more local
reference images. Repeat `--file`/`--attach` for multiple references:

```powershell
bun src\cli.js --video-gen `
  --duration 5 --aspect-ratio 16:9 `
  --file "E:\temp\first.png" --file "E:\temp\second.png" `
  --prompt "A paper boat sailing through a rainy neon city" `
  --out downloads
```

Reference images are optional. `--duration` accepts 1–60 seconds; Dola's
available duration choices may further restrict that value. `--aspect-ratio`
accepts values such as `16:9`, `9:16`, and `1:1`. Use `--no-download` to wait
for generation without saving the returned video.

Video generation stays in the current chat form: the CLI selects Video, then
the duration and ratio controls without navigating away. It polls the current
reply once a minute for up to six minutes. To download the newest completed
video later without submitting another prompt, run:

```powershell
bun src\cli.js --session "https://www.dola.com/chat/<id>" --download-last-video --out downloads
```

## Image Generation

```powershell
bun src\cli.js --new-chat --image-gen --prompt "A simple green circle icon on a white background" --count 1 --out downloads
```

For batch generation, create a UTF-8 text file with one prompt per non-empty
line, then run:

```powershell
bun src\cli.js --new-chat --batch-prompt-file prompts.txt --count 1 --out downloads
```

`--batch-prompt-file` automatically enables image generation. Prompts are
submitted sequentially, and `--count` applies to each line. It cannot be used
with `--prompt`, `--prompt-file`, or `--no-wait`.

For fixed-character batch generation, provide a character reference image and
the prompt that describes it:

```powershell
bun src\cli.js --new-chat `
  --character-image "E:\temp\zhangsan.png" `
  --character-prompt "这是张三的形象图片，请记住" `
  --batch-prompt-file prompts.txt `
  --character-batch-size 10 `
  --out downloads
```

To test or resume an exact original line range, use `--from-line` and
`--to-line`. The saved filename keeps the original prompt-file line number,
even when earlier lines are skipped:

```powershell
bun src\cli.js --new-chat `
  --from-line 25 --to-line 25 `
  --character-image "E:\temp\avatar.png" `
  --character-prompt "这是主角的形象，请记住" `
  --batch-prompt-file prompts.txt `
  --out downloads
```

The character image and character prompt are sent once before each group of
prompts, including the first group. Fixed-character mode generates exactly one
image per non-empty prompt and keeps the original text-file line number in the
output filename, for example `12-a1b2c3d4e5f6.png`. Image content is hashed
with SHA-256; if a hash repeats, generation stops with
`IMAGE_GENERATION_DUPLICATE_HASH` and reports both line numbers.

The last successful Dola session is saved in `.dola-cli-session.json`. Use
`--new-chat` when a fresh session and a fresh character upload are required.
Use `--resume` to reuse the saved session and skip completed output files:

```powershell
bun src\cli.js --resume `
  --session "https://www.dola.com/chat/38415579417953553" `
  --character-image "E:\projectHome\huobijueqi\avatar.png" `
  --character-prompt "这是主角阿币的形象，请记住" `
  --batch-prompt-file prompts.txt `
  --out downloads
```

### Account Pool

`--account-pool` accepts either a directory of Netscape cookie files or a JSON
configuration. A cookie directory is the simplest form; each `.txt` file is an
account, and the filename becomes its account id:

```powershell
bun src\cli.js --account-pool "G:\cookies\dola" `
  --new-chat --resume `
  --character-image "E:\projectHome\huobijueqi\avatar.png" `
  --character-prompt "这是主角阿币的形象，请记住" `
  --batch-prompt-file prompts.txt --out downloads
```

For separate Chrome/CDP endpoints, use JSON instead:

```json
{
  "accounts": [
    { "id": "account-1", "cdp": "http://127.0.0.1:9221", "cookieFile": "G:\\cookies\\dola\\dola_1.txt" },
    { "id": "account-2", "cdp": "http://127.0.0.1:9223", "cookieFile": "G:\\cookies\\dola\\dola_2.txt" }
  ]
}
```

When Dola reports quota exhaustion or account restriction, the current account
is recorded as restricted for the local calendar day and the next available
account is selected automatically. The current chat is stopped, other Dola
tabs on that CDP endpoint are closed, cookies are replaced, and fixed-character
mode uploads the reference image again. If every account is restricted for the
day, the command stops with `ACCOUNT_POOL_EXHAUSTED`; the record is stored in
`.dola-cli-session.json` and is reset on the next day.

Resume state is written after each completed prompt. If no state file exists,
the CLI also recognizes existing files named `行号,短哈希.扩展名` in the output
directory and skips those lines. When the previous session is stuck, combine
`--resume --new-chat`; completed lines remain skipped, while the new session
uploads the character image again before continuing.

Before submitting a prompt, the state file records the in-flight line and the
previous reply image keys. After an interruption, `--resume` first tries to
recover that exact reply and download its images; it opens a fresh image session
only when no matching image can be recovered. This prevents a delayed download
from causing the same prompt to be submitted twice.

Image downloads prefer raw/original/no-watermark URLs. In fixed-character batch
mode, a watermarked URL is used only when no raw URL is available. In ordinary
image-generation mode, URLs containing watermark markers are skipped by default;
use `--allow-watermark` to permit them.

The CLI waits for Dola's generation UI to finish before inspecting the final
reply or collecting image URLs. Only images contained in that final Dola reply
are downloaded. If that reply is text-only, the command exits with a non-zero status and reports one of these
error codes: `IMAGE_GENERATION_QUOTA_EXHAUSTED`, `IMAGE_GENERATION_REFUSED`, or
`IMAGE_GENERATION_TEXT_RESPONSE`. Timeouts, unavailable clean image URLs, and
duplicate downloaded content use `IMAGE_GENERATION_TIMEOUT`,
`IMAGE_GENERATION_NO_CLEAN_IMAGE`, and `IMAGE_GENERATION_DUPLICATE_HASH`,
respectively.

Useful diagnostics:

```powershell
bun src\cli.js --session "https://www.dola.com/chat/38415631468262161" --dry-run
bun src\cli.js --session "https://www.dola.com/chat/38415631468262161" --debug-ui
npm run check
```
