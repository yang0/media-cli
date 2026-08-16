import { DEFAULT_CDP } from "./config.mjs";

/**
 * 通过 CDP 9221 连接已登录的 Chrome，将回复保存到 X.com 官方网页未发送草稿箱 (Unsent Posts/Drafts)
 */
export async function saveReplyToXOnlineDraft({ tweetUrl, replyText, port = 9221 }) {
  const cdpUrl = `http://127.0.0.1:${port}`;
  const versionResp = await fetch(`${cdpUrl}/json/version`, { signal: AbortSignal.timeout(5000) })
    .then(r => r.json())
    .catch(() => null);

  if (!versionResp?.webSocketDebuggerUrl) {
    throw new Error(`无法连接 Chrome CDP (${cdpUrl})，请确保 Chrome 已开启远程调试端口 ${port}`);
  }

  const ws = new WebSocket(versionResp.webSocketDebuggerUrl);
  let msgId = 1;
  const pending = new Map();

  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);
    if (data.id && pending.has(data.id)) {
      const { resolve, reject } = pending.get(data.id);
      pending.delete(data.id);
      if (data.error) reject(data.error);
      else resolve(data.result);
    }
  };

  function send(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const id = msgId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }

  await new Promise((r, j) => {
    ws.onopen = r;
    ws.onerror = j;
  });

  const { targetId } = await send("Target.createTarget", { url: tweetUrl });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });

  try {
    await send("Page.enable", {}, sessionId);
    await send("Runtime.enable", {}, sessionId);

    // 等待推文页面加载完成
    await new Promise((r) => setTimeout(r, 6000));

    // 1. 点击主推文上的回复按钮打开弹窗
    const clickReplyRes = await send("Runtime.evaluate", {
      expression: `(() => {
        const tweet = document.querySelector('article[data-testid="tweet"]') || document.querySelector('article');
        const replyBtn = tweet ? tweet.querySelector('button[data-testid="reply"], div[data-testid="reply"]') : document.querySelector('div[data-testid="reply"]');
        if (replyBtn) {
          replyBtn.click();
          return { clicked: true };
        }
        return { clicked: false };
      })()`,
      returnByValue: true
    }, sessionId);

    await new Promise((r) => setTimeout(r, 2000));

    // 2. 聚焦输入框并输入回复文本
    const typeRes = await send("Runtime.evaluate", {
      expression: `(() => {
        const editor = document.querySelector('div[role="dialog"] div[role="textbox"]') ||
                       document.querySelector('div[role="textbox"][data-testid="tweetTextarea_0"]') ||
                       document.querySelector('div[contenteditable="true"]');
        if (!editor) return { success: false, error: "未找到回复输入框" };
        editor.focus();
        document.execCommand("insertText", false, ${JSON.stringify(replyText)});
        return { success: true };
      })()`,
      returnByValue: true
    }, sessionId);

    if (!typeRes?.result?.value?.success) {
      throw new Error(typeRes?.result?.value?.error || "输入回复文本失败");
    }

    await new Promise((r) => setTimeout(r, 1500));

    // 3. 尝试点击关闭按钮，并发送 Escape 键触发“保存草稿”确认框
    await send("Runtime.evaluate", {
      expression: `(() => {
        const closeBtn = document.querySelector('div[role="dialog"] div[data-testid="app-bar-close"]') ||
                         document.querySelector('div[data-testid="app-bar-close"]');
        if (closeBtn) closeBtn.click();
      })()`
    }, sessionId);

    // 备用触发：发送 Escape 键盘事件
    await send("Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      windowsVirtualKeyCode: 27,
      code: "Escape",
      key: "Escape"
    }, sessionId);
    await send("Input.dispatchKeyEvent", {
      type: "keyUp",
      windowsVirtualKeyCode: 27,
      code: "Escape",
      key: "Escape"
    }, sessionId);

    await new Promise((r) => setTimeout(r, 1500));

    // 4. 点击“保存 / Save”确认按钮
    const confirmRes = await send("Runtime.evaluate", {
      expression: `(() => {
        const saveBtn = document.querySelector('button[data-testid="confirmationSheetConfirm"], div[data-testid="confirmationSheetConfirm"]') ||
                        Array.from(document.querySelectorAll('button, div[role="button"]')).find(b => b.innerText === '保存' || b.innerText === 'Save');
        if (saveBtn) {
          saveBtn.click();
          return { success: true };
        }
        return { success: false, error: "未找到确认保存草稿按钮" };
      })()`,
      returnByValue: true
    }, sessionId);

    if (!confirmRes?.result?.value?.success) {
      throw new Error(confirmRes?.result?.value?.error || "确认保存草稿失败");
    }

    await new Promise((r) => setTimeout(r, 2000));
    return { success: true };
  } finally {
    await send("Target.closeTarget", { targetId }).catch(() => {});
    ws.close();
  }
}
