import { DEFAULT_CDP } from "./config.mjs";

/**
 * 通过 CDP 9221 连接已登录的 Chrome 发送推文回复
 */
export async function sendReplyViaCdp({ tweetUrl, replyText, port = 9221 }) {
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

    // 等待页面加载
    await new Promise((r) => setTimeout(r, 6000));

    // 定位回复输入框
    const typeResult = await send("Runtime.evaluate", {
      expression: `(async () => {
        const editor = document.querySelector('div[role="textbox"][data-testid="tweetTextarea_0"]') ||
                       document.querySelector('div[contenteditable="true"]');
        if (!editor) return { success: false, error: "未找到回复输入框，可能未登录或推文已限制回复" };

        editor.focus();
        // 模拟真实输入
        document.execCommand('insertText', false, ${JSON.stringify(replyText)});
        await new Promise(r => setTimeout(r, 1000));

        // 查找并点击回复发送按钮
        const replyBtn = document.querySelector('button[data-testid="tweetButtonInline"]') ||
                         document.querySelector('button[data-testid="tweetButton"]');
        if (!replyBtn) return { success: false, error: "未找到发送回复按钮" };

        if (replyBtn.disabled) return { success: false, error: "回复按钮为禁用状态" };

        replyBtn.click();
        await new Promise(r => setTimeout(r, 3000));

        return { success: true };
      })()`,
      awaitPromise: true,
      returnByValue: true
    }, sessionId);

    const res = typeResult?.result?.value;
    if (!res?.success) {
      throw new Error(res?.error || "发送回复失败");
    }

    return { success: true };
  } finally {
    await send("Target.closeTarget", { targetId }).catch(() => {});
    ws.close();
  }
}
