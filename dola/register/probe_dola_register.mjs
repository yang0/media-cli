/**
 * Probe whether dola.com auto-registration is feasible via CDP + MailNest temp email.
 * Usage:
 *   node probe_dola_register.mjs --cdp http://127.0.0.1:9223 --email someone@outlook.com
 *   node probe_dola_register.mjs --cdp http://127.0.0.1:9223 --buy-mailnest
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, "probe-out");
mkdirSync(OUT_DIR, { recursive: true });

function parseArgs(argv) {
  const args = { cdp: "http://127.0.0.1:9223" };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    const v = () => {
      const n = argv[++i];
      if (!n) throw new Error(`Missing value for ${a}`);
      return n;
    };
    if (a === "--cdp") args.cdp = v();
    else if (a === "--email") args.email = v();
    else if (a === "--buy-mailnest") args.buyMailnest = true;
    else if (a === "--mailnest-key") args.mailnestKey = v();
    else if (a === "--project") args.project = v();
    else if (a === "--config") args.config = v();
    else throw new Error(`Unknown arg ${a}`);
  }
  return args;
}

async function cdpList(cdp) {
  return fetch(`${new URL(cdp).origin}/json/list`).then((r) => r.json());
}

async function cdpNew(cdp, url) {
  const u = `${new URL(cdp).origin}/json/new?${encodeURIComponent(url)}`;
  try {
    return await fetch(u, { method: "PUT" }).then((r) => r.json());
  } catch {
    return fetch(u).then((r) => r.json());
  }
}

class Cdp {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.id = 0;
    this.pending = new Map();
  }
  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((res, rej) => {
      this.ws.addEventListener("open", res);
      this.ws.addEventListener("error", rej);
    });
    this.ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`timeout ${method}`));
        }
      }, 60000);
    });
  }
  async evaluate(expression, awaitPromise = true) {
    const r = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise,
      returnByValue: true,
      userGesture: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || "evaluate failed");
    return r.result?.value;
  }
  close() {
    try {
      this.ws.close();
    } catch {}
  }
}

async function buyMailnest(apiKey, projectCode = "google001") {
  const resp = await fetch("https://mailnest.top/api/v1/email/temporary/buy", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ project_code: projectCode, count: 1 }),
  });
  const j = await resp.json();
  if (String(j.code) !== "00000") throw new Error(`MailNest buy failed: ${JSON.stringify(j)}`);
  const row = (j.data || [])[0];
  if (!row?.email) throw new Error(`MailNest no email: ${JSON.stringify(j)}`);
  return row;
}

async function receiveMailnest(apiKey, email) {
  const resp = await fetch("https://mailnest.top/api/v1/email/receive", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ email }),
  });
  const j = await resp.json();
  if (String(j.code) !== "00000") throw new Error(`MailNest receive failed: ${JSON.stringify(j)}`);
  return j.data || [];
}

function extractCode(text) {
  const s = String(text || "");
  const patterns = [
    /(?:验证码|verification code|code is|code[:\s])[^\d]{0,12}(\d{4,8})/i,
    /\b(\d{6})\b/,
    /\b(\d{4})\b/,
  ];
  for (const p of patterns) {
    const m = p.exec(s);
    if (m) return m[1];
  }
  return "";
}

async function snapshot(client) {
  return client.evaluate(`(() => {
    const visible = el => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
    };
    const text = el => (el.innerText || el.textContent || el.getAttribute('aria-label') || el.title || '').replace(/\\s+/g,' ').trim();
    const buttons = Array.from(document.querySelectorAll('button, a, [role=button], div, span'))
      .filter(visible)
      .map(el => ({ t: text(el).slice(0,80), tag: el.tagName, y: Math.round(el.getBoundingClientRect().y) }))
      .filter(b => b.t && b.t.length <= 40)
      .filter(b => /登录|注册|Google|邮箱|email|sign|log.?in|continue|下一步|验证|手机|Apple|GitHub|继续|创建/i.test(b.t))
      .slice(0, 80);
    const inputs = Array.from(document.querySelectorAll('input, textarea, [contenteditable=true]'))
      .filter(visible)
      .map(el => ({
        type: el.getAttribute('type') || '',
        name: el.getAttribute('name') || '',
        placeholder: el.getAttribute('placeholder') || '',
        aria: el.getAttribute('aria-label') || '',
        id: el.id || '',
        y: Math.round(el.getBoundingClientRect().y),
      })).slice(0, 40);
    return {
      url: location.href,
      title: document.title,
      buttons,
      inputs,
      tail: (document.body.innerText || '').slice(0, 2500),
    };
  })()`);
}

async function clickText(client, labels) {
  return client.evaluate(`(() => {
    const labels = ${JSON.stringify(labels)};
    const plain = el => (el.innerText || el.textContent || el.getAttribute('aria-label') || '').replace(/\\s+/g,' ').trim();
    const visible = el => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
    };
    const nodes = Array.from(document.querySelectorAll('button, a, [role=button], div, span')).filter(visible);
    const el = nodes
      .filter(n => {
        const t = plain(n);
        return labels.some(l => t === l || t.includes(l)) && t.length <= 40;
      })
      .sort((a,b) => {
        const ar=a.getBoundingClientRect(), br=b.getBoundingClientRect();
        return (br.width*br.height)-(ar.width*ar.height);
      })[0];
    if (!el) return { ok:false };
    el.click();
    return { ok:true, text: plain(el) };
  })()`);
}

async function typeInto(client, selectorOrPlaceholder, value) {
  return client.evaluate(`(() => {
    const value = ${JSON.stringify(value)};
    const hint = ${JSON.stringify(selectorOrPlaceholder)};
    const visible = el => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
    };
    let el = null;
    try { el = document.querySelector(hint); } catch {}
    if (!el) {
      el = Array.from(document.querySelectorAll('input, textarea')).filter(visible).find(i => {
        const bag = [i.type,i.name,i.id,i.placeholder,i.getAttribute('aria-label')].join(' ').toLowerCase();
        return bag.includes(String(hint).toLowerCase()) || /email|mail|邮箱/.test(bag);
      });
    }
    if (!el) return { ok:false };
    el.focus();
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    setter?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles:true }));
    el.dispatchEvent(new Event('change', { bubbles:true }));
    return { ok:true, tag: el.tagName, type: el.type||'', name: el.name||'', placeholder: el.placeholder||'' };
  })()`);
}

async function main() {
  const args = parseArgs(process.argv);
  let email = args.email || "";
  let mailnestKey = args.mailnestKey || "";
  let project = args.project || "google001";
  if (args.config || args.buyMailnest) {
    const cfgPath = args.config || "E:/openProject/grokRegister-cpa/config.json";
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
    mailnestKey = mailnestKey || cfg.mailnest_api_key || "";
  }
  let mailMeta = null;
  if (args.buyMailnest) {
    mailMeta = await buyMailnest(mailnestKey, project);
    email = mailMeta.email;
    console.log("[probe] bought mailnest email:", email, "project=", project);
  }
  if (!email) throw new Error("Need --email or --buy-mailnest");

  const report = {
    startedAt: new Date().toISOString(),
    cdp: args.cdp,
    email,
    mailMeta,
    steps: [],
  };
  const log = (msg, data) => {
    console.log(msg, data ? JSON.stringify(data).slice(0, 500) : "");
    report.steps.push({ t: new Date().toISOString(), msg, data: data || null });
  };

  // Prefer existing dola tab, else open new.
  let list = await cdpList(args.cdp);
  let target = list.find((t) => t.type === "page" && /dola\.com/i.test(t.url || ""));
  if (!target) {
    target = await cdpNew(args.cdp, "https://www.dola.com/");
    await new Promise((r) => setTimeout(r, 3000));
    list = await cdpList(args.cdp);
    target = list.find((t) => t.id === target.id) || list.find((t) => t.type === "page" && /dola\.com/i.test(t.url || ""));
  }
  if (!target?.webSocketDebuggerUrl) throw new Error("No CDP page target");
  log("target", { url: target.url, id: target.id });

  const client = new Cdp(target.webSocketDebuggerUrl);
  await client.connect();
  await client.send("Runtime.enable");
  await client.send("Page.enable");
  await client.send("Network.enable");
  await client.send("Page.bringToFront").catch(() => {});

  // Navigate home then look for login/signup
  await client.send("Page.navigate", { url: "https://www.dola.com/" });
  await new Promise((r) => setTimeout(r, 4000));
  let snap = await snapshot(client);
  log("home", { url: snap.url, title: snap.title, buttons: snap.buttons, inputs: snap.inputs });
  writeFileSync(path.join(OUT_DIR, "01-home.json"), JSON.stringify(snap, null, 2));

  // Try common login entry points
  const loginClicks = [
    ["登录", "Log in", "Login", "Sign in"],
    ["注册", "Sign up", "Signup", "Create account"],
  ];
  for (const labels of loginClicks) {
    const r = await clickText(client, labels);
    if (r?.ok) {
      log("clicked", r);
      await new Promise((x) => setTimeout(x, 2500));
      snap = await snapshot(client);
      log("after-click", { url: snap.url, title: snap.title, buttons: snap.buttons, inputs: snap.inputs, tail: snap.tail?.slice(0, 500) });
      writeFileSync(path.join(OUT_DIR, `02-after-${labels[0]}.json`), JSON.stringify(snap, null, 2));
      break;
    }
  }

  // Also try known passport / login URLs
  const candidates = [
    "https://www.dola.com/login",
    "https://www.dola.com/sign-up",
    "https://www.dola.com/signup",
    "https://www.dola.com/register",
    "https://www.dola.com/passport/web/login",
  ];
  for (const url of candidates) {
    try {
      await client.send("Page.navigate", { url });
      await new Promise((r) => setTimeout(r, 2500));
      snap = await snapshot(client);
      log("nav", { tried: url, landed: snap.url, title: snap.title, buttons: snap.buttons?.slice(0, 20), inputs: snap.inputs });
      writeFileSync(path.join(OUT_DIR, `nav-${url.replace(/[^\w]+/g, "_")}.json`), JSON.stringify(snap, null, 2));
      if (snap.inputs?.length || /login|sign|passport|注册|登录/i.test(snap.url + snap.title + (snap.tail || ""))) {
        break;
      }
    } catch (e) {
      log("nav-error", { url, error: e.message });
    }
  }

  // Attempt email fill if email input visible
  const typed = await typeInto(client, "email", email);
  log("type-email", typed);
  if (typed?.ok) {
    await clickText(client, ["继续", "下一步", "Next", "Continue", "发送", "获取验证码", "Send code", "验证"]);
    await new Promise((r) => setTimeout(r, 2000));
    snap = await snapshot(client);
    log("after-email-submit", { url: snap.url, buttons: snap.buttons, inputs: snap.inputs, tail: snap.tail?.slice(0, 800) });
    writeFileSync(path.join(OUT_DIR, "03-after-email.json"), JSON.stringify(snap, null, 2));
  }

  // Poll mailnest briefly for any mail (if key available)
  if (mailnestKey) {
    const mails = [];
    for (let i = 0; i < 8; i += 1) {
      try {
        const batch = await receiveMailnest(mailnestKey, email);
        for (const m of batch) mails.push(m);
        if (batch.length) break;
      } catch (e) {
        log("mail-poll-error", { error: e.message });
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
    const codes = mails.map((m) => ({
      subject: m.subject,
      preview: (m.body_preview || m.text || m.body || "").slice(0, 200),
      code: extractCode(`${m.subject || ""}\n${m.body_preview || m.text || m.body || ""}`),
    }));
    log("mails", { count: mails.length, codes });
    writeFileSync(path.join(OUT_DIR, "04-mails.json"), JSON.stringify({ email, mails, codes }, null, 2));
  }

  // Final snapshot
  snap = await snapshot(client);
  report.final = snap;
  writeFileSync(path.join(OUT_DIR, "99-report.json"), JSON.stringify(report, null, 2));
  console.log("[probe] done ->", path.join(OUT_DIR, "99-report.json"));
  client.close();
}

main().catch((e) => {
  console.error("[probe] failed:", e.stack || e.message);
  process.exit(1);
});
