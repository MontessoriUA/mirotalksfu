'use strict';

// Montemeet: синхронный перевод голосом — второй, тихий канал через сервер
// (вариант Б из Montemeet/app-spec/TRANSLATE.md §6).
//
// Как устроено. Говорящий отправляет копию своего звука по уже существующему
// соединению socket.io. Сервер держит сессию с поставщиком перевода и отдаёт
// результат ТОЛЬКО тем участникам, чей язык отличается от языка говорящего.
// Медиасервер при этом не трогается вовсе: ни новых дорожек, ни PlainTransport.
//
// Ключи поставщика остаются здесь, на сервере, и в браузер не попадают.
//
// События от клиента:
//   translateJoin  { lang }   участник объявляет свой язык и включает перевод
//   translateAudio { audio }  кусок его речи, base64 PCM16 16 кГц моно
//   translateLeave {}         выключить
// События клиенту:
//   translateState { on, reason, lang, peers }
//   translateText  { from, kind, text }   kind: 'heard' — что услышали у говорящего,
//                                         'translated' — перевод текстом
//   translateVoice { from, audio }        перевод голосом, base64 PCM16 24 кГц
//
// Ключи .env (без TRANSLATE_URL и TRANSLATE_KEY модуль молчит и ничего не меняет):
//   TRANSLATE_URL         адрес поставщика, например
//                         wss://ap-southeast-1.maas.qwencloudapi.com/api-ws/v1/realtime
//   TRANSLATE_MODEL       qwen3.8-livetranslate-flash-realtime
//   TRANSLATE_KEY         ключ поставщика
//   TRANSLATE_ROOMS       комнаты, где перевод разрешён (через запятую)
//   TRANSLATE_LANGS       какие языки разрешаем, по умолчанию ru,zh,en
//   TRANSLATE_MAX_SEC     предохранитель: сколько секунд звука на комнату за
//                         урок, по умолчанию 1800 (полчаса речи ≈ $1,4)
//   TRANSLATE_GLOSSARY    путь к файлу с глоссариями (phrases.json или свой)
//
// Задержка и цена — замеры в TRANSLATE.md §10.1: до первого переведённого
// голоса около 3,4 с на русский→китайский и 1,5 с обратно, урок ≈ $0,74.

const fs = require('fs');
const { WebSocket } = require('ws');

const list = (v) =>
    String(v || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);

const url = () => String(process.env.TRANSLATE_URL || '').trim();
const key = () => String(process.env.TRANSLATE_KEY || '').trim();
const model = () => String(process.env.TRANSLATE_MODEL || 'qwen3.8-livetranslate-flash-realtime').trim();
const rooms = () => new Set(list(process.env.TRANSLATE_ROOMS).map((s) => s.toLowerCase()));
// Языки, у которых поставщик умеет и голос, а не только текст (§3.1 TRANSLATE.md)
const VOICE_LANGS =
    'zh,en,ru,ar,de,fr,es,pt,id,it,ko,th,vi,ja,tr,hi,ms,nl,ur,nb,sv,da,he,fi,pl,is,cs,fil,fa';
const langs = () => new Set(list(process.env.TRANSLATE_LANGS || VOICE_LANGS));
const maxSec = () => Number(process.env.TRANSLATE_MAX_SEC || 1800);

const enabled = () => url().length > 0 && key().length > 0;
const allowedRoom = (roomId) => rooms().has(String(roomId || '').toLowerCase());

// Глоссарий у поставщика односторонний («источник → перевод»), поэтому для
// каждого направления свой. Без обратного термины остаются иероглифами прямо в
// русском тексте — проверено замером (TRANSLATE.md §10.1a).
let glossaries = null;
function glossaryFor(targetLang, log) {
    if (glossaries === null) {
        glossaries = {};
        const file = String(process.env.TRANSLATE_GLOSSARY || '').trim();
        if (file) {
            try {
                const spec = JSON.parse(fs.readFileSync(file, 'utf8'));
                glossaries = { zh: spec.glossary || null, ru: spec.glossary_zh || null };
            } catch (err) {
                log?.warn('[Translate] глоссарий не прочитан', { file, error: err.message });
            }
        }
    }
    return glossaries[targetLang] || null;
}

