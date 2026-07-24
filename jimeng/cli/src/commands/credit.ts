import { Command } from "commander";

import type { RuntimeOptions } from "../runtime/config.js";
import { createCommandServices, writeJson } from "./helpers.js";

export function createCreditCommand(): Command {
  return new Command("credit")
    .description("show current Jimeng credit balance")
    .option("--json", "print JSON output", false)
    .action(async function action(this: Command, options: { json: boolean }) {
      const services = await createCommandServices(this.optsWithGlobals<RuntimeOptions>());
      const result = await services.client.getCreditBalance();

      if (options.json || services.runtime.config.debug) {
        writeJson(result);
        return;
      }

      process.stdout.write(`Total: ${result.totalCredit}\n`);
      process.stdout.write(`Gift: ${result.giftCredit}\n`);
      process.stdout.write(`Purchase: ${result.purchaseCredit}\n`);
      process.stdout.write(`VIP: ${result.vipCredit}\n`);
    });
}
