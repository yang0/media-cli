import path from 'node:path';
import { evaluate, pageSnapshot, waitForComposer } from '../cdp.js';
import { imageGenerationUiSnapshot, waitForImageGenerationComplete } from '../chat/reply.js';
import { ensureImageGenerationMode } from '../image/mode.js';
import { clearImageHook } from '../media/capture.js';
import { sleep } from '../utils.js';
import { ensureVideoGenerationMode, selectVideoOptions } from '../video/mode.js';

async function evaluateWithRetry(client, expression, label, retries = 3) {
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      return await evaluate(client, expression);
    } catch (error) {
      lastError = error;
      const timedOut = /CDP command timed out: Runtime\.evaluate/i.test(String(error?.message || error));
      if (!timedOut || attempt === retries) throw error;
      console.log(`[dola-cli] ${label} timed out during UI refresh; retrying (${attempt}/${retries - 1})`);
      await sleep(1000 * attempt);
    }
  }
  throw lastError;
}

/**
 * Attach 0–n local files as reference images.
 * Empty list is a no-op (text-only video/image gen).
 */
export async function attachFiles(client, files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  if (!list.length) {
    console.log("[dola-cli] no reference images (0 files)");
    return [];
  }
  const names = list.map(file => path.basename(file));
  console.log(`[dola-cli] attaching ${list.length} reference image(s): ${names.join(", ")}`);

  for (let attempt = 1; attempt <= 6; attempt += 1) {
    try {
      await client.send("DOM.enable", {}, { timeoutMs: 15000 }).catch(() => {});
      await sleep(300);
      const documentResult = await client.send("DOM.getDocument", { depth: 0, pierce: false }, { timeoutMs: 15000 });
      const rootNodeId = documentResult.root?.nodeId;
      if (!rootNodeId) throw new Error("Could not inspect Dola DOM for file input.");

      let inputResult = await client.send("DOM.querySelector", {
        nodeId: rootNodeId,
        selector: "input[type=file]",
      }, { timeoutMs: 15000 });

      if (!inputResult.nodeId) {
        await clickAttachmentButton(client).catch(() => {});
        await sleep(800);
        const doc2 = await client.send("DOM.getDocument", { depth: 0, pierce: false }, { timeoutMs: 15000 });
        inputResult = await client.send("DOM.querySelector", {
          nodeId: doc2.root?.nodeId || rootNodeId,
          selector: "input[type=file]",
        }, { timeoutMs: 15000 });
      }

      if (inputResult.nodeId) {
        // CDP accepts multiple absolute paths in one call (0–n reference images).
        await client.send("DOM.setFileInputFiles", { nodeId: inputResult.nodeId, files: list }, { timeoutMs: 30000 });
        await waitForAttachments(client, names);
        console.log(`[dola-cli] attached ${names.join(", ")}`);
        return names;
      }
    } catch (error) {
      console.log(`[dola-cli] attach attempt ${attempt}/6 failed: ${error.message}`);
      await sleep(1000 * attempt);
    }
  }

  throw new Error(`No Dola file input found after retries (wanted ${list.length} file(s)).`);
}

export async function clickAttachmentButton(client) {
  const button = await evaluate(client, `(() => {
    const visible = el => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    // attach / upload / image / file / photo / 添加 / 上传 / 图片 / 文件 / 附件
    const words = /attach|upload|image|file|photo|\\u6dfb\\u52a0|\\u4e0a\\u4f20|\\u56fe\\u7247|\\u6587\\u4ef6|\\u9644\\u4ef6/i;
    const candidates = Array.from(document.querySelectorAll("button, [role='button'], label, [aria-label], [title]"))
      .filter(visible)
      .map(el => ({ el, text: [el.innerText, el.textContent, el.getAttribute("aria-label"), el.title, el.className, el.id].join(" "), rect: el.getBoundingClientRect() }))
      .filter(item => words.test(item.text) && item.text.length < 80)
      .sort((a, b) => (b.rect.y - a.rect.y) || (a.rect.x - b.rect.x));
    const item = candidates[0];
    if (!item) return null;
    return { x: item.rect.x + item.rect.width / 2, y: item.rect.y + item.rect.height / 2 };
  })()`);
  if (!button) throw new Error("No visible attachment button found.");
  await client.send("Input.dispatchMouseEvent", { type: "mousePressed", x: button.x, y: button.y, button: "left", clickCount: 1 });
  await client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: button.x, y: button.y, button: "left", clickCount: 1 });
}

