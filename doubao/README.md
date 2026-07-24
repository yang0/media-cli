# Doubao（豆包）

通过 Chrome CDP 控制已登录的豆包网页会话，提交提示词并下载生成图片。

| 项目 | 说明 |
|------|------|
| 平台 | [豆包](https://www.doubao.com) |
| 能力 | 文生图、附图问答、新会话、图片 URL 捕获与本地下载 |
| 接入方式 | **CDP（默认端口 9222）**，直连 `http://127.0.0.1:9222/json/*` |
| 运行时 | Bun / Node，无 Playwright 依赖 |

## 能力矩阵

| 能力 | 支持 |
|------|:----:|
| 文生图并下载 | ✅ |
| 指定会话 URL / id | ✅ `--session` |
| 新开会话 | ✅ `--new-chat` |
| 本地文件附图 | ✅ `--file` |
| 只提交不等图 | ✅ `--no-download` |
| 干跑校验浏览器 | ✅ `--dry-run` |
| 视频生成 | —（请用 jimeng / dola / flow） |

## 目录结构

```text
doubao/
├── README.md
└── cli/
    ├── package.json       # bin: doubao-img
    ├── src/
    │   └── cli.js
    ├── tools/
    │   └── upload_char.ts # 角色图相关辅助
    └── README.md
```

## 快速开始

### 1. 启动已登录 Chrome

```powershell
& "C:\Program Files\Google\Chrome\Application\chrome.exe" `
  --remote-debugging-port=9222 `
  --user-data-dir="D:\chrome-profiles\doubao-cdp" `
  "https://www.doubao.com/"
```

### 2. 运行 CLI

```powershell
cd E:\projectHome\media-cli\doubao\cli
bun install   # 可选，仅类型声明
bun src\cli.js `
  --session "https://www.doubao.com/chat/<id>" `
  --prompt "生成一张赛博朋克猫海报" `
  --out downloads `
  --count 1
```

附图但不下载：

```powershell
bun src\cli.js `
  --session "https://www.doubao.com/chat/<id>" `
  --file "E:\temp\aa.png" `
  --prompt "请解释图片" `
  --no-download
```

新会话并拿到 `finalUrl`：

```powershell
bun src\cli.js --new-chat --file "E:\temp\aa.png" --prompt "请解释图片" --no-download
```

## 实现说明

- 不依赖 Playwright；直接使用 CDP WebSocket。
- 图片检测结合 **网络 JSON 捕获** 与 **DOM 扫描**（豆包前端变更时更稳）。
- 无水印原始图 URL 策略参考社区 doubao-downloader 等项目（见 `cli/README.md`）。

## 注意事项

- 浏览器必须已登录；不处理 CAPTCHA / 登录框。
- 会话 state 文件（`.doubao-img*.json`）仅本地使用，勿提交。
- 原项目中大量 `generate-ep*.js` / `check-*.js` 为单次剧集批处理脚本，**未迁入**；需要时从 `E:\projectHome\doubao-img` 取。

## 来源

| 组件 | 原路径 |
|------|--------|
| cli 核心 | `E:\projectHome\doubao-img`（仅 `src/cli.js` + 包配置 + 有用工具） |
