'use strict';

// Montemeet: журнал событий комнат.
//
// Жалобу «меня не было слышно» по прежним логам разобрать было нельзя: сервер на
// рабочем уровне не пишет ни входов, ни того, кто что передаёт. На уроке Олены
// Ступак (06.09.2026) это стоило целого вечера догадок по логам nginx — и ответа
// так и не дало (Иван, 2026-09-11). Здесь ровно то, чего не хватило, по нашим
// комнатам: кто вошёл, с какого устройства и в какой роли; когда включил и
// выключил микрофон и камеру; кто чей поток получает и в каком качестве; обрывы,
// зал ожидания, «завершить для всех»; и что сообщило о себе само устройство
// (public/js/MontemeetDiag.js). Раз в 30 секунд — сводка звука по комнате: кто
// сколько говорил, насколько громко и с каким битрейтом шёл поток.
//
// Как и журнал сессий, в стоковые обработчики не вмешивается: состояние снимается
// опросом того, что сервер и так держит (участники, их транспорты, продюсеры,
// консьюмеры), а события сокета — собственными слушателями рядом со стоковыми.
//
// Файлы — по дню (NDJSON), старше 30 дней удаляются сами: чтение одного урока не
// тянет месяц записей, а на сервере не нужно настраивать ротацию.

const fs = require('fs');
const path = require('path');
const profiles = require('./MontemeetProfiles');

const DIR =
    process.env.MONTEMEET_EVENTS_DIR ||
    (process.env.MONTEMEET_JOURNAL_FILE
        ? path.join(path.dirname(process.env.MONTEMEET_JOURNAL_FILE), 'events')
        : path.join(__dirname, '../../montemeet-events'));
const KEEP_DAYS = 30;
const POLL_MS = 2000;
const AUDIO_EVERY_MS = 30000;
const JOIN_SETTLE_MS = 1500; // стоковый вход асинхронный — даём ему закончить
const POOR_SCORE = 3; // оценка качества mediasoup 0..10: ниже — поток рвётся
const OK_SCORE = 7;
const DIAG_PER_MINUTE = 60;

const MEDIA = { audioType: 'mic', videoType: 'cam', screenType: 'screen', audioTab: 'pcsound' };

let roomList = null;
let logger = console;
const rooms = new Map(); // roomId -> состояние, которое мы видели в прошлый опрос

// ---------- запись ----------

let stream = null;
let streamDay = null;

function dayOf(ms) {
    return new Date(ms).toLocaleDateString('sv'); // YYYY-MM-DD по времени сервера
}

// at — когда событие случилось, если записываем его позже (вход пишется, когда
// сток его закончил, а время у него — момент входа)
function write(roomId, rec, at) {
    try {
        const now = at || Date.now();
        const day = dayOf(Date.now());
        if (day !== streamDay) {
            if (stream) stream.end();
            stream = fs.createWriteStream(path.join(DIR, `${day}.ndjson`), { flags: 'a' });
            stream.on('error', (err) => logger.error('Montemeet events write failed', err.message));
            streamDay = day;
        }
        stream.write(JSON.stringify({ t: new Date(now).toISOString(), room: roomId, ...rec }) + '\n');
    } catch (err) {
        logger.error('Montemeet events write failed', err.message);
    }
}

function prune() {
    try {
        const oldest = dayOf(Date.now() - KEEP_DAYS * 86400000);
        for (const name of fs.readdirSync(DIR)) {
            const m = /^(\d{4}-\d{2}-\d{2})\.ndjson$/.exec(name);
            if (m && m[1] < oldest) fs.rmSync(path.join(DIR, name), { force: true });
        }
    } catch (err) {
        logger.error('Montemeet events prune failed', err.message);
    }
}

// ---------- мелочи ----------

// адрес без последнего октета: сменил ли человек сеть (Wi-Fi → мобильный),
// видно и так, а точный адрес журналу ни к чему
function maskIp(ip) {
    const s = String(ip || '').replace(/^::ffff:/, '');
    if (/^\d+\.\d+\.\d+\.\d+$/.test(s)) return s.replace(/\.\d+$/, '.x');
    if (s.includes(':')) return s.split(':').slice(0, 4).join(':') + '::';
    return s || null;
}

function short(id) {
    return id ? String(id).slice(0, 6) : null;
}

function peerName(peer) {
    return peer?.peer_name || peer?.peer_info?.peer_name || '?';
}

