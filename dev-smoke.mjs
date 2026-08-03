// Montemeet dev smoke: two headless peers join the same MiroTalk room with fake media.
import puppeteer from 'puppeteer-core';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const BASE = 'https://localhost:3010';
const ROOM = 'montemeet-smoke';
const OUT = process.env.OUT_DIR || '.';

const flags = [
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    '--mute-audio',
    '--ignore-certificate-errors',
];

async function launchPeer(name) {
    const browser = await puppeteer.launch({
        executablePath: CHROME,
        headless: true,
        acceptInsecureCerts: true,
        args: flags,
    });
    const page = await browser.newPage();
    await page.setUserAgent(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36'
    );
    await page.setViewport({ width: 1280, height: 800 });
    const errors = [];
    page.on('console', (msg) => {
        if (msg.type() === 'error') errors.push(msg.text().slice(0, 300));
    });
    page.on('pageerror', (err) => errors.push('PAGEERROR: ' + String(err).slice(0, 300)));
    await page.goto(`${BASE}/join/${ROOM}?name=${name}&audio=1&video=1&notify=0`, {
        waitUntil: 'networkidle2',
        timeout: 30000,
    });
    return { browser, page, errors, name };
}

function delay(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

async function inspect(peer) {
    return peer.page.evaluate(() => {
        const cams = document.querySelectorAll('#videoMediaContainer .Camera, #videoPinMediaContainer .Camera');
        const names = [...document.querySelectorAll('.videoPeerName, [id$="__name"]')].map((e) =>
            e.textContent.trim()
        );
        return {
            cameras: cams.length,
            names,
            socketConnected: typeof rc !== 'undefined' && rc?.socket?.connected === true,
            producers: typeof rc !== 'undefined' && rc?.producers ? rc.producers.size : -1,
            consumers: typeof rc !== 'undefined' && rc?.consumers ? rc.consumers.size : -1,
        };
    });
}

const peer1 = await launchPeer('Zal');
await delay(4000);
const peer2 = await launchPeer('Guest1');
await delay(8000);

const s1 = await inspect(peer1);
const s2 = await inspect(peer2);

await peer1.page.screenshot({ path: `${OUT}/peer1-zal.png` });
await peer2.page.screenshot({ path: `${OUT}/peer2-guest.png` });

console.log(JSON.stringify({ peer1: s1, peer2: s2, errors1: peer1.errors.slice(0, 5), errors2: peer2.errors.slice(0, 5) }, null, 2));

await peer1.browser.close();
await peer2.browser.close();
