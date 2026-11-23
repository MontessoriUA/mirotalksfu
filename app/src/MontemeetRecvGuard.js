'use strict';

/*
 * Montemeet (2026-11-19): receive guard — audio first on a weak downlink.
 *
 * Field (16.11, 19.11; Samsung on 2.4 GHz) and the weak-network bench (tools/stend_seti.mjs, emulator downlink
 * throttled): a phone camera arrives as ONE layer at up to 2–2.4 Mbit/s, and a screen share as one size; the
 * router cannot thin them (simulcast cameras it already drops to the lowest layer by itself). When the receiver's
 * link is narrower than that, the queue grows, audio packets are lost or late along with video, the signalling
 * socket times out ("ping timeout"), the client rejoins, and the 10–15 s delays and "the music breaks up" follow.
 *
 * Rule (Ivan 19.11: pause only "when it really cannot be received normally"; recover fast — a dip may be local,
 * like walking under an arch):
 *   tight   — the receiver's estimated downlink (BWE trace "out" of its consumer transport) is below 85 % of what
 *             its consumers want;
 *   hurting — the receiver already reports damage: an audio consumer score ≤ 8 or a video consumer score ≤ 5
 *             (mediasoup scores the stream from the receiver's own RTCP loss, 10 = clean);
 *   pause   — tight AND hurting for 3 s in a row: pause one video consumer, in this order — single-layer cameras of
 *             ordinary participants, the presenter's single-layer camera, single-layer screen share; then the same
 *             for layered (simulcast) video, which the router already thins first. Audio is never touched;
 *   resume  — as soon as the estimate fits what flows plus the stream to return (its bitrate before the pause,
 *             +10 %) and the receiver is clean for 3 s, bring the last paused one
 *             back (one stream at a time, each on a 4 s probation); while the link still looks tight — only a rare
 *             blind try after 8 s clean, doubling to 20 s after a failed one; a clean try resets the wait.
 * The client gets "montemeetVideoGuard" {consumer_id, paused, reason} — to show "paused: weak connection"
 * instead of a frozen frame.
 *
 * 23.11: `act: false` — observe only: no pauses, a link trace every 2 s (estimate, what actually flows to the
 * receiver, scores). Bench 23.11 (one-to-one, receiver at 500 kbit/s): with pauses the picture is gone for the whole
 * dip and every blind try spikes concealed audio to 12–17 % — on average worse than no guard at all. Next: a cap
 * from the receiver's link to the single-layer sender's own resolution ladder (docs/СЛАБАЯ-СЕТЬ-19.11.md).
 */

const TICK_MS = 1000;
const TIGHT = 0.85;
const TIGHT_FREE = 1.1; // to bring a stream back the estimate must exceed flowing + that stream by 10 %
const AUDIO_HURT = 8;
const VIDEO_HURT = 5;
const PAUSE_AFTER = 3;
const FREE_RESUME = 3; // link no longer tight and clean for 3 s — bring video back, one stream at a time
const RESUME_FIRST = 8; // a blind try while the link still looks tight — after 8 s clean …
const RESUME_MAX = 20; // … doubling to 20 s after a failed try
const PROBATION = 4;
const OBSERVE_EVERY = 2; // observe-only: trace every 2 s

class MontemeetRecvGuard {
    /**
     * @param {object} o
     * @param {string} o.peerName    receiver, for the log
     * @param {object} o.transport   its mediasoup consumer WebRtcTransport
     * @param {Function} o.send      (action, data) → to this receiver's socket
     * @param {object} o.log         Logger
     * @param {boolean} [o.act]     false — observe only (no pauses), trace every 2 s
     */
    constructor({ peerName, transport, send, log, act = true }) {
        this.act = act;
        this.peerName = peerName;
        this.transport = transport;
        this.send = send;
        this.log = log;
        this.items = new Map(); // consumer id → { consumer, rank, from, kind, simple, score }
        this.paused = []; // guard-paused consumer ids, last paused at the end
        this.bwe = null;
        this.bweAt = 0;
        this.bad = 0;
        this.good = 0;
        this.wait = RESUME_FIRST;
        this.probation = null; // { id, left }
        this.stats = { pauses: 0, resumes: 0 };
        transport.enableTraceEvent(['bwe']).catch(() => {});
        transport.on('trace', (t) => {
            if (t.type === 'bwe' && t.direction === 'out' && t.info) {
                this.bwe = t.info;
                this.bweAt = Date.now();
            }
        });
        this.timer = setInterval(() => this.tick(), TICK_MS);
        transport.observer.once('close', () => this.stop());
    }