function socketIp(socket) {
    const fwd = socket.handshake?.headers?.['x-forwarded-for'];
    return fwd ? String(fwd).split(',')[0].trim() : socket.handshake?.address;
}

function bestScore(scores) {
    // у продюсера — по оценке на каждую кодировку (simulcast), берём лучшую
    if (!Array.isArray(scores) || !scores.length) return null;
    return Math.max(...scores.map((s) => s.score));
}

function managed(roomId) {
    try {
        return !!roomId && profiles.isManagedRoom(roomId);
    } catch (e) {
        return false;
    }
}

// ---------- сокет: то, чего в состоянии сервера не видно ----------

// действия, на которые у стока есть право только у ведущего: чужие он молча
// отбрасывает — и журналу незачем их записывать
function teacherOf(socket) {
    const peer = roomList.get(socket.room_id)?.peers?.get(socket.id);
    return peer?.peer_info?.peer_presenter ? peer : null;
}

function attachSocket(socket) {
    socket.on('join', (data) => {
        socket._mmLeft = false;
        const at = Date.now();
        setTimeout(() => logJoin(socket, data, at), JOIN_SETTLE_MS);
    });

    socket.on('exitRoom', () => logLeave(socket, 'exit'));
    socket.on('disconnect', (reason) => logLeave(socket, reason));

    socket.on('cmd', (data) => {
        if (data?.type !== 'ejectAll' || !managed(socket.room_id)) return;
        const teacher = teacherOf(socket);
        if (teacher) write(socket.room_id, { ev: 'end-for-all', peer: peerName(teacher) });
    });

    socket.on('peerAction', (data) => {
        if (!data?.action || !managed(socket.room_id)) return;
        const teacher = teacherOf(socket);
        if (!teacher) return;
        const target = roomList.get(socket.room_id)?.peers?.get(data.peer_id);
        write(socket.room_id, {
            ev: 'peer-action',
            action: String(data.action).slice(0, 20),
            peer: peerName(teacher),
            to: target ? peerName(target) : String(data.to_peer_name || '?').slice(0, 60),
        });
    });

    socket.on('roomLobby', (data) => {
        if (!managed(socket.room_id)) return;
        const status = String(data?.lobby_status || '');
        if (status !== 'accept' && status !== 'reject') return;
        const teacher = teacherOf(socket);
        if (!teacher) return;
        const room = roomList.get(socket.room_id);
        const ids = Array.isArray(data.peers_id) ? data.peers_id : [data.peer_id];
        write(socket.room_id, {
            ev: status === 'accept' ? 'lobby-accept' : 'lobby-reject',
            peer: peerName(teacher),
            to: ids.map((id) => peerName(room?.peers?.get(id))).slice(0, 20),
        });
    });

    // что сообщает о себе само устройство (MontemeetDiag): только известные виды
    // и только простые значения — журнал не должен становиться чужим блокнотом
    let budget = DIAG_PER_MINUTE;
    const refill = setInterval(() => (budget = DIAG_PER_MINUTE), 60000);
    if (refill.unref) refill.unref();
    socket.on('disconnect', () => clearInterval(refill));
    socket.on('mmDiag', (data) => {
        if (!managed(socket.room_id) || budget <= 0) return;
        budget--;
        const rec = sanitizeDiag(data);
        if (!rec) return;
        const peer = roomList.get(socket.room_id)?.peers?.get(socket.id);
        write(socket.room_id, { ev: 'device', peer: peerName(peer), ...rec });
    });
}

const DIAG_TYPES = new Set([
    'info', // как устройство себя определило
    'gum-error', // браузер не дал микрофон/камеру
    'gum-fallback', // занятое устройство подменили свободным
    'track', // система заглушила или отпустила захват (iOS при уходе в фон)
    'visibility', // вкладка скрыта / вернулась
    'autoplay-blocked', // браузер не дал играть звук без касания
]);

function sanitizeDiag(data) {
    if (!data || typeof data !== 'object' || !DIAG_TYPES.has(data.type)) return null;
    const out = { what: data.type };
    let n = 0;
    for (const [k, v] of Object.entries(data)) {
        if (k === 'type' || k === 't' || n >= 10 || !/^[a-z]{1,16}$/i.test(k)) continue;
        if (typeof v === 'string') out[k] = v.slice(0, 80);
        else if (typeof v === 'number' || typeof v === 'boolean' || v === null) out[k] = v;
        else continue;
        n++;
    }
    return out;
}

