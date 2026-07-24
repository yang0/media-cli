# media-cli 目录与平台规范

本文档定义 `media-cli` 仓库的统一约定。新增平台或工具时请先对齐本规范，再提交代码。

---

## 1. 仓库定位

`media-cli` 是 **AI 生图 / 生视频平台工具集合**，面向：

- 人工在终端调用
- Agent / Skill 编排调用
- 多账号、批处理、可续传工作流

**不包含**：配音管线、视频下载器、剪辑合成等（那些仍在各自项目中）。

---

## 2. 顶层目录结构

```text
media-cli/
├── README.md                 # 总览、平台索引、快速对照
├── .gitignore
├── docs/
│   └── CONVENTIONS.md        # 本规范
├── jimeng/                   # 平台：即梦
├── chatgpt/                  # 平台：chatgpt.com 生图
├── higgsfield/               # 平台：Higgsfield（生图真源 jinqianxinglixue）
├── dola/                     # 平台：Dola
├── doubao/                   # 平台：豆包
└── flow/                     # 平台：Google Flow (Veo / Nano Banana)
```

规则：

| 规则 | 说明 |
|------|------|
| **一平台一顶层目录** | 目录名使用小写英文，与品牌常用称呼一致 |
| **禁止跨平台共享业务代码** | 公共约定写在 `docs/`，不要做「超级统一 SDK」 |
| **原项目可保留** | 迁移优先 **复制** 可运行源码；原路径见各平台 README「来源」 |

---

## 3. 单平台目录模板

每个平台目录应尽量符合：

```text
<platform>/
├── README.md           # 必填：平台说明 + 工具清单 + 快速开始
├── cli/                # 可选：主 CLI（Node / Bun / Python）
│   ├── package.json 或 requirements.txt
│   ├── src/ 或入口脚本
│   └── README.md       # 可选：CLI 详细参数（可与平台 README 合并）
├── bot/                # 可选：浏览器自动化 / 批处理机器人
├── extension/          # 可选：Chrome 扩展
├── skill/ 或 skills/   # 可选：Agent Skill（SKILL.md + references）
├── api/                # 可选：HTTP 服务端封装
└── tools/              # 可选：一次性诊断 / 辅助脚本
```

### 3.1 子目录职责

| 子目录 | 何时使用 | 典型入口 |
|--------|----------|----------|
| `cli/` | 可安装、可 `--help` 的命令行 | `bin` 字段 / `python -m` |
| `bot/` | 长驻轮询、学习、多任务守护 | `python bot.py generate` |
| `extension/` | 必须注入页面 DOM / 与页面脚本通信 | `manifest.json` |
| `skill/` | 给 Claude / Codex / Grok 等 Agent 的操作手册 | `SKILL.md` |
| `api/` | 对外 HTTP（OpenAI 兼容等） | `docker-compose` / `src/index.ts` |
| `tools/` | 非主路径的辅助脚本 | 单文件脚本 |

### 3.2 命名

- 平台目录：`jimeng`、`doubao`、`chatgpt`（不用中文目录名）
- CLI 包名：可保留历史名（如 `doubao-img`），但 README 标题用平台名
- 二进制命令：尽量短且不冲突，例如 `jimeng`、`dola`、`doubao-img`、`flow-cli`、`higgsfield-bot`

---

## 4. README 最低要求

每个 **平台** `README.md` 必须包含：

1. **一句话定位**（图 / 视频 / 两者；API 还是 CDP）
2. **能力矩阵**（表格：图、视频、参考图、批量、账号池…）
3. **目录说明**（本平台下有哪些子工具）
4. **环境依赖**（Node/Bun/Python、Chrome CDP、cookie 路径）
5. **快速开始**（可复制的 3～5 条命令）
6. **来源路径**（从 `E:\projectHome\...` 迁移而来）
7. **注意事项**（登录态、风控、水印、配额）

根 `README.md` 只做索引与选型，不把每个 CLI 的全部参数写爆。

---

## 5. 接入方式分类

迁移进来的工具按实现方式分三类，README 里建议标清：

| 类型 | 说明 | 例子 |
|------|------|------|
| **API-first** | Cookie / Token 调 HTTP，无需常驻浏览器 | `jimeng/cli` |
| **CDP 浏览器** | 连接已登录 Chrome 调试端口操作页面 | `dola`、`doubao`、`flow/cli`、`higgsfield/bot` |
| **扩展 + 总控** | Chrome Extension + 本地控制进程 | `flow/extension` |

CDP 类默认约定：

- 端口在 README 中写死默认值（可覆盖）
- **不**在仓库中提交 cookie、profile、session 文件
- 输出目录默认 `./downloads`（已 gitignore）

---

## 6. 依赖与安装

- **Node / Bun 工具**：依赖写在各自 `package.json`，不在仓库根强行 monorepo workspace（除非后续统一发布）
- **Python 工具**：`requirements.txt` 放在对应子目录
- 安装示例统一用相对路径：

```powershell
cd media-cli\dola\cli
bun install   # 或 npm install
```

---

## 7. 输出与状态文件

| 类型 | 约定 |
|------|------|
| 媒体输出 | `downloads/` 或用户 `--out` 指定 |
| 断点续传 | 本地 state JSON（如 `.dola-cli-session.json`），**勿提交** |
| 账号池配置 | 用户本地 JSON / cookie 目录，仓库只给 schema 示例 |

---

## 8. 新增平台检查清单

- [ ] 在根目录创建 `<platform>/`
- [ ] 编写平台 `README.md`（含能力矩阵与来源）
- [ ] 源码放入 `cli/` / `bot/` / `extension/` / `skill/` 之一
- [ ] 更新根 `README.md` 平台索引表
- [ ] 确认 `.gitignore` 覆盖 downloads / session / cookies
- [ ] 不在仓库内提交密钥、cookie、Chrome profile

---

## 9. 与 tools-list 的关系

`E:\projectHome\tools-list` 是资产盘点报告；`media-cli` 是生图生视频工具的 **可运行归集仓库**。  
盘点里提到的其他工具（TTS、下载器、发布）**不**迁入本仓。
