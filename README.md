# media-cli

AI **生图 / 生视频** 多平台工具集合。

从 `E:\projectHome` 中零散的 CLI、浏览器自动化、Agent Skill 归集到此仓库，按 **平台分子目录**，统一文档与约定，方便人类与 Agent 调用。

盘点来源见 [`../tools-list/README.md`](../tools-list/README.md)。目录规范见 [`docs/CONVENTIONS.md`](./docs/CONVENTIONS.md)。

---

## 平台一览

| 平台目录 | 产品 | 图 | 视频 | 主接入方式 | 推荐入口 |
|----------|------|:--:|:----:|------------|----------|
| [`jimeng/`](./jimeng/) | 即梦 | ✅ | ✅ | API + Cookie | `jimeng/cli` |
| [`chatgpt/`](./chatgpt/) | chatgpt.com 生图 | ✅ | — | Chrome CDP | `chatgpt/cli` |
| [`higgsfield/`](./higgsfield/) | Higgsfield | ✅ | ✅* | CDP bot + 剧集编排 | `higgsfield/workflow`（真源 jinqianxinglixue） |
| [`dola/`](./dola/) | Dola | ✅ | ✅ | Chrome CDP | `dola/cli` |
| [`doubao/`](./doubao/) | 豆包 | ✅ | — | Chrome CDP | `doubao/cli` |
| [`flow/`](./flow/) | Google Flow | ✅ | ✅ | CDP + 扩展 | `flow/cli` / `extension` |

\* Higgsfield 完整视频/3D/音频能力走官方 `higgsfield` CLI；本地 `bot` 以批量生图为主。

---

## 怎么选平台

```text
要稳定 API、即梦积分/模型可控     → jimeng/cli
要 chatgpt.com 网页生图           → chatgpt/cli（来自 G:\初中 实战脚本）
要 Higgsfield 网页批量生图         → higgsfield/workflow（来自 jinqianxinglixue）
要营销/产品/Soul 官方 CLI 栈       → higgsfield/skills
要便宜网页批量、角色固定连出图    → dola/cli
要豆包会话里出图                  → doubao/cli
要 Google Nano Banana / Veo 流程  → flow/cli 或 flow/extension
```

---

## 仓库结构

```text
media-cli/
├── README.md                 # 本文件
├── .gitignore
├── docs/
│   └── CONVENTIONS.md        # 目录与 README 规范（新增平台必读）
├── jimeng/                   # 即梦：cli + bot + skill
├── chatgpt/                  # chatgpt.com 生图（CDP）
├── higgsfield/               # Higgsfield：bot + skills
├── dola/                     # Dola：cli
├── doubao/                   # 豆包：cli
└── flow/                     # Google Flow：cli + extension
```

每个平台目录内遵循：

```text
<platform>/
├── README.md        # 平台说明（必填）
├── cli/             # 命令行（可选）
├── bot/             # 长驻/批处理机器人（可选）
├── extension/       # Chrome 扩展（可选）
├── skill(s)/        # Agent Skill（可选）
└── tools/           # 辅助脚本（可选）
```

---

## 接入方式说明

| 类型 | 含义 | 典型平台 |
|------|------|----------|
| **API-first** | Cookie/Token 调 HTTP，无需盯着浏览器窗口 | jimeng/cli |
| **CDP** | 连接已登录 Chrome 的远程调试端口操作页面 | dola、doubao、flow/cli、higgsfield/bot |
| **Extension + 总控** | 页面注入 + 本地进程调度 | flow/extension |

### CDP 通用前置

1. 用独立 user-data-dir 启动 Chrome，并打开 remote debugging。
2. **手动登录**目标网站。
3. 不同平台可使用不同端口，避免抢同一个浏览器实例：

| 平台 | 文档默认端口 |
|------|----------------|
| chatgpt / dola | `9221`（chatgpt 与初中脚本一致；多开时请改端口） |
| doubao / flow / higgsfield bot | `9222`（以各 README 为准） |

---

## 快速命令索引

> 详细参数以各平台 README 为准；下列路径相对于 `media-cli/`。

### 即梦

```powershell
cd jimeng\cli
npm install ; npm run build
node dist\cli.js image generate "提示词" --download --cookie-file "G:\cookies\jimeng.txt"
node dist\cli.js video generate "提示词" --download --cookie-file "G:\cookies\jimeng.txt"
```

