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
    // Пока говорит сам человек, собеседника приглушаем — несильно, на 15 дБ.
    // Зачем: эхоподавитель, когда в динамике громко, режет и нашу речь — у
    // мобильной сессии от этого «счёт Ирины рвался» под музыку с веба, и
    // лечили они это тем же приёмом. У нас поверх речи всегда звучит перевод,
    // то есть двойной разговор постоянный (Лев, 25.11; решение Ивана — можно).
    const SELF_DUCK = 0.18; // −15 дБ
    const SELF_LEVEL = 0.02; // выше этого считаем, что человек говорит
    const SELF_HOLD_MS = 700; // держим после того, как он замолчал
    let selfUntil = 0;
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
    const LOOP_WAIT_MS = 2500; // сколько ждать дорожку петли, прежде чем играть напрямую
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
    // Ворота по замеру (см. «измеритель утечки» ниже): пока доверия нет, они
    // стоят, как раньше; доверие ставит и снимает gateStep раз в секунду.
    let meter = null;
    let gateTrusted = false;
    let gateTimer = null;
    let gatedMs = 0; // своего звука пришлось на время звучания перевода
    let passedMs = 0; // из него ушло переводчику — ворота были сняты
    let voiceGain = 0.5; // громкость перевода: тише оригинала, заодно вдвое меньше эха

    let on = false;
    // Перевод в комнате включён ведущим — даже если у нас самих он не поднялся.
    // Нужен, чтобы студенту не писали «педагог не включил перевод», когда тот
    // уже включил и студент его слышит (живой заход 25.11).
    let roomOn = false;
    // Есть ли у педагога заранее созданный голос и какой голос сервер считает
    // умолчанием. Приходит от сервера и может опередить панель.
    let lastOwnVoice = false;
    let lastServerVoice = '';
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
        // Два приглушения разом: под перевод и под свою речь. Берём то, что
        // тише, — иначе они спорили бы друг с другом.
        const self = Date.now() < selfUntil ? SELF_DUCK : 1;
        const level = Math.min(duckLevel, self);
        for (const el of els) {
            if (el.muted || el.dataset.mmTranslate === '1') continue;
            if (el.dataset.mmFullVolume === undefined) el.dataset.mmFullVolume = String(el.volume ?? 1);
            const full = Number(el.dataset.mmFullVolume) || 1;
            el.volume = Math.max(0, Math.min(1, full * level));
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
            }
            // Раскладываем уровень каждый такт: он зависит не только от
            // перевода, но и от того, говорит ли человек прямо сейчас.
            applyDuckLevel();
            // Останавливаемся, когда оба приглушения отпустили.
            if (duckLevel === 1 && target === 1 && Date.now() >= selfUntil) {
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

        // Петлю ждём по-настоящему, до соединения. Раньше она считалась
        // поднятой сразу после согласования — и если соединение не
        // устанавливалось, перевод уходил в MediaStreamDestination, из которого
        // его никто не играл: ошибки нет, субтитры идут, а звука нет совсем
        // (заход Ивана 24.11: «перевода не слышу, только субтитры»).
        //
        // Одного ontrack мало: на стенде он срабатывает, когда ICE ещё в
        // состоянии new, то есть звук по петле ещё не пойдёт. Поэтому ждём и
        // дорожку, и фактическое соединение.
        let gotTrack = false;
        const ready = new Promise((resolve) => {
            let settled = false;
            const finish = (ok) => {
                if (settled) return;
                settled = true;
                resolve(ok);
            };
            const check = () => {
                const st = pc1.iceConnectionState;
                if (gotTrack && (st === 'connected' || st === 'completed')) finish(true);
                if (st === 'failed' || st === 'closed') finish(false);
            };
            pc2.ontrack = (e) => {
                el.srcObject = e.streams[0];
                el.play().catch(() => {});
                gotTrack = true;
                check();
            };
            pc1.oniceconnectionstatechange = check;
            setTimeout(() => finish(false), LOOP_WAIT_MS);
        });

        for (const t of dest.stream.getAudioTracks()) pc1.addTrack(t, dest.stream);

        const offer = await pc1.createOffer();
        await pc1.setLocalDescription(offer);
        await pc2.setRemoteDescription(offer);
        const answer = await pc2.createAnswer();
        await pc2.setLocalDescription(answer);
        await pc1.setRemoteDescription(answer);

        if (!(await ready)) {
            try {
                pc1.close();
                pc2.close();
                el.remove();
            } catch (e) {
                /* уже закрыто */
            }
            throw new Error('дорожка петли не пришла');
        }

        loopEl = el;
        loopPc = { pc1, pc2 };
        return dest;
    }

    // Защёлка на подъём вывода. Куски перевода приходят через 100-300 мс, а
    // петля поднимается до двух с половиной секунд — второй кусок запускал
    // подъём ещё раз. Поднимались две петли: вторая переписывала усилитель,
    // первая оставалась в документе с живым соединением и продолжала играть
    // даже после выключения перевода. Снаружи — двойной звук с призвуком и
    // перевод, который не замолкает (разбор 25.11).
    let outputReady = null;

    async function ensureOutput() {
        if (playDest) return;
        if (outputReady) return outputReady;
        outputReady = (async () => {
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
        })();
        return outputReady;
    }

    // ---------- измеритель утечки перевода в микрофон ----------
    //
    // Ворота — «пока звучит перевод, свой микрофон переводчику не шлём» — стоят
    // затем, чтобы переводчик не услышал собственный перевод из динамика: на
    // живом уроке 24.11 переводчики заговорили между собой. Но они же съедают
    // начала фраз: у моба 72 с своего звука из 383 (заход 27.11). Моб снял их
    // по замеру — их отвод идёт после эхоподавителя, и измеритель показал, что
    // эхо в эфир не течёт. У нас отвод тоже после эхоподавителя браузера, а
    // перевод идёт ему опорой через петлю, но эхоподавитель браузера — чёрный
    // ящик, и 24.11 он однажды не справился. Поэтому так же, как в мобе, —
    // не наугад, а по замеру (правило GateTrust моба, montemeet_translate.h):
    //  - ворота стоят, пока замер не покажет, что за 30 с звучащего перевода
    //    его эхо в микрофоне не слышно;
    //  - возвращаются, если за 10 с услышали;
    //  - данных мало — как было, то есть ворота стоят.
    //
    // Как узнаём эхо. Эхо — это то, что мы играем, только позже и тише. Сравниваем
    // огибающую того, что играем, с огибающей микрофона, сдвигая на возможную
    // задержку (до 0,9 с): совпадают — значит в микрофоне наш перевод. Своя речь
    // человека с переводом не совпадает, сколько бы он ни говорил поверх, и
    // ворота из-за неё не возвращаются. «Слышно» — когда совпадение есть, а в
    // микрофоне, пока перевод громкий, выше −45 дБ (тот же порог, что у моба).
    const LEAK_WIN_MS = 20; // шаг огибающей
    const LEAK_KEEP = 4000; // окон в памяти — 80 с
    const LEAK_FLOOR_DB = -70; // ниже — тишина, не различаем
    const LEAK_LOUD_DB = -40; // перевод «звучит громко» в этом окне
    const LEAK_HEAR_DB = -45; // эхо в микрофоне слышно выше этого
    // «Чисто» — только с запасом в 5 дБ: между −50 и −45 — «неизвестно», ворота
    // стоят. Порог −45 взят у моба, но у них эхоподавитель свой и измеренный,
    // а у нас браузерный; ошибиться в сторону «снять ворота» дороже — 24.11
    // переводчики заговорили между собой.
    const LEAK_CLEAN_DB = -50;
    const LEAK_CORR = 0.35; // совпадение огибающих, с которого считаем эхом
    const LEAK_LAG_MIN = -5; // сдвиги, окон: −0,1…0,9 с
    const LEAK_LAG_MAX = 45;
    // Сколько громкого перевода нужно, чтобы судить: снимать ворота — после
    // 20 с громкого (с паузами это около 30 с звучания, как у моба), а
    // возвращать — уже после 3 с: ошибиться в сторону «снять» дороже.
    const LEAK_TRUST_PLAYING_MS = 20000;
    const LEAK_DOUBT_PLAYING_MS = 3000;

    class LeakMeter {
        constructor() {
            this.out = new Float32Array(LEAK_KEEP).fill(NaN);
            this.inp = new Float32Array(LEAK_KEEP).fill(NaN);
            this.outAt = new Float64Array(LEAK_KEEP).fill(-1); // какое окно лежит в ячейке
            this.inAt = new Float64Array(LEAK_KEEP).fill(-1);
        }
        static db(energy) {
            return Math.max(LEAK_FLOOR_DB, 10 * Math.log10(energy + 1e-12));
        }
        put(arr, at, tMs, energy) {
            const k = Math.floor(tMs / LEAK_WIN_MS);
            const i = ((k % LEAK_KEEP) + LEAK_KEEP) % LEAK_KEEP;
            arr[i] = LeakMeter.db(energy);
            at[i] = k;
        }
        // что сыграем (мс — по часам performance.now) и что слышит микрофон
        addOut(tMs, energy) {
            this.put(this.out, this.outAt, tMs, energy);
        }
        addIn(tMs, energy) {
            this.put(this.inp, this.inAt, tMs, energy);
        }
        get(arr, at, k) {
            const i = ((k % LEAK_KEEP) + LEAK_KEEP) % LEAK_KEEP;
            return at[i] === k ? arr[i] : NaN;
        }
        // Слышна ли утечка за последние spanMs: превышение над порогом в дБ,
        // 0 — не слышна, −1 — данных мало.
        verdict(nowMs, spanMs, minPlayingMs) {
            const last = Math.floor((nowMs - 1000) / LEAK_WIN_MS); // последняя секунда ещё неполная
            const first = last - Math.floor(spanMs / LEAK_WIN_MS);
            let playing = 0;
            for (let k = first; k <= last; k++) if (this.get(this.out, this.outAt, k) > LEAK_LOUD_DB) playing++;
            if (playing * LEAK_WIN_MS < minPlayingMs) return { excess: -1, corr: 0, lagMs: 0, hearDb: null };
            let best = { corr: -1, lag: 0 };
            for (let d = LEAK_LAG_MIN; d <= LEAK_LAG_MAX; d++) {
                let n = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
                for (let k = first; k <= last; k++) {
                    const x = this.get(this.out, this.outAt, k);
                    const y = this.get(this.inp, this.inAt, k + d);
                    if (Number.isNaN(x) || Number.isNaN(y)) continue;
                    n++; sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y;
                }
                if (n < 50) continue;
                const vx = sxx - (sx * sx) / n;
                const vy = syy - (sy * sy) / n;
                if (vx <= 0 || vy <= 0) continue;
                const c = (sxy - (sx * sy) / n) / Math.sqrt(vx * vy);
                if (c > best.corr) best = { corr: c, lag: d };
            }
            // Дальше — только окна, где перевод громкий, на найденном сдвиге.
            // Своя речь человека звучит лишь часть времени, поэтому смотрим на
            // нижнюю часть: уровень микрофона — по нижней трети окон, совпадение —
            // по окнам не громче медианы. Эхо есть во ВСЕХ окнах громкого
            // перевода и поднимает и низ; речь — только в своих и низ не трогает.
            const pairs = [];
            for (let k = first; k <= last; k++) {
                const x = this.get(this.out, this.outAt, k);
                if (!(x > LEAK_LOUD_DB)) continue;
                const y = this.get(this.inp, this.inAt, k + best.lag);
                if (!Number.isNaN(y)) pairs.push([x, y]);
            }
            if (pairs.length * LEAK_WIN_MS < minPlayingMs / 2) {
                return { excess: -1, corr: best.corr, lagMs: best.lag * LEAK_WIN_MS, hearDb: null };
            }
            const ys = pairs.map((p) => p[1]).sort((u, v) => u - v);
            const hearDb = ys[Math.floor(ys.length / 3)];
            const median = ys[Math.floor(ys.length / 2)];
            const quiet = pairs.filter((p) => p[1] <= median);
            let n = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
            for (const [x, y] of quiet) {
                n++; sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y;
            }
            const vx = sxx - (sx * sx) / n;
            const vy = syy - (sy * sy) / n;
            const corr = n > 20 && vx > 0 && vy > 0 ? (sxy - (sx * sy) / n) / Math.sqrt(vx * vy) : 0;
            const lagMs = best.lag * LEAK_WIN_MS;
            // Микрофон тих, пока перевод громкий, — эха нет (или оно неслышно).
            if (hearDb <= LEAK_CLEAN_DB) return { excess: 0, corr, lagMs, hearDb };
            if (hearDb <= LEAK_HEAR_DB) return { excess: -1, corr, lagMs, hearDb }; // на грани
            // Громко и повторяет перевод — эхо слышно.
            if (corr >= LEAK_CORR || best.corr >= LEAK_CORR) return { excess: hearDb - LEAK_HEAR_DB, corr, lagMs, hearDb };
            // Громко, но не повторяет: человек говорит или шумно — доказать, что
            // эха нет, нельзя. Не «чисто», а «неизвестно» — ворота стоят.
            return { excess: -1, corr, lagMs, hearDb };
        }
    }

    // Правило моба (GateTrust): «слышна» за 10 с — ворота стоят; «чисто» за
    // 30 с — сняты; «неизвестно» — без перемен, а в начале это значит «стоят».
    function gateStep() {
        if (!meter) {
            gateTrusted = false; // замера нет — ворота стоят
            return;
        }
        const now = performance.now();
        let v10;
        const was = gateTrusted;
        try {
            v10 = meter.verdict(now, 10000, LEAK_DOUBT_PLAYING_MS);
            if (v10.excess > 0) gateTrusted = false;
            else if (meter.verdict(now, 60000, LEAK_TRUST_PLAYING_MS).excess === 0) gateTrusted = true;
        } catch (err) {
            meter = null;
            gateTrusted = false;
            log('измеритель утечки отключён:', err.message);
            return;
        }
        if (gateTrusted === was) return;
        const info = {
            trusted: gateTrusted ? 1 : 0,
            corr: Math.round(v10.corr * 100) / 100,
            lagMs: v10.lagMs,
            micDb: v10.hearDb === null ? -99 : Math.round(v10.hearDb * 10) / 10,
        };
        log(
            gateTrusted
                ? 'ворота сняты — эхо перевода в микрофоне не слышно'
                : 'ворота возвращены — эхо перевода в микрофоне слышно',
            info
        );
        try {
            if (typeof MontemeetDiag !== 'undefined') MontemeetDiag.report('translate-gate', info);
        } catch {
            /* журнал — не главное */
        }
    }

    // ---------- ужимание пауз в голосе перевода ----------
    //
    // Главная растрата времени в переводе — паузы, а не речь: на монологе 42 с
    // у голоса перевода 17,7 с пауз против 8,5 с у оригинала, сама речь почти
    // равна (замер 27.11). Куски играем встык, так что паузы целиком ложатся в
    // отставание, и к концу монолога студент ждёт. Когда перевод уже отстаёт,
    // режем длинные паузы до SQUEEZE_KEEP_S — тон и тембр не меняются, режется
    // только тишина (Иван, 27.11: «рычаг хороший»). Пока отставания нет, паузы
    // не трогаем: это естественные паузы речи.
    const SQUEEZE_LAG_S = 0.6; // отставание, с которого ужимаем
    const SQUEEZE_KEEP_S = 0.3; // длиннее паузу не оставляем
    const SQUEEZE_QUIET = 0.0056; // ≈ −45 дБ: ниже — тишина
    const SQUEEZE_WIN = 240; // 10 мс при 24 кГц
    let quietTail = 0; // тишина в конце уже поставленного, сэмплов: пауза может идти через стык кусков
    let squeezedS = 0; // сколько секунд пауз выкинули за это включение

    function squeezeGaps(f32, lagging) {
        const keep = Math.round(SQUEEZE_KEEP_S * OUT_RATE);
        const out = lagging ? new Float32Array(f32.length) : null;
        let o = 0;
        let run = quietTail;
        for (let i = 0; i < f32.length; i += SQUEEZE_WIN) {
            const end = Math.min(i + SQUEEZE_WIN, f32.length);
            let e = 0;
            for (let j = i; j < end; j++) e += f32[j] * f32[j];
            if (Math.sqrt(e / (end - i)) < SQUEEZE_QUIET) {
                const drop = lagging && run >= keep;
                run += end - i;
                if (drop) continue;
            } else {
                run = 0;
            }
            if (out) {
                out.set(f32.subarray(i, end), o);
                o += end - i;
            }
        }
        quietTail = run;
        if (!out || o === f32.length) return f32;
        squeezedS += (f32.length - o) / OUT_RATE;
        return out.subarray(0, o);
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
            const f32 = new Float32Array(n);
            for (let i = 0; i < n; i++) {
                const lo = raw.charCodeAt(i * 2);
                const hi = raw.charCodeAt(i * 2 + 1);
                let v = (hi << 8) | lo;
                if (v >= 0x8000) v -= 0x10000;
                f32[i] = v / 0x8000;
            }
            // очередь пуста — паузе не с чем стыковаться
            if (playAt < playCtx.currentTime + 0.05) quietTail = 0;
            const pcm = squeezeGaps(f32, playAt - playCtx.currentTime > SQUEEZE_LAG_S);
            if (!pcm.length) return; // кусок был целиком лишней тишиной
            const buf = playCtx.createBuffer(1, pcm.length, OUT_RATE);
            buf.copyToChannel(pcm, 0);

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
                // Ворота отправки опускаем вместе с очередью. Они считались по
                // убежавшему playAt и могли уйти на десять секунд вперёд: очередь
                // сбросили, а свой звук переводчику всё это время не уходил —
                // снаружи это выглядит как «перевод работает только в одну
                // сторону» (разбор 25.11). Хвост оставляем, иначе переводчик
                // услышит остаток собственного перевода.
                muteSendUntil = Date.now() + (loopPc ? SEND_TAIL_LOOP_MS : SEND_TAIL_MS);
                log('перевод отстал больше ' + MAX_QUEUE_S + ' с — остаток отброшен');
            }
            src.start(playAt);
            if (meter) try {
                // Когда этот кусок выйдет из динамика — по часам performance.now,
                // в которых меряется и микрофон. Задержку петли и вывода точно не
                // знаем, и не надо: измеритель ищет сдвиг сам.
                let at = performance.now() + (playAt - playCtx.currentTime) * 1000;
                try {
                    const ts = playCtx.getOutputTimestamp?.();
                    if (ts && ts.performanceTime > 0) at = ts.performanceTime + (playAt - ts.contextTime) * 1000;
                } catch {
                    /* часов вывода нет — берём грубую оценку */
                }
                const w = Math.round((OUT_RATE * LEAK_WIN_MS) / 1000);
                for (let i = 0, k = 0; i + w <= pcm.length; i += w, k++) {
                    let e = 0;
                    for (let j = i; j < i + w; j++) e += pcm[j] * pcm[j];
                    meter.addOut(at + k * LEAK_WIN_MS, (e / w) * voiceGain * voiceGain);
                }
            } catch (err) {
                // измеритель не должен трогать звук: без замера ворота просто стоят
                meter = null;
                log('измеритель утечки отключён:', err.message);
            }
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
            const pcm = e.data;
            const samples = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.byteLength / 2);
            // Огибающая микрофона для измерителя утечки — всегда, и под воротами
            // особенно: эхо ищем именно там. Кадр — 100 мс, пришёл только что.
            const w = (16000 * LEAK_WIN_MS) / 1000;
            const t0 = performance.now() - (samples.length / 16000) * 1000;
            let sum = 0;
            for (let i = 0, k = 0; i < samples.length; i += w, k++) {
                let part = 0;
                const end = Math.min(i + w, samples.length);
                for (let j = i; j < end; j++) {
                    const v = samples[j] / 32768;
                    part += v * v;
                }
                sum += part;
                if (meter) {
                    try {
                        meter.addIn(t0 + k * LEAK_WIN_MS, part / (end - i));
                    } catch (err) {
                        meter = null; // без замера ворота стоят — как раньше
                        log('измеритель утечки отключён:', err.message);
                    }
                }
            }
            // Пока звучит перевод, свой звук переводчику не шлём. Иначе он
            // слышит из динамика собственный перевод, переводит его снова, и
            // урок превращается в эхо с заиканием (заход 24.11). Но ворота же
            // съедают начала фраз — поэтому стоят они, только пока замер не
            // показал, что эхо перевода в микрофон не течёт (gateStep).
            if (Date.now() < muteSendUntil) {
                gatedMs += (samples.length / 16000) * 1000;
                if (!gateTrusted) return;
                passedMs += (samples.length / 16000) * 1000;
            }
            if (samples.length && Math.sqrt(sum / samples.length) > SELF_LEVEL) {
                selfUntil = Date.now() + SELF_HOLD_MS;
                duckNow();
            }
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
            roomOn = true; // перевод в комнате идёт, что бы ни вышло у нас
            // Язык показываем сразу, не дожидаясь успеха: педагог его уже
            // назначил, и человек должен видеть то, что есть на самом деле.
            // Раньше при неудачном включении язык оставался прежним — педагог
            // ставил английский, а у студента так и стоял русский (25.11).
            for (const fn of onText) fn({ kind: 'lang', lang: d.lang });

            if (on && d.lang && d.lang !== myLang) {
                // уже переводим, но ведущий сменил язык — пересаживаемся
                socket.emit('translateJoin', { lang: d.lang }, (r) => {
                    if (r && r.ok) {
                        myLang = d.lang;
                        showToast(noticeFor(d.lang));
                    }
                });
                return;
            }
            if (on) return;

            let r = await start({ lang: d.lang, stream: lastStream?.() });
            if (r.error) {
                // Микрофон мог быть ещё не готов — это самое частое. Пробуем
                // ещё раз через полторы секунды, молча.
                await new Promise((res) => setTimeout(res, 1500));
                r = await start({ lang: d.lang, stream: lastStream?.() });
            }
            if (!r.error) showToast(noticeFor(d.lang));
            log(
                r.error ? 'ведущий включил перевод, но не вышло: ' + r.error : 'перевод включил ведущий, язык ' + d.lang
            );
            for (const fn of onText) fn({ kind: 'state', on: !r.error, lang: d.lang, byTeacher: true, why: r.error });
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
            if (Array.isArray(d.langs) && d.langs.length) keepLangs(d.langs);
            lastOwnVoice = !!d.ownVoice;
            lastServerVoice = d.voice || '';
            ui?.setOwnVoice?.(lastOwnVoice, lastServerVoice);
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
    // Микрофон урока — тот самый, что идёт в комнату. Берём его сами, если нам
    // не передали поток: у студента перевод включает ведущий, и в этот момент
    // localAudioStream может быть ещё не выставлен. Тогда start() возвращал
    // «нет микрофона», перевод у студента не поднимался — и выглядело это как
    // «работает только в одну сторону», потому что речь студента никто не
    // переводил, а его панель писала «педагог не включил перевод» (живой заход
    // 25.11, компьютеры школы).
    function micFromRoom() {
        try {
            if (typeof rc === 'undefined' || !rc) return null;
            const id = rc.producerLabel.get('audioType');
            const p = id && rc.producers.get(id);
            const t = p && p.track;
            return t && t.readyState === 'live' ? new MediaStream([t]) : null;
        } catch (e) {
            return null;
        }
    }

    async function start({ lang, stream } = {}) {
        if (on) return { ok: true, lang: myLang };
        if (!socket) return { error: 'нет соединения' };
        if (!lang) return { error: 'не выбран язык' };
        micStream = stream || micFromRoom() || micStream;
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
        meter = new LeakMeter();
        gateTrusted = false;
        gatedMs = passedMs = 0;
        clearInterval(gateTimer);
        gateTimer = setInterval(gateStep, 1000);
        log('включён, язык:', lang);
        return { ok: true, lang };
    }

    function stop() {
        if (!on) return;
        on = false;
        // сводка в консоль: сколько пауз выкинули — видно, работает ли догон
        if (squeezedS > 0) log('за включение ужато пауз: ' + squeezedS.toFixed(1) + ' с');
        clearInterval(gateTimer);
        gateTimer = null;
        if (gatedMs > 0) {
            // Сводка за включение — та же мера, что у моба («под воротами 72 с из
            // 383»): сколько своего звука пришлось на время перевода и сколько
            // из него всё-таки дошло до переводчика.
            const sum = {
                summary: 1,
                gatedS: Math.round(gatedMs / 100) / 10,
                passedS: Math.round(passedMs / 100) / 10,
                squeezedS: Math.round(squeezedS * 10) / 10,
                trusted: gateTrusted ? 1 : 0,
            };
            log('ворота за включение', sum);
            try {
                if (typeof MontemeetDiag !== 'undefined') MontemeetDiag.report('translate-gate', sum);
            } catch {
                /* журнал — не главное */
            }
        }
        meter = null;
        gateTrusted = false;
        squeezedS = 0;
        quietTail = 0;
        roomOn = false;
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
        outputReady = null; // иначе повторное включение не поднимет вывод
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
        de: 'Deutsch',
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
    // Названия на языке интерфейса — для педагога: он выбирает язык студента
    // и должен прочесть название сам. Студенту — на самих языках (ENDONYM): так
    // он узнаёт свой, на каком бы языке ни был интерфейс (Иван, 27.11; в мобе
    // уже так — montemeet-app meet/src/room/translateLangs.ts, таблицы те же).
    const IN_UI = {
        ru: {
            de: 'немецкий', fr: 'французский', zh: 'китайский', ru: 'русский', es: 'испанский', en: 'английский',
            ar: 'арабский', pt: 'португальский', id: 'индонезийский', it: 'итальянский', ko: 'корейский',
            th: 'тайский', vi: 'вьетнамский', ja: 'японский', tr: 'турецкий', hi: 'хинди', ms: 'малайский',
            nl: 'нидерландский', ur: 'урду', nb: 'норвежский', sv: 'шведский', da: 'датский', he: 'иврит',
            fi: 'финский', pl: 'польский', is: 'исландский', cs: 'чешский', fil: 'филиппинский', fa: 'персидский',
            uk: 'украинский',
        },
        uk: {
            de: 'німецька', fr: 'французька', zh: 'китайська', ru: 'російська', es: 'іспанська', en: 'англійська',
            ar: 'арабська', pt: 'португальська', id: 'індонезійська', it: 'італійська', ko: 'корейська',
            th: 'тайська', vi: 'в’єтнамська', ja: 'японська', tr: 'турецька', hi: 'гінді', ms: 'малайська',
            nl: 'нідерландська', ur: 'урду', nb: 'норвезька', sv: 'шведська', da: 'данська', he: 'іврит',
            fi: 'фінська', pl: 'польська', is: 'ісландська', cs: 'чеська', fil: 'філіппінська', fa: 'перська',
            uk: 'українська',
        },
        en: {
            de: 'German', fr: 'French', zh: 'Chinese', ru: 'Russian', es: 'Spanish', en: 'English',
            ar: 'Arabic', pt: 'Portuguese', id: 'Indonesian', it: 'Italian', ko: 'Korean', th: 'Thai',
            vi: 'Vietnamese', ja: 'Japanese', tr: 'Turkish', hi: 'Hindi', ms: 'Malay', nl: 'Dutch',
            ur: 'Urdu', nb: 'Norwegian', sv: 'Swedish', da: 'Danish', he: 'Hebrew', fi: 'Finnish', pl: 'Polish',
            is: 'Icelandic', cs: 'Czech', fil: 'Filipino', fa: 'Persian', uk: 'Ukrainian',
        },
    };
    const GROUP = {
        ru: ['основные', 'остальные'],
        uk: ['основні', 'інші'],
        en: ['main', 'more'],
    };
    const uiLang = () => {
        const l = window.MontemeetI18n?.lang;
        return IN_UI[l] ? l : 'uk';
    };
    // Как назвать язык в этой панели: педагогу — на языке интерфейса, всем
    // остальным — на самом этом языке. Роль может выясниться позже сборки
    // панели, поэтому подписи перерисовываются (relabel), а не только строятся.
    const labelOf = (code) => {
        if (iAmPresenter) return IN_UI[uiLang()][code] || IN_UI.en[code] || ENDONYM[code] || code;
        return ENDONYM[code] || IN_UI.en[code] || code;
    };
    const noticeFor = (lang) => {
        const name = ENDONYM[lang] || lang;
        return (NOTICE[lang] || NOTICE.en)(name);
    };
    const langOptions = (sel) => {
        const [main, more] = GROUP[uiLang()];
        const opt = ([v]) => `<option value="${v}"${v === sel ? ' selected' : ''}>${labelOf(v)}</option>`;
        return (
            `<optgroup label="${main}">${MAIN_LANGS.map(opt).join('')}</optgroup>` +
            `<optgroup label="${more}">${MORE_LANGS.map(opt).join('')}</optgroup>`
        );
    };
    // Перерисовать подписи в уже построенных списках: роль приходит от сервера
    // позже сборки, а язык интерфейса можно сменить на лету.
    function relabel() {
        if (!ui) return;
        const [main, more] = GROUP[uiLang()];
        for (const sel of [ui.panel.querySelector('#mmTrLangTeacher'), ui.panel.querySelector('#mmTrLangStudent')]) {
            if (!sel) continue;
            const groups = sel.querySelectorAll('optgroup');
            if (groups[0]) groups[0].label = main;
            if (groups[1]) groups[1].label = more;
            for (const o of sel.options) o.textContent = labelOf(o.value);
        }
    }
    const SAVED_LANG = 'mmTranslateLang';
    const SAVED_SUBS = 'mmTranslateSubs';
    const SAVED_GAIN = 'mmTranslateGain';
    const SAVED_STUDENT = 'mmTranslateStudentLang';
    const SAVED_VOICE = 'mmTranslateVoice';
    // Предлагали ли уже этому педагогу его собственный голос: предложение
    // одноразовое, дальше решает он сам.
    const OWN_VOICE_SEEN = 'mmTranslateOwnVoiceSeen';

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
/* Быстрый тумблер рядом с кнопкой — как в мобе (27.11): у педагога после
   первого включения перевода и до конца сессии, чтобы выключить и включить
   снова, не открывая панель. Стоит со стороны центра экрана, на тёмной
   подложке — виден и поверх светлого видео. Дорожку видно и выключенной. */
#mmTrQuick {
    position: fixed; z-index: 2147483000;
    top: calc(env(safe-area-inset-top, 0px) + 19px); right: 74px;
    padding: 4px; border: 0; border-radius: 19px; cursor: pointer;
    background: rgba(0,0,0,.5); display: block;
}
#mmTrQuick[hidden] { display: none; }
#mmTrQuick .mmTrTrack {
    display: block; box-sizing: border-box; width: 56px; height: 30px; padding: 2px; border-radius: 15px;
    background: rgba(255,255,255,.18); border: 1px solid rgba(255,255,255,.55); transition: background .15s;
}
#mmTrQuick .mmTrKnob {
    display: block; width: 24px; height: 24px; border-radius: 12px;
    background: rgba(255,255,255,.85); transition: transform .15s;
}
#mmTrQuick[aria-checked="true"] .mmTrTrack { background: #2f6df6; border-color: #2f6df6; }
#mmTrQuick[aria-checked="true"] .mmTrKnob { transform: translateX(26px); background: #fff; }
#mmTrQuick[aria-disabled="true"] { opacity: .6; cursor: default; }
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
/* панель открыта — кнопка становится крестиком: по ней же её и закрывают */
#mmTrBtn[data-open="1"] .mmTrGlyph { display: none; }
#mmTrBtn[data-open="1"]::before { content: '✕'; font-size: 20px; line-height: 1; }
#mmTrPanel {
    position: fixed; z-index: 2147483000;
    top: calc(env(safe-area-inset-top, 0px) + 72px); right: 12px;
    width: min(380px, calc(100vw - 24px));
    padding: 14px 16px 16px; border-radius: 16px;
    background: rgba(24,24,29,.94); color: #eceef2;
    box-shadow: 0 10px 34px rgba(0,0,0,.5); backdrop-filter: blur(10px);
}
#mmTrPanel[hidden] { display: none; }
/* Всё скрытое внутри панели — скрыто, что бы ни говорил наш display. На
   странице урока это делал bootstrap ([hidden] { display: none !important }),
   но он грузится с внешнего CDN: при упавшем канале студент увидел бы строку
   «Включить перевод», а педагог без образца — кнопку своего голоса (стенд
   27.11). Своё правило не зависит ни от чего. */