    stop() {
        clearInterval(this.timer);
        if (this.stats.pauses) {
            this.log.info('Montemeet: защита приёма — итог', { peer: this.peerName, ...this.stats });
        }
    }

    /**
     * @param {object} consumer   mediasoup Consumer
     * @param {object} meta       { mediaType: 'audioType'|'videoType'|'screenType', presenter: boolean, from: string }
     */
    add(consumer, meta = {}) {
        const simple = consumer.type === 'simple';
        // Lower rank = paused earlier. Audio never.
        let rank = null;
        if (consumer.kind === 'video') {
            const base = meta.mediaType === 'screenType' ? 2 : meta.presenter ? 1 : 0;
            rank = (simple ? 0 : 10) + base;
        }
        const item = { consumer, rank, from: meta.from || '', kind: consumer.kind, simple, score: 10 };
        this.items.set(consumer.id, item);
        consumer.on('score', (s) => {
            if (s && typeof s.score === 'number') item.score = s.score;
        });
        consumer.observer.once('close', () => {
            this.items.delete(consumer.id);
            this.paused = this.paused.filter((id) => id !== consumer.id);
            if (this.probation?.id === consumer.id) this.probation = null;
        });
    }

    tight() {
        if (!this.bwe || Date.now() - this.bweAt > 5000) return false;
        const want = this.bwe.desiredBitrate || 0;
        return want > 0 && this.bwe.availableBitrate < TIGHT * want;
    }

    /** `except` — the consumer on probation: a just-resumed stream always scores low at first (bench 19.11 —
        every try "failed" on its own score within a second), so a try is judged by audio and the other video. */
    hurting(except = null) {
        for (const it of this.items.values()) {
            if (it.consumer.paused || it.consumer.producerPaused || it.consumer.id === except) continue;
            if (it.kind === 'audio' && it.score <= AUDIO_HURT) return true;
            if (it.kind === 'video' && it.score <= VIDEO_HURT) return true;
        }
        return false;
    }

    async tick() {
        if (!this.act) return this.observe();
        try {
            const hurt = this.hurting(this.probation?.id);
            const bad = hurt && this.tight();
            if (this.probation) {
                if (hurt) {
                    const id = this.probation.id;
                    this.probation = null;
                    this.wait = Math.min(RESUME_MAX, this.wait * 2);
                    await this.pause(id, 'проба не прошла');
                    this.bad = 0;
                    return;
                }
                if (--this.probation.left <= 0) {
                    this.probation = null;
                    this.wait = RESUME_FIRST;
                }
            }
            const tight = this.tight();
            this.bad = bad ? this.bad + 1 : 0;
            this.good = hurt ? 0 : this.good + 1;
            this.free = !hurt && this.fits() ? (this.free || 0) + 1 : 0;
            this.trace(tight, hurt);
            if (this.bad >= PAUSE_AFTER) {
                this.bad = 0;
                const victim = this.pickVictim();
                if (victim) await this.pause(victim.consumer.id, 'канал тесен, приём портится');
                return;
            }
            /* Back: as soon as the link is no longer tight and clean (BWE recovered — the arch is behind) — fast,
               one stream at a time; while it still looks tight — only a rare blind try (bench 20.11: every try of a
               2.4 Mbit/s stream into a ~1 Mbit/s link spiked concealed audio to 11–26 %). */
            if (this.paused.length && !this.probation) {
                const why = this.free >= FREE_RESUME ? 'канал освободился' : this.good >= this.wait ? 'пробую вернуть' : null;
                if (why) {
                    this.good = 0;
                    this.free = 0;
                    const id = this.paused.pop();
                    const it = this.items.get(id);
                    if (!it) return;
                    await it.consumer.resume();
                    await it.consumer.requestKeyFrame().catch(() => {});
                    this.stats.resumes++;
                    this.probation = { id, left: PROBATION };
                    this.note(it, false, why);
                }
            }
        } catch (e) {
            this.log.warn('Montemeet: защита приёма — сбой такта', { peer: this.peerName, error: e.message });
        }
    }

