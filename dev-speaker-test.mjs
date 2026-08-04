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
        speechOnce: make('speech8-silence22.wav', [...speechSegments(8, 440), { seconds: 22, freq: 0 }]),
        guestTurn: make('silence5-speech8-silence22.wav', [
            { seconds: 5, freq: 0 },
            ...speechSegments(8, 440),
            { seconds: 22, freq: 0 },
        ]),
    };
}

// ---------- peers ----------

function delay(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

async function launchPeer(name, audioFile, { audio = 1, video = 1, focusFollow = false, room = ROOM } = {}) {
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
            if (data?.peer_name) events.push({ t: Date.now(), name: data.peer_name, peerId: data.peer_id });
        } catch (e) {
            /* page closing */
        }
    });
    await page.goto(`${BASE}/join/${room}?name=${name}&audio=${audio}&video=${video}&notify=0`, {
        waitUntil: 'networkidle2',
        timeout: 30000,
    });
    if (focusFollow) {
        // enable stock auto-focus on dominant speaker (the checkbox is read live)
        await page.evaluate(() => {
            const el = document.getElementById('switchDominantSpeakerFocus');
            if (el) el.checked = true;
        });
    }
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

// Focus scenario: the Observer runs the stock dominant-speaker auto-focus and
// we assert that the [focus-mode] attribute follows whoever is speaking.
async function runFocusScenario(seconds) {
    const observer = await launchPeer('Observer', null, { audio: 0, video: 0 });
    await delay(2000);
    const zal = await launchPeer('Zal', fixtures.speechThenSilence);
    await delay(3000);
    const guest = await launchPeer('Guest1', fixtures.silenceThenSpeech);
    await delay(1000);

    // enable auto-focus AFTER the join flow settled — the settings restore from
    // localStorage would otherwise overwrite the checkbox we just flipped
    const debug = await observer.page.evaluate(() => {
        const el = document.getElementById('switchDominantSpeakerFocus');
        if (el) el.checked = true;
        return {
            checkboxFound: !!el,
            roomDominantFlag: typeof rc !== 'undefined' ? rc.dominantSpeaker : null,
            layoutOwner: typeof MontemeetLayout !== 'undefined',
        };
    });

    const samples = [];
    const started = Date.now();
    while (Date.now() - started < seconds * 1000) {
        await delay(2000);
        const focusedPeerId = await observer.page.evaluate(
            () => document.querySelector('#videoMediaContainer [focus-mode] video[name]')?.getAttribute('name') ?? null
        );
        samples.push(focusedPeerId);
    }

    const idToName = {};
    for (const e of observer.events) if (e.peerId) idToName[e.peerId] = e.name;
    const focusedNames = [...new Set(samples.filter(Boolean).map((id) => idToName[id] || id))];

    const summary = summarize(observer.events);
    await observer.browser.close();
    await zal.browser.close();
    await guest.browser.close();
    return { scenario: 'focus', observerPeer: 'Observer', debug, focusedNames, ...summary };
}

// Anchor scenario (stage 2.2): in an anchored room the presenter (Zal, joins
// first) is the default view. A speaking guest takes the focus over (dominant),
// and after the speech + the 10s inactivity timeout the view RETURNS to the
// anchor instead of falling back to the grid.
async function runAnchorScenario() {
    const room = 'montemeet-anchor';
    const zal = await launchPeer('Zal', fixtures.silence, { room });
    await delay(3000);
    const observer = await launchPeer('Observer', null, { room, audio: 0, video: 0 });
    await delay(5000); // consumer setup + anchor MutationObserver debounce

    // enable auto-focus late — the settings restore overwrites an early flip
    await observer.page.evaluate(() => {
        const el = document.getElementById('switchDominantSpeakerFocus');
        if (el) el.checked = true;
    });

    const focusedPeer = () =>
        observer.page.evaluate(
            () => document.querySelector('#videoMediaContainer [focus-mode] video[name]')?.getAttribute('name') ?? null
        );
    const peerNames = () =>
        observer.page.evaluate(() =>
            Object.fromEntries([...rc.peers].map(([id, p]) => [id, p?.peer_info?.peer_name ?? '?']))
        );

    const anchoredBeforeGuest = await focusedPeer();

    const guest = await launchPeer('Guest1', fixtures.speechOnce, { room });
    await delay(4000);
    const debugState = await observer.page.evaluate(() => ({
        checkbox: document.getElementById('switchDominantSpeakerFocus')?.checked ?? null,
        roomDominantFlag: rc?.dominantSpeaker ?? null,
        consumers: rc?.consumers?.size ?? -1,
    }));
    const samples = [];
    for (let i = 0; i < 12; i++) {
        await delay(2000);
        samples.push(await focusedPeer());
    }

    // rc.peers is a join-time snapshot (late joiners missing) — merge in the
    // names carried by dominantSpeaker events
    const names = await peerNames();
    for (const e of observer.events) if (e.peerId) names[e.peerId] = e.name;
    const nameOf = (id) => (id ? (names[id] ?? id) : null);
    const focusedSequence = [];
    for (const s of samples.map(nameOf)) {
        if (!focusedSequence.length || focusedSequence[focusedSequence.length - 1] !== s) focusedSequence.push(s);
    }

    await observer.browser.close();
    await zal.browser.close();
    await guest.browser.close();
    return {
        scenario: 'anchor',
        observerPeer: 'Observer',
        anchoredBeforeGuest: nameOf(anchoredBeforeGuest),
        focusedSequence,
        finalFocus: nameOf(samples[samples.length - 1]),
        debugEvents: observer.events.map((e) => e.name),
        debugState,
    };
}

