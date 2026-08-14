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
 *
 * Switching is LIVE (no page reload — a reload would drop a student back into
 * the lobby): every touched text node / attribute keeps its source string in
 * __mmSrc/__mmOut expandos, tooltips are re-created from remembered originals.
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

    let lang = pick();
    const D = window.MontemeetDict || { MSG: {}, RULES: [], STATIC: [] };

    // translate one string: exact MSG match, then RULES (regex templates);
    // stock markup mixes &nbsp; into labels ("🎥&nbsp;Default") — match on plain spaces
    function tr(text) {
        if (typeof text !== 'string' || !text) return text;
        const norm = text.replace(/ /g, ' ');
        // long copy wraps across indented lines — keys match on collapsed
        // single spaces, the node's outer whitespace survives
        const key = norm.trim().replace(/\s+/g, ' ');
        if (!key || key.length > 400) return text;
        const lead = /^\s*/.exec(norm)[0];
        const trail = /\s*$/.exec(norm.slice(lead.length))[0];
        const hit = D.MSG[key];
        if (hit && hit[lang] != null) return lead + hit[lang] + trail;
        for (const rule of D.RULES) {
            const m = rule.re.exec(key);
            if (m && rule[lang]) {
                return lead + rule[lang].replace(/\$(\d)/g, (_, n) => m[Number(n)] ?? '') + trail;
            }
        }
        return text;
    }

    // Source tracking for live re-translation: __mmSrc holds the stock string,
    // __mmOut what we last wrote. A current value matching neither means the
    // stock code wrote a fresh string — it becomes the new source.
    function translateTextNode(node) {
        const cur = node.nodeValue;
        if (node.__mmSrc == null || (cur !== node.__mmSrc && cur !== node.__mmOut)) node.__mmSrc = cur;
        const out = tr(node.__mmSrc);
        node.__mmOut = out;
        if (out !== cur) node.nodeValue = out;
    }

    function translateAttrs(el) {
        if (!el.getAttribute) return;
        for (const a of ATTRS) {
            const cur = el.getAttribute(a);
            if (!cur) continue;
            const src = el.__mmSrcA || (el.__mmSrcA = {});
            const prev = el.__mmOutA || (el.__mmOutA = {});
            if (src[a] == null || (cur !== src[a] && cur !== prev[a])) src[a] = cur;
            const out = tr(src[a]);
            prev[a] = out;
            if (out !== cur) el.setAttribute(a, out);
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
        // explicit overrides / html-bearing entries; the stock value is kept so
        // switching to en (no entry) restores it
        for (const [selector, kind, byLang] of D.STATIC) {
            for (const el of document.querySelectorAll(selector)) {
                const store = el.__mmStatic || (el.__mmStatic = {});
                if (store[kind] == null) {
                    store[kind] = kind === 'text' ? el.textContent : kind === 'html' ? el.innerHTML : el.getAttribute(kind);
                }
                const value = byLang[lang] != null ? byLang[lang] : store[kind];
                if (value == null) continue;
                if (kind === 'text') {
                    if (el.textContent !== value) el.textContent = value;
                } else if (kind === 'html') {
                    if (el.innerHTML !== value) el.innerHTML = value;
                } else if (el.getAttribute(kind) !== value) {
                    el.setAttribute(kind, value);
                }
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

    // tooltips are created with an already-translated string — remember the raw
    // one so a live language switch can rebuild them
    const TIPS = new Map();
    function rememberTip(fn, self, args) {
        if (typeof args[1] === 'string') TIPS.set(args[0], { fn, self, args });
    }
    function reapplyTips() {
        for (const { fn, self, args } of TIPS.values()) {
            try {
                fn.call(self, args[0], tr(args[1]), args[2], args[3]);
            } catch (e) {}
        }
    }

    function wrapSwalOptions(options) {
        if (options && typeof options === 'object' && !Array.isArray(options)) {
            options = { ...options };
            // stock popups without an explicit background get Swal's white while
            // the theme colors text white → invisible; default to the theme bg
            if (options.background === undefined && typeof swalBackground !== 'undefined' && swalBackground) {
                options.background = swalBackground;
            }
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
            window.setTippy = (elem, content, placement, allowHTML) => {
                rememberTip(orig, null, [elem, content, placement, allowHTML]);
                return orig(elem, tr(content), placement, allowHTML);
            };
        }
        if (typeof window.userLog === 'function') {
            const orig = window.userLog;
            window.userLog = (icon, message, position, timer) => orig(icon, tr(message), position, timer);
        }
        // RoomClient объявлен как class верхнего уровня: на window его нет, и
        // проверка `window.RoomClient` никогда не срабатывала — обёртки ниже не
        // ставились вовсе, а всплывающие подсказки, которые сток строит из кода,
        // так и оставались английскими (найдено 2026-08-14).
        const rcProto = typeof RoomClient !== 'undefined' ? RoomClient.prototype : null;
        if (rcProto && typeof rcProto.userLog === 'function') {
            const proto = rcProto;
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
                    rememberTip(orig, this, [elem, content, placement, allowHTML]);
                    return orig.call(this, elem, tr(content), placement, allowHTML);
                };
            }
        }
        if (window.Swal && typeof window.Swal.fire === 'function') {
            // Обёртки НЕ привязываем к самому Swal. Swal.mixin() возвращает
            // подкласс, а fire у него — унаследованная статика, которая строит
            // окно через `new this(...)`. Жёсткая привязка к базовому классу
            // подменяла this, и mixin-параметры (toast, position, timer,
            // showConfirmButton) молча терялись: КАЖДЫЙ тост в конференции
            // выходил модальным окном с кнопкой «Хорошо» посреди экрана
            // (Иван, 2026-08-14 — «высветился какой-то попап»).
            const origFire = window.Swal.fire;
            window.Swal.fire = function (options, ...rest) {
                return origFire.call(this, wrapSwalOptions(options), ...rest);
            };
            const origMixin = window.Swal.mixin;
            window.Swal.mixin = function (mixinOptions) {
                return origMixin.call(this, wrapSwalOptions(mixinOptions));
            };
            if (typeof window.Swal.showValidationMessage === 'function') {
                const origSVM = window.Swal.showValidationMessage.bind(window.Swal);
                window.Swal.showValidationMessage = (message) => origSVM(tr(message));
            }
        }
    }

    // live switch — no reload (a reload would kick a student back into the lobby)
    function set(next) {
        if (!LANGS.includes(next) || next === lang) return;
        lang = next;
        try {
            localStorage.setItem('MM_LANG', next);
        } catch (e) {}
        document.documentElement.lang = next;
        applyAll();
        reapplyTips();
        const sel = document.getElementById('mmLangSelect');
        if (sel && sel.value !== next) sel.value = next;
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
        // always active (even for en): the source-tracking pass is what makes a
        // later live switch possible, and for en it is a near-no-op
        applyAll();
        observe();
        // late-built panels that replace big chunks wholesale
        setTimeout(applyAll, 3000);
    });

    return {
        get lang() {
            return lang;
        },
        t: tr,
        set,
    };
})();

// our Montemeet modules translate their runtime strings through this
window.mmT = (s) => MontemeetI18n.t(s);