// На каком языке сказано — по письменности. Этого хватает: кириллица,
// иероглифы и латиница различаются надёжно, а английский с французским нам
// различать не нужно — они оба латиница и оба «не русский, не китайский».
//
// Зачем. Если говорящий перешёл на язык слушателя, переводить нечего, но
// поставщик всё равно может озвучить фразу заново, и она дублирует живую речь
// (заход 24.11: Иван объявил себя англоговорящим, перешёл на русский — и
// переводчик повторил его по-русски поверх). У Qwen для этого есть
// same_language_skip_options, но версия 3.8 его не поддерживает; у OpenAI
// такое поведение встроено.
function scriptOf(text) {
    const t = String(text || '');
    if (/[\u4e00-\u9fff]/.test(t)) return 'zh';
    if (/[\u0400-\u04ff]/.test(t)) return 'ru';
    if (/[A-Za-z]/.test(t)) return 'latin';
    return null;
}

const scriptForTarget = (target) => (target === 'zh' ? 'zh' : target === 'ru' ? 'ru' : 'latin');

// ---------- сессия с поставщиком ----------
//
// Одна на пару «говорящий → целевой язык». Держится открытой, пока участник в
// комнате: соединение само по себе не тарифицируется, а тишину поставщик
// отфильтровывает своим определением речи (TRANSLATE.md §3.1).

class Session {
    constructor({ roomId, fromId, fromName, target, log, onText, onVoice, onFail }) {
        this.roomId = roomId;
        this.fromId = fromId;
        this.fromName = fromName;
        this.target = target;
        this.log = log;
        this.onText = onText;
        this.onVoice = onVoice;
        this.onFail = onFail;

        this.ws = null;
        this.ready = false;
        this.closed = false;
        this.queued = [];
        this.sentSec = 0;
        this.openedAt = 0;
        this.reopenAt = 0;
        this.open();
    }

    open() {
        if (this.closed) return;
        // Не чаще раза в 5 с: у поставщика предел на число подключений в минуту
        const now = Date.now();
        if (now < this.reopenAt) return;
        this.reopenAt = now + 5000;
        this.openedAt = now;
        this.ready = false;

        let ws;
        try {
            ws = new WebSocket(`${url()}?model=${model()}`, { headers: { Authorization: `Bearer ${key()}` } });
        } catch (err) {
            this.log?.warn('[Translate] не удалось открыть сессию', { error: err.message });
            return;
        }
        this.ws = ws;

        ws.on('open', () => {
            const translation = { language: this.target };
            const g = glossaryFor(this.target, this.log);
            if (g) translation.corpus = { phrases: g };
            ws.send(JSON.stringify({ type: 'session.update', session: { output_modalities: ['text', 'audio'], translation } }));
        });

        ws.on('message', (buf) => {
            let m;
            try {
                m = JSON.parse(buf.toString());
            } catch {
                return;
            }
            switch (m.type) {
                case 'session.updated':
                    this.ready = true;
                    for (const chunk of this.queued.splice(0, this.queued.length)) this.push(chunk);
                    break;
                case 'conversation.item.input_audio_transcription.delta':
                case 'conversation.item.input_audio_transcription.completed': {
                    const text = m.transcript || m.delta || '';
                    if (!text) break;
                    const said = scriptOf(text);
                    if (said && said !== this.heardScript) {
                        this.heardScript = said;
                        this.log?.info('[Translate] язык говорящего', {
                            room: this.roomId,
                            target: this.target,
                            сказано: said,
                            дублировать: said === scriptForTarget(this.target) ? 'нет' : 'переводим',
                        });
                    }
                    if (m.type.endsWith('completed')) this.onText?.('heard', text);
                    break;
                }
                case 'response.audio_transcript.delta':
                    if (m.delta && !this.sameAsTarget()) this.onText?.('translated', m.delta);
                    break;
                case 'response.audio.delta':
                    if (m.delta && !this.sameAsTarget()) this.onVoice?.(m.delta);
                    break;
                case 'error':
                    this.log?.warn('[Translate] ошибка сессии', {
                        room: this.roomId,
                        target: this.target,
                        message: m.error?.message,
                    });
                    break;
                default:
                    break;
            }
        });

        // Обрыв — обычное дело: поставщик рвёт соединение, когда накопилось
        // много звука без смыслового результата. На музыкальном уроке с паузами
        // это основной сценарий, поэтому просто открываем заново (§3.1).
        const reopen = () => {
            if (this.closed) return;
            this.ready = false;
            this.ws = null;
            setTimeout(() => this.open(), 1000);
        };
        ws.on('close', reopen);
        ws.on('error', (err) => {
            this.log?.warn('[Translate] сессия отвалилась', { room: this.roomId, error: err.message });
            try {
                ws.close();
            } catch {
                /* уже закрыт */
            }
        });
    }

