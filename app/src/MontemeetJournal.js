'use strict';

// Montemeet: session journal.
// Polls roomList instead of hooking join/leave paths — zero merge friction with upstream.
// A session = a continuous stretch where the room has at least one peer (15s resolution,
// closed after two consecutive empty polls so short reconnects don't split a lesson).
// Closed sessions are appended to an NDJSON file; reads are on demand (cabinet traffic is tiny).

const fs = require('fs');
const path = require('path');

const FILE = process.env.MONTEMEET_JOURNAL_FILE || path.join(__dirname, '../../montemeet-journal.ndjson');
const POLL_MS = 15000;
const EMPTY_TICKS_TO_CLOSE = 2;

const active = new Map(); // roomId -> { startedAt, peak, emptyTicks }
let timer = null;
let logger = console;

function start(roomList, log) {
    if (timer) return;
    if (log) logger = log;
    timer = setInterval(() => {
        try {
            tick(roomList);
        } catch (err) {
            logger.error('Montemeet journal tick failed', err.message);
        }
    }, POLL_MS);
    if (timer.unref) timer.unref();
}

function tick(roomList) {
    const now = Date.now();
    const counts = new Map();
    for (const [roomId, room] of roomList.entries()) {
        const count = room && room.peers ? room.peers.size : 0;
        if (count > 0) counts.set(roomId, count);
    }
    for (const [roomId, count] of counts.entries()) {
        const s = active.get(roomId);
        if (!s) {
            active.set(roomId, { startedAt: now, peak: count, emptyTicks: 0 });
        } else {
            s.emptyTicks = 0;
            if (count > s.peak) s.peak = count;
        }
    }
    for (const [roomId, s] of active.entries()) {
        if (!counts.has(roomId) && ++s.emptyTicks >= EMPTY_TICKS_TO_CLOSE) {
            closeSession(roomId, s, now - s.emptyTicks * POLL_MS);
        }
    }
}

function closeSession(roomId, s, endedMs) {
    active.delete(roomId);
    const rec = {
        roomId,
        startedAt: new Date(s.startedAt).toISOString(),
        endedAt: new Date(endedMs).toISOString(),
        minutes: Math.max(1, Math.round((endedMs - s.startedAt) / 60000)),
        peak: s.peak,
    };
    fs.appendFile(FILE, JSON.stringify(rec) + '\n', (err) => {
        if (err) logger.error('Montemeet journal write failed', err.message);
    });
}

function readClosed(sinceMs) {
    let text = '';
    try {
        text = fs.readFileSync(FILE, 'utf-8');
    } catch (err) {
        return [];
    }
    const out = [];
    for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
            const rec = JSON.parse(line);
            if (!sinceMs || Date.parse(rec.endedAt) >= sinceMs) out.push(rec);
        } catch (err) {}
    }
    return out;
}

// newest first; running sessions included on top with live: true
function sessions({ room, days = 30 } = {}) {
    const since = Date.now() - days * 86400000;
    const out = [];
    for (const [roomId, s] of active.entries()) {
        if (room && roomId !== room) continue;
        out.push({
            roomId,
            startedAt: new Date(s.startedAt).toISOString(),
            endedAt: null,
            minutes: Math.max(1, Math.round((Date.now() - s.startedAt) / 60000)),
            peak: s.peak,
            live: true,
        });
    }
    const closed = readClosed(since).filter((rec) => !room || rec.roomId === room);
    closed.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
    return out.concat(closed);
}

// per-day aggregates (server timezone), newest first
function daily({ days = 30 } = {}) {
    const since = Date.now() - days * 86400000;
    const byDay = new Map();
    for (const rec of readClosed(since)) {
        const day = new Date(rec.startedAt).toLocaleDateString('sv');
        const d = byDay.get(day) || { day, sessions: 0, minutes: 0, peak: 0 };
        d.sessions += 1;
        d.minutes += rec.minutes;
        d.peak = Math.max(d.peak, rec.peak);
        byDay.set(day, d);
    }
    return Array.from(byDay.values()).sort((a, b) => (a.day < b.day ? 1 : -1));
}

// live info for one room (cabinet status card)
function activeRoom(roomId) {
    const s = active.get(roomId);
    if (!s) return null;
    return { startedAt: new Date(s.startedAt).toISOString(), minutes: Math.max(1, Math.round((Date.now() - s.startedAt) / 60000)), peak: s.peak };
}

module.exports = { start, sessions, daily, activeRoom };
