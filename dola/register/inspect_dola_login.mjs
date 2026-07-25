const CDP = process.env.CDP || "http://127.0.0.1:9223";
const origin = new URL(CDP).origin;

async function main() {
  const list = await fetch(`${origin}/json/list`).then((r) => r.json());
  console.log(
    "tabs",
    list.map((t) => ({ type: t.type, url: t.url })).filter((t) => t.type === "page")
  );
  let page = list.find((t) => t.type === "page" && /dola\.com/i.test(t.url || ""));
  if (!page) {
    const created = await fetch(`${origin}/json/new?${encodeURIComponent("https://www.dola.com/")}`, {
      method: "PUT",
    })
      .then((r) => r.json())
      .catch(async () =>
        fetch(`${origin}/json/new?${encodeURIComponent("https://www.dola.com/")}`).then((r) => r.json())
      );
    console.log("created", created);
    await new Promise((r) => setTimeout(r, 3500));
    const list2 = await fetch(`${origin}/json/list`).then((r) => r.json());
    page = list2.find((t) => t.id === created.id) || list2.find((t) => t.type === "page" && /dola\.com/i.test(t.url || ""));
  }
  if (!page?.webSocketDebuggerUrl) throw new Error("no page websocket");

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener("open", res);
    ws.addEventListener("error", (e) => rej(e.error || e));
  });
  console.log("ws open", page.url);

  let id = 0;
  const pending = new Map();
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(String(ev.data));
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const mid = ++id;
      pending.set(mid, { resolve, reject });
      ws.send(JSON.stringify({ id: mid, method, params }));
      setTimeout(() => {
        if (pending.has(mid)) {
          pending.delete(mid);
          reject(new Error("timeout " + method));
        }
      }, 30000);
    });
  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || "eval fail");
    return r.result?.value;
  };

  await send("Runtime.enable");
  await send("Page.enable");
  await send("Page.bringToFront").catch(() => {});
  await send("Page.navigate", { url: "https://www.dola.com/" });
  await new Promise((r) => setTimeout(r, 4000));

  const home = await evaluate(`({
    url: location.href,
    title: document.title,
    text: (document.body && document.body.innerText || '').slice(0, 2000)
  })`);
  console.log("HOME", JSON.stringify(home, null, 2));

  // click login-like controls
  const click = await evaluate(`(() => {
    const labels = ['登录','注册','Log in','Login','Sign in','Sign up','Create account'];
    const plain = el => (el.innerText || el.textContent || el.getAttribute('aria-label') || '').replace(/\\s+/g,' ').trim();
    const visible = el => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
    };
    const nodes = Array.from(document.querySelectorAll('button,a,[role=button],div,span')).filter(visible);
    const hits = nodes.map(el => {
      const t = plain(el);
      let score = 0;
      if (labels.some(l => t === l)) score += 100;
      else if (labels.some(l => t.includes(l))) score += 50;
      if (t.length <= 12) score += 10;
      if (el.getBoundingClientRect().y < 120) score += 20;
      return { el, t, score };
    }).filter(x => x.score > 0).sort((a,b) => b.score - a.score);
    if (!hits[0]) return { ok:false, candidates: nodes.slice(0,20).map(n => plain(n)).filter(Boolean).slice(0,30) };
    hits[0].el.click();
    return { ok:true, text: hits[0].t, score: hits[0].score };
  })()`);
  console.log("CLICK", click);
  await new Promise((r) => setTimeout(r, 3000));

  const after = await evaluate(`(() => {
    const plain = el => (el.innerText || el.textContent || el.getAttribute('aria-label') || '').replace(/\\s+/g,' ').trim();
    const visible = el => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
    };
    return {
      url: location.href,
      title: document.title,
      buttons: Array.from(document.querySelectorAll('button,a,[role=button],div,span')).filter(visible)
        .map(el => plain(el)).filter(t => t && t.length <= 40)
        .filter(t => /Google|Apple|邮箱|email|手机|phone|登录|注册|继续|验证|GitHub|Microsoft|sign|log/i.test(t))
        .slice(0, 60),
      inputs: Array.from(document.querySelectorAll('input,textarea')).filter(visible).map(el => ({
        type: el.type || '', name: el.name || '', id: el.id || '', ph: el.placeholder || '', aria: el.getAttribute('aria-label') || ''
      })),
      text: (document.body.innerText || '').slice(0, 2500),
    };
  })()`);
  console.log("AFTER_LOGIN_CLICK", JSON.stringify(after, null, 2));

  // Try known login urls on dola / bytedance passport
  for (const url of [
    "https://www.dola.com/login",
    "https://www.dola.com/sign-up",
    "https://www.dola.com/passport/",
  ]) {
    await send("Page.navigate", { url });
    await new Promise((r) => setTimeout(r, 3000));
    const s = await evaluate(`({
      url: location.href,
      title: document.title,
      text: (document.body && document.body.innerText || '').slice(0, 1200),
      inputs: Array.from(document.querySelectorAll('input')).slice(0,20).map(i => ({type:i.type,name:i.name,ph:i.placeholder}))
    })`);
    console.log("NAV", url, "=>", JSON.stringify(s, null, 2));
  }

  ws.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
