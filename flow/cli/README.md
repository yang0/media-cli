# flow-cli

通过 Chrome DevTools Protocol (CDP) 控制 Google Flow 生成图片和图生视频的 CLI 工具。

## 前置条件

1. 已安装 Node.js (>= 18)。
2. 已安装 `ffmpeg`，并可从命令行直接执行。
3. Chrome 浏览器以调试模式启动，端口为 `9221`：
   ```bash
   # Windows 示例
   chrome.exe --remote-debugging-port=9221
   ```
4. 在 Chrome 中已登录 Google Flow，并可以访问目标项目：
   `https://labs.google/fx/zh/tools/flow/project/1d49f864-c38c-4365-b144-1d4e7d7d2ca2`

## 安装

```bash
npm install
```

## 使用

```bash
node flow.mjs "提示词"
```

### 示例

```bash
node flow.mjs "一个小女孩在森林里走路"
```

图片将保存到 `./downloads` 目录。

### 图生视频

```powershell
node flow.mjs --video `
  --ref E:\temp\avatar.webp --ref-source file `
  --duration 8 --aspect 16:9 --port 9221 `
  "主体缓慢转身并看向镜头，电影感运镜"
```

视频模式会先设置时长、比例和数量，再上传并附加起始帧，最后提交创建；关键步骤之间加入 1–3 秒随机延时。下载完成后会提取首帧，并与本地参考图比较，明显不相关时直接报错。

### 常用选项

| 选项 | 说明 | 默认值 |
|------|------|--------|
| `-r, --ref` | 参考图名称（已上传）或本地文件路径 | `avatar.png` |
| `--ref-source` | 参考图来源：`uploaded`（项目已上传）/ `file`（本地上传） | `uploaded` |
| `--aspect` | 宽高比 | `16:9` |
| `--count` | 生成数量，如 `1x`、`2x`、`4x` | `1x` |
| `--model` | 模型名称 | `Nano Banana 2` |
| `--video` | 启用图生视频 | `false` |
| `--duration` | 视频时长（秒） | `8` |
| `--port` | Chrome CDP 端口 | `9221` |
| `-o, --output` | 图片保存目录 | `./downloads` |
| `--timeout` | 最大等待生成时间（毫秒） | `300000` |
| `--debug` | 保存每步截图与 DOM 快照到 `debug/` | `false` |

### 更多示例

使用本地上传参考图：

```bash
node flow.mjs "一只猫在睡觉" -r ./my-cat.png --ref-source file
```

指定输出目录与调试：

```bash
node flow.mjs "一个小女孩在森林里走路" -o ./images --debug
```

## 工作流程

1. 连接 Chrome CDP（默认端口 `9221`）。
2. 打开或复用 Google Flow 项目页面。
3. 随机延迟 1-3 秒模拟人类操作。
4. 清空并输入提示词。
5. 打开媒体选择器，从“上传的内容”中选择参考图（默认 `avatar.png`），点击“添加到提示”。
6. 确认模型/比例/数量设置（默认 `Nano Banana 2`、`16:9`、`1x`）。
7. 点击“创建”并等待生成完成。
8. 下载生成的图片或视频到目标目录；本地参考图模式还会保存并校验视频首帧。

## 文件说明

- `flow.mjs` — 主 CLI 入口。
- `package.json` — 项目配置与依赖。
- `downloads/` — 默认图片输出目录。
- `debug/` — 启用 `--debug` 时保存的截图与 DOM 快照。
