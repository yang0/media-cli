# grok — Grok CLI

基于 Chrome CDP 的 Grok 工具集（免 API key，复用本机已登录会话）。

默认调试端口：`9221`。

## 前置

```powershell
chrome.exe --remote-debugging-port=9221 --user-data-dir="D:\chrome-profiles\grok"
```

- **搜索（x.com）**：在该浏览器登录 X，打开过 Grok 即可  
- **Automation 任务结果（grok.com）**：在该浏览器登录 [grok.com](https://grok.com/)

```powershell
cd grok\cli
npm install
```

## 1. 搜索（x.com/i/grok）

```powershell
node src/grok-search.mjs "查询词"
node src/grok-search.mjs --video "主题"
node src/grok-search.mjs --attach 短评.md
```

入口：`src/grok-search.mjs` → `src/lib/grok-client.mjs`。

## 2. 抓取 Automation 最新运行结果（grok.com）

从 Automations 的 runs 列表取**最新一条**，进入详情页，把正文写成 **markdown 文件**。

```powershell
# automationId 来自 URL：https://grok.com/automations?automationId=<id>&tab=runs
node src/grok-task.mjs --id 996fcc28-65a9-4fb5-a494-5562d87fa94a

# 指定输出目录与文件名
node src/grok-task.mjs --id <uuid> -o .\downloads --name latest-run

# 只列 runs，不抓详情（调试用）
node src/grok-task.mjs --id <uuid> --dry-list
```

| 选项 | 说明 |
|---|---|
| `--id` / `--automation-id` | 必填 automation UUID |
| `-o` / `--out` | 输出目录（默认 `./downloads`） |
| `--name` | 输出 basename（无扩展名） |
| `--port` | CDP 端口（默认 9221） |
| `--timeout` | 超时秒数（默认 120） |
| `--keep-open` | 不关详情 tab |
| `--dry-list` | 只打印 runs JSON |

成功时 **stdout 只打印 markdown 绝对路径**；诊断信息在 stderr。

### 实现说明

通过 CDP 复用已登录 Chrome 的 cookie，调用 grok.com 同源 REST：

1. `GET /rest/automations/{id}/runs` → 取最新成功 run（`conversationId` / `taskResultId`）
2. `GET /rest/app-chat/conversations/{conversationId}/responses` → 取 assistant 正文 markdown
3. 写入 `downloads/*.md`（顶部可选 `<!-- source: ... -->` 注释）

DOM 选择器仅作 fallback，不作为主路径。

### 模块结构

```
src/
  grok-task.mjs                 # CLI 入口（参数 / 写盘）
  lib/
    config.mjs
    cdp-session.mjs
    automations/
      urls.mjs                  # runs / detail URL 与 API path
      rest-client.mjs           # 同源 authenticated fetch
      list-runs.mjs             # runs → RunSummary[]
      pick-latest.mjs           # 选最新成功 run
      scrape-result.mjs         # responses → markdown
      fetch-latest.mjs          # 编排
    output/
      write-markdown.mjs        # 落盘 .md
```
