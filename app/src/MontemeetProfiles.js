'use strict';

/*
 * Montemeet: room profile registry.
 *
 * Maps room names to presets that the client applies as defaults
 * (audio capture constraints, Opus params; layout presets come later).
 * Data lives in montemeet-profiles.json at the repo root (see the
 * .template.json next to it); the file is re-read when its mtime changes,
 * so the future host cabinet can edit it without a server restart.
 */

const fs = require('fs');
const path = require('path');
const Logger = require('./Logger');

const log = new Logger('MontemeetProfiles');

const PROFILES_PATH = process.env.MONTEMEET_PROFILES_PATH || path.join(__dirname, '../../montemeet-profiles.json');

const BUILTIN = {
    profiles: {
        music: {
            audio: {
                echoCancellation: true,
                autoGainControl: false,
                noiseSuppression: false,
                opusDtx: false,
                opusMaxAverageBitrate: 128000,
            },
        },
        default: { audio: null },
    },
    rooms: {},
};

let cache = { mtimeMs: -1, data: null };

function load() {
    try {
        const stat = fs.statSync(PROFILES_PATH);
        if (!cache.data || stat.mtimeMs !== cache.mtimeMs) {
            cache = { mtimeMs: stat.mtimeMs, data: JSON.parse(fs.readFileSync(PROFILES_PATH, 'utf-8')) };
            log.info('Room profiles loaded', { path: PROFILES_PATH, rooms: Object.keys(cache.data.rooms || {}) });
        }
    } catch (err) {
        if (!cache.data) {
            cache = { mtimeMs: -1, data: BUILTIN };
            log.warn('No readable montemeet-profiles.json, using built-in defaults', { path: PROFILES_PATH });
        }
    }
    return cache.data;
}

function forRoom(roomId) {
    const {
        profiles = {},
        rooms = {},
        presenters = {},
        roomOverrides = {},
        devicePriority = null,
        googleClientId = null,
        style = null,
    } = load() || {};
    const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

    const profileName = has(rooms, roomId) ? rooms[roomId] : has(rooms, '*') ? rooms['*'] : 'default';
    const profile = has(profiles, profileName) ? profiles[profileName] : null;

    return {
        name: profile ? profileName : 'default',
        audio: (profile && profile.audio) || null,
        layout: (profile && profile.layout) || null,
        roles: (profile && profile.roles) || null,
        // deterministic presenter: the room's teacher by NAME (cabinet-managed)
        presenterName: has(presenters, roomId) ? presenters[roomId] : null,
        // per-room teacher switches (client cares about blurSelf; the rest is applied server-side)
        overrides: has(roomOverrides, roomId) ? roomOverrides[roomId] : null,
        devicePriority, // installation-wide (e.g. SplitCam on school computers)
        googleClientId: googleClientId || null, // One Tap name prefill (optional)
        style: style || null, // conference appearance, forced identically on everyone
    };
}

// cabinet policy -> stock room moderator flag(s); the stock client already
// exempts the presenter from moderator rules and from the lobby
const POLICY_TO_MODERATOR = {
    startMutedAll: ['audio_start_muted'],
    startHiddenAll: ['video_start_hidden'],
    privacyAll: ['video_start_privacy'],
    cantUnmute: ['audio_cant_unmute'],
    cantUnhide: ['video_cant_unhide'],
    screenShareStudentsOff: ['screen_cant_share'],
    chatPrivateOff: ['chat_cant_privately'],
    chatPublicOff: ['chat_cant_publicly'],
    aiOff: ['chat_cant_chatgpt', 'chat_cant_deep_seek'],
    pollsOff: ['polls_cant_create'],
    mediaShareOff: ['media_cant_sharing'],
};

function isLessonRoom(roomId) {
    const { profiles = {}, rooms = {} } = load() || {};
    const profileName = Object.prototype.hasOwnProperty.call(rooms, roomId) ? rooms[roomId] : null;
    const profile = profileName ? profiles[profileName] : null;
    return !!(profile && profile.roles === 'lesson');
}

