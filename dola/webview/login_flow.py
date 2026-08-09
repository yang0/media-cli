# -*- coding: utf-8 -*-
"""
Dola login automation helpers (run inside pywebview after start).

Order of operations (important):
  1) Open dola → Log In → Continue with Google
  2) Fill Google email/password + intermediate TOS/consent
  3) Wait until dola session looks logged-in
  4) Caller may export cookies ONLY after step 3 succeeds
"""
from __future__ import annotations

import re
import random
import time
from dataclasses import dataclass
from typing import Any, Callable, Optional


LogFn = Callable[[str], None]

# Allow Google's password input controller and validation animation to settle
# before we click Next. This is intentionally longer than the email delay.
FIRST_PASSWORD_FIELD_DELAY = 3.0
FIRST_PASSWORD_SUBMIT_DELAY = 4.0
PASSWORD_SUBMIT_DELAY = 2.5


def _human_pause(
    log: Optional[LogFn],
    label: str,
    minimum: float,
    maximum: float,
) -> float:
    delay = random.uniform(minimum, maximum)
    _log(log, f"{label}: wait {delay:.1f}s")
    time.sleep(delay)
    return delay


def _log(log: Optional[LogFn], msg: str) -> None:
    if log:
        safe = re.sub(
            r"((?:access_token|id_token|oauth_token)=)[^&\s'\"]+",
            r"\1<redacted>",
            str(msg),
            flags=re.IGNORECASE,
        )
        log(safe)


def js_eval(window, expression: str) -> Any:
    # pywebview expects an expression; wrap statements in IIFE when needed.
    expr = expression.strip()
    if not expr.startswith("(") and ("{" in expr or "const " in expr or "let " in expr or "var " in expr):
        expr = f"(() => {{ {expr} }})()"
    try:
        return window.evaluate_js(expr)
    except Exception as exc:
        # SPA navigations can throw mid-eval; caller should retry next tick.
        return {"ok": False, "error": str(exc)}


JS_CLICK_LOGIN = r"""
(() => {
  const plain = el => (el.innerText || el.textContent || el.getAttribute('aria-label') || el.title || '').replace(/\s+/g, ' ').trim();
  const visible = el => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
  };
  const forceClick = el => {
    try { el.scrollIntoView({ block: 'center' }); } catch (e) {}
    try { el.click(); } catch (e) {}
    try {
      const o = { bubbles: true, cancelable: true, view: window };
      for (const t of ['pointerdown','mousedown','pointerup','mouseup','click']) el.dispatchEvent(new MouseEvent(t, o));
    } catch (e) {}
  };
  const nodes = Array.from(document.querySelectorAll('button,a,[role=button],div,span')).filter(visible);
  const exact = ['Log In', '登录', 'Sign in', 'Log in', 'Sign In'];
  let el = nodes
    .filter(n => {
      const t = plain(n);
      return exact.some(x => t === x) && t.length <= 16;
    })
    .sort((a, b) => {
      const ar = a.getBoundingClientRect(), br = b.getBoundingClientRect();
      // Prefer top-right login chip
      return (br.x + br.y * 0.2) - (ar.x + ar.y * 0.2);
    })[0];
  if (!el) {
    el = nodes.find(n => {
      const t = plain(n);
      return t.length <= 20 && /^(Log\s*In|Sign\s*in|登录|登陆)$/i.test(t);
    });
  }
  if (!el) return { ok: false, reason: 'login-btn-missing', sample: nodes.map(n => plain(n)).filter(t => t && t.length <= 24 && /log|sign|登|账/i.test(t)).slice(0, 15) };
  forceClick(el);
  return { ok: true, text: plain(el) };
})()
"""

