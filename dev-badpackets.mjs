// Montemeet dev bad packets: сервер должен пережить кривые пакеты socket.io.
//
// Стоковые обработчики зовут функцию подтверждения на любой ветке и разбирают
// данные без проверок. Пакет без подтверждения (голый `exitRoom`) или без
// данных валил синхронный обработчик, исключение доходило до
// `uncaughtException`, и процесс останавливался со всеми идущими уроками
// (Иван, 2026-09-16). Защита — обёртка обработчиков в `Server.js` сразу после
// создания `io`. Этот набор её и проверяет.
//
// Разговариваем с сервером напрямую по engine.io, без браузера: так пакет можно
// послать ровно такой, какой шлёт злонамеренный или просто кривой клиент.
//
// Запуск (сервер должен быть поднят):
//   node dev-badpackets.mjs
//   MM_TEST_BASE=https://192.168.35.11 node dev-badpackets.mjs
//
// Итог: список случаев и «сервер жив» / «СЕРВЕР УПАЛ» по каждому.

import { WebSocket } from 'ws';

const BASE = process.env.MM_TEST_BASE || 'https://localhost:3010';
const WS = BASE.replace(/^http/, 'ws') + '/socket.io/?EIO=4&transport=websocket';
const ROOM = process.env.MM_TEST_ROOM || 'montemeet-badpackets';
const TIMEOUT = 8000;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- сырое соединение engine.io ----------

function open() {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(WS, { rejectUnauthorized: false });
        const acks = new Map();
        let ackId = 0;
        let sid = null;
        const done = (err) => (err ? reject(err) : resolve(api));
        const api = {
            ws,
            get sid() {
                return sid;
            },
            // 42["событие", данные…] — с подтверждением или без
            emit(event, data, wantAck = false) {
                if (ws.readyState !== WebSocket.OPEN) throw new Error('соединение закрыто');
                const args = data === undefined ? [event] : [event, data];
                if (!wantAck) return ws.send('42' + JSON.stringify(args));
                const id = ackId++;
                const wait = new Promise((res, rej) => {
                    acks.set(id, res);
                    setTimeout(() => acks.has(id) && (acks.delete(id), rej(new Error('ответа нет'))), TIMEOUT);
                });
                ws.send('42' + id + JSON.stringify(args));
                return wait;
            },
            // сырой кадр: тут можно послать и то, чего клиентская библиотека не умеет
            raw(frame) {
                ws.send(frame);
            },
            close() {
                try {
                    ws.close();
                } catch (e) {
                    /* уже закрыт */
                }
            },
        };
        ws.on('message', (buf) => {
            const s = buf.toString();
            if (s === '2') return ws.send('3'); // ping → pong
            if (s.startsWith('0')) return ws.send('40'); // открыли engine.io → входим в пространство имён
            if (s.startsWith('40')) {
                try {
                    sid = JSON.parse(s.slice(2)).sid;
                } catch (e) {
                    sid = null;
                }
                return done();
            }
            const m = s.match(/^43(\d+)(\[.*)$/s); // подтверждение
            if (m && acks.has(Number(m[1]))) {
                const res = acks.get(Number(m[1]));
                acks.delete(Number(m[1]));
                try {
                    res(JSON.parse(m[2])[0]);
                } catch (e) {
                    res(null);
                }
            }
        });
        ws.on('error', (err) => done(err));
        setTimeout(() => done(new Error('сервер не ответил на рукопожатие')), TIMEOUT);
    });
}

// Сервер жив, если отвечает по HTTP и принимает новое соединение.
// Комнату для проверки не заводим: у `createRoom` лимит 10 в минуту с адреса
// (Server.js:212-230), и проверки сами себя бы им и заблокировали.
async function serverAlive() {
    try {
        const res = await fetch(BASE + '/config', { signal: AbortSignal.timeout(TIMEOUT) });
        if (!res.ok) return false;
        const c = await open();
        c.close();
        return true;
    } catch (e) {
        return false;
    }
}

// У `createRoom` лимит 10 в минуту с адреса: держим темп ниже него, иначе
// сервер начнёт отказывать во входе и проверки станут врать
const createdAt = [];
async function createRoomPaced(c, room_id) {
    const LIMIT = 9;
    for (;;) {
        const now = Date.now();
        while (createdAt.length && now - createdAt[0] > 60000) createdAt.shift();
        if (createdAt.length < LIMIT) break;
        const wait = 60000 - (now - createdAt[0]) + 200;
        console.log(`   … ждём ${Math.ceil(wait / 1000)} с: лимит createRoom`);
        await delay(wait);
    }
    createdAt.push(Date.now());
    return c.emit('createRoom', { room_id }, true);
}

