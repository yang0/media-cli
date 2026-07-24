# Higgsfield

Higgsfield AI **网页 CDP 批量生图**工具集。

| 项目 | 说明 |
|------|------|
| 平台 | [higgsfield.ai](https://higgsfield.ai) |
| **生图真源** | **`E:\projectHome\jinqianxinglixue`**（金钱心理学剧集实战） |
| 编排层 | `workflow/generate_images.js` ← `jinqianxinglixue/generate_images.js` |
| 引擎层 | `bot/higgsfield-bot.js`（CDP 提交 + 下载 + 续传） |
| 官方 CLI Skills | `skills/`（营销/Soul 等，与网页 bot **不是**同一协议） |

## 能力矩阵

| 能力 | workflow（剧集编排） | bot（引擎） | skills + 官方 CLI |
|------|:--------------------:|:-----------:|:-----------------:|
| 按合并字幕批量生图 | ✅ | — | — |
| 提示词文件批量提交 | 调用 bot | ✅ | ✅ |
| 断点续传（按序号） | ✅ | ✅ | 视官方 |
| 固定风格 keep-line | ✅ 内置 3D 口播风 | ✅ | — |
| 多模型（页面显示名） | ✅ `-m` | ✅ | ✅ |
| 视频 / 3D / Soul 营销栈 | — | — | ✅ |

## 目录结构

```text
higgsfield/
├── README.md                 # 本文件
├── docs/
│   └── image-prompt-spec.md  # 配图提示词规范（来自 jinqianxinglixue）
├── workflow/                 # ★ 生图主路径：剧集批处理
│   ├── README.md
│   └── generate_images.js
├── bot/                      # CDP 引擎（higgsfield-bot）
│   ├── higgsfield-bot.js
│   └── package.json
└── skills/                   # 官方 higgsfield CLI 的 Agent 手册（可选）
    ├── higgsfield-generate/
    ├── higgsfield-product-photoshoot/
    ├── higgsfield-marketplace-cards/
    └── higgsfield-soul-id/
```

## 推荐用法（与真源一致）

### 1. 安装 bot 依赖

```powershell
cd E:\projectHome\media-cli\higgsfield\bot
npm install
```

### 2. Chrome + 登录 Higgsfield

Bot 默认连 `http://localhost:9222`。请用已登录 profile 启动调试 Chrome（常量见 `bot/higgsfield-bot.js` 顶部，可按本机修改）。

### 3. 对 jinqianxinglixue 剧集生图

```powershell
cd E:\projectHome\media-cli\higgsfield\workflow

# 默认 --root = E:\projectHome\jinqianxinglixue
node generate_images.js ep01
node generate_images.js ep06-ep20 -c 2
node generate_images.js all --dry-run
```

输出落到：

```text
jinqianxinglixue/episodes/<...>/visuals/
  higgsfield-prompts.txt
  higgsfield-manifest.json
  images/
```

### 4. 任意提示词文件（不绑剧集）

```powershell
node E:\projectHome\media-cli\higgsfield\bot\higgsfield-bot.js `
  -p prompts.txt -m "FLUX.2 Pro" -c 2 -o .\downloads
```

## 分层说明

| 层 | 做什么 | 来源 |
|----|--------|------|
| **workflow** | 读合并字幕 → 写 prompts → 调 bot → 核对张数 | `jinqianxinglixue/generate_images.js` |
| **bot** | Puppeteer-core 连 Chrome，页面提交/下载/续传 | `higgfield-free` / 全局 `higgsfield-bot`（jinqian 脚本原调用对象） |
| **docs** | 口播配图字段规范 | `jinqianxinglixue/docs/image-prompt-spec.md` |
| **skills** | 官方 CLI 模型路由与营销模板 | `.agents/skills/higgsfield-*` |

> 口播分镜生成（SRT → image-prompts.md）仍在业务仓：  
> `jinqianxinglixue/tools/subtitle-image-storyboard/`，不迁入本目录。

## 注意事项

- 网页 DOM 改版会导致 bot 失效；业务侧以 jinqian 跑通的版本为准同步。  
- `bot` 内硬编码 Chrome 路径/profile 时，换机器先改常量。  
- 勿提交 profile、`.higgsfield-state.json`、下载图。  
- `skills` 依赖官方 `higgsfield` CLI 登录，与 CDP bot 独立。

## 来源对照

| 组件 | 路径 |
|------|------|
| **生图编排（真源）** | `E:\projectHome\jinqianxinglixue\generate_images.js` |
| 提示词规范 | `E:\projectHome\jinqianxinglixue\docs\image-prompt-spec.md` |
| CDP 引擎包 | `E:\projectHome\higgfield-free`（npm: `higgsfield-bot`） |
| 官方 skills | `E:\projectHome\.agents\skills\higgsfield-*` |