    // Говорят ли уже на языке слушателя. Пока ничего не услышали — переводим:
    // лучше лишняя фраза, чем проглоченная.
    sameAsTarget() {
        return this.heardScript !== null && this.heardScript === scriptForTarget(this.target);
    }

    push(b64) {
        if (this.closed) return;
        if (!this.ready || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
            // Копим немного, пока сессия поднимается: иначе теряется начало фразы
            if (this.queued.length < 50) this.queued.push(b64);
            return;
        }
        this.sentSec += (Buffer.byteLength(b64, 'base64') / 2 / 16000) || 0;
        if (this.sentSec > maxSec()) {
            this.onFail?.('limit');
            this.stop();
            return;
        }
        try {
            this.ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: b64 }));
        } catch (err) {
            this.log?.warn('[Translate] не отправилось', { error: err.message });
        }
    }

    stop() {
        if (this.closed) return;
        this.closed = true;
        const ws = this.ws;
        this.ws = null;
        if (!ws) return;
        try {
            // Закрывать сокет сразу нельзя: поставщик не узнает, что звук
            // кончился, и остаток перевода пропадёт.
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'session.finish' }));
            setTimeout(() => {
                try {
                    ws.close();
                } catch {
                    /* уже закрыт */
                }
            }, 500);
        } catch {
            /* уже закрыт */
        }
    }
}

// ---------- участники и комнаты ----------

const roomsState = new Map(); // roomId -> { peers: Map(socketId -> {lang, name}), sessions: Map(key -> Session), sec }

function stateOf(roomId) {
    if (!roomsState.has(roomId)) roomsState.set(roomId, { peers: new Map(), sessions: new Map(), sec: 0 });
    return roomsState.get(roomId);
}

// Кому нужен перевод речи этого участника: всем, у кого язык другой.
function targetsFor(st, fromId) {
    const from = st.peers.get(fromId);
    if (!from) return [];
    const out = new Set();
    for (const [id, p] of st.peers) if (id !== fromId && p.lang && p.lang !== from.lang) out.add(p.lang);
    return [...out];
}

function broadcastState(io, roomId) {
    const st = stateOf(roomId);
    const peers = [...st.peers.entries()].map(([id, p]) => ({ id, name: p.name, lang: p.lang }));
    for (const id of st.peers.keys()) {
        io.to(id).emit('translateState', {
            on: true,
            lang: st.peers.get(id).lang,
            peers,
            spentSec: Math.round(st.sec),
            presenter: !!st.peers.get(id).presenter,
        });
    }
}