function logJoin(socket, data, at) {
    const roomId = socket.room_id;
    if (!managed(roomId)) return;
    const peer = roomList.get(roomId)?.peers?.get(socket.id);
    const info = peer?.peer_info || data?.peer_info || {};
    const teacher = !!peer?.peer_info?.peer_presenter;
    const dev = info.is_mobile_device
        ? 'phone'
        : info.is_tablet_device
          ? 'tablet'
          : info.is_desktop_device
            ? 'computer'
            : null;
    write(roomId, {
        ev: peer ? 'join' : 'join-failed',
        peer: info.peer_name || '?',
        role: peer ? (teacher ? 'teacher' : 'student') : null,
        via: teacher ? roleSource(socket, roomId, info) : undefined,
        lobby: peer ? !!peer.peer_lobby : undefined,
        dev,
        os: [info.os_name, info.os_version].filter(Boolean).join(' ') || null,
        br: [info.browser_name, info.browser_version].filter(Boolean).join(' ') || null,
        mic: !!info.peer_audio,
        cam: !!info.peer_video,
        net: maskIp(socketIp(socket)),
        sid: short(socket.id),
        uuid: short(info.peer_uuid),
    }, at);
}

// откуда у педагога роль — от этого зависит, переживёт ли он переподключение
function roleSource(socket, roomId, info) {
    try {
        const headers = socket.handshake?.headers || {};
        if (profiles.isPresenterEmail(roomId, headers['x-forwarded-email'])) return 'sso';
        if (profiles.isPresenterEmail(roomId, profiles.emailFromGrant(headers.cookie, roomId))) return 'pass';
        if (info.peer_token) return 'token';
        return 'name';
    } catch (e) {
        return null;
    }
}

function logLeave(socket, how) {
    if (socket._mmLeft || !managed(socket.room_id)) return;
    socket._mmLeft = true;
    const peer = roomList.get(socket.room_id)?.peers?.get(socket.id);
    const seen = rooms.get(socket.room_id)?.peers?.get(socket.id);
    if (!peer && !seen) return; // не вошёл — нечего и закрывать
    // 'exit' — человек сам вышел; 'transport close' — закрыл вкладку или пропала
    // сеть; 'ping timeout' — связь пропала молча; 'server namespace disconnect' —
    // выгнали
    write(socket.room_id, { ev: 'leave', peer: peer ? peerName(peer) : seen.name, how: String(how).slice(0, 40) });
}

// ---------- опрос состояния ----------

function roomState(roomId) {
    let rs = rooms.get(roomId);
    if (!rs) {
        rs = { peers: new Map(), levels: new Map(), levelObs: null, audioAt: Date.now() };
        rooms.set(roomId, rs);
        write(roomId, { ev: 'room-open' });
    }
    return rs;
}

// громкость по продюсерам: наблюдатель комнаты шлёт её раз в 100 мс для тех,
// кто громче -70 дБ, — копим «сколько секунд был слышен» и пик
function hookLevels(room, rs) {
    const obs = room.audioLevelObserver;
    if (!obs || rs.levelObs === obs) return;
    rs.levelObs = obs;
    obs.on('volumes', (volumes) => {
        for (const { producer, volume } of volumes || []) {
            const a = rs.levels.get(producer.id) || { ticks: 0, max: -127 };
            a.ticks++;
            if (volume > a.max) a.max = volume;
            rs.levels.set(producer.id, a);
        }
    });
}

function ownerOf(room, producerId) {
    for (const peer of room.peers.values()) {
        const p = peer.producers?.get(producerId);
        if (p) return { name: peerName(peer), media: MEDIA[p.appData?.mediaType] || p.kind };
    }
    return { name: '?', media: null };
}

function poll() {
    for (const [roomId, room] of roomList.entries()) {
        if (!room || !room.peers || !managed(roomId)) continue;
        try {
            pollRoom(roomId, room);
        } catch (err) {
            logger.error('Montemeet events poll failed', { roomId, error: err.message });
        }
    }
    for (const roomId of rooms.keys()) {
        if (!roomList.has(roomId)) {
            rooms.delete(roomId);
            write(roomId, { ev: 'room-close' });
        }
    }
}

