import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { ARTICLE_CLI, buildArticleArgs } from "../src/commands/article.mjs";

const cli = resolve(dirname(fileURLToPath(import.meta.url)), "../src/x-cli.mjs");

test("article wrapper points at video-uploader x-publish", () => {
  assert.match(ARTICLE_CLI.replace(/\\/g, "/"), /video-uploader\/x\/cli\.js$/);
});

test("article --help is forwarded as help, not as a markdown path", () => {
  assert.deepEqual(buildArticleArgs(["--help"]), { help: true, args: [] });
  assert.deepEqual(buildArticleArgs(["save", "FILE.md", "--yes"]), {
    help: false,
    args: ["article", "save", "FILE.md", "--yes"],
  });
});

test("x-cli article --help mentions save and video-uploader", () => {
  const result = spawnSync(process.execPath, [cli, "article", "--help"], { encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /article save/);
  assert.match(result.stdout, /video-uploader/);
  assert.doesNotMatch(result.stdout, /未知命令/);
});
