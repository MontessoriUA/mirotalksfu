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
        },
        consumerVideo: {
            sendMessageButton: false,
            sendFileButton: false,
            sendVideoButton: false,
            geolocationButton: false,
            drawingButton: false,
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

    function apply() {
        if (typeof rc === 'undefined' || !rc) return;
        const preset = MontemeetProfile.roles();
        const teacher = typeof isPresenter !== 'undefined' && isPresenter;
        const list = preset === 'concert' ? HIDE_CONCERT : teacher ? HIDE_BOTH : HIDE_STUDENT;
        for (const id of list) {
            const el = document.getElementById(id);
            if (el && el.style.display !== 'none') el.style.display = 'none';
        }
    }

    (async () => {
        try {
            await MontemeetProfile.ready;
            const preset = MontemeetProfile.roles();
            if (!['lesson', 'concert'].includes(preset)) return;

            if (preset === 'lesson') {
                // role-independent BUTTONS overrides — as early as BUTTONS exists,
                // so tiles are built without the trimmed buttons at all
                const early = setInterval(() => {
                    if (typeof BUTTONS !== 'undefined' && patchButtons(BUTTONS_LESSON_BOTH)) clearInterval(early);
                }, 100);
                setTimeout(() => clearInterval(early), 20000);
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
