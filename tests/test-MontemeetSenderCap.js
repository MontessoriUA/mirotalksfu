'use strict';

// Montemeet (23.11): a single-layer camera's cap from its receivers' links — the weakest fresh receiver, sent to the
// camera's owner on a real change (>15 %), kept alive every 5 s, null when there is no constraint.

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
    it('no budgets — nothing sent', () => {
        const s = setup();
        s.caps.decide('cam-samsung');
        assert.strictEqual(s.sent.length, 0);
    });

    it('a wide link (≥ 3 Mbit/s for video) is no cap — nothing sent', () => {
        const s = setup();
        s.caps.update('cam-samsung', 'r1', 5600, 'Мак');
        assert.strictEqual(s.sent.length, 0);
    });

    it('a weak receiver — its budget goes to the camera owner', () => {
        const s = setup();
        s.caps.update('cam-samsung', 'r1', 260, 'Мак');
        assert.deepStrictEqual(s.sent, [{ sid: 's-samsung', action: 'montemeetVideoCap', data: { producer_id: 'cam-samsung', kbps: 260, from: 'Мак' } }]);
    });

    it('the weakest of several receivers decides', () => {
        const s = setup();
        s.caps.update('cam-samsung', 'r1', 1200, 'Мак');
        s.caps.update('cam-samsung', 'r2', 300, 'OnePlus');
        assert.deepStrictEqual(s.sent.at(-1).data, { producer_id: 'cam-samsung', kbps: 300, from: 'OnePlus' });
    });

    it('small changes are not resent; >15 % is; every 5 s a keepalive', () => {
        const s = setup();
        s.caps.update('cam-samsung', 'r1', 300, 'Мак');
        s.tick(2000);
        s.caps.update('cam-samsung', 'r1', 330, 'Мак');
        assert.strictEqual(s.sent.length, 1, '+10 % — no');
        s.tick(2000);
        s.caps.update('cam-samsung', 'r1', 400, 'Мак');
        assert.strictEqual(s.sent.length, 2, '+33 % — yes');
        s.tick(5000);
        s.caps.update('cam-samsung', 'r1', 410, 'Мак');
        assert.strictEqual(s.sent.length, 3, 'keepalive after 5 s');
    });

    it('the arch is behind — the link is wide again: the cap is lifted (null) at once', () => {
        const s = setup();
        s.caps.update('cam-samsung', 'r1', 260, 'Мак');
        s.tick(2000);
        s.caps.update('cam-samsung', 'r1', 4700, 'Мак');
        assert.deepStrictEqual(s.sent.at(-1).data, { producer_id: 'cam-samsung', kbps: null, from: '' });
    });

    it('a receiver that left (null) or went silent (> 6 s) no longer holds the cap', () => {
        const s = setup();
        s.caps.update('cam-samsung', 'r1', 260, 'Мак');
        s.caps.update('cam-samsung', 'r1', null);
        assert.strictEqual(s.sent.at(-1).data.kbps, null);
        s.caps.update('cam-samsung', 'r2', 300, 'OnePlus');
        s.tick(7000);
        s.caps.update('cam-samsung', 'r3', 5000, 'Веб');
        assert.strictEqual(s.sent.at(-1).data.kbps, null, 'r2 is stale');
    });

    it('a camera without a known owner — nothing sent, nothing breaks', () => {
        const s = setup();
        s.caps.update('cam-gone', 'r1', 100, 'Мак');
        assert.strictEqual(s.sent.length, 0);
    });
});

describe('MontemeetRecvGuard → budgets (observe mode)', () => {
    function fake(id, kind, type, producerId, bitrate) {
        const c = new EventEmitter();
        c.observer = new EventEmitter();
        Object.assign(c, { id, kind, type, producerId, paused: false, producerPaused: false });
        c.getStats = async () => [{ type: 'outbound-rtp', bitrate }];
        return c;
    }

    it('a camera budget = 85 % of the estimate minus everything else flowing; layered video and screens get none', async () => {
        const transport = new EventEmitter();
        transport.observer = new EventEmitter();
        transport.enableTraceEvent = async () => {};
        const got = [];
        const g = new MontemeetRecvGuard({
            peerName: 'Мак', transport, send() {}, log: { info() {}, warn() {} }, act: false,
            onBudget: (pid, kbps) => got.push([pid, kbps]),
        });
        clearInterval(g.timer);
        g.add(fake('a', 'audio', 'simple', 'mic', 40000), { mediaType: 'audioType' });
        g.add(fake('v', 'video', 'simple', 'cam-samsung', 900000), { mediaType: 'videoType', from: 'Samsung' });
        g.add(fake('w', 'video', 'simulcast', 'cam-web', 300000), { mediaType: 'videoType', from: 'Веб' });
        g.add(fake('s', 'video', 'simple', 'screen', 100000), { mediaType: 'screenType', from: 'Веб' });
        transport.emit('trace', { type: 'bwe', direction: 'out', info: { availableBitrate: 1000000, desiredBitrate: 5000000 } });
        await g.tick();
        await g.tick();
        // 0.85 × 1000 − (40 + 300 + 100) = 410
        assert.deepStrictEqual(got, [['cam-samsung', 410]]);
    });

    it('no fresh estimate — the budget is withdrawn (null), not guessed', async () => {
        const transport = new EventEmitter();
        transport.observer = new EventEmitter();
        transport.enableTraceEvent = async () => {};
        const got = [];
        const g = new MontemeetRecvGuard({
            peerName: 'Мак', transport, send() {}, log: { info() {}, warn() {} }, act: false,
            onBudget: (pid, kbps) => got.push([pid, kbps]),
        });
        clearInterval(g.timer);
        g.add(fake('v', 'video', 'simple', 'cam-samsung', 900000), { mediaType: 'videoType' });
        await g.tick();
        await g.tick();
        assert.deepStrictEqual(got, [['cam-samsung', null]]);
    });
});
