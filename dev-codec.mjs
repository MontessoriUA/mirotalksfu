// Montemeet dev: какой видеокодек шлёт веб и с какими слоями (02.10.2026, H.264 первым).
//
// Два headless-участника с фальшивой камерой входят в одну комнату. Для каждого печатается:
// кодек и слои (rid, scalabilityMode) своего продюсера камеры, кодек принятого видео
// собеседника и по каждому слою отправки — кодек, кадры, ширина, причина ограничения.
//
// Usage: node dev-codec.mjs [room] [base]   (по умолчанию montemeet-smoke, https://localhost:3010)
import puppeteer from 'puppeteer-core';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ROOM = process.argv[2] || 'montemeet-smoke';
const BASE = process.argv[3] || 'https://localhost:3010';
const flags = [
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    '--mute-audio',
    '--ignore-certificate-errors',
];

// Без подмены mediasoup-client не узнаёт HeadlessChrome: «device not supported» (как в dev-smoke).
const UA =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function launchPeer(name) {
    const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, acceptInsecureCerts: true, args: flags });
    const page = await browser.newPage();
    await page.setUserAgent(UA);
    await page.setViewport({ width: 1280, height: 800 });
    const errors = [];
    page.on('console', (msg) => {
        const t = msg.text();
        if (msg.type() === 'error') errors.push(t.slice(0, 300));
        if (t.startsWith('Montemeet: H264')) errors.push('note: ' + t.slice(0, 200));
    });
    page.on('pageerror', (err) => errors.push('PAGEERROR: ' + String(err).slice(0, 300)));
    await page.goto(`${BASE}/join/${ROOM}?name=${name}&audio=1&video=1&notify=0`, { waitUntil: 'networkidle2', timeout: 30000 });
    return { browser, page, errors, name };
}

async function inspect(peer) {
    return peer.page.evaluate(async () => {
        const all = [...(rc?.producers?.values?.() || [])];
        const cam = all.find((p) => (p.kind ?? p._kind) === 'video');
        const rtp = cam?.rtpParameters ?? cam?._rtpParameters ?? null;
        const consumers = [...(rc?.consumers?.values?.() || [])].filter((c) => (c.kind ?? c._kind) === 'video');
        const out = [];
        const sender = cam?.rtpSender ?? cam?._rtpSender;
        if (sender) {
            const stats = await sender.getStats();
            const codecs = {};
            stats.forEach((s) => {
                if (s.type === 'codec') codecs[s.id] = s.mimeType;
            });
            stats.forEach((s) => {
                if (s.type === 'outbound-rtp')
                    out.push({
                        rid: s.rid,
                        codec: codecs[s.codecId],
                        frames: s.framesEncoded,
                        width: s.frameWidth,
                        limit: s.qualityLimitationReason,
                        encoder: s.encoderImplementation,
                        scalabilityMode: s.scalabilityMode,
                    });
            });
        }
        return {
            sendCodecFirst: rc?.device?.sendRtpCapabilities?.codecs?.find((c) => c.kind === 'video')?.mimeType ?? null,
            producerCodec: rtp?.codecs?.[0]?.mimeType ?? null,
            producerEncodings: (rtp?.encodings || []).map((e) => ({ rid: e.rid, scalabilityMode: e.scalabilityMode })),
            consumerCodecs: consumers.map((c) => (c.rtpParameters ?? c._rtpParameters)?.codecs?.[0]?.mimeType ?? null),
            outbound: out,
        };
    });
}

const p1 = await launchPeer('Zal');
await delay(4000);
const p2 = await launchPeer('Guest1');
await delay(10000);
const result = {
    room: ROOM,
    p1: await inspect(p1),
    p2: await inspect(p2),
    notes1: p1.errors.slice(0, 6),
    notes2: p2.errors.slice(0, 6),
};
console.log(JSON.stringify(result, null, 2));
await p1.browser.close();
await p2.browser.close();
