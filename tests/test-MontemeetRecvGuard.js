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

    it('recovers after 5 s clean, with a key frame; a failed try doubles the wait', async () => {
        const s = setup();
        s.bwe(1000000, 4000000);
        s.audio.emit('score', { score: 6 });
        for (let i = 0; i < 3; i++) await s.g.tick();
        assert.strictEqual(s.camStudent.paused, true);
        s.audio.emit('score', { score: 10 });
        for (let i = 0; i < 4; i++) await s.g.tick();
        assert.strictEqual(s.camStudent.paused, true, 'not before 5 s');
        await s.g.tick();
        assert.strictEqual(s.camStudent.paused, false, 'back after 5 s clean');
        assert.strictEqual(s.camStudent.keyframes, 1);
        // damage during probation — paused again, next wait 10 s
        s.audio.emit('score', { score: 6 });
        await s.g.tick();
        assert.strictEqual(s.camStudent.paused, true);
        assert.strictEqual(s.g.wait, 10);
        s.audio.emit('score', { score: 10 });
        for (let i = 0; i < 9; i++) await s.g.tick();
        assert.strictEqual(s.camStudent.paused, true, 'not before 10 s');
        await s.g.tick();
        assert.strictEqual(s.camStudent.paused, false);
        for (let i = 0; i < 6; i++) await s.g.tick();
        assert.strictEqual(s.g.wait, 5, 'a clean try resets the wait');
    });

    it('a closed consumer leaves the guard', async () => {
        const s = setup();
        s.camStudent.observer.emit('close');
        assert.strictEqual(s.g.items.has('v-student'), false);
    });
});
