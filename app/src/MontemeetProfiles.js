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
    const { profiles = {}, rooms = {}, devicePriority = null } = load() || {};
    const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

    const profileName = has(rooms, roomId) ? rooms[roomId] : has(rooms, '*') ? rooms['*'] : 'default';
    const profile = has(profiles, profileName) ? profiles[profileName] : null;

    return {
        name: profile ? profileName : 'default',
        audio: (profile && profile.audio) || null,
        layout: (profile && profile.layout) || null,
        roles: (profile && profile.roles) || null,
        devicePriority, // installation-wide (e.g. SplitCam on school computers)
    };
}

module.exports = { forRoom };
