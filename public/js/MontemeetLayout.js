'use strict';

/*
 * Montemeet: single owner for PROGRAMMATIC layout control (stage 2.1).
 *
 * Anything that drives the layout from code — dominant-speaker auto focus,
 * follow-me, the future concert/lesson rules — must go through this module
 * instead of clicking buttons or mutating styles. User clicks keep working
 * unchanged, therefore the DOM ([focus-mode] attribute) is the source of
 * truth, not module state.
 *
 * Id convention (upstream): X = producer/consumer id; video container is
 * `${X}__video`, the focus button `${X}__hideALL`, the pin button `${X}__pin`.
 * Stock toggleFocusMode() is a TOGGLE with a global flag; this module wraps
 * it into idempotent focusOn/focusOff with explicit target state.
 *
 * The pin path intentionally stays button-driven (its logic lives inside the
 * button's click closure upstream; pinning is a manual presenter feature and
 * not part of the automated layouts).
 */

const MontemeetLayout = (() => {
    const containerId = (id) => id + '__video';
    const container = (id) => document.getElementById(containerId(id));
    const focusBtn = (id) => document.getElementById(id + '__hideALL');

    // Currently focused producer/consumer id, or null
    function current() {
        if (typeof rc === 'undefined' || !rc?.videoMediaContainer) return null;
        const el = rc.videoMediaContainer.querySelector('[focus-mode]');
        return el ? el.id.replace(/__video$/, '') : null;
    }

    function isFocused(id) {
        const el = container(id);
        return !!el && el.hasAttribute('focus-mode');
    }

    // Idempotent: focus the given video, unfocusing whatever else was focused
    function focusOn(id) {
        if (typeof rc === 'undefined' || !container(id)) return false;
        const cur = current();
        if (cur === id) return true;
        if (cur !== null) rc.toggleFocusMode(containerId(cur), focusBtn(cur));
        rc.toggleFocusMode(containerId(id), focusBtn(id));
        return isFocused(id);
    }

    // Idempotent: remove focus. With an id — only if that id is the focused one.
    function focusOff(id = null) {
        if (typeof rc === 'undefined') return false;
        const cur = current();
        if (cur === null) return true;
        if (id !== null && cur !== id) return true;
        rc.toggleFocusMode(containerId(cur), focusBtn(cur));
        return current() === null;
    }

    return { current, isFocused, focusOn, focusOff };
})();
