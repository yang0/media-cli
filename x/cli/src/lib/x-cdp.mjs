/** Minimal Chrome DevTools Protocol client for the X capture command. */
export async function connectCdp({ port = 9221, fetchImpl = fetch, WebSocketImpl = globalThis.WebSocket } = {}) {
  const endpoint = `http://127.0.0.1:${port}`;
  const version = await fetchImpl(`${endpoint}/json/version`, { signal: AbortSignal.timeout(5000) })
    .then((response) => response.ok ? response.json() : null)
    .catch(() => null);
  if (!version?.webSocketDebuggerUrl) {
    throw new Error(`无法连接 Chrome CDP (${endpoint})，请确保 Chrome 已开启远程调试端口 ${port}`);
  }
  if (!WebSocketImpl) throw new Error("当前 Node.js 不提供 WebSocket，请使用 Node.js 22+ 或配置兼容 WebSocket");

  const ws = new WebSocketImpl(version.webSocketDebuggerUrl);
  let nextId = 1;
  const pending = new Map();
  const failPending = (error) => {
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
  };
  ws.onmessage = (event) => {
    const data = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
    if (!data.id || !pending.has(data.id)) return;
    const { resolve, reject } = pending.get(data.id);
    pending.delete(data.id);
    if (data.error) reject(new Error(data.error.message || `CDP error ${data.error.code || ""}`));
    else resolve(data.result);
  };
  ws.onerror = () => failPending(new Error("Chrome CDP WebSocket 连接失败"));
  ws.onclose = () => failPending(new Error("Chrome CDP WebSocket 已关闭"));
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Chrome CDP WebSocket 连接超时")), 5000);
    ws.onopen = () => { clearTimeout(timeout); resolve(); };
    ws.onerror = () => { clearTimeout(timeout); reject(new Error("Chrome CDP WebSocket 连接失败")); };
  });

  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    try { ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); }
    catch (error) { pending.delete(id); reject(error); }
  });

  return {
    send,
    close() { try { ws.close(); } catch {} },
  };
}
