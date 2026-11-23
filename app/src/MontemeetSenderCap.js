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
 * 23.11, the second bench (no-burst shaper, netem): the estimate does not lie upward — while the link is narrow it
 * mirrors what flows, and a freed link shows within 4 s. So three states, not one number: a receiver CHOKES (its
 * estimate fell below what flows to it) — the camera must fit in its budget; it is WIDE (room for a phone's 720p,
 * 2 Mbit/s) — the camera is free; otherwise OK — no choking, headroom unknown: the sender probes by itself.
 *
 * To the camera's owner: "montemeetVideoCap" { producer_id, kbps: number | null, wide: boolean, from }:
 *   kbps — the weakest choking receiver's budget; null + wide — free; null + !wide — probe by yourself.
 */

const STALE_MS = 6000; // a receiver's budget older than this does not count (it left, or its estimate went silent)
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

    /** A receiver's report for one camera: { kbps } (chokes) | 'wide' | 'ok' | null (no estimate / gone). */
    update(producerId, receiverKey, report, receiverName = '') {
        let m = this.budgets.get(producerId);
        if (report === null || report === undefined) {
            if (m) m.delete(receiverKey);
        } else {
            if (!m) this.budgets.set(producerId, (m = new Map()));
            const r = typeof report === 'object' ? { state: 'choke', kbps: Math.max(0, Math.round(report.kbps)) } : { state: report, kbps: null };
            m.set(receiverKey, { ...r, name: receiverName, at: this.now() });
        }
        this.decide(producerId);
    }

    /** The camera's state: the weakest choking receiver; else wide if every fresh receiver is wide (or none). */
    cap(producerId) {
        const m = this.budgets.get(producerId);
        let worst = null;
        let wide = true;
        const now = this.now();
        if (m) {
            for (const [key, b] of m) {
                if (now - b.at > STALE_MS) {
                    m.delete(key);
                    continue;
                }
                if (b.state === 'choke' && (!worst || b.kbps < worst.kbps)) worst = b;
                if (b.state !== 'wide') wide = false;
            }
        }
        if (worst) return { kbps: worst.kbps, wide: false, from: worst.name };
        return { kbps: null, wide, from: '' };
    }

    decide(producerId) {
        const { kbps, wide, from } = this.cap(producerId);
        const last = this.sent.get(producerId);
        const now = this.now();
        const kind = kbps !== null ? 'choke' : wide ? 'wide' : 'ok';
        let send;
        if (!last) send = kind !== 'wide'; // a fresh camera is free anyway
        else if (last.kind !== kind) send = true;
        else if (kind === 'choke') send = Math.abs(kbps - last.kbps) > CHANGE * Math.max(last.kbps, 1) || now - last.at >= KEEPALIVE_MS;
        else send = false;
        if (!send) return;
        const owner = this.ownerOf(producerId);
        if (!owner) return;
        this.sent.set(producerId, { kind, kbps, at: now });
        this.sendTo(owner.socketId, 'montemeetVideoCap', { producer_id: producerId, kbps, wide, from });
        if (!last || last.kind !== kind || (kind === 'choke' && Math.abs(kbps - last.kbps) > CHANGE * Math.max(last.kbps, 1))) {
            this.log.info('Montemeet: потолок камеры от получателей', { owner: owner.name, кбит: kbps, простор: wide, from });
        }
    }

    /** A camera closed — forget it. */
    drop(producerId) {
        this.budgets.delete(producerId);
        this.sent.delete(producerId);
    }
}

module.exports = MontemeetSenderCap;
