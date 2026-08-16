// List automation runs (prefer REST; optional DOM fallback).
import { fetchAutomationRuns } from './rest-client.mjs';
import { parseResultUrl, runsListUrl } from './urls.mjs';
import { GROK_BASE } from '../config.mjs';

/**
 * @typedef {{
 *   runId: string,
 *   taskResultId: string,
 *   conversationId: string,
 *   url: string,
 *   title?: string,
 *   status?: string,
 *   createTime?: string,
 *   updateTime?: string,
 * }} RunSummary
 */

/**
 * Normalize REST run objects → RunSummary[].
 * Note: detail page `rid` is the assistant responseId (filled later when scraping);
 * list URL uses conversationId; taskResultId is the run identity from the API.
 *
 * @param {any[]} apiRuns
 * @returns {RunSummary[]}
 */
export function mapApiRuns(apiRuns) {
  /** @type {RunSummary[]} */
  const out = [];
  for (const r of apiRuns || []) {
    const conversationId = r.conversationId || r.conversation_id;
    const taskResultId = r.taskResultId || r.task_result_id || r.id;
    if (!conversationId || !taskResultId) continue;
    out.push({
      runId: taskResultId,
      taskResultId,
      conversationId,
      // provisional url (rid may be refined after loading responses)
      url: `${GROK_BASE}/c/${conversationId}`,
      title: r.title || undefined,
      status: r.status || undefined,
      createTime: r.createTime || r.create_time || undefined,
      updateTime: r.updateTime || r.update_time || undefined,
    });
  }
  return out;
}

/**
 * List runs for an automation (newest first as returned by API).
 *
 * @param {import('playwright-core').Page} page
 * @param {string} automationId
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<RunSummary[]>}
 */
export async function listAutomationRuns(page, automationId, { timeoutMs = 60_000 } = {}) {
  void timeoutMs;
  const apiRuns = await fetchAutomationRuns(page, automationId);
  const runs = mapApiRuns(apiRuns);
  if (runs.length === 0) {
    // Fallback: DOM scrape of result links (rare — SPA rarely exposes rid hrefs)
    const domRuns = await extractRunsFromDom(page, automationId);
    if (domRuns.length) return domRuns;
    throw new Error(`automation ${automationId} 的 runs 列表为空`);
  }
  return runs;
}

/**
 * @param {import('playwright-core').Page} page
 * @param {string} automationId
 * @returns {Promise<RunSummary[]>}
 */
async function extractRunsFromDom(page, automationId) {
  try {
    await page.goto(runsListUrl(automationId), {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    });
    await page.waitForTimeout(3000);
  } catch {
    return [];
  }

  const raw = await page.evaluate(() => {
    /** @type {string[]} */
    const hrefs = [];
    for (const a of document.querySelectorAll('a[href]')) {
      const h = a.href || a.getAttribute('href') || '';
      if (/\/c\/[0-9a-f-]{36}/i.test(h) && /[?&]rid=/i.test(h)) hrefs.push(h);
    }
    return hrefs;
  });

  /** @type {RunSummary[]} */
  const runs = [];
  const seen = new Set();
  for (const href of raw) {
    const p = parseResultUrl(href);
    if (!p || seen.has(p.runId)) continue;
    seen.add(p.runId);
    runs.push({
      runId: p.runId,
      taskResultId: p.runId,
      conversationId: p.conversationId,
      url: p.url,
    });
  }
  return runs;
}
