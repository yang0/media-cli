import { JimengClient } from "../http/jimeng-client.js";
import { createRuntime } from "../runtime/create-runtime.js";
import { type RuntimeOptions } from "../runtime/config.js";
import { downloadAssets } from "../services/download-service.js";
import { GenerationService } from "../services/generation-service.js";
import { TaskService } from "../services/task-service.js";
import type { Runtime } from "../runtime/create-runtime.js";

export interface CommandServices {
  runtime: Runtime;
  client: JimengClient;
  generationService: GenerationService;
  taskService: TaskService;
}

export async function createCommandServices(options: RuntimeOptions): Promise<CommandServices> {
  const runtime = await createRuntime(options);
  const client = new JimengClient(runtime);

  return {
    runtime,
    client,
    generationService: new GenerationService(client),
    taskService: new TaskService(client, runtime.config.pollIntervalMs, runtime.config.pollTimeoutMs),
  };
}

export function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export async function maybeDownload(runtime: Runtime, historyId: string, kind: string, download: boolean, assets: Parameters<typeof downloadAssets>[1]) {
  if (!download) {
    return [];
  }

  return downloadAssets(runtime, assets, `jimeng-${kind}-${historyId}`);
}
