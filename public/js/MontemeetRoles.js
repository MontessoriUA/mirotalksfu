'use strict';


/*
 * Montemeet: role presets — trim the UI per the Appendix A decision table
 * (MASTERPLAN.md). First pass: the main toolbar. The settings panel and the
 * per-tile buttons get their polish at stage 2.5.
 *
 * Activated by profile.roles === 'lesson' (anchored rooms): the presenter is
 * the teacher, everyone else is a student. Students are freed from anything
 * administrative or service-like; the teacher loses the never-used clutter.
 * Applied idempotently on structural DOM changes (join flow timing varies).
 */

const MontemeetRoles = (() => {
    // translated at call time by MontemeetI18n (identity until it loads)
    const mmT = (s) => (typeof window.mmT === 'function' ? window.mmT(s) : s);
    // Appendix A, «Основная панель»: hidden for BOTH roles at lessons
    const HIDE_BOTH = [
        'raiseHandButton',
        'pollButton',
        'speechRecButton',
        'breakoutRoomButton',
        'editorButton',
        'transcriptionButton',
        'documentPiPButton',
        'snapshotRoomButton',
        'emojiRoomButton',
    ];
    // additionally hidden for students
    const HIDE_STUDENT = [...HIDE_BOTH, 'shareButton', 'hideMeButton', 'participantsButton', 'whiteboardButton'];
    // concerts: no screen sharing and no chat for anyone (Ivan, 2026-08-05)
    const HIDE_CONCERT = [...HIDE_BOTH, 'startScreenButton', 'chatButton', 'whiteboardButton'];

    // Appendix A, settings/tile/chat sections — applied by overriding the
    // global BUTTONS object BEFORE tiles are built, so the buttons are simply
    // never created. Split: for everyone at lessons / student extras.
    const BUTTONS_LESSON_BOTH = {
        settings: {
            tabRecording: false,
            broadcastingButton: false,
            tabRTMPStreamingBtn: false,
            activeRooms: false,
            sendEmailInvitation: false,
            customNoiseSuppression: false,
            pushToTalk: false,
            tabModerator: false, // admin-level per Ivan — not even the teacher
            lockRoomButton: false,
            unlockRoomButton: false,
        },
        producerVideo: {
            videoPictureInPicture: false,
            videoMirrorButton: false,
            snapShotButton: false,
            drawingButton: false,
            fullScreenButton: false,
            focusVideoButton: false, // breaks the layout on the way back (Ivan)
        },
        consumerVideo: {
            sendMessageButton: false,
            sendFileButton: false,
            sendVideoButton: false,
            geolocationButton: false,
            drawingButton: false,
            videoPictureInPicture: false,
            videoMirrorButton: false,
            fullScreenButton: false,
            snapShotButton: false,
            focusVideoButton: false,
        },
        videoOff: {
            sendMessageButton: false,
            sendFileButton: false,
            sendVideoButton: false,
            geolocationButton: false,
        },
        chat: {
            chatMarkdownButton: false,
            chatSpeechStartButton: false, // "только эмодзи" из ввода
            chatMaxButton: false,
        },
        participantsList: {
            saveInfoButton: false,
            geoLocationButton: false,
        },
        whiteboard: {
            whiteboardLockButton: false,
        },
    };
    const BUTTONS_LESSON_STUDENT = {
        settings: {
            micOptionsButton: false,
            tabNotificationsBtn: false,
            keyboardShortcuts: false,
        },
        consumerVideo: {
            videoPictureInPicture: false,
            videoMirrorButton: false,
            fullScreenButton: false,
            snapShotButton: false,
            focusVideoButton: false,
            muteVideoButton: false,
            muteAudioButton: false,
            audioVolumeInput: false,
        },
        videoOff: {
            muteAudioButton: false,
            audioVolumeInput: false,
        },
        chat: {
            chatPinButton: false,
            chatMaxButton: false,
            chatSaveButton: false,
        },
    };

    function patchButtons(patch) {
        if (typeof BUTTONS === 'undefined') return false;
        for (const [section, values] of Object.entries(patch)) {
            if (!BUTTONS[section]) BUTTONS[section] = {};
            Object.assign(BUTTONS[section], values);
        }
        return true;
    }

    // Settings tabs kept at lessons/concerts: video, audio, virtual background,
    // language. Everything else is admin-level or noise (Ivan, 2026-08-05).
    const HIDE_SETTINGS_TABS = [
        'tabRoomBtn',
        'tabRecordingBtn',
        'tabModeratorBtn',
        'tabNotificationsBtn',
        'tabProfileBtn',
        'tabShortcutsBtn',
        'tabAspectBtn',
        'tabStylingBtn',
        'tabVideoShareBtn',
        'tabVideoAIBtn',
        'tabRTMPStreamingBtn',
    ];
    // chat panel extras removed for everyone
    const HIDE_CHAT_EXTRAS = ['participantsRaiseHandBtn', 'chatSpeechStartButton', 'chatMaxButton'];

    // hide a settings row: a <tr> for switches, or the select + its .title label
    function hideSettingRow(id) {
        const el = document.getElementById(id);
        if (!el) return;
        const tr = el.closest('tr');
        if (tr) {
            tr.style.display = 'none';
            return;
        }
        el.style.display = 'none';
        let prev = el.previousElementSibling;
        while (prev && !(prev.classList && prev.classList.contains('title'))) {
            const next = prev.previousElementSibling;
            prev.style.display = 'none';
            prev = next;
        }
        if (prev) prev.style.display = 'none';
    }

    let defaultTabPicked = false;
    let panelSplitDone = false;
    let fileShareBtnDone = false;

    // Participants and chat live in one stock panel; the participants button
    // must open ONLY the list (Ivan, 2026-08-05). The stock code already has a
    // participants-only path gated by BUTTONS.main.chatButton — reuse it.
    // Panel split: the buttons get OUR handlers directly (a click before the
    // client is ready is queued and replayed — the stock handlers just threw
    // on a null client, eating the first clicks after page load).
    let pendingPanel = null; // 'chat' | 'participants'

    const plistEl = () => document.getElementById('plist');

    function rcReady() {
        return typeof rc !== 'undefined' && rc && typeof rc.toggleChat === 'function';
    }

    function markPanelOpen(open) {
        document.body.classList.toggle('montemeet-panel-open', !!open);
    }

    function showList() {
        markPanelOpen(true);
        const p = plistEl();
        p?.classList.remove('hidden');
        if (p) p.style.width = '100%';
        if (typeof elemDisplay === 'function') elemDisplay('chat', false);
        rc.isParticipantsOpen = true;
        rc.syncChatToolbarButtons?.();
    }

    function closePanel() {
        markPanelOpen(false);
        rc.isParticipantsOpen = false;
        plistEl()?.classList.add('hidden');
        if (rc.isChatOpen) rc.toggleChat(true);
        rc.syncChatToolbarButtons?.();
    }

    // open the stock chat with the toolbar flag muted so the fromParticipants
    // guard passes. The desktop auto-pin is deliberately LEFT ON: chat and the
    // participants list dock to the side instead of covering the room center
    // (Ivan, 2026-08-06). The fromUser-gated toggleShowParticipants override
    // keeps chatPin()'s plist side effect away from our split.
    async function openChatQuiet() {
        const savedBtn = BUTTONS.main.chatButton;
        BUTTONS.main.chatButton = false;
        try {
            await rc.toggleChat(true);
        } finally {
            BUTTONS.main.chatButton = savedBtn;
        }
    }

    function openChatSplit() {
        if (!rcReady()) {
            pendingPanel = 'chat';
            return;
        }
        pendingPanel = null;
        const p = plistEl();
        const chatAlone = rc.isChatOpen && p?.classList.contains('hidden');
        if (chatAlone) {
            markPanelOpen(false);
            rc.toggleChat(true); // second click closes
            return;
        }
        if (!rc.isChatOpen) openChatQuiet();
        p?.classList.add('hidden');
        if (p) p.style.width = '';
        if (typeof elemDisplay === 'function') elemDisplay('chat', true);
        markPanelOpen(true);
        rc.isParticipantsOpen = false;
        rc.syncChatToolbarButtons?.(); // иначе зелёной остаётся кнопка списка
    }

    async function toggleParticipantsSplit() {
        if (!rcReady()) {
            pendingPanel = 'participants';
            return;
        }
        pendingPanel = null;
        const listOpen = rc.isChatOpen && plistEl() && !plistEl().classList.contains('hidden');
        if (listOpen) {
            closePanel();
            return;
        }
        if (!rc.isChatOpen) await openChatQuiet();
        showList();
    }

    openChatSplit._mm = true;
    toggleParticipantsSplit._mm = true;

    // Занятое имя — не повод останавливать человека на пороге: сток открывает
    // модальное окно и отправляет менять имя вручную, мы просто добавляем номер
    // и заходим (Иван, 2026-08-09). Имя за нами не закреплено: два «Ваня» в
    // комнате — обычное дело, различать их должен номер, а не отказ во входе.
    let nameRetried = false;
    function autoRenameOnConflict() {
        if (!window.RoomClient || !RoomClient.prototype.userNameAlreadyInRoom) return;
        const proto = RoomClient.prototype;
        if (proto._mmRename) return;
        proto._mmRename = true;
        const stock = proto.userNameAlreadyInRoom;
        proto.userNameAlreadyInRoom = function () {
            if (nameRetried) return stock.call(this); // второй отказ подряд — как в стоке
            nameRetried = true;
            const url = new URL(window.location.href);
            const base = String(url.searchParams.get('name') || this.peer_name || '').replace(/\s*\(\d+\)$/, '');
            const prev = /\((\d+)\)$/.exec(String(url.searchParams.get('name') || ''));
            const next = prev ? Number(prev[1]) + 1 : 2;
            url.searchParams.set('name', base + ' (' + next + ')');
            try {
                window.localStorage.peer_name = base + ' (' + next + ')';
            } catch (e) {}
            window.location.replace(url.toString());
        };
    }

    // Любое выпадающее меню закрывается кликом мимо. Сток закрывает так только
    // меню выхода, остальные (выбор устройств, доп. настройки) висят открытыми,
    // пока не нажмёшь ту же стрелку (Иван, 2026-08-09).
    let outsideClickDone = false;
    function closeMenusOnOutsideClick() {
        if (outsideClickDone) return;
        outsideClickDone = true;
        const closeAll = (target, insideToo) => {
            for (const menu of document.querySelectorAll('.dropdown-menu, .navbar-dropdown-content')) {
                const open = !menu.classList.contains('hidden') && menu.offsetParent !== null;
                if (!open) continue;
                const holder = menu.closest('.dropdown') || menu.parentElement;
                const outside = holder && !holder.contains(target);
                // клик мимо закрывает всегда; клик по пункту меню — тоже, иначе
                // меню висит поверх того, что этим пунктом открыли (Иван, 2026-08-09)
                if (outside || (insideToo && menu.contains(target))) {
                    menu.classList.add('hidden');
                    menu.classList.remove('show');
                }
            }
        };
        document.addEventListener('pointerdown', (e) => closeAll(e.target, false), true);
        document.addEventListener('click', (e) => setTimeout(() => closeAll(e.target, true), 0), true);
    }

    // Смена камеры на телефоне падала с «устройство уже используется»: сток
    // закрывает продюсера и через секунду просит новую камеру, но андроид
    // отпускает её позже — а превью в видеоэлементе продолжает её держать.
    // Гасим ВСЕ живые видеодорожки, отцепляем их от элементов и ждём дольше.
    async function swapCameraSafely() {
        const stopOwnVideo = () => {
            const own = rc.getVideoElementByPeerId?.(rc.peer_id);
            const els = [own, document.getElementById('myVideo'), document.getElementById('videoPreview')].filter(Boolean);
            for (const el of els) {
                const src = el.srcObject;
                if (src && typeof src.getVideoTracks === 'function') {
                    src.getVideoTracks().forEach((t) => {
                        try {
                            t.stop();
                        } catch (e) {}
                    });
                }
                el.srcObject = null;
            }
            const prod = rc.producer instanceof Map ? rc.producer.get(RoomClient.mediaType.video) : null;
            try {
                prod?.track?.stop();
            } catch (e) {}
        };

        try {
            if (typeof isHideMeActive !== 'undefined' && isHideMeActive) rc.handleHideMe();
            stopOwnVideo();
            rc.closeProducer(RoomClient.mediaType.video, 'montemeet-swap');
            stopOwnVideo();
            await new Promise((r) => setTimeout(r, 1200));
            try {
                await rc.produce(RoomClient.mediaType.video, null, true);
            } catch (first) {
                // устройство ещё занято: ждём дольше и пробуем ещё раз БЕЗ
                // повторного переворота — иначе вернёмся на ту же камеру
                console.warn('Montemeet: camera busy, retrying', first?.name || first);
                stopOwnVideo();
                await new Promise((r) => setTimeout(r, 2000));
                await rc.produce(RoomClient.mediaType.video, null, false);
            }
        } catch (err) {
            console.warn('Montemeet: swap camera failed', err);
            if (typeof userLog === 'function') userLog('warning', mmT('Камера занята другим приложением — закройте его и попробуйте снова'), 'top-end', 5000);
        }
    }

    // попап со ссылкой на комнату сразу, без системного окна обмена
    function openShareDirect() {
        if (typeof shareRoom === 'function') shareRoom(false);
    }

    function splitParticipantsFromChat() {
        // re-assert our handlers (the stock init may overwrite them at any point)
        const chatBtn = document.getElementById('chatButton');
        const partBtn = document.getElementById('participantsButton');
        if (chatBtn && chatBtn.onclick !== openChatSplit) chatBtn.onclick = openChatSplit;
        if (partBtn && partBtn.onclick !== toggleParticipantsSplit) partBtn.onclick = toggleParticipantsSplit;
        // chat is ALWAYS pinned to the side (Ivan, 2026-08-06): force the flag
        // over whatever localStorage restored, persist it, and hide the switch —
        // the header pin button is already off via BUTTONS.chat.chatPinButton
        if (typeof isChatPinEnabled !== 'undefined' && !isChatPinEnabled) {
            isChatPinEnabled = true;
            if (typeof localStorageSettings !== 'undefined' && typeof lS !== 'undefined') {
                localStorageSettings.chat_pin = true;
                lS.setSettings(localStorageSettings);
            }
        }
        hideSettingRow('switchChatPin');
        // «Поделиться»: стоковый обработчик зовёт системное окно обмена (на маке
        // это отдельный список действий поверх страницы) и показывает QR по
        // наведению. Нужен один клик → сразу наш попап со ссылкой.
        // Пере-навешиваем на каждом тике: стоковый handleButtons() переустанавливает
        // свои обработчики уже после нашей первой попытки.
        closeMenusOnOutsideClick();
        const swapBtn = document.getElementById('swapCameraButton');
        if (swapBtn && swapBtn.onclick !== swapCameraSafely) swapBtn.onclick = swapCameraSafely;
        const shareBtn = document.getElementById('shareButton');
        if (shareBtn && shareBtn.onclick !== openShareDirect) {
            shareBtn.onclick = openShareDirect;
            shareBtn.onmouseenter = null;
            shareBtn.onmouseleave = null;
        }
        if (rcReady()) {
            if (!panelSplitDone) {
                // the list's own X closes the whole panel (stock passes true);
                // chatPin()/chatUnpin() also call this as a no-arg side effect —
                // those must not touch our split
                rc.toggleShowParticipants = function (fromUser) {
                    if (fromUser) closePanel();
                };
                panelSplitDone = true;
            }
            if (pendingPanel === 'chat') openChatSplit();
            else if (pendingPanel === 'participants') toggleParticipantsSplit();
        }
    }

    // «Звук компьютера» (Q4): capture via the browser's screen picker, drop the
    // video track and produce ONLY the audio — Zoom-style computer sound.
    // Lessons only; dance rooms try to engage it right at join.
    let pcSoundBtnDone = false;

    function pcSoundActive() {
        return !!(typeof rc !== 'undefined' && rc && rc.producerLabel?.has(RoomClient.mediaType.audioTab));
    }

    function updatePcSoundBtn() {
        const btn = document.getElementById('montemeetPcSoundBtn');
        if (!btn) return;
        const on = pcSoundActive();
        btn.classList.toggle('montemeet-on', on); // CSS !important beats stock button colors
        btn.title = on ? mmT('Звук компьютера: транслируется (клик — выключить)') : mmT('Транслировать звук компьютера');
        if (on) btn.classList.remove('montemeet-attention');
    }

    async function togglePcSound() {
        try {
            if (pcSoundActive()) {
                rc.closeProducer(RoomClient.mediaType.audioTab);
                setTimeout(updatePcSoundBtn, 300);
                return;
            }
            const stream = await navigator.mediaDevices.getDisplayMedia({
                video: true,
                audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
                systemAudio: 'include', // Windows Chrome: pre-tick the system-audio box
            });
            if (!stream.getAudioTracks().length) {
                stream.getTracks().forEach((t) => t.stop());
                if (typeof userLog === 'function') {
                    // macOS never yields SYSTEM audio to the browser — only a
                    // Chrome tab's own audio can be captured there
                    const isMac = /Mac/i.test(navigator.platform || navigator.userAgent);
                    userLog(
                        'warning',
                        isMac
                            ? mmT('На macOS звук доступен только из вкладки Chrome: выберите ВКЛАДКУ с плеером и включите «Также предоставить доступ к аудио вкладки»')
                            : mmT('Отметьте галку «Предоставить доступ к системному звуку» в диалоге браузера'),
                        'top-end',
                        8000
                    );
                }
                return;
            }
            stream.getVideoTracks().forEach((t) => t.stop()); // sound only, no screen feed
            await rc.produceScreenAudio(stream);
            updatePcSoundBtn();
        } catch (e) {
            // NotAllowedError: dismissed picker or no gesture (dance auto-try) — stay off
            updatePcSoundBtn();
        }
    }

    function ensurePcSoundButton() {
        if (pcSoundBtnDone || MontemeetProfile.roles() !== 'lesson') return;
        if (!(typeof isPresenter !== 'undefined' && isPresenter)) return;
        const bar = document.getElementById('bottomButtons');
        if (!bar || typeof rc === 'undefined' || !rc) return;
        const btn = document.createElement('button');
        btn.id = 'montemeetPcSoundBtn';
        // note inside a monitor: taller screen + a small stand (Ivan, 2026-08-06)
        btn.innerHTML =
            '<svg viewBox="0 0 22 19" width="27" height="23" fill="currentColor"><rect x="1" y="1" width="20" height="14.5" rx="2" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M8.5 17h5l1 1.6h-7z"/><path d="M15.3 3.8 9.4 5.1v5a2.3 2.3 0 1 0 1.3 2.07V7.8l3.3-.73v2.6a2.3 2.3 0 1 0 1.3 2.07z"/></svg>';
        btn.addEventListener('click', togglePcSound);
        const anchorBtn = document.getElementById('montemeetFileShareBtn') || document.getElementById('participantsButton');
        if (anchorBtn && anchorBtn.parentElement === bar) {
            bar.insertBefore(btn, anchorBtn.nextSibling);
        } else {
            bar.appendChild(btn);
        }
        updatePcSoundBtn();
        if (MontemeetProfile.name() === 'dance') {
            // auto-engage at dance lessons; without a user gesture the browser
            // refuses — then the pulsing button invites one click
            btn.classList.add('montemeet-attention');
            togglePcSound();
        }
        pcSoundBtnDone = true;
    }

    // File sharing moves to the bottom toolbar at lessons (not at concerts)
    function ensureFileShareButton() {
        if (fileShareBtnDone || MontemeetProfile.roles() !== 'lesson') return;
        const bar = document.getElementById('bottomButtons');
        const stockBtn = document.getElementById('fileShareButton');
        if (!bar || !stockBtn) return;
        const btn = document.createElement('button');
        btn.id = 'montemeetFileShareBtn';
        btn.title = mmT('Отправить файл');
        btn.innerHTML = '<i class="fas fa-file-upload"></i>';
        btn.addEventListener('click', () => stockBtn.click());
        // right next to the participants button (Ivan, 2026-08-05)
        const anchorBtn = document.getElementById('participantsButton');
        if (anchorBtn && anchorBtn.parentElement === bar) {
            bar.insertBefore(btn, anchorBtn.nextSibling);
        } else {
            bar.appendChild(btn);
        }
        fileShareBtnDone = true;
    }

    function apply() {
        if (typeof rc === 'undefined' || !rc) return;
        const preset = MontemeetProfile.roles();
        const teacher = typeof isPresenter !== 'undefined' && isPresenter;
        // body role classes drive the race-proof CSS trims (Montemeet.css)
        document.body.classList.toggle('montemeet-lesson', preset === 'lesson');
        document.body.classList.toggle('montemeet-concert', preset === 'concert');
        document.body.classList.toggle('montemeet-teacher', teacher);
        document.body.classList.toggle('montemeet-student', !teacher);
        const list = preset === 'concert' ? HIDE_CONCERT : teacher ? HIDE_BOTH : HIDE_STUDENT;
        for (const id of [...list, ...HIDE_SETTINGS_TABS, ...HIDE_CHAT_EXTRAS]) {
            const el = document.getElementById(id);
            if (el && el.style.display !== 'none') el.style.display = 'none';
        }
        hideSettingRow('switchDominantSpeakerFocus');
        hideSettingRow('switchPushToTalk');
        hideSettingRow('videoQuality');
        hideSettingRow('videoFps');
        hideSettingRow('screenFps');
        // not changeable anyway: switching it mid-share throws getDisplayMedia
        // "must be called from a user gesture" (Ivan, 2026-08-06)
        hideSettingRow('screenQuality');
        // orphan divider left at the bottom of the audio tab after the trims
        const audioTab = document.getElementById('tabAudioDevices');
        const lastHr = audioTab ? [...audioTab.querySelectorAll('hr')].pop() : null;
        if (lastHr) lastHr.style.display = 'none';
        if (!defaultTabPicked) {
            // the hidden Room tab was the default — land on the video tab instead
            document.getElementById('tabVideoDevicesBtn')?.click();
            defaultTabPicked = true;
        }
        splitParticipantsFromChat();
        ensureFileShareButton();
        ensurePcSoundButton();
        updatePcSoundBtn();
        ensureUnhideButtons(teacher);
    }

    // Teacher's «размывать мой фон по умолчанию» (cabinet switch): a one-time
    // seed of the stock virtual-background low blur. The teacher's OWN saved
    // choice always wins — once virtualBackgroundSettings exists (including an
    // explicit "no effect"), the default never fires again. Students unaffected.
    // Returns true when done (or not applicable) so the poll can stop.
    function ensureBlurDefault() {
        try {
            const ov = MontemeetProfile.overrides ? MontemeetProfile.overrides() : null;
            if (!ov || !ov.blurSelf) return true;
            if (localStorage.getItem('virtualBackgroundSettings')) return true;
            if (typeof rc === 'undefined' || !rc || !rc.producerExist) return false;
            if (!rc.producerExist(mediaType.video)) return false; // wait for the camera producer
            if (!(typeof isPresenter !== 'undefined' && isPresenter)) return true;
            rc.applyVirtualBackground(10);
            return true;
        } catch (e) {
            return true;
        }
    }

    // The teacher can re-enable a participant's camera right from the avatar
    // tile (Ivan, 2026-08-06) — a hidden camera has no video tile, and the
    // stock videoOff button set has no camera control at all.
    function ensureUnhideButtons(teacher) {
        if (!teacher || MontemeetProfile.roles() !== 'lesson') return;
        for (const tile of document.querySelectorAll('[id$="__videoOff"]')) {
            const peerId = tile.id.replace(/__videoOff$/, '');
            if (!peerId || peerId === rc.peer_id) continue;
            if (document.getElementById(peerId + '__mmUnhide')) continue;
            const bar = tile.querySelector('[id$="__vb"]') || tile;
            const btn = document.createElement('button');
            btn.id = peerId + '__mmUnhide';
            btn.title = mmT('Включить камеру участнику');
            // stock buttons carry the FA class ON the button itself — the tile
            // bar's hover show/hide only works for that pattern
            btn.className = 'fas fa-video-slash red';
            btn.addEventListener('click', () => rc.peerAction('me', peerId + '___pVideo', 'unhide'));
            // right next to the mic mute/unmute button (Ivan, 2026-08-06)
            const audioBtn = bar.querySelector('[id$="__audio"]');
            if (audioBtn) {
                audioBtn.insertAdjacentElement('afterend', btn);
            } else {
                bar.insertBefore(btn, bar.firstChild);
            }
        }
    }

    (async () => {
        try {
            await MontemeetProfile.ready;
            const preset = MontemeetProfile.roles();
            if (!['lesson', 'concert'].includes(preset)) return;

            // role-independent BUTTONS overrides — as early as BUTTONS exists, so
            // tiles are built without the trimmed buttons at all (concerts included)
            const early = setInterval(() => {
                if (typeof BUTTONS !== 'undefined' && patchButtons(BUTTONS_LESSON_BOTH)) clearInterval(early);
            }, 100);
            setTimeout(() => clearInterval(early), 20000);
            // pre-join popup: keep refresh / camera / mic / emoji / exit only
            // (Ivan, 2026-08-06: the eye, screen and mirror buttons go away)
            const initTrim = setInterval(() => {
                const eye = document.getElementById('initAudioVideoButton');
                if (!eye) return;
                for (const id of ['initAudioVideoButton', 'initStartScreenButton', 'initVideoMirrorButton', 'initVirtualBackgroundButton']) {
                    const el = document.getElementById(id);
                    if (el) el.style.display = 'none';
                }
                clearInterval(initTrim);
            }, 100);
            setTimeout(() => clearInterval(initTrim), 20000);

            // the panel split must be in place before the FIRST click on the
            // chat/participants buttons. A capture-phase interceptor queues
            // clicks that arrive before the client exists (the stock handler
            // would throw on the null client and eat them); the poll installs
            // our handlers and replays the queued click once the client is up.
            document.addEventListener(
                'click',
                (e) => {
                    const btn = e.target.closest('#chatButton, #participantsButton');
                    if (!btn || rcReady()) return;
                    e.preventDefault();
                    e.stopImmediatePropagation();
                    pendingPanel = btn.id === 'chatButton' ? 'chat' : 'participants';
                },
                true
            );
            // keep re-asserting for the whole warm-up window: the stock
            // roomIsReady() -> handleButtons() re-binds these onclick handlers
            // AFTER the client exists, which used to steal the buttons back
            // (Ivan: "чат открывается со 2-3-4 клика")
            const splitPoll = setInterval(splitParticipantsFromChat, 150);
            setTimeout(() => clearInterval(splitPoll), 45000);
            if (preset === 'lesson') {
                const blurPoll = setInterval(() => {
                    if (ensureBlurDefault()) clearInterval(blurPoll);
                }, 500);
                setTimeout(() => clearInterval(blurPoll), 30000);
                // the student extras wait until the role is settled (own tile built)
                const studentPoll = setInterval(() => {
                    if (
                        typeof rc !== 'undefined' &&
                        rc &&
                        rc.peer_id &&
                        document.querySelector('#videoMediaContainer .Camera')
                    ) {
                        if (!(typeof isPresenter !== 'undefined' && isPresenter)) {
                            patchButtons(BUTTONS_LESSON_STUDENT);
                        }
                        clearInterval(studentPoll);
                    }
                }, 150);
                setTimeout(() => clearInterval(studentPoll), 30000);
            }

            const target = document.getElementById('videoMediaContainer');
            if (!target) return;
            let t = null;
            new MutationObserver(() => {
                clearTimeout(t);
                t = setTimeout(apply, 900);
            }).observe(target, { childList: true });
        } catch (e) {
            /* no profile -> stock behavior */
        }
    })();

    // перехваты, которые обязаны существовать ДО входа в комнату
    autoRenameOnConflict();
    document.addEventListener('DOMContentLoaded', autoRenameOnConflict);

    // ------------------------------------------------------------------
    // Notification noise filter (Ivan, 2026-08-06): a student must not get a
    // toast for the teacher's routine actions — whiteboard open/close/lock,
    // editor, shared video, follow-me, moderator switches, other students'
    // raised hands. Important ones (mute/eject/lobby/files/recording consent)
    // pass through untouched. Installed on DOMContentLoaded so these wrappers
    // sit OUTSIDE the i18n ones and match the raw stock strings.
    // служебный шум, не нужный никому и никогда: блокировка экрана срабатывает
    // на телефоне при каждом гашении экрана и переключении приложения, и сток
    // рапортует о каждом таком событии попапом (Иван, 2026-08-09)
    const NOISE_ALWAYS_RE = [/Wake Lock/i];

    const NOISE_RE = [
        /whiteboard action:/,
        /\b(open|close) editor\b/,
        /(cleared|locked|unlocked) the editor/,
        /(opened|closed) the video/,
        /Everyone Follows Me/,
        /has raised the hand/,
    ];
    const MOD_MSG_TYPES = new Set([
        'audio_cant_unmute',
        'video_cant_unhide',
        'screen_cant_share',
        'chat_cant_privately',
        'chat_cant_publicly',
        'chat_cant_chatgpt',
        'media_cant_sharing',
        'polls_cant_create',
    ]);

    function mmStudentInLesson() {
        try {
            if (MontemeetProfile.roles() !== 'lesson') return false;
        } catch (e) {
            return false;
        }
        return !(typeof isPresenter !== 'undefined' && isPresenter);
    }

    function noisyForStudent(message) {
        if (typeof message !== 'string') return false;
        if (NOISE_ALWAYS_RE.some((re) => re.test(message))) return true;
        return mmStudentInLesson() && NOISE_RE.some((re) => re.test(message));
    }

    document.addEventListener('DOMContentLoaded', () => {
        if (typeof window.userLog === 'function') {
            const orig = window.userLog;
            window.userLog = (icon, message, ...rest) => {
                if (noisyForStudent(message)) return;
                return orig(icon, message, ...rest);
            };
        }
        if (window.RoomClient && RoomClient.prototype) {
            const proto = RoomClient.prototype;
            if (typeof proto.userLog === 'function') {
                const orig = proto.userLog;
                proto.userLog = function (icon, message, ...rest) {
                    if (noisyForStudent(message)) return;
                    return orig.call(this, icon, message, ...rest);
                };
            }
            // moderator policy toasts arrive on every presenter (re)join push —
            // kill the whole call (sound('switch') included) for students
            if (typeof proto.roomMessage === 'function') {
                const orig = proto.roomMessage;
                proto.roomMessage = function (type, ...rest) {
                    if (MOD_MSG_TYPES.has(type) && mmStudentInLesson()) return;
                    return orig.call(this, type, ...rest);
                };
            }
        }
    });

    return { apply };
})();
