// Orchestrate: list runs → pick latest → scrape detail (REST-first).
import { DEFAULT_CDP, DEFAULT_TIMEOUT_MS } from '../config.mjs';
import { connect, openPage, closeSession } from '../cdp-session.mjs';
import { listAutomationRuns } from './list-runs.mjs';
import { pickLatestRun } from './pick-latest.mjs';
import { scrapeRunResult } from './scrape-result.mjs';

/**
 * @param {{
 *   automationId: string,
 *   cdp?: string,
 *   timeoutMs?: number,
 *   keepOpen?: boolean,
 *   dryList?: boolean,
 * }} opts
 */
export async function fetchLatestAutomationRun({
  automationId,
  cdp = DEFAULT_CDP,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  keepOpen = false,
  dryList = false,
} = {}) {
  if (!automationId) throw new Error('缺少 automationId');

  const { browser, context } = await connect(cdp);
  /** @type {import('playwright-core').Page | undefined} */
  let page;

  try {
    page = await openPage(context, 'about:blank', {
      timeoutMs: Math.min(timeoutMs, 60_000),
    });

    const runs = await listAutomationRuns(page, automationId, {
      timeoutMs: Math.max(15_000, Math.floor(timeoutMs * 0.4)),
    });
    const latest = pickLatestRun(runs);

    if (dryList) {
      return {
        dryList: true,
        automationId,
        runs,
        latest,
        markdown: '',
        finalUrl: latest.url,
        runId: latest.runId,
        conversationId: latest.conversationId,
      };
    }

    const result = await scrapeRunResult(
      page,
      {
        conversationId: latest.conversationId,
        taskResultId: latest.taskResultId || latest.runId,
        url: latest.url,
      },
      { timeoutMs: Math.max(20_000, Math.floor(timeoutMs * 0.6)) },
    );

    return {
      automationId,
      runs,
      latest,
      markdown: result.markdown,
      finalUrl: result.finalUrl,
      runId: result.runId,
      conversationId: result.conversationId,
      responseId: result.responseId,
    };
  } finally {
    await closeSession({ browser, page, keepOpen });
  }
}
