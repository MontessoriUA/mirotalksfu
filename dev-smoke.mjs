// Montemeet dev smoke: two headless peers join a MiroTalk room with fake media.
// Verifies the full produce/consume path and the applied room audio profile.
// Usage: node dev-smoke.mjs [roomName]   (default: runs montemeet-smoke + montemeet-smoke-default)
import puppeteer from 'puppeteer-core';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const BASE = 'https://localhost:3010';
const OUT = process.env.OUT_DIR || '.';

const flags = [
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    '--mute-audio',
    '--ignore-certificate-errors',
];

const UA =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';

function delay(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

async function launchPeer(room, name) {
    const browser = await puppeteer.launch({
        executablePath: CHROME,
        headless: true,
        acceptInsecureCerts: true,
        args: flags,
    });
    const page = await browser.newPage();
    await page.setUserAgent(UA);
    await page.setViewport({ width: 1280, height: 800 });
    const errors = [];
    page.on('console', (msg) => {
        if (msg.type() === 'error') errors.push(msg.text().slice(0, 300));
    });
    page.on('pageerror', (err) => errors.push('PAGEERROR: ' + String(err).slice(0, 300)));
    await page.goto(`${BASE}/join/${room}?name=${name}&audio=1&video=1&notify=0`, {
        waitUntil: 'networkidle2',
        timeout: 30000,
    });
    return { browser, page, errors, name };
}

async function inspect(peer) {
    return peer.page.evaluate(() => {
        const cams = document.querySelectorAll('#videoMediaContainer .Camera, #videoPinMediaContainer .Camera');
        const audioProducer = [...(rc?.producers?.values?.() || [])].find((p) => (p.kind ?? p._kind) === 'audio');
        const track = audioProducer?.track ?? audioProducer?._track ?? null;
        const rtp = audioProducer?.rtpParameters ?? audioProducer?._rtpParameters ?? null;
        return {
            cameras: cams.length,
            socketConnected: typeof rc !== 'undefined' && rc?.socket?.connected === true,
            producers: rc?.producers?.size ?? -1,
            consumers: rc?.consumers?.size ?? -1,
            profile: typeof MontemeetProfile !== 'undefined' ? MontemeetProfile.get() : 'no MontemeetProfile',
            audioSettings: track?.getSettings?.() ?? null,
            opusParams: rtp?.codecs?.[0]?.parameters ?? null,
        };
    });
}

async function runRoom(room) {
    const peer1 = await launchPeer(room, 'Zal');
    await delay(4000);
    const peer2 = await launchPeer(room, 'Guest1');
    await delay(8000);

    const result = {
        room,
        peer1: await inspect(peer1),
        peer2: await inspect(peer2),
        errors1: peer1.errors.slice(0, 5),
        errors2: peer2.errors.slice(0, 5),
    };

    await peer1.page.screenshot({ path: `${OUT}/${room}-peer1.png` });
    await peer2.page.screenshot({ path: `${OUT}/${room}-peer2.png` });

    await peer1.browser.close();
    await peer2.browser.close();
    return result;
}

const rooms = process.argv[2] ? [process.argv[2]] : ['montemeet-smoke', 'montemeet-smoke-default'];
for (const room of rooms) {
    console.log(JSON.stringify(await runRoom(room), null, 2));
}
