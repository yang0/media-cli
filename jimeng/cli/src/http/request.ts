import { AppError } from "../runtime/errors.js";

export interface RequestJsonOptions {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  searchParams?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  cookieHeader?: string;
  timeoutMs?: number;
  userAgent?: string;
}

export async function requestJson<T>(baseUrl: string, pathName: string, options: RequestJsonOptions = {}): Promise<T> {
  const url = new URL(pathName, baseUrl);

  for (const [key, value] of Object.entries(options.searchParams ?? {})) {
    if (value !== undefined) {
      url.searchParams.set(key, String(value));
    }
  }

  const headers = new Headers({
    Accept: "application/json, text/plain, */*",
    "User-Agent": options.userAgent ?? "jimeng-cli",
    ...options.headers,
  });

  if (options.cookieHeader) {
    headers.set("Cookie", options.cookieHeader);
  }

  let body: string | undefined;
  if (options.body !== undefined) {
    body = JSON.stringify(options.body);
    if (!headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
  }

  const requestInit: RequestInit = {
    method: options.method ?? (body ? "POST" : "GET"),
    headers,
    signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
  };

  if (body !== undefined) {
    requestInit.body = body;
  }

  const response = await fetch(url, requestInit);

  const text = await response.text();
  const payload = text === "" ? null : JSON.parse(text) as unknown;

  if (!response.ok) {
    throw new AppError(`Request failed with status ${response.status}: ${response.statusText}`, 1, payload);
  }

  return payload as T;
}
