import { Command } from "commander";

import type { RuntimeOptions } from "../runtime/config.js";
import { createCommandServices, maybeDownload, writeJson } from "./helpers.js";

export function createVideoCommand(): Command {
  return new Command("video")
    .description("video generation commands")
    .addCommand(
      new Command("generate")
        .argument("<prompt>", "text prompt")
        .option("--model <model>", "video model alias or raw model key", "jimeng-video-3.5-pro")
        .option("--ratio <ratio>", "video aspect ratio", "1:1")
        .option("--duration <seconds>", "video duration in seconds", "5")
        .option("--download", "wait for completion and download outputs", false)
        .option("--json", "print JSON output", false)
        .addHelpText(
          "after",
          `
Examples:
  $ jimeng video generate "赛博朋克城市上空掠过一艘发光飞船" --cookie-file "G:\\cookies\\jimeng.txt"
  $ jimeng video generate "海边日落镜头缓慢推进" --ratio 16:9 --duration 10 --download --cookie-file "G:\\cookies\\jimeng.txt"
  $ jimeng video generate "一条龙穿过云层" --model jimeng-video-3.0-fast --json --cookie-file "G:\\cookies\\jimeng.txt"
`,
        )
        .action(async function action(this: Command, prompt: string, options: {
          model: string;
          ratio: "1:1" | "16:9" | "9:16" | "4:3" | "3:4";
          duration: string;
          download: boolean;
          json: boolean;
        }) {
          const services = await createCommandServices(this.optsWithGlobals<RuntimeOptions>());
          const rawDuration = Number(options.duration);
          const duration = rawDuration === 10 || rawDuration === 12 ? rawDuration : 5;
          const submission = await services.generationService.submitVideo({
            prompt,
            model: options.model,
            ratio: options.ratio,
            duration,
          });

          if (!options.download) {
            if (options.json) {
              writeJson(submission);
              return;
            }

            process.stdout.write(`Video task submitted: ${submission.historyId}\n`);
            return;
          }

          const task = await services.taskService.waitForTask(submission.historyId, "video");
          const downloads = await maybeDownload(services.runtime, task.historyId, task.kind, options.download, task.assets);

          if (options.json || services.runtime.config.debug) {
            writeJson({
              ...submission,
              task,
              downloads,
            });
            return;
          }

          process.stdout.write(`Video task completed: ${task.historyId}\n`);
          task.assets.forEach((asset) => {
            process.stdout.write(`- ${asset.url}\n`);
          });
          downloads.forEach((download) => {
            process.stdout.write(`Saved: ${download.filePath}\n`);
          });
        }),
    );
}
