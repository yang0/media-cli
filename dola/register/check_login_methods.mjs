const origin = "http://127.0.0.1:9223";
const list = await fetch(origin + "/json/list").then(r => r.json());
let page = list.find(t => t.type === "page" && /dola\.com/i.test(t.url||""));
if (!page) {
  await fetch(origin + "/json/new?" + encodeURIComponent("https://www.dola.com/"), { method: "PUT" }).catch(()=>fetch(origin+"/json/new?"+encodeURIComponent("https://www.dola.com/")));
  await new Promise(r=>setTimeout(r,3000));
  const list2 = await fetch(origin+"/json/list").then(r=>r.json());
  page = list2.find(t => t.type==="page" && /dola\.com/i.test(t.url||""));
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res,rej)=>{ws.addEventListener("open",res); ws.addEventListener("error",e=>rej(e.error||e));});
let id=0; const pending=new Map();
ws.addEventListener("message", ev => {
  const msg = JSON.parse(String(ev.data));
  if (msg.id && pending.has(msg.id)) {
    const {resolve,reject}=pending.get(msg.id); pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error))); else resolve(msg.result);
  }
});
const send=(method,params={})=>new Promise((resolve,reject)=>{
  const mid=++id; pending.set(mid,{resolve,reject});
  ws.send(JSON.stringify({id:mid,method,params}));
  setTimeout(()=>{ if(pending.has(mid)){ pending.delete(mid); reject(new Error("timeout "+method)); } }, 30000);
});
const evaluate=async (expression)=>{
  const r=await send("Runtime.evaluate",{expression,awaitPromise:true,returnByValue:true,userGesture:true});
  if(r.exceptionDetails) throw new Error(r.exceptionDetails.text||"eval fail");
  return r.result?.value;
};
await send("Runtime.enable"); await send("Page.enable");
await send("Page.navigate",{url:"https://www.dola.com/"});
await new Promise(r=>setTimeout(r,3500));
// click exact Log In
const click = await evaluate(`(() => {
  const plain = el => (el.innerText||el.textContent||el.getAttribute('aria-label')||'').replace(/\\s+/g,' ').trim();
  const visible = el => { const r=el.getBoundingClientRect(); const s=getComputedStyle(el); return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'; };
  const nodes = Array.from(document.querySelectorAll('button,a,[role=button]')).filter(visible);
  const el = nodes.filter(n => { const t=plain(n); return t==='Log In' || t==='登录' || t==='Sign in'; })
    .sort((a,b)=> (b.getBoundingClientRect().width*b.getBoundingClientRect().height)-(a.getBoundingClientRect().width*a.getBoundingClientRect().height))[0];
  if(!el) return {ok:false, all: nodes.map(n=>plain(n)).filter(Boolean).slice(0,40)};
  el.click();
  return {ok:true, text: plain(el), href: el.href||''};
})()`);
console.log("CLICK", JSON.stringify(click));
await new Promise(r=>setTimeout(r,4000));
// also wait for new tab (oauth popup)
const list3 = await fetch(origin+"/json/list").then(r=>r.json());
console.log("TABS", list3.filter(t=>t.type==='page').map(t=>({url:t.url,title:t.title})));
const snap = await evaluate(`(() => {
  const plain = el => (el.innerText||el.textContent||el.getAttribute('aria-label')||'').replace(/\\s+/g,' ').trim();
  const visible = el => { const r=el.getBoundingClientRect(); const s=getComputedStyle(el); return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'; };
  return {
    url: location.href,
    title: document.title,
    buttons: Array.from(document.querySelectorAll('button,a,[role=button],div,span')).filter(visible)
      .map(el=>plain(el)).filter(t=>t&&t.length<=50)
      .filter(t=>/Google|Apple|email|邮箱|手机|phone|GitHub|Microsoft|Facebook|继续|登录|注册|password|密码|验证码|Sign|Log|SSO|TikTok|Byte/i.test(t)).slice(0,80),
    inputs: Array.from(document.querySelectorAll('input,textarea')).filter(visible).map(el=>({type:el.type,name:el.name,ph:el.placeholder,aria:el.getAttribute('aria-label')||''})),
    text: (document.body.innerText||'').slice(0,3000),
    links: Array.from(document.querySelectorAll('a[href]')).filter(visible).map(a=>({t:plain(a).slice(0,40),href:a.href})).filter(x=>/login|sign|auth|passport|oauth|google|email/i.test(x.href+x.t)).slice(0,30)
  };
})()`);
console.log("SNAP", JSON.stringify(snap,null,2));
// Inspect other pages opened by login
for (const t of list3.filter(p=>p.type==='page' && p.webSocketDebuggerUrl && p.id!==page.id)) {
  try {
    const ws2 = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((res,rej)=>{ws2.addEventListener('open',res); ws2.addEventListener('error',e=>rej(e.error||e));});
    let id2=0; const pend=new Map();
    ws2.addEventListener('message', ev=>{ const msg=JSON.parse(String(ev.data)); if(msg.id&&pend.has(msg.id)){const {resolve,reject}=pend.get(msg.id); pend.delete(msg.id); if(msg.error) reject(new Error(JSON.stringify(msg.error))); else resolve(msg.result);} });
    const send2=(method,params={})=>new Promise((resolve,reject)=>{const mid=++id2; pend.set(mid,{resolve,reject}); ws2.send(JSON.stringify({id:mid,method,params})); setTimeout(()=>{if(pend.has(mid)){pend.delete(mid);reject(new Error('to'));}},10000);});
    await send2('Runtime.enable');
    const r = await send2('Runtime.evaluate',{expression:"({url:location.href,title:document.title,text:(document.body&&document.body.innerText||'').slice(0,1500)})",returnByValue:true,awaitPromise:true});
    console.log("OTHER_TAB", JSON.stringify(r.result?.value,null,2));
    ws2.close();
  } catch(e) { console.log("OTHER_TAB_ERR", t.url, e.message); }
}
ws.close();