// Участник комнаты: часть обработчиков раньше падала только у вошедшего
async function joined(name) {
    const c = await open();
    await createRoomPaced(c, ROOM);
    const res = await c.emit(
        'join',
        {
            room_id: ROOM,
            peer_info: {
                peer_name: name,
                peer_id: c.sid, // сервер сверяет его с socket.id
                peer_uuid: 'badpackets-' + name,
                peer_presenter: false,
                peer_audio: false,
                peer_video: false,
            },
        },
        true
    );
    if (typeof res === 'string') throw new Error('вход отклонён: ' + res);
    return c;
}

// ---------- случаи ----------

const CASES = [
    {
        name: 'голый exitRoom (без данных и без подтверждения)',
        joinFirst: false,
        run: (c) => c.emit('exitRoom'),
    },
    {
        name: 'exitRoom у участника комнаты',
        joinFirst: true,
        run: (c) => c.emit('exitRoom'),
    },
    {
        name: 'getRouterRtpCapabilities без подтверждения',
        joinFirst: true,
        run: (c) => c.emit('getRouterRtpCapabilities'),
    },
    {
        name: 'producerClosed без данных',
        joinFirst: true,
        run: (c) => c.emit('producerClosed'),
    },
    {
        name: 'file без данных',
        joinFirst: true,
        run: (c) => c.emit('file'),
    },
    {
        name: 'roomLobby без данных',
        joinFirst: true,
        run: (c) => c.emit('roomLobby'),
    },
    {
        name: 'updateRoomNotifications без подтверждения',
        joinFirst: true,
        run: (c) => c.emit('updateRoomNotifications', { room_id: ROOM, notifications: true }),
    },
    {
        name: 'updatePeerInfo без данных',
        joinFirst: true,
        run: (c) => c.emit('updatePeerInfo'),
    },
    {
        name: 'cmd без данных',
        joinFirst: true,
        run: (c) => c.emit('cmd'),
    },
    {
        name: 'peerAction без данных',
        joinFirst: true,
        run: (c) => c.emit('peerAction'),
    },
    {
        name: 'roomAction без данных',
        joinFirst: true,
        run: (c) => c.emit('roomAction'),
    },
    {
        name: 'setConsumerPreferredLayers без данных',
        joinFirst: true,
        run: (c) => c.emit('setConsumerPreferredLayers'),
    },
    {
        name: 'join без данных',
        joinFirst: false,
        run: (c) => c.emit('join'),
    },
    {
        name: 'createRoom без данных',
        joinFirst: false,
        run: (c) => c.emit('createRoom'),
    },
    {
        name: 'produce без appData',
        joinFirst: true,
        run: (c) => c.emit('produce', { producerTransportId: 'нет такого', kind: 'audio', rtpParameters: {} }),
    },
    {
        name: 'mmDiag без данных',
        joinFirst: true,
        run: (c) => c.emit('mmDiag'),
    },
    {
        name: 'событие с мусором вместо данных',
        joinFirst: true,
        run: (c) => c.emit('getRoomInfo', 'не объект'),
    },
    {
        name: 'кадр с неизвестным событием',
        joinFirst: false,
        run: (c) => c.raw('42["нет-такого-события",{"a":1}]'),
    },
];

// ---------- прогон ----------

console.log('Сервер:', BASE, '· комната:', ROOM);
if (!(await serverAlive())) {
    console.error('Сервер недоступен ещё до проверок — поднимите его и повторите.');
    process.exit(2);
}

let failed = 0;
for (const [i, test] of CASES.entries()) {
    let peer = null;
    try {
        peer = test.joinFirst ? await joined('bad' + i) : await open();
    } catch (err) {
        console.log(`${String(i + 1).padStart(2)}. ${test.name}: подготовка не удалась — ${err.message}`);
        failed++;
        continue;
    }
    try {
        await test.run(peer);
    } catch (err) {
        // отказ самого запроса — не беда, важно, что сервер жив
    }
    await delay(400);
    peer.close();
    const alive = await serverAlive();
    console.log(`${String(i + 1).padStart(2)}. ${test.name}: ${alive ? 'сервер жив' : 'СЕРВЕР УПАЛ'}`);
    if (!alive) {
        failed++;
        break; // дальше проверять нечего
    }
}

// после всей череды обычный вход должен работать как ни в чём не бывало
let normal = false;
try {
    const c = await joined('normal');
    const info = await c.emit('getRoomInfo', {}, true);
    normal = !!info && typeof info.peers === 'string';
    await c.emit('exitRoom', {}, true);
    c.close();
} catch (err) {
    console.log('Обычный вход после проверок не удался:', err.message);
}
console.log(`Обычный вход после всех кривых пакетов: ${normal ? 'работает' : 'НЕ РАБОТАЕТ'}`);

const ok = failed === 0 && normal;
console.log(ok ? 'ИТОГ: все случаи пройдены' : `ИТОГ: провалов ${failed + (normal ? 0 : 1)}`);
process.exit(ok ? 0 : 1);