export async function waitForAttachments(client, names) {
  const started = Date.now();
  while (Date.now() - started < 12000) {
    const state = await evaluate(client, `(() => {
      const names = ${JSON.stringify(names)};
      const body = (document.body && document.body.innerText) || "";
      const selected = Array.from(document.querySelector("input[type=file]")?.files || []).map(file => file.name);
      return {
        selected,
        seen: names.filter(name => body.includes(name)),
        // uploading / processing / 上传中 / 处理中
        uploading: /uploading|processing|\\u4e0a\\u4f20\\u4e2d|\\u5904\\u7406\\u4e2d/i.test(body),
      };
    })()`, false).catch(() => null);
    if (state?.seen?.length === names.length && !state.uploading) {
      console.log("[dola-cli] attachment visible in UI");
      return;
    }
    if (state?.selected?.length === names.length && names.every(name => state.selected.includes(name))) {
      await sleep(1200);
      console.log("[dola-cli] attachment accepted by file input");
      return;
    }
    await sleep(500);
  }
  // Soft success: do not block prompt/submit on thumbnail rendering.
  console.log("[dola-cli] attachment wait soft-continue (file input set; UI may still render thumbs)");
}

/** Wait until send button is enabled (upload may keep it disabled briefly). */
export async function waitForSendEnabled(client, timeoutMs = 45000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const state = await evaluate(client, `(() => {
      const send = document.querySelector("#flow-end-msg-send");
      if (!send) return { found: false, enabled: false };
      const disabled = Boolean(send.disabled || send.getAttribute("aria-disabled") === "true" || send.dataset.disabled === "true");
      const r = send.getBoundingClientRect();
      return {
        found: true,
        enabled: !disabled && r.width > 0 && r.height > 0,
        text: (send.innerText || send.getAttribute("aria-label") || "").trim().slice(0, 40),
      };
    })()`).catch(() => ({ found: false, enabled: false }));
    if (state?.enabled) {
      console.log(`[dola-cli] send button ready (${state.text || "send"})`);
      return true;
    }
    await sleep(500);
  }
  console.log("[dola-cli] send button still disabled/missing; will try Enter / click anyway");
  return false;
}

/**
 * Reference-software-aligned video prep:
 *   1) click 视频生成
 *   2) set duration (5/10 UI + 15 via completion patch) / aspect ratio
 *   3) attach 0–n reference images
 * Prompt fill + submit happen separately in submitPrompt.
 */
export async function prepareVideoComposer(client, options = {}, files = []) {
  await waitForComposer(client, 45000).catch(() => {});
  console.log("[dola-cli] video step 1/3: switch to 视频生成");
  await ensureVideoGenerationMode(client);
  console.log("[dola-cli] video step 2/3: duration / size options + completion patch");
  await selectVideoOptions(client, options);
  const list = Array.isArray(files) ? files : [];
  console.log(`[dola-cli] video step 3/3: reference images count=${list.length}`);
  const attached = await attachFiles(client, list);
  if (attached.length) {
    await sleep(800);
    await waitForSendEnabled(client, 40000);
  }
  return attached;
}

export async function prepareImageComposer(client, options = {}, files = []) {
  await waitForComposer(client, 45000).catch(() => {});
  await ensureImageGenerationMode(client);
  const attached = await attachFiles(client, Array.isArray(files) ? files : []);
  if (attached.length) await sleep(1500);
  return attached;
}

