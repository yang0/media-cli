import { Command } from "commander";

import type { RuntimeOptions } from "../runtime/config.js";
import { createCommandServices, maybeDownload, writeJson } from "./helpers.js";

export function createTaskCommand(): Command {
  const command = new Command("task").description("task status helpers");

  command
    .command("get")
    .argument("<id>", "task or history id")
    .option("--json", "print JSON output", false)
    .action(async function action(this: Command, id: string, options: { json: boolean }) {
      const services = await createCommandServices(this.optsWithGlobals<RuntimeOptions>());
      const task = await services.taskService.getTask(id);

      if (options.json || services.runtime.config.debug) {
        writeJson(task);
        return;
      }

      process.stdout.write(`Task ${task.historyId}: kind=${task.kind} assets=${task.assets.length} status=${String(task.record.status ?? "unknown")}\n`);
    });

  command
    .command("wait")
    .argument("<id>", "task or history id")
    .option("--type <kind>", "optional kind hint")
    .option("--download", "download outputs after completion", false)
    .option("--json", "print JSON output", false)
    .action(async function action(this: Command, id: string, options: { type?: "image" | "video"; download: boolean; json: boolean }) {
      const services = await createCommandServices(this.optsWithGlobals<RuntimeOptions>());
      const task = await services.taskService.waitForTask(id, options.type);
      const downloads = await maybeDownload(services.runtime, task.historyId, task.kind, options.download, task.assets);

      if (options.json || services.runtime.config.debug) {
        writeJson({ task, downloads });
        return;
      }

      process.stdout.write(`Task completed: ${task.historyId}\n`);
      task.assets.forEach((asset) => {
        process.stdout.write(`- ${asset.url}\n`);
      });
      downloads.forEach((download) => {
        process.stdout.write(`Saved: ${download.filePath}\n`);
      });
    });

  return command;
}
