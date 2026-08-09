import { evaluate } from '../cdp.js';
import { sleep } from '../utils.js';

/**
 * Switch composer to image generation on https://www.dola.com/chat
 * via the skill chip / toolbar (do NOT open /chat/create-image).
 */
export async function ensureImageGenerationMode(client) {
  const state = await evaluate(client, `(() => {
    // Prefer exact short labels used on the main chat page.
    const imageTexts = ["\\u56fe\\u50cf\\u751f\\u6210", "Create Image", "Image Generation"];
    const visible = el => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    const plain = el => (el.innerText || el.textContent || el.getAttribute("aria-label") || el.title || "")
      .replace(/\\s+/g, " ").trim();
    const isActive = el => {
      const text = [plain(el), el.className, el.id, el.getAttribute("aria-selected"), el.getAttribute("data-state")].join(" ");
      const selected = el.getAttribute("aria-selected") === "true" || el.getAttribute("data-state") === "active";
      return selected || /active|selected|checked|primary|highlight/i.test(text);
    };
    const nodes = Array.from(document.querySelectorAll(
      'button, [role="button"], [data-skill-id], [data-testid], a, div, span'
    )).filter(visible);

    // Already in image mode if a short "图像生成" control is active.
    const imageNodes = nodes.filter(el => {
      const t = plain(el);
      return imageTexts.some(label => t === label || t.startsWith(label)) && t.length <= 24;
    });
    if (imageNodes.some(isActive)) {
      return { ok: true, already: true, via: "active-chip" };
    }

    // Prefer bottom skill bar / quick chips (main chat), not gallery links.
    const candidates = nodes
      .map(el => {
        const t = plain(el);
        const rect = el.getBoundingClientRect();
        let score = 0;
        if (imageTexts.some(label => t === label)) score += 300;
        else if (imageTexts.some(label => t.startsWith(label) && t.length <= 24)) score += 220;
        else return null;
        // Prefer composer-adjacent chips (lower half) over header/nav.
        if (rect.y > window.innerHeight * 0.45) score += 40;
        // Prefer smaller leaf chips over big containers.
        score += Math.max(0, 40 - Math.min(t.length, 40));
        score -= Math.min(rect.width * rect.height / 20000, 50);
        return { el, score, rect, text: t.slice(0, 80) };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score);

    const item = candidates[0];
    if (!item) {
      return {
        ok: false,
        error: "No image generation chip found on /chat (look for \\u56fe\\u50cf\\u751f\\u6210).",
        sample: nodes.map(n => plain(n)).filter(t => t && t.length <= 30).slice(0, 25),
      };
    }
    return {
      ok: true,
      already: false,
      text: item.text,
      x: item.rect.x + item.rect.width / 2,
      y: item.rect.y + item.rect.height / 2,
    };
  })()`);

  if (!state?.ok) {
    const sample = state?.sample ? ` candidates=${JSON.stringify(state.sample)}` : "";
    throw new Error((state?.error || "No image generation button found.") + sample);
  }
  if (!state.already) {
    console.log(`[dola-cli] clicking image mode: ${state.text || "chip"}`);
    await client.send("Input.dispatchMouseEvent", { type: "mousePressed", x: state.x, y: state.y, button: "left", clickCount: 1 });
    await client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: state.x, y: state.y, button: "left", clickCount: 1 });
    await sleep(800);
  }

  // Do not require /chat/create-image. Confirm chip active or composer still present.
  const switched = await evaluate(client, `(() => new Promise(resolve => {
    const imageTexts = ["\\u56fe\\u50cf\\u751f\\u6210", "Create Image", "Image Generation"];
    const visible = el => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    const plain = el => (el.innerText || el.textContent || el.getAttribute("aria-label") || "").replace(/\\s+/g, " ").trim();
    const check = () => {
      // Stay on /chat; create-image is intentionally not required.
      if (/\\/chat\\/create-image/i.test(location.pathname)) return true;
      const buttons = Array.from(document.querySelectorAll("button, [role='button'], [data-skill-id], div, span")).filter(visible);
      const matching = buttons.filter(el => {
        const t = plain(el);
        return imageTexts.some(label => t === label || t.startsWith(label)) && t.length <= 24;
      });
      const active = matching.some(el => {
        const text = [plain(el), el.className, el.getAttribute("aria-selected"), el.getAttribute("data-state")].join(" ");
        return /active|selected|checked|primary|highlight|true/i.test(text)
          || el.getAttribute("aria-selected") === "true"
          || el.getAttribute("data-state") === "active";
      });
      // If chip click is fire-and-forget without selected state, still OK when on /chat with composer.
      const composer = Boolean(document.querySelector("textarea, [contenteditable='true'], [role='textbox']"));
      const onChat = /\\/chat/i.test(location.pathname || "");
      return active || (onChat && composer && matching.length > 0);
    };
    if (check()) return resolve(true);
    const deadline = Date.now() + 6000;
    const timer = setInterval(() => {
      if (check() || Date.now() > deadline) {
        clearInterval(timer);
        resolve(check());
      }
    }, 250);
  }))()`);

  if (!switched) throw new Error("Clicked image generation but Dola did not appear to switch modes on /chat.");
  console.log("[dola-cli] image generation mode ready (on /chat)");
}
