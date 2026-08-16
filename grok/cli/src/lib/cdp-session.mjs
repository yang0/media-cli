// Playwright CDP session helpers for grok.com / x.com pages.
import pkg from '../../node_modules/playwright-core/index.js';
import { DEFAULT_CDP } from './config.mjs';

const { chromium } = pkg;

/**
 * Connect to an already-running Chrome with remote debugging.
 * @param {string} [cdp]
 * @returns {Promise<{ browser: import('playwright-core').Browser, context: import('playwright-core').BrowserContext }>}
 */
export async function connect(cdp = DEFAULT_CDP) {
  const browser = await chromium.connectOverCDP(cdp);
  const context = browser.contexts()[0];
  if (!context) {
    await browser.close().catch(() => {});
    throw new Error(`CDP 无可用 browser context：${cdp}（请确认 Chrome 已开 remote debugging）`);
  }
  return { browser, context };
}

/**
 * Open a fresh tab and navigate.
 * @param {import('playwright-core').BrowserContext} context
 * @param {string} url
 * @param {{ waitUntil?: 'domcontentloaded'|'load'|'networkidle', timeoutMs?: number }} [opts]
 */
export async function openPage(context, url, { waitUntil = 'domcontentloaded', timeoutMs = 60_000 } = {}) {
  const page = await context.newPage();
  await page.goto(url, { waitUntil, timeout: timeoutMs });
  return page;
}

/**
 * Close page (unless keepOpen) and detach from CDP browser.
 * @param {{ browser: import('playwright-core').Browser, page?: import('playwright-core').Page, keepOpen?: boolean }} opts
 */
export async function closeSession({ browser, page, keepOpen = false } = {}) {
  if (page && !keepOpen) {
    await page.close().catch(() => {});
  }
  // Detach only — do not quit the user's Chrome.
  await browser?.close().catch(() => {});
}
