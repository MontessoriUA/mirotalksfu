// Montemeet: журнал событий комнат (app/src/MontemeetEvents.js) — в читаемую
// ленту урока, по местному времени.
//
//   node dev-events.mjs <комната> [YYYY-MM-DD]          — из каталога журнала
//   ssh boris cat /var/lib/montemeet/events/2026-09-11.ndjson | node dev-events.mjs <комната> -
//
// Каталог: MONTEMEET_EVENTS_DIR, иначе ./montemeet-events (как у сервера на деве).
// Без комнаты — все комнаты дня.

import fs from 'node:fs';
import path from 'node:path';

const [roomArg, dayArg] = process.argv.slice(2);
const room = roomArg && roomArg !== '-' && roomArg !== '*' ? roomArg : null;
const fromStdin = dayArg === '-' || roomArg === '-';
const day = !fromStdin && dayArg ? dayArg : new Date().toLocaleDateString('sv');
const DIR = process.env.MONTEMEET_EVENTS_DIR || path.join(import.meta.dirname, 'montemeet-events');

const text = fromStdin ? fs.readFileSync(0, 'utf-8') : fs.readFileSync(path.join(DIR, `${day}.ndjson`), 'utf-8');

const HOW = {
    exit: 'вышел сам',
    'transport close': 'закрыл вкладку или пропала сеть',
    'ping timeout': 'связь пропала молча',
    'server namespace disconnect': 'выгнали',
    'client namespace disconnect': 'сокет закрыт страницей',
    'transport error': 'ошибка связи',
};
const ROLE = { teacher: 'педагог', student: 'студент' };
const MEDIA = { mic: 'микрофон', cam: 'камера', screen: 'экран', pcsound: 'звук компьютера', audio: 'звук', video: 'видео' };
const m = (x) => MEDIA[x] || x || '?';
const kv = (o, skip) =>
    Object.entries(o)
        .filter(([k, v]) => !skip.includes(k) && v !== null && v !== undefined)
        .map(([k, v]) => `${k}=${v}`)
        .join(' ');

function line(e) {
    const p = e.peer || '';
    switch (e.ev) {
        case 'room-open':
            return '── комната открылась';
        case 'room-close':
            return '── комната опустела';
        case 'join': {
            const role = ROLE[e.role] || e.role || '';
            const via = e.via ? ` (${e.via})` : '';
            const lobby = e.lobby ? ' · в зале ожидания' : '';
            return `ВХОД   ${p} — ${role}${via}${lobby} · ${e.dev || '?'} · ${e.os || '?'} · ${e.br || '?'} · мик ${e.mic ? 'вкл' : 'выкл'}, кам ${e.cam ? 'вкл' : 'выкл'} · сеть ${e.net || '?'}`;
        }
        case 'join-failed':
            return `ВХОД НЕ СОСТОЯЛСЯ ${p} · ${e.dev || '?'} · ${e.br || '?'}`;
        case 'leave':
            return `ВЫХОД  ${p} — ${HOW[e.how] || e.how}`;
        case 'lobby-admitted':
            return `       ${p} впущен из зала ожидания`;
        case 'lobby-accept':
            return `       ${p} впустил: ${(e.to || []).join(', ')}`;
        case 'lobby-reject':
            return `       ${p} отклонил: ${(e.to || []).join(', ')}`;
        case 'mic-on':
        case 'mic-off':
        case 'cam-on':
        case 'cam-off': {
            const [what, st] = e.ev.split('-');
            return `       ${p}: ${what === 'mic' ? 'микрофон' : 'камера'} ${st === 'on' ? 'включил' : 'выключил'}`;
        }
        case 'send-start':
            return `       ${p} → сервер: ${m(e.media)}${e.paused ? ' (на паузе)' : ''}`;
        case 'send-pause':
            return `       ${p} → сервер: ${m(e.media)} на паузе`;
        case 'send-resume':
            return `       ${p} → сервер: ${m(e.media)} снова идёт`;
        case 'send-stop':
            return `       ${p} → сервер: ${m(e.media)} закрыт`;
        case 'send-poor':
            return `!!     ${p} → сервер: ${m(e.media)} идёт плохо (оценка ${e.score})`;
        case 'send-ok':
            return `       ${p} → сервер: ${m(e.media)} выровнялся (оценка ${e.score})`;
        case 'receive':
            return `       ${p} ← ${e.from}: ${m(e.media)}`;
        case 'receive-pause':
            return `       ${p} ← ${e.from}: ${m(e.media)} приостановлен получателем`;
        case 'receive-resume':
            return `       ${p} ← ${e.from}: ${m(e.media)} снова принимается`;
        case 'receive-poor':
            return `!!     ${p}: приём звука плохой (оценка ${e.score})`;
        case 'receive-ok':
            return `       ${p}: приём звука выровнялся (оценка ${e.score})`;
        case 'link':
            return `СВЯЗЬ  ${p} ${e.dir === 'recv' ? 'приём' : 'передача'}: ice=${e.ice} dtls=${e.dtls}${e.proto ? ' ' + e.proto : ''}${e.via ? ' через ' + e.via : ''}${e.net ? ' из ' + e.net : ''}`;
        case 'end-for-all':
            return `!!     ${p} ЗАВЕРШИЛ ДЛЯ ВСЕХ`;
        case 'peer-action':
            return `       ${p} → ${e.to}: ${e.action}`;
        case 'audio':
            return (
                'ЗВУК   ' +
                Object.entries(e.peers || {})
                    .map(([name, a]) => {
                        const parts = [`мик ${a.mic}`];
                        if (a.mic !== 'none') parts.push(`слышно ${a.heard ?? 0}с`);
                        if (a.peak !== undefined) parts.push(`пик ${a.peak} дБ`);
                        if (a.kbps !== undefined) parts.push(`${a.kbps} кбит/с`);
                        if (a.rx) parts.push(`принимает ${a.rx}${a.rxScore !== undefined ? ` (оценка ${a.rxScore})` : ''}`);
                        return `${name}: ${parts.join(', ')}`;
                    })
                    .join(' | ')
            );
        case 'device':
            return `УСТР   ${p}: ${e.what} ${kv(e, ['t', 'room', 'ev', 'peer', 'what'])}`;
        default:
            return `${e.ev} ${kv(e, ['t', 'room', 'ev'])}`;
    }
}

const records = [];
for (const raw of text.split('\n')) {
    if (!raw.trim()) continue;
    try {
        const e = JSON.parse(raw);
        if (!room || e.room === room) records.push(e);
    } catch (err) {
        /* битая строка — пропускаем */
    }
}
// по комнатам в порядке появления; внутри — по времени: вход сервер
// записывает чуть позже, чем он случился
const byRoom = new Map();
for (const e of records) {
    if (!byRoom.has(e.room)) byRoom.set(e.room, []);
    byRoom.get(e.room).push(e);
}
for (const [name, list] of byRoom) {
    list.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
    if (!room) console.log(`\n=== ${name}`);
    for (const e of list) {
        const time = new Date(e.t).toLocaleTimeString('ru-RU', { hour12: false });
        console.log(`${time}  ${line(e)}`);
    }
}
