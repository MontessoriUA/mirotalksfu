'use strict';

/*
 * Montemeet: conference UI translation layer (uk / ru / en, ukrainian default).
 *
 * No stock strings are edited — everything happens at runtime:
 *  - WRAPPERS: the global setTippy()/userLog() (Room.js) AND the RoomClient
 *    prototype methods (setTippy/userLog/toast/msgPopup), Swal.fire/mixin
 *    (incl. inputLabel/inputValidator/showValidationMessage) are wrapped as
 *    soon as this script loads (it is included AFTER Room.js, all deferred);
 *  - DOM PASS: every text node and translatable attribute (placeholder, title,
 *    aria-label, alt) in the document AND inside every <template>.content is
 *    translated by exact MSG match or RULES regex on DOMContentLoaded. Icons
 *    survive: only text nodes are touched, never element markup;
 *  - LIVE: a MutationObserver translates nodes the stock code builds later
 *    (device dropdowns, participants list, chat headers, Swal html bodies...);
 *  - our own Montemeet modules call window.mmT('русская строка') at run time.
 *
 * Dictionaries live in MontemeetI18n.dict.js (MSG / RULES / STATIC).
 * English is the stock language: en entries exist only for OUR russian-authored
 * strings; a stock string without an entry passes through unchanged.
 *
 * Language priority: localStorage MM_LANG (explicit choice in the conference)
 *  -> mm_lang cookie (the cabinet / landing choice, same domain) -> 'uk'.
 * The Settings > Language tab hosts the selector (the async Google-Translate
 * widget mount is hidden).
 */

