'use strict';

/*
 * Montemeet: оживление собственной дорожки, когда она умерла.
 *
 * Заход 24.11 (Иван): «при подключениях продолжаются проблемы — то собеседник
 * не видит мою камеру, то звук. Встречается при каждом третьем заходе».
 * Лечилось всегда одинаково: выключить и снова включить устройство.
 *
 * Что происходит. Продюсер у нас остаётся живым, а дорожка под ним — нет:
 * трек уходит в ended или надолго в muted. Серверу при этом по-прежнему видно
 * «микрофон включён», и в журнале ровно так и было: mic: "on", heard: 0 —
 * звука нет, и никто об этом не узнаёт. Стоковая сверка (reconcileConsumers)
 * этого не лечит: она про ПРИЁМ и ходит раз в тридцать секунд.
 *
 * Лечим ПО СОБЫТИЮ, а не по часам (замечание Ивана 24.11: «если мы ловим
 * нездоровое состояние — тогда и надо передёргивать, а не раз в»). У дорожки
 * есть ended, mute и unmute: на ended реагируем сразу, на mute даём полторы
 * секунды — он бывает мгновенным при смене устройства и проходит сам.
 *
 * Опрос остаётся ровно для одного: подписаться на события новых дорожек.
 * Лечение из него не вызывается никогда.
 *
 * Это лечение симптома, и мы это знаем. Первопричина пока не найдена: в
 * мобильном приложении такого не наблюдается, значит дело не в сети и не в
 * сервере, а в том, как браузер держит захват. Поэтому каждый случай пишем в
 * журнал вместе с обстановкой — скрыта ли вкладка, давно ли менялся список
 * устройств, какое устройство было в дорожке; по этим записям и будем искать
 * причину.
 */

(function () {
    const HOOK_EVERY_MS = 2000; // только подписка на новые дорожки
    const MUTE_PATIENCE_MS = 1500; // mute бывает мгновенным — даём ему пройти
    const COOLDOWN_MS = 10000;
    const MAX_TRIES = 3;

    const KINDS = { audioType: 'audio', videoType: 'video' };
    const state = {
        audioType: { lastFix: 0, tries: 0, timer: null },
        videoType: { lastFix: 0, tries: 0, timer: null },
    };
    let lastDeviceChange = 0;
    // Когда дорожка умирает в первые секунды после входа — это разговор двух
    // захватов: страница держит поток для экрана выбора устройств, а комната
    // берёт свой. В приложении такого нет, там захват один, — и первопричину
    // мы ищем именно здесь (Иван, 24.11).
    const openedAt = Date.now();

    const say = (data) => {
        try {
            if (typeof MontemeetDiag !== 'undefined') MontemeetDiag.report?.('track', data);
        } catch (e) {
            /* журнал не обязателен */
        }
    };

    try {
        navigator.mediaDevices?.addEventListener?.('devicechange', () => (lastDeviceChange = Date.now()));
    } catch (e) {
        /* браузер не умеет — не беда */
    }

    const client = () => (typeof rc !== 'undefined' && rc && rc.isConnected && rc.isConnected() ? rc : null);

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

    // Человек считает устройство включённым ровно тогда, когда живёт продюсер:
    // выключая микрофон или камеру, клиент его закрывает. Отдельных флагов для
    // этого у клиента нет, и выдумывать их не нужно.
    function revive(kind, why, track) {
        const r = client();
        if (!r) return;
        const st = state[kind];
        const now = Date.now();
        // предел не ради расписания, а против шторма: если устройство занято
        // другим приложением, бесконечное передёргивание только мешает
        if (now - st.lastFix < COOLDOWN_MS || st.tries >= MAX_TRIES) return;
        st.lastFix = now;
        st.tries++;

        say({
            kind: KINDS[kind],
            state: why,
            fix: st.tries,
            hidden: !!document.hidden,
            afterDev: lastDeviceChange ? Math.round((now - lastDeviceChange) / 1000) : null,
            sinceOpen: Math.round((now - openedAt) / 1000),
            device: String((track && track.label) || '').slice(0, 40),
        });

        try {
            // устройство берём то же, что выбрано: иначе produce возьмёт
            // умолчательное и может молча сменить микрофон
            const sel = document.getElementById(kind === 'audioType' ? 'microphoneSelect' : 'videoSelect');
            r.closeThenProduce(kind, sel && sel.value ? sel.value : null);
        } catch (e) {
            /* не вышло — следующий случай попробуем снова */
        }
    }

    function hook(kind, track) {
        if (!track || track.mmRevive) return;
        track.mmRevive = true;
        const st = state[kind];

        track.addEventListener('ended', () => revive(kind, 'ended', track));

        track.addEventListener('mute', () => {
            clearTimeout(st.timer);
            st.timer = setTimeout(() => {
                // в фоне система глушит захват законно — это не поломка
                if (track.muted && !document.hidden) revive(kind, 'muted', track);
            }, MUTE_PATIENCE_MS);
        });

        track.addEventListener('unmute', () => {
            clearTimeout(st.timer);
            st.tries = 0; // ожила сама — счётчик попыток обнуляем
        });
    }

    setInterval(() => {
        const r = client();
        if (!r) return;
        for (const kind of Object.keys(KINDS)) hook(kind, trackOf(r, kind));
    }, HOOK_EVERY_MS);
})();
