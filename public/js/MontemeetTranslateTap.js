'use strict';

// Montemeet: отвод звука для синхронного перевода.
//
// Копия своего микрофона уходит вторым, тихим каналом на сервер, а тот держит
// сессию с переводчиком (Montemeet/app-spec/TRANSLATE.md §6, вариант Б).
// Медиатракт урока при этом не трогается вовсе: это отдельная ветка от того же
// источника, и если она сломается, урок идёт как шёл.
//
// Здесь только отвод: копим 100 мс и отдаём их в главный поток как PCM16.
// Частоту не пересчитываем — AudioContext создаётся сразу на 16 000 Гц, и
// браузер приводит к ней сам. 100 мс — размер куска из примеров поставщика.
//
// Ничего не воспроизводит: выход молчит, узел нужен только чтобы граф работал.

const CHUNK = 1600; // 100 мс при 16 кГц

class MontemeetTranslateTap extends AudioWorkletProcessor {
    constructor() {
        super();
        this.buf = new Int16Array(CHUNK);
        this.filled = 0;
        this.on = true;
        this.port.onmessage = (e) => {
            if (e.data && typeof e.data.on === 'boolean') this.on = e.data.on;
        };
    }

    process(inputs) {
        const ch = inputs[0] && inputs[0][0];
        if (!ch || !this.on) return true;

        for (let i = 0; i < ch.length; i++) {
            // float [-1, 1] в PCM16 с ограничением: клиппинг лучше переполнения
            let v = ch[i];
            if (v > 1) v = 1;
            else if (v < -1) v = -1;
            this.buf[this.filled++] = v < 0 ? v * 0x8000 : v * 0x7fff;

            if (this.filled === CHUNK) {
                const out = this.buf.slice(0, CHUNK);
                this.port.postMessage(out, [out.buffer]);
                this.filled = 0;
            }
        }
        return true;
    }
}

registerProcessor('MontemeetTranslateTap', MontemeetTranslateTap);