function pollRoom(roomId, room) {
    const rs = roomState(roomId);
    hookLevels(room, rs);
    const present = new Set();

    for (const [sid, peer] of room.peers.entries()) {
        present.add(sid);
        const name = peerName(peer);
        let ps = rs.peers.get(sid);
        if (!ps) {
            ps = {
                name,
                lobby: !!peer.peer_lobby,
                mic: !!peer.peer_audio,
                cam: !!peer.peer_video,
                producers: new Map(),
                consumers: new Map(),
                transports: new Map(),
                rxPoor: false,
                rxLow: 0,
            };
            rs.peers.set(sid, ps);
        }

        if (ps.lobby && !peer.peer_lobby) write(roomId, { ev: 'lobby-admitted', peer: name });
        ps.lobby = !!peer.peer_lobby;

        // кнопки микрофона и камеры — так, как их видит сам человек
        const mic = !!peer.peer_audio;
        const cam = !!peer.peer_video;
        if (mic !== ps.mic) write(roomId, { ev: mic ? 'mic-on' : 'mic-off', peer: name });
        if (cam !== ps.cam) write(roomId, { ev: cam ? 'cam-on' : 'cam-off', peer: name });
        ps.mic = mic;
        ps.cam = cam;

        pollProducers(roomId, peer, ps, name);
        pollConsumers(roomId, room, peer, ps, name);
        pollTransports(roomId, peer, ps, name);
    }

    for (const sid of rs.peers.keys()) if (!present.has(sid)) rs.peers.delete(sid);

    if (Date.now() - rs.audioAt >= AUDIO_EVERY_MS) {
        rs.audioAt = Date.now();
        summarizeAudio(roomId, room, rs);
    }
}

function pollProducers(roomId, peer, ps, name) {
    const alive = new Set();
    for (const [pid, p] of peer.producers.entries()) {
        if (p.closed) continue;
        alive.add(pid);
        const media = MEDIA[p.appData?.mediaType] || p.kind;
        const score = bestScore(p.score);
        let st = ps.producers.get(pid);
        if (!st) {
            st = { media, paused: p.paused, poor: false, low: 0 };
            ps.producers.set(pid, st);
            write(roomId, { ev: 'send-start', peer: name, media, paused: p.paused || undefined });
        } else if (st.paused !== p.paused) {
            write(roomId, { ev: p.paused ? 'send-pause' : 'send-resume', peer: name, media });
            st.paused = p.paused;
        }
        // качество ОТ человека к серверу: два опроса подряд плохо — пишем
        if (score !== null && !p.paused) {
            if (score <= POOR_SCORE) {
                if (++st.low >= 2 && !st.poor) {
                    st.poor = true;
                    write(roomId, { ev: 'send-poor', peer: name, media, score });
                }
            } else {
                st.low = 0;
                if (st.poor && score >= OK_SCORE) {
                    st.poor = false;
                    write(roomId, { ev: 'send-ok', peer: name, media, score });
                }
            }
        }
    }
    for (const [pid, st] of ps.producers.entries()) {
        if (alive.has(pid)) continue;
        ps.producers.delete(pid);
        write(roomId, { ev: 'send-stop', peer: name, media: st.media });
    }
}

function pollConsumers(roomId, room, peer, ps, name) {
    let worst = null;
    for (const [cid, c] of peer.consumers.entries()) {
        if (c.closed) continue;
        let st = ps.consumers.get(cid);
        if (!st) {
            const owner = ownerOf(room, c.producerId);
            st = { from: owner.name, media: owner.media, paused: c.paused };
            ps.consumers.set(cid, st);
            write(roomId, { ev: 'receive', peer: name, from: st.from, media: st.media });
        } else if (st.paused !== c.paused) {
            // пауза со стороны получателя: сток так глушит невидимые плитки
            write(roomId, { ev: c.paused ? 'receive-pause' : 'receive-resume', peer: name, from: st.from, media: st.media });
            st.paused = c.paused;
        }
        // качество ОТ сервера к человеку — по звуку, он важнее всего
        const score = c.score?.score;
        if (c.kind === 'audio' && !c.paused && !c.producerPaused && typeof score === 'number') {
            worst = worst === null ? score : Math.min(worst, score);
        }
    }
    for (const cid of ps.consumers.keys()) if (!peer.consumers.has(cid)) ps.consumers.delete(cid);

    if (worst === null) return;
    if (worst <= POOR_SCORE) {
        if (++ps.rxLow >= 2 && !ps.rxPoor) {
            ps.rxPoor = true;
            write(roomId, { ev: 'receive-poor', peer: name, score: worst });
        }
    } else {
        ps.rxLow = 0;
        if (ps.rxPoor && worst >= OK_SCORE) {
            ps.rxPoor = false;
            write(roomId, { ev: 'receive-ok', peer: name, score: worst });
        }
    }
}