### Dola

```powershell
# Chrome: --remote-debugging-port=9221 且已登录
cd dola\cli
bun src\cli.js --new-chat --image-gen --prompt "提示词" --out downloads
bun src\cli.js --video-gen --duration 5 --aspect-ratio 16:9 --prompt "提示词" --out downloads
```

### 豆包

```powershell
# Chrome: --remote-debugging-port=9222 且已登录
cd doubao\cli
bun src\cli.js --session "https://www.doubao.com/chat/<id>" --prompt "提示词" --out downloads
```

### Higgsfield（真源：jinqianxinglixue）

```powershell
cd higgsfield\bot
npm install

# 剧集批量（默认项目根 E:\projectHome\jinqianxinglixue）
cd ..\workflow
node generate_images.js ep01
node generate_images.js ep01 --dry-run

# 仅引擎：任意 prompts 文件
node ..\bot\higgsfield-bot.js -p prompts.txt -o .\downloads
```

### Google Flow 生图

```powershell
cd flow\cli
npm install
node flow.mjs "提示词"
```

### ChatGPT.com 生图

```powershell
# Chrome: --remote-debugging-port=9221 且已登录 chatgpt.com
cd chatgpt\cli
node src\cli.mjs dry-run
node src\cli.mjs generate --prompt "提示词" -o downloads
node src\cli.mjs batch --prompts-dir .\prompts -o .\figures
```

---

## 迁移对照（原路径 → 本仓库）

| 原路径 | 迁入位置 | 备注 |
|--------|----------|------|
| `jimeng-cli` | `jimeng/cli` | API CLI，含测试 |
| `auto_jimeng` | `jimeng/bot` | Playwright 机器人 |
| `~/.agents/skills/jimeng-image` | `jimeng/skill` | Agent 说明 |
| `G:\初中\generate_wenyuan_grade8_images.mjs` | `chatgpt/cli` | 抽取通用 CDP 生图；业务批处理仍留初中工程 |
| **`jinqianxinglixue/generate_images.js`** | **`higgsfield/workflow`** | **生图主路径真源** |
| `jinqianxinglixue/docs/image-prompt-spec.md` | `higgsfield/docs/` | 配图规范 |
| `higgfield-free` / npm `higgsfield-bot` | `higgsfield/bot` | 引擎（原目录拼写 higgfield） |
| `.agents/skills/higgsfield-*` | `higgsfield/skills/*` | 官方 CLI 手册，未含 websites |
| `dola-cli` | `dola/cli` | 仅核心源码与文档 |
| `doubao-img` | `doubao/cli` | 仅 cli 核心，不含剧集批处理脚本 |
| `flow-cli` | `flow/cli` | |
| `flow-skill` | `flow/extension` | 扩展 + 必要 scripts |

### 有意未迁入

| 路径 | 原因 |
|------|------|
| `jimeng-api` | 独立 HTTP 服务，体积与部署形态不同；需要可再放 `jimeng/api/` |
| `banana_utils` / flow2api | 含 GUI 与完整 API 网关，职责超出「单平台 CLI」 |
| `doubao-img` 内大量 ep 批处理脚本 | 业务临时脚本，非通用工具 |
| `higgsfield-websites` | 建站，非生图生视频 |
| `auto_sora` / Sora 扩展总控 | **已删除**（站点/能力停用） |
| 各项目 `node_modules`、downloads、session、cookies | 本地状态与密钥，禁止入库 |

迁移策略为 **复制归集**（Sora 除外，已物理删除源项目）；后续可按需把全局安装 / PATH 指到本仓库。

---

## 安全与合规

- **禁止**提交 cookie、Chrome profile、session JSON、账号池中的密钥。
- 自动化仅限你有权使用的账号；遵守各平台 ToS 与速率限制。
- 逆向 API（如即梦网页接口）可能随官网变更失效，需自行维护。

---

## 新增平台

1. 阅读 [`docs/CONVENTIONS.md`](./docs/CONVENTIONS.md)。
2. 新建 `<platform>/README.md` + 对应 `cli|bot|extension|skill`。
3. 更新本文件的「平台一览」与「迁移对照」表。

---

## License

各子工具保留其原有许可证与作者信息；本仓库作为归集与文档层，不改变上游许可。
