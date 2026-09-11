'use strict';

/*
 * Montemeet: что устройство участника сообщает о себе в журнал событий сервера
 * (app/src/MontemeetEvents.js).
 *
 * Сервер видит, какие потоки идут и в каком качестве, но не видит того, что
 * случилось внутри браузера: не отказал ли он в микрофоне, не заглушила ли
 * захват система (iOS делает это, когда браузер уходит в фон), скрыта ли
 * вкладка, не запретил ли браузер играть звук без касания. Ровно эти факты сюда
 * и идут — и ничего больше (Иван, 2026-09-11: после урока Олены Ступак по логам
 * сервера было не понять, передавал ли её iPad звук вообще).
 */

const MontemeetDiag = (() => {
    const LIMIT = 300; // на страницу: хватает на урок и не даёт зациклиться
    const queue = [];
    let sent = 0;
    let readyAt = 0;
    let infoDone = false;

    function channel() {
        try {
            if (typeof rc === 'undefined' || !rc || !rc.socket || !rc.socket.connected) return null;
            // даём входу в комнату закончиться: до него сервер не знает, чья это запись
            if (!readyAt) readyAt = Date.now() + 3000;
            return Date.now() >= readyAt ? rc.socket : null;
        } catch (e) {
            return null;
        }
    }

    function flush() {
        const s = channel();
        if (!s) return;
        if (!infoDone) {
            infoDone = true;
            queue.unshift(deviceInfo());
        }
        while (queue.length) s.emit('mmDiag', queue.shift());
    }

    // ключи — только латиница: сервер остальное отбрасывает
    function report(type, data) {
        if (sent >= LIMIT) return;
        sent++;
        queue.push({ type, ...(data || {}) });
        if (queue.length > 60) queue.shift(); // до входа копим только свежее
        flush();
    }

    // как устройство себя определило — и поправили ли мы стоковое определение
    function deviceInfo() {
        // константы Room.js: к моменту первой отправки он давно выполнен
        const phone = typeof isMobileDevice !== 'undefined' && isMobileDevice;
        const tablet = typeof isTabletDevice !== 'undefined' && isTabletDevice;
        return {
            type: 'info',
            dev: phone ? 'phone' : tablet ? 'tablet' : 'computer',
            fix: (typeof MontemeetDevices !== 'undefined' && MontemeetDevices.touchTablet) || null,
            touch: navigator.maxTouchPoints || 0,
            coarse: !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches),
            screenshare: !!(navigator.mediaDevices && typeof navigator.mediaDevices.getDisplayMedia === 'function'),
        };
    }

    // вкладка скрыта или вернулась: на телефоне и планшете это уход в другое
    // приложение, и захват в этот момент система вправе остановить
    document.addEventListener('visibilitychange', () => report('visibility', { hidden: document.hidden }));

    // браузер не дал играть звук без касания: собеседник «молчит», хотя поток идёт.
    // Только для элементов с потоком собеседника: звуковые эффекты («дзынь» при
    // входе) браузер тоже не пускает без касания, но к «не слышно» они отношения
    // не имеют — на iPad их набиралось по семь штук на каждый вход
    try {
        const play = HTMLMediaElement.prototype.play;
        HTMLMediaElement.prototype.play = function () {
            const p = play.apply(this, arguments);
            if (p && typeof p.then === 'function') {
                p.then(null, (err) => {
                    if (err?.name !== 'NotAllowedError' || this._mmAutoplay || !this.srcObject) return;
                    this._mmAutoplay = true;
                    report('autoplay-blocked', { el: this.tagName.toLowerCase() });
                });
            }
            return p;
        };
    } catch (e) {
        /* без перехвата — просто не узнаем */
    }

    // дорожки захвата: заглушила ли их система и не кончились ли они сами.
    // Обычное выключение микрофона кнопкой сюда не попадает — это пауза
    // продюсера, дорожка при ней не глохнет
    const hooked = new WeakSet();
    function hookTracks() {
        try {
            if (typeof rc === 'undefined' || !rc || !rc.producers) return;
            for (const p of rc.producers.values()) {
                const t = p && p.track;
                if (!t || hooked.has(t)) continue;
                hooked.add(t);
                const media = (p.appData && p.appData.mediaType) || t.kind;
                const say = (state) => report('track', { kind: t.kind, media, state });
                t.addEventListener('mute', () => say('muted'));
                t.addEventListener('unmute', () => say('unmuted'));
                t.addEventListener('ended', () => say('ended'));
                if (t.muted) say('muted');
            }
        } catch (e) {
            /* не мешаем уроку */
        }
    }

    setInterval(() => {
        hookTracks();
        flush();
    }, 1500);

    return { report };
})();
