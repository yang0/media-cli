import path from 'node:path';
import { readdir } from 'node:fs/promises';
import { inspectCookieFile } from './cookies.js';
import { DEFAULT_CDP } from '../config.js';
import { DolaCliError } from '../errors.js';
import { normalizeSession } from '../session.js';
import { accountDayKey, readJsonFile } from '../utils.js';

export async function loadAccountPool(file) {
  const absoluteFile = path.resolve(file);
  try {
    const directoryEntries = await readdir(absoluteFile, { withFileTypes: true });
    const cookieFiles = directoryEntries
      .filter(entry => entry.isFile() && /\.(txt|cookies?|json)$/i.test(entry.name))
      .map(entry => path.join(absoluteFile, entry.name))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    if (!cookieFiles.length) throw new Error(`No cookie files found in account pool directory: ${file}`);
    const accounts = [];
    for (const cookieFile of cookieFiles) {
      const id = path.basename(cookieFile, path.extname(cookieFile)) || `account-${accounts.length + 1}`;
      const health = await inspectCookieFile(cookieFile).catch(error => ({
        ok: false,
        cookieCount: 0,
        hasSession: false,
        error: error.message,
      }));
      accounts.push({
        id,
        cdp: DEFAULT_CDP,
        session: "",
        cookieFile,
        health,
      });
    }
    return accounts;
  } catch (error) {
    if (error?.code !== "ENOTDIR") throw error;
  }
  const value = await readJsonFile(file);
  const entries = Array.isArray(value) ? value : value?.accounts;
  if (!Array.isArray(entries) || !entries.length) {
    throw new Error(`Account pool must contain a non-empty JSON array or {"accounts": [...]}: ${file}`);
  }
  const accounts = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry || typeof entry !== "object") throw new Error(`Account pool entry ${index + 1} must be an object.`);
    const id = String(entry.id || entry.name || `account-${index + 1}`).trim();
    if (!id) throw new Error(`Account pool entry ${index + 1} has an empty id.`);
    const cdp = String(entry.cdp || DEFAULT_CDP).trim();
    const session = entry.session ? normalizeSession(entry.session) : "";
    const cookieFile = entry.cookieFile || entry.cookies || entry.cookie
      ? path.resolve(String(entry.cookieFile || entry.cookies || entry.cookie))
      : "";
    if (!cdp) throw new Error(`Account pool entry ${id} has an empty cdp endpoint.`);
    const health = cookieFile
      ? await inspectCookieFile(cookieFile).catch(error => ({ ok: false, cookieCount: 0, hasSession: false, error: error.message }))
      : { ok: true, cookieCount: 0, hasSession: true, note: "no-cookie-file" };
    accounts.push({ id, cdp, session, cookieFile, health });
  }
  const ids = new Set();
  for (const account of accounts) {
    if (ids.has(account.id)) throw new Error(`Duplicate account id in pool: ${account.id}`);
    ids.add(account.id);
  }
  return accounts;
}

export function loadPoolDayState(savedState, day = accountDayKey()) {
  const restricted = new Set(
    Array.isArray(savedState?.restrictedAccounts?.[day])
      ? savedState.restrictedAccounts[day].map(String)
      : []
  );
  const reasons = savedState?.accountBlockReasons?.[day] && typeof savedState.accountBlockReasons[day] === "object"
    ? { ...savedState.accountBlockReasons[day] }
    : {};
  const usage = savedState?.accountUsage?.[day] && typeof savedState.accountUsage[day] === "object"
    ? { ...savedState.accountUsage[day] }
    : {};
  // Coerce usage counts to numbers.
  for (const [id, value] of Object.entries(usage)) {
    usage[id] = Number(value) || 0;
  }
  return { day, restricted, reasons, usage };
}

export function markAccountBlocked(poolDayState, accountId, reason = "restricted") {
  if (!accountId) return;
  poolDayState.restricted.add(String(accountId));
  poolDayState.reasons[String(accountId)] = {
    reason: String(reason || "restricted"),
    at: new Date().toISOString(),
  };
}

export function bumpAccountUsage(poolDayState, accountId, amount = 1) {
  if (!accountId) return;
  const id = String(accountId);
  poolDayState.usage[id] = (Number(poolDayState.usage[id]) || 0) + amount;
}

export function chooseAccount(accounts, poolDayState, preferredId = "", options = {}) {
  const restricted = poolDayState?.restricted || new Set();
  const usage = poolDayState?.usage || {};
  const requireHealthyCookies = options.requireHealthyCookies !== false;
  const available = accounts.filter(account => {
    if (restricted.has(account.id)) return false;
    if (requireHealthyCookies && account.health && account.health.ok === false) return false;
    return true;
  });
  if (!available.length) {
    const blocked = accounts.map(account => ({
      id: account.id,
      blocked: restricted.has(account.id),
      reason: poolDayState?.reasons?.[account.id]?.reason || (account.health?.ok === false ? "invalid-cookies" : ""),
      health: account.health || null,
    }));
    throw new DolaCliError(
      "ACCOUNT_POOL_EXHAUSTED",
      "All accounts in the pool are restricted, quota-exhausted, or have invalid cookies for today.",
      { day: poolDayState?.day || accountDayKey(), accounts: blocked }
    );
  }
  if (preferredId) {
    const preferred = available.find(account => account.id === preferredId);
    if (preferred) return preferred;
    console.log(`[dola-cli] preferred account ${preferredId} unavailable; picking another`);
  }
  // Least-used first, then original order (stable for cookie-file numeric names).
  const ranked = [...available].sort((a, b) => {
    const usageDiff = (Number(usage[a.id]) || 0) - (Number(usage[b.id]) || 0);
    if (usageDiff) return usageDiff;
    return accounts.indexOf(a) - accounts.indexOf(b);
  });
  return ranked[0];
}

export function accountStateFields(accountPoolFile, activeAccount, poolDayState) {
  if (!accountPoolFile) return {};
  const day = poolDayState?.day || accountDayKey();
  return {
    accountPoolFile: path.resolve(accountPoolFile),
    accountId: activeAccount?.id || "",
    restrictedAccounts: { [day]: [...(poolDayState?.restricted || [])].sort() },
    accountBlockReasons: { [day]: poolDayState?.reasons || {} },
    accountUsage: { [day]: poolDayState?.usage || {} },
  };
}

export async function listAccountPoolStatus(accountPoolFile, savedState = null) {
  const accounts = await loadAccountPool(accountPoolFile);
  const dayState = loadPoolDayState(savedState, accountDayKey());
  return {
    pool: path.resolve(accountPoolFile),
    day: dayState.day,
    accounts: accounts.map(account => ({
      id: account.id,
      cookieFile: account.cookieFile || "",
      cdp: account.cdp,
      session: account.session || "",
      health: account.health || null,
      blocked: dayState.restricted.has(account.id),
      blockReason: dayState.reasons[account.id] || null,
      usageToday: Number(dayState.usage[account.id]) || 0,
    })),
  };
}
