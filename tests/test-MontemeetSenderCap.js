'use strict';

// Montemeet (23.11): a single-layer camera's state from its receivers' links — CHOKE (the weakest choking receiver's
// budget), WIDE (room for 720p — free), OK (no choking, headroom unknown — the sender probes by itself).

const assert = require('assert');
const { EventEmitter } = require('events');
const MontemeetSenderCap = require('../app/src/MontemeetSenderCap');
const MontemeetRecvGuard = require('../app/src/MontemeetRecvGuard');

function setup() {
    let t = 1000;
    const sent = [];
    const caps = new MontemeetSenderCap({
        send: (sid, action, data) => sent.push({ sid, action, data }),
        ownerOf: (pid) => (pid === 'cam-samsung' ? { socketId: 's-samsung', name: 'Samsung' } : null),
        log: { info() {} },
        now: () => t,
    });
    return { caps, sent, tick: (ms) => (t += ms) };
}

describe('MontemeetSenderCap', () => {
    it('no reports — nothing sent', () => {
        const s = setup();
        s.caps.decide('cam-samsung');
        assert.strictEqual(s.sent.length, 0);
    });

    it('a wide receiver at the start — nothing sent (a fresh camera is free anyway)', () => {
        const s = setup();
        s.caps.update('cam-samsung', 'r1', 'wide', 'Мак');
        assert.strictEqual(s.sent.length, 0);
    });

    it('a choking receiver — its budget goes to the camera owner', () => {
        const s = setup();
        s.caps.update('cam-samsung', 'r1', { kbps: 260 }, 'Мак');
        assert.deepStrictEqual(s.sent, [{ sid: 's-samsung', action: 'montemeetVideoCap', data: { producer_id: 'cam-samsung', kbps: 260, wide: false, from: 'Мак' } }]);
    });

    it('the weakest of several choking receivers decides; one choking beats others wide', () => {
        const s = setup();
        s.caps.update('cam-samsung', 'r1', 'wide', 'Мак');
        s.caps.update('cam-samsung', 'r2', { kbps: 300 }, 'OnePlus');
        s.caps.update('cam-samsung', 'r3', { kbps: 1200 }, 'Веб');
        assert.deepStrictEqual(s.sent.at(-1).data, { producer_id: 'cam-samsung', kbps: 300, wide: false, from: 'OnePlus' });
    });

    it('choke → ok: «probe by yourself» (kbps null, wide false); ok → wide: free', () => {
        const s = setup();
        s.caps.update('cam-samsung', 'r1', { kbps: 200 }, 'Мак');
        s.caps.update('cam-samsung', 'r1', 'ok', 'Мак');
        assert.deepStrictEqual(s.sent.at(-1).data, { producer_id: 'cam-samsung', kbps: null, wide: false, from: '' });
        s.caps.update('cam-samsung', 'r1', 'ok', 'Мак');
        assert.strictEqual(s.sent.length, 2, 'ok again — nothing new');
        s.caps.update('cam-samsung', 'r1', 'wide', 'Мак');
        assert.deepStrictEqual(s.sent.at(-1).data, { producer_id: 'cam-samsung', kbps: null, wide: true, from: '' });
    });

    it('wide only when every fresh receiver is wide', () => {
        const s = setup();
        s.caps.update('cam-samsung', 'r1', { kbps: 200 }, 'Мак');
        s.caps.update('cam-samsung', 'r1', 'wide', 'Мак');
        s.caps.update('cam-samsung', 'r2', 'ok', 'OnePlus');
        assert.deepStrictEqual(s.sent.at(-1).data, { producer_id: 'cam-samsung', kbps: null, wide: false, from: '' });
    });

    it('choking: small changes are not resent; >15 % is; every 5 s a keepalive', () => {
        const s = setup();
        s.caps.update('cam-samsung', 'r1', { kbps: 300 }, 'Мак');
        s.tick(2000);
        s.caps.update('cam-samsung', 'r1', { kbps: 330 }, 'Мак');
        assert.strictEqual(s.sent.length, 1, '+10 % — no');
        s.tick(2000);
        s.caps.update('cam-samsung', 'r1', { kbps: 400 }, 'Мак');
        assert.strictEqual(s.sent.length, 2, '+33 % — yes');
        s.tick(5000);
        s.caps.update('cam-samsung', 'r1', { kbps: 410 }, 'Мак');
        assert.strictEqual(s.sent.length, 3, 'keepalive after 5 s');
    });

    it('a receiver that left (null) or went silent (> 6 s) no longer holds the camera', () => {
        const s = setup();
        s.caps.update('cam-samsung', 'r1', { kbps: 260 }, 'Мак');
        s.caps.update('cam-samsung', 'r1', null);
        assert.deepStrictEqual(s.sent.at(-1).data, { producer_id: 'cam-samsung', kbps: null, wide: true, from: '' });
        s.caps.update('cam-samsung', 'r2', { kbps: 300 }, 'OnePlus');
        s.tick(7000);
        s.caps.update('cam-samsung', 'r3', 'wide', 'Веб');
        assert.strictEqual(s.sent.at(-1).data.wide, true, 'r2 is stale');
    });

    it('a camera without a known owner — nothing sent, nothing breaks', () => {
        const s = setup();
        s.caps.update('cam-gone', 'r1', { kbps: 100 }, 'Мак');
        assert.strictEqual(s.sent.length, 0);
    });
});