JS_CLICK_GOOGLE = r"""
(() => {
  const plain = el => (el.innerText || el.textContent || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
  const visible = el => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
  };
  const nodes = Array.from(document.querySelectorAll('button,a,[role=button]')).filter(visible);
  const exactLabels = [
    'Continue with Google',
    'Google 登录',
    '使用 Google 登录',
    '使用 Google 账号继续',
    '通过 Google 登录',
    'Sign in with Google',
  ];
  const exact = nodes
    .map(el => ({ el, t: plain(el), area: el.getBoundingClientRect().width * el.getBoundingClientRect().height }))
    .filter(x => exactLabels.some(l => x.t === l || x.t.toLowerCase() === l.toLowerCase()))
    .sort((a, b) => a.area - b.area);
  const el = exact[0]?.el || nodes.find(n => {
    const t = plain(n);
    return t.length <= 40 && /Continue with Google|Google\s*登录|使用 Google|Sign in with Google/i.test(t);
  });
  if (!el) {
    return {
      ok: false,
      reason: 'google-btn-missing',
      candidates: nodes.map(n => plain(n)).filter(t => t && t.length <= 50 && /google|登录|Log|Continue/i.test(t)).slice(0, 20),
    };
  }
  el.scrollIntoView({ block: 'center' });
  el.click();
  return { ok: true, text: plain(el), tag: el.tagName };
})()
"""


def js_fill_email(email: str) -> str:
    return f"""
(() => {{
  const email = {email!r};
  const visible = el => {{
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
  }};
  let el = document.querySelector('input[type=email]')
    || document.querySelector('#identifierId')
    || Array.from(document.querySelectorAll('input')).filter(visible).find(i =>
        /email|identifier|account/i.test([i.type, i.name, i.id, i.getAttribute('autocomplete') || ''].join(' '))
      );
  if (!el || !visible(el)) return {{ ok: false, reason: 'email-input-missing', url: location.href }};
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  return new Promise(resolve => {{
    el.focus();
    setter?.call(el, '');
    el.dispatchEvent(new Event('input', {{ bubbles: true }}));
    let index = 0;
    const typeNext = () => {{
      index += 1;
      setter?.call(el, email.slice(0, index));
      el.dispatchEvent(new InputEvent('input', {{
        bubbles: true,
        data: email[index - 1] || '',
        inputType: 'insertText',
      }}));
      if (index >= email.length) {{
        el.dispatchEvent(new Event('change', {{ bubbles: true }}));
        resolve({{ ok: true, url: location.href, valLen: el.value.length }});
        return;
      }}
      setTimeout(typeNext, 70 + Math.floor(Math.random() * 80));
    }};
    setTimeout(typeNext, 350 + Math.floor(Math.random() * 350));
  }});
}})()
"""


def js_fill_password(password: str) -> str:
    return f"""
(() => {{
  const password = {password!r};
  const visible = el => {{
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    // Google sometimes keeps password field with opacity/animation; don't require opacity===1
    return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
  }};
  // Prefer real password inputs; Google may briefly mark them non-visible during transition
  let candidates = Array.from(document.querySelectorAll('input[type=password], input[name=Passwd], input[name=password], #password input'));
  let el = candidates.find(visible) || candidates[0]
    || Array.from(document.querySelectorAll('input')).find(i => i.type === 'password');
  if (!el) return {{ ok: false, reason: 'password-input-missing', url: location.href, n: candidates.length }};
  try {{ el.scrollIntoView({{ block: 'center' }}); }} catch (e) {{}}
  // Keep a submitted password intact while Google validates it.
  if (el.value === password) {{
    return {{ ok: true, alreadyFilled: true, url: location.href, vis: visible(el), valLen: el.value.length }};
  }}
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  return new Promise(resolve => {{
    el.focus();
    setter?.call(el, '');
    el.dispatchEvent(new Event('input', {{ bubbles: true }}));
    let index = 0;
    const typeNext = () => {{
      index += 1;
      setter?.call(el, password.slice(0, index));
      el.dispatchEvent(new InputEvent('input', {{
        bubbles: true,
        data: password[index - 1] || '',
        inputType: 'insertText',
      }}));
      if (index >= password.length) {{
        el.dispatchEvent(new Event('change', {{ bubbles: true }}));
        resolve({{
          ok: true,
          alreadyFilled: false,
          url: location.href,
          vis: visible(el),
          valLen: el.value.length,
        }});
        return;
      }}
      setTimeout(typeNext, 85 + Math.floor(Math.random() * 95));
    }};
    setTimeout(typeNext, 450 + Math.floor(Math.random() * 450));
  }});
}})()
"""

