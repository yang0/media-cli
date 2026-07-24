# ChatGPT（chatgpt.com 生图）

通过已登录的 **chatgpt.com** 网页，用 Chrome CDP 提交提示词并下载图片。

> Sora 相关工具已移除（站点/能力不再使用）。  
> 生图逻辑来自 **`G:\初中\generate_wenyuan_grade8_images.mjs`** 的实战脚本。

| 项目 | 说明 |
|------|------|
| 平台 | [chatgpt.com](https://chatgpt.com/) |
| 能力 | 文生图（网页 imagegen）、单条 / 批量、断点跳过已有文件 |
| 接入方式 | **Chrome CDP**（默认端口 `9221`） |
| 运行时 | Node ≥ 20，零 npm 依赖 |

## 能力矩阵

| 能力 | 支持 |
|------|:----:|
| 文生图并本地下载 | ✅ |
| 提示词文件 | ✅ |
| 批量目录 / 行列表 | ✅ |
| 已有图跳过 | ✅（batch） |
| 文字回复换标签重试 | ✅ |
| 视频（Sora） | ❌ 已删除 |

## 目录结构

```text
chatgpt/
├── README.md
└── cli/                    # chatgpt-img
    ├── package.json
    ├── README.md
    └── src/
        ├── cli.mjs
        ├── cdp.mjs
        └── chatgpt-image.mjs
```

## 快速开始

```powershell
# 1) Chrome 调试端口 + 登录 chatgpt.com
& "C:\Program Files\Google\Chrome\Application\chrome.exe" `
  --remote-debugging-port=9221 `
  --user-data-dir="D:\chrome-profiles\chatgpt" `
  "https://chatgpt.com/"

# 2) 生图
cd E:\projectHome\media-cli\chatgpt\cli
node src\cli.mjs dry-run
node src\cli.mjs generate --prompt "一张适合初中历史的卡通示意图" -o downloads
```

更多参数见 [`cli/README.md`](./cli/README.md)。

## 与 G:\初中 的关系

| 用途 | 用哪里 |
|------|--------|
| 通用 chatgpt.com 生图 | **本目录 `cli/`** |
| 文渊八年级卡片扫库 / 回写 cards.md / 状态文件 | **`G:\初中\generate_wenyuan_grade8_images.mjs`**（业务脚本，仍放在初中工程内） |

初中脚本可继续直接调用；若日后要共用核心模块，可改为：

```js
import { connectChatGPT, generateOnce } from
  'E:/projectHome/media-cli/chatgpt/cli/src/chatgpt-image.mjs';
```

## 注意事项

- 账号需具备 ChatGPT 生图权限；遵守 OpenAI 使用条款。  
- 前端改版可能导致选择器失效，集中改 `cli/src/chatgpt-image.mjs`。  
- 不提交 profile / cookie / 下载目录。

## 来源

| 组件 | 说明 |
|------|------|
| 生图 CDP 逻辑 | `G:\初中\generate_wenyuan_grade8_images.mjs` |
| 已删除 | `E:\projectHome\auto_sora`、`media-cli/chatgpt/sora`（Sora 扩展总控） |
