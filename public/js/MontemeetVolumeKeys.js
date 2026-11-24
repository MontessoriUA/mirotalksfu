'use strict';

/*
 * Montemeet: вернуть кнопкам громкости управление звуком собеседника.
 *
 * Задача. На телефоне кнопки громкости крутят «Вызов», а голос собеседника
 * слушается «Медиа» — поднять его человек не может (Иван, 24.11). Причина
 * подтверждена его замерами: разговорного режима аудиосессии требует
 * эхоподавление, и именно оно уводит кнопки. При ?mmec=off кнопки сразу
 * крутят «Медиа», при mmec=remote — снова «Вызов». Выключать эхоподавление
 * нельзя: наушников нет ни у педагогов, ни у студентов.
 *
 * Приём. У Zoom с тем же симптомом помечено решённым: перед стартом звука они
 * на мгновение открывают микрофон КОНКРЕТНОГО устройства по deviceId и сразу
 * закрывают — этим аудиосессия переинициализируется. У них это «Headset
 * earpiece»; на телефоне оно есть и без гарнитуры (список с телефона Ивана:
 * «По умолчанию | Speakerphone | Headset earpiece»).
 *
 * Первая попытка не удалась, и причина была в порядке. Мы делали приём после
 * того, как страница уже взяла микрофон для экрана выбора устройств: сессия
 * успевала уйти в разговорный режим и возвращалась в него снова. У Zoom приём
 * идёт ДО первого захвата. Поэтому здесь он встроен в самое начало опроса
 * устройств (Room.js, initEnumerateDevices) и работает так:
 *
 *   1. короткий запрос микрофона — только чтобы браузер выдал подписи
 *      устройств: без разрешения они пусты и выбрать нужное не из чего;
 *   2. открываем «Headset earpiece» по deviceId и сразу закрываем;
 *   3. и только после этого идёт наш обычный захват.
 *
 * Пока по флагу ?mmvol=2: приём не из документации, а из практики.
 */

const MontemeetVolumeKeys = (() => {
    const WANT = /headset earpiece|earpiece|разговорн/i;

    const say = (data) => {
        try {
            if (typeof MontemeetDiag !== 'undefined') MontemeetDiag.report?.('audio-route', data);
        } catch (e) {
            /* журнал не обязателен */
        }
    };

    const stop = (stream) => {
        try {
            stream.getTracks().forEach((t) => t.stop());
        } catch (e) {
            /* уже остановлен */
        }
    };

    // Вызывается ДО основного захвата. Ничего не возвращает и никогда не
    // бросает: что бы здесь ни случилось, урок должен начаться.
    async function beforeCapture() {
        if (!/[?&]mmvol=2/.test(location.search)) return;
        try {
            // 1. разрешение — иначе подписи устройств пусты
            const probe = await navigator.mediaDevices.getUserMedia({ audio: true });
            stop(probe);

            // 2. нужное устройство
            const list = await navigator.mediaDevices.enumerateDevices();
            const target = list.find((d) => d.kind === 'audioinput' && WANT.test(d.label || ''));
            if (!target) {
                say({ when: 'volfix2', found: false });
                return;
            }
            const one = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: target.deviceId } } });
            stop(one);
            say({ when: 'volfix2', found: true, ok: true });
        } catch (e) {
            say({ when: 'volfix2', ok: false, why: String(e && e.name).slice(0, 40) });
        }
    }

    return { beforeCapture };
})();
