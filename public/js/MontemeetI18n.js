'use strict';

/*
 * Montemeet: conference UI translation layer (uk / ru / en, ukrainian default).
 *
 * No stock strings are edited — everything happens at runtime:
 *  - WRAPPERS: the global setTippy()/userLog() (Room.js) AND the RoomClient
 *    prototype methods (setTippy/userLog/toast/msgPopup) plus Swal.fire are
 *    wrapped as soon as this script loads (it is included AFTER Room.js, all
 *    scripts deferred), so every runtime string passes through tr();
 *  - TOOLTIPS installed before the wrap (top-level initClient) are re-applied
 *    from the TOOLTIPS list (id -> stock English source);
 *  - STATIC texts in Room.html are replaced by the STATIC map on
 *    DOMContentLoaded (+ one delayed pass for late-built panels);
 *  - our own Montemeet modules call window.mmT('русская строка') at runtime.
 *
 * Dictionaries live in MontemeetI18n.dict.js (MSG / RULES / STATIC / TOOLTIPS).
 * English is the stock language: en entries exist only for OUR russian-authored
 * strings; a stock string without an entry passes through unchanged.
 *
 * Language priority: localStorage MM_LANG (explicit choice in the conference)
 *  -> mm_lang cookie (the cabinet / landing choice, same domain)
 *  -> 'uk'. The Settings > Language tab hosts the selector (replaces the stock
 * Google-Translate widget).
 */

const MontemeetI18n = (() => {
    const LANGS = ['uk', 'ru', 'en'];

    function pick() {
        try {
            const ls = localStorage.getItem('MM_LANG');
            if (LANGS.includes(ls)) return ls;
        } catch (e) {}
        const m = /(?:^|;\s*)mm_lang=(uk|ru|en)(?:;|$)/.exec(document.cookie || '');
        return m ? m[1] : 'uk';
    }

    const lang = pick();
    const D = window.MontemeetDict || { MSG: {}, RULES: [], STATIC: [], TOOLTIPS: [] };

    // translate one string: exact MSG match, then RULES (regex templates)
    function tr(text) {
        if (typeof text !== 'string' || !text) return text;
        const key = text.trim();
        const hit = D.MSG[key];
        if (hit && hit[lang] != null) return text.replace(key, hit[lang]);
        for (const rule of D.RULES) {
            const m = rule.re.exec(text);
            if (m && rule[lang]) {
                return rule[lang].replace(/\$(\d)/g, (_, n) => m[Number(n)] ?? '');
            }
        }
        return text;
    }

    function applyStatic() {
        for (const [selector, kind, byLang] of D.STATIC) {
            const value = byLang[lang];
            if (value == null) continue;
            for (const el of document.querySelectorAll(selector)) {
                if (kind === 'text') el.textContent = value;
                else if (kind === 'html') el.innerHTML = value;
                else el.setAttribute(kind, value); // placeholder / title / aria-label
            }
        }
    }

    function applyTooltips() {
        if (typeof window.setTippy !== 'function') return;
        for (const [id, source] of D.TOOLTIPS) {
            if (document.getElementById(id)) window.setTippy(id, source, 'top');
        }
    }

    function wrapSwalOptions(options) {
        if (options && typeof options === 'object' && !Array.isArray(options)) {
            options = { ...options };
            for (const k of ['title', 'text', 'html', 'confirmButtonText', 'denyButtonText', 'cancelButtonText', 'footer', 'inputPlaceholder']) {
                if (typeof options[k] === 'string') options[k] = tr(options[k]);
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
            // toasts and steppers go through Swal.mixin(...).fire
            const origMixin = window.Swal.mixin.bind(window.Swal);
            window.Swal.mixin = (mixinOptions) => {
                const inst = origMixin(wrapSwalOptions(mixinOptions));
                const instFire = inst.fire.bind(inst);
                inst.fire = (options, ...r) => instFire(wrapSwalOptions(options), ...r);
                return inst;
            };
        }
    }

    function set(next) {
        if (!LANGS.includes(next)) return;
        try {
            localStorage.setItem('MM_LANG', next);
        } catch (e) {}
        window.location.reload();
    }

    // Settings > Language tab: our selector instead of the Google-Translate widget
    function mountSelector() {
        const host = document.getElementById('google_translate_element');
        if (!host) return;
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
        // the async Google-Translate widget mounts into the host later — park it
        host.style.display = 'none';
        host.parentElement.insertBefore(sel, host);
    }

    // wrap immediately: this script loads after Room.js/RoomClient.js definitions
    wrap();

    document.addEventListener('DOMContentLoaded', () => {
        applyStatic();
        if (lang !== 'en') applyTooltips();
        mountSelector();
        document.documentElement.lang = lang;
        // some panels are (re)built after join — one delayed second pass
        setTimeout(() => {
            applyStatic();
            if (lang !== 'en') applyTooltips();
        }, 3000);
    });

    return { lang, t: tr, set };
})();

// our Montemeet modules translate their runtime strings through this
window.mmT = (s) => MontemeetI18n.t(s);
