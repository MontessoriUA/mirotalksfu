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

    // Google One Tap: prefill the pre-join name field from the active Google
    // account (the participant can still edit it). Active only when the
    // registry provides a googleClientId (cabinet-managed, prod domains).
    ready.then((p) => {
        const clientId = p && p.googleClientId;
        if (!clientId) return;
        const script = document.createElement('script');
        script.src = 'https://accounts.google.com/gsi/client';
        script.onload = () => {
            try {
                google.accounts.id.initialize({
                    client_id: clientId,
                    auto_select: true,
                    callback: (resp) => {
                        try {
                            const payload = JSON.parse(atob(resp.credential.split('.')[1]));
                            if (!payload?.name) return;
                            // drop the name into the pre-join input once it exists and is empty
                            const fill = setInterval(() => {
                                const input = document.getElementById('usernameInput');
                                if (!input) return;
                                if (!input.value) input.value = payload.name;
                                clearInterval(fill);
                            }, 200);
                            setTimeout(() => clearInterval(fill), 60000);
                        } catch (e) {
                            /* malformed credential — ignore */
                        }
                    },
                });
                google.accounts.id.prompt();
            } catch (e) {
                console.warn('MontemeetProfile: One Tap unavailable', e);
            }
        };
        document.head.appendChild(script);
    });

    return {
        ready,
        get: () => profile,
        name: () => (profile && profile.name) || 'default',
        audio: () => (profile && profile.audio) || null,
        // Профиль звука с поправкой на платформу. На Android запрос обычного
        // эхоподавления переводит микрофон в голосовой пресет, и вендорский DSP
        // вырезает фортепиано (стуки проходят, ноты нет — Иван, 2026-08-19).
        // Поэтому музыкальные профили несут отдельное значение для Android:
        // 'remote-only' не включает платформенные эффекты, микрофон открывается
        // обычным трактом, а эхо собеседника снимает программный AEC3
        // (Chrome 141+; старый браузер молча превратит строку в true — то есть
        // в сегодняшнее поведение). Десктоп это поле не читает вовсе.
        audioResolved: () => {
            const a = profile && profile.audio;
            if (!a) return null;
            const android = /android/i.test(navigator.userAgent);
            if (!android || a.echoCancellationAndroid === undefined || a.echoCancellation === false) return a;
            return { ...a, echoCancellation: a.echoCancellationAndroid };
        },
        layout: () => (profile && profile.layout) || null,
        roles: () => (profile && profile.roles) || null,
        overrides: () => (profile && profile.overrides) || null,
        style: () => (profile && profile.style) || null,
        isMusic: () => !!(profile && profile.audio && profile.audio.noiseSuppression === false),
        recordingOff: () => !!(profile && profile.recordingOff), // школа запретила запись урока
    };
})();