describe('MontemeetRecvGuard → camera reports (observe mode)', () => {
    function fake(id, kind, type, producerId, bitrate) {
        const c = new EventEmitter();
        c.observer = new EventEmitter();
        Object.assign(c, { id, kind, type, producerId, paused: false, producerPaused: false });
        c.getStats = async () => [{ type: 'outbound-rtp', bitrate }];
        return c;
    }
    async function guardWith(availKbps, camKbps) {
        const transport = new EventEmitter();
        transport.observer = new EventEmitter();
        transport.enableTraceEvent = async () => {};
        const got = [];
        const g = new MontemeetRecvGuard({
            peerName: 'Мак', transport, send() {}, log: { info() {}, warn() {} }, act: false,
            onBudget: (pid, r) => got.push([pid, r]),
        });
        clearInterval(g.timer);
        g.add(fake('a', 'audio', 'simple', 'mic', 40000), { mediaType: 'audioType' });
        g.add(fake('v', 'video', 'simple', 'cam-samsung', camKbps * 1000), { mediaType: 'videoType', from: 'Samsung' });
        g.add(fake('w', 'video', 'simulcast', 'cam-web', 300000), { mediaType: 'videoType', from: 'Веб' });
        g.add(fake('s', 'video', 'simple', 'screen', 100000), { mediaType: 'screenType', from: 'Веб' });
        if (availKbps !== null) transport.emit('trace', { type: 'bwe', direction: 'out', info: { availableBitrate: availKbps * 1000, desiredBitrate: 5000000 } });
        await g.tick();
        await g.tick();
        return got;
    }

    it('the estimate fell below what flows — chokes: budget = 85 % of it minus everything else; screens and layered video get none', async () => {
        // flows: 40 + 900 + 300 + 100 = 1340; estimate 1000 < 0.9 × 1340 → choke, 0.85 × 1000 − 440 = 410
        assert.deepStrictEqual(await guardWith(1000, 900), [['cam-samsung', { kbps: 410 }]]);
    });

    it('the estimate ≈ what flows (narrow, not choking) — ok: headroom unknown', async () => {
        // flows 40 + 200 + 300 + 100 = 640; estimate 660 — not below 0.9 × 640; budget 0.85 × 660 − 440 = 121 < 2000
        assert.deepStrictEqual(await guardWith(660, 200), [['cam-samsung', 'ok']]);
    });

    it('room for 720p (budget ≥ 2 Mbit/s) — wide', async () => {
        assert.deepStrictEqual(await guardWith(6500, 200), [['cam-samsung', 'wide']]);
    });

    it('no fresh estimate — the report is withdrawn (null), not guessed', async () => {
        assert.deepStrictEqual(await guardWith(null, 900), [['cam-samsung', null]]);
    });
});
