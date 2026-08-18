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

// Каждый урок начинается с чистого листа: микрофон и камера на экране входа
// включены, чем бы ни закончился прошлый раз.
//
// Сток помнит последний выбор (INIT_CONFIG) и молча повторяет его при следующем
// входе — достаточно один раз войти беззвучным, например когда в админке стояло
// «студенты входят с выключенным микрофоном», и человек будет входить так
// всегда, месяцами после снятого правила. Ребёнок этого не понимает: он
// говорит, а его не слышат (Иван, 2026-08-19).
//
// Сбрасываем ИМЕННО память, а не состояние после входа: сам экран входа —
// территория человека. Что он выключил там, мы не включаем; наша забота
// только в том, чтобы он попадал на этот экран с включёнными устройствами.
//
// Порядок важен: наши модули стоят в разметке раньше Room.js, а тот читает
// память при разборе файла.
(() => {
    try {
        localStorage.setItem('INIT_CONFIG', JSON.stringify({ audio: true, video: true, audioVideo: true }));
    } catch (e) {
        /* хранилище недоступно — сток отработает как обычно */
    }
})();

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