// Concert scenario (stage 2.3, ТЗ §5). Three peers, three perspectives:
//   Zal    — presenter/Host (the hall), silent, own tile hidden, grid by default;
//   Guest1 — sings at ~5-13s (dominant), otherwise silent;
//   Guest2 — silent guest, must watch the Зал by default.
// Expectations: silence -> Host: grid, Guests: focus on Зал; Guest1 speaking ->
// Host & Guest2 focus Guest1, while Guest1 himself keeps watching the Зал
// (dom == self -> anchor); after the speech + silenceMs -> back to defaults.
async function runConcertScenario() {
    const room = 'montemeet-concert';
    const zal = await launchPeer('Zal', fixtures.silence, { room });
    await delay(3000);
    const guest1 = await launchPeer('Guest1', fixtures.guestTurn, { room });
    const guest2 = await launchPeer('Guest2', fixtures.silence, { room });
    await delay(2000);

    const idOf = (p) => p.page.evaluate(() => rc.peer_id);
    const ids = { zal: await idOf(zal), guest1: await idOf(guest1), guest2: await idOf(guest2) };
    const nameById = Object.fromEntries(Object.entries(ids).map(([k, v]) => [v, k]));

    // the concert big view is a PIN on desktop (focus on mobile) — read both
    const focusedOn = (p) =>
        p.page.evaluate(
            () =>
                document.querySelector('#videoPinMediaContainer video[name]')?.getAttribute('name') ??
                document.querySelector('#videoMediaContainer [focus-mode] video[name]')?.getAttribute('name') ??
                null
        );
    const selfHidden = (p) =>
        p.page.evaluate(() => {
            const videoEl = rc.getVideoElementByPeerId(rc.peer_id);
            const c = videoEl ? document.getElementById(videoEl.id + '__video') : null;
            return c ? c.style.display === 'none' : null;
        });

    const samples = [];
    const started = Date.now();
    for (let i = 0; i < 14; i++) {
        await delay(2000);
        samples.push({
            t: Math.round((Date.now() - started) / 1000),
            zalSees: nameById[await focusedOn(zal)] ?? null,
            guest1Sees: nameById[await focusedOn(guest1)] ?? null,
            guest2Sees: nameById[await focusedOn(guest2)] ?? null,
        });
    }
    const hidden = { zal: await selfHidden(zal), guest2: await selfHidden(guest2) };

    await zal.browser.close();
    await guest1.browser.close();
    await guest2.browser.close();

    const early = samples.filter((s) => s.t <= 4);
    const mid = samples.filter((s) => s.t >= 10 && s.t <= 16);
    const late = samples.filter((s) => s.t >= 24);
    return {
        scenario: 'concert',
        hidden,
        samples,
        checks: {
            earlyDefaults: early.some((s) => s.zalSees === null && s.guest2Sees === 'zal'),
            guestTakeover: mid.some((s) => s.zalSees === 'guest1' && s.guest2Sees === 'guest1'),
            performerWatchesZal: samples.every((s) => s.guest1Sees === 'zal' || s.guest1Sees === null),
            backToDefaults: late.length > 0 && late.every((s) => s.zalSees === null && s.guest2Sees === 'zal'),
            selfHidden: hidden.zal === true && hidden.guest2 === true,
        },
    };
}

