// Montemeet dev translate room: перевод внутри комнаты, а не в обход неё.
//
// Проверяет второй, тихий канал (app/src/MontemeetTranslate.js, вариант Б из
// Montemeet/app-spec/TRANSLATE.md §6): участник отдаёт копию своего звука, а
// перевод приходит ТОЛЬКО тому, у кого язык другой.
//
// Сценарии:
//   off        — поставщик не настроен: событий перевода нет вовсе, комната
//                работает как раньше;
//   room       — комната не в списке разрешённых: перевод не включается;
//   pair       — двое с разными языками: говорящему возвращается «что услышали»,
//                слушателю — перевод текстом и голосом;
//   same-lang  — у обоих один язык: сессия не открывается и деньги не тратятся;
//   same-speech — говорящий перешёл на язык слушателя: перевод не дублирует
//             его живую речь;
//   lobby      — ожидающему в зале перевод не дают.
//
// Сценарий pair ходит к настоящему поставщику и тратит несколько секунд звука
// (доли цента). Остальные денег не стоят.
//
// Скрипт сам поднимает сервер со своим набором переменных. Нужен ключ:
//   TRANSLATE_QWEN_KEY в .env стенда.
//
// Запуск: node dev-translate-room.mjs [off|room|pair|same-lang|lobby]

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';

process.env.DOTENV_CONFIG_QUIET = 'true';
try {
    process.loadEnvFile(path.join(import.meta.dirname, '.env'));
} catch {
    /* .env может не быть */
}

// По умолчанию поднимаем свой сервер. Против боевого — MM_TEST_BASE и
// MM_TEST_ROOM (там сценарии off/room/lobby пропускаются: чужие настройки не
// трогаем, проверяем только сквозной перевод).
const PORT = 3016;
const EXTERNAL = String(process.env.MM_TEST_BASE || '').trim();
const BASE = EXTERNAL || `https://localhost:${PORT}`;
const ROOM = String(process.env.MM_TEST_ROOM || 'spec-lesson').trim();
const TIMEOUT = 8000;
const HERE = import.meta.dirname;
const PHRASES = process.env.TRANSLATE_PHRASES || path.resolve(HERE, '..', 'Montemeet', 'app-spec', 'translate-phrases');

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- сырое соединение engine.io ----------

function open() {
    const url = BASE.replace(/^http/, 'ws') + '/socket.io/?EIO=4&transport=websocket';
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(url, { rejectUnauthorized: false });
        const acks = new Map();
        const events = [];
        const waiters = [];
        let next = 0;
        let sid = null;
        const api = {
            get sid() {
                return sid;
            },
            events,
            emit(event, data, wantAck = false) {
                const args = data === undefined ? [event] : [event, data];
                if (!wantAck) return ws.send('42' + JSON.stringify(args));
                const id = next++;
                ws.send('42' + id + JSON.stringify(args));
                return new Promise((res, rej) => {
                    acks.set(id, res);
                    setTimeout(() => acks.has(id) && (acks.delete(id), rej(new Error('ответа нет'))), TIMEOUT);
                });
            },
            // ждём событие с именем name не дольше ms
            wait(name, ms = 12000) {
                const found = events.find((e) => e.name === name);
                if (found) return Promise.resolve(found.data);
                return new Promise((res) => {
                    const w = { name, res };
                    waiters.push(w);
                    setTimeout(() => {
                        const i = waiters.indexOf(w);
                        if (i >= 0) waiters.splice(i, 1);
                        res(null);
                    }, ms);
                });
            },
            close: () => ws.close(),
        };
        ws.on('message', (buf) => {
            const s = buf.toString();
            if (s === '2') return ws.send('3');
            if (s.startsWith('0')) return ws.send('40');
            if (s.startsWith('40')) {
                sid = JSON.parse(s.slice(2)).sid;
                return resolve(api);
            }
            const ack = s.match(/^43(\d+)(\[.*)$/s);
            if (ack && acks.has(Number(ack[1]))) {
                const res = acks.get(Number(ack[1]));
                acks.delete(Number(ack[1]));
                return res(JSON.parse(ack[2])[0]);
            }
            const ev = s.match(/^42(\[.*)$/s);
            if (ev) {
                const [name, data] = JSON.parse(ev[1]);
                events.push({ name, data });
                for (let i = waiters.length - 1; i >= 0; i--) {
                    if (waiters[i].name === name) {
                        waiters[i].res(data);
                        waiters.splice(i, 1);
                    }
                }
            }
        });
        ws.on('error', reject);
        setTimeout(() => reject(new Error('нет рукопожатия')), TIMEOUT);
    });
}

