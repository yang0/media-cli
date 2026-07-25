(function () {
    'use strict';
    if (window.__dola15sLoaded) return;
    window.__dola15sLoaded = true;

    const TARGET_DURATION = 15;
    const TARGET_MODEL = 'seedance_v2.0';
    const STORAGE_KEY = 'dola_video_duration_choice';
    const MARK = 'data-dola-15s';
    const STYLE_ID = 'dola-15s-style';
    let timer = 0;

    function selectedDuration() {
        try { return Number(localStorage.getItem(STORAGE_KEY)) || 0; } catch (_) { return 0; }
    }

    function saveDuration(seconds) {
        try {
            if (seconds) localStorage.setItem(STORAGE_KEY, String(seconds));
            else localStorage.removeItem(STORAGE_KEY);
        } catch (_) { }
    }

    function isCompletionUrl(input) {
        const raw = typeof input === 'string' ? input : (input && (input.url || input.href)) || String(input || '');
        try {
            const url = new URL(raw, location.href);
            return /(^|\.)dola\.com$/.test(url.hostname) && url.pathname === '/chat/completion';
        } catch (_) {
            return /\/chat\/completion(?:\?|$)/.test(raw);
        }
    }

    // ===== 关键修复：递归遍历 JSON 树，与扩展插件的 patchDuration 完全一致 =====
    function patchDuration(obj, depth) {
        depth = depth || 0;
        if (depth > 20 || obj == null || typeof obj !== 'object') return false;
        var changed = false;
        if (Array.isArray(obj)) {
            for (var i = 0; i < obj.length; i++) {
                if (patchDuration(obj[i], depth + 1)) changed = true;
            }
        } else {
            if (obj.chat_ability && Number(obj.chat_ability.ability_type) === 17) {
                var ability = obj.chat_ability;
                if (typeof ability.ability_param === 'string') {
                    try {
                        var param = JSON.parse(ability.ability_param);
                        if (param && typeof param === 'object') {
                            param.model = TARGET_MODEL;
                            param.duration = TARGET_DURATION;
                            ability.ability_param = JSON.stringify(param);
                            changed = true;
                        }
                    } catch (_) {}
                } else if (ability.ability_param && typeof ability.ability_param === 'object') {
                    ability.ability_param.model = TARGET_MODEL;
                    ability.ability_param.duration = TARGET_DURATION;
                    changed = true;
                }
            }
            var keys = Object.keys(obj);
            for (var j = 0; j < keys.length; j++) {
                if (keys[j] !== 'chat_ability' && patchDuration(obj[keys[j]], depth + 1)) changed = true;
            }
        }
        return changed;
    }

    function patchBody(rawBody) {
        if (typeof rawBody !== 'string' || !rawBody.trim()) return { changed: false, body: rawBody };
        var payload;
        try { payload = JSON.parse(rawBody); } catch (_) { return { changed: false, body: rawBody }; }
        if (patchDuration(payload)) {
            return { changed: true, body: JSON.stringify(payload) };
        }
        return { changed: false, body: rawBody };
    }

    // ===== 关键修复：用闭包保存原始 fetch =====
    function patchFetch() {
        const currentFetch = window.fetch;
        if (!currentFetch || typeof currentFetch !== 'function') return;
        if (currentFetch.__dola15s) return;

        const _originalFetch = currentFetch;

        function patchedFetch(input, init) {
            try {
                if (!isCompletionUrl(input)) return _originalFetch.apply(this, arguments);
                if (init && Object.prototype.hasOwnProperty.call(init, 'body')) {
                    const patched = patchBody(init.body);
                    if (patched.changed) return _originalFetch.call(this, input, { ...init, body: patched.body });
                    return _originalFetch.apply(this, arguments);
                }
                if (window.Request && input instanceof window.Request && String(input.method || '').toUpperCase() === 'POST') {
                    const raw = input.clone().text();
                    if (raw && typeof raw.then === 'function') {
                        return raw.then(function (text) {
                            const patched = patchBody(text);
                            if (patched.changed) return _originalFetch.call(this, new window.Request(input, { body: patched.body }), init);
                            return _originalFetch.call(this, input, init);
                        }.bind(this));
                    }
                }
            } catch (error) { }
            return _originalFetch.apply(this, arguments);
        }
        patchedFetch.__dola15s = true;
        window.fetch = patchedFetch;
    }

    function patchXhr() {
        const proto = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
        if (!proto || proto.__dola15sXhr) return;
        const originalOpen = proto.open;
        const originalSend = proto.send;

        proto.open = function (method, url) {
            this.__dola15sMethod = method;
            this.__dola15sUrl = url;
            return originalOpen.apply(this, arguments);
        };

        proto.send = function (body) {
            try {
                if (String(this.__dola15sMethod || '').toUpperCase() === 'POST' && isCompletionUrl(this.__dola15sUrl)) {
                    const patched = patchBody(body);
                    if (patched.changed) return originalSend.call(this, patched.body);
                }
            } catch (error) { }
            return originalSend.apply(this, arguments);
        };
        proto.__dola15sXhr = true;
    }

    // ===== 轮询守护 =====
    function startFetchGuard() {
        setInterval(function () {
            if (typeof window.fetch !== 'function' || !window.fetch.__dola15s) {
                patchFetch();
            }
        }, 1500);
    }

    // ========== UI 部分 ==========
    function visible(el) {
        if (!el || !el.isConnected) return false;
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    }
    function text(el) { return String((el && el.textContent) || '').replace(/\s+/g, '').replace(/[✓✔√]/g, '').trim(); }
    function exactDuration(el) { const m = text(el).match(/^(5|10|15)(s|秒)$/); return m ? Number(m[1]) : 0; }

    function installStyle() {
        if (document.getElementById(STYLE_ID)) return;
        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent =
            `[${MARK}="option"]{display:flex!important;align-items:center!important;gap:26px!important;cursor:pointer!important}` +
            `[${MARK}="option"][${MARK}-active="1"]::after{content:"\\2713";margin-left:auto;flex:0 0 auto;color:currentColor;font-size:18px;font-weight:600;line-height:1}` +
            `[${MARK}-native-check="hidden"]{visibility:hidden!important}`;
        (document.head || document.documentElement).appendChild(style);
    }

    function closestClickable(el) {
        let current = el && el.nodeType === Node.TEXT_NODE ? el.parentElement : el;
        for (let i = 0; current && i < 7; i += 1, current = current.parentElement) {
            const role = current.getAttribute('role');
            if (current.tagName === 'BUTTON' || role === 'button' || role === 'menuitem' || role === 'menuitemradio' || role === 'menuitemcheckbox' || role === 'option' || current.tabIndex >= 0 || /pointer/.test(String(getComputedStyle(current).cursor || ''))) return current;
        }
        return el && el.parentElement;
    }

    function findDurationMenuRoot() {
        if (!document.body) return null;
        // NEVER querySelectorAll('div') on SPA — freezes renderer ("此页存在问题")
        var sels = [
            '[role="menu"]',
            '[role="listbox"]',
            '[data-slot*="dropdown-menu"]',
            '[data-radix-menu-content]',
            '[class*="dropdown-menu"]',
            '[class*="DropdownMenu"]',
            '[class*="duration"]',
            '[class*="Duration"]'
        ];
        var nodes = [];
        for (var s = 0; s < sels.length; s++) {
            try {
                var found = document.querySelectorAll(sels[s]);
                for (var i = 0; i < found.length; i++) nodes.push(found[i]);
            } catch (_) {}
        }
        return nodes
            .filter(visible)
            .filter(function (el) {
                var t = text(el);
                return t.length <= 220 && /时长/.test(t) && /5s/.test(t) && /10s/.test(t) && !/Seedance/.test(t) && !/比例/.test(t);
            })
            .sort(function (a, b) {
                var ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
                return (ra.width * ra.height) - (rb.width * rb.height);
            })[0] || null;
    }

    function optionTextNodes(root) {
        const nodes = []; const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode(n) { return /^\s*(5|10|15)(s|秒)\s*$/.test(n.nodeValue || '') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT; } });
        while (walker.nextNode()) nodes.push(walker.currentNode); return nodes;
    }

    function findMenuOptions(root) {
        const out = [];
        for (const node of optionTextNodes(root)) {
            const parent = node.parentElement; if (!visible(parent)) continue;
            const item = closestClickable(parent); if (!item || !root.contains(item)) continue;
            if (!exactDuration(item)) continue;
            if (out.some(e => e === item || e.contains(item))) continue;
            for (let i = out.length - 1; i >= 0; i--) { if (item.contains(out[i])) out.splice(i, 1); }
            out.push(item);
        }
        // Injected rows are not owned by React and may not have exactly the
        // same clickable/text structure as native rows after a rerender.
        // Include them by our stable marker so MutationObserver cannot clone
        // duplicate 15s options or render selection state on the wrong row.
        root.querySelectorAll(`[${MARK}="option"]`).forEach(item => {
            const markedParent = item.parentElement && item.parentElement.closest(`[${MARK}="option"]`);
            if (!markedParent && !out.includes(item)) out.push(item);
        });
        return out;
    }

    function durationTextNode(el) { const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); while (w.nextNode()) { if (/^\s*(5|10|15)(s|秒)\s*$/.test(w.currentNode.nodeValue || '')) return w.currentNode; } return null; }
    function removeOwnChecks(el) { el.querySelectorAll(`[${MARK}-check]`).forEach(n => n.remove()); }

    function setNativeChecksHidden(item, hidden) {
        item.querySelectorAll(`[${MARK}-native-check]`).forEach(n => n.removeAttribute(`${MARK}-native-check`));
        if (!hidden) return;
        item.querySelectorAll('svg,img,canvas').forEach(n => n.setAttribute(`${MARK}-native-check`, 'hidden'));
        const nodes = []; const w = document.createTreeWalker(item, NodeFilter.SHOW_TEXT, { acceptNode(n) { return /[✓✔√]/.test(n.nodeValue || '') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT; } });
        while (w.nextNode()) nodes.push(w.currentNode);
        for (const n of nodes) { const p = n.parentElement; if (p && /^[\s✓✔√]+$/.test(p.textContent || '')) p.setAttribute(`${MARK}-native-check`, 'hidden'); }
    }

    function scrubClone(clone) {
        clone.removeAttribute('aria-selected'); clone.removeAttribute('aria-checked'); clone.removeAttribute('checked'); clone.removeAttribute('selected');
        clone.removeAttribute('data-state');
        // Native rows are bound before we choose one as the clone template.
        // cloneNode copies those data attributes, so remove all injected state
        // from the entire clone before turning it into the synthetic 15s row.
        [clone, ...clone.querySelectorAll('*')].forEach(node => {
            node.removeAttribute(MARK);
            node.removeAttribute(`${MARK}-active`);
            node.removeAttribute(`${MARK}-native`);
            node.removeAttribute(`${MARK}-trigger`);
            node.removeAttribute(`${MARK}-native-check`);
            node.removeAttribute('data-state');
        });
        removeOwnChecks(clone);
        const node = durationTextNode(clone); if (node) node.nodeValue = '15s'; else clone.textContent = '15s';
    }

    function setToolbarText(seconds) {
        const next = seconds === TARGET_DURATION ? '15s' : `${seconds}s`;
        const durationMenu = findDurationMenuRoot();
        const nodes = []; const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, { acceptNode(n) { return /^\s*(5|10|15)(s|秒)\s*$/.test(n.nodeValue || '') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT; } });
        while (w.nextNode()) nodes.push(w.currentNode);
        for (const node of nodes) {
            // Never rewrite the 5s/10s rows inside the open duration menu.
            // Doing so makes the menu unrecognizable and breaks selection
            // rendering on compact layouts where body text is short.
            if (durationMenu && durationMenu.contains(node)) continue;
            const parent = node.parentElement; if (!visible(parent)) continue;
            const click = closestClickable(parent); if (!click || !visible(click)) continue;
            let cur = click.parentElement;
            for (let i = 0; cur && cur !== document.body && cur !== document.documentElement && i < 7; i += 1, cur = cur.parentElement) {
                const t = text(cur); if (/Seedance/.test(t) && /比例/.test(t) && t.length < 260) {
                    if (node.nodeValue !== next) node.nodeValue = next;
                    if (!click.hasAttribute(`${MARK}-trigger`)) { click.setAttribute(`${MARK}-trigger`, '1'); click.addEventListener('click', () => { setTimeout(inject15Option, 80); setTimeout(inject15Option, 240); }, true); }
                    break;
                }
            }
        }
    }

    function renderChecks(options) {
        const sel = selectedDuration() === TARGET_DURATION;
        for (const item of options) {
            const v = exactDuration(item);
            if (v === 5 || v === 10) {
                setNativeChecksHidden(item, sel);
                item.removeAttribute(`${MARK}-active`);
                continue;
            }
            if (v !== TARGET_DURATION) continue;

            // A 15s row is cloned from a native option, whose check icon and
            // data-state may describe the old 5s/10s selection. Never use that
            // stale visual state; render our own deterministic check instead.
            removeOwnChecks(item);
            setNativeChecksHidden(item, true);
            if (sel) item.setAttribute(`${MARK}-active`, '1');
            else item.removeAttribute(`${MARK}-active`);

            const role = item.getAttribute('role') || '';
            if (role === 'option' || item.hasAttribute('aria-selected')) {
                item.setAttribute('aria-selected', sel ? 'true' : 'false');
            }
            if (role === 'menuitemradio' || role === 'menuitemcheckbox' || item.hasAttribute('aria-checked')) {
                item.setAttribute('aria-checked', sel ? 'true' : 'false');
            }
            item.setAttribute('data-state', sel ? 'checked' : 'unchecked');
        }
    }
    function bindNative(item, seconds) { if (item.hasAttribute(`${MARK}-native`)) return; item.setAttribute(`${MARK}-native`, String(seconds)); item.addEventListener('click', () => { saveDuration(0); setToolbarText(seconds); setTimeout(inject15Option, 80); }, true); }
    function bind15(item) {
        item.querySelectorAll(`[${MARK}="option"]`).forEach(child => {
            child.removeAttribute(MARK);
            child.removeAttribute(`${MARK}-active`);
            child.removeAttribute('data-state');
            child.removeAttribute('aria-selected');
            child.removeAttribute('aria-checked');
        });
        if (item.hasAttribute(MARK)) return;
        item.setAttribute(MARK, 'option');
        function select15(e) {
            e.preventDefault();
            e.stopPropagation();
            saveDuration(TARGET_DURATION);
            setToolbarText(TARGET_DURATION);
            const root = findDurationMenuRoot();
            if (root) renderChecks(findMenuOptions(root));
            setTimeout(() => document.body && document.body.click(), 80);
        }
        item.addEventListener('click', select15, true);
        item.addEventListener('keydown', e => {
            if (e.key === 'Enter' || e.key === ' ') select15(e);
        }, true);
    }

    function inject15Option() {
        const root = findDurationMenuRoot(); if (!root) return;
        const options = findMenuOptions(root); if (!options.length) return;
        for (const item of options) { const v = exactDuration(item); if (v === 5 || v === 10) bindNative(item, v); if (v === TARGET_DURATION) bind15(item); }
        const existing15 = root.querySelector(`[${MARK}="option"]`);
        if (!existing15 && !options.some(item => exactDuration(item) === TARGET_DURATION)) {
            const after = options.find(item => exactDuration(item) === 10) || options[options.length - 1];
            const template = options.find(item => exactDuration(item) === 5) || after;
            if (!after || !template || !after.parentElement) return;
            const clone = template.cloneNode(true); scrubClone(clone); bind15(clone);
            after.parentElement.insertBefore(clone, after.nextSibling); options.push(clone);
        }
        renderChecks(options);
    }

    function tick() { if (selectedDuration() === TARGET_DURATION) setToolbarText(TARGET_DURATION); inject15Option(); }
    function schedule() {
        if (timer) return;
        timer = setTimeout(function () { timer = 0; tick(); }, 200);
    }

    function start() {
        installStyle(); tick();
        const observer = new MutationObserver(schedule);
        const waitBody = () => { if (!document.body) return setTimeout(waitBody, 200); observer.observe(document.body, { childList: true, subtree: true }); schedule(); };
        waitBody();
    }

    // ===== 轻量立即执行 + UI 延后（避免 inject 同步扫 DOM 卡死渲染进程）=====
    patchFetch();
    patchXhr();
    startFetchGuard();

    // Always defer UI work so evaluate_js / <script> inject can return immediately.
    setTimeout(function () {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', function () { setTimeout(start, 200); });
        } else {
            start();
        }
    }, 0);
})()
