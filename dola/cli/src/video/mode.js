import { evaluate } from '../cdp.js';
import { sleep } from '../utils.js';
import { installVideoRequestPatch } from '../video/patch.js';

export function videoModeReadyExpression() {
  // Use unicode escapes so source encoding never corrupts Chinese labels.
  // Keep selectors lean — scanning all div/span after image attach freezes the page.
  return `(() => {
    const visible = el => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.display !== "none" && s.visibility !== "hidden";
    };
    const plain = el => (el.innerText || el.textContent || el.getAttribute("aria-label") || el.title || "").replace(/\\s+/g, " ").trim();
    const hasControls = Array.from(document.querySelectorAll(
      '[data-input-engine-actionbar-control-key="video-duration"], [data-input-engine-actionbar-control-key="video-ratio"], [data-input-engine-actionbar-control-key*="video" i]'
    )).some(visible);
    if (hasControls) return { ready: true, reason: "controls" };

    // Buttons/tabs only (not every div/span — hangs after large attachments).
    const chips = Array.from(document.querySelectorAll("button, [role='button'], [role='tab'], a")).filter(visible);
    const nearComposer = chips.some(el => {
      const t = plain(el);
      if (t.length > 32) return false;
      const y = el.getBoundingClientRect().y;
      if (y <= innerHeight * 0.45) return false;
      if (/Seedance/i.test(t)) return true;
      if (/^(5|10|15)\\s*(s|\\u79d2)$/i.test(t)) return true;
      if (/video-duration|video-ratio|seedance/i.test(String(el.className || "") + (el.getAttribute("data-input-engine-actionbar-control-key") || ""))) return true;
      return false;
    });
    if (nearComposer) return { ready: true, reason: "composer-video-ui" };

    const videoChip = chips.find(el => {
      const t = plain(el);
      return t === "\\u89c6\\u9891\\u751f\\u6210" || t === "Create Video" || t === "Video Generation";
    });
    const imageChip = chips.find(el => {
      const t = plain(el);
      return t === "\\u56fe\\u50cf\\u751f\\u6210" || t === "Create Image" || t === "Image Generation";
    });
    const strictActive = el => {
      if (!el) return false;
      return el.getAttribute("aria-selected") === "true"
        || el.getAttribute("aria-pressed") === "true"
        || el.getAttribute("data-state") === "active"
        || el.getAttribute("data-checked") === "true"
        || el.getAttribute("data-active") === "true";
    };
    if (videoChip && strictActive(videoChip) && !(imageChip && strictActive(imageChip))) {
      return { ready: true, reason: "chip-active", text: plain(videoChip) };
    }
    return {
      ready: false,
      reason: videoChip ? "chip-found-not-active" : "no-video-ui",
      videoChip: videoChip ? plain(videoChip) : "",
      imageChip: imageChip ? plain(imageChip) : "",
    };
  })()`;
}

