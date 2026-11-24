'use strict';

/*
 * Montemeet: сколько людей в комнате — до входа в неё.
 *
 * Заход 24.11 (Иван): «показывать, сколько человек на встрече, на экране
 * выбора камеры, микрофона и т.п. — для каждой встречи».
 *
 * На том экране человек в комнату ещё не вошёл: сокет подключён, но peer не
 * создан, и ни одно стоковое событие о составе комнаты ему не приходит.
 * Поэтому отдельный вопрос-ответ: клиент спрашивает про комнату по её имени,
 * сервер отвечает двумя числами.
 *
 * Имён не отдаём намеренно. Число — не секрет: кто знает имя комнаты, тот и так
 * войдёт и всех увидит. А список имён до входа — уже сведения о людях, и для
 * «стоит ли заходить» он не нужен.
 *
 * Ждущих в зале ожидания считаем отдельно: с 24.11 зал включён и на тестовой
 * комнате, и педагогу важно видеть, что кто-то уже стоит у двери.
 */

const MIN_INTERVAL_MS = 900; // чаще спрашивать незачем: клиент опрашивает раз в 5 с

function register({ socket, roomList, log }) {
    let lastAt = 0;

    socket.on('mmRoomPeek', ({ room = '' } = {}, callback) => {
        const reply = typeof callback === 'function' ? callback : () => {};
        try {
            const now = Date.now();
            if (now - lastAt < MIN_INTERVAL_MS) return reply({ error: 'too often' });
            lastAt = now;

            const r = roomList.get(String(room));
            if (!r) return reply({ count: 0, waiting: 0 });

            let count = 0;
            let waiting = 0;
            for (const peer of r.getPeers().values()) {
                if (peer.peer_lobby) waiting++;
                else count++;
            }
            reply({ count, waiting });
        } catch (err) {
            log?.error('Montemeet room peek', err.message);
            reply({ error: 'failed' });
        }
    });
}

module.exports = { register };
