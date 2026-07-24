import { Command } from "commander";

import type { RuntimeOptions } from "../runtime/config.js";
import { createCommandServices, writeJson } from "./helpers.js";

export function createHistoryCommand(): Command {
  const command = new Command("history").description("history lookup commands");

  command
    .command("list")
    .option("--limit <count>", "number of items to fetch", "10")
    .option("--offset <count>", "pagination offset", "0")
    .option("--json", "print JSON output", false)
    .action(async function action(this: Command, options: { limit: string; offset: string; json: boolean }) {
      const services = await createCommandServices(this.optsWithGlobals<RuntimeOptions>());
      const result = await services.client.getHistoryList(Number(options.limit), Number(options.offset));

      if (options.json || services.runtime.config.debug) {
        writeJson(result);
        return;
      }

      const records = result.records_list ?? [];
      records.forEach((record) => {
        process.stdout.write(`${String(record.history_record_id ?? "unknown")}\tstatus=${String(record.status ?? "unknown")}\tfail=${String(record.fail_code ?? 0)}\n`);
      });
    });

  return command;
}