#mmTrPanel [hidden] { display: none !important; }
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
/* Субтитры — как на YouTube и как в мобе (27.11): неподвижная полоса в две
   строки постоянной ширины, текст слева, прижат к низу и растёт вверх — верх
   обрезается. Раньше полоса была по центру и меняла ширину с каждым словом, а
   длинный монолог переставал помещаться. */
#mmTrSubs {
    position: fixed; z-index: 2147482000; left: 50%; transform: translateX(-50%);
    bottom: calc(env(safe-area-inset-bottom, 0px) + 96px);
    width: min(760px, calc(100vw - 32px));
    font-size: clamp(17px, 2.2vw, 22px); line-height: 1.4;
    pointer-events: none; opacity: 0; transition: opacity .18s;
}
#mmTrSubs .mmTrSubsBox { padding: 6px 14px; border-radius: 10px; background: rgba(0,0,0,.66); }
/* Окно ровно в две строки: обрезаем по границе строки, а не по краю полосы —
   иначе в верхнем поле торчали хвостики букв ушедшей строки (стенд 27.11). */
#mmTrSubs .mmTrSubsWin { position: relative; height: 2.8em; overflow: hidden; }
#mmTrSubs .mmTrSubsText {
    position: absolute; left: 0; right: 0; bottom: 0;
    color: #fff; text-align: left; white-space: pre-wrap; overflow-wrap: anywhere;
    text-shadow: 0 1px 2px rgba(0,0,0,.6);
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
/* Выбранный значок — на светлом, а не на синем: значок говорящей головы сам
   сине-серый и на синей заливке почти пропадал (Иван, 26.11). Белить его
   фильтром нельзя — силуэт пересвечивается в пятно; на светлом хорошо видны
   все три. */