def _js_norm_plain() -> str:
    """Shared JS helpers: plain text + force click (React-friendly)."""
    return r"""
  const plain = el => {
    if (!el) return '';
    const raw = (el.innerText || el.textContent || el.getAttribute('aria-label') || el.value || '');
    return String(raw)
      .replace(/[\u200b-\u200d\ufeff]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  };
  const visible = el => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
  };
  const forceClick = el => {
    if (!el) return false;
    try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) {}
    try { el.focus && el.focus(); } catch (e) {}
    const opts = { bubbles: true, cancelable: true, view: window, buttons: 1 };
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      try { el.dispatchEvent(new MouseEvent(type, opts)); } catch (e) {}
    }
    try { el.click(); } catch (e) {}
    return true;
  };
  const clickables = () => Array.from(document.querySelectorAll(
    'button, a, [role=button], input[type=submit], input[type=button], div, span, label'
  )).filter(visible);
"""


# Use unicode escapes for Chinese so source encoding never breaks matching.
JS_CLICK_AGE_CONFIRM = r"""
(() => {
""" + _js_norm_plain() + r"""
  const CONFIRM = '\u786e\u8ba4';      // 确认
  const CONFIRM2 = '\u786e\u5b9a';     // 确定
  const NO = '\u5426';                 // 否
  const AGE_RE = /\u786e\u8ba4\u4f60\u7684\u5e74\u9f84|\u5df2\u6ee1\s*18|\u6ee118\u5468\u5c81|confirm your age|18\s*years/i;
  const bodyText = plain(document.body || document.documentElement);
  const ageGate = AGE_RE.test(bodyText);
  const reject = t => {
    const s = (t || '').toLowerCase();
    return !t || t === NO || s === 'no' || s === 'close' || t === '\u5173\u95ed' || t === '\u53d6\u6d88'
      || s === 'cancel' || s === 'x';
  };
  const nodes = clickables();
  // Prefer exact short labels on age gate
  const prefer = ageGate
    ? [CONFIRM, 'Confirm', 'Yes', 'OK', 'I am 18', 'I am over 18', CONFIRM2]
    : [CONFIRM, CONFIRM2, 'Confirm', 'Yes', 'OK'];
  for (const label of prefer) {
    const el = nodes.find(n => {
      const t = plain(n);
      if (reject(t)) return false;
      // Prefer leaf-ish nodes: exact match or very short
      return t === label || t.toLowerCase() === String(label).toLowerCase();
    });
    if (el) {
      forceClick(el);
      return { ok: true, via: 'exact:' + label, ageGate, text: plain(el) };
    }
  }
  // Contains-only 确认 on short buttons (avoid matching long paragraphs)
  const soft = nodes.find(n => {
    const t = plain(n);
    if (reject(t) || t.length > 12) return false;
    return t.includes(CONFIRM) || t.includes(CONFIRM2) || /^(confirm|yes|ok)$/i.test(t);
  });
  if (soft) {
    forceClick(soft);
    return { ok: true, via: 'soft:' + plain(soft), ageGate };
  }
  // Walk text nodes for exact 确认 (guard body during SPA transitions)
  const root = document.body || document.documentElement;
  if (root) {
    try {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        const t = String(node.textContent || '').replace(/[\u200b-\u200d\ufeff]/g, '').replace(/\s+/g, ' ').trim();
        if (t !== CONFIRM && t !== CONFIRM2 && t.toLowerCase() !== 'confirm') continue;
        let el = node.parentElement;
        for (let i = 0; i < 5 && el; i++, el = el.parentElement) {
          if (!visible(el)) continue;
          if (reject(plain(el)) && plain(el).length > 4) continue;
          forceClick(el);
          return { ok: true, via: 'text-node:' + t, ageGate };
        }
      }
    } catch (e) {
      return { ok: false, reason: 'tree-walk:' + String(e && e.message || e), url: location.href, ageGate };
    }
  }
  return {
    ok: false,
    url: location.href,
    body: bodyText.slice(0, 240),
    buttons: nodes.map(n => plain(n)).filter(t => t && t.length <= 40).slice(0, 20),
    ageGate,
  };
})()
"""