function register({ io, socket, roomId, peerName, log, isPresenter }) {
    if (!enabled() || !allowedRoom(roomId)) return;

    socket.on('translateJoin', ({ lang } = {}, cb) => {
        const want = String(lang || '').trim();
        if (!langs().has(want)) {
            // Пустой язык — это проба «есть ли перевод в комнате». Отвечаем и
            // заодно говорим, ведущий ли спрашивает: от этого зависит, покажет
            // ли ему браузер управление за всех.
            return cb?.({ error: 'язык не разрешён', presenter: !!isPresenter?.() });
        }
        const st = stateOf(roomId);
        st.peers.set(socket.id, { lang: want, name: peerName, presenter: !!isPresenter?.() });
        log?.info('[Translate] участник включил перевод', { room: roomId, peer: peerName, lang: want });
        broadcastState(io, roomId);
        cb?.({ ok: true, lang: want });
    });

    socket.on('translateAudio', ({ audio } = {}) => {
        if (!audio) return;
        const st = stateOf(roomId);
        if (!st.peers.has(socket.id)) return;
        if (st.sec > maxSec()) return;

        const targets = targetsFor(st, socket.id);

        // Собеседник сменил язык — прежняя сессия больше не нужна. Раньше она
        // висела до таймаута поставщика («Response stream timeout», заход
        // 24.11) и зря занимала подключение.
        for (const [k, session] of st.sessions) {
            if (!k.startsWith(`${socket.id}->`)) continue;
            const target = k.slice(k.indexOf('->') + 2);
            if (!targets.includes(target)) {
                session.stop();
                st.sessions.delete(k);
                log?.info('[Translate] язык собеседника сменился, сессия закрыта', { room: roomId, target });
            }
        }

        for (const target of targets) {
            const sessionKey = `${socket.id}->${target}`;
            let session = st.sessions.get(sessionKey);
            if (!session) {
                session = new Session({
                    roomId,
                    fromId: socket.id,
                    fromName: peerName,
                    target,
                    log,
                    onText: (kind, text) => {
                        for (const [id, p] of st.peers) {
                            if (id !== socket.id && p.lang === target) {
                                io.to(id).emit('translateText', { from: peerName, kind, text });
                            }
                        }
                        // говорящему возвращаем только «что услышали»: по нему
                        // видно, правильно ли его разобрали
                        if (kind === 'heard') io.to(socket.id).emit('translateText', { from: peerName, kind, text });
                    },
                    onVoice: (b64) => {
                        for (const [id, p] of st.peers) {
                            if (id !== socket.id && p.lang === target) {
                                io.to(id).emit('translateVoice', { from: peerName, audio: b64 });
                            }
                        }
                    },
                    onFail: (reason) => {
                        log?.warn('[Translate] перевод выключен', { room: roomId, reason });
                        for (const id of st.peers.keys()) io.to(id).emit('translateState', { on: false, reason });
                    },
                });
                st.sessions.set(sessionKey, session);
            }
            session.push(audio);
        }
        st.sec += Buffer.byteLength(audio, 'base64') / 2 / 16000;
    });

    // Ведущий включает перевод за всех и выбирает язык каждому. На уроке у
    // педагога заняты руки, а студент может и не найти кнопку — поэтому всё
    // управление собрано у него (решение Ивана 24.11).
    // Параметр нарочно НЕ langs: так называется функция разрешённых языков
    // выше, и одноимённый параметр её затенял — «langs is not a function»,
    // перевод не включался вовсе (заход 24.11).
    socket.on('translateForAll', ({ on = true, langs: wanted = {} } = {}, cb) => {
        if (!isPresenter?.()) {
            log?.info('[Translate] не ведущий пытался включить перевод за всех', { room: roomId, peer: peerName });
            return cb?.({ error: 'только ведущий' });
        }
        const st = stateOf(roomId);
        const known = wanted && typeof wanted === 'object' ? wanted : {};

        if (!on) {
            for (const [, s] of st.sessions) s.stop();
            st.sessions.clear();
            const ids = [...st.peers.keys()];
            st.peers.clear();
            for (const id of ids) io.to(id).emit('translateState', { on: false, reason: 'ведущий выключил' });
            log?.info('[Translate] ведущий выключил перевод за всех', { room: roomId });
            return cb?.({ ok: true, on: false });
        }

        let set = 0;
        for (const [id, lang] of Object.entries(known)) {
            if (!langs().has(lang)) continue;
            const was = st.peers.get(id);
            st.peers.set(id, { lang, name: was?.name || '', presenter: !!was?.presenter });
            io.to(id).emit('translateTurnOn', { lang });
            set++;
        }
        broadcastState(io, roomId);
        log?.info('[Translate] ведущий включил перевод за всех', { room: roomId, участников: set });
        cb?.({ ok: true, on: true, set });
    });

    const leave = () => {
        const st = roomsState.get(roomId);
        if (!st || !st.peers.has(socket.id)) return;
        st.peers.delete(socket.id);
        for (const [k, s] of st.sessions) {
            if (k.startsWith(`${socket.id}->`)) {
                s.stop();
                st.sessions.delete(k);
            }
        }
        if (st.peers.size === 0) roomsState.delete(roomId);
        else broadcastState(io, roomId);
        log?.info('[Translate] участник вышел', { room: roomId, peer: peerName });
    };

    socket.on('translateLeave', leave);
    socket.on('disconnect', leave);
}

module.exports = { enabled, allowedRoom, register, maxSec, langs };
