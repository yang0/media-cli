import { Command } from "commander";

import type { RuntimeOptions } from "../runtime/config.js";
import { createCommandServices, maybeDownload, writeJson } from "./helpers.js";

export function createDownloadCommand(): Command {
  return new Command("download")
    .description("download generation outputs")
    .argument("<id>", "task, history, or item id")
    .option("--type <kind>", "optional kind hint")
    .option("--json", "print JSON output", false)
    .action(async function action(this: Command, id: string, options: { type?: "image" | "video"; json: boolean }) {
      const services = await createCommandServices(this.optsWithGlobals<RuntimeOptions>());
      const task = await services.taskService.waitForTask(id, options.type);
      const downloads = await maybeDownload(services.runtime, task.historyId, task.kind, true, task.assets);

      if (options.json || services.runtime.config.debug) {
        writeJson({ task, downloads });
        return;
      }

      downloads.forEach((download) => {
        process.stdout.write(`${download.filePath}\n`);
      });
    });
}
