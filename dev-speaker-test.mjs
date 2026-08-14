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

// overridable so the same suite can be pointed at a real deployment:
//   MM_TEST_BASE=http://192.168.35.11 node dev-speaker-test.mjs
const CHROME = process.env.MM_TEST_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const BASE = process.env.MM_TEST_BASE || 'https://localhost:3010';
const ROOM = 'montemeet-smoke';
const FIXTURES = path.join(import.meta.dirname, 'dev-fixtures');

const UA =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';
// телефон: от него зависит и ветка раскладки (закрепление против фокуса), и
// признак сенсорного экрана, по которому включается мобильная вёрстка сетки
const PHONE_UA =
    'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Mobile Safari/537.36';

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
        const on = 0.15 + 0.05 * ((i * 7) % 3);
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
        // Концертному сценарию нужен изрядный запас тишины В НАЧАЛЕ: от запуска
        // браузера до первого замера проходит от трёх до двенадцати секунд, и
        // разбег гуляет вместе с загрузкой машины. Двадцать пять секунд тишины
        // держат «до выступления» тишиной при любом разбеге.
        concertTurn: make('silence25-speech8-silence20.wav', [
            { seconds: 25, freq: 0 },
            ...speechSegments(8, 440),
            { seconds: 20, freq: 0 },
        ]),
    };
}

// ---------- peers ----------

