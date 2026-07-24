import { AppError } from "../runtime/errors.js";
import type { GenerationKind, JimengHistoryItem, JimengHistoryRecord, ResolvedAsset, TaskResolution } from "../types/jimeng.js";
import type { JimengClient } from "../http/jimeng-client.js";

function normalizeUrl(url: string): string {
  return url.replace(/\\u0026/gu, "&");
}

function extractImageUrls(items: JimengHistoryItem[]): ResolvedAsset[] {
  return items
    .flatMap((item, index) => {
      const url = item.image?.large_images?.[0]?.image_url ?? item.common_attr?.cover_url;
      if (!url) {
        return [];
      }

      return [{ kind: "image" as const, url: normalizeUrl(url), fileNameHint: `image-${index + 1}` }];
    });
}

function extractPreviewVideoUrl(item: JimengHistoryItem): string | null {
  const url = item.common_attr?.transcoded_video?.origin?.video_url
    ?? item.video?.transcoded_video?.origin?.video_url
    ?? item.video?.play_url
    ?? item.video?.download_url
    ?? item.video?.url;

  return url ? normalizeUrl(url) : null;
}

function extractItemId(item: JimengHistoryItem): string | null {
  const itemId = item.item_id ?? item.id ?? item.local_item_id ?? item.common_attr?.id;
  return itemId === undefined || itemId === null ? null : String(itemId);
}

function decodeBase64Url(value: string): string | null {
  try {
    const decoded = Buffer.from(value, "base64").toString("utf8");
    return decoded.startsWith("http") ? decoded : null;
  } catch {
    return null;
  }
}

function detectKind(record: JimengHistoryRecord): GenerationKind {
  const firstItem = record.item_list?.[0];
  if (firstItem?.image?.large_images?.length) {
    return "image";
  }

  return "video";
}

function resolveHistoryId(record: JimengHistoryRecord, lookupId: string): string {
  const historyId = record.history_record_id ?? record.task?.history_id;
  if (historyId !== undefined && historyId !== null) {
    return String(historyId);
  }

  return lookupId;
}

function pickRecord(response: Record<string, JimengHistoryRecord>, lookupId: string): JimengHistoryRecord | undefined {
  const direct = response[lookupId];
  if (direct) {
    return direct;
  }

  const values = Object.values(response);
  if (values.length === 1) {
    return values[0];
  }

  return values.find((record) => String(record.history_record_id ?? "") === lookupId || String(record.submit_id ?? "") === lookupId);
}

export class TaskService {
  public constructor(
    private readonly client: Pick<JimengClient, "getHistoryByIds" | "getLocalItemList">,
    private readonly pollIntervalMs: number,
    private readonly pollTimeoutMs: number,
  ) {}

  public async getTask(historyId: string): Promise<TaskResolution> {
    const record = await this.fetchRecord(historyId, "auto");
    const kind = detectKind(record);
    const assets = await this.resolveAssets(kind, record);

    return {
      historyId: resolveHistoryId(record, historyId),
      kind,
      record,
      assets,
    };
  }

  public async waitForTask(historyId: string, hint?: GenerationKind): Promise<TaskResolution> {
    const startedAt = Date.now();

    while (Date.now() - startedAt < this.pollTimeoutMs) {
      const record = await this.fetchRecord(historyId, hint ?? "auto");
      const kind = hint ?? detectKind(record);
      const assets = await this.resolveAssets(kind, record);

      if (assets.length > 0) {
        return {
          historyId: resolveHistoryId(record, historyId),
          kind,
          record,
          assets,
        };
      }

      if (record.fail_code !== undefined && String(record.fail_code) !== "0") {
        throw new AppError(`Task failed with fail_code=${String(record.fail_code)}`, 1, record);
      }

      if (record.status === 30) {
        throw new AppError("Task failed with status=30", 1, record);
      }

      await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
    }

    throw new AppError(`Timed out waiting for task ${historyId}`, 1);
  }

  private async fetchRecord(historyId: string, hint: GenerationKind | "auto"): Promise<JimengHistoryRecord> {
    const response = await this.client.getHistoryByIds([historyId], hint === "auto" ? "auto" : hint);
    const record = pickRecord(response, historyId);

    if (!record) {
      throw new AppError(`Task ${historyId} was not found`, 1, response);
    }

    return record;
  }

  private async resolveAssets(kind: GenerationKind, record: JimengHistoryRecord): Promise<ResolvedAsset[]> {
    const items = record.item_list ?? [];

    if (kind === "image") {
      return extractImageUrls(items);
    }

    const firstItem = items[0];
    if (!firstItem) {
      return [];
    }

    const itemId = extractItemId(firstItem);
    if (itemId) {
      const localItem = await this.client.getLocalItemList([itemId]);
      const videoItems = localItem.item_list ?? localItem.local_item_list ?? [];
      const upgraded = videoItems[0]?.video?.video_model;

      if (typeof upgraded === "string") {
        try {
          const parsed = JSON.parse(upgraded) as { video_list?: Record<string, { main_url?: string }> };
          const candidates = ["video_4", "video_3", "video_2", "video_1"];
          for (const candidate of candidates) {
            const encoded = parsed.video_list?.[candidate]?.main_url;
            if (encoded) {
              const decoded = decodeBase64Url(encoded);
              if (decoded) {
                return [{ kind: "video", url: decoded, fileNameHint: "video-1" }];
              }
            }
          }
        } catch {
          // fall through to preview URL
        }
      }
    }

    const previewUrl = extractPreviewVideoUrl(firstItem);
    return previewUrl ? [{ kind: "video", url: previewUrl, fileNameHint: "video-1" }] : [];
  }
}
