# media-cli / x

X (Twitter) CLI for tweet drafting, reply queue management, and automated publishing via CDP.

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
```