function delay(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

async function launchPeer(
    name,
    audioFile,
    { audio = 1, video = 1, focusFollow = false, room = ROOM, phone = false } = {}
) {
    const args = [
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream',
        '--autoplay-policy=no-user-gesture-required',
        '--mute-audio',
        '--ignore-certificate-errors',
        // AudioService*: without this the fake-audio-capture FILE yields silence.
        // Https*: Chrome 141+ silently upgrades http navigations to https, which
        // kills any run against an http-only stand (ERR_CONNECTION_REFUSED).
        '--disable-features=AudioServiceOutOfProcess,AudioServiceSandbox,HttpsUpgrades,HttpsFirstBalancedModeAutoEnable',
    ];
    // headless Linux (a server run) has no usable sandbox namespace
    if (process.platform === 'linux') args.push('--no-sandbox', '--disable-dev-shm-usage');
    // getUserMedia needs a secure context: plain http is only trusted for
    // localhost, so a remote http stand has to be whitelisted explicitly
    if (BASE.startsWith('http://') && !/\/\/(localhost|127\.)/.test(BASE)) {
        args.push(`--unsafely-treat-insecure-origin-as-secure=${BASE}`, '--disable-site-isolation-trials');
    }
    if (audioFile) args.splice(1, 0, `--use-file-for-fake-audio-capture=${audioFile}`);
    const browser = await puppeteer.launch({
        executablePath: CHROME,
        headless: true,
        acceptInsecureCerts: true,
        args,
    });
    const page = await browser.newPage();
    await page.setUserAgent(phone ? PHONE_UA : UA);
    if (phone)
        await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
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
//
// Комната здесь БЕЗ профиля (по шаблону «*» — обычная комната): сценарий
// проверяет стоковый механизм, а в комнате урока видом распоряжается наша
// раскладка — педагог закреплён, и стоковый автофокус спорит с закреплением.
// Раньше сценарий шёл в комнате урока и проходил лишь потому, что вошедший
// первым не узнавал о педагоге из своего снимка состава (Иван, 2026-08-09).
async function runFocusScenario(seconds) {
    const room = 'montemeet-plain';
    const observer = await launchPeer('Observer', null, { audio: 0, video: 0, room });
    await delay(2000);
    const zal = await launchPeer('Zal', fixtures.speechThenSilence, { room });
    await delay(3000);
    const guest = await launchPeer('Guest1', fixtures.silenceThenSpeech, { room });
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
//   Guest1 — sings at ~9-17s of the measurement (dominant), otherwise silent;
//   Guest2 — silent guest, must watch the Зал by default.
// Expectations: silence -> Host: grid, Guests: focus on Зал; Guest1 speaking ->
// Host & Guest2 focus Guest1, while Guest1 himself keeps watching the Зал
// (dom == self -> anchor); after the speech + silenceMs -> back to defaults.
async function runConcertScenario() {
    const room = 'montemeet-concert';
    const zal = await launchPeer('Zal', fixtures.silence, { room });
    await delay(3000);
    const guest1 = await launchPeer('Guest1', fixtures.concertTurn, { room });
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
    for (let i = 0; i < 24; i++) {
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

    // Окна не назначаем по часам: между запуском браузера и первым замером
    // проходит от трёх до двенадцати секунд, и на загруженной машине «до
    // выступления» попадало ровно в выступление (Иван, 2026-08-10). Границы
    // берём из самих данных — по тому, когда зал показал гостя.
    const from = samples.findIndex((s) => s.zalSees === 'guest1');
    const to = samples.findLastIndex((s) => s.zalSees === 'guest1');
    const before = from > 0 ? samples.slice(0, from) : [];
    const after = to >= 0 ? samples.slice(to + 1) : [];
    const defaults = (s) => s.zalSees === null && s.guest2Sees === 'zal';
    return {
        scenario: 'concert',
        hidden,
        samples,
        window: { from, to },
        checks: {
            // прямо перед выступлением: зал показывает сетку, молчащий гость
            // смотрит на зал. Самые первые замеры не берём — там ещё строятся
            // плитки, и это не про раскладку
            earlyDefaults: before.length >= 2 && before.slice(-2).every(defaults),
            guestTakeover: from >= 0 && samples.slice(from, to + 1).some((s) => s.guest2Sees === 'guest1'),
            performerWatchesZal: samples.every((s) => s.guest1Sees === 'zal' || s.guest1Sees === null),
            backToDefaults: after.length >= 2 && after.every(defaults),
            // the HALL (TV) never sees itself; a guest DOES see themselves in
            // the strip since 2026-08-06 (Ivan's decision, like at lessons)
            selfVisibility: hidden.zal === true && hidden.guest2 === false,
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
    // Педагогу режим восстанавливается из прошлого выбора, поэтому «сетку»
    // просим явно: проверяем именно её, а не то, с чего он случайно начал
    await teacher.page.evaluate(async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        for (let i = 0; i < 4 && MontemeetLayout.view() !== 'grid'; i++) {
            document.getElementById('montemeetSpeakerViewBtn')?.click();
            await sleep(300);
        }
    });
    await delay(3000);
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
    // Стартовый режим больше не подразумеваем: педагогу его восстанавливают из
    // прошлого выбора, так что «первый клик = grid → sticky» держалось на удаче.
    // Прокликиваем до сетки, а дальше идём по циклу осознанно.
    const viewOf = (p) => p.page.evaluate(() => MontemeetLayout.view());
    for (let i = 0; i < 4 && (await viewOf(teacher)) !== 'grid'; i++) await clickCycle(teacher);
    const clicked = (await clickCycle(teacher)) && (await viewOf(teacher)) === 'sticky'; // grid → sticky

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
            teacherPin:
                (await pinnedOn(teacher)) === ids.student1 ? 'student1' : (await pinnedOn(teacher)) ? 'other' : null,
        });
    }

    // Сколько шагов до сетки — зависит от админки: с выключенным «Авто» режимов
    // два, а не три. Поэтому доходим до сетки, а не отсчитываем клики.
    for (let i = 0; i < 4 && (await viewOf(teacher)) !== 'grid'; i++) await clickCycle(teacher);
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

// Тот, кого показывали крупно, вышел из встречи (Иван, 2026-08-10). Режим по
// кнопке остаётся прежним, поэтому и на экране должен остаться кто-то крупно —
// раньше «липкий» вид молча оставался ни с кем и показывал сетку. Группа после
// ухода должна остаться группой, иначе включится раскладка 1:1.
async function runLeaverScenario() {
    const room = 'montemeet-group';
    const teacher = await launchPeer('Teacher', fixtures.silence, { room });
    await delay(3000);
    const loud = await launchPeer('Student1', fixtures.speech, { room });
    const rest = [await launchPeer('Student2', fixtures.silence, { room })];
    rest.push(await launchPeer('Student3', fixtures.silence, { room }));
    await delay(9000);

    const viewOf = (p) => p.page.evaluate(() => MontemeetLayout.view());
    const clickCycle = (p) => p.page.evaluate(() => !!document.getElementById('montemeetSpeakerViewBtn')?.click());
    for (let i = 0; i < 4 && (await viewOf(teacher)) !== 'sticky'; i++) await clickCycle(teacher);
    await delay(8000);

    const bigOn = (p) =>
        p.page.evaluate(
            () =>
                document.querySelector('#videoPinMediaContainer video[name]')?.getAttribute('name') ??
                document.querySelector('#videoMediaContainer [focus-mode] video[name]')?.getAttribute('name') ??
                null
        );
    const loudId = await loud.page.evaluate(() => rc.peer_id);
    const before = { big: await bigOn(teacher), view: await viewOf(teacher) };
    await loud.browser.close();
    await delay(10000);
    const after = { big: await bigOn(teacher), view: await viewOf(teacher) };

    await teacher.browser.close();
    for (const p of rest) await p.browser.close();

    return {
        scenario: 'leaver',
        before,
        after,
        checks: {
            speakerShownBefore: before.big === loudId && before.view === 'sticky',
            modeKept: after.view === 'sticky',
            someoneElseShown: !!after.big && after.big !== loudId,
        },
    };
}

// Круг режимов у педагога на телефоне: сетка → говорящий крупно → авто →
// сетка (Иван, 2026-08-10). Сток при снятии фокуса пересчитывает сетку раньше,
// чем возвращает скрытые плитки, и та, что была крупной, остаётся размером
// «я тут один» — на экране она висит сверху, остальные жмутся под ней.
async function runViewCycleScenario() {
    const room = 'montemeet-group';
    const teacher = await launchPeer('Teacher', fixtures.silence, { room, phone: true });
    await delay(3000);
    const students = [];
    for (const n of ['Student1', 'Student2', 'Student3']) {
        students.push(await launchPeer(n, fixtures.silence, { room }));
        await delay(1200);
    }
    await delay(9000);

    const cycle = (p) =>
        p.page.evaluate(async () => {
            const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
            const seen = [];
            for (let i = 0; i < 4; i++) {
                document.getElementById('montemeetSpeakerViewBtn')?.click();
                await sleep(700);
                seen.push(MontemeetLayout.view());
            }
            return seen;
        });
    const seen = await cycle(teacher);
    // добираем до сетки, чем бы круг ни закончился
    await teacher.page.evaluate(async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        for (let i = 0; i < 4 && MontemeetLayout.view() !== 'grid'; i++) {
            document.getElementById('montemeetSpeakerViewBtn')?.click();
            await sleep(500);
        }
    });
    await delay(3000);

    const grid = await teacher.page.evaluate(() => {
        const c = document.getElementById('videoMediaContainer');
        const tiles = [...c.querySelectorAll(':scope > div.Camera')].filter((t) => t.style.display !== 'none');
        const box = (t) => t.getBoundingClientRect();
        const pin = document.getElementById('videoPinMediaContainer');
        return {
            view: MontemeetLayout.view(),
            marked: !!c.querySelector('[focus-mode]'),
            hidden: [...c.children].filter((el) => el.style.display === 'none').length,
            widths: tiles.map((t) => Math.round(box(t).width)),
            heights: tiles.map((t) => Math.round(box(t).height)),
            // мерить надо ПРОСТАВЛЕННЫЕ размеры, а не отрисованные: мобильная
            // вёрстка перебивает их своими, и на эмуляторе залипшая плитка
            // выглядит нормальной, хотя размер у неё «я тут один»
            inlineWidths: tiles.map((t) => parseInt(t.style.width, 10) || 0),
            pinShown: !!pin && getComputedStyle(pin).display !== 'none',
            containerWidth: Math.round(c.getBoundingClientRect().width),
            viewportHeight: window.innerHeight,
        };
    });

    await teacher.browser.close();
    for (const p of students) await p.browser.close();

    const widest = Math.max(...grid.widths, 0);
    const narrowest = Math.min(...grid.widths, Infinity);
    const tallest = Math.max(...grid.heights, 0);
    const shortest = Math.min(...grid.heights, Infinity);
    const setWide = Math.max(...grid.inlineWidths, 0);
    const setNarrow = Math.min(...grid.inlineWidths, Infinity);
    return {
        scenario: 'view-cycle',
        seen,
        grid,
        checks: {
            cycleWorks: seen.length === 4 && new Set(seen).size >= 2,
            backToGrid: grid.view === 'grid' && !grid.marked && grid.hidden === 0,
            // ни одна плитка не шире контейнера и не крупнее соседей
            // ни одна плитка не шире контейнера, не выше соседей и не осталась
            // с проставленным размером «я тут один»
            noStuckTile:
                grid.widths.length >= 3 &&
                widest <= grid.containerWidth + 2 &&
                widest - narrowest <= 4 &&
                tallest - shortest <= 4 &&
                setWide - setNarrow <= 4 &&
                setWide <= grid.containerWidth + 2 &&
                !grid.pinShown,
        },
    };
}

// Кружочки говорящих (Иван, 2026-08-09). Студент на ТЕЛЕФОНЕ смотрит педагога
// крупно, а заговорившие одноклассники выезжают из-за левой грани кружками:
// одновременно не больше трёх, педагога среди них не бывает, на компьютере и у
// самого педагога их нет вовсе, и после тишины они уходят.
async function runCirclesScenario() {
    const room = 'montemeet-group';
    const teacher = await launchPeer('Teacher', fixtures.silence, { room });
    await delay(3000);
    const viewer = await launchPeer('Student1', fixtures.silence, { room, phone: true });
    const talkers = [];
    for (const n of ['Student2', 'Student3', 'Student4', 'Student5']) {
        talkers.push(await launchPeer(n, fixtures.speech, { room }));
        await delay(1000);
    }
    await delay(12000);

    const teacherId = await teacher.page.evaluate(() => rc.peer_id);
    const circles = (p) =>
        p.page.evaluate(() => {
            const box = document.getElementById('montemeetCircles');
            const items = box ? [...box.children] : [];
            return {
                exists: !!box,
                peers: items.map((c) => c.dataset.peer),
                shown: items.filter((c) => c.classList.contains('is-in')).length,
                faces: items.map((c) => c.firstElementChild?.tagName.toLowerCase() ?? null),
            };
        });

    const speaking = await circles(viewer);
    const onDesktop = await circles(talkers[0]);
    const onTeacher = await circles(teacher);

    for (const t of talkers) await t.browser.close();
    await delay(9000);
    const afterSilence = await circles(viewer);

    await teacher.browser.close();
    await viewer.browser.close();

    return {
        scenario: 'circles',
        speaking,
        afterSilence,
        checks: {
            cappedAtThree: speaking.shown === 3 && speaking.peers.length === 3,
            neverTheTeacher: !speaking.peers.includes(teacherId),
            facesShown: speaking.faces.length === 3 && speaking.faces.every((f) => f === 'video'),
            notOnDesktop: !onDesktop.exists,
            notForTheTeacher: !onTeacher.exists,
            goneAfterSilence: afterSilence.peers.length === 0,
        },
    };
}

// Занятое имя: второй участник с тем же именем должен молча получить номер и
// войти, а не упереться в модальное окно «Username already in use».
async function runNameClashScenario() {
    const room = 'montemeet-group';
    const first = await launchPeer('Teacher', fixtures.silence, { room });
    await delay(3000);
    const second = await launchPeer('Teacher', fixtures.silence, { room });
    await delay(8000);

    const state = (p) =>
        p.page.evaluate(() => ({
            name: typeof rc !== 'undefined' ? rc.peer_name : null,
            joined: typeof rc !== 'undefined' && !!rc.peer_id,
            // сток показывает занятое имя через SweetAlert
            popup: !!document.querySelector('.swal2-container'),
        }));
    const firstState = await state(first);
    const secondState = await state(second);
    // обе стороны должны видеть двух участников, а не одного
    const peersSeen = await first.page.evaluate(
        () => document.querySelectorAll('#videoMediaContainer .Camera, [id$="__videoOff"]').length
    );

    await first.browser.close();
    await second.browser.close();

    return {
        scenario: 'name-clash',
        firstState,
        secondState,
        peersSeen,
        checks: {
            firstKeepsName: firstState.name === 'Teacher',
            secondNumbered: secondState.name === 'Teacher (2)',
            noPopup: !secondState.popup,
            secondJoined: secondState.joined && peersSeen >= 2,
        },
    };
}

// Своя же копия: педагог входит со второго устройства и остаётся собой. Когда
// он там говорит, на первом устройстве он НЕ должен всплыть крупно сам у себя,
// и кнопок «Заблокировать»/«Отключить» на своей копии быть не должно.
// Проверка не пустая: рядом меряем уровень звука, пришедший с той копии, —
// значит она действительно говорила, а раскладка её осознанно не взяла.
async function runTwinScenario() {
    const room = 'montemeet-group';
    const teacher = await launchPeer('Teacher', fixtures.silence, { room });
    await delay(3000);
    const twin = await launchPeer('Teacher', fixtures.speech, { room });
    const student = await launchPeer('Student1', fixtures.silence, { room });
    await delay(4000);

    const twinId = await twin.page.evaluate(() => rc.peer_id);
    const viewOf = (p) => p.page.evaluate(() => MontemeetLayout.view());
    const clickCycle = (p) =>
        p.page.evaluate(() => {
            const btn = document.getElementById('montemeetSpeakerViewBtn');
            if (!btn) return false;
            btn.click();
            return true;
        });
    // Нужен режим, в котором говорящий вообще всплывает крупно, иначе проверять
    // нечего. Берём «липкий»: он есть всегда, а «авто» из админки могут выключить.
    for (let i = 0; i < 4 && (await viewOf(teacher)) !== 'sticky'; i++) await clickCycle(teacher);
    const modeReady = (await viewOf(teacher)) === 'sticky';

    const pinnedOn = (p) =>
        p.page.evaluate(
            () => document.querySelector('#videoPinMediaContainer video[name]')?.getAttribute('name') ?? null
        );
    // Речь копии считаем по тем же событиям уровня звука, по которым раскладка
    // и выбирает говорящего: мгновенный снимок полоски громкости слишком
    // случаен, чтобы им что-то доказывать.
    await teacher.page.evaluate(() => {
        window.__mmHeard = {};
        const stock = MontemeetLayout.noteActivity;
        MontemeetLayout.noteActivity = (peerId, volume, top) => {
            window.__mmHeard[peerId] = Math.max(window.__mmHeard[peerId] || 0, volume || 0);
            return stock(peerId, volume, top);
        };
    });

    const pins = [];
    for (let i = 0; i < 8; i++) {
        await delay(1500);
        pins.push(await pinnedOn(teacher));
    }
    const heardTwin = await teacher.page.evaluate((id) => window.__mmHeard[id] || 0, twinId);

    const recognised = await teacher.page.evaluate((id) => MontemeetLayout.isMyTwin(id), twinId);
    const forStudent = await student.page.evaluate((id) => MontemeetLayout.isMyTwin(id), twinId);
    const rows = await teacher.page.evaluate((id) => {
        const box = document.getElementById(id + '_video__videoExpandContent');
        const shown = (suffix) => {
            const row = box?.querySelector(`[id$="${suffix}"]`)?.closest('.navbar-dropdown-item');
            return !!row && row.style.display !== 'none';
        };
        return { found: !!box, ban: shown('___ban'), kick: shown('___kickOut') };
    }, twinId);

    await teacher.browser.close();
    await twin.browser.close();
    await student.browser.close();

    return {
        scenario: 'twin',
        twinId,
        pins,
        heardTwin,
        rows,
        checks: {
            modeReady,
            recognised: recognised === true && forStudent === false,
            heardTheTwin: heardTwin >= 3, // копия действительно говорила
            neverBigOnMyself: pins.every((p) => p !== twinId),
            noSelfHarmButtons: rows.found && !rows.ban && !rows.kick,
        },
    };
}

// Заставка концерта у ЗРИТЕЛЯ: камера зала выключена и никто не выступает —
// смотреть нечего, вместо чёрной плитки с аватаркой должна висеть афиша.
// Вернули камеру — заставка ушла.
async function runSplashScenario() {
    const room = 'montemeet-concert';
    // зал — педагог комнаты по реестру, иначе презентера в комнате нет вовсе
    const hall = await launchPeer('Zal', fixtures.silence, { room });
    await delay(3000);
    const guest = await launchPeer('Guest1', fixtures.silence, { room });
    await delay(8000);

    const splashOn = (p) =>
        p.page.evaluate(() => !!document.getElementById('montemeetSplash')?.classList.contains('is-on'));
    const camera = (p, on) =>
        p.page.evaluate((wanted) => {
            document.getElementById(wanted ? 'startVideoButton' : 'stopVideoButton')?.click();
        }, on);

    const guestWhileOn = await splashOn(guest);
    await camera(hall, false);
    await delay(6000);
    const guestWhenOff = await splashOn(guest);
    await camera(hall, true);
    await delay(6000);
    const guestAfterBack = await splashOn(guest);

    await guest.browser.close();
    await hall.browser.close();

    return {
        scenario: 'splash',
        guestWhileOn,
        guestWhenOff,
        guestAfterBack,
        checks: {
            quietWhileCameraOn: guestWhileOn === false,
            shownWhenCameraOff: guestWhenOff === true,
            goneWhenCameraBack: guestAfterBack === false,
        },
    };
}

// Скрытый тулбар не должен ловить тот самый тап, которым его поднимают.
// Воспроизводим ровно ту щель, из-за которой баг возвращался: между касанием и
// кликом на телефоне проходят сотни миллисекунд, за это время наш опрос успевает
// снять запрет нажатий — и клик приходит уже по появившейся кнопке.
async function runPhantomTapScenario() {
    const room = 'montemeet-group';
    const teacher = await launchPeer('Teacher', fixtures.silence, { room });
    await delay(2000);
    const phone = await launchPeer('Student1', fixtures.silence, { room, phone: true });
    await delay(8000);
    const p = phone.page;

    const coarse = await p.evaluate(() => matchMedia('(hover: none) and (pointer: coarse)').matches);
    await p.evaluate(() => {
        window.__mmTaps = 0;
        document.addEventListener('click', (e) => {
            if (document.getElementById('bottomButtons')?.contains(e.target)) window.__mmTaps++;
        });
    });
    // Прячем панель ровно так, как это делает сток: он ведёт ещё и свой признак,
    // и без него showButtons() выходит сразу — панель не поднимется, а проверка
    // выродится в «клика нет, потому что кнопки нет».
    const setBar = (display) =>
        p.evaluate((d) => {
            document.getElementById('bottomButtons').style.display = d;
            try {
                isButtonsVisible = d !== 'none';
                // «указатель над панелью» сток снимает по mouseout: на телефоне
                // это происходит от касания в стороне от панели, чем наш
                // сценарий и занимается
                if (d === 'none') isButtonsBarOver = false;
            } catch (e) {
                /* сток переименовал признак — увидим по barRevealed */
            }
        }, display);
    const barShown = () =>
        p.evaluate(() => getComputedStyle(document.getElementById('bottomButtons')).display !== 'none');
    const taps = () => p.evaluate(() => window.__mmTaps);

    // цель — безобидная кнопка: поднятая рука переключается туда и обратно
    await setBar('flex');
    await delay(500);
    const target = await p.evaluate(() => {
        const bar = document.getElementById('bottomButtons');
        const seen = (el) => !!el && !!el.offsetParent;
        // безобидные переключатели; выход и панели трогать нельзя — уедет вся сцена
        const btn =
            ['raiseHandButton', 'stopAudioButton', 'startAudioButton', 'stopVideoButton', 'startVideoButton']
                .map((id) => document.getElementById(id))
                .find(seen) || [...bar.querySelectorAll('button')].find((b) => seen(b) && b.id !== 'exitButton');
        const r = btn.getBoundingClientRect();
        return { id: btn.id, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    });

    // контроль: по ВИДИМОЙ панели нажатие обязано проходить
    await p.touchscreen.touchStart(target.x, target.y);
    await delay(400);
    await p.touchscreen.touchEnd();
    await delay(600);
    const whenVisible = await taps();

    // а теперь — панель спрятана, бьём в то же место
    await setBar('none');
    await delay(500);
    await p.evaluate(() => {
        window.__mmTaps = 0;
    });
    await p.touchscreen.touchStart(target.x, target.y);
    await delay(400); // опрос успевает вернуть класс «панель видна»
    await p.touchscreen.touchEnd();
    await delay(600);
    const whenHidden = await taps();
    const revealed = await barShown();

    await phone.browser.close();
    await teacher.browser.close();

    return {
        scenario: 'phantom-tap',
        target,
        whenVisible,
        whenHidden,
        checks: {
            touchScreen: coarse, // без этого проверка ничего не значит
            controlPressed: whenVisible === 1,
            phantomBlocked: whenHidden === 0,
            barRevealed: revealed,
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
if (which === 'leaver' || which === 'all') {
    const r = await runLeaverScenario();
    r.pass = Object.values(r.checks).every(Boolean);
    results.push(r);
}
if (which === 'view-cycle' || which === 'all') {
    const r = await runViewCycleScenario();
    r.pass = Object.values(r.checks).every(Boolean);
    results.push(r);
}
if (which === 'circles' || which === 'all') {
    const r = await runCirclesScenario();
    r.pass = Object.values(r.checks).every(Boolean);
    results.push(r);
}
if (which === 'name-clash' || which === 'all') {
    const r = await runNameClashScenario();
    r.pass = Object.values(r.checks).every(Boolean);
    results.push(r);
}
if (which === 'twin' || which === 'all') {
    const r = await runTwinScenario();
    r.pass = Object.values(r.checks).every(Boolean);
    results.push(r);
}
if (which === 'splash' || which === 'all') {
    const r = await runSplashScenario();
    r.pass = Object.values(r.checks).every(Boolean);
    results.push(r);
}
if (which === 'phantom-tap' || which === 'all') {
    const r = await runPhantomTapScenario();
    r.pass = Object.values(r.checks).every(Boolean);
    results.push(r);
}

console.log(JSON.stringify(results, null, 2));
process.exitCode = results.every((r) => r.pass) ? 0 : 1;
