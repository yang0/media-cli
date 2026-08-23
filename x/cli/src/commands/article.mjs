/**
 * Thin alias: X Articles drafts live in video-uploader/x.
 * media-cli/x only forwards so callers do not confuse this with reply drafts.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

export const ARTICLE_CLI = resolve("E:/projectHome/video-uploader/x/cli.js");

export function printArticleHelp() {
  console.log(`
x-cli article — 转调 video-uploader/x 的长文草稿模块

这不是回复草稿箱。真源在 video-uploader/x（lib/article）。

用法:
  node src/x-cli.mjs article preview FILE.md [--json]
  node src/x-cli.mjs article save FILE.md --yes --json
  node src/x-cli.mjs article verify FILE.md --verify-draft URL [--json]
  node src/x-cli.mjs article FILE.md --save-draft --yes --json

真源:
  node ${ARTICLE_CLI} article save FILE.md --yes --json
`);
}

export function buildArticleArgs(rest) {
  const args = rest.filter((value) => value !== undefined);
  if (!args.length || args.includes("--help") || args.includes("-h")) {
    return { help: true, args: [] };
  }
  return { help: false, args: ["article", ...args] };
}

export async function handleArticle(rest) {
  const parsed = buildArticleArgs(rest);
  if (parsed.help) {
    printArticleHelp();
    return;
  }
  if (!existsSync(ARTICLE_CLI)) {
    throw new Error(`找不到 X Articles 执行器: ${ARTICLE_CLI}`);
  }
  const status = await new Promise((resolveStatus, reject) => {
    const child = spawn(process.execPath, [ARTICLE_CLI, ...parsed.args], {
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) reject(new Error(`x-publish article terminated by ${signal}`));
      else resolveStatus(code ?? 1);
    });
  });
  if (status !== 0) process.exit(status);
}
