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
        // an active screen share replaces the anchor's camera (Ivan, 2026-08-05)
        const screenEl = peerScreenVideo(peerId);
        if (screenEl) return screenEl.id;
        const videoEl = rc.getVideoElementByPeerId(peerId);
        return videoEl ? videoEl.id : null;
    }

    // Show the anchor if the room is anchored and nothing else claims the screen
    function ensureDefault() {
        if (!anchorMode || typeof rc === 'undefined' || !rc) return;
        if (soloActive) return; // the 1:1 layout owns the screen
        const id = anchorVideoId(); // prefers the anchor's screen share
        if (anchorView === 'pin' && !rc.isMobileDevice) {
            if (manualPinActive() || current() !== null) return;
            if (auto) return; // the teacher's speaker view owns pinning
            if (!id) return;
            if (rc.isVideoPinned) {
                if (rc.pinnedVideoPlayerId === id) return;
                unpin(); // the anchor started/stopped sharing → swap the pin
            }
            pinByVideoEl(document.getElementById(id));
            return;
        }
        if (rc.isVideoPinned || current() !== null) return; // manual layout wins
        if (id) focusOn(id);
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
                lastDom = dom;
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
    // upstream — synthetic clicks are allowed here only (see ensureDefault).
    // The strip order must not depend on who spoke (Ivan, 2026-08-04), so a
    // programmatic pin remembers the tile's place and unpin puts it back
    // (stock unpin appends the tile to the end).
    const stripRestore = new Map(); // camId -> next sibling camId (null = was last)

    // Stock pin/focus clicks play a UI sound — automated switches must be silent
    function silentClick(el) {
        if (!el) return;
        if (typeof rc !== 'undefined' && rc && typeof rc.sound === 'function') {
            const orig = rc.sound;
            rc.sound = () => {};
            try {
                el.click();
            } finally {
                rc.sound = orig;
            }
        } else {
            el.click();
        }
    }

    // Screen-share videos carry no name attribute — only volumeBar (upstream)
    function peerScreenVideo(peerId) {
        return document.querySelector(`video[volumeBar="${peerId}___pVolume"]:not([name])`) || null;
    }

    function anyRemoteScreenVideo() {
        for (const el of document.querySelectorAll('video[volumeBar]:not([name])')) {
            const owner = (el.getAttribute('volumeBar') || '').replace(/___pVolume$/, '');
            if (owner && owner !== selfId()) return el;
        }
        return null;
    }

    // Our layout rules own screen shares and pins in profile rooms
    function managedRoom() {
        return !!(anchorMode || concertRoom);
    }

    function syncPinnedClass() {
        if (typeof rc !== 'undefined' && rc) {
            // sanitize a dead pin: the pinned tile can vanish with its peer
            // (e.g. a screen share ended) leaving the stock flag stuck
            if (rc.isVideoPinned && rc.pinnedVideoPlayerId && !document.getElementById(rc.pinnedVideoPlayerId)) {
                rc.isVideoPinned = false;
                rc.pinnedVideoPlayerId = null;
                programmaticPinId = null;
                try {
                    rc.removeVideoPinMediaContainer();
                } catch (e) {
                    /* container already gone */
                }
            }
        }
        document.body.classList.toggle('montemeet-pinned', !!(typeof rc !== 'undefined' && rc && rc.isVideoPinned));
    }

    function unpin() {
        if (typeof rc === 'undefined' || !rc.isVideoPinned || !rc.pinnedVideoPlayerId) return;
        const camId = containerId(rc.pinnedVideoPlayerId);
        silentClick(document.getElementById(rc.pinnedVideoPlayerId + '__pin'));
        programmaticPinId = null;
        if (stripRestore.has(camId)) {
            const nextId = stripRestore.get(camId);
            stripRestore.delete(camId);
            const cam = document.getElementById(camId);
            const next = nextId ? document.getElementById(nextId) : null;
            if (cam && next && next.parentElement === cam.parentElement) {
                cam.parentElement.insertBefore(cam, next);
            }
        }
        syncPinnedClass();
        // the stock unpin resized while our strip classes were still applied
        if (typeof resizeVideoMedia === 'function') resizeVideoMedia();
    }

    function pinByVideoEl(videoEl) {
        if (!videoEl) return false;
        if (rc.isVideoPinned) {
            if (rc.pinnedVideoPlayerId === videoEl.id) return true;
            if (manualPinActive()) return false; // never fight a manual pin
            unpin();
        }
        const cam = document.getElementById(containerId(videoEl.id));
        if (cam) stripRestore.set(cam.id, cam.nextElementSibling?.id ?? null);
        silentClick(document.getElementById(videoEl.id + '__pin'));
        const ok = rc.isVideoPinned && rc.pinnedVideoPlayerId === videoEl.id;
        if (ok) programmaticPinId = videoEl.id;
        syncPinnedClass();
        // re-run the layout with the final strip classes in place
        if (typeof resizeVideoMedia === 'function') resizeVideoMedia();
        return ok;
    }

    async function pinByPeer(peerId) {
        return pinByVideoEl(await resolvePeerVideo(peerId));
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

    // Concert big view: pin + tile strip on desktop (Ivan, 2026-08-05 — the
    // other participants stay visible as small tiles), focus on mobile.
    function concertPinView() {
        return anchorView === 'pin' && typeof rc !== 'undefined' && rc && !rc.isMobileDevice;
    }

    async function applyConcert() {
        if (!auto || typeof rc === 'undefined') return;
        if (soloActive) return; // the 1:1 layout owns the screen
        if (manualPinActive()) return; // a hand-made pin always wins
        let shownDom = false;
        if (dom && dom !== selfId()) {
            shownDom = concertPinView() ? await pinByPeer(dom) : await focusByPeer(dom);
        }
        if (!shownDom) {
            // silence, self is dominant, or the dominant has no video here
            if (isHost()) {
                concertPinView() ? unpin() : focusOff(); // grid of the others
            } else {
                const id = anchorVideoId();
                if (concertPinView()) {
                    id ? pinByVideoEl(document.getElementById(id)) : unpin();
                } else {
                    id ? focusOn(id) : focusOff();
                }
            }
        }
        // last — a re-layout above re-shows every sibling, including our own
        // tile; a full resize keeps the grid honest after class/visibility flips
        hideSelf();
        if (typeof resizeVideoMedia === 'function') resizeVideoMedia();
    }

    // ---------- teacher's view switch at group lessons (2.4+) ----------
    // A toolbar button for the teacher in view:'pin' rooms cycles three views:
    //   'grid'   (default) — the plain grid of students;
    //   'sticky' — the active/LAST speaker stays pinned big with the tile
    //              strip; silence changes nothing;
    //   'auto'   — the active speaker pinned, silence returns the grid.
    // The button's icon shows what the NEXT click will give (Ivan, 2026-08-04).

    const VIEW_CYCLE = ['grid', 'sticky', 'auto'];
    // The button shows the CURRENT state (Ivan, 2026-08-05), always lime.
    const VIEW_ICON = {
        // grid: four cells
        grid: '<svg viewBox="0 0 16 16" width="19" height="19" fill="currentColor"><rect x="1" y="1" width="6.4" height="6.4" rx="1"/><rect x="8.6" y="1" width="6.4" height="6.4" rx="1"/><rect x="1" y="8.6" width="6.4" height="6.4" rx="1"/><rect x="8.6" y="8.6" width="6.4" height="6.4" rx="1"/></svg>',
        // sticky: one big cell right, small tiles left
        sticky: '<svg viewBox="0 0 16 16" width="19" height="19" fill="currentColor"><rect x="1" y="1" width="4" height="4" rx="0.8"/><rect x="1" y="6" width="4" height="4" rx="0.8"/><rect x="1" y="11" width="4" height="4" rx="0.8"/><rect x="6.4" y="1" width="8.6" height="14" rx="1"/></svg>',
        // auto: the word in a cell-like frame (padded so the frame clears the text)
        auto: '<svg viewBox="0 0 20 16" width="23" height="19"><rect x="0.75" y="1.75" width="18.5" height="12.5" rx="2" fill="none" stroke="currentColor" stroke-width="1.4"/><text x="10" y="8" dominant-baseline="central" text-anchor="middle" font-size="4.6" font-family="sans-serif" font-weight="bold" letter-spacing="0.3" fill="currentColor">AUTO</text></svg>',
    };
    const VIEW_TITLE = {
        grid: 'Вид: сетка (клик — говорящий крупно)',
        sticky: 'Вид: говорящий крупно, остаётся (клик — авто-возврат в сетку)',
        auto: 'Вид: говорящий крупно, тишина возвращает сетку (клик — сетка)',
    };

    let speakerView = 'grid';
    let layoutCfg = null;
    let programmaticPinId = null; // pinnedVideoPlayerId set by US (manual pins win)
    let lastDom = null; // last non-null dominant — engaging sticky/auto starts from them

    function manualPinActive() {
        return !!(rc?.isVideoPinned && rc.pinnedVideoPlayerId && rc.pinnedVideoPlayerId !== programmaticPinId);
    }

    async function applyGroupSpeaker() {
        if (typeof rc === 'undefined') return;
        if (soloActive) return; // the 1:1 layout owns the screen
        if (manualPinActive()) return; // the teacher pinned someone by hand — obey
        // a student's screen share outranks the speaker logic on the teacher's side
        const screenEl = anyRemoteScreenVideo();
        if (screenEl) {
            await pinByVideoEl(screenEl);
            return;
        }
        if (dom && dom !== selfId()) {
            const ok = await pinByPeer(dom);
            if (ok) return;
        }
        // silence, self speaking, or no video for the dominant:
        if (speakerView === 'sticky') return; // keep the LAST speaker pinned
        unpin(); // 'auto' → back to the grid
    }

    function updateSpeakerViewButton() {
        const btn = document.getElementById('montemeetSpeakerViewBtn');
        if (!btn) return;
        btn.innerHTML = VIEW_ICON[speakerView];
        btn.title = VIEW_TITLE[speakerView];
        btn.style.color = 'lime';
    }

    function cycleSpeakerView() {
        speakerView = VIEW_CYCLE[(VIEW_CYCLE.indexOf(speakerView) + 1) % VIEW_CYCLE.length];
        try {
            localStorage.setItem('MONTEMEET_SPEAKER_VIEW', speakerView);
        } catch (e) {
            /* localStorage unavailable */
        }
        if (speakerView === 'grid') {
            disengageAuto();
            unpin();
        } else {
            if (!auto || auto.apply !== applyGroupSpeaker) {
                engageAuto({
                    holdMs: layoutCfg?.holdMs ?? 1500,
                    silenceMs: layoutCfg?.silenceMs ?? 4000,
                    minVolume: layoutCfg?.minVolume ?? 2,
                    apply: applyGroupSpeaker,
                });
            }
            // don't wait for the next speech — start from the LAST speaker,
            // or from the first remote participant when nobody spoke yet
            if (dom === null) {
                if (!lastDom) {
                    for (const el of document.querySelectorAll('video[name]')) {
                        const p = el.getAttribute('name');
                        if (p && p !== selfId()) {
                            lastDom = p;
                            break;
                        }
                    }
                }
                if (lastDom) {
                    dom = lastDom;
                    lastActivityTs = Date.now();
                }
            }
            applyGroupSpeaker();
        }
        updateSpeakerViewButton();
    }

    // ---------- solo (1:1) layout, Google-Meet style (Ivan, 2026-08-05) ----------
    // Lessons with exactly two participants: the companion fullscreen, the own
    // tile as a small overlay in the corner; the view-cycle button is hidden.
    // Entering/leaving is automatic as the third participant joins/leaves.

    let soloActive = false;
    let concertRoom = false;

    function markSelfPip() {
        const videoEl = rc?.getVideoElementByPeerId?.(selfId());
        const cam = videoEl ? document.getElementById(containerId(videoEl.id)) : null;
        for (const el of document.querySelectorAll('.montemeet-self-pip')) {
            if (el !== cam) el.classList.remove('montemeet-self-pip');
        }
        if (cam) cam.classList.add('montemeet-self-pip');
    }

    function clearSelfPip() {
        for (const el of document.querySelectorAll('.montemeet-self-pip')) el.classList.remove('montemeet-self-pip');
    }

    // rc.peers is a join-time snapshot (the first joiner never learns about
    // later peers there) — the DOM is the live source of participant identity
    function livePeerIds() {
        const ids = new Set();
        for (const el of document.querySelectorAll('video[name]')) ids.add(el.getAttribute('name'));
        for (const el of document.querySelectorAll('video[volumeBar]:not([name])')) {
            ids.add((el.getAttribute('volumeBar') || '').replace(/___pVolume$/, ''));
        }
        for (const el of document.querySelectorAll('[id$="__videoOff"]')) ids.add(el.id.replace(/__videoOff$/, ''));
        ids.delete('');
        if (selfId()) ids.add(selfId());
        return ids;
    }

    function companionPeerId() {
        for (const id of livePeerIds()) {
            if (id !== selfId()) return id;
        }
        return null;
    }

    async function applySolo() {
        const companion = companionPeerId();
        if (!companion) return;
        const videoEl = peerScreenVideo(companion) || (await resolvePeerVideo(companion));
        if (videoEl) focusOn(videoEl.id);
        markSelfPip();
    }

    // Solo also applies at concerts with a single online guest (Ivan,
    // 2026-08-05): the guest and the hall see each other Meet-style instead
    // of an empty strip; the self tile becomes visible there by design.
    function syncSolo() {
        if (!anchorMode || typeof rc === 'undefined' || !rc) return;
        const peerCount = livePeerIds().size;
        const shouldSolo = peerCount === 2 && !rc.isMobileDevice;
        const btn = document.getElementById('montemeetSpeakerViewBtn');
        // the view button makes sense only with an actual group (3+): hidden
        // when the teacher sits alone and in the solo 1:1 layout
        if (btn) btn.style.display = !shouldSolo && peerCount >= 3 ? '' : 'none';
        if (shouldSolo === soloActive) {
            if (soloActive) applySolo(); // keep in shape (screen share swaps etc.)
            return;
        }
        soloActive = shouldSolo;
        document.body.classList.toggle('montemeet-solo', soloActive);
        if (soloActive) {
            if (auto && auto.apply === applyGroupSpeaker) disengageAuto();
            speakerView = 'grid';
            updateSpeakerViewButton();
            unpin();
            applySolo();
        } else {
            clearSelfPip();
            if (concertRoom) {
                // the concert machinery re-applies on the same observer tick
                focusOff();
            } else if (anchorView === 'pin' && !rc.isMobileDevice) {
                focusOff();
                ensureDefault();
            }
            // focus view keeps an existing focus (companion/anchor or the new speaker)
        }
    }

    // Concert splash: an image (profile layout.splash) fills the stage when no
    // other participant's video is visible (nobody online / all cameras off).
    // The admin cabinet will manage the image later — the mechanics live here.
    function syncConcertSplash() {
        if (!concertRoom) return;
        const url = layoutCfg?.splash;
        if (!url) return;
        const others = [
            ...document.querySelectorAll(
                '#videoMediaContainer video[name], #videoPinMediaContainer video[name],' +
                    '#videoMediaContainer video[volumeBar]:not([name]), #videoPinMediaContainer video[volumeBar]:not([name])'
            ),
        ].filter((v) => {
            const owner = v.getAttribute('name') || (v.getAttribute('volumeBar') || '').replace(/___pVolume$/, '');
            if (!owner || owner === selfId()) return false;
            const cam = v.closest('.Camera');
            return !cam || cam.style.display !== 'none';
        });
        let el = document.getElementById('montemeetSplash');
        if (others.length === 0 && !el) {
            el = document.createElement('div');
            el.id = 'montemeetSplash';
            el.style.cssText = `position:fixed;inset:0;z-index:6;background:#000 url('${url}') center/contain no-repeat;`;
            document.body.appendChild(el);
        } else if (others.length > 0 && el) {
            el.remove();
        }
    }

    // The button appears only for the presenter in pin-view rooms on desktop;
    // isPresenter settles after join, so creation is retried on DOM changes.
    function maybeCreateSpeakerViewButton() {
        if (anchorView !== 'pin' || !isHost() || concertRoom) return;
        if (typeof rc === 'undefined' || !rc || rc.isMobileDevice) return;
        if (document.getElementById('montemeetSpeakerViewBtn')) return;
        const bar = document.getElementById('bottomButtons');
        if (!bar) return;
        const btn = document.createElement('button');
        btn.id = 'montemeetSpeakerViewBtn';
        btn.addEventListener('click', cycleSpeakerView);
        bar.appendChild(btn);
        // restore the teacher's last chosen view (lesson rooms only — the
        // button never exists at concerts, so the memory cannot leak there)
        try {
            const saved = localStorage.getItem('MONTEMEET_SPEAKER_VIEW');
            if (saved && VIEW_CYCLE.includes(saved) && saved !== 'grid' && !soloActive) {
                speakerView = saved;
                engageAuto({
                    holdMs: layoutCfg?.holdMs ?? 1500,
                    silenceMs: layoutCfg?.silenceMs ?? 4000,
                    minVolume: layoutCfg?.minVolume ?? 2,
                    apply: applyGroupSpeaker,
                });
            }
        } catch (e) {
            /* localStorage unavailable */
        }
        updateSpeakerViewButton();
    }

    (async () => {
        try {
            await MontemeetProfile.ready;
            const layout = MontemeetProfile.layout();
            layoutCfg = layout;
            anchorMode = layout?.anchor ?? null;
            anchorView = layout?.view ?? 'focus';
            if (anchorView === 'pin') document.body.classList.add('montemeet-strip');
            const isConcert = layout?.mode === 'concert';
            concertRoom = isConcert;
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
                    syncPinnedClass();
                    syncSolo();
                    if (isConcert) syncConcertSplash();
                    if (soloActive) return;
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

    return {
        current,
        isFocused,
        focusOn,
        focusOff,
        ensureDefault,
        autoActive,
        onDominant,
        noteActivity,
        syncPinnedClass,
        managedRoom,
    };
})();
