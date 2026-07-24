#!/usr/bin/env node

import { Command } from "commander";
import { pathToFileURL } from "node:url";

import { createAuthCheckCommand } from "./commands/auth-check.js";
import { createCreditCommand } from "./commands/credit.js";
import { createDownloadCommand } from "./commands/download.js";
import { createHistoryCommand } from "./commands/history.js";
import { createImageCommand } from "./commands/image.js";
import { createModelsCommand } from "./commands/models.js";
import { createTaskCommand } from "./commands/task.js";
import { createVideoCommand } from "./commands/video.js";
import { AppError, formatError, getExitCode } from "./runtime/errors.js";

function addGlobalOptions(program: Command): void {
  program
    .option("--cookie-file <path>", "cookie file path in Netscape format")
    .option("--base-url <url>", "Jimeng base URL", "https://jimeng.jianying.com")
    .option("--output-dir <path>", "default download directory")
    .option("--poll-interval-ms <ms>", "poll interval in milliseconds")
    .option("--poll-timeout-ms <ms>", "poll timeout in milliseconds")
    .option("--debug", "print raw API payloads for debugging", false);
}

export function buildProgram(): Command {
  const program = new Command();

  program
    .name("jimeng")
    .description("Jimeng CLI for authenticated generation workflows")
    .version("0.1.0");

  program.addHelpText(
    "after",
    `
Pricing notes:
  - Image pricing depends on Jimeng account rights and upstream web/API behavior.
  - This CLI no longer depends on a live Chrome session at runtime.
  - Other model pricing is not fully verified.

Examples:
  $ jimeng auth check --cookie-file "G:\\cookies\\jimeng.txt"
  $ jimeng credit --cookie-file "G:\\cookies\\jimeng.txt"
  $ jimeng models --type image
  $ jimeng image generate "一只霓虹狐狸，赛博朋克风格" --download --cookie-file "G:\\cookies\\jimeng.txt"
  $ jimeng video generate "赛博朋克城市上空掠过一艘发光飞船" --download --cookie-file "G:\\cookies\\jimeng.txt"
  $ jimeng avatar generate "大家好，我是数字人主播" --download --cookie-file "G:\\cookies\\jimeng.txt"
`,
  );

  addGlobalOptions(program);
  program.addCommand(createAuthCheckCommand());
  program.addCommand(createCreditCommand());
  program.addCommand(createImageCommand());
  program.addCommand(createVideoCommand());
  program.addCommand(createModelsCommand());
  program.addCommand(createTaskCommand());
  program.addCommand(createHistoryCommand());
  program.addCommand(createDownloadCommand());

  return program;
}

export async function main(argv: string[] = process.argv): Promise<void> {
  const program = buildProgram();

  try {
    await program.parseAsync(argv);
  } catch (error) {
    const normalized = error instanceof AppError ? error : new AppError(formatError(error), 1, error);
    process.stderr.write(`${normalized.message}\n`);
    process.exitCode = getExitCode(normalized);
  }
}

const currentEntryPoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;

if (currentEntryPoint === import.meta.url) {
  void main();
}
