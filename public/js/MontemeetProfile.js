'use strict';

/*
 * Montemeet: fetch and expose the room profile served by GET /profile/:roomId
 * (see app/src/MontemeetProfiles.js). Loaded before RoomClient.js; RoomClient
 * consults MontemeetProfile.audio() when building capture constraints and
 * Opus codec options. If the fetch fails or the room has no profile, every
 * accessor returns null and the stock behavior applies.
 */

const MontemeetProfile = (() => {
    let profile = null;

    function roomIdFromLocation() {
        try {
            const url = new URL(window.location.href);
            const fromQuery = url.searchParams.get('room');
            if (fromQuery) return fromQuery;
            const joinPath = url.pathname.split('/join/')[1] || '';
            return decodeURIComponent(joinPath.replace(/\/+$/, ''));
        } catch (e) {
            return '';
        }
    }

    const ready = (async () => {
        const roomId = roomIdFromLocation();
        if (!roomId) return null;
        try {
            const res = await fetch('/profile/' + encodeURIComponent(roomId));
            if (res.ok) profile = await res.json();
            console.log('MontemeetProfile', profile);
        } catch (e) {
            console.warn('MontemeetProfile: fetch failed, using stock behavior', e);
        }
        return profile;
    })();

    return {
        ready,
        get: () => profile,
        name: () => (profile && profile.name) || 'default',
        audio: () => (profile && profile.audio) || null,
        layout: () => (profile && profile.layout) || null,
        roles: () => (profile && profile.roles) || null,
        isMusic: () => !!(profile && profile.audio && profile.audio.noiseSuppression === false),
    };
})();
