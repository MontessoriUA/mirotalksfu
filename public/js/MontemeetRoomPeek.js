'use strict';

// Montemeet: строка «сколько людей на встрече» на экране выбора камеры.
//
// Заход 24.11 (Иван): «показывать, сколько человек на встрече, на экране выбора
// камеры, микрофона и т.п. — для каждой встречи». Польза простая: видно, ждут
// тебя уже или ты первый, и не надо входить, чтобы это выяснить.
//
// Спрашиваем у сервера (MontemeetRoomPeek.js), потому что до входа в комнату
// клиент о её составе не знает ничего: сокет подключён, но peer ещё не создан.
// Опрос — раз в 5 секунд, пока экран открыт; как только вход состоялся,
// замолкаем: дальше состав комнаты показывает сама комната.
//
// Где строка стоит. Экран устройств — это узел #initUser, который Swal на
// открытии переносит в своё окно. Внутрь него строку класть нельзя: .init-user
// это flex в одну строку без переноса, и наша строка встаёт в ряд с кнопками
// устройств и уезжает за правый край (проверено на стенде). Поэтому кладём её
// рядом с #initUser, в того же родителя, и переставляем следом, когда Swal
// перенесёт узел к себе, — тогда она оказывается отдельной строкой под блоком
// устройств, а стоковую вёрстку трогать не нужно.

(function () {
    const EVERY_MS = 5000;
    const PLACE_EVERY_MS = 500; // пока окно не открылось — следим, куда уехал #initUser
    const MAX_MS = 15 * 60 * 1000; // человек ушёл заваривать чай — без вечного опроса

    const roomFromUrl = () => {
        const m = location.pathname.match(/\/join\/([^/?#]+)/);
        if (!m) return '';
        try {
            return decodeURIComponent(m[1]);
        } catch (e) {
            return m[1];
        }
    };

    const say = (s) => (typeof window.mmT === 'function' ? window.mmT(s) : s);

    function make() {
        const el = document.createElement('div');
        el.id = 'mmPeek';
        el.style.cssText =
            'width:100%;margin:6px 0 0;font-size:13px;line-height:1.35;opacity:.72;' +
            'text-align:center;min-height:1.2em';
        return el;
    }

    // держим строку сразу за блоком устройств, где бы тот сейчас ни лежал
    function place(el) {
        const host = document.getElementById('initUser');
        if (!host || !host.parentNode) return false;
        if (el.previousElementSibling === host) return true;
        host.parentNode.insertBefore(el, host.nextSibling);
        return true;
    }

    function render(el, { count = 0, waiting = 0 } = {}) {
        if (!count && !waiting) {
            el.textContent = say('На встрече пока никого');
            return;
        }
        let text = `${say('На встрече')}: ${count}`;
        if (waiting) text += `, ${say('ждут входа')}: ${waiting}`;
        el.textContent = text;
    }

    function start() {
        const room = roomFromUrl();
        if (!room || document.getElementById('mmPeek')) return;

        const el = make();
        if (!place(el)) return;

        const startedAt = Date.now();
        let ask = null;
        let keep = null;

        const stop = () => {
            if (ask) clearInterval(ask);
            if (keep) clearInterval(keep);
            ask = keep = null;
            el.remove();
        };

        const done = () => {
            // вход состоялся — дальше состав показывает сама комната
            const joined = typeof rc !== 'undefined' && rc && rc.isConnected && rc.isConnected();
            return joined || Date.now() - startedAt > MAX_MS;
        };

        const poll = () => {
            if (done()) return stop();
            if (typeof socket === 'undefined' || !socket || !socket.connected) return;
            socket.emit('mmRoomPeek', { room }, (res) => {
                if (!res || res.error) return;
                render(el, res);
            });
        };

        poll();
        ask = setInterval(poll, EVERY_MS);
        keep = setInterval(() => {
            if (done()) return stop();
            place(el);
        }, PLACE_EVERY_MS);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start);
    } else {
        start();
    }
})();
