# Google Flow

Google Flow（labs.google Flow / Veo / Nano Banana 等）的图片与图生视频自动化工具。

| 项目 | 说明 |
|------|------|
| 平台 | [Google Flow](https://labs.google/fx/tools/flow) / [flow.google](https://flow.google/) |
| 能力 | 文生图（参考图）、图生视频（扩展桥） |
| 接入方式 | CDP CLI + Chrome Extension |

## 能力矩阵

| 能力 | cli | extension |
|------|:---:|:---------:|
| 文生图 + 参考图 | ✅ | — |
| 模型 / 比例 / 数量 | ✅ | — |
| 图生视频 | — | ✅ |
| 调试截图 / DOM | ✅ `--debug` | 辅助 scripts |
| 需已登录 Google | ✅ | ✅ |

## 目录结构

```text
flow/
├── README.md
├── cli/                    # flow-cli：CDP 生图
│   ├── flow.mjs
│   ├── package.json
│   └── README.md
└── extension/              # Flow Skill Bridge：图生视频
    ├── manifest.json
    ├── background.js
    ├── content.js
    ├── popup.*
    ├── scripts/
    │   ├── send_flow_request.py
    │   ├── launch_profile3_debug.ps1
    │   └── ...
    └── README.md
```

## 快速开始

### A. CLI 生图

```powershell
cd E:\projectHome\media-cli\flow\cli
npm install

# Chrome: --remote-debugging-port=9222 且已登录 Flow 项目
node flow.mjs "一个小女孩在森林里走路"

# 常用参数
node flow.mjs "一只猫在睡觉" -r ./my-cat.png --ref-source file
node flow.mjs "提示词" --aspect 16:9 --count 1x --model "Nano Banana 2" -o ./downloads
```

默认流程：连接 CDP → 打开/复用项目页 → 输入提示词 → 选参考图 → 设置模型比例 → 创建 → 下载到 `downloads/`。

### B. Extension 图生视频

1. 用调试模式启动 Chrome 并加载未打包扩展（见 `extension/scripts/launch_profile3_debug.ps1` 或手动 Load unpacked 指向 `extension/`）。
2. 打开 Flow 页面并保持登录。
3. 发送请求：

```powershell
cd E:\projectHome\media-cli\flow\extension
python .\scripts\send_flow_request.py `
  --prompt "A slow cinematic dolly shot of the subject, soft morning light" `
  --image "E:\path\to\input.png"
```

扩展会先确认图片上传成功，再填提示词并点生成，避免静默退化为纯文生视频。

## 选型建议

| 场景 | 用哪个 |
|------|--------|
| Nano Banana 等 Flow 内生图 | **cli** |
| 已有图 → Veo 类视频 | **extension** |
| 完整 API 网关（OpenAI 兼容） | 见外部 `banana_utils/flow/flow2api`（未迁入） |

## 注意事项

- Google 前端与地区限制变动频繁；失败时用 `cli` 的 `--debug` 或 extension 的 DOM 脚本排查。
- 需可用的 Google 账号与 Flow 访问权限。
- 勿提交登录 cookie（如 `labs.google_cookies.txt`）。

## 来源

| 组件 | 原路径 |
|------|--------|
| cli | `E:\projectHome\flow-cli` |
| extension | `E:\projectHome\flow-skill`（仅扩展与必要 scripts，不含调试 JSON/截图） |

相关未迁入：`E:\projectHome\banana_utils`（含 flow2api 与 GUI，体量与职责更杂）。
