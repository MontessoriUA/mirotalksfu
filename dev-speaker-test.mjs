// Montemeet dev speaker test: control WHO SPEAKS via per-peer fake-audio wav files
// and assert the dominantSpeaker event stream. Foundation for concert layout tests.
//
// Scenarios:
//   solo      — Zal plays a tone, Guest is silent  -> every dominant event names Zal
//   alternate — Zal: 8s tone / 8s silence, Guest: 8s silence / 8s tone (looped)
//               -> both peers become dominant, focus switches at least twice
//
// Usage: node dev-speaker-test.mjs [solo|alternate]   (default: both)
// Requires: MEDIASOUP_ROUTER_ACTIVE_SPEAKER_OBSERVER_ENABLED=true and a music-profile
// room (montemeet-smoke) so RNNoise does not eat the pure sine tone.

import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const BASE = 'https://localhost:3010';
const ROOM = 'montemeet-smoke';
const FIXTURES = path.join(import.meta.dirname, 'dev-fixtures');

const UA =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';

// ---------- WAV fixtures (48 kHz mono 16-bit PCM) ----------

function writeWav(file, segments) {
    const RATE = 48000;
    const totalSamples = segments.reduce((n, s) => n + Math.round(s.seconds * RATE), 0);
    const data = Buffer.alloc(totalSamples * 2);
    let offset = 0;
    for (const seg of segments) {
        const n = Math.round(seg.seconds * RATE);
        for (let i = 0; i < n; i++) {
            const v = seg.freq ? Math.round(Math.sin((2 * Math.PI * seg.freq * i) / RATE) * 12000) : 0;
            data.writeInt16LE(v, (offset + i) * 2);
        }
        offset += n;
    }
    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + data.length, 4);
    header.write('WAVEfmt ', 8);
    header.writeUInt32LE(16, 16); // fmt chunk size
    header.writeUInt16LE(1, 20); // PCM
    header.writeUInt16LE(1, 22); // mono
    header.writeUInt32LE(RATE, 24);
    header.writeUInt32LE(RATE * 2, 28); // byte rate
    header.writeUInt16LE(2, 32); // block align
    header.writeUInt16LE(16, 34); // bits
    header.write('data', 36);
    header.writeUInt32LE(data.length, 40);
    fs.writeFileSync(file, Buffer.concat([header, data]));
}

// mediasoup's dominant speaker detection looks for SPEECH-like activity;
// a stationary sine reads as noise and never wins. Emulate syllables:
// short tone bursts (~0.15-0.25s) with pauses and varying pitch.
function speechSegments(seconds, baseFreq) {
    const segs = [];
    let t = 0;
    let i = 0;
    while (t < seconds) {
        const on = 0.15 + (0.05 * ((i * 7) % 3));
        const off = 0.08 + 0.02 * ((i * 5) % 4);
        const freq = Math.round(baseFreq * (0.85 + 0.075 * ((i * 3) % 5)));
        segs.push({ seconds: on, freq }, { seconds: off, freq: 0 });
        t += on + off;
        i++;
    }
    return segs;
}

function ensureFixtures() {
    fs.mkdirSync(FIXTURES, { recursive: true });
    const make = (name, segments) => {
        const file = path.join(FIXTURES, name);
        if (!fs.existsSync(file)) writeWav(file, segments);
        return file;
    };
    return {
        speech: make('speech.wav', speechSegments(30, 440)),
        silence: make('silence.wav', [{ seconds: 30, freq: 0 }]),
        speechThenSilence: make('speech8-silence8.wav', [...speechSegments(8, 440), { seconds: 8, freq: 0 }]),
        silenceThenSpeech: make('silence8-speech8.wav', [{ seconds: 8, freq: 0 }, ...speechSegments(8, 330)]),
    };
}

// ---------- peers ----------

function delay(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

async function launchPeer(name, audioFile, { audio = 1, video = 1 } = {}) {
    const args = [
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream',
        '--autoplay-policy=no-user-gesture-required',
        '--mute-audio',
        '--ignore-certificate-errors',
        // without this the fake-audio-capture FILE silently yields silence
        '--disable-features=AudioServiceOutOfProcess,AudioServiceSandbox',
    ];
    if (audioFile) args.splice(1, 0, `--use-file-for-fake-audio-capture=${audioFile}`);
    const browser = await puppeteer.launch({
        executablePath: CHROME,
        headless: true,
        acceptInsecureCerts: true,
        args,
    });
    const page = await browser.newPage();
    await page.setUserAgent(UA);
    // Collect dominantSpeaker events via the client handler's console.log
    // ('Dominant Speaker', data) — resolving the logged object through puppeteer.
    const events = [];
    page.on('console', async (msg) => {
        if (!msg.text().startsWith('Dominant Speaker')) return;
        try {
            const data = await msg.args()[1]?.jsonValue();
            if (data?.peer_name) events.push({ t: Date.now(), name: data.peer_name });
        } catch (e) {
            /* page closing */
        }
    });
    await page.goto(`${BASE}/join/${ROOM}?name=${name}&audio=${audio}&video=${video}&notify=0`, {
        waitUntil: 'networkidle2',
        timeout: 30000,
    });
    return { browser, page, name, events };
}

function summarize(events) {
    const switches = [];
    for (const e of events) {
        if (!switches.length || switches[switches.length - 1].name !== e.name) {
            switches.push({ name: e.name, t: e.t });
        }
    }
    return {
        totalEvents: events.length,
        names: [...new Set(events.map((e) => e.name))],
        switchSequence: switches.map((s) => s.name),
    };
}

// ---------- scenarios ----------

// mediasoup's activeSpeakerObserver fires only on CHANGE of the dominant speaker,
// so a silent Observer joins FIRST and listens before anyone produces audio.
// Warm-up noise (elections among still-silent peers) is cut off by measuring
// only from `measureFrom` — a moment after the last peer has joined.
async function runScenario(title, zalFile, guestFile, seconds) {
    const observer = await launchPeer('Observer', null, { audio: 0, video: 0 });
    await delay(2000);
    const zal = await launchPeer('Zal', zalFile);
    await delay(3000);
    const guest = await launchPeer('Guest1', guestFile);
    const measureFrom = Date.now() + 3000;
    await delay(seconds * 1000);

    const all = observer.events;
    const summary = summarize(all.filter((e) => e.t >= measureFrom));
    await observer.browser.close();
    await zal.browser.close();
    await guest.browser.close();
    return {
        scenario: title,
        observerPeer: 'Observer',
        warmupEvents: all.length - summary.totalEvents,
        lastName: all.length ? all[all.length - 1].name : null,
        ...summary,
    };
}

const fixtures = ensureFixtures();
const which = process.argv[2] || 'both';
const results = [];

if (which === 'solo' || which === 'both') {
    const r = await runScenario('solo', fixtures.speech, fixtures.silence, 20);
    // change-only events: Zal is usually elected during warm-up and stays dominant,
    // so require: final dominant is Zal AND nobody else was elected after warm-up
    r.pass = r.lastName === 'Zal' && r.names.every((n) => n === 'Zal');
    results.push(r);
}
if (which === 'alternate' || which === 'both') {
    const r = await runScenario('alternate', fixtures.speechThenSilence, fixtures.silenceThenSpeech, 40);
    r.pass = r.names.includes('Zal') && r.names.includes('Guest1') && r.switchSequence.length >= 2;
    results.push(r);
}

console.log(JSON.stringify(results, null, 2));
process.exitCode = results.every((r) => r.pass) ? 0 : 1;
