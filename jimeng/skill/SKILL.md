---
name: jimeng-image
description: 使用 jimeng CLI（字节跳动旗下即梦 AI）生成图片和视频。支持多模型、多种比例、高清分辨率。当用户需要生成配图、封面、海报、视频素材时使用。已全局安装，任意目录可执行。
---

# Jimeng AI — 即梦图片/视频生成

字节跳动旗下即梦 AI 的图像/视频生成 CLI。

- 本仓库源码：`media-cli/jimeng/cli`（API-first，可 `npm run build` 后本地调用）
- 若已全局安装 `@yang0/jimeng-cli`，可直接使用 `jimeng` 命令
- 平台总览：`media-cli/jimeng/README.md`

## 可用模型

### 图像模型
| 模型 | 说明 |
|------|------|
| `jimeng-5.0` | 最新最强 |
| `jimeng-4.6` | 最新 |
| `jimeng-4.5` | 推荐 |
| `jimeng-4.1` | 稳定 |
| `jimeng-4.0` | 稳定 |
| `jimeng-3.1` | 旧版 |
| `jimeng-3.0` | 旧版 |

### 视频模型
| 模型 | 说明 |
|------|------|
| `jimeng-video-3.0-pro` | 高质量视频 |
| `jimeng-video-3.0-fast` | 快速生成 |
| `jimeng-video-3.5-pro` | 最新视频模型 |
| `jimeng-video-seedance-2.0` | Seedance 高质量 |
| `jimeng-video-seedance-2.0-fast` | Seedance 快速 |

## 用法

```bash
# 生成图片
jimeng image generate \
  --model jimeng-5.0 \
  --ratio 16:9 \
  --prompt "提示词" \
  --output-dir outputs

# 生成视频
jimeng video generate \
  --model jimeng-video-3.5-pro \
  --prompt "提示词" \
  --output-dir outputs
```

### 参数说明

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `--model` | 模型名 | jimeng-4.5 |
| `--ratio` | 画面比例 | 1:1 |
| `--resolution` | 分辨率 | 2k |
| `--prompt` | 提示词（必填） | — |
| `--negative-prompt` | 负面提示词 | — |
| `--output-dir` | 输出目录 | ./pic/cli-image-generate |
| `--json` | JSON 格式输出 | — |
| `--wait` / `--no-wait` | 是否等待完成 | wait |

### 常用比例

| 比例 | 适用场景 |
|------|----------|
| `16:9` | 文章封面、横幅、YouTube 缩略图 |
| `1:1` | 社交媒体方形图 |
| `9:16` | 手机海报、小红书封面 |
| `4:3` | 演示文稿 |
| `3:4` | 竖版文章配图 |

## 核心工作流：baoyu 出提示词 → jimeng 出图

**不要手动写 jimeng 的 prompt。** 先用 baoyu skill 生成专业的图片提示词，再用 jimeng 渲染。

```
写作内容
  → skill(name="baoyu-cover-image")       # 生成封面图提示词
  → skill(name="baoyu-article-illustrator") # 生成配图提示词
  → jimeng image generate --prompt "..."    # 用 baoyu 的提示词出图
```

### 具体做法

**封面图**：
```
1. skill(name="baoyu-cover-image")  → 设置 type/concept, palette, mood
2. 从 baoyu-cover-image 的输出中提取 prompt
3. jimeng image generate --model jimeng-5.0 --ratio 16:9 --prompt "baoyu生成的prompt"
```

**文章配图**：
```
1. skill(name="baoyu-article-illustrator")  → 基于文章内容生成配图方案
2. 提取配图 prompt
3. jimeng image generate --model jimeng-5.0 --ratio 16:9 --prompt "baoyu生成的prompt"
```

**信息图** → 直接用 baoyu-infographic（SVG 出图，不需 jimeng）

## 与 baoyu 技能的分工

| 产出 | 提示词来源 | 渲染引擎 |
|------|-----------|----------|
| 文章封面 | `baoyu-cover-image` 设计概念+配色 | **jimeng** 出图 |
| 文章配图 | `baoyu-article-illustrator` 分析内容 | **jimeng** 出图 |
| 信息图 | `baoyu-infographic` 布局+风格 | **baoyu** 直接出 SVG |
| SVG 图表 | `baoyu-diagram` 图表类型+布局 | **baoyu** 直接出 SVG |
| 小红书卡片 | `baoyu-xhs-images` 风格+布局 | **baoyu** 直接出图 |
| 演示文稿 | `baoyu-slide-deck` 风格+内容 | **baoyu** 直接出图 |

## 输出文件

每次生成 4 张图片，命名格式：
```
{output-dir}/jimeng-image-generate-{timestamp}-{01-04}.png
```
