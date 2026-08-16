// Extract automation run answer: prefer REST responses, DOM as fallback.
import { fetchConversationResponses } from './rest-client.mjs';
import { resultDetailUrl, parseResultUrl } from './urls.mjs';

/**
 * Pick the assistant answer from conversation responses.
 * @param {any[]} responses
 * @returns {{ responseId: string, message: string, sender: string } | null}
 */
export function pickAssistantResponse(responses) {
  if (!Array.isArray(responses) || !responses.length) return null;

  const assistants = responses.filter((r) => {
    const sender = String(r.sender || r.role || '').toLowerCase();
    return sender && sender !== 'human' && sender !== 'user';
  });

  // Prefer last non-partial assistant message with content
  const withText = (assistants.length ? assistants : responses).filter(
    (r) => typeof r.message === 'string' && r.message.trim().length > 0 && !r.partial,
  );
  if (!withText.length) return null;

  // Last assistant-like entry
  const chosen = withText[withText.length - 1];
  return {
    responseId: chosen.responseId || chosen.id || '',
    message: String(chosen.message || '').trim(),
    sender: String(chosen.sender || ''),
  };
}

/**
 * @param {import('playwright-core').Page} page
 * @param {{ conversationId: string, taskResultId?: string, url?: string }} target
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<{ markdown: string, finalUrl: string, runId: string, conversationId: string, responseId: string }>}
 */
export async function scrapeRunResult(page, target, { timeoutMs = 90_000 } = {}) {
  void timeoutMs;
  let conversationId = target.conversationId;
  let provisionalUrl = target.url || '';

  if (!conversationId && provisionalUrl) {
    const p = parseResultUrl(provisionalUrl) || parseConversationOnly(provisionalUrl);
    if (p) conversationId = p.conversationId;
  }
  if (!conversationId) {
    throw new Error('scrapeRunResult 需要 conversationId');
  }

  const responses = await fetchConversationResponses(page, conversationId);
  const assistant = pickAssistantResponse(responses);
  if (!assistant?.message) {
    // DOM fallback
    const dom = await scrapeFromDom(page, conversationId, target.taskResultId);
    if (dom) return dom;
    throw new Error(`conversation ${conversationId} 未找到 assistant 正文`);
  }

  const responseId = assistant.responseId || target.taskResultId || '';
  const finalUrl = responseId
    ? resultDetailUrl(conversationId, responseId)
    : `${provisionalUrl || `https://grok.com/c/${conversationId}`}`;

  return {
    markdown: cleanMarkdown(assistant.message),
    finalUrl,
    runId: target.taskResultId || responseId,
    conversationId,
    responseId,
  };
}

/**
 * @param {string} href
 */
function parseConversationOnly(href) {
  try {
    const u = new URL(href, 'https://grok.com');
    const m = u.pathname.match(/\/c\/([0-9a-fA-F-]{36})/i);
    if (!m) return null;
    return { conversationId: m[1], runId: u.searchParams.get('rid') || '', url: u.toString() };
  } catch {
    return null;
  }
}

/**
 * DOM fallback if REST fails.
 * @param {import('playwright-core').Page} page
 * @param {string} conversationId
 * @param {string} [rid]
 */
async function scrapeFromDom(page, conversationId, rid) {
  const url = rid
    ? resultDetailUrl(conversationId, rid)
    : `https://grok.com/c/${conversationId}`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });

  const deadline = Date.now() + 45_000;
  let last = '';
  let stable = 0;
  while (Date.now() < deadline) {
    const text = await page.evaluate(() => {
      const main = document.querySelector('main') || document.body;
      return (main?.innerText || '').trim();
    });
    if (text.length > 80) {
      if (text.length <= last.length + 20) stable += 1;
      else stable = 0;
      last = text;
      if (stable >= 2) break;
    }
    await page.waitForTimeout(1500);
  }
  if (!last || last.length < 40) return null;

  // Drop obvious chrome lines
  const lines = last.split('\n');
  const start = lines.findIndex((l) =>
    /报告|Report|### |## |^\*\*/.test(l) || l.length > 40,
  );
  const body = (start > 0 ? lines.slice(start) : lines).join('\n').trim();
  return {
    markdown: cleanMarkdown(body),
    finalUrl: page.url(),
    runId: rid || '',
    conversationId,
    responseId: rid || '',
  };
}

/**
 * @param {string} md
 */
export function cleanMarkdown(md) {
  return (md || '')
    .replace(/\r\n/g, '\n')
    .replace(/^(Copy|Share|Regenerate|Retry)\n/gim, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
