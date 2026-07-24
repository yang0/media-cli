import { readFile } from "node:fs/promises";

import { AppError } from "../runtime/errors.js";

export interface NetscapeCookie {
  domain: string;
  includeSubdomains: boolean;
  path: string;
  secure: boolean;
  expiresAt: number | null;
  name: string;
  value: string;
}

function parseBooleanFlag(raw: string): boolean {
  return raw.toUpperCase() === "TRUE";
}

export function parseNetscapeCookieFile(contents: string): NetscapeCookie[] {
  const cookies: NetscapeCookie[] = [];
  const lines = contents.split(/\r?\n/u);

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed === "" || trimmed.startsWith("#")) {
      continue;
    }

    const fields = line.split("\t");
    if (fields.length !== 7) {
      throw new AppError(`Invalid Netscape cookie line: ${line}`, 2);
    }

    const domain = fields[0];
    const includeSubdomains = fields[1];
    const cookiePath = fields[2];
    const secure = fields[3];
    const expiresRaw = fields[4];
    const name = fields[5];
    const value = fields[6];

    if (
      domain === undefined ||
      includeSubdomains === undefined ||
      cookiePath === undefined ||
      secure === undefined ||
      expiresRaw === undefined ||
      name === undefined ||
      value === undefined
    ) {
      throw new AppError(`Invalid Netscape cookie line: ${line}`, 2);
    }

    cookies.push({
      domain,
      includeSubdomains: parseBooleanFlag(includeSubdomains),
      path: cookiePath,
      secure: parseBooleanFlag(secure),
      expiresAt: expiresRaw === "0" ? null : Number(expiresRaw),
      name,
      value,
    });
  }

  return cookies;
}

export function cookieMatchesUrl(cookie: NetscapeCookie, targetUrl: URL): boolean {
  const targetHost = targetUrl.hostname;
  const normalizedDomain = cookie.domain.replace(/^\./u, "");
  const hostMatches = cookie.includeSubdomains
    ? targetHost === normalizedDomain || targetHost.endsWith(`.${normalizedDomain}`)
    : targetHost === normalizedDomain;

  if (!hostMatches) {
    return false;
  }

  if (cookie.secure && targetUrl.protocol !== "https:") {
    return false;
  }

  return targetUrl.pathname.startsWith(cookie.path);
}

export function buildCookieHeader(cookies: NetscapeCookie[], targetUrl: string | URL): string {
  const url = targetUrl instanceof URL ? targetUrl : new URL(targetUrl);

  return cookies
    .filter((cookie) => cookieMatchesUrl(cookie, url))
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ");
}

export async function loadCookieHeaderFromFile(filePath: string, targetUrl: string | URL): Promise<string> {
  const contents = await readFile(filePath, "utf8");
  const header = buildCookieHeader(parseNetscapeCookieFile(contents), targetUrl);

  if (!header) {
    throw new AppError(`No matching cookies found for ${String(targetUrl)}`, 2);
  }

  return header;
}
