'use strict';

/*
 * Montemeet: keep each video consumer's simulcast/SVC layer in step with its
 * rendered tile size, so thumbnails don't pull full-resolution streams.
 * sync() is debounced and hooked into resizeVideoMedia(); the server clamps
 * and applies the request via the 'setConsumerPreferredLayers' socket event.
 * A hidden tile (clientWidth 0) drops to the lowest layer.
 */

const MontemeetLayers = (() => {
    const lastSent = new Map(); // consumer_id -> spatialLayer
    let timer = null;

    function spatialForWidth(px) {
        if (px <= 320) return 0;
        if (px <= 720) return 1;
        return 2;
    }

    function sync() {
        clearTimeout(timer);
        timer = setTimeout(run, 500);
    }

    function run() {
        try {
            if (typeof rc === 'undefined' || !rc?.socket?.connected || !rc?.consumers) return;
            const seen = new Set();
            for (const consumer of rc.consumers.values()) {
                if ((consumer.kind ?? consumer._kind) !== 'video') continue;
                const id = consumer.id ?? consumer._id;
                const el = document.getElementById(id + '__video');
                if (!el) continue;
                seen.add(id);
                const spatialLayer = spatialForWidth(el.clientWidth || 0);
                if (lastSent.get(id) === spatialLayer) continue;
                lastSent.set(id, spatialLayer);
                rc.socket.emit('setConsumerPreferredLayers', {
                    consumer_id: id,
                    spatialLayer,
                    temporalLayer: 2,
                });
            }
            for (const id of lastSent.keys()) {
                if (!seen.has(id)) lastSent.delete(id);
            }
        } catch (e) {
            console.warn('MontemeetLayers.sync failed', e);
        }
    }

    return { sync };
})();