export async function findSendButton(client) {
  // Prefer #flow-end-msg-send only — broad "生成" matches hit 视频生成 chips and stall the flow.
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    const button = await evaluate(client, `(() => {
      const visible = el => {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      };
      const isDisabled = el => Boolean(el.disabled || el.getAttribute("aria-disabled") === "true" || el.dataset.disabled === "true");
      const send = document.querySelector("#flow-end-msg-send");
      if (visible(send) && !isDisabled(send)) {
        const rect = send.getBoundingClientRect();
        return {
          ok: true,
          text: (send.innerText || send.getAttribute("aria-label") || "send").trim().slice(0, 80),
          x: rect.x + rect.width / 2,
          y: rect.y + rect.height / 2,
        };
      }
      // send / submit / 发送 / 提交 — avoid bare 生成 (matches mode chips)
      const words = /^(send|submit|\\u53d1\\u9001|\\u63d0\\u4ea4)$/i;
      const candidates = Array.from(document.querySelectorAll("button, [role='button']"))
        .filter(visible)
        .map(el => {
          const text = (el.innerText || el.textContent || el.getAttribute("aria-label") || "").replace(/\\s+/g, " ").trim();
          const rect = el.getBoundingClientRect();
          return { text, rect, disabled: isDisabled(el) };
        })
        .filter(item => !item.disabled && words.test(item.text) && item.rect.y > window.innerHeight * 0.5);
      const item = candidates.sort((a, b) => b.rect.x - a.rect.x)[0];
      if (!item) return { ok: false, disabled: Boolean(send && isDisabled(send)) };
      return { ok: true, text: item.text.slice(0, 80), x: item.rect.x + item.rect.width / 2, y: item.rect.y + item.rect.height / 2 };
    })()`).catch(() => ({ ok: false }));
    if (button?.ok) return button;
    await sleep(500);
  }
  return { ok: false };
}

export async function syncInputText(client, promptText) {
  return evaluateWithRetry(client, `(() => {
    const text = ${JSON.stringify(promptText)};
    const visible = el => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    const el = Array.from(document.querySelectorAll("textarea, input[type='text'], [contenteditable='true'], [role='textbox']"))
      .filter(visible)
      .at(-1);
    if (!el) return false;
    el.focus();
    if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
      const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      el._valueTracker?.setValue("");
      setter?.call(el, text);
    } else {
      el.textContent = text;
    }
    el.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data: text }));
    el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  })()`, "syncing prompt text");
}

/**
 * Fill prompt and click send only.
 * Mode switch + reference attach must be done beforehand via prepareVideoComposer / prepareImageComposer.
 */