.mmTrVoices button[aria-pressed="true"] {
    background: #e2eaf8; color: #1b2a4a; border-color: #2f6df6;
    box-shadow: inset 0 0 0 1px #2f6df6;
}
.mmTrVoices[hidden] { display: none; }
/* Своё display: flex сильнее браузерного правила для hidden, и скрытая кнопка
   оставалась на виду (поймано на стенде 26.11). */
.mmTrVoices button[hidden] { display: none; }
#mmTrPair select[disabled] { opacity: .75; }
#mmTrSign {
    align-self: center; margin-top: 18px; width: 34px; height: 34px; flex: none;
    padding: 0; border: 0; background: none; border-radius: 9px;
}
#mmTrSign[data-swap="1"] { cursor: pointer; }
#mmTrSign[data-swap="1"]:active { transform: scale(.92); }
#mmTrSign svg path { transform-origin: 50% 50%; }
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
#mmTrSubs .mmTrWho {
    display: inline-block; margin-bottom: 4px; padding: 1px 8px; border-radius: 6px;
    background: rgba(0,0,0,.5); color: rgba(255,255,255,.85);
    font-size: 12px; font-weight: 700; line-height: 1.5;
}
#mmTrSubs .mmTrWho:empty { display: none; }
@media (min-width: 900px) {
    /* Справа внизу стоит своё окно камеры — кнопка его перекрывала (заход 24.11).
       Слева внизу свободно. */
    #mmTrBtn { top: auto; bottom: 24px; right: auto; left: 18px; }
    #mmTrQuick { top: auto; bottom: 31px; right: auto; left: 80px; }
    #mmTrPanel { top: auto; bottom: 88px; right: auto; left: 18px; }
    #mmTrSubs { bottom: calc(env(safe-area-inset-bottom, 0px) + 112px); }
}
`;

    let ui = null;

    // ---------- субтитры: подача текста ----------
    //
    // Перенос из моба (montemeet-app meet/src/net/subtitles.ts, 27.11), правила
    // те же, чтобы урок выглядел одинаково на телефоне и за компьютером. Образец
    // — субтитры YouTube (замечание Ивана: на длинном монологе текст «уходил за
    // три точки», а каждое слово перекладывало все строки).
    //
    // Поставщик отдаёт перевод кусками — то словом, то сразу длинной фразой, и
    // раньше голоса. Здесь:
    //  - текст дописывается ПО СЛОВАМ в темпе чтения (SUB_BASE_CPS знаков в
    //    секунду — норма субтитров 17–20); накопилось много — темп растёт так,
    //    чтобы отставание ушло за SUB_CATCHUP_MS, но не быстрее SUB_MAX_CPS;
    //  - экран — неподвижная полоса в две строки, заполненная строка уходит
    //    вверх; ушедшее из вида экран сообщает сюда (trim), и оно убирается
    //    ЦЕЛЫМИ строками — оставшиеся от этого не перекладываются;
    //  - новая мысль — с чистой строки: прошлое предложение закончено и была
    //    пауза SUB_NEW_BLOCK_MS; сменился говорящий — тоже;
    //  - после SUB_HIDE_MS тишины субтитры гаснут.
    const SUB_BASE_CPS = 18;
    const SUB_MAX_CPS = 60;
    const SUB_CATCHUP_MS = 2500;
    const SUB_TICK_MS = 60;
    const SUB_NEW_BLOCK_MS = 1500;
    const SUB_HIDE_MS = 5000;
    // Слово длиннее этого (китайский, японский, тайский — без пробелов) подаём знаками.
    const SUB_LONG_WORD = 14;

    class Subtitles {
        constructor(emit, now = () => Date.now()) {
            this.emit = emit;
            this.now = now;
            this.from = '';
            this.shown = '';
            this.pending = '';
            this.budget = 0;
            this.lastShownAt = 0;
            this.tick = null;
            this.hide = null;
        }

        // Новый кусок перевода от говорящего from.
        push(from, delta) {
            if (!delta) return;
            if (from !== this.from && (this.shown || this.pending)) {
                this.shown = '';
                this.pending = '';
                this.budget = 0;
            }
            this.from = from;
            this.pending += delta;
            if (this.hide) {
                clearTimeout(this.hide);
                this.hide = null;
            }
            if (!this.tick) {
                // Первое слово — сразу: субтитры не должны ждать такт.
                this.budget = Math.max(this.budget, this.nextWord().length);
                this.step();
            }
        }

        // Экран убрал из вида первые chars знаков показанного (целые строки).
        trim(chars) {
            if (chars <= 0 || chars >= this.shown.length) return;
            this.shown = this.shown.slice(chars);
            this.emit({ from: this.from, text: this.shown });
        }

        clear() {
            clearTimeout(this.tick);
            clearTimeout(this.hide);
            this.tick = this.hide = null;
            const had = !!this.shown;
            this.from = this.shown = this.pending = '';
            this.budget = 0;
            if (had) this.emit(null);
        }

        nextWord() {
            const m = /^\s*\S+\s*/.exec(this.pending);
            if (!m) return this.pending; // одни пробелы
            const word = m[0];
            return word.trim().length > SUB_LONG_WORD ? word.slice(0, Math.max(1, word.search(/\S/) + 2)) : word;
        }

        step() {
            this.tick = null;
            let changed = false;
            while (this.pending) {
                const word = this.nextWord();
                if (this.budget < word.length) break;
                this.budget -= word.length;
                this.pending = this.pending.slice(word.length);
                // Новая мысль после паузы — с чистой строки.
                if (
                    this.shown &&
                    /[.!?…。！？]["»”)]?\s*$/.test(this.shown) &&
                    this.now() - this.lastShownAt >= SUB_NEW_BLOCK_MS
                ) {
                    this.shown = '';
                }
                this.shown += this.shown ? word : word.replace(/^\s+/, '');
                this.lastShownAt = this.now();
                changed = true;
            }
            if (changed) this.emit({ from: this.from, text: this.shown });
            if (this.pending) {
                const cps = Math.min(SUB_MAX_CPS, Math.max(SUB_BASE_CPS, (this.pending.length * 1000) / SUB_CATCHUP_MS));
                this.budget += (cps * SUB_TICK_MS) / 1000;
                this.tick = setTimeout(() => this.step(), SUB_TICK_MS);
            } else {
                this.budget = 0;
                this.hide = setTimeout(() => {
                    this.hide = null;
                    this.shown = '';
                    this.emit(null);
                }, SUB_HIDE_MS);
            }
        }
    }
    let lastPeers = [];
    let lastStream = null; // как добыть микрофон — нужно, когда перевод включает ведущий
    const nameOfLang = (code) => labelOf(code);
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
        const TITLE = {
            clone: 'Голос говорящего (звучит естественнее, но задерживает перевод)',
            female: 'Женский голос',
            male: 'Мужской голос',
        };
        // Голос говорящего предлагаем, только когда он записан заранее, и только
        // педагогу. Иначе поставщик снимает образец прямо на уроке и задерживает
        // каждую фразу: у студента образца нет вовсе, у педагога без записи —
        // тоже (Иван, 26.11, оба решения). Поэтому у студента кнопки нет совсем,
        // а у педагога она нарисована скрытой и открывается, когда сервер
        // подтвердит, что голос записан.
        const voiceGroup = (side) =>
            `<div class="mmTrVoices" id="mmTrVoice${side}" role="group" aria-label="Голос перевода">` +
            (side === 'Teacher' ? ['clone', 'female', 'male'] : ['female', 'male'])
                .map(
                    (v) =>
                        `<button type="button" data-v="${v}" title="${TITLE[v]}" aria-label="${TITLE[v]}"` +
                        `${v === 'clone' ? ' hidden' : ''}` +
                        ` aria-pressed="${v === 'female' ? 'true' : 'false'}">${ICON[v]}</button>`
                )
                .join('') +
            '</div>';

        // Знак перевода: две встречные стрелки в цветах знака Montemeet.
        // Пока перевод идёт, они по очереди оживают — видно, что канал жив.
        const sign =
            '<button type="button" id="mmTrSign" title="Поменять языки местами" aria-label="Поменять языки местами">' +
            '<svg viewBox="0 0 36 36" aria-hidden="true" style="width:100%;height:100%">' +
            '<defs>' +
            '<linearGradient id="mmTrGa" x1="0" y1="0" x2="1" y2="1">' +
            '<stop offset="0" stop-color="#88B92C"/><stop offset="1" stop-color="#008C99"/></linearGradient>' +
            '<linearGradient id="mmTrGb" x1="1" y1="0" x2="0" y2="1">' +
            '<stop offset="0" stop-color="#F7B234"/><stop offset="1" stop-color="#E5422E"/></linearGradient>' +
            '</defs>' +
            '<g fill="none" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">' +
            '<path class="a" d="M7 13h17m-5-5 5 5-5 5" stroke="url(#mmTrGa)"/>' +
            '<path class="b" d="M29 25H12m5 5-5-5 5-5" stroke="url(#mmTrGb)"/>' +
            '</g></svg></button>';

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
            // Предмет урока: от него зависит глоссарий, который уходит
            // поставщику. Видит и меняет только педагог (Иван, 25.11).
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
        subs.innerHTML =
            '<span class="mmTrWho"></span>' +
            '<div class="mmTrSubsBox"><div class="mmTrSubsWin"><div class="mmTrSubsText"></div></div></div>';

        const toast = document.createElement('div');
        toast.id = 'mmTrToast';

        const quick = document.createElement('button');
        quick.type = 'button';
        quick.id = 'mmTrQuick';
        quick.hidden = true;
        quick.setAttribute('role', 'switch');
        quick.setAttribute('aria-checked', 'false');
        quick.title = 'Перевод: включить или выключить';
        quick.setAttribute('aria-label', quick.title);
        quick.innerHTML = '<span class="mmTrTrack"><span class="mmTrKnob"></span></span>';

        document.body.append(btn, quick, panel, subs, toast);
        ui = { btn, quick, panel, subs, toast };
        if (allowed) btn.hidden = false;
        watchOverlays();

        const onSw = panel.querySelector('#mmTrOn');
        const teachSel = panel.querySelector('#mmTrLangTeacher');
        const studentSel = panel.querySelector('#mmTrLangStudent');
        const voiceBox = {
            teacher: panel.querySelector('#mmTrVoiceTeacher'),
            student: panel.querySelector('#mmTrVoiceStudent'),
        };
        const getVoice = (side) => voiceBox[side].querySelector('[aria-pressed="true"]')?.dataset.v || 'female';
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
            relabel();
            ui?.syncQuick?.();
            teachSel.disabled = !iAmPresenter; // студенту язык педагога — только показ
            voiceBox.teacher.hidden = !iAmPresenter;
            voiceBox.student.hidden = !iAmPresenter;
            if (onRow) onRow.hidden = !iAmPresenter; // включает перевод только педагог
            offEl.hidden = iAmPresenter || on || roomOn;
            note.hidden = !iAmPresenter && !on;
            const sw = panel.querySelector('#mmTrSign');
            if (sw) sw.dataset.swap = iAmPresenter ? '1' : '0';
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

        const signBtn = panel.querySelector('#mmTrSign');

        btn.onclick = () => {
            panel.hidden = !panel.hidden;
            btn.dataset.open = panel.hidden ? '0' : '1';
            // язык интерфейса могли сменить в настройках — подписи по нему
            if (!panel.hidden) relabel();
        };

        // Знак между языками меняет их местами — как в переводчиках (Иван,
        // 24.11). Студенту менять нечего: язык педагога он не выбирает.
        // Свой голос педагога, созданный заранее: он и естественнее, и больше не
        // стоит задержки (замер 26.11), поэтому с ним умолчание — он.
        //
        // Один раз это умолчание сильнее прежнего выбора. Иван зашёл первым, и
        // панель показала мужской голос: он выбирал его в прежние дни, когда
        // своего голоса ещё не было, — выбор сохранён и перекрывал умолчание
        // (заход 26.11). Поэтому при первом появлении своего голоса ставим его
        // и помечаем, что предлагали; дальше выбор педагога снова главнее.
        ui.setOwnVoice = (yes, serverVoice) => {
            const b = voiceBox.teacher.querySelector('button[data-v="clone"]');
            if (!yes) {
                // Голос не записан — кнопки нет. Ставим то, что умолчанием
                // считает сервер: он берёт голос по полу педагога из справочника
                // школы, а панель показывала женский независимо от этого и при
                // включении перевода пересиливала сервер своим значком. Прежний
                // выбор педагога не трогаем — кроме «как говорящего», который
                // иначе остался бы висеть на скрытой кнопке.
                if (b) b.hidden = true;
                let chosen = null;
                try {
                    chosen = localStorage.getItem(SAVED_VOICE);
                } catch {
                    /* памяти нет — считаем, что выбора не было */
                }
                if ((!chosen || chosen === 'clone') && ['female', 'male'].includes(serverVoice)) {
                    setVoice('teacher', serverVoice);
                }
                return;
            }
            if (b) {
                b.hidden = false;
                b.title = 'Ваш голос — записан заранее, перевод не задерживает';
            }
            let offered = null;
            try {
                offered = localStorage.getItem(OWN_VOICE_SEEN);
            } catch {
                /* памяти нет — предложим снова при следующем заходе */
            }
            if (offered) return;
            setVoice('teacher', 'clone');
            try {
                localStorage.setItem(OWN_VOICE_SEEN, '1');
                localStorage.setItem(SAVED_VOICE, 'clone');
            } catch {
                /* не сохранилось — не беда */
            }
        };

        ui.setOwnVoice(lastOwnVoice, lastServerVoice);

        signBtn.onclick = () => {
            if (!iAmPresenter) return;
            const a = teachSel.value;
            teachSel.value = studentSel.value;
            studentSel.value = a;
            try {
                localStorage.setItem(SAVED_LANG, teachSel.value);
                localStorage.setItem(SAVED_STUDENT, studentSel.value);
            } catch (e) {
                /* не сохранилось — не беда */
            }
            if (on) applyForAll(true);
        };
        document.addEventListener('click', (e) => {
            if (!panel.hidden && !panel.contains(e.target) && e.target !== btn && !btn.contains(e.target)) {
                panel.hidden = true;
                btn.dataset.open = '0';
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

        // Быстрый тумблер повторяет главный и жмёт его же: правила включения
        // одни, расходиться им негде. Включённым он показывается и пока перевод
        // поднимается («включаю…») — как в мобе, чтобы не мигал.
        let everOn = false;
        const syncQuick = () => {
            const onNow = btn.dataset.on === '1';
            if (onNow && iAmPresenter) everOn = true;
            quick.hidden = !(iAmPresenter && everOn);
            quick.setAttribute('aria-checked', String(onNow || onSw.disabled));
            quick.setAttribute('aria-disabled', String(!!onSw.disabled));
        };
        ui.syncQuick = syncQuick;
        quick.onclick = () => {
            if (onSw.disabled || !iAmPresenter) return;
            // От того, что видит человек: горит кнопка — значит выключаем.
            // Переключать сам главный тумблер нельзя — разойдись он хоть раз с
            // кнопкой, быстрый стал бы жать наоборот (стенд 27.11).
            onSw.checked = btn.dataset.on !== '1';
            onSw.onchange();
        };
        const quickWatch = new MutationObserver(syncQuick);
        quickWatch.observe(btn, { attributes: true, attributeFilter: ['data-on'] });
        quickWatch.observe(onSw, { attributes: true, attributeFilter: ['disabled'] });
        syncQuick();

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
            if (!subsSw.checked) {
                // выключили — гасим сразу и забываем недоказанное, чтобы при
                // включении не вылезла старая фраза
                subtitles.clear();
                subs.dataset.show = '0';
            }
        };

        // ---------- то, что приходит с сервера ----------

        const subsWho = subs.querySelector('.mmTrWho');
        const subsText = subs.querySelector('.mmTrSubsText');
        // Видно две строки; в тексте держим четыре — видимые и запас над ними.
        // Лишнее сверху убираем целыми строками, когда накопилось больше: тогда
        // оставшиеся строки не перекладываются (так же в мобе).
        const SUB_KEEP_LINES = 4;

        // Сколько знаков в начале текста занимают строки, ушедшие выше запаса.
        // Строку узнаём по вертикали знака: ищем первый знак, стоящий на нужной
        // строке, — двоичным поиском, вертикаль по тексту только растёт.
        const subsOverflow = () => {
            const node = subsText.firstChild;
            if (!node || node.nodeType !== 3) return 0;
            const lh = parseFloat(getComputedStyle(subsText).lineHeight) || 0;
            if (!lh) return 0;
            const lines = Math.round(subsText.offsetHeight / lh);
            if (lines <= SUB_KEEP_LINES) return 0;
            const top0 = subsText.getBoundingClientRect().top;
            const want = (lines - SUB_KEEP_LINES) * lh - lh / 2;
            const range = document.createRange();
            const topOf = (i) => {
                range.setStart(node, i);
                range.setEnd(node, i + 1);
                const r = range.getClientRects()[0] || range.getBoundingClientRect();
                return r.top - top0;
            };
            let lo = 0;
            let hi = node.length - 1;
            while (lo < hi) {
                const mid = (lo + hi) >> 1;
                if (topOf(mid) >= want) hi = mid;
                else lo = mid + 1;
            }
            return lo;
        };

        const subtitles = new Subtitles((view) => {
            if (!view) {
                subs.dataset.show = '0';
                return;
            }
            if (!subsSw.checked) return;
            subsWho.textContent = view.from || '';
            subsText.textContent = view.text;
            subs.dataset.show = '1';
            const drop = subsOverflow();
            if (drop > 0) subtitles.trim(drop);
        });

        onText.push((d) => {
            if (d.kind === 'lang') {
                if (d.lang) mySel().value = d.lang;
                applyRole();
                return;
            }
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
                    if (d.byTeacher)
                        roomOn = true; // ведущий включил, не вышло у нас
                    else if (d.reason) roomOn = false; // перевод в комнате выключен
                    note.textContent = d.why
                        ? 'перевод не включился: ' + d.why
                        : d.reason === 'limit'
                          ? 'израсходован предел на урок'
                          : 'перевод выключен';
                } else if (d.byTeacher) {
                    roomOn = true;
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
                if (subsSw.checked) subtitles.push(d.from || '', String(d.text || ''));
            }
        });
    }

    // Сервер сказал, какие языки примет, — лишние из списков убираем. Показывать
    // то, чего сервер не возьмёт, нельзя: он молча отвергает такой выбор, язык
    // остаётся прежним, и человек видит перевод не на тот язык (Иван, 24.11).
    function keepLangs(allowed) {
        const ok = new Set(allowed);
        if (!ui) return;
        for (const sel of [ui.panel.querySelector('#mmTrLangTeacher'), ui.panel.querySelector('#mmTrLangStudent')]) {
            if (!sel) continue;
            const was = sel.value;
            for (const opt of [...sel.options]) {
                if (!ok.has(opt.value)) opt.remove();
            }
            if (ok.has(was)) sel.value = was;
        }
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
            ui.quick.style.display = busy ? 'none' : '';
            if (busy) {
                ui.panel.hidden = true;
                ui.btn.dataset.open = '0';
            }
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
