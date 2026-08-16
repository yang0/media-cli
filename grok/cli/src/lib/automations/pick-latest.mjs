// Select the latest run from a RunSummary list.

/**
 * @typedef {import('./list-runs.mjs').RunSummary} RunSummary
 */

const SUCCESS_RE = /SUCCESS|SUCCEEDED|COMPLETED|完成|成功/i;
const RUNNING_RE = /RUNNING|IN_PROGRESS|PENDING|QUEUED|生成中|运行中|进行中/i;

/**
 * Pick the newest successful run when possible.
 * API list is typically newest-first; we also sort by createTime desc as a safeguard.
 *
 * @param {RunSummary[]} runs
 * @param {{ preferCompleted?: boolean }} [opts]
 * @returns {RunSummary}
 */
export function pickLatestRun(runs, { preferCompleted = true } = {}) {
  if (!Array.isArray(runs) || runs.length === 0) {
    throw new Error('运行列表为空，无法选择最新一条');
  }

  const sorted = [...runs].sort((a, b) => {
    const ta = Date.parse(a.createTime || a.updateTime || '') || 0;
    const tb = Date.parse(b.createTime || b.updateTime || '') || 0;
    if (tb !== ta) return tb - ta;
    return 0; // stable relative to original when equal/missing
  });

  // If createTimes missing, keep original order (API newest-first)
  const ordered = sorted.some((r) => r.createTime || r.updateTime) ? sorted : runs;

  if (preferCompleted) {
    const success = ordered.find((r) => SUCCESS_RE.test(r.status || ''));
    if (success) return success;

    const notRunning = ordered.find((r) => !RUNNING_RE.test(r.status || ''));
    if (notRunning) return notRunning;
  }

  return ordered[0];
}
