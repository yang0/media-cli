# Dola

通过 Chrome CDP 控制已登录的 Dola 网页会话，提交对话、**生图**、**生视频**，并下载结果。

| 项目 | 说明 |
|------|------|
| 平台 | [dola.com](https://www.dola.com) |
| 能力 | 聊天附件、文生图、角色固定批量生图、文生视频、账号池 |
| 接入方式 | **CDP（默认端口 9221）** |
| 运行时 | Bun / Node，零 npm 运行时依赖 |

## 能力矩阵

| 能力 | 支持 |
|------|:----:|
| 文本 / 附图对话 | ✅ |
| 文生图 | ✅ `--image-gen` |
| 批量提示词文件 | ✅ `--batch-prompt-file` |
| 固定角色参考图批处理 | ✅ `--character-image` + `--character-prompt` |
| 文生视频 | ✅ `--video-gen`（时长 / 比例 / 多参考图） |
| 下载最近视频 | ✅ `--download-last-video` |
| 账号池 + 日配额切换 | ✅ `--account-pool` |
| 断点续传 | ✅ `--resume` + 本地 session JSON |
| 无水印优先下载 | ✅（可用 `--allow-watermark` 放宽） |

## 目录结构

```text
dola/
├── README.md
└── cli/
    ├── package.json          # bin: dola
    ├── src/
    │   └── cli.js            # 主入口（单文件）
    ├── regenerate_images.py  # 辅助：补图脚本
    └── README.md             # 详细参数与账号池说明
```

## 快速开始

### 1. 启动已登录 Chrome

```powershell
chrome.exe --remote-debugging-port=9221
```

在浏览器中打开并登录 Dola。

### 2. 安装与运行

```powershell
cd E:\projectHome\media-cli\dola\cli
# 无第三方依赖；Bun 或 Node 均可
bun src\cli.js --help
# 或
node src\cli.js --help
```

### 3. 常用命令

**生图（新会话）**

```powershell
bun src\cli.js --new-chat --image-gen `
  --prompt "A simple green circle icon on a white background" `
  --count 1 --out downloads
```

**固定角色批量生图**

```powershell
bun src\cli.js --new-chat `
  --character-image "E:\path\to\avatar.png" `
  --character-prompt "这是主角的形象，请记住" `
  --batch-prompt-file prompts.txt `
  --out downloads
```

**生视频**

```powershell
bun src\cli.js --video-gen `
  --duration 5 --aspect-ratio 16:9 `
  --file "E:\temp\first.png" `
  --prompt "A paper boat sailing through a rainy neon city" `
  --out downloads
```

**账号池 + 续传**

```powershell
bun src\cli.js --account-pool "G:\cookies\dola" `
  --new-chat --resume `
  --character-image "E:\path\to\avatar.png" `
  --character-prompt "这是主角的形象，请记住" `
  --batch-prompt-file prompts.txt --out downloads
```

更完整的参数、错误码、账号池 JSON schema 见 [`cli/README.md`](./cli/README.md)。

## 错误码（节选）

| 码 | 含义 |
|----|------|
| `IMAGE_GENERATION_QUOTA_EXHAUSTED` | 额度用尽 |
| `IMAGE_GENERATION_REFUSED` | 内容拒绝 |
| `IMAGE_GENERATION_TIMEOUT` | 等待超时 |
| `IMAGE_GENERATION_DUPLICATE_HASH` | 连续重复图，停止批处理 |
| `ACCOUNT_POOL_EXHAUSTED` | 池内账号当日均不可用 |

## 注意事项

- 默认 CDP 端口 **9221**（与 doubao 的 9222 刻意区分，可多开）。
- 不处理验证码 / 登录弹窗；浏览器需已登录。
- `.dola-cli-session*.json`、cookie 目录勿提交仓库。

## 来源

| 组件 | 原路径 |
|------|--------|
| cli | `E:\projectHome\dola-cli` |