JS_CLICK_NEXT = r"""
(() => {
""" + _js_norm_plain() + r"""
  const preferIds = ['#identifierNext', '#passwordNext', '#next', '#submit_approve_access'];
  for (const sel of preferIds) {
    const el = document.querySelector(sel);
    if (el && visible(el)) { forceClick(el); return { ok: true, via: sel }; }
  }
  const CONFIRM = '\u786e\u8ba4';
  const CONFIRM2 = '\u786e\u5b9a';
  const NO = '\u5426';
  const bodyText = plain(document.body || document.documentElement);
  const ageGate = /\u786e\u8ba4\u4f60\u7684\u5e74\u9f84|\u5df2\u6ee1\s*18|\u6ee118\u5468\u5c81|confirm your age/i.test(bodyText);
  if (ageGate) {
    // Delegate to same strategy as age confirm (inlined briefly)
    const nodes = clickables();
    for (const label of [CONFIRM, 'Confirm', 'Yes', 'OK', CONFIRM2]) {
      const el = nodes.find(n => {
        const t = plain(n);
        if (!t || t === NO || /^no|close|cancel$/i.test(t)) return false;
        return t === label || t.toLowerCase() === String(label).toLowerCase();
      });
      if (el) { forceClick(el); return { ok: true, via: 'age:' + label, ageGate: true }; }
    }
  }
  const labels = ageGate
    ? [CONFIRM, 'Confirm', 'Yes', 'OK', CONFIRM2]
    : ['Next', 'Continue', 'Allow', 'I understand', 'I agree', 'Accept', 'Accept all', 'Agree',
       '\u4e0b\u4e00\u6b65', '\u7ee7\u7eed', '\u5141\u8bb8', '\u6211\u4e86\u89e3', '\u6211\u540c\u610f',
       '\u540c\u610f', '\u63a5\u53d7', CONFIRM, CONFIRM2];
  const buttons = Array.from(document.querySelectorAll(
    'button,div[role=button],input[type=submit],a,[role=button]'
  )).filter(visible);
  for (const label of labels) {
    const el = buttons.find(b => {
      const t = plain(b);
      if (!t || t === NO || t === '\u53d6\u6d88' || /^no|close|cancel$/i.test(t)) return false;
      return t === label || t.toLowerCase() === String(label).toLowerCase();
    });
    if (el) { forceClick(el); return { ok: true, via: 'label:' + label, ageGate }; }
  }
  for (const c of Array.from(document.querySelectorAll('input[type=checkbox]')).filter(visible)) {
    if (!c.checked) forceClick(c);
  }
  const soft = buttons.find(b => {
    const t = plain(b);
    if (!t || t === NO || /^no|close|cancel$/i.test(t)) return false;
    return t.length <= 40 && /next|continue|allow|agree|accept|understand|confirm|\u4e0b\u4e00\u6b65|\u7ee7\u7eed|\u540c\u610f|\u5141\u8bb8|\u4e86\u89e3|\u63a5\u53d7|\u786e\u8ba4|\u786e\u5b9a/i.test(t);
  });
  if (soft) { forceClick(soft); return { ok: true, via: 'soft:' + plain(soft), ageGate }; }
  return {
    ok: false,
    url: location.href,
    body: plain(document.body).slice(0, 240),
    buttons: buttons.map(b => plain(b)).filter(Boolean).slice(0, 15),
    ageGate,
  };
})()
"""

