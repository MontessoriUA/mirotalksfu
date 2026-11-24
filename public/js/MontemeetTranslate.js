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
        socket.on('translateVoice', (d = {}) => {
            revealUi();
            if (d.audio) playPcm16(d.audio);
        });

        // Проба: пустой язык сервер отвергает, но сам факт ответа говорит, что
        // в этой комнате перевод разрешён. Где его нет, обработчика нет вовсе —
        // ответа не будет, и кнопка останется скрытой.
        try {
            socket.emit('translateJoin', { lang: '' }, () => revealUi());
        } catch {
            /* соединения ещё нет — тогда разрешение придёт событием */
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

    const LANGS = [
        ['ru', 'русский'],
        ['en', 'английский'],
        ['zh', 'китайский'],
        ['fr', 'французский'],
    ];
    const SAVED_LANG = 'mmTranslateLang';
    const SAVED_SUBS = 'mmTranslateSubs';

    const CSS = `
#mmTr, #mmTrSubs { font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
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
    width: min(300px, calc(100vw - 24px));
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
#mmTrHeard { margin-top: 8px; font-size: 12px; opacity: .5; min-height: 1.2em; }
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

    function mountUi({ getStream } = {}) {
        if (ui) return;

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
        panel.innerHTML =
            '<h4>Перевод голосом</h4>' +
            '<div class="mmTrRow"><label for="mmTrOn">Включить</label>' +
            '<span class="mmTrSwitch"><input type="checkbox" id="mmTrOn"><i></i></span></div>' +
            '<div class="mmTrRow"><label for="mmTrLang">Я говорю на</label>' +
            `<select id="mmTrLang">${LANGS.map(([v, t]) => `<option value="${v}">${t}</option>`).join('')}</select></div>` +
            '<div class="mmTrRow"><label for="mmTrSubsOn">Субтитры</label>' +
            '<span class="mmTrSwitch"><input type="checkbox" id="mmTrSubsOn" checked><i></i></span></div>' +
            '<div id="mmTrNote">перевод услышит тот, у кого выбран другой язык</div>' +
            '<div id="mmTrHeard"></div>';

        const subs = document.createElement('div');
        subs.id = 'mmTrSubs';

        document.body.append(btn, panel, subs);
        ui = { btn, panel, subs };
        if (allowed) btn.hidden = false;

        const onSw = panel.querySelector('#mmTrOn');
        const langSel = panel.querySelector('#mmTrLang');
        const subsSw = panel.querySelector('#mmTrSubsOn');
        const note = panel.querySelector('#mmTrNote');
        const heardEl = panel.querySelector('#mmTrHeard');

        try {
            const saved = localStorage.getItem(SAVED_LANG);
            if (saved && LANGS.some(([v]) => v === saved)) langSel.value = saved;
            subsSw.checked = localStorage.getItem(SAVED_SUBS) !== '0';
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

        onSw.onchange = async () => {
            if (!onSw.checked) {
                stop();
                btn.dataset.on = '0';
                langSel.disabled = false;
                note.textContent = 'перевод услышит тот, у кого выбран другой язык';
                return;
            }
            onSw.disabled = true;
            langSel.disabled = true;
            note.textContent = 'включаю…';
            const r = await start({ lang: langSel.value, stream: getStream?.() });
            onSw.disabled = false;
            if (r.error) {
                onSw.checked = false;
                langSel.disabled = false;
                note.textContent = 'не вышло: ' + r.error;
                return;
            }
            btn.dataset.on = '1';
            try {
                localStorage.setItem(SAVED_LANG, langSel.value);
            } catch {
                /* не сохранилось — не беда */
            }
            note.textContent = 'жду собеседника с другим языком';
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
                if (d.on === false) {
                    onSw.checked = false;
                    btn.dataset.on = '0';
                    langSel.disabled = false;
                    note.textContent = d.reason === 'limit' ? 'израсходован предел на урок' : 'перевод выключен';
                } else if (Array.isArray(d.peers)) {
                    const other = d.peers.filter((p) => p.lang && p.lang !== myLang).length;
                    note.textContent = other
                        ? `перевод идёт · собеседников: ${other}`
                        : 'жду собеседника с другим языком';
                }
                return;
            }
            if (d.kind === 'heard') {
                heardEl.textContent = 'услышано: ' + String(d.text).trim().slice(-90);
                return;
            }
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
    function revealUi() {
        allowed = true;
        if (ui) ui.btn.hidden = false;
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
