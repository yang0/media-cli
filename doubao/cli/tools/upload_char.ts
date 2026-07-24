#!/usr/bin/env bun
/**
 * Upload character reference image to Doubao session
 * Usage: bun upload_char.ts <session_url>
 * 
 * Uses the 'ws' library (same as doubao-img) for CDP WebSocket connection.
 */

import WebSocket from "ws";

const CDP = "http://127.0.0.1:9222";
const AVATAR = "E:/projectHome/huobijueqi/主角三视图.png";
const SESSION = process.argv[2] || "https://www.doubao.com/chat/38434161979461378";

async function findPage(client) {
  const pages = await (await fetch(`${CDP}/json`)).json();
  const url = SESSION.includes("/chat/") ? SESSION.split("/chat/")[1] : SESSION;
  const page = pages.find((p) => p.url.includes(url) || p.url.includes("doubao.com/chat"));
  if (!page) throw new Error(`Session not found: ${SESSION}`);
  return page;
}

async function main() {
  console.log(`[upload] 连接 CDP ${CDP}`);
  const page = await findPage();
  console.log(`[upload] 会话: ${page.url.slice(0, 60)}...`);

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const id = Math.random();
      ws.send(JSON.stringify({ id, method, params }));
      ws.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.id === id) resolve(msg.result);
      });
    });

  await new Promise((resolve, reject) => {
    ws.on("open", resolve);
    ws.on("error", (err) => reject(new Error(`WebSocket: ${err.message}`)));
    setTimeout(() => reject(new Error("WebSocket timeout")), 10000);
  });
  await send("Page.enable");
  await send("DOM.enable");
  await send("Runtime.enable");

  // Step 1: Get document root
  const doc = await send("DOM.getDocument", { depth: -1, pierce: true });
  const rootId = doc.root.nodeId;

  // Step 2: Try multiple selectors for file input
  const selectors = [
    "input[type=file]",
    "input[accept*=image]",
    "div[class*=upload] input",
    "div[class*=attach] input",
    ".upload-input input",
    "[class*=file-input] input",
  ];

  let inputNodeId = null;
  let usedSelector = "";
  for (const sel of selectors) {
    const result = await send("DOM.querySelector", { nodeId: rootId, selector: sel });
    if (result.nodeId) {
      inputNodeId = result.nodeId;
      usedSelector = sel;
      break;
    }
  }

  if (!inputNodeId) {
    // Step 3: Fallback - walk the DOM to find any input[type=file]
    const walkResult = await send("Runtime.evaluate", {
      expression: `(() => {
        const all = document.querySelectorAll('input[type=file]');
        return all.length > 0 ? 'found:' + all.length : 'not-found';
      })()`,
    });
    console.log(`[upload] DOM 扫描: ${walkResult.result.value}`);

    // Try one more time with fresh DOM
    const retry = await send("DOM.querySelector", { nodeId: rootId, selector: "input[type=file]" });
    if (retry.nodeId) {
      inputNodeId = retry.nodeId;
      usedSelector = "input[type=file] (retry)";
    } else {
      throw new Error("❌ 找不到文件上传控件，请在豆包页面手动上传");
    }
  }

  console.log(`[upload] 找到上传控件: ${usedSelector}`);

  // Step 4: Set the file
  await send("DOM.setFileInputFiles", { nodeId: inputNodeId, files: [AVATAR] });
  console.log(`[upload] 已设置文件: 主角三视图.png`);

  // Step 5: Wait for upload to register on page
  await new Promise((r) => setTimeout(r, 3000));

  // Step 6: Verify upload appeared
  const verify = await send("Runtime.evaluate", {
    expression: `(() => {
      const body = document.body.innerText;
      const hasFileName = body.includes('主角三视图') || body.includes('.png');
      const hasUploading = /上传中|正在上传|uploading/i.test(body);
      return JSON.stringify({ hasFileName, hasUploading });
    })()`,
  });

  const status = JSON.parse(verify.result.value);
  if (status.hasFileName) {
    console.log(`[upload] ✅ 上传成功: 主角三视图.png 已在页面中检测到`);
  } else if (status.hasUploading) {
    console.log(`[upload] ⏳ 文件上传中，请稍候...`);
    await new Promise((r) => setTimeout(r, 5000));
  } else {
    console.log(`[upload] ⚠️ 文件已设置但未在页面文本中检测到，继续...`);
  }

  ws.close();
  console.log(`[upload] 完成`);
}

main().catch((err) => {
  console.error(`[upload] ❌ ${err.message}`);
  console.error(`        请手动上传: 打开豆包 → 上传主角三视图.png`);
  process.exit(1);
});