// seed a freshly created Room with cabinet policies + the teacher's switches.
// Lessons only: concerts run their own rules, unmanaged rooms stay stock.
function applyToRoom(room, roomId) {
    if (!isLessonRoom(roomId)) return false;
    const { roomOverrides = {}, lessonPolicies = {} } = load() || {};
    for (const [policy, flags] of Object.entries(POLICY_TO_MODERATOR)) {
        if (lessonPolicies[policy]) for (const flag of flags) room._moderator[flag] = true;
    }
    const ov = roomOverrides[roomId];
    if (ov) {
        if (ov.startMuted) room._moderator.audio_start_muted = true;
        if (ov.startHidden) room._moderator.video_start_hidden = true;
        if (ov.lobby) room._isLobbyEnabled = true;
    }
    log.debug('Montemeet room policies applied', { roomId, moderator: room._moderator, lobby: room._isLobbyEnabled });
    return true;
}

function endsOnTeacherLeave(roomId) {
    const { lessonPolicies = {} } = load() || {};
    return !!lessonPolicies.endOnTeacherLeave && isLessonRoom(roomId);
}

// The single link: one URL for everyone. The teacher is recognised by the email
// their SSO login puts in the request, so no separate secret address is needed.
// Deliberately NOT part of forRoom(): that object is served to every visitor at
// GET /profile/:roomId, and the teacher's address has no business being public.
function isPresenterEmail(roomId, email) {
    if (!email) return false;
    const { presenterEmails = {}, admins = [], rooms = {} } = load() || {};
    const who = String(email).trim().toLowerCase();
    // Админ школы — педагог в любой ИЗВЕСТНОЙ комнате: он заходит к коллегам
    // помочь, подменить, посмотреть, и понижать его там до участника незачем
    // (Иван, 2026-08-12). Список приходит из кабинета вместе с остальным
    // реестром, так что снятый админ теряет это в тот же миг.
    //
    // Оговорка про «известную» дорого досталась: билет с испорченным слагом увёл
    // админа в несуществующую комнату, и права там у него всё равно оказались —
    // из-за чего ошибка выглядела успешным входом (Иван, 2026-08-13).
    const known = Object.prototype.hasOwnProperty.call(rooms, roomId);
    if (known && admins.some((a) => String(a).toLowerCase() === who)) return true;
    const expected = presenterEmails[roomId];
    return !!expected && expected.toLowerCase() === who;
}

// Есть ли у комнаты SSO-владелец. Если есть, имя перестаёт быть пропуском в
// педагоги: вход по логину и по ссылке из кабинета никуда не делись, а
// назваться чужим именем больше не значит получить права.
function hasPresenterEmail(roomId) {
    const { presenterEmails = {} } = load() || {};
    return !!presenterEmails[roomId];
}

// Пропуск педагога от кабинета.
//
// Роль держалась на одном заголовке от SSO, который проставляется при каждом
// рукопожатии сокета. Стоит сессии на миг оказаться недействительной — при
// переподключении, после сна вкладки, по истечении сессии — и педагог посреди
// урока молча становился студентом (Иван, 2026-08-10, Safari).
//
// Кабинет и конференция живут на одном адресе, поэтому кабинет кладёт в куку
// подписанный пропуск: комната, почта и срок. Кука HttpOnly, в адресной строке
// её нет — ни прочитать со страницы, ни переслать одноклассникам. Почту из
// пропуска всё равно сверяем с реестром, так что снятый в кабинете педагог
// теряет права сразу, не дожидаясь конца срока.
const crypto = require('crypto');
const GRANT_COOKIE = 'mm_grant';

function grantSecret() {
    return process.env.MONTEMEET_GRANT_SECRET || '';
}

function readCookie(cookieHeader, name) {
    for (const part of String(cookieHeader || '').split(';')) {
        const eq = part.indexOf('=');
        if (eq < 0) continue;
        if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
    }
    return null;
}

function emailFromGrant(cookieHeader, roomId) {
    const secret = grantSecret();
    if (!secret) return null;
    const raw = readCookie(cookieHeader, GRANT_COOKIE);
    if (!raw) return null;
    const dot = raw.lastIndexOf('.');
    if (dot < 1) return null;
    const body = raw.slice(0, dot);
    const sig = raw.slice(dot + 1);
    const expected = crypto.createHmac('sha256', secret).update(body).digest('base64url');
    // сравнение постоянного времени: длины могут не совпасть, поэтому сначала они
    if (sig.length !== expected.length) return null;
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    let payload;
    try {
        payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf-8'));
    } catch (e) {
        return null;
    }
    if (!payload || payload.r !== roomId || !(payload.x > Date.now())) return null;
    return payload.e || null;
}

module.exports = {
    forRoom,
    applyToRoom,
    endsOnTeacherLeave,
    isLessonRoom,
    isPresenterEmail,
    hasPresenterEmail,
    emailFromGrant,
};
