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
    // translated at call time by MontemeetI18n (identity until it loads)
    const mmT = (s) => (typeof window.mmT === 'function' ? window.mmT(s) : s);
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
        regrid();
        return current() === null;
    }

    // Сток снимает фокус так: сначала пересчитывает сетку, и только потом
    // возвращает скрытые плитки. В момент пересчёта видимой остаётся ровно
    // одна — та, что была крупной, — и он раскладывает её по правилу «я тут
    // один», то есть шире экрана. Остальные появляются уже под ней, и картинка
    // «залипает»: наш общий проход запускается по изменению состава, а смена
    // режима состав не меняет (Иван, 2026-08-10). Пересчитываем сами, когда все
    // плитки снова на месте.
    function regrid() {
        if (typeof resizeVideoMedia !== 'function') return;
        resizeVideoMedia();
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

    // rc.peers — снимок состава на момент входа: вошедший раньше никогда не
    // узнает из него о вошедших позже, а после перезахода педагога там ещё
    // висит его прежний peer. Поэтому карту обновляем с сервера каждый раз,
    // когда состав участников в DOM изменился (вход, выход, перезаход).
    let peersKey = '';
    let peersSyncing = false;
    function syncPeerMap(after) {
        if (typeof rc === 'undefined' || !rc?.getRoomInfo || peersSyncing) return;
        const key = [...livePeerIds()].sort().join(',');
        if (key === peersKey) return;
        peersSyncing = true;
        rc.getRoomInfo()
            .then((info) => {
                if (!info?.peers) return;
                rc.peers = new Map(JSON.parse(info.peers));
                // ключ берём на момент ответа: состав мог смениться и в полёте
                peersKey = [...livePeerIds()].sort().join(',');
                if (typeof after === 'function') after();
            })
            .catch(() => {
                /* следующий тик попробует снова */
            })
            .finally(() => {
                peersSyncing = false;
            });
    }

    // Якорь — АКТИВНЫЙ презентер, а не первый попавшийся в карте: педагог может
    // сидеть в двух вкладках, а после перезахода в комнате какое-то время
    // остаются оба его peer'а. Порядок предпочтения: демонстрация экрана →
    // включённая камера → кто из них говорил последним → кто угодно.
    const lastSpokeAt = new Map(); // peerId -> ts

    function anchorScore(peerId) {
        if (peerScreenVideo(peerId)) return 3;
        if (rc.getVideoElementByPeerId(peerId)) return 2;
        return 1;
    }

    function anchorPeerId() {
        if (typeof rc === 'undefined' || !rc?.peers) return null;
        const live = livePeerIds();
        const me = selfId();
        const candidates = [];
        for (const [peerId, peer] of rc.peers) {
            if (peerId === me || !live.has(peerId)) continue;
            if (peer?.peer_info?.peer_presenter) candidates.push(peerId);
        }
        if (candidates.length < 2) return candidates[0] ?? null;
        // сортировка в JS стабильная — при полном равенстве останется тот,
        // кто вошёл раньше, и якорь не будет дёргаться туда-сюда
        candidates.sort(
            (a, b) => anchorScore(b) - anchorScore(a) || (lastSpokeAt.get(b) || 0) - (lastSpokeAt.get(a) || 0)
        );
        return candidates[0];
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

    // Тот, кого показывали крупно, вышел из встречи. Ссылки на него надо
    // забыть, иначе «липкий» режим остаётся ни с кем: закреплять некого, и на
    // экране молча висит сетка, хотя кнопка показывает говорящего крупно
    // (Иван, 2026-08-10). «Авто» в этом случае по своим правилам и должен
    // вернуть сетку — тишина, говорить больше некому.
    function pruneDeparted() {
        if (typeof rc === 'undefined' || !rc) return;
        const live = livePeerIds();
        for (const id of lastSpokeAt.keys()) if (!live.has(id)) lastSpokeAt.delete(id);
        if (pending && !live.has(pending.peerId)) {
            clearTimeout(pending.timer);
            pending = null;
        }
        if (lastDom && !live.has(lastDom)) lastDom = null;
        if (dom && !live.has(dom)) {
            dom = null;
            if (auto && auto.apply === applyGroupSpeaker && speakerView === 'sticky') seedPending = true;
        }
    }

    // Флаг «показываем одного крупно» живёт отдельно от пометки на самой плитке.
    // Если плитка исчезла в обход обычного пути, флаг остаётся поднятым, а
    // остальные плитки — скрытыми: на экране одна картинка, и убрать её нечем,
    // потому что снимать фокус уже не с чего (Иван, 2026-08-10).
    function healFocusState() {
        if (typeof rc === 'undefined' || !rc?.videoMediaContainer) return;
        if (typeof isHideALLVideosActive === 'undefined') return;
        const marked = rc.videoMediaContainer.querySelector('[focus-mode]');
        if (!isHideALLVideosActive) {
            // обратный случай: пометка осталась на плитке при опущенном флаге.
            // Для глаза это незаметно, но вёрстка по ней перестраивается —
            // на телефоне сетка теряла прокрутку и плитки уезжали за экран.
            if (marked) {
                marked.removeAttribute('focus-mode');
                marked.style.width = '';
                marked.style.height = '';
            }
            return;
        }
        if (marked) return;
        isHideALLVideosActive = false;
        for (const child of rc.videoMediaContainer.children) {
            // зал на концерте прячет свою плитку сам — её не возвращаем
            if (concertRoom && isHost() && child.classList?.contains('montemeet-self')) continue;
            child.style.display = 'block';
        }
        for (const btn of document.querySelectorAll('.focusMode')) btn.style.color = 'white';
        regrid();
    }

    // Единая точка перекладки: концерт, авто-режим педагога или якорь комнаты.
    // Вызывается и по изменениям DOM, и после обновления карты участников.
    function applyCurrent() {
        healFocusState();
        pruneDeparted();
        if (soloActive) return;
        if (concertRoom) applyConcert();
        else if (auto) auto.apply();
        else ensureDefault();
    }

    // Show the anchor if the room is anchored and nothing else claims the screen
    function ensureDefault() {
        if (!anchorMode || typeof rc === 'undefined' || !rc) return;
        if (soloActive) return; // the 1:1 layout owns the screen
        // Якорь — правило для СТУДЕНТОВ. Педагог смотрит на класс, а не на
        // другого педагога и тем более не на свою же вторую вкладку: у него для
        // этого есть собственные режимы вида. Раньше второй презентер в комнате
        // молча раскрывался у первого на весь экран, хотя кнопка показывала
        // сетку (Иван, 2026-08-09).
        if (isHost()) return;
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
        seedPending = false;
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
                seedPending = false; // настоящий говорящий важнее подобранного
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
    // top === false — это не самый громкий из пришедшей тройки: такой годится
    // для кружочков говорящих, но не для смены того, кого показываем крупно,
    // иначе кандидаты чередуются и выдержка никогда не срабатывает.
    function noteActivity(peer_id, volume, top = true) {
        // отметку о речи ведём всегда, а не только в авто-режимах: по ней
        // выбирается активный якорь, когда презентеров в комнате двое
        if (peer_id && (volume ?? 0) >= (auto?.minVolume ?? 2)) {
            lastSpokeAt.set(peer_id, Date.now());
            noteSpeakingCircle(peer_id);
        }
        if (!auto || !top) return;
        if ((volume ?? 0) < auto.minVolume) return;
        lastActivityTs = Date.now();
        if (peer_id) holdCandidate(peer_id);
    }

    // dominantSpeaker event → same hold machinery.
    // Верим ему только с подтверждением по уровню звука: mediasoup выбирает
    // «доминирующего» и в полной тишине, и на старте концерта это молча
    // раскрывало на весь зал случайного гостя, который ещё не сказал ни слова
    // (Иван, 2026-08-07). Настоящая речь и без этого события поднимает
    // кандидата — через noteActivity, поэтому переключения мы не теряем.
    const DOMINANT_CORROBORATE_MS = 2000;
    function onDominant(peer_id) {
        if (!auto || !peer_id) return;
        if (Date.now() - (lastSpokeAt.get(peer_id) || 0) > DOMINANT_CORROBORATE_MS) return;
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
        if (rc?.isMobileDevice) return focusOff();
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
        if (rc?.isMobileDevice) return focusOn(videoEl.id) !== false;
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
        // the peer's active screen share represents them (Q2(в), Ivan 2026-08-06)
        return pinByVideoEl(peerScreenVideo(peerId) || (await resolvePeerVideo(peerId)));
    }

    async function focusByPeerPreferScreen(peerId) {
        const screenEl = peerScreenVideo(peerId);
        if (screenEl) return focusOn(screenEl.id);
        return focusByPeer(peerId);
    }

    function hideSelf() {
        if (concertRoom && rc?.isMobileDevice && !isHost()) {
            document.body.classList.add('montemeet-concert-pip');
            markSelfPip();
            return;
        }
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
            const epoch = layoutEpoch;
            shownDom = concertPinView() ? await pinByPeer(dom) : await focusByPeerPreferScreen(dom);
            if (epoch !== layoutEpoch) return;
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
        // last — a re-layout above re-shows every sibling; only the HALL hides
        // its own tile (the TV shows guests only), a guest sees themselves in
        // the strip like at lessons (Ivan, 2026-08-06). A full resize keeps
        // the grid honest after class/visibility flips.
        if (isHost()) hideSelf();
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
    // «Авто» отключается из админки. Настройка приходит с сервера асинхронно,
    // поэтому спрашиваем её в момент переключения, а не при загрузке модуля.
    const viewCycle = () =>
        MontemeetProfile.style()?.autoView === false ? VIEW_CYCLE.filter((v) => v !== 'auto') : VIEW_CYCLE;
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
    let seedPending = false; // режим включён, но кандидата ещё не нашли (плитки не готовы)
    // Закрепление и фокус ищут плитку через await, и за это время раскладка
    // могла смениться: например, педагог входит вторым, режим восстанавливается
    // и закрепляет собеседника, а следом включается вид 1:1 и ставит на него же
    // фокус — запоздавшее закрепление ложится поверх (Иван, 2026-08-10, «крупное
    // на крупное»). Каждая смена состояния метит раскладку новым числом, и
    // отложенная перекладка проверяет, не устарела ли она.
    let layoutEpoch = 0;
    const bumpEpoch = () => ++layoutEpoch;
    let manualState = null; // { prevView } while a hand-made pin is on screen

    function manualPinActive() {
        return !!(rc?.isVideoPinned && rc.pinnedVideoPlayerId && rc.pinnedVideoPlayerId !== programmaticPinId);
    }

    // Track manual pins: entering shows the pin icon on the view button,
    // leaving (unpin by any means) restores the mode that was active before
    function syncManualPinState() {
        if (manualPinActive() && !manualState) {
            manualState = { prevView: speakerView };
            updateSpeakerViewButton();
        } else if (!manualPinActive() && manualState) {
            const prev = manualState.prevView;
            manualState = null;
            setSpeakerViewTo(prev);
        }
        // the unpin button is visible only on a MANUALLY pinned big video
        document.body.classList.toggle('montemeet-manualpin', !!manualState);
    }

    // Кого показать крупно, пока никто не заговорил: последний говоривший, если
    // он ещё в комнате, иначе первый участник с ВКЛЮЧЁННОЙ камерой (плитка без
    // видео крупно бесполезна). Себя не выбираем — на себя не смотрят.
    function seedDom() {
        const live = livePeerIds();
        if (lastDom && lastDom !== selfId() && live.has(lastDom)) return lastDom;
        for (const el of document.querySelectorAll('video[name]')) {
            const p = el.getAttribute('name');
            if (p && p !== selfId() && live.has(p)) return p;
        }
        return null;
    }

    async function applyGroupSpeaker() {
        if (typeof rc === 'undefined') return;
        if (soloActive) return; // the 1:1 layout owns the screen
        if (manualPinActive()) return; // the teacher pinned someone by hand — obey
        // режим включили раньше, чем построились плитки — добираем кандидата
        if (dom === null && seedPending) {
            const seed = seedDom();
            if (seed) {
                seedPending = false;
                dom = lastDom = seed;
                lastActivityTs = Date.now();
            }
        }
        // Q2(в): the screen share is the FACE of its owner — focus still picks
        // the SPEAKER, and pinByPeer shows their screen instead of the camera
        // when they have one (a muted sharer never hijacks the view)
        if (dom && dom !== selfId()) {
            const epoch = layoutEpoch;
            const ok = await pinByPeer(dom);
            if (epoch !== layoutEpoch) return; // раскладка успела смениться
            if (ok) return;
        }
        // silence, self speaking, or no video for the dominant:
        if (speakerView === 'sticky') return; // keep the LAST speaker pinned
        unpin(); // 'auto' → back to the grid
    }

    const MANUAL_PIN_ICON =
        '<svg viewBox="0 0 16 16" width="19" height="19" fill="currentColor"><path d="M9.5 1l5.5 5.5-2 2-.9-.3-2.8 2.8.4 3-1.4 1.4L4.7 11.8 1.5 15l-1-1 3.2-3.2L.1 7.2l1.4-1.4 3 .4L7.3 3.4 7 2.5z"/></svg>';

    function updateSpeakerViewButton() {
        const btn = document.getElementById('montemeetSpeakerViewBtn');
        if (!btn) return;
        if (manualState) {
            btn.innerHTML = MANUAL_PIN_ICON;
            btn.title = mmT('Закреплено вручную — клик: вернуть прежний режим');
        } else {
            btn.innerHTML = VIEW_ICON[speakerView];
            btn.title = mmT(VIEW_TITLE[speakerView]);
        }
        btn.style.color = 'lime';
    }

    // seed=true — режим включил ЧЕЛОВЕК, ему нужен отклик сразу: показываем
    // крупно последнего говорившего, а если таких не было — первого участника
    // с включённой камерой. seed=false — режим просто восстановлен (загрузка
    // страницы, возврат из 1:1): пока никто не заговорил, на экране сетка,
    // как и задумано для группового урока.
    function setSpeakerViewTo(view, seed = true) {
        speakerView = VIEW_CYCLE.includes(view) ? view : 'grid';
        bumpEpoch();
        try {
            localStorage.setItem('MONTEMEET_SPEAKER_VIEW', speakerView);
        } catch (e) {
            /* localStorage unavailable */
        }
        if (speakerView === 'grid') {
            disengageAuto();
            unpin();
            // на телефоне «крупно» — это фокус, а не закрепление: если он почему-то
            // не снялся, сетка так и не появится, пока не дождёмся общего прохода
            healFocusState();
        } else {
            if (!auto || auto.apply !== applyGroupSpeaker) {
                engageAuto({
                    holdMs: layoutCfg?.holdMs ?? 1500,
                    silenceMs: layoutCfg?.silenceMs ?? 4000,
                    minVolume: layoutCfg?.minVolume ?? 2,
                    apply: applyGroupSpeaker,
                });
            }
            // Плитки могут ещё строиться (перезаход, телефон): если кандидата
            // нет, помечаем задачу и добираем его на следующем проходе, иначе
            // нажатие кнопки осталось бы без всякого отклика.
            if (seed && dom === null) {
                const picked = seedDom();
                if (picked) {
                    dom = lastDom = picked;
                    lastActivityTs = Date.now();
                }
                seedPending = dom === null;
            }
            applyGroupSpeaker();
        }
        updateSpeakerViewButton();
    }

    function cycleSpeakerView() {
        if (manualState) {
            // exit the manual pin and restore the mode active before it
            const prev = manualState.prevView;
            manualState = null;
            unpin();
            setSpeakerViewTo(prev);
            return;
        }
        setSpeakerViewTo(viewCycle()[(viewCycle().indexOf(speakerView) + 1) % viewCycle().length]);
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
        const epoch = layoutEpoch;
        const videoEl = peerScreenVideo(companion) || (await resolvePeerVideo(companion));
        if (epoch !== layoutEpoch) return; // вышли из 1:1, пока искали плитку
        if (videoEl) focusOn(videoEl.id);
        markSelfPip();
    }

    // Solo also applies at concerts with a single online guest (Ivan,
    // 2026-08-05): the guest and the hall see each other Meet-style instead
    // of an empty strip; the self tile becomes visible there by design.
    function syncSolo() {
        if (!anchorMode || typeof rc === 'undefined' || !rc) return;
        const peerCount = livePeerIds().size;
        // Телефон больше не исключение: на индивидуальном уроке собеседник
        // крупно, своя картинка — в углу, как на компьютере (Иван, 2026-08-09).
        // Раньше мобильные проваливались в сетку, а себя не было видно вовсе.
        const shouldSolo = peerCount === 2;
        const btn = document.getElementById('montemeetSpeakerViewBtn');
        // the view button makes sense only with an actual group (3+): hidden
        // when the teacher sits alone and in the solo 1:1 layout
        if (btn) btn.style.display = !shouldSolo && peerCount >= 3 ? '' : 'none';
        if (shouldSolo === soloActive) {
            if (soloActive) applySolo(); // keep in shape (screen share swaps etc.)
            return;
        }
        soloActive = shouldSolo;
        bumpEpoch();
        document.body.classList.toggle('montemeet-solo', soloActive);
        if (soloActive) {
            if (auto && auto.apply === applyGroupSpeaker) disengageAuto();
            preSoloView = speakerView; // вернём его, когда придёт третий
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
                // педагог возвращается в свой режим, остальные — к якорю
                isHost() ? restoreSpeakerView() : ensureDefault();
            }
            // focus view keeps an existing focus (companion/anchor or the new speaker)
        }
    }

    // Mark the own tile (video or avatar) — drives CSS (self buttons hidden,
    // teacher's own bar) and the strip ordering (self always on top)
    function markSelfTile() {
        const me = selfId();
        if (!me) return;
        const own = new Set();
        const videoEl = rc?.getVideoElementByPeerId?.(me);
        if (videoEl) {
            const cam = document.getElementById(containerId(videoEl.id));
            if (cam) own.add(cam);
        }
        const off = document.getElementById(me + '__videoOff');
        if (off) own.add(off);
        for (const el of document.querySelectorAll('.montemeet-self')) {
            if (!own.has(el)) el.classList.remove('montemeet-self');
        }
        for (const el of own) el.classList.add('montemeet-self');
    }

    // Strip ordering: the own tile first, newcomers (incl. screen feeds) right
    // below it instead of the bottom (Ivan, 2026-08-06)
    function orderStrip() {
        const container = rc?.videoMediaContainer;
        if (!container || !document.body.classList.contains('montemeet-pinned')) return;
        const tiles = [...container.children].filter((c) => c.classList?.contains('Camera'));
        const selfTile = tiles.find((c) => c.classList.contains('montemeet-self'));
        if (selfTile && container.firstElementChild !== selfTile) {
            container.insertBefore(selfTile, container.firstElementChild);
        }
        const anchorNode =
            selfTile && selfTile.parentElement === container ? selfTile.nextSibling : container.firstChild;
        for (const tile of tiles) {
            if (tile === selfTile || tile.dataset.mmSeen) continue;
            tile.dataset.mmSeen = '1';
            if (tile !== anchorNode) container.insertBefore(tile, anchorNode);
        }
    }

    // Manual pin by clicking the video itself (teacher, pin-view group rooms).
    // Clicking the big manually-pinned video unpins it (mode auto-restores);
    // clicking another tile switches the pin — no stock popup dance.
    function manualPinClick(e) {
        if (typeof rc === 'undefined' || !rc || rc.isMobileDevice) return;
        if (!isHost() || concertRoom || soloActive || anchorView !== 'pin') return;
        const videoEl = e.target.closest('video[id]');
        if (!videoEl) return;
        const cam = videoEl.closest('.Camera');
        // the big pinned video loses its .Camera class upstream — allow it too
        const isBigPinned = rc.isVideoPinned && rc.pinnedVideoPlayerId === videoEl.id;
        if (!cam && !isBigPinned) return;
        if (cam?.classList.contains('montemeet-self')) return; // never pin oneself
        if (e.target.closest('button, input, select')) return; // tile buttons keep working
        if (rc.isVideoPinned && rc.pinnedVideoPlayerId === videoEl.id) {
            if (manualPinActive()) {
                const prev = manualState ? manualState.prevView : speakerView;
                manualState = null;
                unpin();
                setSpeakerViewTo(prev);
            }
            return; // a mode-made pin is not unpinnable by hand (Q6.5)
        }
        const camForRestore = document.getElementById(containerId(videoEl.id));
        if (camForRestore) stripRestore.set(camForRestore.id, camForRestore.nextElementSibling?.id ?? null);
        if (rc.isVideoPinned) {
            silentClick(document.getElementById(rc.pinnedVideoPlayerId + '__pin')); // auto-swap
        }
        silentClick(document.getElementById(videoEl.id + '__pin'));
        programmaticPinId = null; // this is a MANUAL pin
        syncPinnedClass();
        syncManualPinState();
        if (typeof resizeVideoMedia === 'function') resizeVideoMedia();
    }
    document.addEventListener('click', manualPinClick, true);

    // Concert splash: an image (profile layout.splash) fills the stage when no
    // other participant's video is visible (nobody online / all cameras off).
    // The admin cabinet will manage the image later — the mechanics live here.
    function syncConcertSplash() {
        if (!concertRoom) return;
        // the splash is the HALL's stage filler only (Ivan, 2026-08-06) — guests
        // keep the normal focus-on-hall view
        if (!isHost()) {
            document.getElementById('montemeetSplash')?.remove();
            return;
        }
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
        // Заставка закрывает сцену, пока НИКТО не выступает. Раньше её гасило
        // само появление чужой камеры — молчащий гость с включённым видео убирал
        // заставку, хотя на сцене по-прежнему пусто (Иван, 2026-08-09).
        // Теперь смотрим на выступающего: есть подтверждённый говорящий или
        // ручной пин — сцена занята, иначе показываем заставку.
        const performing = !!dom || manualPinActive();
        const wantSplash = !splashForced && !performing;
        let el = document.getElementById('montemeetSplash');
        if (wantSplash && !el) {
            el = document.createElement('div');
            el.id = 'montemeetSplash';
            el.className = 'montemeet-splash';
            el.style.backgroundImage = `url('${url}')`;
            document.body.appendChild(el);
            requestAnimationFrame(() => el.classList.add('is-on')); // плавное появление
        } else if (!wantSplash && el) {
            el.classList.remove('is-on');
            const doomed = el;
            setTimeout(() => doomed.remove(), 400);
        }
    }

    // Педагог может убрать заставку вручную — например, чтобы показать зал
    // до начала выступлений (Иван, 2026-08-09).
    let splashForced = false;
    function maybeCreateSplashButton() {
        if (!concertRoom || !isHost() || !layoutCfg?.splash) return;
        if (document.getElementById('montemeetSplashBtn')) return;
        const bar = document.getElementById('bottomButtons');
        if (!bar) return;
        const btn = document.createElement('button');
        btn.id = 'montemeetSplashBtn';
        btn.innerHTML = '<i class="fas fa-image"></i>';
        btn.title = typeof window.mmT === 'function' ? window.mmT('Заставка сцены') : 'Заставка сцены';
        btn.addEventListener('click', () => {
            splashForced = !splashForced;
            btn.style.color = splashForced ? 'lime' : '';
            syncConcertSplash();
        });
        bar.appendChild(btn);
    }

    // The button appears only for the presenter in pin-view rooms on desktop;
    // isPresenter settles after join, so creation is retried on DOM changes.
    function maybeCreateSpeakerViewButton() {
        if (anchorView !== 'pin' || !isHost() || concertRoom) return;
        if (typeof rc === 'undefined' || !rc) return;
        if (document.getElementById('montemeetSpeakerViewBtn')) return;
        const bar = document.getElementById('bottomButtons');
        if (!bar) return;
        const btn = document.createElement('button');
        btn.id = 'montemeetSpeakerViewBtn';
        btn.addEventListener('click', cycleSpeakerView);
        // Видимость выставляем сразу: раньше её ставил syncSolo, а он теперь
        // проходит РАНЬШЕ создания кнопки — и на паре участников кнопка
        // появлялась, хотя переключать там нечего (Иван, 2026-08-10)
        btn.style.display = !soloActive && livePeerIds().size >= 3 ? '' : 'none';
        bar.appendChild(btn);
        restoreSpeakerView();
        updateSpeakerViewButton();
    }

    // Восстановление вида педагога: после перезагрузки и после выхода из
    // режима 1:1. Раньше это жило внутри создания кнопки и только выставляло
    // переменную — режим оставался пустым до первой чужой реплики, а кнопка
    // могла показывать одно, экран другое (Иван, 2026-08-09). Теперь идём через
    // setSpeakerViewTo: он же выберет, кого показать крупно прямо сейчас.
    let preSoloView = null;
    function restoreSpeakerView() {
        if (soloActive || concertRoom || !isHost() || anchorView !== 'pin') return;
        let saved = preSoloView;
        preSoloView = null;
        if (!saved) {
            try {
                saved = localStorage.getItem('MONTEMEET_SPEAKER_VIEW');
            } catch (e) {
                /* localStorage unavailable */
            }
        }
        // без запомненного выбора — говорящий крупно (sticky), не сетка и не
        // авто (Иван, 2026-08-06); отключённый админкой режим тоже отбрасываем.
        // Показать кого-то надо сразу: восстановленный режим, при котором на
        // экране сетка до первой реплики, читается как поломка (Иван, 2026-08-10)
        setSpeakerViewTo(viewCycle().includes(saved) ? saved : 'sticky');
    }

    // ---------- кружочки говорящих (телефон, студент на групповом уроке) ----------
    // Студент смотрит на педагога крупно, и одноклассник, когда заговорил,
    // выезжает из-за левой грани маленьким кружком, а замолчав — уходит туда
    // же. Одновременно их может быть до трёх (Иван, 2026-08-09).
    const CIRCLE_MAX = 3;
    const CIRCLE_HOLD_MS = 3000; // сколько кружок держится после последнего звука (Иван, 2026-08-11)
    const CIRCLE_LEAVE_MS = 400; // столько занимает уход за грань экрана
    const speakingUntil = new Map(); // peerId -> до какого времени показывать
    let circlesTimer = null;

    function circlesAllowed() {
        if (typeof rc === 'undefined' || !rc?.isMobileDevice) return false;
        if (!anchorMode || concertRoom || soloActive) return false;
        if (isHost()) return false; // у педагога для этого свои режимы вида
        // кружочки существуют поверх КРУПНОГО видео; если на экране сетка,
        // говорящий и так виден своей плиткой
        return current() !== null;
    }

    function noteSpeakingCircle(peerId) {
        if (!peerId || !circlesAllowed()) return;
        if (peerId === selfId() || peerId === anchorPeerId()) return;
        speakingUntil.set(peerId, Date.now() + CIRCLE_HOLD_MS);
        syncCircles();
    }

    // лицо кружка: та же дорожка, что и в основной плитке (лишнего трафика
    // нет — поток один), иначе аватар, иначе первая буква имени
    function circleFace(peerId) {
        const src = rc.getVideoElementByPeerId?.(peerId)?.srcObject;
        if (src) {
            const v = document.createElement('video');
            v.autoplay = true;
            v.muted = true; // звук идёт из основной плитки, здесь он лишний
            v.playsInline = true;
            v.srcObject = src;
            return v;
        }
        const avatar = document.getElementById(peerId + '__videoOff')?.querySelector('img');
        if (avatar?.src) {
            const i = document.createElement('img');
            i.src = avatar.src;
            i.alt = '';
            return i;
        }
        const span = document.createElement('span');
        const name = rc.peers?.get(peerId)?.peer_info?.peer_name || '';
        span.textContent = (name.trim()[0] || '?').toUpperCase();
        return span;
    }

    function syncCircles() {
        const now = Date.now();
        for (const [id, until] of speakingUntil) if (until <= now) speakingUntil.delete(id);
        let box = document.getElementById('montemeetCircles');
        // Место закрепляется за тем, кто его занял, пока он говорит: если
        // каждый раз пересобирать тройку заново, при четырёх одновременно
        // говорящих кружки скачут по колонке каждую десятую секунды.
        const wanted = [];
        if (circlesAllowed()) {
            for (const el of box ? box.children : []) {
                const id = el.dataset.peer;
                if (id && speakingUntil.has(id) && !wanted.includes(id)) wanted.push(id);
            }
            for (const [id] of [...speakingUntil.entries()].sort((a, b) => b[1] - a[1])) {
                if (wanted.length >= CIRCLE_MAX) break;
                if (!wanted.includes(id)) wanted.push(id);
            }
            wanted.length = Math.min(wanted.length, CIRCLE_MAX);
        }
        if (!wanted.length && !box) return;
        if (!box) {
            box = document.createElement('div');
            box.id = 'montemeetCircles';
            box.className = 'montemeet-circles';
            document.body.appendChild(box);
        }
        for (const el of [...box.children]) {
            const keep = wanted.includes(el.dataset.peer);
            if (keep) {
                delete el.dataset.leavingAt; // заговорил снова, пока уезжал
                el.classList.add('is-in');
            } else if (!el.dataset.leavingAt) {
                el.dataset.leavingAt = String(now);
                el.classList.remove('is-in');
            } else if (now - Number(el.dataset.leavingAt) > CIRCLE_LEAVE_MS) {
                el.remove();
            }
        }
        for (const id of wanted) {
            if (box.querySelector(`[data-peer="${id}"]`)) continue;
            const el = document.createElement('div');
            el.className = 'montemeet-circle';
            el.dataset.peer = id;
            el.appendChild(circleFace(id));
            box.appendChild(el);
            requestAnimationFrame(() => el.classList.add('is-in'));
        }
        const busy = speakingUntil.size > 0 || box.children.length > 0;
        if (busy && !circlesTimer) circlesTimer = setInterval(syncCircles, 250);
        if (!busy && circlesTimer) {
            clearInterval(circlesTimer);
            circlesTimer = null;
            box.remove();
        }
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
            const observer = new MutationObserver(() => {
                clearTimeout(t);
                t = setTimeout(() => {
                    syncPinnedClass();
                    markSelfTile();
                    // 1:1 определяем ДО восстановления режима: иначе педагог на
                    // входе успевает включить «говорящего крупно» и закрепить
                    // собеседника, а следом раскладка 1:1 ставит фокус на него же
                    syncSolo();
                    maybeCreateSpeakerViewButton();
                    syncManualPinState();
                    orderStrip();
                    if (isConcert) {
                        maybeCreateSplashButton();
                        syncConcertSplash();
                    }
                    // состав сменился — подтянуть карту участников и переложить
                    // ещё раз уже с ней (ответ приходит после этого прохода)
                    syncPeerMap(applyCurrent);
                    if (soloActive) return;
                    applyCurrent();
                    // structural changes may have flipped strip classes after the
                    // stock resize ran — one more pass keeps tile sizes honest
                    if (typeof resizeVideoMedia === 'function') resizeVideoMedia();
                }, 800);
            });
            observer.observe(target, { childList: true });
            // the pinned video lives in a SEPARATE container — a screen share
            // ending there must also trigger a re-layout (Ivan's grid-after-share)
            const pinTarget = document.getElementById('videoPinMediaContainer');
            if (pinTarget) observer.observe(pinTarget, { childList: true });
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
        view: () => speakerView, // текущий режим вида педагога (регрессии, отладка)
    };
})();
