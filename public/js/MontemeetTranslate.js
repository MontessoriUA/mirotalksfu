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
    const DUCK = 0.25; // во сколько раз приглушаем оригинал, пока звучит перевод
    const DUCK_TAIL_MS = 400; // и держим приглушение ещё немного после

    let socket = null;
    let remoteAudioEl = null;
    let log = (...a) => console.log('[Перевод]', ...a);

    let micCtx = null;
    let micSrc = null;
    let tap = null;
    let micStream = null;

    let playCtx = null;
    let playAt = 0;
    let duckUntil = 0;
    let duckTimer = null;

    let on = false;
    let myLang = '';
    const onText = [];

    // ---------- приглушение оригинала ----------
    //
    // Грубо, зато без перестройки тракта: у элементов <audio> участников
    // понижаем громкость, пока играет перевод. Инструмент при этом тоже
    // приглушится — поэтому на музыкальных уроках перевод и должен звучать
    // только в паузах, а это задача детектора речи.

    function setDuck(active) {
        if (!remoteAudioEl) return;
        for (const el of remoteAudioEl.querySelectorAll('audio')) {
            if (el.dataset.mmFullVolume === undefined) el.dataset.mmFullVolume = String(el.volume ?? 1);
            const full = Number(el.dataset.mmFullVolume) || 1;
            el.volume = active ? full * DUCK : full;
        }
    }

    function duckNow() {
        duckUntil = Date.now() + DUCK_TAIL_MS;
        setDuck(true);
        if (duckTimer) return;
        duckTimer = setInterval(() => {
            if (Date.now() >= duckUntil) {
                setDuck(false);
                clearInterval(duckTimer);
                duckTimer = null;
            }
        }, 120);
    }

    // ---------- воспроизведение перевода ----------

    function playPcm16(b64) {
        try {
            if (!playCtx) playCtx = new AudioContext({ sampleRate: OUT_RATE });
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
            src.connect(playCtx.destination);
            // куски приходят подряд, поэтому ставим их в очередь встык
            const now = playCtx.currentTime;
            if (playAt < now) playAt = now + 0.05;
            src.start(playAt);
            playAt += buf.duration;

            duckUntil = Date.now() + buf.duration * 1000 + DUCK_TAIL_MS;
            duckNow();
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
        socket = opts.socket || null;
        remoteAudioEl = opts.remoteAudioEl || null;
        if (opts.log) log = opts.log;
        if (!socket) return;

        socket.on('translateState', (d = {}) => {
            if (d.on === false) {
                log('перевод выключен сервером:', d.reason || '');
                stop();
            }
            for (const fn of onText) fn({ kind: 'state', ...d });
        });
        socket.on('translateText', (d = {}) => {
            for (const fn of onText) fn(d);
        });
        socket.on('translateVoice', (d = {}) => {
            if (d.audio) playPcm16(d.audio);
        });
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
        log('выключен');
    }

    // ---------- простая панель ----------
    //
    // Делаем из кода, а не в разметке комнаты: это опыт, и его не должно быть
    // видно там, где перевод не включён.

    const LANGS = [
        ['ru', 'русский'],
        ['en', 'английский'],
        ['zh', 'китайский'],
        ['fr', 'французский'],
    ];

    function mountUi({ getStream } = {}) {
        if (document.getElementById('mmTranslate')) return;
        const box = document.createElement('div');
        box.id = 'mmTranslate';
        box.style.cssText =
            'position:fixed;right:12px;bottom:84px;z-index:9;max-width:320px;padding:10px 12px;' +
            'border-radius:12px;background:rgba(20,20,24,.86);color:#eee;font:13px/1.45 system-ui,sans-serif;' +
            'box-shadow:0 6px 24px rgba(0,0,0,.35);backdrop-filter:blur(6px)';
        const sel = LANGS.map(([v, t]) => `<option value="${v}">${t}</option>`).join('');
        box.innerHTML =
            '<div style="display:flex;gap:8px;align-items:center">' +
            '<span style="opacity:.75">Перевод</span>' +
            `<select id="mmTrLang" style="flex:1;background:#2a2a30;color:#eee;border:0;border-radius:8px;padding:4px 6px">${sel}</select>` +
            '<button id="mmTrBtn" style="background:#3b6ef6;color:#fff;border:0;border-radius:8px;padding:5px 12px;cursor:pointer">Включить</button>' +
            '</div>' +
            '<div id="mmTrInfo" style="margin-top:6px;opacity:.6;font-size:12px">я говорю на этом языке</div>' +
            '<div id="mmTrHeard" style="margin-top:6px;opacity:.65;font-size:12px"></div>' +
            '<div id="mmTrText" style="margin-top:4px;font-size:14px"></div>';
        document.body.appendChild(box);

        const btn = box.querySelector('#mmTrBtn');
        const langSel = box.querySelector('#mmTrLang');
        const info = box.querySelector('#mmTrInfo');
        const heardEl = box.querySelector('#mmTrHeard');
        const textEl = box.querySelector('#mmTrText');

        btn.onclick = async () => {
            if (on) {
                stop();
                btn.textContent = 'Включить';
                langSel.disabled = false;
                info.textContent = 'я говорю на этом языке';
                return;
            }
            btn.disabled = true;
            btn.textContent = 'Включаю…';
            const r = await start({ lang: langSel.value, stream: getStream?.() });
            btn.disabled = false;
            if (r.error) {
                btn.textContent = 'Включить';
                info.textContent = 'не вышло: ' + r.error;
                return;
            }
            btn.textContent = 'Выключить';
            langSel.disabled = true;
            info.textContent = 'перевод идёт';
        };

        let translated = '';
        onText.push((d) => {
            if (d.kind === 'state') {
                if (d.on === false) {
                    btn.textContent = 'Включить';
                    langSel.disabled = false;
                    info.textContent = d.reason === 'limit' ? 'предел расхода на урок' : 'выключен';
                } else if (Array.isArray(d.peers)) {
                    const other = d.peers.filter((p) => p.lang !== myLang).length;
                    info.textContent = other ? `перевод идёт, собеседников: ${other}` : 'жду собеседника с другим языком';
                }
                return;
            }
            if (d.kind === 'heard') {
                heardEl.textContent = '· ' + String(d.text).slice(-120);
            } else if (d.kind === 'translated') {
                translated = (translated + String(d.text)).slice(-200);
                textEl.textContent = translated;
                clearTimeout(mountUi._t);
                mountUi._t = setTimeout(() => (translated = ''), 6000);
            }
        });
    }

    return {
        init,
        start,
        stop,
        mountUi,
        isOn: () => on,
        lang: () => myLang,
        onMessage: (fn) => onText.push(fn),
    };
})();

if (typeof window !== 'undefined') window.MontemeetTranslate = MontemeetTranslate;
