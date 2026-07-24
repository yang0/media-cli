# Higgsfield 剧集批量生图工作流

**来源真源**：`E:\projectHome\jinqianxinglixue\generate_images.js`

本目录是金钱心理学口播系列在 Higgsfield 上的**实战编排层**；真正往网页提交任务、轮询下载的是上层 `../bot`（`higgsfield-bot`）。

## 链路

```text
episodes/<集>/media/audio/narration-zh-merged.md
        │
        ▼  buildHiggsfieldPrompts()
episodes/<集>/visuals/higgsfield-prompts.txt
episodes/<集>/visuals/higgsfield-manifest.json
        │
        ▼  node ../bot/higgsfield-bot.js -p ... -o ...
episodes/<集>/visuals/images/   (01.png / 02.webp … 可续传)
```

固定风格约束（`-k` keep-line）写在脚本内 `REQUIRED_KEEP`：3D 动画电影风、画内无文字/字幕/水印、前中后景与角色动作等——与口播配图规范一致。

## 前置

1. 安装 bot 依赖：

```powershell
cd E:\projectHome\media-cli\higgsfield\bot
npm install
```

2. Chrome 远程调试 + 登录 [higgsfield.ai](https://higgsfield.ai)（bot 默认 CDP `http://localhost:9222`，profile 见 `bot/higgsfield-bot.js` 顶部常量）。

3. 内容项目目录存在，且目标集已有合并字幕：

```text
<ROOT>/episodes/.../media/audio/narration-zh-merged.md
```

默认 `ROOT` = `E:\projectHome\jinqianxinglixue`。

## 用法

```powershell
cd E:\projectHome\media-cli\higgsfield\workflow

# 单集 / 多集 / 范围 / 全部
node generate_images.js ep01
node generate_images.js ep02 ep03
node generate_images.js ep06-ep20
node generate_images.js all

# 只生成提示词，不提交
node generate_images.js ep01 --dry-run

# 模型与并发
node generate_images.js ep01 -m "FLUX.2 Pro" -c 2

# 指定内容项目根（默认真源 jinqianxinglixue）
node generate_images.js ep01 --root "E:\projectHome\jinqianxinglixue"
```

等价环境变量：`JINQIAN_ROOT` 或 `HIGGSFIELD_PROJECT_ROOT`。

## 与原项目脚本关系

| 文件 | 说明 |
|------|------|
| `jinqianxinglixue/generate_images.js` | 业务仓内原入口（解析全局 npm 的 higgsfield-bot） |
| **本目录 `generate_images.js`** | 归集版：优先调用 `media-cli/higgsfield/bot`，支持 `--root` |

行为与剧集映射保持一致；后续改映射或 keep-line 时，建议两边同步，或以本仓为工具真源、业务仓改薄封装。

## 提示词规范

见 [`../docs/image-prompt-spec.md`](../docs/image-prompt-spec.md)（同样来自 jinqianxinglixue）。  
分镜/SRT 侧工具仍在业务仓：`jinqianxinglixue/tools/subtitle-image-storyboard/`。

## 通用「只跑 bot」

不绑剧集、只有提示词文件时，直接：

```powershell
node ..\bot\higgsfield-bot.js -p prompts.txt -m "FLUX.2 Pro" -c 2 -o .\downloads
```