export async function submitPrompt(client, promptText, options = {}) {
  // Optional late mode switch only when caller skipped prepare (legacy / character path).
  if (options.ensureMode !== false) {
    if (options.videoGen && !options.modePrepared) {
      await ensureVideoGenerationMode(client);
      await selectVideoOptions(client, options);
    } else if (options.imageGen && !options.modePrepared) {
      await ensureImageGenerationMode(client);
    }
  }

  console.log("[dola-cli] filling prompt into composer...");
  const inputInfo = await evaluateWithRetry(client, `(() => {
    const visible = el => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    const pickLastVisible = selectors => {
      for (const selector of selectors) {
        const items = Array.from(document.querySelectorAll(selector)).filter(visible);
        if (items.length) return { el: items[items.length - 1], selector };
      }
      return null;
    };
    const input = pickLastVisible([
      "textarea:not([aria-hidden='true']):not([tabindex='-1'])",
      "[contenteditable='true']",
      "[role='textbox']",
      "div[contenteditable='true']",
      "textarea",
      "input[type='text']"
    ]);
    if (!input) return { ok: false, error: "No visible Dola input box found." };
    input.el.focus();
    input.el.setSelectionRange && input.el.setSelectionRange(0, input.el.value ? input.el.value.length : 0);
    const rect = input.el.getBoundingClientRect();
    return { ok: true, selector: input.selector, x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, tagName: input.el.tagName };
  })()`, "finding the prompt editor");

  if (!inputInfo?.ok) throw new Error(inputInfo?.error || "No visible Dola input box found.");
  await client.send("Input.dispatchMouseEvent", { type: "mousePressed", x: inputInfo.x, y: inputInfo.y, button: "left", clickCount: 1 });
  await client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: inputInfo.x, y: inputInfo.y, button: "left", clickCount: 1 });
  await client.send("Input.dispatchKeyEvent", { type: "keyDown", windowsVirtualKeyCode: 65, code: "KeyA", key: "a", modifiers: 2 });
  await client.send("Input.dispatchKeyEvent", { type: "keyUp", windowsVirtualKeyCode: 65, code: "KeyA", key: "a", modifiers: 2 });
  await sleep(80);
  await client.send("Input.dispatchKeyEvent", { type: "keyDown", windowsVirtualKeyCode: 46, code: "Delete", key: "Delete" });
  await client.send("Input.dispatchKeyEvent", { type: "keyUp", windowsVirtualKeyCode: 46, code: "Delete", key: "Delete" });
  await sleep(80);
  await client.send("Input.insertText", { text: promptText });
  await syncInputText(client, promptText);
  console.log(`[dola-cli] prompt filled (${promptText.slice(0, 48)}${promptText.length > 48 ? "…" : ""})`);

  await waitForSendEnabled(client, options.videoGen ? 45000 : 15000);
  console.log("[dola-cli] clicking send...");
  const buttonInfo = await findSendButton(client);
  if (buttonInfo?.ok) {
    await client.send("Input.dispatchMouseEvent", { type: "mousePressed", x: buttonInfo.x, y: buttonInfo.y, button: "left", clickCount: 1 });
    await client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: buttonInfo.x, y: buttonInfo.y, button: "left", clickCount: 1 });
    // Also DOM-click the known send id when present.
    await evaluate(client, `(() => {
      const el = document.querySelector("#flow-end-msg-send");
      if (el && !el.disabled) { el.click(); return true; }
      return false;
    })()`).catch(() => false);
    await sleep(1200);
  } else {
    console.log("[dola-cli] send button not found; pressing Enter");
    await client.send("Input.dispatchKeyEvent", { type: "keyDown", windowsVirtualKeyCode: 13, code: "Enter", key: "Enter" });
    await client.send("Input.dispatchKeyEvent", { type: "keyUp", windowsVirtualKeyCode: 13, code: "Enter", key: "Enter" });
    await sleep(1200);
  }

  let stillThere = "";
  for (let checkAttempt = 0; checkAttempt < 4; checkAttempt += 1) {
    stillThere = await evaluate(client, `(() => {
      const el = Array.from(document.querySelectorAll("textarea, input[type='text'], [contenteditable='true'], [role='textbox']")).filter(el => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      }).at(-1);
      return el ? (el.value || el.innerText || el.textContent || "") : "";
    })()`).catch(() => "");
    if (!stillThere.includes(promptText)) break;
    // retry send once
    if (checkAttempt === 1) {
      const again = await findSendButton(client);
      if (again?.ok) {
        await client.send("Input.dispatchMouseEvent", { type: "mousePressed", x: again.x, y: again.y, button: "left", clickCount: 1 });
        await client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: again.x, y: again.y, button: "left", clickCount: 1 });
      }
    }
    await sleep(1500);
  }
  if (stillThere.includes(promptText)) {
    throw new Error("Prompt text is still in the input after submit; Dola did not accept the message (send may still be blocked by upload).");
  }
  console.log("[dola-cli] submit accepted (composer cleared)");
  return { selector: inputInfo.selector, method: buttonInfo?.ok ? "cdp-mouse" : "enter-key", buttonText: buttonInfo?.text || "" };
}

export async function waitForResponseText(client, beforeTail, options) {
  const started = Date.now();
  let lastText = "";
  let lastChange = Date.now();
  while (Date.now() - started < options.timeout) {
    const snapshot = await pageSnapshot(client);
    const text = snapshot.textTail || "";
    if (text !== lastText) {
      lastText = text;
      lastChange = Date.now();
      console.log(`[dola-cli] page text changed (${text.length} chars in tail)`);
    }
    if (text && text !== beforeTail && Date.now() - lastChange >= options.stable) return snapshot;
    await sleep(1000);
  }
  return pageSnapshot(client);
}

export async function sendCharacterContext(client, imagePath, characterPrompt, options) {
  const beforeGenerationUi = await imageGenerationUiSnapshot(client);
  await waitForComposer(client);
  await clearImageHook(client);
  await attachFiles(client, [imagePath]);
  await submitPrompt(client, characterPrompt, options);
  await waitForImageGenerationComplete(client, { ...options, beforeGenerationUi });
  await sleep(500);
}
