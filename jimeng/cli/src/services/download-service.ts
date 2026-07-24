import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { AppError } from "../runtime/errors.js";
import type { Runtime } from "../runtime/create-runtime.js";
import type { ResolvedAsset } from "../types/jimeng.js";

const EXTENSION_BY_KIND = {
  image: ".webp",
  video: ".mp4",
} as const;

function sanitizeFileName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/gu, "-").replace(/-+/gu, "-").replace(/^-|-$/gu, "");
}

function inferExtension(asset: ResolvedAsset): string {
  try {
    const pathname = new URL(asset.url).pathname;
    const extension = path.extname(pathname);
    if (extension) {
      return extension;
    }
  } catch {
    // ignore malformed URL and use default
  }

  return EXTENSION_BY_KIND[asset.kind];
}

async function ensureUniqueFilePath(baseDir: string, baseName: string, extension: string): Promise<string> {
  let candidate = path.join(baseDir, `${baseName}${extension}`);
  let counter = 2;

  while (await exists(candidate)) {
    candidate = path.join(baseDir, `${baseName}-${counter}${extension}`);
    counter += 1;
  }

  return candidate;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await import("node:fs/promises").then(({ access }) => access(filePath));
    return true;
  } catch {
    return false;
  }
}

export interface DownloadedAsset {
  sourceUrl: string;
  filePath: string;
}

export async function downloadAssets(runtime: Runtime, assets: ResolvedAsset[], prefix: string): Promise<DownloadedAsset[]> {
  await mkdir(runtime.config.outputDir, { recursive: true });

  const results: DownloadedAsset[] = [];
  const cookieHeader = await runtime.getCookieHeader();

  for (const [index, asset] of assets.entries()) {
    const extension = inferExtension(asset);
    const baseName = sanitizeFileName(asset.fileNameHint ?? `${prefix}-${index + 1}`) || `${prefix}-${index + 1}`;
    const filePath = await ensureUniqueFilePath(runtime.config.outputDir, baseName, extension);
    const response = await fetch(asset.url, {
      headers: {
        Accept: "*/*",
        "User-Agent": runtime.config.userAgent,
        Cookie: cookieHeader,
      },
      signal: AbortSignal.timeout(120_000),
    });

    if (!response.ok) {
      throw new AppError(`Failed to download asset: ${response.status} ${response.statusText}`, 1, asset);
    }

    const arrayBuffer = await response.arrayBuffer();
    await writeFile(filePath, Buffer.from(arrayBuffer));
    results.push({
      sourceUrl: asset.url,
      filePath,
    });
  }

  return results;
}
