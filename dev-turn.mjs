// Montemeet dev turn: сервер отдаёт клиенту адреса ретранслятора и временные
// учётные данные вместе с транспортом (app/src/MontemeetTurn.js, Room.js).
//
// Сценарии:
//   off     — ретранслятор не настроен: ответ такой же, как до правки;
//   on      — настроен: в ответе адреса, имя вида «срок:метка» и подпись,
//             которая сходится с общим секретом; личных данных в имени нет;
//   forced  — комната из TURN_FORCE_RELAY_ROOMS получает режим «только
//             ретранслятор», обычная комната — нет;
//   lobby   — ожидающему в зале ожидания транспорта и учётных данных не дают;
//   relay-flag — журнал метит ретранслированный вход по адресу И порту: адреса
//             мало, у участника из сети сервера он тот же.
//
// Скрипт сам поднимает отдельный сервер на :3014 со своим набором переменных и
// в конце гасит его. Комнаты spec-lesson, spec-music и spec-lobby должны быть в
// реестре стенда (Montemeet/app-spec/ENV.md).
//
// Запуск: node dev-turn.mjs [off|on|forced|lobby]   (по умолчанию все)

import crypto from 'node:crypto';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';

process.env.DOTENV_CONFIG_QUIET = 'true';

const PORT = 3014;
const BASE = `https://localhost:${PORT}`;
const SECRET = 'dev-turn-' + crypto.randomBytes(8).toString('hex');
const TTL = 120;
const URLS = 'turn:turn.example.test:3478?transport=udp,turn:turn.example.test:3478?transport=tcp';
const TIMEOUT = 8000;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- сырое соединение engine.io ----------

function open() {
    const url = BASE.replace(/^http/, 'ws') + '/socket.io/?EIO=4&transport=websocket';
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(url, { rejectUnauthorized: false });
        const acks = new Map();
        let next = 0;
        let sid = null;
        const api = {
            get sid() {
                return sid;
            },
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
            const m = s.match(/^43(\d+)(\[.*)$/s);
            if (m && acks.has(Number(m[1]))) {
                const res = acks.get(Number(m[1]));
                acks.delete(Number(m[1]));
                res(JSON.parse(m[2])[0]);
            }
        });
        ws.on('error', reject);
        setTimeout(() => reject(new Error('нет рукопожатия')), TIMEOUT);
    });
}

// вход и запрос транспорта: что сервер отдаёт клиенту
async function transportFor(room, name) {
    const c = await open();
    await c.emit('createRoom', { room_id: room }, true);
    const joined = await c.emit(
        'join',
        {
            room_id: room,
            peer_info: { peer_name: name, peer_id: c.sid, peer_uuid: 'turn-' + name, peer_audio: false, peer_video: false },
        },
        true
    );
    const res = await c.emit('createWebRtcTransport', {}, true);
    c.close();
    return { joined, res, sid: c.sid };
}

// ---------- свой сервер со своим набором переменных ----------