async function join(room, name) {
    const c = await open();
    await c.emit('createRoom', { room_id: room }, true);
    const joined = await c.emit(
        'join',
        {
            room_id: room,
            peer_info: {
                peer_name: name,
                peer_id: c.sid,
                peer_uuid: 'tr-' + name,
                peer_audio: false,
                peer_video: false,
            },
        },
        true
    );
    return { c, joined };
}

// ---------- сервер ----------

async function startServer(extra) {
    if (EXTERNAL) return null; // работаем против уже запущенного сервера
    const env = {
        ...process.env,
        SERVER_LISTEN_PORT: String(PORT),
        SERVER_HOST_URL: BASE,
        SFU_MIN_PORT: '41400',
        SFU_MAX_PORT: '41500',
        TRANSLATE_URL: '',
        TRANSLATE_KEY: '',
        TRANSLATE_ROOMS: '',
        TRANSLATE_GLOSSARY: '',
        ...extra,
    };
    const child = spawn(process.execPath, ['app/src/Server.js'], { cwd: HERE, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const started = Date.now();
    while (Date.now() - started < 30000) {
        try {
            const res = await fetch(`${BASE}/config`);
            if (res.ok) return child;
        } catch {
            /* ещё не поднялся */
        }
        if (child.exitCode !== null) break;
        await delay(500);
    }
    child.kill('SIGKILL');
    throw new Error('сервер не поднялся: ' + out.slice(-400));
}

async function stopServer(child) {
    if (!child || child.exitCode !== null) return;
    child.kill('SIGTERM');
    for (let i = 0; i < 20 && child.exitCode === null; i++) await delay(250);
    if (child.exitCode === null) child.kill('SIGKILL');
}

const live = {
    TRANSLATE_URL: process.env.TRANSLATE_QWEN_URL || 'wss://ap-southeast-1.maas.qwencloudapi.com/api-ws/v1/realtime',
    TRANSLATE_MODEL: process.env.TRANSLATE_QWEN_MODEL || 'qwen3.8-livetranslate-flash-realtime',
    TRANSLATE_KEY: process.env.TRANSLATE_QWEN_KEY || '',
    TRANSLATE_ROOMS: ROOM,
    TRANSLATE_GLOSSARY: path.join(PHRASES, 'phrases.json'),
};

const results = [];
const check = (scenario, checks) => {
    const pass = Object.values(checks).every(Boolean);
    results.push({ scenario, pass, checks });
    console.log(`${pass ? '+' : '—'} ${scenario}`, JSON.stringify(checks));
};

// ---------- звук для проверки ----------

function pcmChunks(id = 'piano-03') {
    const file = path.join(PHRASES, 'audio', '16k-live', `${id}.wav`);
    const fallback = path.join(PHRASES, 'audio', '16k', `${id}.wav`);
    const use = fs.existsSync(file) ? file : fallback;
    const b = fs.readFileSync(use);
    let pos = 12;
    let pcm = null;
    while (pos + 8 <= b.length) {
        const name = b.toString('ascii', pos, pos + 4);
        const size = b.readUInt32LE(pos + 4);
        if (name === 'data') {
            pcm = b.subarray(pos + 8, Math.min(pos + 8 + size, b.length));
            break;
        }
        pos += 8 + size + (size % 2);
    }
    if (!pcm) throw new Error('нет звука для проверки: ' + use);
    const frame = 3200; // 100 мс при 16 кГц
    const out = [];
    for (let i = 0; i < pcm.length; i += frame) out.push(pcm.subarray(i, i + frame).toString('base64'));
    return out;
}

// ---------- сценарии ----------

async function off() {
    const server = await startServer({});
    try {
        const { c } = await join(ROOM, 'TrOff');
        const ans = await c.emit('translateJoin', { lang: 'ru' }, true).catch(() => 'нет ответа');
        await delay(500);
        check('off', {
            serverAlive: true,
            noHandler: ans === 'нет ответа',
            noState: !c.events.some((e) => e.name.startsWith('translate')),
        });
        c.close();
    } finally {
        await stopServer(server);
    }
}

async function room() {
    const server = await startServer({ ...live, TRANSLATE_ROOMS: 'другая-комната' });
    try {
        const { c } = await join(ROOM, 'TrRoom');
        const ans = await c.emit('translateJoin', { lang: 'ru' }, true).catch(() => 'нет ответа');
        check('room', { notAllowed: ans === 'нет ответа' });
        c.close();
    } finally {
        await stopServer(server);
    }
}

async function pair() {
    if (!live.TRANSLATE_KEY) {
        check('pair', { ключЕсть: false });
        console.error('    нет TRANSLATE_QWEN_KEY в .env — сценарий пропущен');
        return;
    }
    const server = await startServer(live);
    try {
        const a = await join(ROOM, 'TrRu');
        const b = await join(ROOM, 'TrZh');
        const ra = await a.c.emit('translateJoin', { lang: 'ru' }, true);
        const rb = await b.c.emit('translateJoin', { lang: 'zh' }, true);

        const chunks = pcmChunks();
        for (const ch of chunks) {
            a.c.emit('translateAudio', { audio: ch });
            await delay(100);
        }
        // Тишину шлём непрерывно, как это делает живой микрофон: поставщик
        // закрывает фразу по тишине, и без потока он её не закроет вовсе.
        const silence = Buffer.alloc(3200).toString('base64');
        const keepAlive = setInterval(() => a.c.emit('translateAudio', { audio: silence }), 100);

        const text = await b.c.wait('translateText', 14000);
        const voice = await b.c.wait('translateVoice', 14000);
        // «Что услышали» приходит в конце фразы, позже первого куска перевода,
        // поэтому ждём отдельно, а не смотрим накопленное.
        const findHeard = () => a.c.events.find((e) => e.name === 'translateText' && e.data?.kind === 'heard');
        for (let i = 0; i < 60 && !findHeard(); i++) await delay(200);
        const heardBySpeaker = findHeard();
        const speakerGotVoice = a.c.events.some((e) => e.name === 'translateVoice');

        clearInterval(keepAlive);
        check('pair', {
            обаВключились: ra?.ok === true && rb?.ok === true,
            слушательПолучилТекст: !!text,
            слушательПолучилГолос: !!voice,
            говорящемуВернулиУслышанное: !!heardBySpeaker,
            говорящемуНеШлютГолос: !speakerGotVoice,
        });
        if (text) console.log(`    слушателю: ${text.kind} «${String(text.text).slice(0, 60)}»`);
        if (heardBySpeaker) console.log(`    говорящему: услышано «${String(heardBySpeaker.data.text).slice(0, 60)}»`);
        a.c.close();
        b.c.close();
    } finally {
        await stopServer(server);
    }
}

// Говорящий перешёл на язык слушателя: переводить нечего, и дублировать его
// живую речь нельзя (заход 24.11). У Qwen своего выключателя для этого нет —
// глушим сами, по письменности транскрипта.
async function sameSpeech() {
    if (!live.TRANSLATE_KEY) {
        check('same-speech', { ключЕсть: false });
        return;
    }
    const server = await startServer(live);
    try {
        const a = await join(ROOM, 'TrEn');
        const b = await join(ROOM, 'TrRu2');
        // A объявил себя англоговорящим, но говорит по-русски — как Иван,
        // когда переключился на язык собеседницы
        await a.c.emit('translateJoin', { lang: 'en' }, true);
        await b.c.emit('translateJoin', { lang: 'ru' }, true);

        const chunks = pcmChunks('piano-03'); // русская фраза
        for (const ch of chunks) {
            a.c.emit('translateAudio', { audio: ch });
            await delay(100);
        }
        const silence = Buffer.alloc(3200).toString('base64');
        const keepAlive = setInterval(() => a.c.emit('translateAudio', { audio: silence }), 100);
        await delay(12000);
        clearInterval(keepAlive);

        // Проверяем только одно: живую речь не дублируют. Транскрипт тут
        // требовать нельзя — на чистой речи целевого языка поставщик молчит
        // сам и не присылает вообще ничего (замер 24.11).
        check('same-speech', {
            слушателюНеДублируют:
                !b.c.events.some((e) => e.name === 'translateVoice') &&
                !b.c.events.some((e) => e.name === 'translateText' && e.data?.kind === 'translated'),
        });
        console.log('    события говорящего:', a.c.events.map((e) => e.name + (e.data?.kind ? '/' + e.data.kind : '')).join(', ') || 'нет');
        console.log('    события слушателя: ', b.c.events.map((e) => e.name + (e.data?.kind ? '/' + e.data.kind : '')).join(', ') || 'нет');
        a.c.close();
        b.c.close();
    } finally {
        await stopServer(server);
    }
}

async function sameLang() {
    const server = await startServer(live);
    try {
        const a = await join(ROOM, 'TrOne');
        const b = await join(ROOM, 'TrTwo');
        await a.c.emit('translateJoin', { lang: 'ru' }, true);
        await b.c.emit('translateJoin', { lang: 'ru' }, true);
        const chunks = pcmChunks();
        for (const ch of chunks.slice(0, 10)) {
            a.c.emit('translateAudio', { audio: ch });
            await delay(100);
        }
        await delay(2500);
        check('same-lang', {
            переводНеШлют: !b.c.events.some((e) => e.name === 'translateText' || e.name === 'translateVoice'),
        });
        a.c.close();
        b.c.close();
    } finally {
        await stopServer(server);
    }
}

async function lobby() {
    const server = await startServer({ ...live, TRANSLATE_ROOMS: 'spec-lobby' });
    try {
        const { c, joined } = await join('spec-lobby', 'TrWait');
        const ans = await c.emit('translateJoin', { lang: 'ru' }, true).catch(() => 'нет ответа');
        check('lobby', {
            вЗалеОжидания: joined === 'isLobby' || joined === 'lobby' || joined?.error === 'In lobby',
            переводНеДают: ans === 'нет ответа' || !!ans?.error,
        });
        c.close();
    } finally {
        await stopServer(server);
    }
}

// ---------- запуск ----------

const all = { off, room, pair, 'same-lang': sameLang, 'same-speech': sameSpeech, lobby };
const only = process.argv[2];
if (only && !all[only]) {
    console.error('Сценарии: ' + Object.keys(all).join(', '));
    process.exit(2);
}

const plan = only ? [only] : EXTERNAL ? ['pair', 'same-speech'] : Object.keys(all);
if (EXTERNAL) console.log(`против боевого: ${BASE}, комната ${ROOM} — только сценарий pair\n`);
for (const name of plan) {
    try {
        await all[name]();
    } catch (err) {
        check(name, { ошибка: false });
        console.error('   ', err.message);
    }
}

const failed = results.filter((r) => !r.pass);
console.log(`\nсценариев: ${results.length} | прошли: ${results.length - failed.length}`);
process.exit(failed.length ? 1 : 0);