JS_PAGE_STATE = r"""
(() => {
""" + _js_norm_plain() + r"""
  const body = plain(document.body || document.documentElement).slice(0, 1200);
  const url = location.href;
  const host = (location.hostname || '').toLowerCase();
  // Hostname only — callback hash may contain accounts.google.com text.
  const onGoogle = host === 'accounts.google.com' || host.endsWith('.accounts.google.com')
    || ((host === 'google.com' || host.endsWith('.google.com')) && /\/signin|\/o\/oauth|\/v3\/signin/i.test(location.pathname || ''));
  const onDola = host === 'dola.com' || host.endsWith('.dola.com');
  const ageGate = /\u786e\u8ba4\u4f60\u7684\u5e74\u9f84|\u5df2\u6ee1\s*18|\u6ee118\u5468\u5c81|confirm your age|18\s*years/i.test(body);
  const nodes = Array.from(document.querySelectorAll('button,a,[role=button]')).filter(visible);
  const hasLoginBtn = nodes.some(n => {
    const t = plain(n);
    return t === 'Log In' || t === '\u767b\u5f55' || t === 'Sign in' || t === 'Log in';
  });
  const hasGoogleBtn = nodes.some(n => /Continue with Google|Google\s*\u767b\u5f55|\u4f7f\u7528 Google|Sign in with Google/i.test(plain(n)));
  const hasLogin = hasLoginBtn || hasGoogleBtn || /Log In to Unlock|Continue with Google|Google\s*\u767b\u5f55|\u4f7f\u7528 Google/i.test(body);
  // Logged-in chat UI: display name / 新对话 / 历史对话, without login CTAs
  const looksIn = onDola && !hasLogin && !hasLoginBtn && !hasGoogleBtn && (
    /user\d{5,}|@|\u9000\u51fa|Sign out|Log out|\u4e2a\u4eba\u4e2d\u5fc3/i.test(body)
    || (/\u65b0\u5bf9\u8bdd|\u5386\u53f2\u5bf9\u8bdd|\u6709\u4ec0\u4e48\u6211\u80fd\u5e2e\u4f60/i.test(body)
        && !/\u767b\u5f55|Log In|Sign in|Google/i.test(body))
    || (/[A-Z][a-z]+\s+[A-Z][a-z]+/.test(body) && /\u65b0\u5bf9\u8bdd|\u4e3b\u5bf9\u8bdd/i.test(body))
  );
  const challenge = /verify|unusual|captcha|phone|2-step|\u4e24\u6b65|\u9a8c\u8bc1\u4f60\u7684\u8eab\u4efd|\u6062\u590d\u90ae\u7bb1|couldn't sign you in|browser or app may not be secure|\u6b64\u6d4f\u89c8\u5668/i.test(body);
  const workspace = /workspacetermsofservice|Welcome to your new account|Google Workspace|\u5b66\u6821\u7ba1\u7406|\u6559\u80b2\u8d26\u53f7/i.test(url + ' ' + body);
  const consent = /signin\/oauth\/consent|\u8981\u8bbf\u95ee\u60a8\u7684|wants to access|\u8bf7\u6c42\u8bbf\u95ee/i.test(url + ' ' + body);
  // Prefer URL path — Google keeps hidden password inputs on the email page.
  const path = location.pathname || '';
  const passVisible = (() => {
    const el = document.querySelector('input[type=password], input[name=Passwd]');
    return !!(el && visible(el));
  })();
  const emailVisible = (() => {
    const el = document.querySelector('input[type=email], #identifierId');
    return !!(el && visible(el));
  })();
  const passStep = /\/challenge\/pwd|\/pwd/i.test(path + url) || (passVisible && !emailVisible);
  const emailStep = /\/signin\/identifier|\/v3\/signin\/identifier|\/identifier/i.test(path)
    || (emailVisible && !passStep);
  const onCallback = onDola && (/\/auth\/callback/i.test(url) || /access_token=/i.test(url));
  return { url, host, onGoogle, onDola, onCallback, hasLogin, hasLoginBtn, hasGoogleBtn, looksIn, challenge, workspace, consent, ageGate, emailStep, passStep, body: body.slice(0, 280) };
})()
"""



@dataclass
class LoginResult:
    ok: bool
    stage: str
    message: str = ""
    url: str = ""
    detail: Any = None


def wait_until(window, predicate, timeout: float = 60, interval: float = 0.8, log: Optional[LogFn] = None) -> Any:
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        try:
            last = predicate()
            if last:
                return last
        except Exception as exc:
            _log(log, f"wait poll warn: {exc}")
        time.sleep(interval)
    return last


def page_state(window) -> dict:
    try:
        st = js_eval(window, JS_PAGE_STATE) or {}
        if isinstance(st, str):
            # some backends return JSON string
            import json
            try:
                st = json.loads(st)
            except Exception:
                st = {"body": st}
        return st if isinstance(st, dict) else {}
    except Exception as exc:
        return {"error": str(exc), "url": ""}


