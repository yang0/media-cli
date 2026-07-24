import path from "node:path";

import { AppError } from "./errors.js";

export interface RuntimeOptions {
  cookieFile?: string;
  baseUrl?: string;
  outputDir?: string;
  pollIntervalMs?: string | number;
  pollTimeoutMs?: string | number;
  debug?: boolean;
}

export interface RuntimeConfig {
  cookieFile?: string;
  baseUrl: string;
  outputDir: string;
  pollIntervalMs: number;
  pollTimeoutMs: number;
  debug: boolean;
  userAgent: string;
}

const DEFAULT_BASE_URL = "https://jimeng.jianying.com";
const DEFAULT_OUTPUT_DIR = "downloads";
const DEFAULT_POLL_INTERVAL_MS = 4_000;
const DEFAULT_POLL_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";

function parseNumber(value: string | number | undefined, fallback: number, fieldName: string): number {
  if (value === undefined) {
    return fallback;
  }

  const parsed = typeof value === "number" ? value : Number(value);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new AppError(`${fieldName} must be a positive number`, 2);
  }

  return parsed;
}

export function resolveRuntimeConfig(options: RuntimeOptions, env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): RuntimeConfig {
  const cookieFile = options.cookieFile ?? env.JIMENG_COOKIE_FILE;
  const baseUrl = options.baseUrl ?? env.JIMENG_BASE_URL ?? DEFAULT_BASE_URL;
  const outputDir = options.outputDir ?? env.JIMENG_OUTPUT_DIR ?? DEFAULT_OUTPUT_DIR;
  const pollIntervalMs = parseNumber(options.pollIntervalMs ?? env.JIMENG_POLL_INTERVAL_MS, DEFAULT_POLL_INTERVAL_MS, "pollIntervalMs");
  const pollTimeoutMs = parseNumber(options.pollTimeoutMs ?? env.JIMENG_POLL_TIMEOUT_MS, DEFAULT_POLL_TIMEOUT_MS, "pollTimeoutMs");
  const debug = Boolean(options.debug ?? env.JIMENG_DEBUG === "1");

  const config: RuntimeConfig = {
    baseUrl,
    outputDir: path.resolve(cwd, outputDir),
    pollIntervalMs,
    pollTimeoutMs,
    debug,
    userAgent: env.JIMENG_USER_AGENT ?? DEFAULT_USER_AGENT,
  };

  if (cookieFile) {
    config.cookieFile = path.resolve(cwd, cookieFile);
  }

  return config;
}

export function requireCookieFile(config: RuntimeConfig): string {
  if (!config.cookieFile) {
    throw new AppError("Cookie file is required. Pass --cookie-file or set JIMENG_COOKIE_FILE.", 2);
  }

  return config.cookieFile;
}
