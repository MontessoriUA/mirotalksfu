'use strict';

/*
 * Montemeet: попытка увести звук собеседника в тот поток, которым на телефоне
 * управляют кнопки громкости.
 *
 * Заход 24.11 (Иван): на телефоне кнопки громкости крутят «Вызов», а голос
 * собеседника слушается ползунка «Медиа» — поднять или убавить его человек
 * просто не может.
 *
 * Почему так. Как только страница берёт микрофон, Android переводит сессию в
 * разговорный режим, и кнопки уходят на громкость вызова. Это известная
 * особенность Chromium (баг 443255997, открыт): попросить «медийный» режим
 * страница не может, прочитать или задать системную громкость — тоже, а
 * нажатия кнопок до неё не доходят вовсе. Значит подогнать громкость под
 * кнопки нельзя; можно попробовать обратное — подогнать звук под кнопки.
 *
 * Приём. Поток, в который попадёт воспроизведение, браузер выбирает в момент
 * его начала. В самом баге предлагают оставлять «Медиа», если звук уже играл
 * к моменту захвата микрофона, — похоже, это наш случай: элементы собеседника
 * заводятся раньше. Поэтому переподключаем их заново, когда микрофон уже взят:
 * есть надежда, что воспроизведение уйдёт в разговорный поток и кнопки начнут
 * им управлять.
 *
 * Чем это проверяется. Прямого способа спросить «каким потоком идёт звук» в
 * вебе нет. Поэтому обратная связь двойная: в журнал пишем, чем отвечает
 * аудиосистема до и после (частота и задержка вывода — на Android разговорный
 * режим обычно 16 кГц, медийный 48), а человеку показываем подсказку, чтобы он
 * тут же нажал кнопки громкости и сказал, что изменилось.
 *
 * Пока — только по флагу в адресе (?mmroute=1). Поведение обычных уроков не
 * меняется, пока приём не подтверждён на живых телефонах.
 *
 * Случаи, которые учтены:
 *  - перезагрузка и возврат «назад»: флаг живёт в адресе, всё повторяется;
 *  - переподключение не удалось (звук не пошёл) — возвращаем как было;
 *  - элементы собеседника пересоздаются по ходу урока — каждый берём один раз;
 *  - свой звук и звук перевода не трогаем вовсе.
 */

(function () {
    const ON = /[?&]mmroute=1/.test(location.search);
    const FIRST_WAIT_MS = 4000; // дать входу закончиться
    const CHECK_MS = 2000; // через сколько судить, пошёл ли звук
    const done = new WeakSet();

    const probe = () => {
        try {
            const C = window.AudioContext || window.webkitAudioContext;
            if (!C) return null;
            const ctx = new C();
            const out = { rate: ctx.sampleRate, out: Math.round((ctx.outputLatency || 0) * 1000), state: ctx.state };
            if (ctx.close) ctx.close().catch(() => {});
            return out;
        } catch (e) {
            return null;
        }
    };

    // MontemeetDiag объявлен через const — в window он не попадает, только в
    // общую область видимости скриптов страницы (те же грабли, что с rc).
    const say = (what, data) => {
        try {
            if (typeof MontemeetDiag !== 'undefined') MontemeetDiag.report?.(what, data);
        } catch (e) {
            /* журнал не обязателен */
        }
    };

    // звук собеседника: поток с дорожкой звука, не наш перевод и не своё превью
    function peerAudio() {
        const out = [];
        for (const el of document.querySelectorAll('audio, video')) {
            if (el.muted || el.dataset.mmTranslate === '1') continue;
            const s = el.srcObject;
            if (!s || typeof s.getAudioTracks !== 'function') continue;
            if (!s.getAudioTracks().length) continue;
            if (!done.has(el)) out.push(el);
        }
        return out;
    }

    function hint(text) {
        let box = document.getElementById('mmRouteHint');
        if (!box) {
            box = document.createElement('div');
            box.id = 'mmRouteHint';
            box.style.cssText =
                'position:fixed;z-index:2147483100;left:50%;transform:translateX(-50%);' +
                'top:calc(env(safe-area-inset-top,0px) + 12px);max-width:min(420px,calc(100vw - 24px));' +
                'padding:12px 16px;border-radius:12px;background:rgba(24,24,29,.94);color:#eceef2;' +
                'font:14px/1.4 system-ui,-apple-system,sans-serif;text-align:center;pointer-events:none;' +
                'box-shadow:0 8px 28px rgba(0,0,0,.45)';
            document.body.appendChild(box);
        }
        box.textContent = text;
        clearTimeout(hint._off);
        hint._off = setTimeout(() => box.remove(), 8000);
    }

    async function reconnect(el) {
        done.add(el);
        const stream = el.srcObject;
        const before = probe();
        const wasTime = el.currentTime;

        try {
            el.srcObject = null;
            await new Promise((r) => setTimeout(r, 60));
            el.srcObject = stream;
            const p = el.play();
            if (p && typeof p.catch === 'function') await p.catch(() => {});
        } catch (e) {
            say('audio-route', { when: 'reconnect-failed', why: String(e && e.message).slice(0, 80) });
            return;
        }

        setTimeout(() => {
            const alive = !el.paused && el.currentTime > 0;
            const after = probe();
            say('audio-route', { when: 'reconnect', alive, before, after });
            if (!alive) {
                // звук не пошёл — возвращаем как было, урок важнее опыта
                try {
                    el.srcObject = stream;
                    el.play().catch(() => {});
                } catch (e) {
                    /* уже ничего не поделать */
                }
                hint('Переключить звук не вышло, вернул как было');
                return;
            }
            hint('Звук переподключён. Нажмите кнопки громкости — что теперь меняется?');
        }, CHECK_MS);

        return wasTime;
    }

    function tick() {
        const els = peerAudio();
        for (const el of els) reconnect(el);
    }

    if (!ON) return;
    setTimeout(() => {
        tick();
        setInterval(tick, 5000); // собеседник мог подключиться позже
    }, FIRST_WAIT_MS);
})();
