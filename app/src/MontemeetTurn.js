'use strict';

// Montemeet: ретранслятор медиа (TURN). Сервер выдаёт клиенту адреса
// ретранслятора и временные учётные данные в том же ответе, что и транспорт.
// Постоянных паролей нет: данные считаются по общему секрету (TURN REST API) и
// живут TURN_TTL_SEC секунд. Описание и обоснование — Montemeet/app-spec/TURN.md.
//
// Ключи .env (пустой TURN_URLS — поле iceServers не отдаётся, всё как до
// ретранслятора):
//   TURN_URLS                адреса через запятую, например
//                            turn:turn.meet.montessori.ua:3478?transport=udp
//   TURN_SHARED_SECRET       общий секрет, он же static-auth-secret у coturn
//   TURN_TTL_SEC             срок учётных данных, по умолчанию 43200 (12 ч)
//   TURN_FORCE_RELAY_ROOMS   комнаты, где медиа идёт только через ретранслятор
//                            (для проверки; обычным комнатам не задавать)
//   TURN_RELAY_IP            адрес ретранслятора со стороны сервера встреч
//   TURN_RELAY_PORTS         его порты ретрансляции, «начало-конец» (по умолчанию
//                            61000-61999 — как min-port и max-port у coturn).
//                            По адресу и порту журнал отмечает вход через
//                            ретранслятор

const crypto = require('crypto');

const TTL_DEFAULT = 43200;
const TAG_MAX = 12;

const list = (value) =>
    String(value || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);

const urls = () => list(process.env.TURN_URLS);
const secret = () => String(process.env.TURN_SHARED_SECRET || '');
const relayIp = () => String(process.env.TURN_RELAY_IP || '').trim();

// Порты ретрансляции: адреса мало — у участника из той же сети (или у пробного
// браузера на самом сервере) адрес совпадает с адресом ретранслятора, и вход
// помечался бы ретранслированным зря. Порт же у ретранслятора всегда свой.
function relayPorts() {
    const m = String(process.env.TURN_RELAY_PORTS || '61000-61999').match(/^(\d+)\s*-\s*(\d+)$/);
    if (!m) return null;
    const from = Number(m[1]);
    const to = Number(m[2]);
    return from > 0 && to >= from ? { from, to } : null;
}

function ttlSec() {
    const n = parseInt(process.env.TURN_TTL_SEC, 10);
    return Number.isFinite(n) && n > 0 ? n : TTL_DEFAULT;
}

function enabled() {
    return urls().length > 0 && secret().length > 0;
}

// Имя пользователя видно в журнале ретранслятора, поэтому в нём только срок и
// короткая метка участника — без имени, почты и прочего личного.
function credentials(tag) {
    const username = `${Math.floor(Date.now() / 1000) + ttlSec()}:${String(tag || '').slice(0, TAG_MAX)}`;
    const credential = crypto.createHmac('sha1', secret()).update(username).digest('base64');
    return { username, credential };
}

function forcedRooms() {
    return new Set(list(process.env.TURN_FORCE_RELAY_ROOMS).map((s) => s.toLowerCase()));
}

// То, что уходит клиенту вместе с транспортом. mediasoup-client передаёт эти
// поля дальше в RTCPeerConnection, правок клиента не нужно.
function forPeer(roomId, tag) {
    if (!enabled()) return {};
    const out = { iceServers: [{ urls: urls(), ...credentials(tag) }] };
    if (forcedRooms().has(String(roomId || '').toLowerCase())) out.iceTransportPolicy = 'relay';
    return out;
}

// Пришёл ли участник через наш ретранслятор: у пары кандидатов его адрес и
// порт из диапазона ретрансляции.
function isRelayed(remoteIp, remotePort) {
    const ip = relayIp();
    const ports = relayPorts();
    if (!ip || !ports || !remoteIp || remoteIp !== ip) return false;
    const port = Number(remotePort);
    return Number.isFinite(port) && port >= ports.from && port <= ports.to;
}

module.exports = { enabled, credentials, forPeer, isRelayed, relayIp, relayPorts, ttlSec, urls };