// Group lesson scenario (stage 2.4). Teacher (presenter) + two students in an
// anchored room with view:'pin': students must see the teacher pinned big with
// a strip of tiles (the other student AND themselves — lessons don't hide
// self); the teacher keeps the plain grid of students (no pin, no focus).
async function runGroupScenario() {
    const room = 'montemeet-group';
    const teacher = await launchPeer('Teacher', fixtures.silence, { room });
    await delay(3000);
    const student1 = await launchPeer('Student1', fixtures.silence, { room });
    const student2 = await launchPeer('Student2', fixtures.silence, { room });
    await delay(6000);

    const teacherId = await teacher.page.evaluate(() => rc.peer_id);
    const view = (p) =>
        p.page.evaluate(() => ({
            pinned: rc.isVideoPinned === true,
            pinnedPeer: document.querySelector('#videoPinMediaContainer video[name]')?.getAttribute('name') ?? null,
            focused: document.querySelector('#videoMediaContainer [focus-mode]') !== null,
            stripTiles: [...document.querySelectorAll('#videoMediaContainer .Camera')].filter(
                (c) => c.style.display !== 'none'
            ).length,
        }));

    const teacherView = await view(teacher);
    const s1View = await view(student1);
    const s2View = await view(student2);

    await teacher.browser.close();
    await student1.browser.close();
    await student2.browser.close();

    return {
        scenario: 'group',
        teacherView,
        s1View,
        s2View,
        checks: {
            studentsSeeTeacherPinned:
                s1View.pinned && s1View.pinnedPeer === teacherId && s2View.pinned && s2View.pinnedPeer === teacherId,
            studentsKeepTileStrip: s1View.stripTiles >= 2 && s2View.stripTiles >= 2,
            teacherKeepsGrid: !teacherView.pinned && !teacherView.focused && teacherView.stripTiles >= 2,
        },
    };
}

// Teacher's view cycle (2.4+, Ivan 2026-08-04): grid → sticky (last speaker
// stays pinned, silence changes nothing) → auto (speaker pinned, silence
// returns the grid) → grid. Student1 sings at ~5-13s. One click before the
// speech puts the teacher into STICKY: Student1 must be pinned during the
// speech AND stay pinned through the silence after it. Two more clicks
// (auto → grid) must unpin. Also asserts the Appendix A toolbar trim.
async function runGroupSpeakerScenario() {
    const room = 'montemeet-group';
    const teacher = await launchPeer('Teacher', fixtures.silence, { room });
    await delay(3000);
    const student1 = await launchPeer('Student1', fixtures.guestTurn, { room });
    const student2 = await launchPeer('Student2', fixtures.silence, { room });
    await delay(2000);

    const ids = {
        student1: await student1.page.evaluate(() => rc.peer_id),
    };
    const clickCycle = (p) =>
        p.page.evaluate(() => {
            const btn = document.getElementById('montemeetSpeakerViewBtn');
            if (!btn) return false;
            btn.click();
            return true;
        });
    const clicked = await clickCycle(teacher); // grid → sticky

    const pinnedOn = (p) =>
        p.page.evaluate(
            () => document.querySelector('#videoPinMediaContainer video[name]')?.getAttribute('name') ?? null
        );
    const visible = (p, id) =>
        p.page.evaluate((elId) => {
            const el = document.getElementById(elId);
            return !!el && getComputedStyle(el).display !== 'none';
        }, id);

    const samples = [];
    const started = Date.now();
    for (let i = 0; i < 13; i++) {
        await delay(2000);
        samples.push({
            t: Math.round((Date.now() - started) / 1000),
            teacherPin: (await pinnedOn(teacher)) === ids.student1 ? 'student1' : ((await pinnedOn(teacher)) ? 'other' : null),
        });
    }

    await clickCycle(teacher); // sticky → auto
    await clickCycle(teacher); // auto → grid (unpins)
    await delay(1500);
    const afterGridClick = await pinnedOn(teacher);

    const toolbar = {
        teacherPollHidden: !(await visible(teacher, 'pollButton')),
        teacherShareVisible: await visible(teacher, 'shareButton'),
        studentShareHidden: !(await visible(student2, 'shareButton')),
        studentEmojiHidden: !(await visible(student2, 'emojiRoomButton')),
    };

    await teacher.browser.close();
    await student1.browser.close();
    await student2.browser.close();

    const mid = samples.filter((s) => s.t >= 9 && s.t <= 15);
    const late = samples.filter((s) => s.t >= 22);
    return {
        scenario: 'group-speaker',
        samples,
        toolbar,
        checks: {
            buttonFound: clicked,
            speakerPinned: mid.some((s) => s.teacherPin === 'student1'),
            stickyThroughSilence: late.length > 0 && late.every((s) => s.teacherPin === 'student1'),
            gridClickUnpins: afterGridClick === null,
            toolbarTrimmed: Object.values(toolbar).every(Boolean),
        },
    };
}

