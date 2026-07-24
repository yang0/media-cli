# Jimeng（即梦）

字节跳动即梦 AI 的图片 / 视频生成工具集。

| 项目 | 说明 |
|------|------|
| 平台 | [即梦](https://jimeng.jianying.com) |
| 能力 | 文生图、文生视频、参考图、任务轮询与下载、积分查询 |
| 主路径 | **API-first CLI**（`cli/`） |
| 备选 | Playwright 浏览器机器人（`bot/`） |
| Agent | `skill/SKILL.md` |

## 能力矩阵

| 能力 | cli（推荐） | bot |
|------|:-----------:|:---:|
| 文生图 | ✅ | ✅ |
| 文生视频 | ✅ | — |
| 参考图 | ✅（视模型） | ✅ |
| Cookie 登录 | ✅ Netscape cookie 文件 | ✅ Cookie / Chrome profile |
| 任务历史 / 下载 | ✅ | ✅ |
| 积分查询 | ✅ | — |
| 每日提示词学习 | — | ✅ |
| 守护轮询 | 任务 wait | ✅ `run` 循环 |

## 目录结构

```text
jimeng/
├── README.md          # 本文件
├── cli/               # @yang0/jimeng-cli — API 优先 CLI（TypeScript）
│   ├── src/
│   ├── test/
│   ├── package.json
│   └── README.md
├── bot/               # auto_jimeng — Playwright 生图机器人（Python）
│   ├── jimeng_bot.py
│   ├── requirements.txt
│   └── README.md
└── skill/
    └── SKILL.md       # Agent 调用说明（对接全局 jimeng 命令）
```

## 快速开始

### 1. CLI（推荐）

```powershell
cd E:\projectHome\media-cli\jimeng\cli
npm install
npm run build
# 或开发模式：npm run dev -- --help

# 验证 cookie
node dist/cli.js auth check --cookie-file "G:\cookies\jimeng.txt"

# 生图并下载
node dist/cli.js image generate "一只霓虹狐狸，赛博朋克风格" `
  --download --cookie-file "G:\cookies\jimeng.txt"

# 生视频并下载
node dist/cli.js video generate "赛博朋克城市上空掠过一艘发光飞船" `
  --download --cookie-file "G:\cookies\jimeng.txt"
```

若已全局安装 `@yang0/jimeng-cli`：

```bash
jimeng models
jimeng credit --cookie-file "G:\cookies\jimeng.txt"
```

Cookie 需为 **Netscape** 格式（可用 Chrome 插件 *Get cookies.txt LOCALLY* 导出）。

### 2. Bot（浏览器自动化）

```powershell
cd E:\projectHome\media-cli\jimeng\bot
python -m pip install -r requirements.txt
python -m playwright install chromium

python jimeng_bot.py generate --prompt "赛博朋克街道上的橘猫，电影感"
python jimeng_bot.py poll --timeout 120
python jimeng_bot.py learn
```

默认数据 / Chrome 路径写在 `bot/README.md`（可按本机环境修改）。

### 3. Agent Skill

见 [`skill/SKILL.md`](./skill/SKILL.md)。典型链路：baoyu 系 skill 出提示词 → `jimeng image generate` 出图。

## 选型建议

| 场景 | 用哪个 |
|------|--------|
| 脚本/Agent 稳定批量出图出视频 | **cli** |
| 需要跟网页 UI 完全一致、或 API 暂不可用 | **bot** |
| 只改 Agent 说明、不改代码 | **skill** |

## 注意事项

- 默认图片链路为逆向网页接口，**非**官方公开 API；接口变更时需对照网页抓包更新。
- 勿将 cookie 文件、Chrome profile 提交进仓库。
- 积分与模型别名以 `jimeng models` / 网页实际展示为准。

## 来源

| 组件 | 原路径 |
|------|--------|
| cli | `E:\projectHome\jimeng-cli` |
| bot | `E:\projectHome\auto_jimeng` |
| skill | `~\.agents\skills\jimeng-image` |

相关但未迁入：`E:\projectHome\jimeng-api`（独立 HTTP 服务，体量较大，需要时可再并入 `jimeng/api/`）。
