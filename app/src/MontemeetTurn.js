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
//   TURN_RELAY_IP            адрес ретранслятора со стороны сервера встреч —
//                            по нему журнал отмечает ретранслированные входы

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

// Пришёл ли участник через наш ретранслятор: у пары кандидатов его адрес.
function isRelayed(remoteIp) {
    const ip = relayIp();
    return !!ip && !!remoteIp && remoteIp === ip;
}

module.exports = { enabled, credentials, forPeer, isRelayed, relayIp, ttlSec, urls };
