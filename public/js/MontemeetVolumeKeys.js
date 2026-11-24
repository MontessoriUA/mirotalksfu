'use strict';

/*
 * Montemeet: вернуть кнопкам громкости управление звуком собеседника.
 *
 * Задача. На телефоне кнопки громкости крутят «Вызов», а голос собеседника
 * слушается «Медиа» — поднять его человек не может (Иван, 24.11). Причина
 * подтверждена замерами: разговорного режима аудиосессии требует
 * эхоподавление, и именно оно уводит кнопки. При ?mmec=off кнопки сразу
 * крутят «Медиа», при mmec=remote — снова «Вызов». Выключать эхоподавление
 * нельзя: наушников нет ни у педагогов, ни у студентов.
 *
 * Приём. У Zoom с тем же симптомом помечено решённым: перед стартом звука они
 * на мгновение открывают микрофон КОНКРЕТНОГО устройства по deviceId и сразу
 * закрывают. На телефоне такое устройство есть и без гарнитуры — список с
 * телефона Ивана: «По умолчанию | Speakerphone | Headset earpiece».
 *
 * Что уже проверено и не сработало:
 *   — приём после того, как страница взяла микрофон (кнопки остались на вызове);
 *   — приём до первого захвата, с закрытием потока (то же самое).
 *
 * Разница с Zoom, которую стоит проверить дальше: у них между приёмом и
 * стартом звука проходит вся инициализация SDK, а у нас сразу идёт свой
 * захват — и, возможно, он возвращает сессию в разговорный режим. Поэтому
 * здесь три варианта, переключаемых флагом ?mmvol=:
 *
 *   2 — открыть устройство и закрыть, затем обычный захват (уже проверен);
 *   3 — открыть устройство и НЕ закрывать: держим его открытым весь урок,
 *       рядом с основным захватом;
 *   4 — не держать, а вести сам урок с этого устройства: основной захват
 *       идёт с его deviceId.
 *
 * Судить о результате можно не только по кнопкам: частота микрофонной дорожки
 * на Android выдаёт тракт — 16000 это голосовой, 48000 медийный. Она видна на
 * бейдже в левом верхнем углу (он показывается при ?mmvol= и при ?mmec=).
 */

const MontemeetVolumeKeys = (() => {
    const WANT = /headset earpiece|earpiece|разговорн/i;

    const mode = () => {
        try {
            const v = new URL(location.href).searchParams.get('mmvol');
            const n = Number(v);
            return n >= 2 && n <= 4 ? n : 0;
        } catch (e) {
            return 0;
        }
    };

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

    let chosen = null; // устройство для варианта 4
    let held = null; // поток, который держим открытым (вариант 3)

    // Вызывается ДО основного захвата. Никогда не бросает: что бы здесь ни
    // случилось, урок должен начаться.
    async function beforeCapture() {
        const m = mode();
        if (!m) return;
        try {
            // разрешение — иначе подписи устройств пусты и выбрать не из чего
            const probe = await navigator.mediaDevices.getUserMedia({ audio: true });
            stop(probe);

            const list = await navigator.mediaDevices.enumerateDevices();
            const target = list.find((d) => d.kind === 'audioinput' && WANT.test(d.label || ''));
            if (!target) {
                say({ when: 'volfix', mode: m, found: false });
                return;
            }

            if (m === 4) {
                chosen = target.deviceId; // урок поведём с него же
                say({ when: 'volfix', mode: m, found: true, ok: true });
                return;
            }

            const one = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: target.deviceId } } });
            if (m === 3) {
                held = one; // держим открытым рядом с основным захватом
            } else {
                stop(one);
            }
            say({ when: 'volfix', mode: m, found: true, ok: true });
        } catch (e) {
            say({ when: 'volfix', mode: m, ok: false, why: String(e && e.name).slice(0, 40) });
        }
    }

    // Чем открывать микрофон урока: обычно как было, в варианте 4 — тем же
    // устройством, которым переинициализировали сессию.
    function audio(base) {
        return chosen ? { deviceId: { exact: chosen } } : base;
    }

    return { beforeCapture, audio, mode };
})();