// Solo (1:1) lesson layout: exactly two participants → Google-Meet style on
// BOTH sides (companion fullscreen, self as a corner overlay, view button
// hidden); a third participant joining returns the group layout.
async function runSoloScenario() {
    const room = 'montemeet-group';
    const teacher = await launchPeer('Teacher', fixtures.silence, { room });
    await delay(3000);
    const student1 = await launchPeer('Student1', fixtures.silence, { room });
    await delay(8000);

    const ids = {
        teacher: await teacher.page.evaluate(() => rc.peer_id),
        student1: await student1.page.evaluate(() => rc.peer_id),
    };
    const soloState = (p) =>
        p.page.evaluate(() => ({
            solo: document.body.classList.contains('montemeet-solo'),
            pip: !!document.querySelector('.montemeet-self-pip'),
            focused:
                document.querySelector('#videoMediaContainer [focus-mode] video[name]')?.getAttribute('name') ?? null,
            btnHidden: (() => {
                const b = document.getElementById('montemeetSpeakerViewBtn');
                return !b || b.style.display === 'none';
            })(),
        }));
    const teacherSolo = await soloState(teacher);
    const studentSolo = await soloState(student1);

    const student2 = await launchPeer('Student2', fixtures.silence, { room });
    await delay(8000);
    const teacherAfter = await soloState(teacher);
    const student2Pin = await student2.page.evaluate(
        () => document.querySelector('#videoPinMediaContainer video[name]')?.getAttribute('name') ?? null
    );

    await teacher.browser.close();
    await student1.browser.close();
    await student2.browser.close();

    return {
        scenario: 'solo-lesson',
        teacherSolo,
        studentSolo,
        teacherAfter,
        checks: {
            soloOnAtTwo: teacherSolo.solo && studentSolo.solo && teacherSolo.pip && studentSolo.pip,
            companionsFocused: teacherSolo.focused === ids.student1 && studentSolo.focused === ids.teacher,
            buttonHiddenInSolo: teacherSolo.btnHidden,
            groupRestoredAtThree: !teacherAfter.solo && student2Pin === ids.teacher,
        },
    };
}

const fixtures = ensureFixtures();
const which = process.argv[2] || 'all';
const results = [];

if (which === 'solo' || which === 'both' || which === 'all') {
    const r = await runScenario('solo', fixtures.speech, fixtures.silence, 20);
    // change-only events: Zal is usually elected during warm-up and stays dominant,
    // so require: final dominant is Zal AND nobody else was elected after warm-up
    r.pass = r.lastName === 'Zal' && r.names.every((n) => n === 'Zal');
    results.push(r);
}
if (which === 'alternate' || which === 'both' || which === 'all') {
    const r = await runScenario('alternate', fixtures.speechThenSilence, fixtures.silenceThenSpeech, 40);
    r.pass = r.names.includes('Zal') && r.names.includes('Guest1') && r.switchSequence.length >= 2;
    results.push(r);
}
if (which === 'focus' || which === 'all') {
    const r = await runFocusScenario(40);
    r.pass = r.focusedNames.includes('Zal') && r.focusedNames.includes('Guest1');
    results.push(r);
}
if (which === 'anchor' || which === 'all') {
    const r = await runAnchorScenario();
    r.pass =
        r.anchoredBeforeGuest === 'Zal' && // anchor is the default view
        r.focusedSequence.includes('Guest1') && // the speaker takes over
        r.finalFocus === 'Zal'; // and the view returns to the anchor
    results.push(r);
}
if (which === 'concert' || which === 'all') {
    const r = await runConcertScenario();
    r.pass = Object.values(r.checks).every(Boolean);
    results.push(r);
}
if (which === 'group' || which === 'all') {
    const r = await runGroupScenario();
    r.pass = Object.values(r.checks).every(Boolean);
    results.push(r);
}
if (which === 'group-speaker' || which === 'all') {
    const r = await runGroupSpeakerScenario();
    r.pass = Object.values(r.checks).every(Boolean);
    results.push(r);
}
if (which === 'solo-lesson' || which === 'all') {
    const r = await runSoloScenario();
    r.pass = Object.values(r.checks).every(Boolean);
    results.push(r);
}

console.log(JSON.stringify(results, null, 2));
process.exitCode = results.every((r) => r.pass) ? 0 : 1;