export async function ensureVideoGenerationMode(client) {
  const readyBefore = await evaluate(client, videoModeReadyExpression()).catch(() => ({ ready: false }));
  if (readyBefore?.ready) {
    console.log(`[dola-cli] video generation mode ready (${readyBefore.reason})`);
    return;
  }

  const state = await evaluate(client, `(() => {
    // \\u89c6\\u9891\\u751f\\u6210 = 视频生成
    const exactLabels = ["\\u89c6\\u9891\\u751f\\u6210", "Create Video", "Video Generation", "Text to Video", "Image to Video"];
    const visible = el => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    const plain = el => (el.innerText || el.textContent || el.getAttribute("aria-label") || el.title || "").replace(/\\s+/g, " ").trim();
    const meta = el => [plain(el), el.getAttribute("aria-label"), el.title, el.className, el.id].join(" ");
    // Prefer real BUTTON chips. Nested text divs also match "视频生成" but do not switch mode.
    const nodes = Array.from(document.querySelectorAll("button, [role='button'], [role='tab'], a")).filter(visible);
    const candidates = nodes.map(el => {
      const t = plain(el);
      if (!t || t.length > 24) return null;
      if (!exactLabels.includes(t)) return null;
      const rect = el.getBoundingClientRect();
      let score = 300 + Math.min(120, rect.width * rect.height / 40);
      if (rect.y > innerHeight * 0.55) score += 80;
      if (el.tagName === "BUTTON") score += 40;
      if (/chat-item|sidebar|history|title-/i.test(meta(el))) score -= 200;
      return { score, rect, text: t.slice(0, 80), tag: el.tagName };
    }).filter(Boolean).sort((a, b) => b.score - a.score);
    const item = candidates[0];
    return item
      ? { ok: true, text: item.text, x: item.rect.x + item.rect.width / 2, y: item.rect.y + item.rect.height / 2, score: item.score, tag: item.tag }
      : { ok: false, error: "No video generation button found.", candidates: candidates.slice(0, 5) };
  })()`);
  if (!state?.ok) throw new Error(state?.error || "No video generation button found.");

  console.log(`[dola-cli] clicking video mode control: ${state.text || "(unknown)"} (${state.tag || "?"})`);
  // Prefer DOM click on the largest exact BUTTON; synthetic mouse alone is flaky on these chips.
  const domClicked = await evaluate(client, `(() => {
    const labels = ["\\u89c6\\u9891\\u751f\\u6210", "Create Video", "Video Generation"];
    const plain = el => (el.innerText || el.textContent || el.getAttribute("aria-label") || "").replace(/\\s+/g, " ").trim();
    const visible = el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.display !== "none" && s.visibility !== "hidden"; };
    const el = Array.from(document.querySelectorAll("button, [role='button'], [role='tab']"))
      .filter(visible)
      .filter(node => labels.includes(plain(node)))
      .sort((a, b) => {
        const ar = a.getBoundingClientRect();
        const br = b.getBoundingClientRect();
        return (br.width * br.height) - (ar.width * ar.height) || (br.y - ar.y);
      })[0];
    if (!el) return "";
    el.click();
    return plain(el);
  })()`).catch(() => "");
  if (!domClicked) {
    await client.send("Input.dispatchMouseEvent", { type: "mousePressed", x: state.x, y: state.y, button: "left", clickCount: 1 });
    await client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: state.x, y: state.y, button: "left", clickCount: 1 });
  }

  const started = Date.now();
  while (Date.now() - started < 8000) {
    const ready = await evaluate(client, videoModeReadyExpression()).catch(() => ({ ready: false }));
    if (ready?.ready) {
      console.log(`[dola-cli] video generation mode ready (${ready.reason})`);
      return;
    }
    await sleep(350);
  }
  // Soft-ok after a successful chip click: some builds hide Seedance/5s chips until first focus,
  // and 15s is forced via completion patch anyway (reseller style).
  const controlsReady = await evaluate(client, videoModeReadyExpression()).catch(() => ({ ready: false }));
  if (controlsReady?.ready) {
    console.log(`[dola-cli] video generation mode ready (${controlsReady.reason})`);
    return;
  }
  console.log(
    `[dola-cli] video chip clicked (${state.text || "视频生成"}); controls not confirmed (${controlsReady?.reason || "unknown"})`
    + " — continuing with completion patch for duration/model"
  );
}

/**
 * Normalize video generation payload options.
 * 15s is not exposed in Dola's official UI; the desktop reseller tools force
 * ability_type=17 + duration=15 + model=seedance_v2.0 on POST /chat/completion.
 */

