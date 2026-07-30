# flow-cli

通过 Chrome DevTools Protocol（CDP）控制 Google Flow 生成图片和图生视频。CLI 复用可见浏览器中的登录状态，不读取或保存账号密码。

## 前置条件

1. Node.js 18 或更高版本。
2. Chrome 开启 CDP，默认端口为 `9221`。
3. Chrome 中已登录 Google Flow，并打开一个 Flow 项目。
4. 本地图生视频需要安装 `ffmpeg`，且命令行可以直接执行。

Windows 启动示例：

```powershell
# 使用独立配置目录可避免和日常 Chrome 实例冲突
chrome.exe --remote-debugging-port=9221 `
  --user-data-dir="$env:TEMP\flow-cli-chrome"
```

在这个 Chrome 窗口中登录 Google Flow，并打开自己的项目页面。

## 安装与帮助

```powershell
cd flow\cli
npm install
node flow.mjs --help

# package.json 已提供同等入口
npm run help
```

项目页面可通过以下任一方式确定：

- 浏览器中保持一个 Flow 项目页面打开；
- 命令行传入 `--project-url "你的项目 URL"`；
- 设置环境变量 `$env:FLOW_PROJECT_URL="你的项目 URL"`。

CLI 不再内置任何个人项目 ID。

## Demo

### 1. 使用项目素材生成图片

`avatar.png` 必须已经存在于当前 Flow 项目中：

```powershell
node flow.mjs "角色站在窗边，柔和自然光" `
  --ref avatar.png `
  --aspect 16:9 --count 1x `
  --output .\downloads
```

### 2. 使用本地参考图生成图片

```powershell
node flow.mjs "保持人物外观，改成雨夜街道背景" `
  --ref E:\assets\portrait.webp `
  --ref-source file `
  --output .\downloads
```

如果 `--ref` 指向实际存在的本地文件，CLI 会自动切换为 `file`，可省略 `--ref-source file`。

### 3. 本地图生视频

```powershell
node flow.mjs --video `
  --ref E:\temp\avatar.webp `
  --duration 4 --aspect 16:9 --count 1x `
  --port 9221 `
  --output E:\temp\flow-output `
  "主体缓慢转身并看向镜头，电影感运镜"
```

流程包括：

1. 先选择视频模式、时长、比例和数量；
2. 直接写入 Flow 的图片上传控件，不弹 Windows 文件选择框；
3. 等待上传完成并将参考图附加到提示词；
4. 以 1–3 秒随机间隔模拟人工操作；
5. 确认新的图生视频请求已真实发出；
6. 只接受本次请求产生的新视频；
7. 下载视频并用 `ffmpeg` 提取首帧；
8. 首帧与本地参考图明显不相关时返回失败。

### 4. 使用 Flow 项目中的图片生成视频

```powershell
node flow.mjs --video `
  --ref avatar.webp --ref-source uploaded `
  --duration 4 --count 1x `
  "角色微笑并挥手"
```

项目素材只有名称、没有本地原文件，因此该模式会跳过自动首帧相似度校验。

### 5. 指定项目 URL

```powershell
node flow.mjs --video `
  --project-url "https://labs.google/fx/zh/tools/flow/project/YOUR_PROJECT_ID" `
  --ref E:\temp\avatar.webp --duration 4 `
  "镜头缓慢推进"
```

### 6. 批量生成

复制示例文件：

```powershell
Copy-Item .\examples\prompts.example.txt .\prompts.txt
node flow.mjs --batch .\prompts.txt `
  --ref avatar.png `
  --output .\downloads
```

批量文件规则：

```text
第一条提示词
第二条提示词

第一行空行之后的内容
会作为公共后缀追加到每条提示词
```

## 参数

| 参数 | 说明 | 默认值 |
|---|---|---|
| `<prompt>` | 图片或视频提示词 | 必填（使用 `--batch` 时除外） |
| `-b, --batch` | 批量提示词文件 | 无 |
| `-r, --ref` | Flow 项目素材名称或本地图片路径 | `avatar.png` |
| `--ref-source` | `uploaded` 或 `file`；本地路径会自动识别 | `uploaded` |
| `--video` | 启用图生视频 | `false` |
| `-d, --duration` | 视频时长：`4`、`6`、`8`、`10` 秒 | `8` |
| `--aspect` | 输出比例 | `16:9` |
| `--count` | 生成数量，如 `1x`、`2x`、`4x` | `1x` |
| `--model` | 图片生成模型；视频模式忽略 | `Nano Banana 2` |
| `--port` | Chrome CDP 端口 | `9221` |
| `-o, --output` | 图片、视频和首帧输出目录 | `./downloads` |
| `--timeout` | 等待生成的最长时间，单位毫秒 | `300000` |
| `--project-url` | Flow 项目 URL | 复用已打开项目或读取环境变量 |
| `--debug` | 保存关键步骤截图和 DOM 快照 | `false` |
| `-h, --help` | 显示完整帮助和示例 | — |

## 批量文件示例

仓库内提供 [examples/prompts.example.txt](./examples/prompts.example.txt)，可以直接复制修改。

## 输出

- 图片：按 Flow 返回格式保存，通常为 `.png`、`.jpg` 或 `.webp`。
- 视频：保存为 `.mp4` 或 `.webm`。
- 视频首帧：本地参考图模式保存为 `flow-video-first-frame.jpg`。
- 调试信息：使用 `--debug` 时写入 `debug/`。

## 常见问题

### 找不到 Flow 项目

先在 CDP Chrome 中打开一个 Flow 项目，或传入 `--project-url`/`FLOW_PROJECT_URL`。

### 右下角显示橙色 info 图标

将鼠标移到图标上查看原因。常见情况是 Flow 点数不足。可尝试 `--duration 4 --count 1x`，或充值后重试。

### 一直停留在媒体选择器

本地文件上传后，Flow 可能需要几十秒处理素材。CLI 最长等待两分钟，不会点击尚未启用的“添加到提示”按钮。

### 为什么没有弹 Windows 文件选择框

这是预期行为。CLI 直接向网页的文件 input 写入路径，避免原生文件框阻塞自动化。

### 下载到了历史视频

CLI 会在提交前记录页面中已有的视频 URL，并要求检测到新的生成请求和新媒体 URL，不会把历史视频当成结果。

### 首帧校验失败

生成视频的第一帧与本地参考图差异过大。首帧仍会保存在输出目录，便于人工检查。