def is_logged_in(window, cookies_probe: Optional[Callable[[], bool]] = None) -> bool:
    """Prefer real session cookies. UI alone is not enough (guest chat looks logged-in)."""
    if cookies_probe and cookies_probe():
        return True
    return False


def run_google_login(
    window,
    email: str,
    password: str,
    *,
    timeout: float = 240,
    log: Optional[LogFn] = None,
    cookies_probe: Optional[Callable[[], bool]] = None,
) -> LoginResult:
    """Drive dola → Google OAuth login. Does NOT export cookies."""
    email = (email or "").strip()
    password = password or ""
    if not email or not password:
        return LoginResult(False, "init", "email/password required")

    _log(log, f"login start for {email}")
    deadline = time.time() + timeout
    stage = "open-dola"
    email_done = False
    pass_done = False
    password_submit_attempts = 0
    last_password_submit = 0.0
    first_password_field_waited = False

    # Ensure on dola first
    try:
        url = window.get_current_url() or ""
    except Exception:
        url = ""
    if "dola.com" not in (url or ""):
        window.load_url("https://www.dola.com/")
        time.sleep(3)

    # Click login + google on dola (skip if already mid-OAuth / age gate / callback)
    for attempt in range(1, 4):
        st = page_state(window)
        if st.get("onGoogle") or st.get("emailStep") or st.get("passStep"):
            break
        if st.get("ageGate") or st.get("onCallback") or "access_token=" in str(st.get("url") or ""):
            _log(log, "already on oauth callback / age gate — skip login buttons")
            break
        # Only treat as already logged-in when session cookies exist (UI alone is unreliable).
        if cookies_probe and cookies_probe():
            return LoginResult(True, "already-logged-in", "session cookies already present", st.get("url", ""))

        _human_pause(log, "before Dola login click", 1.2, 2.2)
        r1 = js_eval(window, JS_CLICK_LOGIN)
        _log(log, f"click login: {r1}")
        _human_pause(log, "before Google login click", 1.4, 2.6)
        r2 = js_eval(window, JS_CLICK_GOOGLE)
        _log(log, f"click google: {r2}")
        time.sleep(2.5)
        st = page_state(window)
        if st.get("onGoogle") or st.get("emailStep") or st.get("passStep") or st.get("ageGate") or st.get("onCallback"):
            break
        # Maybe same-window navigation delayed
        time.sleep(2)

    age_clicks = 0
    idle_ticks = 0
    oauth_seen = False
    while time.time() < deadline:
        st = page_state(window)
        url = st.get("url") or ""
        body = str(st.get("body") or "")
        body_age = bool(
            st.get("ageGate")
            or re.search(r"确认你的年龄|满18周岁|confirm your age|18\s*years", body, re.I)
        )
        on_callback = bool(
            st.get("onCallback")
            or "/auth/callback" in url
            or "access_token=" in url
        )
        if on_callback or "access_token=" in url:
            oauth_seen = True

        _log(
            log,
            f"state url={url[:120]} host={st.get('host')} google={st.get('onGoogle')} "
            f"dola={st.get('onDola')} age={body_age} cb={on_callback} email={st.get('emailStep')} "
            f"pass={st.get('passStep')} workspace={st.get('workspace')} "
            f"consent={st.get('consent')} in={st.get('looksIn')}",
        )

        if st.get("challenge") and st.get("onGoogle"):
            return LoginResult(False, "challenge", "Google challenge / verification required", url, st)

        # Require real session cookies — guest /chat UI can lookIn without login.
        if cookies_probe and cookies_probe():
            return LoginResult(True, "logged-in", "dola session cookies present", url, st)

        # Age gate: click 确认, then STAY on callback so SPA can exchange access_token.
        # Do NOT load_url away while hash still has the OAuth token.
        if body_age:
            stage = "age-gate"
            _human_pause(log, "before age confirmation", 1.6, 2.8)
            nr = js_eval(window, JS_CLICK_AGE_CONFIRM)
            _log(log, f"age-gate click: {nr}")
            age_clicks += 1
            # Give SPA time to POST token / set session cookies after confirm
            time.sleep(4.0)
            if cookies_probe and cookies_probe():
                return LoginResult(True, "logged-in-after-age", "session after age confirm", url, st)
            continue

        # Guest chat often has no 登录 text in body but still shows composer — still try login/google
        if st.get("onDola") and not st.get("onGoogle") and not on_callback and not body_age:
            if st.get("hasLogin") or st.get("hasLoginBtn") or st.get("hasGoogleBtn"):
                stage = "retry-dola-login"
                _human_pause(log, "before retry login click", 1.0, 2.0)
                js_eval(window, JS_CLICK_LOGIN)
                _human_pause(log, "before retry Google click", 1.3, 2.4)
                js_eval(window, JS_CLICK_GOOGLE)
                time.sleep(2)
                continue
            # No login button visible: open login modal via common entry points / top-right
            if idle_ticks in (0, 3, 8) and not oauth_seen:
                stage = "force-login-entry"
                _human_pause(log, "before forced login click", 1.0, 2.0)
                r1 = js_eval(window, JS_CLICK_LOGIN)
                _log(log, f"force click login: {r1}")
                _human_pause(log, "before forced Google click", 1.3, 2.4)
                r2 = js_eval(window, JS_CLICK_GOOGLE)
                _log(log, f"force click google: {r2}")
                time.sleep(2.5)
                if isinstance(r2, dict) and not r2.get("ok"):
                    # Try navigating home then login
                    try:
                        window.load_url("https://www.dola.com/")
                    except Exception:
                        pass
                    time.sleep(2.5)
                continue

        # Google email step — re-fill if still on identifier after a failed advance
        if st.get("onGoogle") and st.get("emailStep") and not st.get("passStep"):
            stage = "fill-email"
            # Allow re-fill if page bounced back
            _human_pause(log, "email form settle", 1.5, 2.8)
            fr = js_eval(window, js_fill_email(email))
            _log(log, f"fill email: {fr}")
            if isinstance(fr, dict) and fr.get("ok"):
                email_done = True
                _human_pause(log, "after email typing", 1.4, 2.6)
                nr = js_eval(window, JS_CLICK_NEXT)
                _log(log, f"next after email: {nr}")
                time.sleep(2.8)
            else:
                time.sleep(1.2)
            continue

        # Google password step — never spam identifierNext while password is present
        if st.get("onGoogle") and (st.get("passStep") or "/challenge/pwd" in url or "/challenge/pwd" in (url or "")):
            stage = "fill-password"
            # The password page remains visible while Google validates a submit.
            # Do not overwrite its native input or click Next on every poll.
            if pass_done and time.time() - last_password_submit < 8.0:
                _log(log, "password submitted; waiting for Google response")
                time.sleep(1.5)
                continue
            if password_submit_attempts >= 3:
                return LoginResult(
                    False,
                    "password-submit-stalled",
                    "password page did not advance after 3 submits; check Google verification or credentials",
                    url,
                    st,
                )
            if not first_password_field_waited:
                wait_started = time.monotonic()
                first_password_delay = random.uniform(
                    FIRST_PASSWORD_FIELD_DELAY,
                    FIRST_PASSWORD_FIELD_DELAY + 1.5,
                )
                _log(log, f"first password page: wait {first_password_delay:.1f}s before filling")
                time.sleep(first_password_delay)
                first_password_field_waited = True
                _log(log, f"first password pre-fill wait actual={time.monotonic() - wait_started:.1f}s")
            # Wait a beat for password field animation
            time.sleep(0.8)
            fr = js_eval(window, js_fill_password(password))
            _log(log, f"fill password: ok={isinstance(fr, dict) and fr.get('ok')} alreadyFilled={isinstance(fr, dict) and fr.get('alreadyFilled')}")
            if isinstance(fr, dict) and fr.get("ok"):
                pass_done = True
                submit_delay = (
                    random.uniform(FIRST_PASSWORD_SUBMIT_DELAY, FIRST_PASSWORD_SUBMIT_DELAY + 1.5)
                    if password_submit_attempts == 0
                    else random.uniform(PASSWORD_SUBMIT_DELAY, PASSWORD_SUBMIT_DELAY + 1.0)
                )
                _log(log, f"wait {submit_delay:.1f}s before password submit")
                time.sleep(submit_delay)
                nr = js_eval(window, JS_CLICK_NEXT)
                _log(log, f"next after password: {nr}")
                password_submit_attempts += 1
                last_password_submit = time.time()
                time.sleep(3.0)
            else:
                # Retry without clicking Next (avoids stuck identifierNext loop)
                time.sleep(1.5)
            continue

        # Workspace TOS / OAuth consent only (not email/password pages)
        if st.get("workspace") or st.get("consent"):
            stage = "google-intermediate"
            _human_pause(log, "before consent/terms click", 1.7, 3.0)
            nr = js_eval(window, JS_CLICK_NEXT)
            _log(log, f"intermediate click: {nr}")
            time.sleep(2)
            continue

        # Other Google interstitial (not identifier/password forms)
        if st.get("onGoogle") and not st.get("emailStep") and not st.get("passStep"):
            stage = "google-intermediate"
            _human_pause(log, "before Google intermediate click", 1.7, 3.0)
            nr = js_eval(window, JS_CLICK_NEXT)
            _log(log, f"intermediate click: {nr}")
            time.sleep(2)
            continue

        # OAuth callback without age gate: wait for SPA (keep token hash intact)
        if st.get("onDola") and on_callback:
            stage = "dola-callback-wait"
            idle_ticks += 1
            # Soft-click any residual confirm UI, but never wipe the hash via load_url
            if age_clicks < 6:
                nr = js_eval(window, JS_CLICK_AGE_CONFIRM)
                _log(log, f"callback residual click: {nr}")
                if isinstance(nr, dict) and nr.get("ok"):
                    age_clicks += 1
            time.sleep(2.5)
            if cookies_probe and cookies_probe():
                return LoginResult(True, "logged-in-callback", "session on callback", url, st)
            # Only after SPA has had time, follow its navigatePath if still stuck
            if idle_ticks >= 8 and age_clicks > 0:
                _log(log, "callback still no session; soft navigate to /chat (token may already be consumed)")
                try:
                    js_eval(
                        window,
                        "(() => { if (!/access_token=/.test(location.href)) "
                        "location.assign('https://www.dola.com/chat/?from_login=1'); "
                        "return location.href; })()",
                    )
                except Exception as exc:
                    _log(log, f"soft nav warn: {exc}")
                time.sleep(3)
            continue

        if st.get("onDola") and cookies_probe and cookies_probe():
            return LoginResult(True, "logged-in-cookies", "session cookies present", url, st)

        # Idle on dola chat without session: log cookies occasionally; re-trigger login if OAuth already done
        if st.get("onDola"):
            idle_ticks += 1
            if idle_ticks % 5 == 1:
                try:
                    names = js_eval(
                        window,
                        "(() => (document.cookie||'').split(';').map(s=>s.split('=')[0].trim()).filter(Boolean).slice(0,40))()",
                    )
                    _log(log, f"document.cookie names={names}")
                except Exception as exc:
                    _log(log, f"cookie probe warn: {exc}")
            # If we already finished Google but landed without session, re-open login once
            if oauth_seen and idle_ticks >= 10 and st.get("hasLogin"):
                stage = "relogin-after-failed-session"
                _log(log, "no session after oauth; retry google login button")
                oauth_seen = False
                email_done = False
                pass_done = False
                age_clicks = 0
                idle_ticks = 0
                js_eval(window, JS_CLICK_LOGIN)
                time.sleep(1.2)
                js_eval(window, JS_CLICK_GOOGLE)
                time.sleep(2)
                continue

        time.sleep(1.2)

    st = page_state(window)
    return LoginResult(False, stage, "login timeout", st.get("url", ""), st)




def parse_accounts_file(path: str) -> list[tuple[str, str]]:
    text = open(path, encoding="utf-8", errors="replace").read()
    rows = []
    for i, line in enumerate(text.splitlines(), 1):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        for sep in ("|", "----", "\t", ":"):
            if sep in line:
                email, password = line.split(sep, 1)
                email, password = email.strip(), password.strip()
                if email and password:
                    rows.append((email, password))
                break
        else:
            raise ValueError(f"bad account line {i}: {line}")
    return rows
