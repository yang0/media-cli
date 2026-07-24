const pendingNames = new Map();
const attachedTabs = new Set();

function debuggerTarget(tabId) {
  return { tabId };
}

async function ensureDebugger(tabId) {
  if (attachedTabs.has(tabId)) return;
  await new Promise((resolve, reject) => {
    chrome.debugger.attach(debuggerTarget(tabId), "1.3", () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      attachedTabs.add(tabId);
      resolve();
    });
  });
}

async function sendDebuggerCommand(tabId, method, params) {
  await new Promise((resolve) => {
    chrome.tabs.update(tabId, { active: true }, () => resolve());
  });
  await ensureDebugger(tabId);
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand(debuggerTarget(tabId), method, params || {}, (result) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(result || {});
    });
  });
}

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId) attachedTabs.delete(source.tabId);
});

function downloadVideo(url, filename) {
  return new Promise((resolve, reject) => {
    chrome.downloads.download({
      url,
      filename,
      conflictAction: "uniquify"
    }, (downloadId) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!downloadId) {
        reject(new Error("No download id returned"));
        return;
      }
      pendingNames.set(downloadId, filename);
      resolve(downloadId);
    });
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.type === "FLOW_SKILL_CDP") {
    const tabId = sender.tab && sender.tab.id;
    if (!tabId) {
      sendResponse({ ok: false, error: "No sender tab id" });
      return true;
    }
    sendDebuggerCommand(tabId, message.method, message.params)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message && message.type === "FLOW_SKILL_DOWNLOAD_VIDEO") {
    downloadVideo(message.url, message.filename || `FlowSkillBridge/flow_${Date.now()}.mp4`)
      .then((downloadId) => sendResponse({ ok: true, downloadId }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message && message.type === "FLOW_SKILL_DOWNLOAD_DATA_URL") {
    downloadVideo(message.dataUrl, message.filename || `FlowSkillBridge/flow_${Date.now()}.mp4`)
      .then((downloadId) => sendResponse({ ok: true, downloadId }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
});
