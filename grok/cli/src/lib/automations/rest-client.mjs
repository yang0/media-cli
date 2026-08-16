// Authenticated grok.com REST helpers (run inside a logged-in page context).
import { GROK_BASE } from '../config.mjs';

/**
 * Ensure the page has grok.com origin + cookies before calling same-origin fetch.
 * @param {import('playwright-core').Page} page
 * @param {{ timeoutMs?: number }} [opts]
 */
export async function ensureGrokOrigin(page, { timeoutMs = 30_000 } = {}) {
  const cur = page.url();
  if (/^https:\/\/grok\.com(\/|$)/i.test(cur)) return;
  await page.goto(`${GROK_BASE}/`, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
}

/**
 * JSON GET via page fetch (inherits browser cookies).
 * @param {import('playwright-core').Page} page
 * @param {string} pathOrUrl - absolute path on grok.com or full URL
 * @returns {Promise<{ status: number, ok: boolean, json: any, text: string }>}
 */
export async function grokFetchJson(page, pathOrUrl) {
  const result = await page.evaluate(async (path) => {
    const url = path.startsWith('http') ? path : path;
    const res = await fetch(url, {
      credentials: 'include',
      headers: { Accept: 'application/json' },
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: res.status, ok: res.ok, text, json };
  }, pathOrUrl);

  return result;
}

/**
 * List automation runs.
 * GET /rest/automations/:id/runs
 *
 * @param {import('playwright-core').Page} page
 * @param {string} automationId
 */
export async function fetchAutomationRuns(page, automationId) {
  await ensureGrokOrigin(page);
  const path = `/rest/automations/${encodeURIComponent(automationId)}/runs`;
  const res = await grokFetchJson(page, path);
  if (res.status === 401 || res.status === 403) {
    throw new Error(
      `未登录或无权访问 automation runs（HTTP ${res.status}）。请在 CDP Chrome 登录 https://grok.com 后重试。`,
    );
  }
  if (!res.ok) {
    const msg = res.json?.message || res.text?.slice(0, 200) || '';
    throw new Error(`获取 runs 失败 HTTP ${res.status}${msg ? `: ${msg}` : ''} (${path})`);
  }
  const runs = res.json?.runs;
  if (!Array.isArray(runs)) {
    throw new Error(`runs 响应格式异常：缺少 runs 数组 (${path})`);
  }
  return runs;
}

/**
 * Fetch conversation responses (prompt + assistant answer).
 * GET /rest/app-chat/conversations/:id/responses
 *
 * @param {import('playwright-core').Page} page
 * @param {string} conversationId
 */
export async function fetchConversationResponses(page, conversationId) {
  await ensureGrokOrigin(page);
  const path = `/rest/app-chat/conversations/${encodeURIComponent(conversationId)}/responses`;
  const res = await grokFetchJson(page, path);
  if (res.status === 401 || res.status === 403) {
    throw new Error(
      `未登录或无权访问 conversation responses（HTTP ${res.status}）。请在 CDP Chrome 登录 https://grok.com 后重试。`,
    );
  }
  if (!res.ok) {
    const msg = res.json?.message || res.text?.slice(0, 200) || '';
    throw new Error(`获取 conversation responses 失败 HTTP ${res.status}${msg ? `: ${msg}` : ''} (${path})`);
  }
  const responses = res.json?.responses;
  if (!Array.isArray(responses)) {
    throw new Error(`responses 响应格式异常：缺少 responses 数组 (${path})`);
  }
  return responses;
}
