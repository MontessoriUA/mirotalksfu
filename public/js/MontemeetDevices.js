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
    // Ждать профиль дольше секунды нельзя: и список устройств, и захват звука
    // идут через нас, а человек не должен сидеть перед пустым экраном из-за
    // медленной сети (Иван, 2026-08-19 — перед живым уроком).
    const READY_MS = 1000;
    const profileReady = () =>
        Promise.race([MontemeetProfile.ready, new Promise((r) => setTimeout(r, READY_MS))]).catch(() => null);

    // паттерны из реестра: приоритетное устройство (SplitCam) и то, что при нём прячем
    async function patterns() {
        try {
            await profileReady();
            const dp = MontemeetProfile.get()?.devicePriority || {};
            return { match: String(dp.match || '').toLowerCase(), hide: String(dp.hide || '').toLowerCase() };
        } catch (e) {
            return { match: '', hide: '' };
        }
    }

    const BUSY = new Set(['NotReadableError', 'AbortError', 'TrackStartError']);
    const label = (d) => String(d.label || '').toLowerCase();

    // Камеры, которые кормят SplitCam, заняты им же. Выбрать такую — остаться
    // без картинки: «Already in use» и никакого выхода, кроме как угадать
    // обратно (Иван, 2026-08-19, реальный случай на уроке у педагога). Пока
    // SplitCam есть в системе, прячем их отовсюду, что видит страница, — не
    // только из выпадающего списка.
    //
    // Прячем ТОЛЬКО когда SplitCam действительно найден: на домашнем ноутбуке
    // педагога та же камера — единственная, и прятать её нельзя.
    function installDeviceFilter() {
        const md = navigator.mediaDevices;
        if (!md || md._mmFiltered || typeof md.enumerateDevices !== 'function') return;
        const stock = md.enumerateDevices.bind(md);
        md.enumerateDevices = async function () {
            const list = await stock();
            try {
                const { match, hide } = await patterns();
                if (!hide || !match) return list;
                const hasPriority = list.some((d) => d.kind === 'videoinput' && label(d).includes(match));
                if (!hasPriority) return list;
                const kept = list.filter((d) => !(d.kind === 'videoinput' && label(d).includes(hide)));
                // без камер вообще не оставляем: лучше показать спорную, чем ни одной
                return kept.some((d) => d.kind === 'videoinput') ? kept : list;
            } catch (e) {
                return list;
            }
        };
        md._mmFiltered = true;
    }

    // Устройство занято другим приложением — ищем свободное сами.
    //
    // Сток в этом случае показывает ошибку и оставляет человека ни с чем.
    // Перебираем остальные устройства того же вида, приоритетное пробуем
    // первым; нашли рабочее — подменяем и выбор в списке, чтобы дальше всё шло
    // с ним. Не нашли ни одного — отдаём ошибку стоку (Иван, 2026-08-19).
    function deviceIdOf(constraints, key) {
        const c = constraints?.[key];
        if (!c || typeof c !== 'object') return null;
        const id = c.deviceId;
        return typeof id === 'string' ? id : id?.exact || id?.ideal || null;
    }

    function withDevice(constraints, key, deviceId) {
        const base = constraints?.[key];
        const next = { ...constraints };
        next[key] = typeof base === 'object' && base ? { ...base, deviceId: { exact: deviceId } } : { deviceId: { exact: deviceId } };
        return next;
    }

    function rememberChoice(kind, deviceId) {
        const ids = kind === 'video' ? ['videoSelect', 'initVideoSelect'] : ['microphoneSelect', 'initMicrophoneSelect'];
        for (const id of ids) {
            const el = document.getElementById(id);
            if (el && [...el.options].some((o) => o.value === deviceId)) el.value = deviceId;
        }
    }

    // Профиль звука комнаты — КАЖДОМУ захвату, а не только тому, что делает
    // сама конференция.
    //
    // На входе поток берётся с обычными audio: true, и при входе в комнату
    // конференция переиспользует именно его (produce c init: true). То есть
    // музыкальная комната всё это время работала с речевой обработкой: шумодав
    // и авто-громкость съедали тихие хвосты рояля, а наши настройки применялись
    // только к кодеку (Иван, 2026-08-19). Теперь настройки профиля
    // подмешиваются в любой захват звука, где бы он ни случился.
    async function withProfileAudio(constraints) {
        try {
            if (!constraints?.audio) return constraints;
            await profileReady();
            const a = MontemeetProfile.audioResolved ? MontemeetProfile.audioResolved() : null;
            if (!a) return constraints;
            const base = typeof constraints.audio === 'object' ? constraints.audio : {};
            const audio = {
                ...base,
                echoCancellation:
                    typeof a.echoCancellation === 'string' ? a.echoCancellation : a.echoCancellation !== false,
                autoGainControl: a.autoGainControl !== false,
                noiseSuppression: a.noiseSuppression !== false,
            };
            if (a.voiceIsolation !== undefined) audio.voiceIsolation = !!a.voiceIsolation;
            if (a.channelCount) audio.channelCount = a.channelCount;
            return { ...constraints, audio };
        } catch (e) {
            return constraints;
        }
    }

    // Что браузер применил на самом деле — в консоль: сегодняшняя история с
    // необъяснимым эхом стоила часа именно потому, что фактический режим
    // микрофона не было видно нигде (Иван, 2026-08-19).
    function logApplied(stream) {
        try {
            const t = stream?.getAudioTracks?.()[0];
            if (!t || !t.getSettings) return;
            const s = t.getSettings();
            console.log('Montemeet: микрофон —', {
                эхоподавление: s.echoCancellation,
                шумодав: s.noiseSuppression,
                автоГромкость: s.autoGainControl,
                // Частота — честный индикатор тракта на мобильных: голосовой
                // отдаёт 16 кГц, медийный — 48 кГц. Слову echoCancellation в
                // настройках верить нельзя — оно рапортует запрошенное, а не
                // действительное (2026-08-22, практика библиотеки Recorder).
                частота: s.sampleRate,
                каналов: s.channelCount,
            });
            showMicBadge(s);
        } catch (e) {
            /* не мешаем захвату */
        }
    }

    // Бейдж с фактическим режимом микрофона — только при ?mmec=… в адресе:
    // на телефоне консоль не открыть, а видеть применённое нужно именно там
    function showMicBadge(s) {
        let mmec = null;
        try {
            mmec = new URL(location.href).searchParams.get('mmec');
        } catch (e) {
            /* адрес не разобрался — значит и бейдж не нужен */
        }
        if (!mmec) return;
        let el = document.getElementById('mmMicBadge');
        if (!el) {
            el = document.createElement('div');
            el.id = 'mmMicBadge';
            el.style.cssText =
                'position:fixed;top:8px;left:8px;z-index:99999;background:rgba(0,0,0,.8);color:#7CFC00;' +
                'font:12px/1.5 monospace;padding:6px 10px;border-radius:8px;pointer-events:none;white-space:pre;';
            document.body.appendChild(el);
        }
        el.textContent =
            `mmec=${mmec}
эхо: ${JSON.stringify(s.echoCancellation)}
шумодав: ${s.noiseSuppression}
авто: ${s.autoGainControl}
частота: ${s.sampleRate || '?'} (16000 — голосовой тракт, 48000 — медийный)`;
    }

    function installBusyFallback() {
        const md = navigator.mediaDevices;
        if (!md || md._mmBusy || typeof md.getUserMedia !== 'function') return;
        const stockRaw = md.getUserMedia.bind(md);
        const stock = async (c) => stockRaw(await withProfileAudio(c));
        md.getUserMedia = async function (constraints) {
            try {
                const stream = await stock(constraints);
                if (constraints?.audio) logApplied(stream);
                return stream;
            } catch (err) {
                const key = constraints?.video ? 'video' : constraints?.audio ? 'audio' : null;
                if (!BUSY.has(err?.name) || !key) throw err;
                const kind = key === 'video' ? 'videoinput' : 'audioinput';
                const { match } = await patterns();
                const failed = deviceIdOf(constraints, key);
                const list = (await md.enumerateDevices())
                    .filter((d) => d.kind === kind && d.deviceId && d.deviceId !== failed)
                    .sort((a, b) => Number(label(b).includes(match)) - Number(label(a).includes(match)));
                for (const dev of list) {
                    try {
                        const stream = await stock(withDevice(constraints, key, dev.deviceId));
                        console.warn(`MontemeetDevices: устройство занято, перешли на «${dev.label || dev.deviceId}»`);
                        rememberChoice(key, dev.deviceId);
                        return stream;
                    } catch (e) {
                        /* и это занято — пробуем следующее */
                    }
                }
                throw err;
            }
        };
        md._mmBusy = true;
    }

    // Свободных камер не нашлось — входим без камеры, а не упираемся в ошибку.
    // Сток на этом месте показывает попап и бросает исключение: человек остаётся
    // перед закрытой дверью, хотя урок можно вести и голосом (Иван, 2026-08-19).
    function installCameraGiveUp() {
        if (typeof window.handleMediaError !== 'function' || window.handleMediaError._mm) return;
        const stock = window.handleMediaError;
        const wrapped = function (mediaType, err, ...rest) {
            if (mediaType === 'video' && BUSY.has(err?.name)) {
                console.warn('MontemeetDevices: свободной камеры нет — входим без неё');
                try {
                    if (typeof isVideoAllowed !== 'undefined') isVideoAllowed = false;
                } catch (e) {
                    /* сток ещё не объявил переменную */
                }
                return;
            }
            return stock.apply(this, [mediaType, err, ...rest]);
        };
        wrapped._mm = true;
        window.handleMediaError = wrapped;
    }

    installDeviceFilter();
    installBusyFallback();
    document.addEventListener('DOMContentLoaded', installCameraGiveUp);

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
