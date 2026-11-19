'use strict';

// Montemeet (19.11): receive guard — pause video only when the link is tight AND the receiver already reports
// damage; single-layer cameras of ordinary participants first, never audio; fast resume with back-off.

const assert = require('assert');
const { EventEmitter } = require('events');
const MontemeetRecvGuard = require('../app/src/MontemeetRecvGuard');

function fakeTransport() {
    const t = new EventEmitter();
    t.observer = new EventEmitter();
    t.enableTraceEvent = async () => {};
    return t;
}

function fakeConsumer(id, kind, type) {
    const c = new EventEmitter();
    c.observer = new EventEmitter();
    Object.assign(c, { id, kind, type, paused: false, producerPaused: false, keyframes: 0 });
    c.pause = async () => { c.paused = true; };
    c.resume = async () => { c.paused = false; };
    c.requestKeyFrame = async () => { c.keyframes++; };
    c.getStats = async () => [{ type: 'outbound-rtp', bitrate: kind === 'video' ? 2000000 : 64000 }];
    return c;
}

function setup() {
    const transport = fakeTransport();
    const sent = [];
    const log = { info() {}, warn() {} };
    const g = new MontemeetRecvGuard({ peerName: 'приёмник', transport, send: (a, d) => sent.push({ a, d }), log });
    clearInterval(g.timer); // the test drives ticks itself
    const audio = fakeConsumer('a1', 'audio', 'simple');
    const camStudent = fakeConsumer('v-student', 'video', 'simple');
    const camTeacher = fakeConsumer('v-teacher', 'video', 'simple');
    const camWeb = fakeConsumer('v-web', 'video', 'simulcast');
    g.add(audio, { mediaType: 'audioType', from: 'Ира' });
    g.add(camTeacher, { mediaType: 'videoType', presenter: true, from: 'Педагог' });
    g.add(camWeb, { mediaType: 'videoType', presenter: false, from: 'Веб' });
    g.add(camStudent, { mediaType: 'videoType', presenter: false, from: 'Ира' });
    const bwe = (available, desired) => transport.emit('trace', { type: 'bwe', direction: 'out', info: { availableBitrate: available, desiredBitrate: desired } });
    return { g, transport, sent, audio, camStudent, camTeacher, camWeb, bwe };
}

