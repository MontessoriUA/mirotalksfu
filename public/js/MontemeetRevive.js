'use strict';

/*
 * Montemeet: оживление собственной дорожки, когда она умерла.
 *
 * Заход 24.11 (Иван): «при подключениях продолжаются проблемы — то собеседник
 * не видит мою камеру, то звук. Встречается при каждом третьем заходе».
 * Лечилось всегда одинаково: выключить и снова включить микрофон или камеру.
 *
 * Что происходит. Продюсер у нас остаётся живым, а дорожка под ним — нет:
 * система отбирает устройство (другое приложение, звонок, уход браузера в
 * фон), и трек переходит в ended или надолго в muted. Серверу при этом
 * по-прежнему видно «микрофон включён», и в журнале ровно так и было:
 * mic: "on", heard: 0 — звука нет, а никто не жалуется. Собеседник видит
 * чёрный прямоугольник или тишину.
 *
 * Стоковая сверка (reconcileConsumers) этого не лечит: она про ПРИЁМ, следит
 * за тем, что мы потребляем чужое, и ходит раз в тридцать секунд. Здесь же
 * беда на ОТПРАВКЕ, и чинится она тем же, что человек делает руками, —
 * пересозданием продюсера.
 *
 * Поэтому: следим за своими дорожками и, если включённая дорожка умерла или
 * молчит слишком долго, передёргиваем её сами. Молча: человеку незачем знать,
 * что у него отобрали микрофон, — ему нужно, чтобы его слышали.
 *
 * Осторожности:
 *  — лечим только то, что человек считает включённым (переключатель в нужном
 *    положении); выключил сам — не трогаем;
 *  — не чаще раза в 20 секунд и не больше трёх попыток подряд: если устройство
 *    занято другим приложением, бесконечное передёргивание не поможет, а
 *    помешает;
 *  — вкладка в фоне на телефоне — обычное дело, и система там глушит захват
 *    законно: ждём возвращения, а не чиним.
 */

(function () {
    const EVERY_MS = 3000;
    const MUTED_PATIENCE_MS = 6000; // сколько терпим молчащую дорожку
    const COOLDOWN_MS = 20000;
    const MAX_TRIES = 3;

    const state = {
        audioType: { mutedSince: 0, lastFix: 0, tries: 0 },
        videoType: { mutedSince: 0, lastFix: 0, tries: 0 },
    };

    const say = (data) => {
        try {
            if (typeof MontemeetDiag !== 'undefined') MontemeetDiag.report?.('track', data);
        } catch (e) {
            /* журнал не обязателен */
        }
    };

    const client = () => (typeof rc !== 'undefined' && rc && rc.isConnected && rc.isConnected() ? rc : null);

    // Человек считает устройство включённым ровно тогда, когда живёт продюсер:
    // выключая микрофон или камеру, клиент его закрывает. Отдельных флагов для
    // этого у него нет, и выдумывать их не нужно.

    function trackOf(r, kind) {
        try {
            const id = r.producerLabel.get(kind);
            if (!id) return null;
            const p = r.producers.get(id);
            return p && p.track ? p.track : null;
        } catch (e) {
            return null;
        }
    }

    function check() {
        const r = client();
        if (!r || document.hidden) return; // в фоне система глушит захват законно

        for (const kind of ['audioType', 'videoType']) {
            const st = state[kind];
            const now = Date.now();
            const track = trackOf(r, kind);

            if (!track) {
                st.mutedSince = 0;
                continue;
            }

            const dead = track.readyState === 'ended';
            const silent = track.muted === true;
            if (!dead && !silent) {
                st.mutedSince = 0;
                st.tries = 0; // ожила сама — счётчик обнуляем
                continue;
            }
            if (silent && !dead) {
                if (!st.mutedSince) st.mutedSince = now;
                if (now - st.mutedSince < MUTED_PATIENCE_MS) continue;
            }

            if (now - st.lastFix < COOLDOWN_MS || st.tries >= MAX_TRIES) continue;
            st.lastFix = now;
            st.tries++;
            st.mutedSince = 0;

            say({ kind: kind === 'audioType' ? 'audio' : 'video', state: dead ? 'ended' : 'muted', fix: st.tries });
            try {
                // устройство берём то же, что выбрано сейчас: без него produce
                // возьмёт умолчательное и может молча сменить микрофон
                const sel = document.getElementById(kind === 'audioType' ? 'microphoneSelect' : 'videoSelect');
                r.closeThenProduce(kind, sel && sel.value ? sel.value : null); // то же, что человек делает руками
            } catch (e) {
                /* не вышло — попробуем в следующий раз */
            }
        }
    }

    setInterval(check, EVERY_MS);
})();
