import { Command } from "commander";

import { getSupportedModels } from "../services/generation-service.js";
import type { GenerationKind } from "../types/jimeng.js";
import { writeJson } from "./helpers.js";

export function createModelsCommand(): Command {
  return new Command("models")
    .description("list supported image and video model aliases")
    .option("--type <kind>", "filter by kind: image, video, all", "all")
    .option("--json", "print JSON output", false)
    .addHelpText(
      "after",
      `
Pricing notes:
  - Image pricing depends on Jimeng account rights and upstream web/API behavior.
  - The list below shows supported aliases, not a verified pricing table.
`,
    )
    .action((options: { type: GenerationKind | "all"; json: boolean }) => {
      const models = getSupportedModels(options.type);

      if (options.json) {
        writeJson(models);
        return;
      }

      models.forEach((model) => {
        process.stdout.write(`${model.kind}\t${model.alias}\t${model.key}\n`);
      });
    });
}
