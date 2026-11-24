'use strict';

/*
 * Montemeet: вернуть кнопкам громкости управление звуком собеседника.
 *
 * Задача. На телефоне кнопки громкости крутят «Вызов», а голос собеседника
 * слушается «Медиа» — поднять его человек не может (Иван, 24.11). Причина
 * выяснена и подтверждена его же замерами: разговорного режима аудиосессии
 * требует эхоподавление, и именно оно уводит кнопки на громкость вызова. При
 * ?mmec=off кнопки сразу начинают крутить «Медиа», при mmec=remote — опять
 * «Вызов». Выключать эхоподавление нельзя: наушников нет ни у педагогов, ни у
 * студентов.
 *
 * Приём. У Zoom с тем же симптомом помечено решённым: перед стартом звука они
 * на мгновение открывают микрофон КОНКРЕТНОГО устройства по deviceId и сразу
 * закрывают его — этим аудиосессия переинициализируется. У них это «Headset
 * earpiece», то есть разговорный динамик; на телефоне он есть и без гарнитуры —
 * в журнале с телефона Ивана список микрофонов оказался таким:
 * «По умолчанию | Speakerphone | Headset earpiece».
 *
 * Делается один раз, после того как разрешение на микрофон уже выдано (иначе
 * подписи устройств пусты и выбрать нужное не из чего) и до входа в комнату —
 * в том числе пока человек ждёт в зале ожидания.
 *
 * Пока только по флагу ?mmvol=1: приём не из документации, а из практики, и
 * проверить его надо на живом телефоне, прежде чем включать всем.
 */

(function () {
    const ON = /[?&]mmvol=1/.test(location.search);
    if (!ON) return;

    const WANT = /headset earpiece|earpiece|разговорн/i;
    const EVERY_MS = 2000;
    const GIVE_UP_MS = 90000;

    const say = (data) => {
        try {
            if (typeof MontemeetDiag !== 'undefined') MontemeetDiag.report?.('audio-route', data);
        } catch (e) {
            /* журнал не обязателен */
        }
    };

    let done = false;
    const startedAt = Date.now();

    async function apply() {
        if (done) return;
        if (Date.now() - startedAt > GIVE_UP_MS) {
            done = true;
            return;
        }
        let list = [];
        try {
            list = await navigator.mediaDevices.enumerateDevices();
        } catch (e) {
            return;
        }
        const mics = list.filter((d) => d.kind === 'audioinput');
        // подписи пусты — значит разрешение ещё не выдано, ждём
        if (!mics.length || !mics.some((d) => d.label)) return;

        done = true;
        const target = mics.find((d) => WANT.test(d.label || ''));
        if (!target) {
            say({ when: 'volfix', found: false });
            return;
        }
        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                audio: { deviceId: { exact: target.deviceId } },
            });
            stream.getTracks().forEach((t) => t.stop());
            say({ when: 'volfix', found: true, ok: true });
        } catch (e) {
            say({ when: 'volfix', found: true, ok: false, why: String(e && e.name).slice(0, 40) });
        }
    }

    const timer = setInterval(() => {
        if (done) {
            clearInterval(timer);
            return;
        }
        apply();
    }, EVERY_MS);
    apply();
})();