    /** Observe only: what the receiver's link estimate says next to what actually flows to it (23.11 — is the
        estimate usable as a cap for the sender?). */
    async observe() {
        this.traceTick = (this.traceTick || 0) + 1;
        if (this.traceTick % OBSERVE_EVERY) return;
        try {
            let audio = 0;
            let video = 0;
            const scores = [];
            for (const it of this.items.values()) {
                const st = await it.consumer.getStats().catch(() => []);
                const out = (st || []).find((r) => r.type === 'outbound-rtp');
                const kb = out && out.bitrate ? Math.round(out.bitrate / 1000) : 0;
                if (it.kind === 'audio') audio += kb;
                else video += kb;
                scores.push(`${it.kind[0]}${it.consumer.paused ? 'п' : it.score}`);
            }
            const fresh = this.bwe && Date.now() - this.bweAt <= 5000;
            this.log.info('Montemeet: защита приёма — след', {
                peer: this.peerName,
                доступно: fresh ? Math.round(this.bwe.availableBitrate / 1000) : null,
                нужно: fresh ? Math.round((this.bwe.desiredBitrate || 0) / 1000) : null,
                'идёт звук/видео': `${audio}/${video}`,
                оценки: scores.join(' '),
            });
        } catch (e) {
            this.log.warn('Montemeet: защита приёма — сбой следа', { peer: this.peerName, error: e.message });
        }
    }

    /** The link fits what flows now plus the next stream to bring back (its bitrate before the pause). */
    fits() {
        if (!this.bwe || Date.now() - this.bweAt > 5000) return false;
        const next = this.items.get(this.paused[this.paused.length - 1]);
        const extra = next?.bitrate || 0;
        return this.bwe.availableBitrate >= TIGHT_FREE * ((this.bwe.desiredBitrate || 0) + extra);
    }

    /** Test rooms: every 5 s while anything is tight or paused — the numbers the rule decides on. */
    trace(tight, hurt) {
        this.traceTick = (this.traceTick || 0) + 1;
        if (this.traceTick % 5 || (!tight && !hurt && !this.paused.length)) return;
        const bwe = this.bwe ? `${Math.round(this.bwe.availableBitrate / 1000)}/${Math.round(this.bwe.desiredBitrate / 1000)}` : '—';
        const scores = [...this.items.values()].map((x) => `${x.kind[0]}${x.consumer.paused ? 'п' : x.score}`).join(' ');
        this.log.info('Montemeet: защита приёма — канал', { peer: this.peerName, 'доступно/нужно': bwe, оценки: scores, тесно: tight, потери: hurt });
    }

    pickVictim() {
        let best = null;
        for (const it of this.items.values()) {
            if (it.rank === null || it.consumer.paused || it.consumer.producerPaused) continue;
            if (!best || it.rank < best.rank) best = it;
        }
        return best;
    }

    async pause(id, reason) {
        const it = this.items.get(id);
        if (!it || it.consumer.paused) return;
        // Its bitrate before the pause: the link must fit it again before it comes back (bench 20.11 — with it
        // paused, "desired" no longer counted it, the link looked free at once, and video swung back and forth
        // every ~10 s, hurting audio more than no guard at all).
        try {
            const st = await it.consumer.getStats();
            const out = (st || []).find((r) => r.type === 'outbound-rtp');
            if (out && out.bitrate) it.bitrate = out.bitrate;
        } catch (_) {}
        await it.consumer.pause();
        this.paused = this.paused.filter((x) => x !== id);
        this.paused.push(id);
        this.stats.pauses++;
        this.note(it, true, reason);
    }

    note(it, paused, reason) {
        const bwe = this.bwe
            ? { доступно: Math.round(this.bwe.availableBitrate / 1000), нужно: Math.round(this.bwe.desiredBitrate / 1000) }
            : {};
        const scores = [...this.items.values()].map((x) => `${x.kind[0]}${x.score}`).join(' ');
        this.log.info(`Montemeet: защита приёма — ${paused ? 'пауза' : 'возврат'}`, {
            peer: this.peerName,
            from: it.from,
            kind: it.kind,
            layers: it.simple ? 1 : 'слои',
            reason,
            кбит: bwe,
            оценки: scores,
            ждать: this.wait,
        });
        this.send('montemeetVideoGuard', { consumer_id: it.consumer.id, paused, reason });
    }
}

module.exports = MontemeetRecvGuard;