function pollTransports(roomId, peer, ps, name) {
    const recvIds = new Set([...peer.consumers.values()].map((c) => c.appData?.consumerTransportId).filter(Boolean));
    for (const [tid, t] of peer.transports.entries()) {
        if (t.closed) continue;
        const tuple = t.iceSelectedTuple;
        // через какой из наших адресов пришёл клиент (при нескольких линиях это
        // важно); адрес прослушивания «любой» ничего не говорит — его не пишем
        const local = tuple?.localAddress || tuple?.localIp || null;
        const now = {
            dir: recvIds.has(tid) ? 'recv' : 'send',
            ice: t.iceState,
            dtls: t.dtlsState,
            proto: tuple?.protocol || null,
            via: local && !/^(0\.0\.0\.0|::)$/.test(local) ? local : null,
            net: tuple ? maskIp(tuple.remoteIp) : null,
        };
        const was = ps.transports.get(tid);
        // направление выясняется только с первым консьюмером — его смену не пишем
        const changed = !was || was.ice !== now.ice || was.dtls !== now.dtls || was.proto !== now.proto || was.net !== now.net;
        ps.transports.set(tid, now);
        if (!changed || (!was && now.ice === 'new')) continue;
        write(roomId, { ev: 'link', peer: name, ...now });
    }
    for (const tid of ps.transports.keys()) if (!peer.transports.has(tid)) ps.transports.delete(tid);
}

// сводка звука: кто слышен, сколько секунд за полминуты, пик и битрейт потока
function summarizeAudio(roomId, room, rs) {
    const levels = rs.levels;
    rs.levels = new Map();
    const jobs = [];
    const peers = {};
    for (const peer of room.peers.values()) {
        const name = peerName(peer);
        const mic = [...peer.producers.values()].find((p) => !p.closed && p.appData?.mediaType === 'audioType');
        const entry = { mic: mic ? (mic.paused ? 'paused' : 'on') : 'none' };
        if (mic) {
            const lv = levels.get(mic.id);
            entry.heard = lv ? Math.round(lv.ticks) / 10 : 0; // секунды громче -70 дБ
            if (lv) entry.peak = lv.max;
            jobs.push(
                mic
                    .getStats()
                    .then((stats) => {
                        const rtp = (stats || []).find((s) => s.type === 'inbound-rtp');
                        if (rtp && typeof rtp.bitrate === 'number') entry.kbps = Math.round(rtp.bitrate / 1000);
                    })
                    .catch(() => {})
            );
        }
        const audioIn = [...peer.consumers.values()].filter((c) => !c.closed && c.kind === 'audio');
        if (audioIn.length) {
            entry.rx = audioIn.length;
            const scores = audioIn.map((c) => c.score?.score).filter((s) => typeof s === 'number');
            if (scores.length) entry.rxScore = Math.min(...scores);
        }
        peers[name] = entry;
    }
    if (!Object.keys(peers).length) return;
    const timeout = new Promise((r) => setTimeout(r, 1500));
    Promise.race([Promise.all(jobs), timeout]).then(() => write(roomId, { ev: 'audio', peers }));
}

// ---------- чтение ----------

// события за день (по времени сервера); room — только одной комнаты
function read({ day, room } = {}) {
    const d = /^\d{4}-\d{2}-\d{2}$/.test(String(day || '')) ? day : dayOf(Date.now());
    let text = '';
    try {
        text = fs.readFileSync(path.join(DIR, `${d}.ndjson`), 'utf-8');
    } catch (err) {
        return [];
    }
    const out = [];
    for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
            const rec = JSON.parse(line);
            if (!room || rec.room === room) out.push(rec);
        } catch (err) {}
    }
    // вход записывается чуть позже, чем случился, — ставим его на место
    return out.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
}

function start({ io, roomList: list, log } = {}) {
    if (roomList || !io || !list) return;
    roomList = list;
    if (log) logger = log;
    try {
        fs.mkdirSync(DIR, { recursive: true });
    } catch (err) {
        logger.error('Montemeet events dir failed', err.message);
        return;
    }
    prune();
    const pruneTimer = setInterval(prune, 6 * 3600000);
    if (pruneTimer.unref) pruneTimer.unref();
    io.on('connection', attachSocket);
    const timer = setInterval(poll, POLL_MS);
    if (timer.unref) timer.unref();
}

module.exports = { start, read };
