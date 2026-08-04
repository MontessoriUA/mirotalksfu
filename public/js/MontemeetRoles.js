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
    function splitParticipantsFromChat() {
        if (panelSplitDone || typeof rc === 'undefined' || !rc || !rc.toggleParticipants) return;

        const plistEl = () => document.getElementById('plist');
        const showList = () => {
            plistEl()?.classList.remove('hidden');
            const p = plistEl();
            if (p) p.style.width = '100%';
            if (typeof elemDisplay === 'function') elemDisplay('chat', false);
            rc.isParticipantsOpen = true;
            rc.syncChatToolbarButtons?.();
        };
        const closePanel = () => {
            rc.isParticipantsOpen = false;
            plistEl()?.classList.add('hidden');
            if (rc.isChatOpen) rc.toggleChat(true);
        };

        // participants button: the panel with ONLY the list; second click closes
        rc.toggleParticipants = async function () {
            const listOpen = rc.isChatOpen && !plistEl()?.classList.contains('hidden');
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
        };

        // the list's own X goes through toggleShowParticipants — closing there
        // closes the whole panel instead of surfacing the chat underneath
        rc.toggleShowParticipants = function () {
            closePanel();
        };

        // chat button: always the chat, never the list
        document.getElementById('chatButton')?.addEventListener('click', () => {
            setTimeout(() => {
                if (!rc.isChatOpen) return;
                const p = plistEl();
                p?.classList.add('hidden');
                if (p) p.style.width = '';
                if (typeof elemDisplay === 'function') elemDisplay('chat', true);
                rc.isParticipantsOpen = false;
            }, 60);
        });
        panelSplitDone = true;
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
            });
            if (!stream.getAudioTracks().length) {
                stream.getTracks().forEach((t) => t.stop());
                if (typeof userLog === 'function') {
                    userLog('warning', 'Отметьте галку «Предоставить доступ к звуку» в диалоге браузера', 'top-end', 6000);
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
        // note inside a monitor — bigger, bolder note (Ivan, 2026-08-06)
        btn.innerHTML =
            '<svg viewBox="0 0 20 18" width="24" height="22" fill="currentColor"><rect x="1" y="1.5" width="18" height="11.5" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M8 16h4l.8 1.5H7.2z"/><path d="M13.2 4.2 8.9 5.2v4.1a2 2 0 1 0 1.1 1.8V7.2l2.1-.5v2a2 2 0 1 0 1.1 1.8z"/></svg>';
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
            if (preset === 'lesson') {
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