describe('MontemeetRecvGuard', () => {
    it('tight link without damage — nothing is paused', async () => {
        const s = setup();
        s.bwe(1000000, 4000000);
        for (let i = 0; i < 6; i++) await s.g.tick();
        assert.strictEqual(s.camStudent.paused, false);
        assert.strictEqual(s.sent.length, 0);
    });

    it('damage without a tight link — nothing is paused', async () => {
        const s = setup();
        s.bwe(5000000, 4000000);
        s.audio.emit('score', { score: 5 });
        for (let i = 0; i < 6; i++) await s.g.tick();
        assert.strictEqual(s.camStudent.paused, false);
    });

    it('tight + damage for 3 s — the single-layer camera of an ordinary participant goes first, audio never', async () => {
        const s = setup();
        s.bwe(1000000, 4000000);
        s.audio.emit('score', { score: 6 });
        await s.g.tick(); await s.g.tick();
        assert.strictEqual(s.camStudent.paused, false, 'not after 2 s');
        await s.g.tick();
        assert.strictEqual(s.camStudent.paused, true);
        assert.strictEqual(s.camTeacher.paused, false);
        assert.strictEqual(s.audio.paused, false);
        assert.deepStrictEqual(s.sent[0], { a: 'montemeetVideoGuard', d: { consumer_id: 'v-student', paused: true, reason: 'канал тесен, приём портится' } });
        // still bad — the presenter's single-layer camera next, then the layered one
        for (let i = 0; i < 3; i++) await s.g.tick();
        assert.strictEqual(s.camTeacher.paused, true);
        for (let i = 0; i < 3; i++) await s.g.tick();
        assert.strictEqual(s.camWeb.paused, true);
        for (let i = 0; i < 3; i++) await s.g.tick();
        assert.strictEqual(s.audio.paused, false, 'audio is never paused');
    });

    it('link frees up — video is back within 3 s, one stream at a time, with a key frame', async () => {
        const s = setup();
        s.bwe(1000000, 4000000);
        s.audio.emit('score', { score: 6 });
        for (let i = 0; i < 6; i++) await s.g.tick();
        assert.strictEqual(s.camStudent.paused, true);
        assert.strictEqual(s.camTeacher.paused, true);
        // the arch is behind: BWE recovered, audio clean (fits 1 Mbit/s flowing + 2 Mbit/s to return, +10 %)
        s.bwe(5000000, 1000000);
        s.audio.emit('score', { score: 10 });
        await s.g.tick(); await s.g.tick();
        assert.strictEqual(s.camTeacher.paused, true, 'not before 3 s');
        await s.g.tick();
        assert.strictEqual(s.camTeacher.paused, false, 'last paused comes back first');
        assert.strictEqual(s.camTeacher.keyframes, 1);
        assert.strictEqual(s.camStudent.paused, true, 'one at a time');
        for (let i = 0; i < 7; i++) await s.g.tick();
        assert.strictEqual(s.camStudent.paused, false, 'the next one after the probation');
    });

    it('paused stream does not count in "desired" — the link must fit it again, no swinging back (bench 20.11)', async () => {
        const s = setup();
        s.bwe(1000000, 4000000);
        s.audio.emit('score', { score: 6 });
        for (let i = 0; i < 3; i++) await s.g.tick();
        assert.strictEqual(s.camStudent.paused, true);
        // paused: desired dropped to what still flows — 1.2 Mbit/s available "looks" enough, but not with 2 Mbit/s back
        s.bwe(1200000, 900000);
        s.audio.emit('score', { score: 10 });
        for (let i = 0; i < 5; i++) await s.g.tick();
        assert.strictEqual(s.camStudent.paused, true, 'does not fit 0.9 + 2.0 Mbit/s');
        s.bwe(3500000, 900000);
        for (let i = 0; i < 3; i++) await s.g.tick();
        assert.strictEqual(s.camStudent.paused, false, 'fits — back');
    });

    it('link still tight — only a rare blind try (8 s), a failed one doubles the wait (max 20 s)', async () => {
        const s = setup();
        s.bwe(1000000, 4000000);
        s.audio.emit('score', { score: 6 });
        for (let i = 0; i < 3; i++) await s.g.tick();
        assert.strictEqual(s.camStudent.paused, true);
        s.audio.emit('score', { score: 10 }); // clean, but the link still looks tight
        for (let i = 0; i < 7; i++) await s.g.tick();
        assert.strictEqual(s.camStudent.paused, true, 'no try before 8 s');
        await s.g.tick();
        assert.strictEqual(s.camStudent.paused, false, 'blind try at 8 s');
        s.audio.emit('score', { score: 6 });
        await s.g.tick();
        assert.strictEqual(s.camStudent.paused, true, 'try failed');
        assert.strictEqual(s.g.wait, 16);
        s.audio.emit('score', { score: 10 });
        for (let i = 0; i < 15; i++) await s.g.tick();
        assert.strictEqual(s.camStudent.paused, true);
        await s.g.tick();
        assert.strictEqual(s.camStudent.paused, false, 'next try at 16 s');
        s.audio.emit('score', { score: 6 });
        await s.g.tick();
        assert.strictEqual(s.g.wait, 20, 'capped at 20 s');
    });

    it('a try is judged by audio and other video, not by the just-resumed stream itself', async () => {
        const s = setup();
        s.bwe(1000000, 4000000);
        s.audio.emit('score', { score: 6 });
        for (let i = 0; i < 3; i++) await s.g.tick();
        assert.strictEqual(s.camStudent.paused, true);
        s.bwe(5000000, 1000000);
        s.audio.emit('score', { score: 10 });
        for (let i = 0; i < 3; i++) await s.g.tick();
        assert.strictEqual(s.camStudent.paused, false);
        s.camStudent.emit('score', { score: 3 }); // a resumed stream scores low at first
        for (let i = 0; i < 6; i++) await s.g.tick();
        assert.strictEqual(s.camStudent.paused, false, 'the try passes: audio is clean');
        assert.strictEqual(s.g.wait, 8);
    });

    it('the guard is never stored on the Peer object — peers are serialised to JSON on every join', () => {
        // bench 19.11: `peer.montemeetRecvGuard = …` broke every join into the room ("circular structure")
        const src = require('fs').readFileSync(require('path').join(__dirname, '../app/src/Room.js'), 'utf8');
        assert.ok(!/peer\.montemeet\w*\s*=/.test(src), 'Room.js must not attach the guard to a peer');
        assert.ok(/new WeakMap\(\)/.test(src));
    });

    it('a closed consumer leaves the guard', async () => {
        const s = setup();
        s.camStudent.observer.emit('close');
        assert.strictEqual(s.g.items.has('v-student'), false);
    });
});
