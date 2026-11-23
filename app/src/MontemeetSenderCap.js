'use strict';

/*
 * Montemeet (2026-11-23): a cap for a single-layer camera from its receivers' links.
 *
 * A phone camera goes as ONE layer (H.264, hardware encoder); the router cannot thin it for a weak receiver. Meet and
 * Zoom in a one-to-one call (measured 23.11 from a Samsung, docs/СЛАБАЯ-СЕТЬ-19.11.md in montemeet-app) do not send
 * layers either: the receiver's link goes back to the sender, and the sender shrinks its single copy within seconds.
 * Here: every receiver's guard (MontemeetRecvGuard, observe mode) reports, per camera it receives, how much video its
 * link has room for — the BWE estimate of its consumer transport minus everything else flowing to it. The cap for a
 * camera is the smallest of its receivers' budgets; the sender's app (cameraLadder.ts) takes min(own uplink, cap).
 *
 * Bench 23.11 (receiver at 500 kbit/s): while the stream fits, the estimate is close to the truth (320–470) and shows
 * a freed link within 3 s; an overloading stream drives it to the 30 kbit/s floor within 20 s — the sender then goes
 * to the lowest rung, the stream fits, and the estimate grows back (~8 %/s).
 *
 * To the camera's owner: "montemeetVideoCap" { producer_id, kbps: number | null, from } — null: no cap.
 */

const STALE_MS = 6000; // a receiver's budget older than this does not count (it left, or its estimate went silent)
const NONE_KBPS = 3000; // budget this large — no cap at all (a phone camera tops at 2–2.4 Mbit/s)
const CHANGE = 0.15; // resend when the cap moves by more than 15 %
const KEEPALIVE_MS = 5000; // and every 5 s while a cap holds

class MontemeetSenderCap {
    /**
     * @param {object} o
     * @param {Function} o.send     (socketId, action, data)
     * @param {Function} o.ownerOf  producerId → { socketId, name } | null
     * @param {object} o.log        Logger
     * @param {Function} [o.now]    clock (tests)
     */
    constructor({ send, ownerOf, log, now = Date.now }) {
        this.sendTo = send;
        this.ownerOf = ownerOf;
        this.log = log;
        this.now = now;
        this.budgets = new Map(); // producerId → Map(receiverKey → { kbps, name, at })
        this.sent = new Map(); // producerId → { kbps, at }
    }

    /** A receiver's budget for one camera; `kbps` null — the receiver no longer takes it. */
    update(producerId, receiverKey, kbps, receiverName = '') {
        let m = this.budgets.get(producerId);
        if (kbps === null || kbps === undefined) {
            if (m) m.delete(receiverKey);
        } else {
            if (!m) this.budgets.set(producerId, (m = new Map()));
            m.set(receiverKey, { kbps: Math.max(0, Math.round(kbps)), name: receiverName, at: this.now() });
        }
        this.decide(producerId);
    }

    /** The current cap for a camera: the weakest fresh receiver, or null. */
    cap(producerId) {
        const m = this.budgets.get(producerId);
        if (!m) return { kbps: null, from: '' };
        let best = null;
        const now = this.now();
        for (const [key, b] of m) {
            if (now - b.at > STALE_MS) {
                m.delete(key);
                continue;
            }
            if (!best || b.kbps < best.kbps) best = b;
        }
        if (!best || best.kbps >= NONE_KBPS) return { kbps: null, from: '' };
        return { kbps: best.kbps, from: best.name };
    }

    decide(producerId) {
        const { kbps, from } = this.cap(producerId);
        const last = this.sent.get(producerId);
        const now = this.now();
        let send = false;
        if (!last) send = kbps !== null;
        else if ((last.kbps === null) !== (kbps === null)) send = true;
        else if (kbps !== null) {
            send = Math.abs(kbps - last.kbps) > CHANGE * Math.max(last.kbps, 1) || now - last.at >= KEEPALIVE_MS;
        }
        if (!send) return;
        const owner = this.ownerOf(producerId);
        if (!owner) return;
        this.sent.set(producerId, { kbps, at: now });
        this.sendTo(owner.socketId, 'montemeetVideoCap', { producer_id: producerId, kbps, from });
        if (!last || (last.kbps === null) !== (kbps === null) || Math.abs((kbps || 0) - (last.kbps || 0)) > CHANGE * Math.max(last.kbps || 0, 1)) {
            this.log.info('Montemeet: потолок камеры от получателей', { owner: owner.name, кбит: kbps, from });
        }
    }

    /** A camera closed — forget it. */
    drop(producerId) {
        this.budgets.delete(producerId);
        this.sent.delete(producerId);
    }
}

module.exports = MontemeetSenderCap;
