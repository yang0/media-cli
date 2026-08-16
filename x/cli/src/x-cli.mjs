#!/usr/bin/env node
import { handleDraftAdd } from "./commands/draft-add.mjs";
import { handleDraftList } from "./commands/draft-list.mjs";
import { handleDraftApprove, handleDraftDelete, handleDraftClear } from "./commands/draft-manage.mjs";
import { handleDraftSend } from "./commands/draft-send.mjs";
import { handleDraftPushOnline } from "./commands/draft-push-online.mjs";

function printHelp() {
  console.log(`
x-cli — X (Twitter) 互动与草稿箱管理工具

用法:
  node src/x-cli.mjs <command> [options]

草稿箱管理:
  draft add --url <推文链接> --text <回复正文> [--author <作者>] [--topic <主题>]
  draft add --file <markdown文件路径>          # 批量从 Markdown 文件中导入回复草稿
  draft push-online [id|all] [--port 9221]    # 【核心】推送到 X.com 网页官方未发送草稿箱！
  draft list [--status pending|approved]       # 查看本地草稿箱
  draft list --history                         # 查看已发送历史
  draft approve <id>                           # 标记草稿为已批准
  draft delete <id>                            # 删除单条草稿
  draft clear                                  # 清空草稿箱
  draft send <id|all> [--port 9221]            # 直接通过 Chrome CDP 发送发布回复

示例:
  node src/x-cli.mjs draft push-online all     # 一键将所有待发回复推送到 X 网页官方草稿箱
  node src/x-cli.mjs draft list
`);
}

async function main() {
  const args = process.argv.slice(2);
  if (!args.length || args.includes("--help") || args.includes("-h")) {
    printHelp();
    return;
  }

  const [cmd, subcmd, ...rest] = args;

  if (cmd === "draft") {
    switch (subcmd) {
      case "add":
        return await handleDraftAdd(rest);
      case "list":
      case "ls":
        return await handleDraftList(rest);
      case "push-online":
      case "sync":
      case "push":
        return await handleDraftPushOnline(rest);
      case "approve":
        return await handleDraftApprove(rest);
      case "delete":
      case "rm":
        return await handleDraftDelete(rest);
      case "clear":
        return await handleDraftClear();
      case "send":
        return await handleDraftSend(rest);
      default:
        console.error(`❌ 未知 draft 子命令: ${subcmd}`);
        printHelp();
        process.exit(1);
    }
  } else {
    console.error(`❌ 未知命令: ${cmd}`);
    printHelp();
    process.exit(1);
  }
}

main().catch(err => {
  console.error("❌ 执行出错:", err);
  process.exit(1);
});
