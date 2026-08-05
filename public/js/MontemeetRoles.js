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

    function showList() {
        const p = plistEl();
        p?.classList.remove('hidden');
        if (p) p.style.width = '100%';
        if (typeof elemDisplay === 'function') elemDisplay('chat', false);
        rc.isParticipantsOpen = true;
        rc.syncChatToolbarButtons?.();
    }

    function closePanel() {
        rc.isParticipantsOpen = false;
        plistEl()?.classList.add('hidden');
        if (rc.isChatOpen) rc.toggleChat(true);
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
            rc.toggleChat(true); // second click closes
            return;
        }
        if (!rc.isChatOpen) rc.toggleChat(true);
        p?.classList.add('hidden');
        if (p) p.style.width = '';
        if (typeof elemDisplay === 'function') elemDisplay('chat', true);
        rc.isParticipantsOpen = false;
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
        if (!rc.isChatOpen) {
            const saved = BUTTONS.main.chatButton;
            BUTTONS.main.chatButton = false; // the stock open path must not show the chat
            try {
                await rc.toggleChat(true);
            } finally {
                BUTTONS.main.chatButton = saved;
            }
        }
        showList();
    }

    openChatSplit._mm = true;
    toggleParticipantsSplit._mm = true;

    function splitParticipantsFromChat() {
        // re-assert our handlers (the stock init may overwrite them at any point)
        const chatBtn = document.getElementById('chatButton');
        const partBtn = document.getElementById('participantsButton');
        if (chatBtn && chatBtn.onclick !== openChatSplit) chatBtn.onclick = openChatSplit;
        if (partBtn && partBtn.onclick !== toggleParticipantsSplit) partBtn.onclick = toggleParticipantsSplit;
        if (rcReady()) {
            if (!panelSplitDone) {
                // the list's own X closes the whole panel
                rc.toggleShowParticipants = function () {
                    closePanel();
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
        btn.title = on ? 'Звук компьютера: транслируется (клик — выключить)' : 'Транслировать звук компьютера';
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
                            ? 'На macOS звук доступен только из вкладки Chrome: выберите ВКЛАДКУ с плеером и включите «Также предоставить доступ к аудио вкладки»'
                            : 'Отметьте галку «Предоставить доступ к системному звуку» в диалоге браузера',
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
        btn.title = 'Отправить файл';
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
            btn.title = 'Включить камеру участнику';
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
                for (const id of ['initAudioVideoButton', 'initStartScreenButton', 'initVideoMirrorButton']) {
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
            const splitPoll = setInterval(() => {
                splitParticipantsFromChat();
                if (panelSplitDone && pendingPanel === null) clearInterval(splitPoll);
            }, 150);
            setTimeout(() => clearInterval(splitPoll), 30000);
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

    return { apply };
})();
