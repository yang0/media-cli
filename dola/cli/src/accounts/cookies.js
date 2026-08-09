import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { DolaCliError } from '../errors.js';

export function normalizeCookieDomain(domain, includeSubdomains = false) {
  let value = String(domain || "").trim();
  if (!value) return value;
  // CDP: leading dot means host-only is false (include subdomains).
  if (includeSubdomains && !value.startsWith(".")) value = `.${value.replace(/^\./, "")}`;
  return value;
}

export async function loadNetscapeCookies(file) {
  const text = await readFile(file, "utf8");
  if (file.toLowerCase().endsWith(".json")) {
    const value = JSON.parse(text);
    const entries = Array.isArray(value) ? value : value.cookies;
    if (!Array.isArray(entries)) throw new Error(`Cookie JSON must be an array or contain cookies: ${file}`);
    return entries.map(cookie => {
      const domain = normalizeCookieDomain(cookie.domain || cookie.host || "", Boolean(cookie.includeSubdomains ?? cookie.hostOnly === false));
      const expires = Number(cookie.expires || cookie.expirationDate || 0);
      return {
        name: String(cookie.name || ""),
        value: String(cookie.value ?? ""),
        domain,
        path: cookie.path || "/",
        secure: Boolean(cookie.secure),
        httpOnly: Boolean(cookie.httpOnly),
        sameSite: cookie.sameSite || "Lax",
        ...(expires > 0 ? { expires } : {}),
      };
    }).filter(cookie => cookie.name && cookie.domain);
  }

  const now = Math.floor(Date.now() / 1000);
  const cookies = [];
  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line) continue;
    let httpOnly = false;
    if (line.startsWith("#HttpOnly_")) {
      httpOnly = true;
      line = line.slice("#HttpOnly_".length);
    } else if (line.startsWith("#")) {
      continue;
    }
    // Prefer Netscape tab format; fall back to multi-space for broken exports.
    let parts = line.split("\t");
    if (parts.length < 7) parts = line.split(/\s+/);
    if (parts.length < 7) continue;
    const [domainRaw, includeSubdomains, cookiePath, secure, expiresRaw, name, ...valueParts] = parts;
    const value = valueParts.join("\t");
    const expires = Number(expiresRaw);
    // Drop clearly expired non-session cookies.
    if (Number.isFinite(expires) && expires > 0 && expires < now) continue;
    if (!name) continue;
    const includeSubs = String(includeSubdomains).toUpperCase() === "TRUE";
    cookies.push({
      domain: normalizeCookieDomain(domainRaw, includeSubs),
      path: cookiePath || "/",
      secure: String(secure).toUpperCase() === "TRUE",
      ...(Number.isFinite(expires) && expires > 0 ? { expires } : {}),
      name,
      value,
      httpOnly,
      sameSite: "Lax",
    });
  }
  return cookies;
}

export async function inspectCookieFile(file) {
  const cookies = await loadNetscapeCookies(file);
  const names = new Set(cookies.map(cookie => cookie.name));
  const hasSession = ["sessionid", "sessionid_ss", "sid_tt", "sid_guard", "uid_tt"].some(name => names.has(name));
  const domains = [...new Set(cookies.map(cookie => cookie.domain).filter(Boolean))];
  const dolaRelated = domains.some(domain => /dola\.com/i.test(domain));
  return {
    ok: Boolean(cookies.length && hasSession && dolaRelated),
    cookieCount: cookies.length,
    hasSession,
    dolaRelated,
    domains,
    names: [...names].sort(),
    file: path.resolve(file),
  };
}

export async function applyAccountCookies(client, account) {
  if (!account?.cookieFile) return { cookieCount: 0 };
  const cookies = await loadNetscapeCookies(account.cookieFile);
  if (!cookies.length) {
    throw new DolaCliError(
      "ACCOUNT_COOKIE_INVALID",
      `No usable cookies found in account file: ${account.cookieFile}`,
      { accountId: account.id, cookieFile: account.cookieFile }
    );
  }
  const health = await inspectCookieFile(account.cookieFile);
  if (!health.hasSession) {
    console.log(`[dola-cli] warning: account ${account.id} cookies lack session tokens (sessionid/sid_tt/...)`);
  }
  // Clear then set; also seed both host-only and subdomain forms when possible.
  await client.send("Network.clearBrowserCookies");
  const expanded = [];
  for (const cookie of cookies) {
    expanded.push(cookie);
    if (cookie.domain && !cookie.domain.startsWith(".") && /dola\.com$/i.test(cookie.domain)) {
      expanded.push({ ...cookie, domain: `.${cookie.domain.replace(/^\./, "")}` });
    }
  }
  // Network.setCookies rejects bad sameSite values on some Chrome builds.
  const payload = expanded.map(cookie => ({
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path || "/",
    secure: Boolean(cookie.secure),
    httpOnly: Boolean(cookie.httpOnly),
    ...(cookie.expires ? { expires: cookie.expires } : {}),
    sameSite: ["Strict", "Lax", "None"].includes(cookie.sameSite) ? cookie.sameSite : "Lax",
  }));
  await client.send("Network.setCookies", { cookies: payload });
  console.log(`[dola-cli] loaded ${cookies.length} cookie(s) for account ${account.id}${health.hasSession ? "" : " (weak session)"}`);
  return { cookieCount: cookies.length, health };
}
