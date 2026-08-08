# volc-tts (media-cli) — 火山引擎口播稿转音频+字幕

> media-cli 平台的 TTS/ASR 工具。输入口播稿（Markdown/TXT），一键生成配音 MP3 + SRT 字幕。
> 迁移自 `E:\projectHome\volc-tts`（huobijueqi 项目的 TTS 方案），对齐 media-cli 结构。

## 能力

| 功能 | 说明 |
|---|---|
| TTS | 火山 seed-tts-2.0（v3 HTTP 单向流），多语种（zh/en/ja/es-mx/id/pt-br/ko） |
| ASR 字幕 | 火山 seedasr（bigmodel），从生成音频自动识别出带时间戳的 SRT |
| 多语种 | `multi` 命令：zh/en/ja 三语 + 自动翻译（DashScope qwen-plus）或读 script-{lang}.md + 时长对齐 |
| 分段合成 | 长稿自动按句分段（≤180 字/段）后合并 |

## 安装/运行

需要 **bun**（Bun.file/Bun.write API）。

```powershell
cd E:\projectHome\media-cli\volc-tts\cli
bun install          # 首次（commander + ws）
```

## 配置（环境变量）

| 变量 | 必须 | 用途 |
|---|---|---|
| `VOLC_API_KEY` | ✅ | TTS + ASR（X-Api-Key） |
| `DASHSCOPE_API_KEY` | 可选 | multi 命令自动翻译（有 script-{lang}.md 可跳过） |

```powershell
$env:VOLC_API_KEY = "你的火山语音合成 API Key"
```

> 注意：这是 **openspeech.bytedance.com 语音合成服务**（X-Api-Key），
> 与火山方舟 CodingPlan 订阅无关——CodingPlan 失效不影响本工具。

## 快速开始

```powershell
# 一键生成音频+字幕（输出与输入同名 .mp3/.srt）
bun src/cli.ts script.md

# 指定输出前缀
bun src/cli.ts script.md -o episode-02

# 指定音色/语速/语种
bun src/cli.ts script.md --voice zh_female_qingxin --speed 1.1 --lang en

# 只生成音频（不做 ASR）
bun src/cli.ts script.md --audio-only

# 用已有音频补字幕
bun src/cli.ts script.md --skip-tts

# 多语种（zh/en/ja）+ 时长对齐
bun src/cli.ts multi script.md --langs zh,en,ja --align

# 诊断
bun src/cli.ts doctor
```

## 常用音色（seed-tts）

| 音色 | 说明 |
|---|---|
| `zh_female_vv_uranus_bigtts`（默认） | 女声-新闻播报（财经解说推荐） |
| `zh_female_warm` | 女声-温柔播报 |
| `zh_female_qingxin` | 女声-情感电台 |
| `zh_female_cute` | 女声-可爱少女 |
| `zh_male_deep` | 男声-沉稳 |
| `zh_male_qingshuang` | 男声-清爽 |
| `BV001_streaming` | 通用女声 |
| `BV002_streaming` | 情感女声-故事旁白 |

## 参数

```
volc-tts [options] <script>

选项:
  -o, --output <path>     输出文件前缀
  --voice <type>          音色 (默认: zh_female_vv_uranus_bigtts)
  --speed <ratio>         语速 0.2-3.0 (默认: 1.0)
  --lang <code>           语种 zh/en/ja/es-mx/id/pt-br/kr
  --encoding <e>          音频编码 mp3/wav/pcm/opus (默认: mp3)
  --sample-rate <rate>    采样率 (默认: 24000)
  --skip-subtitle         跳过字幕
  --skip-tts              跳过音频（用已有音频生成字幕）
  --audio-only            只生成音频
  --max-chars <n>         每行字幕最大字符数 (默认: 20)

multi 子命令:
  volc-tts multi script.md --langs zh,en,ja --align
  --voice-zh / --voice-en / --voice-ja   各语种音色
  --align                               对齐各语种时长（ffmpeg atempo + 字幕缩放）
```

## 字幕语言策略（实战经验）

| 语种 | 方案 | 原因 |
|---|---|---|
| 中文 | ASR 字幕（时间戳精确） | seedasr 中文精准 |
| 英文 | ASR 字幕，`maxChars: 55` | 避免单词截断（默认 20 会断词） |
| 日文 | 原文按字数等比分配 | seedasr 日文输出罗马音乱码 |

## 文件结构

```
volc-tts/cli/
├── src/
│   ├── cli.ts          # 入口（主命令 + multi + doctor）
│   ├── tts.ts          # seed-tts-2.0 v3 HTTP 单向流
│   ├── asr.ts          # seedasr 音频转 SRT
│   ├── script.ts       # 口播稿解析（frontmatter/标题/视觉提示跳过）
│   ├── translate.ts    # DashScope qwen-plus 翻译（multi 用）
│   └── ws_protocol.ts  # v3 双向 WebSocket 二进制协议（备用，seed-tts-2.0）
├── package.json
└── README.md
```
