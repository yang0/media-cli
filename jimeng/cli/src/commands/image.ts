import { Command } from "commander";

import { createCommandServices, maybeDownload, writeJson } from "./helpers.js";
import type { RuntimeOptions } from "../runtime/config.js";

export function createImageCommand(): Command {
  return new Command("image")
    .description("image generation commands")
    .addCommand(
      new Command("generate")
        .argument("<prompt>", "text prompt")
        .option("--model <model>", "image model alias or raw model key", "jimeng-5.0")
        .option("--ratio <ratio>", "image ratio", "1:1")
        .option("--resolution <resolution>", "image resolution", "2k")
        .option("--negative-prompt <text>", "negative prompt")
        .option("--seed <seed>", "random seed")
        .option("--strength <value>", "sample strength", "0.5")
        .option("--download", "wait for completion and download outputs", false)
        .option("--json", "print JSON output", false)
        .addHelpText(
          "after",
          `
Pricing notes:
  - Image pricing depends on Jimeng account rights and upstream web/API behavior.
  - This command no longer depends on a live Chrome session at runtime.
  - Other image model pricing is not fully verified.

Examples:
  $ jimeng image generate "一只霓虹狐狸，赛博朋克风格" --cookie-file "G:\\cookies\\jimeng.txt"
  $ jimeng image generate "一只霓虹狐狸，赛博朋克风格" --ratio 16:9 --resolution 4k --download --cookie-file "G:\\cookies\\jimeng.txt"
  $ jimeng image generate "一只猫坐在窗边" --negative-prompt "模糊, 低质量" --seed 123456 --json --cookie-file "G:\\cookies\\jimeng.txt"
`,
        )
        .action(async function action(this: Command, prompt: string, options: {
          model: string;
          ratio: "1:1" | "4:3" | "3:4" | "16:9" | "9:16";
          resolution: "1k" | "2k" | "4k";
          negativePrompt?: string;
          seed?: string;
          strength: string;
          download: boolean;
          json: boolean;
        }) {
          const services = await createCommandServices(this.optsWithGlobals<RuntimeOptions>());
          const request = {
            prompt,
            model: options.model,
            ratio: options.ratio,
            resolution: options.resolution,
            sampleStrength: Number(options.strength),
            ...(options.negativePrompt ? { negativePrompt: options.negativePrompt } : {}),
            ...(options.seed ? { seed: Number(options.seed) } : {}),
          };
          const submission = await services.generationService.submitImage(request);

          if (!options.download) {
            if (options.json) {
              writeJson(submission);
              return;
            }

            process.stdout.write(`Image task submitted: ${submission.historyId}\n`);
            return;
          }

          const task = await services.taskService.waitForTask(submission.submitId, "image");
          const downloads = await maybeDownload(services.runtime, task.historyId, task.kind, options.download, task.assets);

          if (options.json || services.runtime.config.debug) {
            writeJson({
              ...submission,
              task,
              downloads,
            });
            return;
          }

          process.stdout.write(`Image task completed: ${task.historyId}\n`);
          task.assets.forEach((asset) => {
            process.stdout.write(`- ${asset.url}\n`);
          });
          downloads.forEach((download) => {
            process.stdout.write(`Saved: ${download.filePath}\n`);
          });
        }),
    );
}
