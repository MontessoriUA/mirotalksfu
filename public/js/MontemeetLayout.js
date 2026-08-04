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
        if (!el) return null;
        // Self-heal: the attribute without the global flag is a stale leftover
        // (see the addConsumer reset upstream) — clean it up and report no focus
        if (typeof isHideALLVideosActive !== 'undefined' && !isHideALLVideosActive) {
            el.removeAttribute('focus-mode');
            el.style.width = '';
            el.style.height = '';
            return null;
        }
        return el.id.replace(/__video$/, '');
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

    // ---------- room anchor (stage 2.2 + 2.4) ----------
    // profile.layout.anchor === 'presenter': the presenter (Зал at concerts,
    // the teacher at lessons) is the DEFAULT view — whenever nothing else is
    // focused, show the anchor. One never watches oneself: if I am the anchor
    // (or the anchor has no video here), the grid stays.
    //
    // profile.layout.view selects HOW the anchor is shown (stage 2.4):
    //   'focus' (default) — anchor fullscreen, others hidden (1:1 lessons);
    //   'pin'             — anchor big, everyone else as a tile strip
    //                       (group lessons). Falls back to 'focus' on mobile,
    //                       where the stock pin is disabled.

    let anchorMode = null;
    let anchorView = 'focus';

    function anchorPeerId() {
        if (typeof rc === 'undefined' || !rc?.peers) return null;
        for (const [peerId, peer] of rc.peers) {
            if (peerId !== rc.peer_id && peer?.peer_info?.peer_presenter) return peerId;
        }
        return null;
    }

    function anchorVideoId() {
        const peerId = anchorPeerId();
        if (!peerId) return null;
        const videoEl = rc.getVideoElementByPeerId(peerId);
        return videoEl ? videoEl.id : null;
    }

    // Show the anchor if the room is anchored and nothing else claims the screen
    function ensureDefault() {
        if (!anchorMode || typeof rc === 'undefined') return;
        if (rc.isVideoPinned || current() !== null) return; // manual layout wins
        const id = anchorVideoId();
        if (!id) return;
        if (anchorView === 'pin' && !rc.isMobileDevice) {
            // The pin logic lives inside the button's click closure upstream —
            // this is the one place a synthetic click is allowed, encapsulated here.
            const btn = document.getElementById(id + '__pin');
            if (btn) btn.click();
            return;
        }
        focusOn(id);
    }

    // ---------- concert mode (stage 2.3, ТЗ §5) ----------
    // Roles: the presenter is the Host («Зал», the hall machine on the TV),
    // everyone else is a Guest. dom = dominant speaker confirmed by a hold
    // timer; silence = no audio activity above minVolume for silenceMs
    // (heartbeat via the audioVolume events, see RoomClient.handleAudioVolume).
    //
    //           | dom == self       | dom == other     | silence
    //   Host    | grid of others    | focus on dom     | grid of others
    //   Guest   | focus on anchor   | focus on dom     | focus on anchor
    //
    // One never sees oneself: the own tile is hidden in concert rooms.

    // Generalized dominant tracker: any "auto" mode (concert focus, teacher's
    // speaker view at group lessons) plugs its apply() into the same hold
    // timer + silence watchdog machinery.
    let auto = null; // { holdMs, silenceMs, minVolume, apply }
    let dom = null; // confirmed dominant peer id (null = silence)
    let pending = null; // { peerId, timer } — hold in progress
    let lastActivityTs = 0;
    let watchdog = null;

    const selfId = () => (typeof rc !== 'undefined' ? rc.peer_id : null);
    const isHost = () => typeof isPresenter !== 'undefined' && isPresenter;

    function autoActive() {
        return !!auto;
    }

    function engageAuto(cfg) {
        auto = cfg;
        dom = null;
        lastActivityTs = 0;
        if (pending) clearTimeout(pending.timer);
        pending = null;
        if (!watchdog) {
            // silence watchdog: no activity above the threshold → back to default
            watchdog = setInterval(() => {
                if (auto && dom !== null && Date.now() - lastActivityTs > auto.silenceMs) {
                    dom = null;
                    if (pending) {
                        clearTimeout(pending.timer);
                        pending = null;
                    }
                    auto.apply();
                }
            }, 1000);
        }
    }

    function disengageAuto() {
        auto = null;
        dom = null;
        if (pending) clearTimeout(pending.timer);
        pending = null;
    }

    // A candidate must survive holdMs before the layout switches to them
    function holdCandidate(peer_id) {
        if (peer_id === dom) return;
        if (pending?.peerId === peer_id) return; // already holding this candidate
        if (pending) clearTimeout(pending.timer);
        pending = {
            peerId: peer_id,
            timer: setTimeout(() => {
                if (!auto || !pending) return;
                dom = pending.peerId;
                pending = null;
                auto.apply();
            }, auto.holdMs),
        };
    }

    // Heartbeat from audioVolume events (volume 1-10, peer_id = the loudest).
    // Besides feeding the silence watchdog it ALSO nominates the speaker:
    // mediasoup emits dominantspeaker only on CHANGE, so when the same person
    // speaks again after a silence reset, no new dominant event ever arrives —
    // the audio-level stream is what re-elects them.
    function noteActivity(peer_id, volume) {
        if (!auto) return;
        if ((volume ?? 0) < auto.minVolume) return;
        lastActivityTs = Date.now();
        if (peer_id) holdCandidate(peer_id);
    }

    // dominantSpeaker event → same hold machinery
    function onDominant(peer_id) {
        if (!auto || !peer_id) return;
        lastActivityTs = Date.now();
        holdCandidate(peer_id);
    }

    async function resolvePeerVideo(peerId) {
        let videoEl = rc.getVideoElementByPeerId(peerId);
        if (!videoEl) {
            // late joiner — rc.peers/DOM may lag; one refresh + retry
            try {
                const info = await rc.getRoomInfo();
                if (info?.peers) rc.peers = new Map(JSON.parse(info.peers));
            } catch (e) {
                /* keep going */
            }
            videoEl = rc.getVideoElementByPeerId(peerId);
        }
        return videoEl;
    }

    async function focusByPeer(peerId) {
        const videoEl = await resolvePeerVideo(peerId);
        if (videoEl) return focusOn(videoEl.id);
        return false;
    }

    // Pin helpers: the pin logic lives inside the button's click closure
    // upstream — synthetic clicks are allowed here only (see ensureDefault)
    function unpin() {
        if (typeof rc === 'undefined' || !rc.isVideoPinned || !rc.pinnedVideoPlayerId) return;
        document.getElementById(rc.pinnedVideoPlayerId + '__pin')?.click();
    }

    async function pinByPeer(peerId) {
        const videoEl = await resolvePeerVideo(peerId);
        if (!videoEl) return false;
        if (rc.isVideoPinned) {
            if (rc.pinnedVideoPlayerId === videoEl.id) return true;
            unpin();
        }
        document.getElementById(videoEl.id + '__pin')?.click();
        return rc.isVideoPinned && rc.pinnedVideoPlayerId === videoEl.id;
    }

    function hideSelf() {
        const videoEl = rc?.getVideoElementByPeerId?.(selfId());
        const container = videoEl ? document.getElementById(videoEl.id + '__video') : null;
        if (container && container.style.display !== 'none') {
            container.style.display = 'none';
            return true;
        }
        return false;
    }

    async function applyConcert() {
        if (!auto || typeof rc === 'undefined') return;
        let focusedDom = false;
        if (dom && dom !== selfId()) {
            focusedDom = await focusByPeer(dom);
        }
        if (!focusedDom) {
            // silence, self is dominant, or the dominant has no video here
            if (isHost()) {
                focusOff(); // grid of the others
            } else {
                const id = anchorVideoId();
                id ? focusOn(id) : focusOff();
            }
        }
        // last — an unfocus above re-shows every sibling, including our own tile
        if (hideSelf() && typeof resizeVideoMedia === 'function') resizeVideoMedia();
    }

    // ---------- teacher's speaker view at group lessons (2.4+) ----------
    // A toolbar toggle for the teacher in view:'pin' rooms: OFF (default) —
    // the plain grid of students; ON — the current speaker pinned big with
    // the tile strip (same mechanics the students get, anchored to whoever
    // speaks). Silence or the teacher speaking → back to the grid.

    let speakerView = false;
    let layoutCfg = null;

    async function applyGroupSpeaker() {
        if (typeof rc === 'undefined') return;
        if (dom && dom !== selfId()) {
            const ok = await pinByPeer(dom);
            if (ok) return;
        }
        unpin(); // silence, self, or no video → grid
    }

    function toggleSpeakerView() {
        speakerView = !speakerView;
        if (speakerView) {
            engageAuto({
                holdMs: layoutCfg?.holdMs ?? 1500,
                silenceMs: layoutCfg?.silenceMs ?? 4000,
                minVolume: layoutCfg?.minVolume ?? 2,
                apply: applyGroupSpeaker,
            });
        } else {
            disengageAuto();
            unpin();
        }
        const btn = document.getElementById('montemeetSpeakerViewBtn');
        if (btn) {
            btn.style.color = speakerView ? 'lime' : 'white';
            btn.title = speakerView ? 'Speaker view: on (click for grid)' : 'Speaker view: off (click to follow the speaker)';
        }
    }

    // The button appears only for the presenter in pin-view rooms on desktop;
    // isPresenter settles after join, so creation is retried on DOM changes.
    function maybeCreateSpeakerViewButton() {
        if (anchorView !== 'pin' || !isHost()) return;
        if (typeof rc === 'undefined' || rc.isMobileDevice) return;
        if (document.getElementById('montemeetSpeakerViewBtn')) return;
        const bar = document.getElementById('bottomButtons');
        if (!bar) return;
        const btn = document.createElement('button');
        btn.id = 'montemeetSpeakerViewBtn';
        btn.title = 'Speaker view: off (click to follow the speaker)';
        btn.innerHTML = '<i class="fas fa-crosshairs"></i>';
        btn.addEventListener('click', toggleSpeakerView);
        bar.appendChild(btn);
    }

    (async () => {
        try {
            await MontemeetProfile.ready;
            const layout = MontemeetProfile.layout();
            layoutCfg = layout;
            anchorMode = layout?.anchor ?? null;
            anchorView = layout?.view ?? 'focus';
            const isConcert = layout?.mode === 'concert';
            if (isConcert) {
                engageAuto({
                    holdMs: layout.holdMs ?? 1500,
                    silenceMs: layout.silenceMs ?? 4000,
                    minVolume: layout.minVolume ?? 2,
                    apply: applyConcert,
                });
            }
            if (!anchorMode && !isConcert) return;
            const target = document.getElementById('videoMediaContainer');
            if (!target) return;
            // Structural changes only (tiles appear/leave) — a manual unfocus
            // does not add/remove nodes, so it is not overridden by the anchor.
            let t = null;
            new MutationObserver(() => {
                clearTimeout(t);
                t = setTimeout(() => {
                    maybeCreateSpeakerViewButton();
                    if (isConcert) {
                        applyConcert();
                    } else if (auto) {
                        auto.apply();
                    } else {
                        ensureDefault();
                    }
                }, 800);
            }).observe(target, { childList: true });
        } catch (e) {
            /* no profile -> stock behavior */
        }
    })();

    return { current, isFocused, focusOn, focusOff, ensureDefault, autoActive, onDominant, noteActivity };
})();
