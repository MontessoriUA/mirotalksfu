'use strict';

/*
 * Montemeet: preferred capture devices. School computers use SplitCam as a
 * virtual camera/mic aggregator — when a device label matches the configured
 * pattern (montemeet-profiles.json -> devicePriority.match), that device is
 * selected as the default camera and microphone, overriding the saved choice
 * (school machines are shared — predictability wins). No matching device ->
 * stock behavior. Speakers are never touched. De facto teacher-only: student
 * machines have no SplitCam; explicit role gating arrives with stage 2 roles.
 */

const MontemeetDevices = (() => {
    async function applyPriority() {
        try {
            await MontemeetProfile.ready;
            const match = (MontemeetProfile.get()?.devicePriority?.match || '').toLowerCase();
            if (!match) return;

            const prefer = (selects) => {
                const present = selects.filter(Boolean);
                const source = present.find((s) => s.options.length);
                if (!source) return false;
                const hit = [...source.options].find((o) => (o.text || '').toLowerCase().includes(match));
                if (!hit) return false;
                for (const s of present) s.value = hit.value;
                return true;
            };

            const video = prefer([
                typeof videoSelect !== 'undefined' ? videoSelect : null,
                typeof initVideoSelect !== 'undefined' ? initVideoSelect : null,
            ]);
            const audio = prefer([
                typeof microphoneSelect !== 'undefined' ? microphoneSelect : null,
                typeof initMicrophoneSelect !== 'undefined' ? initMicrophoneSelect : null,
            ]);

            if (video || audio) console.log('MontemeetDevices: priority device selected', { match, video, audio });
        } catch (e) {
            console.warn('MontemeetDevices.applyPriority failed', e);
        }
    }

    return { applyPriority };
})();