const MontemeetI18n = (() => {
    const LANGS = ['uk', 'ru', 'en'];
    const ATTRS = ['placeholder', 'title', 'aria-label', 'alt'];

    function pick() {
        try {
            const ls = localStorage.getItem('MM_LANG');
            if (LANGS.includes(ls)) return ls;
        } catch (e) {}
        const m = /(?:^|;\s*)mm_lang=(uk|ru|en)(?:;|$)/.exec(document.cookie || '');
        return m ? m[1] : 'uk';
    }

    const lang = pick();
    const D = window.MontemeetDict || { MSG: {}, RULES: [], STATIC: [] };

    // translate one string: exact MSG match, then RULES (regex templates)
    function tr(text) {
        if (typeof text !== 'string' || !text) return text;
        const key = text.trim();
        if (!key || key.length > 400) return text;
        const hit = D.MSG[key];
        if (hit && hit[lang] != null) return text.replace(key, hit[lang]);
        for (const rule of D.RULES) {
            const m = rule.re.exec(key);
            if (m && rule[lang]) {
                return text.replace(key, rule[lang].replace(/\$(\d)/g, (_, n) => m[Number(n)] ?? ''));
            }
        }
        return text;
    }

    // stock is English → for en only OUR russian strings matter, and those are
    // translated at the source via window.mmT
    const domActive = lang !== 'en';

    function translateTextNode(node) {
        const out = tr(node.nodeValue);
        if (out !== node.nodeValue) node.nodeValue = out;
    }

    function translateAttrs(el) {
        for (const a of ATTRS) {
            const v = el.getAttribute && el.getAttribute(a);
            if (v) {
                const out = tr(v);
                if (out !== v) el.setAttribute(a, out);
            }
        }
    }

    function applyDom(root) {
        if (!root) return;
        if (root.nodeType === Node.TEXT_NODE) {
            translateTextNode(root);
            return;
        }
        if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return;
        if (root.nodeType === Node.ELEMENT_NODE) translateAttrs(root);
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
        let n;
        while ((n = walker.nextNode())) {
            if (n.nodeType === Node.TEXT_NODE) translateTextNode(n);
            else translateAttrs(n);
        }
    }

    function applyAll() {
        applyDom(document.body);
        for (const t of document.querySelectorAll('template')) applyDom(t.content);
        // explicit overrides / html-bearing entries
        for (const [selector, kind, byLang] of D.STATIC) {
            const value = byLang[lang];
            if (value == null) continue;
            for (const el of document.querySelectorAll(selector)) {
                if (kind === 'text') el.textContent = value;
                else if (kind === 'html') el.innerHTML = value;
                else el.setAttribute(kind, value);
            }
        }
    }

    let observer = null;
    function observe() {
        observer = new MutationObserver((muts) => {
            for (const m of muts) {
                if (m.type === 'attributes') {
                    translateAttrs(m.target);
                    continue;
                }
                for (const node of m.addedNodes) applyDom(node);
            }
        });
        observer.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ATTRS,
        });
    }

    function wrapSwalOptions(options) {
        if (options && typeof options === 'object' && !Array.isArray(options)) {
            options = { ...options };
            for (const k of ['title', 'text', 'html', 'confirmButtonText', 'denyButtonText', 'cancelButtonText', 'footer', 'inputPlaceholder', 'inputLabel']) {
                if (typeof options[k] === 'string') options[k] = tr(options[k]);
            }
            if (typeof options.inputValidator === 'function') {
                const orig = options.inputValidator;
                options.inputValidator = async (...args) => tr(await orig(...args));
            }
            if (typeof options.preConfirm === 'function') {
                const orig = options.preConfirm;
                options.preConfirm = (...args) => orig(...args);
            }
        }
        return options;
    }

    function wrap() {
        if (typeof window.setTippy === 'function') {
            const orig = window.setTippy;
            window.setTippy = (elem, content, placement, allowHTML) => orig(elem, tr(content), placement, allowHTML);
        }
        if (typeof window.userLog === 'function') {
            const orig = window.userLog;
            window.userLog = (icon, message, position, timer) => orig(icon, tr(message), position, timer);
        }
        if (window.RoomClient && window.RoomClient.prototype) {
            const proto = window.RoomClient.prototype;
            for (const name of ['userLog', 'msgPopup']) {
                if (typeof proto[name] === 'function') {
                    const orig = proto[name];
                    proto[name] = function (a, message, ...rest) {
                        return orig.call(this, a, tr(message), ...rest);
                    };
                }
            }
            if (typeof proto.toast === 'function') {
                const orig = proto.toast;
                proto.toast = function (icon, title, text, ...rest) {
                    return orig.call(this, icon, tr(title), tr(text), ...rest);
                };
            }
            if (typeof proto.setTippy === 'function') {
                const orig = proto.setTippy;
                proto.setTippy = function (elem, content, placement, allowHTML) {
                    return orig.call(this, elem, tr(content), placement, allowHTML);
                };
            }
        }
        if (window.Swal && typeof window.Swal.fire === 'function') {
            const origFire = window.Swal.fire.bind(window.Swal);
            window.Swal.fire = (options, ...rest) => origFire(wrapSwalOptions(options), ...rest);
            const origMixin = window.Swal.mixin.bind(window.Swal);
            window.Swal.mixin = (mixinOptions) => {
                const inst = origMixin(wrapSwalOptions(mixinOptions));
                const instFire = inst.fire.bind(inst);
                inst.fire = (options, ...r) => instFire(wrapSwalOptions(options), ...r);
                return inst;
            };
            if (typeof window.Swal.showValidationMessage === 'function') {
                const origSVM = window.Swal.showValidationMessage.bind(window.Swal);
                window.Swal.showValidationMessage = (message) => origSVM(tr(message));
            }
        }
    }

    function set(next) {
        if (!LANGS.includes(next)) return;
        try {
            localStorage.setItem('MM_LANG', next);
        } catch (e) {}
        window.location.reload();
    }

    // Settings > Language tab: our selector; the async Google widget mount is hidden
    function mountSelector() {
        const host = document.getElementById('google_translate_element');
        if (!host || document.getElementById('mmLangSelect')) return;
        const NAMES = { uk: 'Українська', ru: 'Русский', en: 'English' };
        const sel = document.createElement('select');
        sel.id = 'mmLangSelect';
        sel.className = 'form-select';
        sel.style.cssText = 'width:100%;max-width:220px;padding:8px 10px;border-radius:8px;font-size:14px;';
        for (const code of LANGS) {
            const o = document.createElement('option');
            o.value = code;
            o.textContent = NAMES[code];
            if (code === lang) o.selected = true;
            sel.appendChild(o);
        }
        sel.addEventListener('change', () => set(sel.value));
        host.style.display = 'none';
        host.parentElement.insertBefore(sel, host);
    }

    // wrap immediately: this script loads after Room.js/RoomClient.js definitions
    wrap();

    document.addEventListener('DOMContentLoaded', () => {
        mountSelector();
        document.documentElement.lang = lang;
        if (domActive) {
            applyAll();
            observe();
            // late-built panels that replace big chunks wholesale
            setTimeout(applyAll, 3000);
        }
    });

    return { lang, t: tr, set };
})();

// our Montemeet modules translate their runtime strings through this
window.mmT = (s) => MontemeetI18n.t(s);
