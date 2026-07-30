# Google Flow CLI

Use a signed-in, visible Chrome session through CDP to generate images and image-to-video clips in Google Flow.

## English quick start

Requirements: Node.js 18+, Chrome with CDP enabled, and `ffmpeg` on `PATH` for local image-to-video validation.

```powershell
# Start Chrome. Close other Chrome windows using this profile first.
chrome.exe --remote-debugging-port=9221 --user-data-dir="$env:TEMP\flow-cli-chrome"

cd flow\cli
npm install
node flow.mjs --help
```

Keep your Flow project open in that Chrome window, or provide its URL with `--project-url`/`FLOW_PROJECT_URL`.

```powershell
# Image generation with an existing Flow project asset
node flow.mjs "A cat sleeping in sunlight" --ref cat.png

# Image-to-video with a local file
node flow.mjs --video --ref E:\temp\avatar.webp --duration 4 `
  "The subject slowly turns toward the camera"

# Image-to-video with an existing Flow project asset
node flow.mjs --video --ref avatar.webp --ref-source uploaded --duration 4 `
  "The subject smiles and waves"
```

The CLI uses randomized 1–3 second pauses, confirms that a new generation request was submitted, ignores historical videos, downloads the result, and validates the first frame against a local reference image.

## 中文快速开始

需要 Node.js 18+、开启 CDP 的已登录 Chrome；本地图生视频还需要命令行可用的 `ffmpeg`。

```powershell
chrome.exe --remote-debugging-port=9221 --user-data-dir="$env:TEMP\flow-cli-chrome"

cd flow\cli
npm install
node flow.mjs --help

node flow.mjs --video --ref E:\temp\avatar.webp --duration 4 `
  "主体缓慢转身并看向镜头，电影感运镜"
```

浏览器里保持一个 Flow 项目页面打开即可；也可以使用 `--project-url` 或环境变量 `FLOW_PROJECT_URL` 指定项目。完整参数、批量文件格式和故障排查见 [CLI 文档](./cli/README.md)。
