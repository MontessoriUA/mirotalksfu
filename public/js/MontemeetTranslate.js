'use strict';

// Montemeet: синхронный перевод голосом, сторона браузера.
//
// Разбор и замеры — Montemeet/app-spec/TRANSLATE.md. Коротко об устройстве:
// копия своего микрофона уходит на сервер вторым каналом по socket.io, сервер
// держит сессию с переводчиком и возвращает перевод только тем, кому он нужен.
// Медиасервер не трогается: ни новых дорожек, ни правок в тракте урока.
//
// Что здесь:
//   • отвод звука (MontemeetTranslateTap.js) и отправка кусками по 100 мс;
//   • воспроизведение перевода голосом, PCM16 24 кГц, очередью;
//   • приглушение оригинала, пока звучит перевод;
//   • показ того, что переводчик услышал и что сказал.
//
// Почему не «кнопка удержания», как было задумано сперва: педагогу нужны обе
// руки — он играет. Поэтому здесь тумблер на урок, а отделять речь от
// инструмента будет детектор речи, отдельной работой (TRANSLATE.md §9.2).
//
// Включается только в комнатах, где перевод разрешён сервером: если сервер
// молчит, ни один обработчик не срабатывает и всё идёт как раньше.

const MontemeetTranslate = (() => {
    const CHUNK_MS = 100;
    const OUT_RATE = 24000; // перевод приходит в этой частоте
    // Оригинал на время перевода уводим почти в фон: на −12 дБ он ещё спорил с
    // переводом и мешал слушать (Иван, 24.11). −22 дБ — слышно, что человек
    // говорит, но слова не разбираются и не отвлекают.
    const DUCK = 0.05;
    // Приглушение ведём плавно и с удержанием. Резкий скачок громкости слышен
    // сам по себе, а между кусками перевода приходят паузы в полсекунды — на
    // них приглушение отпускало и тут же возвращалось, и оригинал «дёргался»
    // (Иван, 24.11). Удержание длиннее этих пауз, спад быстрый, возврат мягкий.
    const DUCK_HOLD_MS = 900; // держим приглушение после конца куска
    const DUCK_DOWN_MS = 120; // уводим вниз быстро — иначе перевод начинается в шуме
    const DUCK_UP_MS = 600; // возвращаем мягко
    const DUCK_TICK_MS = 40;
    const JITTER_S = 0.12; // запас перед началом воспроизведения — против заикания
    const SEND_TAIL_MS = 600; // сколько ещё не слать свой звук после перевода
    const SEND_TAIL_LOOP_MS = 200; // с петлёй эхоподавитель помогает — хвост короче
    const MAX_QUEUE_S = 10; // отбрасываем остаток только при явном завале:
    // на 3 с длинный перевод обрывался на полузвуке (заход 24.11)

    let socket = null;
    let remoteAudioEl = null;
    let log = (...a) => console.log('[Перевод]', ...a);

    let micCtx = null;
    let micSrc = null;
    let tap = null;
    let micStream = null;

    let playCtx = null;
    let playDest = null; // куда отдаём перевод: петля RTCPeerConnection или динамик напрямую
    let playGain = null;
    let loopEl = null; // <audio>, в котором перевод приходит «удалённой» дорожкой
    let loopPc = null;
    let playAt = 0;
    const queued = []; // запланированные куски — чтобы было что гасить
    let duckUntil = 0;
    let duckTimer = null;
    let muteSendUntil = 0; // до какого момента не отправляем свой звук переводчику
    let voiceGain = 0.5; // громкость перевода: тише оригинала, заодно вдвое меньше эха

    let on = false;
    let inited = false;
    let myLang = '';
    const onText = [];

    // ---------- приглушение оригинала ----------
    //
    // Грубо, зато без перестройки тракта: у элементов <audio> участников
    // понижаем громкость, пока играет перевод. Инструмент при этом тоже
    // приглушится — поэтому на музыкальных уроках перевод и должен звучать
    // только в паузах, а это задача детектора речи.

    let duckLevel = 1; // текущий множитель громкости оригинала
    let duckWarned = false;

    // Раскладываем текущий уровень по звучащим элементам. Ищем по всему
    // документу, а не в одном контейнере: звук собеседника может идти и через
    // <video>, и элементы пересоздаются по ходу урока. Своё превью всегда
    // muted — его не трогаем, как и сам перевод.
    function applyDuckLevel() {
        const els = document.querySelectorAll('audio, video');
        let touched = 0;
        for (const el of els) {
            if (el.muted || el.dataset.mmTranslate === '1') continue;
            if (el.dataset.mmFullVolume === undefined) el.dataset.mmFullVolume = String(el.volume ?? 1);
            const full = Number(el.dataset.mmFullVolume) || 1;
            el.volume = Math.max(0, Math.min(1, full * duckLevel));
            touched++;
        }
        if (!touched && duckLevel < 1 && !duckWarned) {
            duckWarned = true;
            log('приглушать нечего: звучащих элементов не нашлось');
        }
    }

    function setDuck(active) {
        // мгновенная установка — только когда перевод выключают совсем
        duckUntil = 0;
        duckLevel = active ? DUCK : 1;
        applyDuckLevel();
    }

    function duckNow() {
        if (duckTimer) return;
        const down = (1 - DUCK) / Math.max(1, DUCK_DOWN_MS / DUCK_TICK_MS);
        const up = (1 - DUCK) / Math.max(1, DUCK_UP_MS / DUCK_TICK_MS);
        duckTimer = setInterval(() => {
            const target = Date.now() < duckUntil ? DUCK : 1;
            if (duckLevel !== target) {
                const step = target < duckLevel ? down : up;
                duckLevel =
                    Math.abs(target - duckLevel) <= step ? target : duckLevel + (target > duckLevel ? step : -step);
                applyDuckLevel();
            }
            if (duckLevel === 1 && target === 1) {
                clearInterval(duckTimer);
                duckTimer = null;
            }
        }, DUCK_TICK_MS);
    }

    // ---------- воспроизведение перевода ----------

    // Петля из двух RTCPeerConnection внутри страницы: перевод уходит в pc1 и
    // возвращается на pc2 «удалённой» дорожкой, которая играется через <audio>.
    //
    // Зачем так. Эхоподавитель браузера берёт опорой то, что играет тракт связи,
    // а вывод обычного AudioContext туда исторически не попадает — поэтому наш
    // перевод звучал из динамика, возвращался в микрофон и уходил собеседнику
    // эхом (заход 24.11). Через петлю он идёт тем же путём, что голос
    // собеседника, и эхоподавитель видит его как свою опору. Совет мобильной
    // сессии: медиатракт урока при этом не трогается, цена — Opus туда-обратно
    // и +20…60 мс к задержке.
    //
    // Если петля почему-то не поднялась, играем напрямую, как раньше.
    async function buildLoop() {
        const dest = playCtx.createMediaStreamDestination();
        const el = document.createElement('audio');
        el.autoplay = true;
        el.dataset.mmTranslate = '1'; // себя не приглушаем
        document.body.appendChild(el);

        const pc1 = new RTCPeerConnection();
        const pc2 = new RTCPeerConnection();
        pc1.onicecandidate = (e) => e.candidate && pc2.addIceCandidate(e.candidate).catch(() => {});
        pc2.onicecandidate = (e) => e.candidate && pc1.addIceCandidate(e.candidate).catch(() => {});
        pc2.ontrack = (e) => {
            el.srcObject = e.streams[0];
            el.play().catch(() => {});
        };
        for (const t of dest.stream.getAudioTracks()) pc1.addTrack(t, dest.stream);

        const offer = await pc1.createOffer();
        await pc1.setLocalDescription(offer);
        await pc2.setRemoteDescription(offer);
        const answer = await pc2.createAnswer();
        await pc2.setLocalDescription(answer);
        await pc1.setRemoteDescription(answer);

        loopEl = el;
        loopPc = { pc1, pc2 };
        return dest;
    }

    async function ensureOutput() {
        if (playDest) return;
        if (!playCtx) playCtx = new AudioContext({ sampleRate: OUT_RATE });
        if (playCtx.state !== 'running') playCtx.resume().catch(() => {});

        // громкость перевода: тише оригинала — это прямо уменьшает и эхо
        playGain = playCtx.createGain();
        playGain.gain.value = voiceGain;

        try {
            const dest = await buildLoop();
            playGain.connect(dest);
            playDest = dest;
            log('перевод идёт через петлю — эхоподавитель видит его своей опорой');
        } catch (err) {
            playGain.connect(playCtx.destination);
            playDest = playCtx.destination;
            log('петля не поднялась, играю напрямую:', err.message);
        }
    }

    function playPcm16(b64) {
        try {
            if (!playCtx || !playDest) {
                // первый кусок приходит до того, как вывод готов: поднимаем и
                // проигрываем следом, иначе потеряем начало фразы
                ensureOutput().then(() => playPcm16(b64));
                return;
            }
            if (playCtx.state !== 'running') playCtx.resume().catch(() => {});

            const raw = atob(b64);
            const n = raw.length >> 1;
            if (!n) return;
            const buf = playCtx.createBuffer(1, n, OUT_RATE);
            const ch = buf.getChannelData(0);
            for (let i = 0; i < n; i++) {
                const lo = raw.charCodeAt(i * 2);
                const hi = raw.charCodeAt(i * 2 + 1);
                let v = (hi << 8) | lo;
                if (v >= 0x8000) v -= 0x10000;
                ch[i] = v / 0x8000;
            }

            const src = playCtx.createBufferSource();
            src.buffer = buf;
            src.connect(playGain);
            queued.push(src);
            src.onended = () => {
                const i = queued.indexOf(src);
                if (i >= 0) queued.splice(i, 1);
            };
            // куски приходят подряд, поэтому ставим их в очередь встык
            // Запас перед началом: куски идут по сети неровно, и без него
            // перевод заикается на каждом разрыве (заход 24.11).
            // Куски играем строго встык, в порядке прихода. Сдвигать указатель
            // назад нельзя: уже запланированные куски продолжают играть по
            // своему расписанию, и новые накладываются поверх — на заходе 24.11
            // это слышалось как «сначала конец фразы, потом поверх начало».
            // Если очередь действительно убежала, её надо не сдвигать, а гасить.
            const now = playCtx.currentTime;
            if (playAt < now + 0.05) playAt = now + JITTER_S;
            else if (playAt > now + MAX_QUEUE_S) {
                for (const old of queued.splice(0, queued.length)) {
                    try {
                        old.stop();
                    } catch {
                        /* уже доиграл */
                    }
                }
                playAt = now + JITTER_S;
                log('перевод отстал больше ' + MAX_QUEUE_S + ' с — остаток отброшен');
            }
            src.start(playAt);
            playAt += buf.duration;

            const endsInMs = (playAt - now) * 1000;
            // Ворота отправки держим всегда, пока перевод звучит. Сначала мы
            // понадеялись на петлю: перевод идёт путём связи, и эхоподавитель
            // браузера должен вычитать его из микрофона сам. На живом уроке он
            // не справился — переводчики услышали друг друга и заговорили сами
            // с собой (Иван, 24.11). Поэтому с петлёй хвост короткий, лишь бы
            // не ловить собственный хвост перевода, а без петли — прежний
            // длинный: там вся надежда на ворота.
            const tail = loopPc ? SEND_TAIL_LOOP_MS : SEND_TAIL_MS;
            muteSendUntil = Math.max(muteSendUntil, Date.now() + endsInMs + tail);
            duckUntil = Math.max(duckUntil, Date.now() + endsInMs + DUCK_HOLD_MS);
            duckNow();
            markVoice(true);
            clearTimeout(playPcm16._off);
            playPcm16._off = setTimeout(() => markVoice(false), buf.duration * 1000 + 300);
        } catch (err) {
            log('не удалось проиграть перевод:', err.message);
        }
    }

    // ---------- отвод своего звука ----------

    async function startTap(stream) {
        if (typeof AudioWorkletNode === 'undefined') throw new Error('AudioWorklet не поддерживается');
        // просим сразу 16 кГц: браузер пересчитает сам, и нам не надо
        micCtx = new AudioContext({ sampleRate: 16000, latencyHint: 'interactive' });
        if (micCtx.state !== 'running') {
            await Promise.race([micCtx.resume(), new Promise((r) => setTimeout(r, 1000))]);
        }
        await micCtx.audioWorklet.addModule('../js/MontemeetTranslateTap.js');

        micSrc = micCtx.createMediaStreamSource(stream);
        tap = new AudioWorkletNode(micCtx, 'MontemeetTranslateTap', {
            numberOfInputs: 1,
            numberOfOutputs: 1,
            channelCount: 1,
            channelCountMode: 'explicit',
        });
        tap.port.onmessage = (e) => {
            if (!on || !socket) return;
            // Пока звучит перевод, свой звук переводчику не шлём. Иначе он
            // слышит из динамика собственный перевод, переводит его снова, и
            // урок превращается в эхо с заиканием (заход 24.11). Наушники
            // снимают вопрос совсем, но рассчитывать на них нельзя.
            if (Date.now() < muteSendUntil) return;
            const pcm = e.data;
            let s = '';
            const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
            for (let i = 0; i < bytes.length; i += 0x8000) {
                s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
            }
            socket.emit('translateAudio', { audio: btoa(s) });
        };
        micSrc.connect(tap);
        // выход воркета молчит, но граф должен куда-то идти
        const sink = micCtx.createGain();
        sink.gain.value = 0;
        tap.connect(sink).connect(micCtx.destination);
    }

    function stopTap() {
        try {
            micSrc?.disconnect();
            tap?.disconnect();
        } catch {
            /* уже отключено */
        }
        micCtx?.close().catch(() => {});
        micCtx = micSrc = tap = null;
    }

    // ---------- наружу ----------

    function init(opts = {}) {
        // Заход 24.11: клиент комнаты позвал init, а следом самозапуск позвал
        // его второй раз — обработчики навесились дважды, каждый кусок перевода
        // играл и дописывался по два раза («ThatThat's's good good..»), а очередь
        // звука росла вдвое и давала огромную задержку. Входим один раз.
        if (inited) return;
        inited = true;
        socket = opts.socket || null;
        remoteAudioEl = opts.remoteAudioEl || null;
        if (opts.log) log = opts.log;
        if (!socket) return;

        socket.on('translateState', (d = {}) => {
            revealUi();
            if (d.on === false) {
                log('перевод выключен сервером:', d.reason || '');
                stop();
            }
            for (const fn of onText) fn({ kind: 'state', ...d });
        });
        socket.on('translateText', (d = {}) => {
            revealUi();
            for (const fn of onText) fn(d);
        });
        // Ведущий включил перевод за всех — поднимаемся молча, без нажатий.
        socket.on('translateTurnOn', async (d = {}) => {
            revealUi();
            if (on) return;
            const r = await start({ lang: d.lang, stream: lastStream?.() });
            if (!r.error) showToast(noticeFor(d.lang));
            log(r.error ? 'ведущий включил перевод, но не вышло: ' + r.error : 'перевод включил ведущий, язык ' + d.lang);
            for (const fn of onText) fn({ kind: 'state', on: !r.error, lang: d.lang, byTeacher: true });
        });

        socket.on('translateVoice', (d = {}) => {
            revealUi();
            if (d.audio) playPcm16(d.audio);
        });

        // Сервер сам говорит, что перевод в комнате есть, — это надёжнее пробы.
        // Тому, кого педагог впускает из зала ожидания, обработчики достаются
        // только в момент впуска, а наши попытки к тому времени кончаются, и
        // кнопка не появляется вовсе (стенд 24.11).
        socket.on('mmTranslateReady', (d = {}) => {
            if (d.presenter) iAmPresenter = true;
            revealUi();
        });

        probeRoom();
    }

    // Проба: пустой язык сервер отвергает, но сам факт ответа говорит, что в
    // этой комнате перевод разрешён. Где его нет, обработчика нет вовсе —
    // ответа не будет, и кнопка останется скрытой.
    //
    // Повторяем, потому что обработчики перевода сервер навешивает только
    // после входа в комнату, а нас заводят раньше: одна проба уходила в пустоту
    // и кнопка не появлялась совсем (заход 24.11).
    function probeRoom(tries = 0) {
        if (allowed || !socket) return;
        let answered = false;
        try {
            socket.emit('translateJoin', { lang: '' }, (r) => {
                answered = true;
                if (r && r.presenter) iAmPresenter = true;
                revealUi();
            });
        } catch {
            /* соединения ещё нет — попробуем снова */
        }
        if (tries < 12) {
            setTimeout(() => {
                if (!answered && !allowed) probeRoom(tries + 1);
            }, 1500);
        }
    }

    // stream — тот же микрофонный поток, что идёт в урок
    async function start({ lang, stream } = {}) {
        if (on) return { ok: true, lang: myLang };
        if (!socket) return { error: 'нет соединения' };
        if (!lang) return { error: 'не выбран язык' };
        micStream = stream || micStream;
        if (!micStream) return { error: 'нет микрофона' };

        const ans = await new Promise((resolve) => {
            let done = false;
            socket.emit('translateJoin', { lang }, (r) => {
                done = true;
                resolve(r || {});
            });
            setTimeout(() => !done && resolve({ error: 'сервер не ответил' }), 5000);
        });
        if (ans.error) return ans;

        try {
            await startTap(micStream);
        } catch (err) {
            socket.emit('translateLeave');
            return { error: err.message };
        }
        on = true;
        myLang = lang;
        log('включён, язык:', lang);
        return { ok: true, lang };
    }

    function stop() {
        if (!on) return;
        on = false;
        myLang = '';
        try {
            socket?.emit('translateLeave');
        } catch {
            /* соединения уже нет */
        }
        stopTap();
        setDuck(false);
        markVoice(false);
        muteSendUntil = 0;
        playAt = 0;
        for (const src of queued.splice(0, queued.length)) {
            try {
                src.stop();
            } catch {
                /* уже доиграл */
            }
        }
        try {
            loopPc?.pc1.close();
            loopPc?.pc2.close();
            loopEl?.remove();
        } catch {
            /* уже закрыто */
        }
        loopPc = null;
        loopEl = null;
        playDest = null;
        playGain = null;
        log('выключен');
    }

    // ---------- интерфейс ----------
    //
    // Круглая кнопка со знаком «文A» — она всегда на виду, потому что перевод
    // включают и выключают по ходу урока. На телефоне сверху справа (внизу там
    // панель кнопок комнаты и место занято), на широком экране — снизу справа,
    // над той же панелью. По нажатию открывается карточка: тумблер перевода,
    // свой язык и тумблер субтитров.
    //
    // Субтитры — то же, что приходит голосом, только текстом внизу экрана. На
    // уроке они полезнее, чем кажется: по ним видно, что переводчик услышал, и
    // ошибку замечаешь глазами раньше, чем она собьёт ученика.
    //
    // Всё своё, с запасом по z-index и отступом под «чёлку»; вёрстку комнаты не
    // трогаем вовсе.

    // Основные вверху (решение Ивана 24.11), дальше остальные языки, у которых
    // поставщик умеет голос, а не только текст (TRANSLATE.md §3.1).
    const MAIN_LANGS = [
        ['de', 'немецкий'],
        ['fr', 'французский'],
        ['zh', 'китайский'],
        ['ru', 'русский'],
        ['es', 'испанский'],
        ['en', 'английский'],
    ];
    const MORE_LANGS = [
        ['ar', 'арабский'],
        ['pt', 'португальский'],
        ['id', 'индонезийский'],
        ['it', 'итальянский'],
        ['ko', 'корейский'],
        ['th', 'тайский'],
        ['vi', 'вьетнамский'],
        ['ja', 'японский'],
        ['tr', 'турецкий'],
        ['hi', 'хинди'],
        ['ms', 'малайский'],
        ['nl', 'нидерландский'],
        ['ur', 'урду'],
        ['nb', 'норвежский'],
        ['sv', 'шведский'],
        ['da', 'датский'],
        ['he', 'иврит'],
        ['fi', 'финский'],
        ['pl', 'польский'],
        ['is', 'исландский'],
        ['cs', 'чешский'],
        ['fil', 'филиппинский'],
        ['fa', 'персидский'],
    ];
    const LANGS = [...MAIN_LANGS, ...MORE_LANGS];

    // Сообщение студенту, когда педагог включил перевод, — на его же языке и с
    // названием языка на нём же. Для языков без перевода берём английский
    // шаблон: лучше понятная чужая фраза, чем непонятная своя.
    const NOTICE = {
        ru: (l) => `Включён синхронный перевод на ${l}`,
        en: (l) => `Simultaneous translation into ${l} is on`,
        de: (l) => `Simultanübersetzung ins ${l} ist aktiviert`,
        fr: (l) => `La traduction simultanée en ${l} est activée`,
        es: (l) => `Traducción simultánea al ${l} activada`,
        zh: (l) => `已开启${l}同声传译`,
        it: (l) => `Traduzione simultanea in ${l} attivata`,
        pt: (l) => `Tradução simultânea para ${l} ativada`,
        pl: (l) => `Włączono tłumaczenie symultaniczne na ${l}`,
        nl: (l) => `Simultaanvertaling naar het ${l} is ingeschakeld`,
        ja: (l) => `${l}への同時通訳を開始しました`,
        ko: (l) => `${l} 동시통역이 켜졌습니다`,
        tr: (l) => `${l} eşzamanlı çeviri açıldı`,
        ar: (l) => `تم تشغيل الترجمة الفورية إلى ${l}`,
        uk: (l) => `Увімкнено синхронний переклад на ${l}`,
    };
    // Название языка на нём самом — чтобы фраза читалась целиком на одном языке
    const ENDONYM = {
        ru: 'русский',
        en: 'English',
        de: 'Deutsche',
        fr: 'français',
        es: 'español',
        zh: '中文',
        it: 'italiano',
        pt: 'português',
        pl: 'polski',
        nl: 'Nederlands',
        ja: '日本語',
        ko: '한국어',
        tr: 'Türkçe',
        ar: 'العربية',
        id: 'Bahasa Indonesia',
        th: 'ไทย',
        vi: 'Tiếng Việt',
        hi: 'हिन्दी',
        ms: 'Bahasa Melayu',
        ur: 'اردو',
        nb: 'norsk',
        sv: 'svenska',
        da: 'dansk',
        he: 'עברית',
        fi: 'suomi',
        is: 'íslenska',
        cs: 'čeština',
        fil: 'Filipino',
        fa: 'فارسی',
    };
    const noticeFor = (lang) => {
        const name = ENDONYM[lang] || lang;
        return (NOTICE[lang] || NOTICE.en)(name);
    };
    const langOptions = (sel) =>
        `<optgroup label="основные">${MAIN_LANGS.map(([v, t]) => `<option value="${v}"${v === sel ? ' selected' : ''}>${t}</option>`).join('')}</optgroup>` +
        `<optgroup label="остальные">${MORE_LANGS.map(([v, t]) => `<option value="${v}"${v === sel ? ' selected' : ''}>${t}</option>`).join('')}</optgroup>`;
    const SAVED_LANG = 'mmTranslateLang';
    const SAVED_SUBS = 'mmTranslateSubs';
    const SAVED_GAIN = 'mmTranslateGain';
    const SAVED_STUDENT = 'mmTranslateStudentLang';
    const SAVED_VOICE = 'mmTranslateVoice';

    const CSS = `
#mmTr, #mmTrToast {
    position: fixed; z-index: 2147483100; left: 50%; transform: translateX(-50%);
    top: calc(env(safe-area-inset-top, 0px) + 14px);
    max-width: min(560px, calc(100vw - 32px));
    padding: 11px 18px; border-radius: 999px;
    background: rgba(28,28,34,.92); color: #fff;
    border: 1px solid rgba(255,255,255,.3);
    box-shadow: 0 6px 22px rgba(0,0,0,.45); backdrop-filter: blur(8px);
    font-size: 15px; line-height: 1.3; text-align: center;
    pointer-events: none; /* ничего не перекрывает: нажатия проходят сквозь */
    opacity: 0; transition: opacity .22s;
}
#mmTrToast[data-show="1"] { opacity: 1; }
@media (min-width: 900px) { #mmTrToast { top: 18px; } }
#mmTrSubs { font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
#mmTrBtn[hidden] { display: none; }
#mmTrBtn {
    position: fixed; z-index: 2147483000;
    top: calc(env(safe-area-inset-top, 0px) + 12px); right: 12px;
    width: 52px; height: 52px; border-radius: 50%; cursor: pointer;
    /* Светлый ореол: без него тёмная кнопка тонет в тёмной комнате (Иван, 24.11) */
    border: 1px solid rgba(255,255,255,.38);
    background: rgba(32,32,40,.86); color: #fff;
    box-shadow: 0 0 0 3px rgba(255,255,255,.13), 0 6px 20px rgba(0,0,0,.45);
    backdrop-filter: blur(8px);
    display: flex; align-items: center; justify-content: center;
    transition: background .18s, transform .12s;
}
#mmTrBtn:active { transform: scale(.94); }
#mmTrBtn[data-on="1"] { background: #2f6df6; border-color: rgba(255,255,255,.55); }
#mmTrBtn[data-voice="1"] { box-shadow: 0 0 0 5px rgba(120,170,255,.45), 0 6px 20px rgba(0,0,0,.45); }
#mmTrBtn .mmTrGlyph { position: relative; width: 28px; height: 28px; }
#mmTrBtn .mmTrGlyph b { position: absolute; font-weight: 600; }
#mmTrBtn .mmTrGlyph b:first-child { left: 0; top: -2px; font-size: 18px; }
#mmTrBtn .mmTrGlyph b:last-child { right: 0; bottom: -2px; font-size: 14px; opacity: .85; }
#mmTrPanel {
    position: fixed; z-index: 2147483000;
    top: calc(env(safe-area-inset-top, 0px) + 72px); right: 12px;
    width: min(380px, calc(100vw - 24px));
    padding: 14px 16px 16px; border-radius: 16px;
    background: rgba(24,24,29,.94); color: #eceef2;
    box-shadow: 0 10px 34px rgba(0,0,0,.5); backdrop-filter: blur(10px);
}
#mmTrPanel[hidden] { display: none; }
#mmTrPanel h4 { margin: 0 0 12px; font-size: 15px; font-weight: 600; }
#mmTrPanel .mmTrRow { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 12px 0; }
#mmTrPanel label { opacity: .9; }
#mmTrPanel select {
    background: #31313a; color: #eceef2; border: 0; border-radius: 9px;
    padding: 7px 9px; font: inherit; max-width: 160px;
}
#mmTrPanel select:disabled { opacity: .55; }
#mmTrPanel input[type="range"] { width: 120px; accent-color: #2f6df6; }
.mmTrSwitch { position: relative; width: 46px; height: 27px; flex: none; }
.mmTrSwitch input { position: absolute; opacity: 0; width: 100%; height: 100%; margin: 0; cursor: pointer; }
.mmTrSwitch i {
    position: absolute; inset: 0; border-radius: 999px; background: #4a4a55; transition: background .18s;
    pointer-events: none;
}
.mmTrSwitch i::after {
    content: ''; position: absolute; top: 3px; left: 3px; width: 21px; height: 21px;
    border-radius: 50%; background: #fff; transition: transform .18s;
}
.mmTrSwitch input:checked + i { background: #2f6df6; }
.mmTrSwitch input:checked + i::after { transform: translateX(19px); }
.mmTrSwitch input:disabled + i { opacity: .5; }
#mmTrNote { margin-top: 10px; font-size: 12px; line-height: 1.4; opacity: .62; }
#mmTrNote:empty { display: none; } /* пустая строка состояния места не занимает */
#mmTrPanel .mmTrSep { height: 1px; background: rgba(255,255,255,.12); margin: 14px 0 10px; }
#mmTrPanel optgroup { background: #31313a; }
#mmTrSubs {
    position: fixed; z-index: 2147482000; left: 50%; transform: translateX(-50%);
    bottom: calc(env(safe-area-inset-bottom, 0px) + 96px);
    max-width: min(900px, calc(100vw - 32px));
    padding: 10px 18px; border-radius: 12px;
    background: rgba(0,0,0,.66); color: #fff;
    font-size: clamp(17px, 2.4vw, 23px); line-height: 1.35; text-align: center;
    text-shadow: 0 1px 2px rgba(0,0,0,.6);
    pointer-events: none; opacity: 0; transition: opacity .18s;
}
/* Первый уровень панели — пара языков, как в переводчиках: слева тот, кого
   переводят, справа тот, для кого. Голос свой у каждой стороны: педагог и
   студент — разные люди, и общий голос путает (Иван, 24.11). Между ними —
   знак перевода, он оживает, пока перевод идёт. */
#mmTrPair { display: grid; grid-template-columns: 1fr auto 1fr; gap: 10px; align-items: start; margin: 4px 0 2px; }
#mmTrPair .mmTrSide { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
#mmTrPair .mmTrWho { font-size: 11px; letter-spacing: .04em; text-transform: uppercase; opacity: .5; }
#mmTrPair select {
    width: 100%; max-width: none; font-size: 13px;
    /* своя стрелка: у родной в Safari нет отступа от края, она липнет к стенке */
    appearance: none; -webkit-appearance: none;
    padding: 7px 26px 7px 10px;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 8'%3E%3Cpath d='M1 1.5 6 6.5l5-5' fill='none' stroke='%23cfd2d9' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
    background-repeat: no-repeat; background-position: right 9px center; background-size: 11px 7px;
}
/* Голос — тремя значками, а не вторым рядом списков: два выпадающих списка
   один под другим неудобны (Иван, 24.11). «Как говорящий» — две фигуры, одна
   сплошная, вторая повторяет её очертания. */
.mmTrVoices { display: flex; gap: 4px; }
.mmTrVoices button {
    flex: 1; min-width: 0; height: 30px; padding: 0; cursor: pointer;
    border: 1px solid rgba(255,255,255,.14); border-radius: 8px;
    background: #31313a; color: #cfd2d9;
    display: flex; align-items: center; justify-content: center;
    transition: background .15s, color .15s, border-color .15s;
}
.mmTrVoices button { font-size: 18px; line-height: 1; }
.mmTrVoices button[aria-pressed="true"] { background: #2f6df6; color: #fff; border-color: transparent; }
.mmTrVoices[hidden] { display: none; }
#mmTrPair select[disabled] { opacity: .75; }
#mmTrSign { align-self: center; margin-top: 18px; width: 34px; height: 34px; flex: none; }
#mmTrSign path { transform-origin: 50% 50%; }
#mmTrSign .a, #mmTrSign .b { opacity: .5; transition: opacity .2s; }
#mmTrPanel[data-live="1"] #mmTrSign .a { animation: mmTrFlow 1.8s ease-in-out infinite; }
#mmTrPanel[data-live="1"] #mmTrSign .b { animation: mmTrFlow 1.8s ease-in-out infinite .9s; }
@keyframes mmTrFlow {
    0%, 100% { opacity: .35; transform: translateX(0); }
    45% { opacity: 1; transform: translateX(2px); }
}
@media (prefers-reduced-motion: reduce) {
    #mmTrPanel[data-live="1"] #mmTrSign .a, #mmTrPanel[data-live="1"] #mmTrSign .b { animation: none; opacity: .9; }
}
#mmTrPanel .mmTrSep { height: 1px; background: rgba(255,255,255,.1); margin: 14px 0 4px; }
#mmTrPanel h4 { display: flex; align-items: center; justify-content: space-between; }
#mmTrOff { font-size: 12.5px; line-height: 1.4; opacity: .7; margin: 10px 0 2px; }
#mmTrSubs[data-show="1"] { opacity: 1; }
#mmTrSubs .mmTrWho { display: block; font-size: 12px; opacity: .65; margin-bottom: 2px; }
@media (min-width: 900px) {
    /* Справа внизу стоит своё окно камеры — кнопка его перекрывала (заход 24.11).
       Слева внизу свободно. */
    #mmTrBtn { top: auto; bottom: 24px; right: auto; left: 18px; }
    #mmTrPanel { top: auto; bottom: 88px; right: auto; left: 18px; }
    #mmTrSubs { bottom: calc(env(safe-area-inset-bottom, 0px) + 112px); }
}
`;

    let ui = null;
    let lastPeers = [];
    let lastStream = null; // как добыть микрофон — нужно, когда перевод включает ведущий
    const nameOfLang = (code) => (LANGS.find(([v]) => v === code) || [, code])[1];
    const myId = () => (socket && socket.id) || '';

    function mountUi({ getStream } = {}) {
        if (ui) return;
        lastStream = getStream || null;

        const style = document.createElement('style');
        style.textContent = CSS;
        document.head.appendChild(style);

        const btn = document.createElement('button');
        btn.id = 'mmTrBtn';
        btn.hidden = true; // покажем, когда сервер подтвердит, что перевод в комнате есть
        btn.title = 'Перевод';
        btn.setAttribute('aria-label', 'Перевод');
        btn.innerHTML = '<span class="mmTrGlyph"><b>文</b><b>A</b></span>';

        const panel = document.createElement('div');
        panel.id = 'mmTrPanel';
        panel.hidden = true;
        // Значки голоса. Женский и мужской — обычные фигуры; «как говорящий» —
        // фигура и её повтор рядом, то есть копия того, кто сейчас говорит.
        // Цветные эмодзи вместо рисованных значков: нарисованные фигуры полов
        // читались плохо (Иван, 24.11). «Как говорящий» — говорящая голова.
        const ICON = { clone: '🗣️', female: '👩', male: '👨' };
        const TITLE = { clone: 'Голос говорящего', female: 'Женский голос', male: 'Мужской голос' };
        const voiceGroup = (side) =>
            `<div class="mmTrVoices" id="mmTrVoice${side}" role="group" aria-label="Голос перевода">` +
            ['clone', 'female', 'male']
                .map(
                    (v) =>
                        `<button type="button" data-v="${v}" title="${TITLE[v]}" aria-label="${TITLE[v]}"` +
                        ` aria-pressed="${v === 'clone' ? 'true' : 'false'}">${ICON[v]}</button>`
                )
                .join('') +
            '</div>';

        // Знак перевода: две встречные стрелки в цветах знака Montemeet.
        // Пока перевод идёт, они по очереди оживают — видно, что канал жив.
        const sign =
            '<svg id="mmTrSign" viewBox="0 0 36 36" aria-hidden="true">' +
            '<defs>' +
            '<linearGradient id="mmTrGa" x1="0" y1="0" x2="1" y2="1">' +
            '<stop offset="0" stop-color="#88B92C"/><stop offset="1" stop-color="#008C99"/></linearGradient>' +
            '<linearGradient id="mmTrGb" x1="1" y1="0" x2="0" y2="1">' +
            '<stop offset="0" stop-color="#F7B234"/><stop offset="1" stop-color="#E5422E"/></linearGradient>' +
            '</defs>' +
            '<g fill="none" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">' +
            '<path class="a" d="M7 13h17m-5-5 5 5-5 5" stroke="url(#mmTrGa)"/>' +
            '<path class="b" d="M29 25H12m5 5-5-5 5-5" stroke="url(#mmTrGb)"/>' +
            '</g></svg>';

        panel.innerHTML =
            '<h4>Перевод голосом</h4>' +
            // первый уровень: кого переводим и для кого, с голосом каждой стороны
            '<div id="mmTrPair">' +
            '<div class="mmTrSide">' +
            '<span class="mmTrWho" id="mmTrWhoLeft">Педагог</span>' +
            `<select id="mmTrLangTeacher" aria-label="Язык педагога">${langOptions('ru')}</select>` +
            voiceGroup('Teacher') +
            '</div>' +
            sign +
            '<div class="mmTrSide">' +
            '<span class="mmTrWho" id="mmTrWhoRight">Студент</span>' +
            `<select id="mmTrLangStudent" aria-label="Язык студента">${langOptions('en')}</select>` +
            voiceGroup('Student') +
            '</div>' +
            '</div>' +
            // у студента, пока педагог не включил перевод, — объяснение вместо настроек
            '<div id="mmTrOff" hidden>Перевод не включён педагогом</div>' +
            // строка состояния стоит здесь, а не внизу: под ползунком громкости
            // она читалась как подпись к нему — «громкость регулируется обоим»
            // (Иван, 24.11)
            '<div id="mmTrNote"></div>' +
            '<div class="mmTrSep"></div>' +
            // второй уровень: сами настройки
            '<div class="mmTrRow" id="mmTrOnRow"><label for="mmTrOn">Включить перевод</label>' +
            '<span class="mmTrSwitch"><input type="checkbox" id="mmTrOn"><i></i></span></div>' +
            '<div class="mmTrRow"><label for="mmTrSubsOn">Субтитры</label>' +
            '<span class="mmTrSwitch"><input type="checkbox" id="mmTrSubsOn" checked><i></i></span></div>' +
            '<div class="mmTrRow"><label for="mmTrVol">Громкость перевода</label>' +
            '<input type="range" id="mmTrVol" min="20" max="100" step="5" value="50"></div>' +
            '<div id="mmTrWho" style="font-size:12px;opacity:.6;margin-top:6px"></div>';

        const subs = document.createElement('div');
        subs.id = 'mmTrSubs';

        const toast = document.createElement('div');
        toast.id = 'mmTrToast';

        document.body.append(btn, panel, subs, toast);
        ui = { btn, panel, subs, toast };
        if (allowed) btn.hidden = false;
        watchOverlays();

        const onSw = panel.querySelector('#mmTrOn');
        const teachSel = panel.querySelector('#mmTrLangTeacher');
        const studentSel = panel.querySelector('#mmTrLangStudent');
        const voiceBox = {
            teacher: panel.querySelector('#mmTrVoiceTeacher'),
            student: panel.querySelector('#mmTrVoiceStudent'),
        };
        const getVoice = (side) => voiceBox[side].querySelector('[aria-pressed="true"]')?.dataset.v || 'clone';
        const setVoice = (side, v) => {
            for (const b of voiceBox[side].querySelectorAll('button')) {
                b.setAttribute('aria-pressed', String(b.dataset.v === v));
            }
        };
        const offEl = panel.querySelector('#mmTrOff');
        const subsSw = panel.querySelector('#mmTrSubsOn');
        const volEl = panel.querySelector('#mmTrVol');
        const note = panel.querySelector('#mmTrNote');
        const onRow = panel.querySelector('#mmTrOnRow');
        const whoEl = panel.querySelector('#mmTrWho');

        // «Мой язык» — та сторона, на которой я стою. Педагог правит обе,
        // студент только свою: педагог может ошибиться с языком (поставить
        // китайский японцу), и поправить себя студент должен сам (Иван, 24.11).
        const mySel = () => (iAmPresenter ? teachSel : studentSel);

        function applyRole() {
            teachSel.disabled = !iAmPresenter; // студенту язык педагога — только показ
            voiceBox.teacher.hidden = !iAmPresenter;
            voiceBox.student.hidden = !iAmPresenter;
            if (onRow) onRow.hidden = !iAmPresenter; // включает перевод только педагог
            offEl.hidden = iAmPresenter || on;
            note.hidden = !iAmPresenter && !on;
        }
        ui.applyRole = applyRole;
        applyRole();

        try {
            const saved = localStorage.getItem(SAVED_LANG);
            // У педагога по умолчанию русский (решение Ивана 24.11): прежний
            // выбор уважаем, но пустую память не оставляем на первом языке
            // списка — им оказывался немецкий.
            const mine = saved && LANGS.some(([v]) => v === saved) ? saved : 'ru';
            if (iAmPresenter) teachSel.value = mine;
            else studentSel.value = mine;
            subsSw.checked = localStorage.getItem(SAVED_SUBS) !== '0';
            const v = localStorage.getItem(SAVED_VOICE);
            if (v && ['clone', 'female', 'male'].includes(v)) {
                setVoice('teacher', v);
                setVoice('student', v);
            }
            const st = localStorage.getItem(SAVED_STUDENT);
            if (st && LANGS.some(([x]) => x === st) && iAmPresenter) studentSel.value = st;
            const g = Number(localStorage.getItem(SAVED_GAIN));
            if (g >= 20 && g <= 100) {
                volEl.value = String(g);
                voiceGain = g / 100;
            }
        } catch {
            /* приватный режим — просто значения по умолчанию */
        }

        btn.onclick = () => {
            panel.hidden = !panel.hidden;
        };
        document.addEventListener('click', (e) => {
            if (!panel.hidden && !panel.contains(e.target) && e.target !== btn && !btn.contains(e.target)) {
                panel.hidden = true;
            }
        });

        // Один тумблер на всё: включает перевод и себе, и студенту.
        onSw.onchange = async () => {
            if (!onSw.checked) {
                applyForAll(false);
                stop();
                btn.dataset.on = '0';
                panel.dataset.live = '0';
                note.textContent = '';
                return;
            }
            onSw.disabled = true;
            note.textContent = 'включаю…';
            const r = await start({ lang: mySel().value, stream: getStream?.() });
            onSw.disabled = false;
            if (r.error) {
                onSw.checked = false;
                note.textContent = 'не вышло: ' + r.error;
                return;
            }
            btn.dataset.on = '1';
            panel.dataset.live = '1';
            try {
                localStorage.setItem(SAVED_LANG, mySel().value);
                localStorage.setItem(SAVED_STUDENT, studentSel.value);
            } catch {
                /* не сохранилось — не беда */
            }
            applyForAll(true);
            note.textContent = 'перевод идёт';
        };

        // Громкость перевода — самый дешёвый рычаг против эха: тише на 6 дБ
        // значит и эха на 6 дБ меньше (совет мобильной сессии).
        volEl.oninput = () => {
            voiceGain = Number(volEl.value) / 100;
            if (playGain) playGain.gain.value = voiceGain;
            try {
                localStorage.setItem(SAVED_GAIN, volEl.value);
            } catch {
                /* не сохранилось — не беда */
            }
        };

        // Ведущий: язык студента и включение обоим сразу.
        // Кому какой язык, решает сервер по списку комнаты: браузер на момент
        // нажатия ещё никого не знает (заход 24.11).
        const applyForAll = (on) => {
            socket.emit(
                'translateForAll',
                on
                    ? {
                          on: true,
                          me: teachSel.value,
                          others: studentSel.value,
                          voice: { teacher: getVoice('teacher'), student: getVoice('student') },
                      }
                    : { on: false },
                (r) => {
                    if (r && r.error) note.textContent = 'не вышло: ' + r.error;
                    else if (r && r.set !== undefined) note.textContent = `перевод идёт · участников: ${r.set}`;
                }
            );
        };

        // Голос каждой стороны отдельно: «голос говорящего» поставщик снимает
        // с него самого перед каждым ответом, женский и мужской — готовые.
        for (const side of ['teacher', 'student']) {
            voiceBox[side].addEventListener('click', (e) => {
                const b = e.target.closest('button[data-v]');
                if (!b || !iAmPresenter) return;
                const v = b.dataset.v;
                setVoice(side, v);
                try {
                    localStorage.setItem(SAVED_VOICE, v);
                } catch {
                    /* не сохранилось — не беда */
                }
                socket.emit('translateVoiceMode', { side, voice: v }, (r) => {
                    if (r && r.error) note.textContent = 'не вышло: ' + r.error;
                });
            });
        }

        studentSel.onchange = () => {
            if (!iAmPresenter) return langChanged(); // студенту это его собственный язык
            try {
                localStorage.setItem(SAVED_STUDENT, studentSel.value);
            } catch {
                /* не сохранилось — не беда */
            }
            if (on) applyForAll(true);
        };

        // Язык меняется на ходу, без выключения перевода (Иван, 24.11).
        const langChanged = () => {
            const sel = mySel();
            try {
                localStorage.setItem(SAVED_LANG, sel.value);
            } catch {
                /* не сохранилось — не беда */
            }
            if (!on) return;
            if (iAmPresenter) {
                applyForAll(true); // педагог: пересобираем обоим
                return;
            }
            socket.emit('translateJoin', { lang: sel.value }, (r) => {
                if (r && r.ok) {
                    myLang = sel.value;
                    note.textContent = 'перевод идёт';
                    showToast(noticeFor(sel.value));
                }
            });
        };
        teachSel.onchange = () => {
            if (iAmPresenter) langChanged();
        };

        subsSw.onchange = () => {
            try {
                localStorage.setItem(SAVED_SUBS, subsSw.checked ? '1' : '0');
            } catch {
                /* не сохранилось — не беда */
            }
            if (!subsSw.checked) subs.dataset.show = '0';
        };

        // ---------- то, что приходит с сервера ----------

        let line = '';
        let hideTimer = null;

        const showSubs = (who, text) => {
            if (!subsSw.checked) return;
            subs.innerHTML = `<span class="mmTrWho">${who}</span>`;
            subs.append(text);
            subs.dataset.show = '1';
            clearTimeout(hideTimer);
            hideTimer = setTimeout(() => (subs.dataset.show = '0'), 5000);
        };

        onText.push((d) => {
            if (d.kind === 'state') {
                if (Array.isArray(d.peers)) lastPeers = d.peers;
                if (d.presenter) iAmPresenter = true;
                // Язык педагога студент видит, но не меняет: иначе непонятно,
                // на какой язык его переводят.
                if (!iAmPresenter && Array.isArray(d.peers)) {
                    const teacher = d.peers.find((p) => p.presenter && p.lang);
                    if (teacher) teachSel.value = teacher.lang;
                }
                if (d.voices) {
                    if (d.voices.teacher) setVoice('teacher', d.voices.teacher);
                    if (d.voices.student) setVoice('student', d.voices.student);
                }
                if (whoEl && Array.isArray(d.peers)) {
                    whoEl.textContent = d.peers.map((p) => `${p.name || '—'}: ${nameOfLang(p.lang)}`).join(' · ');
                }
                if (d.on === false) {
                    onSw.checked = false;
                    btn.dataset.on = '0';
                    panel.dataset.live = '0';
                    note.textContent = d.reason === 'limit' ? 'израсходован предел на урок' : 'перевод выключен';
                } else if (d.byTeacher) {
                    onSw.checked = !!d.on;
                    btn.dataset.on = d.on ? '1' : '0';
                    panel.dataset.live = d.on ? '1' : '0';
                    if (d.lang) mySel().value = d.lang;
                    note.textContent = d.on ? 'перевод включил ведущий' : 'перевод выключил ведущий';
                } else if (Array.isArray(d.peers)) {
                    const other = d.peers.filter((p) => p.lang && p.lang !== myLang).length;
                    note.textContent = other
                        ? `перевод идёт · собеседников: ${other}`
                        : 'жду собеседника с другим языком';
                }
                applyRole();
                return;
            }
            // «что услышали» в панели не показываем (решение Ивана 24.11):
            // педагогу на уроке важен перевод, а не отладочная строка. В журнал
            // сервера оно по-прежнему пишется.
            if (d.kind === 'heard') return;
            if (d.kind === 'translated') {
                line = (line + String(d.text)).slice(-220);
                showSubs(d.from || '', line);
                clearTimeout(mountUi._reset);
                mountUi._reset = setTimeout(() => (line = ''), 5000);
            }
        });
    }

    // Сервер ответил — значит перевод в этой комнате разрешён, кнопку видно.
    // В обычных комнатах она так и остаётся скрытой. Ответ может прийти и
    // раньше, чем построен интерфейс, поэтому помним разрешение отдельно.
    let allowed = false;
    let iAmPresenter = false;
    // Кнопку видят оба. У педагога — включение и язык студента; у студента —
    // только свой язык, громкость и субтитры: включает перевод педагог, но если
    // он ошибся с языком (поставил китайский японцу), студент поправит сам
    // (решение Ивана 24.11).
    function revealUi() {
        allowed = true;
        if (!ui) return;
        ui.btn.hidden = false;
        ui.applyRole?.(); // роль могла прийти позже, чем построилась панель
    }

    // Всплывашка: держится 4 секунды и ничего не перекрывает (решение Ивана).
    function showToast(text, ms = 4000) {
        if (!ui?.toast) return;
        ui.toast.textContent = text;
        ui.toast.dataset.show = '1';
        clearTimeout(showToast._t);
        showToast._t = setTimeout(() => (ui.toast.dataset.show = '0'), ms);
    }

    // ---------- кнопка не лезет поверх окон комнаты ----------
    //
    // Кнопка 文A висит на самом верхнем слое, чтобы её было видно всегда. Но
    // окна комнаты лежат ниже (z-index 9999), и при открытых настройках кнопка
    // оказывалась поверх них, накрывая крестик (Иван, 24.11). Пока открыто
    // любое окно — прячем и кнопку, и свою панель; закрыли — возвращаем.

    const OVERLAYS = ['mySettings', 'chatRoom', 'pollRoom', 'editorRoom', 'whiteboard', 'breakoutPanel', 'lobby'];

    function overlayOpen() {
        for (const id of OVERLAYS) {
            const el = document.getElementById(id);
            if (!el || el.classList.contains('hidden')) continue;
            if (el.getBoundingClientRect().width > 0) return true;
        }
        // Swal оставляет свой контейнер в разметке и после закрытия, причём
        // растянутым на весь экран, — по нему судить нельзя. Смотрим на само
        // окно: есть видимый .swal2-popup — значит что-то открыто.
        const popup = document.querySelector('.swal2-popup');
        return !!popup && popup.getBoundingClientRect().width > 0;
    }

    function watchOverlays() {
        const apply = () => {
            if (!ui) return;
            const busy = overlayOpen();
            ui.btn.style.display = busy ? 'none' : '';
            if (busy) ui.panel.hidden = true;
        };
        const obs = new MutationObserver(apply);
        for (const id of OVERLAYS) {
            const el = document.getElementById(id);
            if (el) obs.observe(el, { attributes: true, attributeFilter: ['class', 'style'] });
        }
        obs.observe(document.body, { childList: true }); // окна Swal приходят и уходят целиком
        apply();
    }

    // кнопка слегка пульсирует, пока звучит перевод — видно, что он идёт
    function markVoice(active) {
        if (ui) ui.btn.dataset.voice = active ? '1' : '0';
    }

    return {
        init,
        start,
        stop,
        mountUi,
        ready: () => !!ui,
        toast: showToast, // наружу — чтобы можно было проверить, не включая перевод
        noticeFor,
        isOn: () => on,
        lang: () => myLang,
        onMessage: (fn) => onText.push(fn),
    };
})();

if (typeof window !== 'undefined') {
    window.MontemeetTranslate = MontemeetTranslate;

    // Самостоятельный запуск. Клиент комнаты зовёт нас сам, но на заходе 24.11
    // на Samsung Internet этого не случилось: страница держала в кэше прежний
    // RoomClient.js, в котором вызова ещё нет. Этот файл новый и из кэша прийти
    // не мог, поэтому поднимаемся сами, если нас не позвали.
    // Клиент комнаты лежит в переменной `rc`, объявленной через let, — такая в
    // window не попадает, брать её надо по имени.
    const roomClient = () => {
        try {
            if (typeof rc !== 'undefined' && rc) return rc;
        } catch {
            /* ещё не объявлена */
        }
        return window.rc || null;
    };
    const selfBoot = (tries = 0) => {
        if (MontemeetTranslate.ready()) return;
        const rc = roomClient();
        if (rc && rc.socket) {
            MontemeetTranslate.init({ socket: rc.socket, remoteAudioEl: rc.remoteAudioEl });
            MontemeetTranslate.mountUi({ getStream: () => rc.localAudioStream });
            return;
        }
        if (tries < 60) setTimeout(() => selfBoot(tries + 1), 300);
    };
    setTimeout(() => selfBoot(), 1500);
}
