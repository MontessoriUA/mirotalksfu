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
    // Перезагружать страницу с новым именем в адресе оказалось ненадёжно: имя
    // подтягивается ещё и из localStorage соседней вкладки, и попап всё равно
    // всплывал. Заходим иначе: правим имя на месте и повторяем сам join —
    // до входа в комнату ничего не построено, повтор ничего не ломает.
    // RoomClient объявлен как class на верхнем уровне скрипта, а такие имена
    // живут в лексическом окружении, а НЕ в window: проверка window.RoomClient
    // не срабатывала никогда, и перехват просто не ставился.
    const roomClientProto = () =>
        typeof RoomClient !== 'undefined' && RoomClient.prototype?.userNameAlreadyInRoom ? RoomClient.prototype : null;

    function autoRenameOnConflict() {
        const proto = roomClientProto();
        if (!proto) return;
        if (proto._mmRename) return;
        proto._mmRename = true;
        const stock = proto.userNameAlreadyInRoom;
        proto.userNameAlreadyInRoom = function () {
            const tries = (this._mmNameTry = (this._mmNameTry || 0) + 1);
            if (tries > 20) return stock.call(this); // не смогли подобрать — как в стоке
            const base = String(this.peer_name || this.peer_info?.peer_name || '').replace(/\s*\(\d+\)$/, '');
            const name = base + ' (' + (tries + 1) + ')';
            this.peer_name = name;
            if (this.peer_info) this.peer_info.peer_name = name;
            try {
                // Room.js держит имя ещё и в своей глобальной переменной —
                // без неё чат и запись подписывались бы прежним именем
                if (typeof peer_name !== 'undefined') peer_name = name;
            } catch (e) {
                /* переменной нет — не страшно */
            }
            // в localStorage остаётся исходное имя: номер — свойство этой
            // вкладки, а не человека, и в следующий раз подберётся заново
            return this.join({ room_id: this.room_id, peer_info: this.peer_info });
        };
    }

    // Чат и список участников лежат в одной стоковой панели, и любое открытие
    // чата — по кнопке, по своему же отправленному сообщению, по входящему —
    // показывает их рядом: чат ужимается по ширине, а список висит слева,
    // хотя его никто не звал (Иван, 2026-08-10). Список показываем только
    // тогда, когда его попросили кнопкой участников.
    function chatWithoutParticipants() {
        const proto = roomClientProto();
        if (!proto || proto._mmChatSolo) return;
        proto._mmChatSolo = true;
        const stock = proto.toggleChat;
        proto.toggleChat = async function (fromParticipants = false) {
            const res = await stock.call(this, fromParticipants);
            if (this.isChatOpen && !this.isParticipantsOpen) {
                const p = document.getElementById('plist');
                p?.classList.add('hidden');
                if (p) p.style.width = '';
            }
            return res;
        };
    }

    // Заявка из лобби показывалась дважды: всплывашкой «такой-то хочет
    // присоединиться» и тут же окном с кнопками пустить-не пустить. Окно
    // появляется и исчезает само и у всех педагогов сразу, а всплывашка висела
    // и после чужого решения — гасить её надёжно не вышло (Иван, 2026-08-10).
    // Убираем саму всплывашку: она ничего не добавляла к окну и звуку.
    const LOBBY_TOAST_RE = /wants to join the meeting/i;
    function dismissLobbyToast() {
        const proto = roomClientProto();
        if (!proto || proto._mmLobbyToast) return;
        proto._mmLobbyToast = true;
        const stockLog = proto.userLog;
        // сток зовёт userLog отдельной строкой после lobbyAddPear, поэтому
        // «тихий» флаг вокруг добавления в список ничего не давал: смотрим
        // на сам текст сообщения
        proto.userLog = function (icon, message, ...rest) {
            if (typeof message === 'string' && LOBBY_TOAST_RE.test(message)) return;
            return stockLog.call(this, icon, message, ...rest);
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
    // Смена камеры на телефоне. Ключевое отличие от стока: камеру отпускаем
    // ЯВНО и до запроса новой — андроид не отдаёт устройство по факту закрытия
    // передачи, пока живы дорожки в элементах превью (Иван, 2026-08-09).
    let swapBusy = false;
    async function swapCameraSafely() {
        if (swapBusy) return;
        swapBusy = true;
        const btn = document.getElementById('swapCameraButton');
        const restore = () => {
            swapBusy = false;
            if (!btn) return;
            btn.disabled = false;
            btn.style.opacity = '';
            btn.blur(); // иначе на телефоне остаётся «нажатой»
        };
        if (btn) {
            btn.disabled = true;
            btn.style.opacity = '0.55';
        }

        const releaseCamera = () => {
            const seen = new Set();
            for (const el of document.querySelectorAll('video')) {
                const src = el.srcObject;
                if (!src || typeof src.getVideoTracks !== 'function') continue;
                // только СВОИ дорожки: чужие приходят от консьюмеров
                const own = el.id && rc.peer_id && el.id.includes(rc.peer_id);
                const preview = ['initVideo', 'myVideo', 'videoPreview', 'previewVideo'].includes(el.id);
                if (!own && !preview) continue;
                for (const t of src.getVideoTracks()) {
                    if (seen.has(t)) continue;
                    seen.add(t);
                    try {
                        t.stop();
                    } catch (e) {}
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
            releaseCamera();
            rc.closeProducer(RoomClient.mediaType.video, 'montemeet-swap');
            releaseCamera();
            await new Promise((r) => setTimeout(r, 1500));
            try {
                await rc.produce(RoomClient.mediaType.video, null, true);
            } catch (first) {
                console.warn('Montemeet: camera still busy, one more try', first?.name || first);
                releaseCamera();
                await new Promise((r) => setTimeout(r, 2500));
                // без повторного переворота: getCameraConstraints уже сменил сторону
                await rc.produce(RoomClient.mediaType.video, null, false);
            }
        } catch (err) {
            console.warn('Montemeet: swap camera failed', err);
            if (typeof userLog === 'function') {
                userLog(
                    'warning',
                    mmT('Камера занята другим приложением — закройте его и попробуйте снова'),
                    'top-end',
                    5000
                );
            }
        } finally {
            restore();
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
        btn.title = on
            ? mmT('Звук компьютера: транслируется (клик — выключить)')
            : mmT('Транслировать звук компьютера');
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
                            ? mmT(
                                  'На macOS звук доступен только из вкладки Chrome: выберите ВКЛАДКУ с плеером и включите «Также предоставить доступ к аудио вкладки»'
                              )
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
        // системный звук браузеру на телефоне недоступен — кнопка была бы мёртвой
        if (rc?.isMobileDevice) return;
        const bar = document.getElementById('bottomButtons');
        if (!bar || typeof rc === 'undefined' || !rc) return;
        const btn = document.createElement('button');
        btn.id = 'montemeetPcSoundBtn';
        // note inside a monitor: taller screen + a small stand (Ivan, 2026-08-06)
        btn.innerHTML =
            '<svg viewBox="0 0 22 19" width="27" height="23" fill="currentColor"><rect x="1" y="1" width="20" height="14.5" rx="2" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M8.5 17h5l1 1.6h-7z"/><path d="M15.3 3.8 9.4 5.1v5a2.3 2.3 0 1 0 1.3 2.07V7.8l3.3-.73v2.6a2.3 2.3 0 1 0 1.3 2.07z"/></svg>';
        btn.addEventListener('click', togglePcSound);
        const anchorBtn =
            document.getElementById('montemeetFileShareBtn') || document.getElementById('participantsButton');
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
            // обёртка split-btn остаётся в потоке и ловит нажатия своей стрелкой
            const wrap = el?.closest('.split-btn');
            if (
                wrap &&
                ![...wrap.querySelectorAll('button')].some(
                    (b) => b.style.display !== 'none' && !b.classList.contains('hidden')
                )
            ) {
                wrap.style.display = 'none';
            }
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
                for (const id of [
                    'initAudioVideoButton',
                    'initStartScreenButton',
                    'initVideoMirrorButton',
                    'initVirtualBackgroundButton',
                ]) {
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

    // «Оставить отзыв» при выходе нам не нужен ни в каком виде
    function disableSurvey() {
        try {
            if (typeof survey !== 'undefined' && survey) survey.enabled = false;
            window.survey = { enabled: false, url: '' };
        } catch (e) {}
    }
    disableSurvey();
    document.addEventListener('DOMContentLoaded', disableSurvey);

    // Наушники, воткнутые посреди урока, в списке микрофонов не появлялись.
    // Стоковый обработчик смены устройств живёт внутри настройки быстрых
    // выпадающих меню: на телефоне она не выполняется вовсе, а на компьютере
    // требует, чтобы на месте были все её кнопки (Иван, 2026-08-11). Ставим
    // свой, независимый — и трогаем только то, что действительно поменялось:
    // перечитывать камеру ради воткнутой гарнитуры незачем, лишний захват
    // камеры посреди урока — это ровно тот путь, на котором она отваливалась.
    let deviceWatchDone = false;
    let deviceSnapshot = null;
    const deviceMark = (d) => d.deviceId + '|' + d.label;
    const deviceSnap = (list) => ({
        audio: list
            .filter((d) => d.kind === 'audioinput' || d.kind === 'audiooutput')
            .map(deviceMark)
            .sort()
            .join(','),
        video: list
            .filter((d) => d.kind === 'videoinput')
            .map(deviceMark)
            .sort()
            .join(','),
    });

    // Перечитать список и, если состав или подписи изменились, пересобрать поля
    async function checkDevices() {
        let now;
        try {
            now = deviceSnap(await navigator.mediaDevices.enumerateDevices());
        } catch (e) {
            return;
        }
        const was = deviceSnapshot;
        deviceSnapshot = now;
        if (!was) return;
        if (was.audio !== now.audio) await rebuildDeviceSelects('audio');
        if (was.video !== now.video) await rebuildDeviceSelects('video');
    }
    function watchDeviceChanges() {
        if (deviceWatchDone || !navigator.mediaDevices?.enumerateDevices) return;
        deviceWatchDone = true;
        navigator.mediaDevices
            .enumerateDevices()
            .then((l) => (deviceSnapshot = deviceSnap(l)))
            .catch(() => {});
        let timer = null;
        // событие о смене устройств приходит не во всех браузерах и не на всякую
        // смену: на маке подключение гарнитуры часто только переносит на неё
        // «устройство по умолчанию», и события может не быть вовсе
        navigator.mediaDevices.addEventListener?.('devicechange', () => {
            clearTimeout(timer);
            // системе нужно время доделать переключение, телефону — больше
            timer = setTimeout(checkDevices, 900);
        });
        // поэтому не полагаемся на него: раз в несколько секунд смотрим сами.
        // Перечитывание списка ничего не захватывает и разрешений не просит,
        // поэтому стоит дёшево; на скрытой вкладке не тратимся вовсе.
        keepDeviceChoice();
        setInterval(() => {
            keepDeviceChoice(); // поля появляются не сразу
            if (document.visibilityState === 'visible') checkDevices();
        }, 3000);
    }

    // Пересобираем поля выбора САМИ, из одного лишь перечня устройств.
    //
    // Стоковое обновление сначала заново запрашивает микрофон, и это дважды
    // подводит. В Safari такой запрос посреди звонка не проходит: флаг «звук
    // разрешён» гаснет, а вместе с ним навсегда отключаются и все последующие
    // обновления — список так и остаётся тем, что был на входе (Иван,
    // 2026-08-11). А ещё сток восстанавливает выбор по НОМЕРУ строки: стоит
    // списку измениться — и номер показывает уже на другое устройство.
    // Перечень устройств никакого захвата не требует и разрешений не просит.
    async function rebuildDeviceSelects(kind) {
        if (typeof addChild !== 'function') return;
        let devices;
        try {
            devices = await navigator.mediaDevices.enumerateDevices();
        } catch (e) {
            return;
        }
        const groups =
            kind === 'audio'
                ? [
                      ['audioinput', ['microphoneSelect', 'initMicrophoneSelect']],
                      ['audiooutput', ['speakerSelect', 'initSpeakerSelect']],
                  ]
                : [['videoinput', ['videoSelect', 'initVideoSelect']]];
        for (const [devKind, ids] of groups) {
            const els = ids.map((id) => document.getElementById(id)).filter(Boolean);
            if (!els.length) continue;
            let list = devices.filter((d) => d.kind === devKind);
            if (devKind === 'videoinput' && typeof mmDedupeCameras === 'function') list = mmDedupeCameras(devices);
            if (!list.length) continue;
            for (const el of els) {
                const chosen = el.value;
                // Порядок сохраняем прежний: уже знакомые устройства остаются на
                // своих местах, новые дописываются в конец. Система выдаёт их в
                // произвольном порядке и любит поднимать активное наверх — от
                // этого список перетасовывался на глазах (Иван, 2026-08-11).
                const seen = [...el.options].map((o) => o.value);
                const ordered = [
                    ...seen.map((v) => list.find((d) => d.deviceId === v)).filter(Boolean),
                    ...list.filter((d) => !seen.includes(d.deviceId)),
                ];
                // Собираем пункты отдельно и подменяем разом: если чистить живое
                // поле, между очисткой и восстановлением выбора оно на миг пустое
                // — и меню, построенное в этот момент, ставит галочку не туда.
                const spare = document.createElement('select');
                for (const d of ordered) await addChild(d, [spare]);
                el.replaceChildren(...spare.children);
                // выбор держим за устройством, а не за номером строки
                if ([...el.options].some((o) => o.value === chosen)) el.value = chosen;
            }
        }
    }

    // Выбор держится за УСТРОЙСТВОМ, кто бы список ни пересобрал.
    //
    // Стоковое обновление запоминает номер строки и возвращает его после
    // пересборки. Система же выдаёт устройства в произвольном порядке и любит
    // поднимать активное наверх — и тот же номер показывает уже на другую
    // камеру. Отсюда и расхождение: в настройках выбрана одна, галочка в
    // выпадающем списке стоит на другой (Иван, 2026-08-11). Бороться с
    // перестановками бесполезно, они системные; поэтому запоминаем сам выбор и
    // возвращаем его на место каждый раз, когда список поменялся.
    const stickyChoice = new Map(); // поле -> выбранное устройство
    const DEVICE_SELECTS = [
        'videoSelect',
        'microphoneSelect',
        'speakerSelect',
        'initVideoSelect',
        'initMicrophoneSelect',
        'initSpeakerSelect',
    ];
    function keepDeviceChoice() {
        for (const id of DEVICE_SELECTS) {
            const el = document.getElementById(id);
            if (!el || el.dataset.mmSticky) continue;
            el.dataset.mmSticky = '1';
            if (el.value) stickyChoice.set(id, el.value);
            // выбор человека — единственный источник правды
            el.addEventListener('change', () => {
                if (el.value) stickyChoice.set(id, el.value);
            });
            new MutationObserver(() => {
                const want = stickyChoice.get(id);
                if (!want || el.value === want) return;
                if ([...el.options].some((o) => o.value === want)) el.value = want;
            }).observe(el, { childList: true });
        }
    }

    // список нужен свежим ровно в тот момент, когда его открывают — не ждём
    // очередного круга опроса
    function refreshDevicesOnDemand() {
        document.addEventListener(
            'click',
            (e) => {
                if (e.target.closest?.('#settingsButton, .device-dropdown-toggle, #tabDevicesBtn, #tabAudioBtn')) {
                    checkDevices();
                }
            },
            true
        );
    }
    watchDeviceChanges();
    refreshDevicesOnDemand();

    // перехваты, которые обязаны существовать ДО входа в комнату
    function patchRoomClient() {
        autoRenameOnConflict();
        chatWithoutParticipants();
        dismissLobbyToast();
    }
    (function waitForRoomClient(tries = 0) {
        patchRoomClient();
        if (roomClientProto()?._mmRename || tries > 200) return;
        setTimeout(() => waitForRoomClient(tries + 1), 20);
    })();
    document.addEventListener('DOMContentLoaded', patchRoomClient);

    // Панель кнопок то показывается, то прячется. Отмечаем её состояние на body:
    // по нему CSS поднимает своё превью над панелью и — главное — запрещает
    // нажатия по невидимой панели, иначе тап по пустому месту внизу экрана
    // выключал камеру (Иван, 2026-08-09).
    setInterval(() => {
        // Панель чата закрывают и стоковым крестиком, а класс «панель открыта»
        // снимал только наш обработчик — после этого вёрстка прятала нижний
        // тулбар навсегда, и тапы по экрану переставали его вызывать
        // (Иван, 2026-08-10). Держим класс и признак по факту.
        if (typeof rc !== 'undefined' && rc) {
            const shown = document.getElementById('chatRoom')?.classList.contains('show');
            if (rc.isChatOpen && shown === false) rc.isChatOpen = false;
            const listOpen = !!rc.isParticipantsOpen && !document.getElementById('plist')?.classList.contains('hidden');
            markPanelOpen(!!rc.isChatOpen || listOpen);
        }
        const bar = document.getElementById('bottomButtons');
        if (!bar) return;
        const cs = getComputedStyle(bar);
        const visible = cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) > 0.05;
        document.body.classList.toggle('montemeet-bar-visible', visible);
    }, 250);

    // Переключились в другое приложение и вернулись — браузер успел заморозить
    // вкладку и порвать связь. Сток показывает баннер и ждёт нажатия; пробуем
    // переподключиться сами (Иван, 2026-08-09).
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible') return;
        setTimeout(() => {
            try {
                if (typeof rc === 'undefined' || !rc || !rc.socket) return;
                if (rc.socket.connected) return;
                console.log('Montemeet: соединение потеряно за время в фоне, переподключаемся');
                rc.socket.connect();
            } catch (e) {}
        }, 400);
    });

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
