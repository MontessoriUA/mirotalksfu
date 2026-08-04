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

    function apply() {
        if (typeof rc === 'undefined' || !rc) return;
        const teacher = typeof isPresenter !== 'undefined' && isPresenter;
        const list = teacher ? HIDE_BOTH : HIDE_STUDENT;
        for (const id of list) {
            const el = document.getElementById(id);
            if (el && el.style.display !== 'none') el.style.display = 'none';
        }
    }

    (async () => {
        try {
            await MontemeetProfile.ready;
            if (MontemeetProfile.roles() !== 'lesson') return;
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
