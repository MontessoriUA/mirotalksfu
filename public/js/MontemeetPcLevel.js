'use strict';

// Montemeet (2026-10-29): computer sound is levelled where it is SENT.
//
// Live run on build 441 (live-46): web music reached the phones at −15.7…−16.9 LUFS with peaks at
// 0 dBFS, while the voices the phones send arrive at −21…−23 LUFS (BS.1770, tools/gromkost.py).
// The music "shouted" 6–7 LU over the voices, and every receiver had to squash it: its receive
// limiter worked in 40–67 blocks of 100 per second, and Ivan heard the music "eaten". Level is the
// sender's business (Ivan): bring the computer sound to the loudness of the voices once, here,
// instead of in every phone.
//
// How. A slow loudness leveller, not a compressor:
//  - loudness is BS.1770 (K-weighted) on the mono downmix — what a phone's echo reference sees;
//  - the estimate is a long gated average (absolute gate −60 LUFS, relative −10 LU, ~10 s), so
//    soft passages and crescendos inside a piece keep their shape and silence never pumps it up;
//  - the gain moves slowly (down 3 dB/s, up 1 dB/s); only at the start, once 1.5 s of sound is
//    measured, it goes straight to the estimate;
//  - a 128-sample look-ahead peak limiter at −1 dBFS is only a safety net: at −23 LUFS music
//    peaks sit near −9 dBFS.

const TARGET_LUFS = -23; // the voices as the phones receive them, live-46: −21…−23 LUFS
const START_DB = -9; // until measured: web music −14 LUFS (platform norm) → −23
const MIN_DB = -30;
const MAX_DB = 10;
const ABS_GATE = -60;
const REL_GATE = -10;
const WARM_S = 1.5;
const TAU_S = 10;
const DOWN_DB_S = 3;
const UP_AFTER_S = 5; // a phrase or two of music before a quiet source is lifted
const UP_DB_S = 1.5;
const SNAP_DB_S = 20;
const CEIL = 0.891; // −1 dBFS
const REL_S = 0.2;
const REPORT_S = 5;

function biquad(b, a) {
    return { b0: b[0] / a[0], b1: b[1] / a[0], b2: b[2] / a[0], a1: a[1] / a[0], a2: a[2] / a[0], z1: 0, z2: 0 };
}

// BS.1770 pre-filter (shelf +4 dB) and RLB high-pass, recomputed for the context's rate
function kWeighting(fs) {
    let G = 3.999843853973347,
        Q = 0.7071752369554196,
        fc = 1681.974450955533;
    const A = Math.pow(10, G / 40);
    let w0 = (2 * Math.PI * fc) / fs;
    let al = Math.sin(w0) / (2 * Q);
    const c = Math.cos(w0),
        sa = 2 * Math.sqrt(A) * al;
    const shelf = biquad(
        [A * (A + 1 + (A - 1) * c + sa), -2 * A * (A - 1 + (A + 1) * c), A * (A + 1 + (A - 1) * c - sa)],
        [A + 1 - (A - 1) * c + sa, 2 * (A - 1 - (A + 1) * c), A + 1 - (A - 1) * c - sa]
    );
    Q = 0.5003270373238773;
    fc = 38.13547087602444;
    w0 = (2 * Math.PI * fc) / fs;
    al = Math.sin(w0) / (2 * Q);
    const c2 = Math.cos(w0);
    const hp = biquad([(1 + c2) / 2, -(1 + c2), (1 + c2) / 2], [1 + al, -2 * c2, 1 - al]);
    return [shelf, hp];
}

function run(f, x) {
    const y = f.b0 * x + f.z1;
    f.z1 = f.b1 * x - f.a1 * y + f.z2;
    f.z2 = f.b2 * x - f.a2 * y;
    return y;
}

const lufs = (e) => -0.691 + 10 * Math.log10(Math.max(e, 1e-12));
const fromDb = (d) => Math.pow(10, d / 20);

class MontemeetPcLevel extends AudioWorkletProcessor {
    constructor() {
        super();
        this.k = kWeighting(sampleRate);
        this.hop = Math.round(sampleRate * 0.1);
        this.acc = 0;
        this.accN = 0;
        this.hops = [0, 0, 0, 0]; // last 400 ms → momentary loudness
        this.hopsN = 0;
        this.est = 0; // gated loudness estimate, energy
        this.gatedS = 0;
        this.snapped = false;
        this.wantDb = START_DB;
        this.gainDb = START_DB;
        this.gain = fromDb(START_DB);
        this.lim = 1;
        this.minLim = 1;
        this.delay = [new Float32Array(128), new Float32Array(128)];
        this.spare = [new Float32Array(128), new Float32Array(128)];
        this.sinceReport = 0;
        this.peakOut = 0;
    }

