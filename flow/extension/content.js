(function () {
  "use strict";

  const SOURCE = "flow-skill-bridge";
  const STATE_KEY = "__flowSkillBridgeState";

  const state = (window[STATE_KEY] = window[STATE_KEY] || {
    busy: false,
    lastResult: null,
    lastError: null,
    log: []
  });

  function log(message, data) {
    const entry = {
      at: new Date().toISOString(),
      message,
      data: data || null
    };
    state.log.push(entry);
    state.log = state.log.slice(-200);
    console.debug("[Flow Skill Bridge]", message, data || "");
    window.postMessage({ source: SOURCE, type: "status", entry }, "*");
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function waitFor(predicate, options = {}) {
    const timeoutMs = options.timeoutMs || 15000;
    const intervalMs = options.intervalMs || 250;
    const started = Date.now();
    let lastError;

    while (Date.now() - started < timeoutMs) {
      try {
        const value = await predicate();
        if (value) return value;
      } catch (error) {
        lastError = error;
      }
      await sleep(intervalMs);
    }

    const suffix = lastError ? ` Last error: ${lastError.message}` : "";
    throw new Error(`${options.label || "Condition"} timed out after ${timeoutMs}ms.${suffix}`);
  }

  function visible(element) {
    if (!element) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
  }

  function textOf(element) {
    return (element.innerText || element.textContent || element.getAttribute("aria-label") || "").trim();
  }

  function normalized(text) {
    return String(text || "").replace(/\s+/g, " ").trim().toLowerCase();
  }

  function findByText(selectors, patterns) {
    const elements = Array.from(document.querySelectorAll(selectors));
    return elements.find((element) => {
      if (!visible(element) && element.tagName !== "INPUT") return false;
      const haystack = normalized([
        textOf(element),
        element.getAttribute("aria-label"),
        element.getAttribute("title"),
        element.getAttribute("placeholder")
      ].filter(Boolean).join(" "));
      return patterns.some((pattern) => pattern.test(haystack));
    });
  }

  function clickElement(element) {
    element.scrollIntoView({ block: "center", inline: "center" });
    const rect = element.getBoundingClientRect();
    const clientX = rect.left + rect.width / 2;
    const clientY = rect.top + rect.height / 2;
    const common = { bubbles: true, cancelable: true, view: window, clientX, clientY };
    if (window.PointerEvent) {
      element.dispatchEvent(new PointerEvent("pointerover", { ...common, pointerId: 1, pointerType: "mouse", isPrimary: true }));
      element.dispatchEvent(new PointerEvent("pointerenter", { ...common, pointerId: 1, pointerType: "mouse", isPrimary: true }));
      element.dispatchEvent(new PointerEvent("pointerdown", { ...common, pointerId: 1, pointerType: "mouse", isPrimary: true, buttons: 1 }));
    }
    element.dispatchEvent(new MouseEvent("mouseover", common));
    element.dispatchEvent(new MouseEvent("mouseenter", common));
    element.dispatchEvent(new MouseEvent("mousedown", { ...common, buttons: 1 }));
    if (window.PointerEvent) {
      element.dispatchEvent(new PointerEvent("pointerup", { ...common, pointerId: 1, pointerType: "mouse", isPrimary: true }));
    }
    element.dispatchEvent(new MouseEvent("mouseup", common));
    element.click();
  }

  function sendRuntimeMessage(message) {
    return new Promise((resolve, reject) => {
      if (!chrome.runtime || !chrome.runtime.sendMessage) {
        reject(new Error("chrome.runtime.sendMessage is unavailable"));
        return;
      }
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(response);
      });
    });
  }

  async function cdp(method, params) {
    const response = await sendRuntimeMessage({ type: "FLOW_SKILL_CDP", method, params });
    if (!response || !response.ok) {
      throw new Error((response && response.error) || `CDP command failed: ${method}`);
    }
    return response.result;
  }

  async function trustedClick(element) {
    if (!visible(element)) {
      element.scrollIntoView({ block: "center", inline: "center" });
    }
    await sleep(100);
    const rect = element.getBoundingClientRect();
    const x = Math.round(rect.left + rect.width / 2);
    const y = Math.round(rect.top + rect.height / 2);
    await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });
    await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  }

  async function trustedInsertText(text) {
    await cdp("Input.insertText", { text });
  }

  function setNativeValue(element, value) {
    const prototype = Object.getPrototypeOf(element);
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
    if (descriptor && descriptor.set) {
      descriptor.set.call(element, value);
    } else {
      element.value = value;
    }
    element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function setEditableValue(element, value) {
    element.focus();
    if (element.isContentEditable) {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(element);
      selection.removeAllRanges();
      selection.addRange(range);

      element.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, inputType: "deleteContentBackward" }));
      document.execCommand("delete", false, null);

      const transfer = new DataTransfer();
      transfer.setData("text/plain", value);
      const pasteEvent = new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: transfer
      });
      element.dispatchEvent(pasteEvent);

      element.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, inputType: "insertText", data: value }));
      document.execCommand("insertText", false, value);
      if (!textOf(element).includes(value)) {
        element.textContent = value;
      }
      element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      return;
    }
    setNativeValue(element, value);
  }

  function dataUrlToFile(dataUrl, filename) {
    const match = String(dataUrl).match(/^data:([^;,]+)?(;base64)?,(.*)$/);
    if (!match) throw new Error("imageDataUrl must be a data URL");
    const mime = match[1] || "image/png";
    const isBase64 = Boolean(match[2]);
    const body = match[3] || "";
    const binary = isBase64 ? atob(body) : decodeURIComponent(body);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return new File([bytes], filename || `flow-input-${Date.now()}.${mime.split("/")[1] || "png"}`, { type: mime });
  }

  function candidateFileInputs() {
    return Array.from(document.querySelectorAll("input[type='file']")).filter((input) => {
      const accept = normalized(input.getAttribute("accept") || "");
      return !accept || accept.includes("image") || accept.includes("png") || accept.includes("jpeg") || accept.includes("jpg") || accept.includes("*");
    });
  }

  async function revealFileInput() {
    const direct = candidateFileInputs()[0];
    if (direct) return direct;

    const uploadButton = findByText(
      "button, [role='button'], div, span, a",
      [
        /upload/,
        /add image/,
        /image/,
        /frames?/,
        /ingredients?/,
        /上传/,
        /图片/,
        /素材/,
        /参考/
      ]
    );
    if (uploadButton) {
      log("Clicking possible image upload control", { text: textOf(uploadButton) });
      clickElement(uploadButton);
    }

    return waitFor(() => candidateFileInputs()[0], {
      timeoutMs: 10000,
      label: "Image file input"
    });
  }

  async function setImage(file) {
    const input = await revealFileInput();
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    log("Image file assigned", { name: file.name, type: file.type, size: file.size });

    await waitFor(() => {
      if (input.files && input.files.length > 0) return true;
      const images = Array.from(document.querySelectorAll("img")).filter(visible);
      const imageLike = findByText("button, [role='button'], div, span", [/remove image/, /replace image/, /鍒犻櫎鍥剧墖/, /鏇挎崲鍥剧墖/]);
      return images.length > 0 && imageLike;
    }, {
      timeoutMs: 12000,
      label: "Image upload acknowledgement"
    });
  }

  function findPromptInput() {
    const controls = Array.from(document.querySelectorAll("textarea, input[type='text'], [contenteditable='true'], [role='textbox']"));
    const scored = controls
      .filter((element) => visible(element))
      .map((element) => {
        const haystack = normalized([
          element.getAttribute("placeholder"),
          element.getAttribute("aria-label"),
          textOf(element)
        ].filter(Boolean).join(" "));
        let score = 0;
        const rect = element.getBoundingClientRect();
        const isSlate = element.hasAttribute("data-slate-editor") || element.querySelector("[data-slate-placeholder]");
        if (isSlate) score += 50;
        if (element.isContentEditable || element.getAttribute("role") === "textbox") score += 20;
        if (rect.y > window.innerHeight * 0.55) score += 15;
        if (element.matches("[data-testid='search-input']")) score -= 50;
        if (["可编辑文本"].includes(element.getAttribute("aria-label"))) score -= 40;
        if (/prompt|describe|create|生成|提示|描述/.test(haystack)) score += 5;
        score += Math.min(3, Math.floor(rect.width / 180));
        score += element.tagName === "TEXTAREA" ? 2 : 0;
        return { element, score };
      })
      .sort((a, b) => b.score - a.score);
    return scored[0] && scored[0].element;
  }

  async function setPrompt(prompt) {
    const input = await waitFor(findPromptInput, {
      timeoutMs: 15000,
      label: "Prompt input"
    });
    try {
      await trustedClick(input);
      await trustedInsertText(prompt);
    } catch (error) {
      log("Trusted text input failed; falling back to DOM input", { message: error.message });
      setEditableValue(input, prompt);
    }
    await waitFor(() => textOf(input).includes(prompt), {
      timeoutMs: 5000,
      label: "Prompt text acknowledgement"
    });
    log("Prompt filled", { length: prompt.length });
  }

  function findAddButton() {
    return Array.from(document.querySelectorAll("button"))
      .filter(visible)
      .find((button) => /add_2|娣诲姞|鍒涘缓/.test(textOf(button)) && button.getBoundingClientRect().y > window.innerHeight * 0.65);
  }

  async function attachMaterialToPrompt() {
    const textIncludes = (element, needles) => {
      const text = textOf(element);
      return needles.some((needle) => text.includes(needle));
    };
    const findVisible = (selectors, needles) => Array.from(document.querySelectorAll(selectors))
      .filter(visible)
      .find((element) => textIncludes(element, needles));
    const findVisibleButton = (needles) => findVisible("button, [role='button'], [role='tab']", needles);

    if (findVisibleButton(["清除提示", "clear prompt"])) {
      log("Material already appears attached");
      return;
    }

    const deadline = Date.now() + 25000;
    let lastError = "";
    while (Date.now() < deadline) {
      const addToPrompt = findVisibleButton(["添加到提示", "Add to prompt", "add to prompt"]);
      if (addToPrompt) {
        await trustedClick(addToPrompt);
        await sleep(1200);
        if (findVisibleButton(["清除提示", "clear prompt"]) || !findVisibleButton(["添加到提示", "Add to prompt", "add to prompt"])) {
          log("Attached material to prompt");
          return;
        }
      }

      const uploadedTab = findVisibleButton(["上传的内容", "Uploaded", "uploaded"]);
      if (uploadedTab) {
        clickElement(uploadedTab);
        await sleep(700);
        lastError = "clicked uploaded tab";
        continue;
      }

      const promptAdd = findAddButton();
      const topAdd = findVisibleButton(["添加媒体", "Add media", "add"]);
      const opener = promptAdd || topAdd;
      if (opener) {
        clickElement(opener);
        await sleep(900);
        lastError = "clicked media opener";
        continue;
      }

      lastError = "no opener or add-to-prompt button visible";
      await sleep(500);
    }

    throw new Error("Material attachment acknowledgement timed out: " + lastError);
  }
  async function chooseImageMode() {
    const mode = findByText(
      "button, [role='button'], [role='tab'], mat-button-toggle, div, span",
      [/image to video/, /image-to-video/, /frames? to video/, /鍥剧敓瑙嗛/, /鍥剧墖.*瑙嗛/, /绱犳潗.*瑙嗛/]
    );
    if (mode) {
      log("Clicking possible image-to-video mode", { text: textOf(mode) });
      clickElement(mode);
      await sleep(600);
    }
  }

  function findGenerateButton() {
    const buttons = Array.from(document.querySelectorAll("button, [role='button']"))
      .filter((element) => visible(element))
      .filter((element) => {
        const haystack = normalized([
          textOf(element),
          element.getAttribute("aria-label"),
          element.getAttribute("title")
        ].filter(Boolean).join(" "));
        if (/generate|create|submit|生成|开始/.test(haystack)) return true;
        if (/arrow_forward/.test(haystack)) return true;
        return false;
      })
      .filter((element) => !element.disabled && element.getAttribute("aria-disabled") !== "true");

    const bottomArrow = buttons.find((button) => {
      const rect = button.getBoundingClientRect();
      return /arrow_forward|鍒涘缓|generate|鐢熸垚/i.test(textOf(button)) && rect.y > window.innerHeight * 0.65;
    });
    if (bottomArrow) return bottomArrow;

    return buttons.sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width)[0];
  }

  async function clickGenerate() {
    const button = await waitFor(findGenerateButton, {
      timeoutMs: 30000,
      label: "Generate button"
    });
    log("Clicking generate", { text: textOf(button) });
    await trustedClick(button);
  }

  function collectVideoUrls() {
    const urls = new Set();
    const addVideo = (value) => {
      if (!value || typeof value !== "string") return;
      if (value.startsWith("blob:") || value.startsWith("data:video") || /\.(mp4|webm)(\?|#|$)/i.test(value) || /videoplayback|media\.getMediaUrlRedirect/i.test(value)) {
        urls.add(value);
      }
    };
    const addLink = (value) => {
      if (!value || typeof value !== "string") return;
      if (value.startsWith("blob:") || value.startsWith("data:video") || /\.(mp4|webm)(\?|#|$)/i.test(value) || /videoplayback|media\.getMediaUrlRedirect/i.test(value)) {
        urls.add(value);
      }
    };

    document.querySelectorAll("video").forEach((video) => {
      addVideo(video.currentSrc);
      addVideo(video.src);
      video.querySelectorAll("source").forEach((source) => addVideo(source.src));
    });
    document.querySelectorAll("a[href], source[src]").forEach((element) => {
      addLink(element.href || element.src);
    });
    return Array.from(urls);
  }

  async function clickPlayableCardsForUrls() {
    const cards = Array.from(document.querySelectorAll("[role='button'], button"))
      .filter(visible)
      .filter((element) => /play_circle|鎾斁|瑙傜湅瑙嗛|video/i.test(textOf(element)))
      .sort((a, b) => a.getBoundingClientRect().x - b.getBoundingClientRect().x);
    for (const card of cards.slice(0, 8)) {
      const before = collectVideoUrls();
      clickElement(card);
      await sleep(1200);
      const after = collectVideoUrls();
      if (after.length > before.length || after.length > 0) return after;
    }
    return collectVideoUrls();
  }

  async function collectVideoUrlsDeep() {
    const urls = new Set(collectVideoUrls());
    const scrollables = Array.from(document.querySelectorAll("div, main, section"))
      .filter((element) => {
        const style = getComputedStyle(element);
        return element.scrollHeight > element.clientHeight + 100 &&
          element.clientHeight > 200 &&
          ["auto", "scroll"].includes(style.overflowY);
      })
      .sort((a, b) => (b.clientHeight * b.clientWidth) - (a.clientHeight * a.clientWidth));
    const scrollElement = scrollables[0] || document.scrollingElement || document.documentElement;
    const originalTop = scrollElement.scrollTop;
    const maxTop = scrollElement.scrollHeight;
    const step = Math.max(250, Math.floor(scrollElement.clientHeight * 0.7));

    for (let top = 0; top <= maxTop + step; top += step) {
      scrollElement.scrollTop = top;
      await sleep(150);
      collectVideoUrls().forEach((url) => urls.add(url));
    }
    scrollElement.scrollTop = originalTop;
    await sleep(100);
    if (urls.size === 0) {
      (await clickPlayableCardsForUrls()).forEach((url) => urls.add(url));
    }
    return Array.from(urls);
  }

  async function blobUrlToDataUrl(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Blob fetch failed: HTTP ${response.status}`);
    const blob = await response.blob();
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error("Blob read failed"));
      reader.readAsDataURL(blob);
    });
  }

  async function downloadUrl(url, filename) {
    if (url.startsWith("blob:")) {
      const dataUrl = await blobUrlToDataUrl(url);
      return sendRuntimeMessage({ type: "FLOW_SKILL_DOWNLOAD_DATA_URL", dataUrl, filename });
    }
    return sendRuntimeMessage({ type: "FLOW_SKILL_DOWNLOAD_VIDEO", url, filename });
  }

  async function waitAndDownload(command) {
    const before = new Set(command.includeExisting ? [] : (command.beforeUrls || await collectVideoUrlsDeep()));
    const timeoutMs = command.timeoutMs || 30 * 60 * 1000;
    const intervalMs = command.intervalMs || 5000;
    const count = command.count || 1;
    const folder = (command.folder || "FlowSkillBridge").replace(/[\\:*?"<>|]+/g, "_");
    const prefix = (command.prefix || "flow_material").replace(/[\\/:*?"<>|]+/g, "_");
    const downloaded = [];
    const started = Date.now();

    log("Waiting for generated video", { timeoutMs, count });
    while (Date.now() - started < timeoutMs) {
      const urls = (await collectVideoUrlsDeep()).filter((url) => !before.has(url));
      for (const url of urls) {
        if (downloaded.some((item) => item.url === url)) continue;
        const filename = `${folder}/${prefix}_${String(downloaded.length + 1).padStart(3, "0")}.mp4`;
        const response = await downloadUrl(url, filename);
        downloaded.push({ url, filename, response });
        log("Queued video download", { filename, url });
        if (downloaded.length >= count) {
          return { ok: true, downloaded };
        }
      }
      await sleep(intervalMs);
    }

    throw new Error(`Timed out waiting for ${count} generated video(s); downloaded ${downloaded.length}`);
  }

  async function runGenerateVideo(command) {
    if (state.busy) throw new Error("Flow Skill Bridge is already running a command");
    state.busy = true;
    state.lastError = null;
    state.lastResult = null;

    try {
      const prompt = String(command.prompt || "").trim();
      if (!prompt) throw new Error("prompt is required");
      if (!command.imageDataUrl) throw new Error("imageDataUrl is required for image-to-video");

      log("Starting image-to-video command");
      await chooseImageMode();
      await setImage(dataUrlToFile(command.imageDataUrl, command.filename));
      await attachMaterialToPrompt();
      await setPrompt(prompt);

      if (command.autoGenerate !== false) {
        await clickGenerate();
      }

      state.lastResult = { ok: true, autoGenerate: command.autoGenerate !== false };
      window.postMessage({ source: SOURCE, type: "result", requestId: command.requestId, result: state.lastResult }, "*");
      log("Command completed", state.lastResult);
    } catch (error) {
      state.lastError = { message: error.message, stack: error.stack };
      window.postMessage({ source: SOURCE, type: "error", requestId: command.requestId, error: state.lastError }, "*");
      log("Command failed", state.lastError);
      throw error;
    } finally {
      state.busy = false;
    }
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const message = event.data || {};
    if (message.source !== SOURCE) return;

    if (message.type === "get-status") {
      window.postMessage({
        source: SOURCE,
        type: "status-response",
        requestId: message.requestId,
        state
      }, "*");
      return;
    }

    if (message.type === "generate-video") {
      runGenerateVideo(message).catch(() => {});
    }

    if (message.type === "wait-and-download") {
      waitAndDownload(message)
        .then((result) => {
          state.lastResult = result;
          window.postMessage({ source: SOURCE, type: "result", requestId: message.requestId, result }, "*");
        })
        .catch((error) => {
          state.lastError = { message: error.message, stack: error.stack };
          window.postMessage({ source: SOURCE, type: "error", requestId: message.requestId, error: state.lastError }, "*");
        });
    }
  });

  window.postMessage({ source: SOURCE, type: "ready" }, "*");
  log("Ready");
})();
