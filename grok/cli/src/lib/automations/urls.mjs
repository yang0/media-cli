// URL builders / parsers for grok.com automations.
import { GROK_BASE } from '../config.mjs';

const UUID_RE =
  '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const RESULT_PATH_RE = new RegExp(`\\/c\\/(${UUID_RE})`, 'i');
const RID_RE = new RegExp(`(?:\\?|&)rid=(${UUID_RE})`, 'i');

/**
 * @param {string} automationId
 * @returns {string}
 */
export function runsListUrl(automationId) {
  if (!automationId || typeof automationId !== 'string') {
    throw new Error('automationId 不能为空');
  }
  const id = automationId.trim();
  const u = new URL('/automations', GROK_BASE);
  u.searchParams.set('automationId', id);
  u.searchParams.set('tab', 'runs');
  return u.toString();
}

/**
 * @param {string} href
 * @returns {boolean}
 */
export function isResultHref(href) {
  if (!href) return false;
  try {
    const abs = href.startsWith('http') ? href : new URL(href, GROK_BASE).toString();
    return RESULT_PATH_RE.test(abs) && RID_RE.test(abs);
  } catch {
    return false;
  }
}

/**
 * @param {string} href
 * @returns {{ conversationId: string, runId: string, url: string } | null}
 */
export function parseResultUrl(href) {
  if (!href) return null;
  try {
    const abs = href.startsWith('http') ? new URL(href) : new URL(href, GROK_BASE);
    const pathMatch = abs.pathname.match(RESULT_PATH_RE);
    const rid = abs.searchParams.get('rid') || abs.href.match(RID_RE)?.[1];
    if (!pathMatch || !rid) return null;
    const conversationId = pathMatch[1];
    const url = `${GROK_BASE}/c/${conversationId}?rid=${rid}`;
    return { conversationId, runId: rid, url };
  } catch {
    return null;
  }
}

/**
 * Build a canonical result detail URL.
 * `rid` is the assistant responseId (not taskResultId).
 * @param {string} conversationId
 * @param {string} responseId
 */
export function resultDetailUrl(conversationId, responseId) {
  if (responseId) return `${GROK_BASE}/c/${conversationId}?rid=${responseId}`;
  return `${GROK_BASE}/c/${conversationId}`;
}

/**
 * REST paths used by automations modules.
 * @param {string} automationId
 */
export function runsApiPath(automationId) {
  return `/rest/automations/${encodeURIComponent(automationId)}/runs`;
}

/**
 * @param {string} conversationId
 */
export function responsesApiPath(conversationId) {
  return `/rest/app-chat/conversations/${encodeURIComponent(conversationId)}/responses`;
}