    measure(L, R, n) {
        for (let i = 0; i < n; i++) {
            const y = run(this.k[1], run(this.k[0], 0.5 * (L[i] + R[i])));
            this.acc += y * y;
            if (++this.accN === this.hop) this.hopDone();
        }
    }

    hopDone() {
        this.hops[this.hopsN++ % 4] = this.acc / this.accN;
        this.acc = 0;
        this.accN = 0;
        if (this.hopsN < 4) return;
        const m = (this.hops[0] + this.hops[1] + this.hops[2] + this.hops[3]) / 4;
        const lm = lufs(m);
        if (lm <= ABS_GATE) return; // silence holds the gain
        const warm = this.gatedS < WARM_S;
        if (!warm && lm < lufs(this.est) + REL_GATE) return; // soft passage: keep its shape
        if (warm) this.est = (this.est * this.gatedS + m * 0.1) / (this.gatedS + 0.1);
        else this.est += (m - this.est) * (0.1 / TAU_S);
        this.gatedS += 0.1;
        if (this.gatedS >= WARM_S) {
            this.wantDb = Math.min(MAX_DB, Math.max(MIN_DB, TARGET_LUFS - lufs(this.est)));
        }
    }

    process(inputs, outputs) {
        const out = outputs[0];
        const n = out[0].length;
        const inp = inputs[0];
        const L = inp && inp.length ? inp[0] : null;
        const R = inp && inp.length > 1 ? inp[1] : L;
        if (L) this.measure(L, R, n);

        // leveller gain: one slewed step per render quantum, ramped across it. Down is never
        // late: at 1.5 s of sound the gain goes straight to the estimate if that is lower. Up is
        // never early: only after UP_AFTER_S of sound and slowly — a soft intro measured first
        // must not lift the loud part that follows (live-46: +8 dB and the limiter at work).
        const dt = n / sampleRate;
        if (!this.snapped && this.gatedS >= WARM_S && this.wantDb >= this.gainDb - SNAP_DB_S * dt) this.snapped = true;
        const down = (this.snapped ? DOWN_DB_S : this.gatedS >= WARM_S ? SNAP_DB_S : 0) * dt;
        const up = (this.gatedS >= UP_AFTER_S ? UP_DB_S : 0) * dt;
        const g0 = this.gain;
        this.gainDb += Math.max(-down, Math.min(up, this.wantDb - this.gainDb));
        const g1 = fromDb(this.gainDb);
        this.gain = g1;

        // gained input → look-ahead stage; the quantum held from the previous call goes out now
        let peakIn = 0;
        if (this.spare[0].length !== n) this.spare = [new Float32Array(n), new Float32Array(n)];
        if (this.delay[0].length !== n) this.delay = [new Float32Array(n), new Float32Array(n)];
        const cur = this.spare;
        for (let i = 0; i < n; i++) {
            const g = g0 + ((g1 - g0) * (i + 1)) / n;
            const l = L ? L[i] * g : 0;
            const r = R ? R[i] * g : 0;
            cur[0][i] = l;
            cur[1][i] = r;
            peakIn = Math.max(peakIn, Math.abs(l), Math.abs(r));
        }
        let peakHeld = 0;
        for (let i = 0; i < n; i++) peakHeld = Math.max(peakHeld, Math.abs(this.delay[0][i]), Math.abs(this.delay[1][i]));
        const want = Math.min(1, CEIL / Math.max(peakIn, 1e-9), CEIL / Math.max(peakHeld, 1e-9));
        const l0 = this.lim;
        const l1 = want < l0 ? want : l0 + (want - l0) * (1 - Math.exp(-dt / REL_S));
        this.lim = l1;
        this.minLim = Math.min(this.minLim, l1);
        for (let ch = 0; ch < out.length; ch++) {
            const src = this.delay[Math.min(ch, 1)];
            const o = out[ch];
            for (let i = 0; i < n; i++) {
                const v = src[i] * (l0 + ((l1 - l0) * (i + 1)) / n);
                o[i] = v > 1 ? 1 : v < -1 ? -1 : v;
                this.peakOut = Math.max(this.peakOut, Math.abs(o[i]));
            }
        }
        this.spare = this.delay;
        this.delay = cur;

        this.sinceReport += dt;
        if (this.sinceReport >= REPORT_S) {
            this.port.postMessage({
                loudness: this.gatedS > 0 ? Math.round(lufs(this.est) * 10) / 10 : null,
                gainDb: Math.round(this.gainDb * 10) / 10,
                limiterDb: Math.round(20 * Math.log10(this.minLim) * 10) / 10,
                peakOutDb: Math.round(20 * Math.log10(Math.max(this.peakOut, 1e-9)) * 10) / 10,
            });
            this.sinceReport = 0;
            this.minLim = 1;
            this.peakOut = 0;
        }
        return true;
    }
}

registerProcessor('MontemeetPcLevel', MontemeetPcLevel);