export async function selectVideoOptions(client, options = {}) {
  if (!options.videoGen) return;
  const config = await installVideoRequestPatch(client, options);
  const durationLabel = String(config?.duration ?? options.duration ?? "");
  const aspectRatio = options.aspectRatio ? String(options.aspectRatio) : "";
  if (!durationLabel && !aspectRatio) return;

  const click = async point => {
    await client.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 });
    await client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 });
  };
  const choose = async (controlKey, value) => {
    const trigger = await evaluate(client, `(() => {
      const el = document.querySelector('[data-input-engine-actionbar-control-key=${JSON.stringify(controlKey)}]');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return r.width && r.height ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
    })()`).catch(() => null);
    if (!trigger) return false;
    await click(trigger);
    await sleep(300);
    const option = await evaluate(client, `(() => {
      const wanted = ${JSON.stringify(String(value))}.replace(/\\s/g, "").toLowerCase();
      const wantedSec = wanted.replace(/s$/, "");
      const visible = el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.display !== "none" && s.visibility !== "hidden"; };
      const text = el => (el.innerText || el.textContent || el.getAttribute("aria-label") || "").replace(/\\s/g, "").toLowerCase();
      const candidates = Array.from(document.querySelectorAll('[role="option"], [role="menuitem"], [data-radix-collection-item], button, label')).filter(visible);
      const el = candidates.find(item => {
        const t = text(item);
        return t === wanted || t === wanted + "s" || t === wantedSec + "s" || t === wantedSec + "秒" || t === wanted + "秒";
      });
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`).catch(() => null);
    if (!option) return false;
    await click(option);
    await sleep(250);
    return true;
  };

  const result = [];
  // Official menu usually has 5s/10s only. Prefer nearest native option for UX,
  // then force the real duration through the completion patch.
  if (durationLabel) {
    const uiDuration = Number(durationLabel) >= 15 ? "10" : durationLabel;
    if (await choose("video-duration", uiDuration)) {
      result.push(`ui:${uiDuration}s`);
    } else if (Number(durationLabel) < 15) {
      console.log(`[dola-cli] video duration UI option not found (${durationLabel}s); relying on completion patch`);
    } else {
      console.log(`[dola-cli] duration ${durationLabel}s is not in the official UI; using completion patch (Seedance-compatible)`);
    }
    result.push(`api:${durationLabel}s`);
  }
  if (aspectRatio) {
    const ratioKeys = ["video-ratio", "video-aspect-ratio", "aspect-ratio", "ratio"];
    let ratioOk = false;
    for (const key of ratioKeys) {
      if (await choose(key, aspectRatio)) {
        result.push(`${key}:${aspectRatio}`);
        ratioOk = true;
        break;
      }
    }
    if (!ratioOk) {
      // Still OK: completion patch injects ratio into ability_param when present.
      console.log(`[dola-cli] video aspect-ratio UI option not found (${aspectRatio}); relying on completion patch`);
      result.push(`ratio-api:${aspectRatio}`);
    }
  }
  if (config?.model) result.push(`model:${config.model}`);
  if (result.length) console.log(`[dola-cli] video options selected: ${result.join(", ")}`);
}

export async function activateLatestVideoPlayer(client) {
  const point = await evaluate(client, `(() => {
    const visible = el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.display !== "none" && s.visibility !== "hidden"; };
    const item = Array.from(document.querySelectorAll('[class*="block-video"]')).filter(visible).at(-1);
    if (!item) return null;
    const trigger = item.querySelector('[class*="play-icon"]') || item;
    trigger.click();
    const r = trigger.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`).catch(() => null);
  if (!point) return false;
  await client.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 });
  await client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 });
  await sleep(750);
  return true;
}

export async function hoverLatestVideoCard(client) {
  const point = await evaluate(client, `(() => {
    const visible = el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.display !== "none" && s.visibility !== "hidden"; };
    const item = Array.from(document.querySelectorAll('[class*="block-video"]')).filter(visible).at(-1);
    if (!item) return null;
    const r = item.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`).catch(() => null);
  if (!point) return false;
  await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
  await sleep(300);
  return true;
}

export async function openLatestVideoMoreMenu(client) {
  const point = await evaluate(client, `(() => {
    const visible = el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.display !== "none" && s.visibility !== "hidden"; };
    const candidates = Array.from(document.querySelectorAll("button, [role='button'], div, [aria-label], [title]"))
      .filter(visible)
      .filter(el => (el.innerText || el.textContent || el.getAttribute("aria-label") || el.title || "").includes("鏇村"))
      .sort((a, b) => (a.getBoundingClientRect().width * a.getBoundingClientRect().height) - (b.getBoundingClientRect().width * b.getBoundingClientRect().height));
    const el = candidates[0];
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`).catch(() => null);
  if (!point) throw new Error("Could not find the newest video card's More button.");
  await client.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 });
  await client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 });
  await sleep(300);
}

/**
 * Resolve a playable/no-watermark video URL the same way the Dola desktop tools do:
 * harvest JSON → cache by vid → POST /samantha/media/get_play_info → decode → strip watermark params.
 * Preview <video src> is never treated as a preferred download when a cleaner URL exists.
 */
