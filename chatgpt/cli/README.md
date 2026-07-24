# chatgpt-img

通过 **chatgpt.com** 网页（已登录 Chrome + CDP）提交提示词并下载生成图片。

核心逻辑来自 `G:\初中\generate_wenyuan_grade8_images.mjs`（文渊八年级卡片批量生图实战脚本）：DOM 选择器、输入校验、超时宽限、文字回复换标签重试等均已在批量任务中验证。

## 前置条件

1. Node.js ≥ 20  
2. Chrome 以远程调试启动，并登录 ChatGPT：

```powershell
& "C:\Program Files\Google\Chrome\Application\chrome.exe" `
  --remote-debugging-port=9221 `
  --user-data-dir="D:\chrome-profiles\chatgpt" `
  "https://chatgpt.com/"
```

默认 CDP 端口 **9221**（与 `G:\初中` 脚本一致）。

## 安装

无第三方依赖：

```powershell
cd E:\projectHome\media-cli\chatgpt\cli
node src\cli.mjs --help
```

可选全局 bin：

```powershell
npm link
chatgpt-img --help
```

## 命令

### 检查连接

```powershell
node src\cli.mjs dry-run --port 9221
```

### 单次生图

```powershell
node src\cli.mjs generate --prompt "一只赛博朋克橘猫，电影感灯光" -o downloads

node src\cli.mjs generate --prompt-file .\prompt.md -o downloads --name card-001
```

### 批量

目录内每个 `.md` / `.txt` 一条提示词，文件名（无扩展名）作为输出 basename：

```powershell
node src\cli.mjs batch --prompts-dir .\prompts -o .\figures --port 9221
```

文本文件每行一条（`#` 开头为注释）：

```powershell
node src\cli.mjs batch --prompt-list prompts.txt -o .\figures --limit 10
```

已存在同名图片会跳过。结束后写入 `figures/chatgpt-batch-report.json`。

## 常用选项

| 选项 | 说明 | 默认 |
|------|------|------|
| `--port` | Chrome CDP 端口 | `9221` |
| `-o` / `--out` | 输出目录 | `./downloads` |
| `--name` | 单次输出文件名（无扩展名） | 时间戳 |
| `--wait-seconds` | 等待生图秒数 | `300` |
| `--retries` | 失败/文字回复时换新标签重试次数 | `2` |
| `--limit` | 批量最多条数 | 不限制 |

## 与 G:\初中 批处理的关系

| 路径 | 职责 |
|------|------|
| **本 CLI** | 通用 chatgpt.com 生图（单条 / 批量文件） |
| `G:\初中\generate_wenyuan_grade8_images.mjs` | 业务批处理：扫 `cards.md` + `prompts/<ID>.md`、按卡片 ID 落盘、回写 Markdown、状态文件 |

文渊卡片流水线请继续在 `G:\初中` 运行原脚本；通用生图请用本工具。

## 注意事项

- 不处理登录 / CAPTCHA；浏览器需已登录且具备生图权限。  
- 依赖 chatgpt.com 前端 DOM（`group/imagegen-image` 等），官网改版后可能需更新 `src/chatgpt-image.mjs`。  
- 若返回纯文字（拒绝 / 安全策略），会换新标签重试；仍失败则记为 `skipped-text`。  
- 勿将 Chrome profile、会话 cookie 提交进仓库。

## 源文件

| 文件 | 说明 |
|------|------|
| `src/cli.mjs` | 命令行入口 |
| `src/cdp.mjs` | 轻量 CDP WebSocket 客户端 |
| `src/chatgpt-image.mjs` | 连接 / 发送 / 等待 / 下载 |