async function startServer(extra) {
    const env = {
        ...process.env,
        SERVER_LISTEN_PORT: String(PORT),
        SERVER_HOST_URL: BASE,
        SFU_MIN_PORT: '41200',
        SFU_MAX_PORT: '41300',
        TURN_URLS: '',
        TURN_SHARED_SECRET: '',
        TURN_TTL_SEC: '',
        TURN_FORCE_RELAY_ROOMS: '',
        TURN_RELAY_IP: '',
        ...extra,
    };
    const child = spawn(process.execPath, ['app/src/Server.js'], {
        cwd: import.meta.dirname,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const started = Date.now();
    while (Date.now() - started < 30000) {
        try {
            const res = await fetch(`${BASE}/config`);
            if (res.ok) return child;
        } catch (e) {
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

const results = [];
const check = (scenario, checks) => {
    const pass = Object.values(checks).every(Boolean);
    results.push({ scenario, pass, checks });
    console.log(`${pass ? '+' : '—'} ${scenario}`, JSON.stringify(checks));
};

// ---------- off: ретранслятор не настроен ----------

async function off() {
    const server = await startServer({});
    try {
        const { res } = await transportFor('spec-lesson', 'TurnOff' + Date.now().toString(36).slice(-3));
        check('off', {
            transportGiven: !!res && !!res.id && !!res.iceParameters,
            noIceServers: !('iceServers' in (res || {})),
            noPolicy: !('iceTransportPolicy' in (res || {})),
        });
    } finally {
        await stopServer(server);
    }
}

// ---------- on / forced: ретранслятор настроен ----------

async function onAndForced(which) {
    const server = await startServer({
        TURN_URLS: URLS,
        TURN_SHARED_SECRET: SECRET,
        TURN_TTL_SEC: String(TTL),
        TURN_FORCE_RELAY_ROOMS: 'spec-lesson',
        TURN_RELAY_IP: '192.168.35.11',
    });
    try {
        const name = 'TurnOn' + Date.now().toString(36).slice(-3);
        const plain = await transportFor('spec-music', name);
        const srv = plain.res?.iceServers?.[0];
        const [expiry, tag] = String(srv?.username || '').split(':');
        const signed = srv && crypto.createHmac('sha1', SECRET).update(srv.username).digest('base64');
        const left = Number(expiry) - Math.floor(Date.now() / 1000);
        if (which !== 'forced') {
            check('on', {
                bothUrls: Array.isArray(srv?.urls) && srv.urls.length === 2,
                usernameShape: !!expiry && !!tag && /^\d+$/.test(expiry),
                ttlAsAsked: left > TTL - 10 && left <= TTL,
                signatureMatches: !!srv && srv.credential === signed,
                noPersonalData: !!tag && !tag.includes(name),
                noPolicyInPlainRoom: !('iceTransportPolicy' in (plain.res || {})),
            });
        }
        if (which !== 'on') {
            const forcedRoom = await transportFor('spec-lesson', name + 'F');
            check('forced', {
                policyRelay: forcedRoom.res?.iceTransportPolicy === 'relay',
                serversGiven: !!forcedRoom.res?.iceServers?.length,
                plainRoomUntouched: !('iceTransportPolicy' in (plain.res || {})),
            });
        }
    } finally {
        await stopServer(server);
    }
}

// ---------- lobby: ожидающему учётных данных не дают ----------

async function lobby() {
    const server = await startServer({
        TURN_URLS: URLS,
        TURN_SHARED_SECRET: SECRET,
        TURN_TTL_SEC: String(TTL),
    });
    try {
        const { joined, res } = await transportFor('spec-lobby', 'TurnWait' + Date.now().toString(36).slice(-3));
        const text = JSON.stringify(res || {});
        check('lobby', {
            inLobby: joined === 'isLobby' || joined === 'lobby' || res?.error === 'In lobby',
            noTransport: !res?.id,
            noCredentials: !text.includes('credential') && !text.includes('iceServers'),
        });
    } finally {
        await stopServer(server);
    }
}

// ---------- relay-flag: метка ретранслированного входа ----------
//
// Отдельный сценарий без сервера: считать вход ретранслированным по одному
// адресу нельзя — у участника из сети сервера (и у пробного браузера на самом
// Борисе) адрес тот же. Проверяем, что отличает порт.

async function relayFlag() {
    const { default: turn } = await import('./app/src/MontemeetTurn.js');
    const prevIp = process.env.TURN_RELAY_IP;
    const prevPorts = process.env.TURN_RELAY_PORTS;
    process.env.TURN_RELAY_IP = '192.168.35.11';
    process.env.TURN_RELAY_PORTS = '61000-61999';
    try {
        check('relay-flag', {
            relayPortMarked: turn.isRelayed('192.168.35.11', 61123) === true,
            sameIpOtherPortNot: turn.isRelayed('192.168.35.11', 54321) === false,
            otherIpNot: turn.isRelayed('10.0.0.5', 61123) === false,
            noPortNot: turn.isRelayed('192.168.35.11', undefined) === false,
        });
    } finally {
        process.env.TURN_RELAY_IP = prevIp ?? '';
        process.env.TURN_RELAY_PORTS = prevPorts ?? '';
    }
}

// ---------- запуск ----------

const only = process.argv[2];
const all = { off, on: () => onAndForced('on'), forced: () => onAndForced('forced'), lobby, 'relay-flag': relayFlag };

if (only && !all[only]) {
    console.error('Сценарии: ' + Object.keys(all).join(', '));
    process.exit(2);
}

const run = only ? [only] : Object.keys(all);
for (const name of run) {
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
