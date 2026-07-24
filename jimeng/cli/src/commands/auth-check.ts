import { Command } from "commander";

import { JimengClient } from "../http/jimeng-client.js";
import { createRuntime } from "../runtime/create-runtime.js";
import { type RuntimeOptions } from "../runtime/config.js";
import { AppError } from "../runtime/errors.js";

export function createAuthCheckCommand(): Command {
  return new Command("auth")
    .description("authentication helpers")
    .addCommand(
      new Command("check")
        .description("validate cookie file against Jimeng account info")
        .action(async function action(this: Command) {
          const runtime = await createRuntime(this.optsWithGlobals<RuntimeOptions>());
          const response = await new JimengClient(runtime).getAccountInfo();

          if (response.message !== "success" || !response.data?.user_id) {
            throw new AppError(response.data?.description ?? "Authentication failed", 1, response);
          }

          if (runtime.config.debug) {
            process.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
            return;
          }

          process.stdout.write(`Authenticated as user ${response.data.user_id}.\n`);
        }),
    );
}
