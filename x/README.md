# media-cli / x

X (Twitter) CLI for tweet drafting, reply queue management, automated publishing, and single-tweet screenshots via CDP.

## 功能特性

1. **模块化设计**：
   - `src/lib/draft-store.mjs`：草稿持久化存储与历史记录
   - `src/lib/cdp-reply.mjs`：基于 Chrome CDP (9221) 的自动化回复执行器
   - `src/lib/validator.mjs`：推文链接与回复文本校验
   - `src/commands/`：add / list / approve / delete / send 命令实现
2. **支持 Markdown 批量导入**：
   - 直接读取并解析包含 `原推链接` 和 `💡 回复建议` 的 Markdown 文档，一键批量入库草稿箱。
3. **支持状态流转与历史归档**：
   - `pending` (待确认) -> `approved` (已批准) -> `sent` (已发送)。
4. **单条推文/回复截图**：
   - 精确按 status ID 截取单条 `article`，不会把时间线或其他回复截进图片。
   - 支持原推和回复、媒体与引用/转推卡片；默认保留互动统计，可用 `--cut-stats` 隐藏。
   - 复用已登录 Chrome CDP 9221，不安装 Puppeteer；默认宽度 598px。

## 常用命令

```bash
cd E:\projectHome\media-cli\x\cli

# 从 Markdown 文件中批量导入回复草稿
node src/x-cli.mjs draft add --file "G:/x-expert/today/home_timeline_replies.md"

# 查看草稿箱
node src/x-cli.mjs draft list

# 批准单条草稿
node src/x-cli.mjs draft approve <id>

# 通过 CDP 9221 发送单条草稿回复
node src/x-cli.mjs draft send <id>

# 查看已发送历史记录
node src/x-cli.mjs draft list --history

# 截取原推或回复（纯数字 ID 也可）
node src/x-cli.mjs capture "https://x.com/<handle>/status/<tweet-id>"
node src/x-cli.mjs capture <tweet-id> --cut-stats --width 598 --wait 5
```

截图输出到 `downloads/x/captures/<时间>/`：图片位于 `images/x-<tweet-id>.png`，同目录的 `manifest.json` 记录来源 URL、作者、尺寸、SHA-256 和错误信息。`--output-dir` 指定一次运行的输出根目录。

需要先启动带远程调试端口的 Chrome 并登录 X：

```powershell
chrome.exe --remote-debugging-port=9221 --user-data-dir="$PWD\.chrome-profile"
```
