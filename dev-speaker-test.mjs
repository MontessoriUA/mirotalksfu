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
import { pathToFileURL } from 'node:url';

// Сценарий room-policy подгружает MontemeetProfiles, тот тянет dotenv, а dotenv
// с 17-й версии печатает в вывод рекламную подсказку — и она попадала в JSON
// отчёта первой строкой, ломая разбор (Иван, 2026-08-18).
process.env.DOTENV_CONFIG_QUIET = 'true';

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
    { audio = 1, video = 1, focusFollow = false, room = ROOM, phone = false, memory = null } = {}
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
        // демонстрация экрана без диалога выбора источника (сценарий screen-tile)
        '--auto-select-desktop-capture-source=Entire screen',
        '--auto-accept-this-tab-capture',
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
    // память браузера о прошлом входе (сток помнит выбор микрофона и камеры)
    if (memory) {
        await page.evaluateOnNewDocument((m) => {
            localStorage.setItem('INIT_CONFIG', JSON.stringify(m));
        }, memory);
    }
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
    // На стенде педагог узнаётся по ИМЕНИ, а второй тёзка входит как «Имя (2)» и
    // педагогом уже не считается — двух презентеров по имени не сделать. В жизни
    // обе копии приходят по почте (вход из кабинета или билет из расписания) и
    // презентеры обе. Ставим в карте участников тот самый признак, который в
    // проде приходит с сервера, — дальше работает настоящий код.
    // Карту участников клиент перечитывает с сервера при каждой смене состава,
    // и любая разовая заплатка затирается. Подменяем само чтение: кто бы ни
    // положил новую карту, вторая копия в ней всегда придёт педагогом — ровно
    // так её отдаёт сервер в бою.
    await teacher.page.evaluate((id) => {
        const wrap = (map) =>
            new Proxy(map, {
                get(target, prop) {
                    if (prop === 'get') {
                        return (key) => {
                            const value = target.get(key);
                            if (key === id && value?.peer_info) value.peer_info.peer_presenter = true;
                            return value;
                        };
                    }
                    const value = Reflect.get(target, prop);
                    return typeof value === 'function' ? value.bind(target) : value;
                },
            });
        let real = rc.peers;
        Object.defineProperty(rc, 'peers', {
            get: () => wrap(real),
            set: (map) => {
                real = map;
            },
            configurable: true,
        });
    }, twinId);
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
    // Видимость меряем ВЫЧИСЛЕННЫМ стилем: у стока на строке меню
    // `display: flex !important`, и инлайновый display ему проигрывает —
    // проверка по style.display показывала «скрыто» на видимой строке
    // (Иван, 2026-08-14).
    const rows = await teacher.page.evaluate((id) => {
        const box = document.getElementById(id + '_video__videoExpandContent');
        if (box) box.classList.add('show'); // скрытый контейнер не считается
        const shown = (suffix) => {
            const row = box?.querySelector(`[id$="${suffix}"]`)?.closest('.navbar-dropdown-item');
            return !!row && getComputedStyle(row).display !== 'none';
        };
        const res = { found: !!box, ban: shown('___ban'), kick: shown('___kickOut') };
        if (box) box.classList.remove('show');
        return res;
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
    // Зрителей двое, и один с телефона: Иван видел заставку на смартфоне и не
    // видел на компьютере, так что смотрим обоих сразу (2026-08-14). Заодно
    // зрителей двое — значит вид «один на один» тут не включается.
    const guest = await launchPeer('Guest1', fixtures.silence, { room });
    const phone = await launchPeer('Guest2', fixtures.silence, { room, phone: true });
    await delay(10000);

    const splashOn = (p) =>
        p.page.evaluate(() => !!document.getElementById('montemeetSplash')?.classList.contains('is-on'));
    const camera = (p, on) =>
        p.page.evaluate((wanted) => {
            document.getElementById(wanted ? 'startVideoButton' : 'stopVideoButton')?.click();
        }, on);

    const whileOn = { пк: await splashOn(guest), телефон: await splashOn(phone) };
    await camera(hall, false);
    await delay(7000);
    const whenOff = { пк: await splashOn(guest), телефон: await splashOn(phone) };
    await camera(hall, true);
    await delay(7000);
    const afterBack = { пк: await splashOn(guest), телефон: await splashOn(phone) };

    await phone.browser.close();
    await guest.browser.close();
    await hall.browser.close();

    return {
        scenario: 'splash',
        whileOn,
        whenOff,
        afterBack,
        checks: {
            quietWhileCameraOn: whileOn.пк === false && whileOn.телефон === false,
            shownWhenCameraOff: whenOff.пк === true && whenOff.телефон === true,
            goneWhenCameraBack: afterBack.пк === false && afterBack.телефон === false,
        },
    };
}

// Вкладку свернули, браузер убил дорожку камеры — вернулись, и камера должна
// подняться сама, без перезагрузки страницы. Фон эмулируем честно: вторая
// вкладка поверх делает первую скрытой, дорожку в это время гасим — ровно так
// её гасит браузер.
async function runTabReturnScenario() {
    const room = 'montemeet-group';
    const teacher = await launchPeer('Teacher', fixtures.silence, { room });
    await delay(3000);
    const student = await launchPeer('Student1', fixtures.silence, { room });
    await delay(9000);

    const p = student.page;
    const cameraState = () =>
        p.evaluate(() => {
            const type = RoomClient.mediaType.video;
            const has = rc.producerExist(type);
            const track = has ? rc.producers.get(rc.producerLabel.get(type))?.track : null;
            return { producer: has, live: !!track && track.readyState === 'live' && !track.muted };
        });

    await p.evaluate(() => {
        window.__hidden = 0;
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState !== 'visible') window.__hidden++;
        });
    });

    const before = await cameraState();
    const other = await student.browser.newPage();
    await other.goto('about:blank');
    await other.bringToFront();
    await delay(1200);
    const hiddenSeen = await p.evaluate(() => window.__hidden > 0);
    // браузер в фоне глушит захват — повторяем это руками
    await p.evaluate(() => {
        const type = RoomClient.mediaType.video;
        rc.producers.get(rc.producerLabel.get(type))?.track?.stop();
    });
    await delay(2500);
    const whileHidden = await cameraState();

    await p.bringToFront();
    let back = null;
    for (let i = 0; i < 10; i++) {
        await delay(1500);
        back = await cameraState();
        if (back.producer && back.live) break;
    }

    await other.close();
    await student.browser.close();
    await teacher.browser.close();

    return {
        scenario: 'tab-return',
        before,
        whileHidden,
        back,
        checks: {
            cameraWasOn: before.producer && before.live,
            wentHidden: hiddenSeen === true,
            diedInBackground: !whileHidden.live, // без этого проверять нечего
            cameraBack: back.producer === true && back.live === true,
        },
    };
}

// Плитка ДЕМОНСТРАЦИИ экрана: «Отключить» на ней выгоняло студента из встречи
// целиком. Там должно остаться «Остановить показ», а бан с отключением —
// уехать; на обычной плитке того же студента они обязаны остаться.
async function runScreenTileScenario() {
    const room = 'montemeet-group';
    const teacher = await launchPeer('Teacher', fixtures.silence, { room });
    await delay(3000);
    const student = await launchPeer('Student1', fixtures.silence, { room });
    await delay(9000);

    const sharing = await student.page.evaluate(async () => {
        try {
            await rc.produce(RoomClient.mediaType.screen);
            return true;
        } catch (e) {
            return false;
        }
    });
    await delay(6000);

    const studentId = await student.page.evaluate(() => rc.peer_id);
    const menu = await teacher.page.evaluate((id) => {
        const read = (kind) => {
            const box = document.getElementById(`${id}_${kind}__videoExpandContent`);
            if (!box) return null;
            box.classList.add('show'); // у скрытого контейнера всё скрыто по определению
            const seen = (suffix) => {
                const row = box.querySelector(`[id$="${suffix}"]`)?.closest('.navbar-dropdown-item');
                return !!row && getComputedStyle(row).display !== 'none';
            };
            const res = {
                ban: seen('___ban'),
                kick: seen('___kickOut'),
                stop: !!box.querySelector('.montemeet-stop-share'),
            };
            box.classList.remove('show');
            return res;
        };
        return { screen: read('screen'), camera: read('video') };
    }, studentId);

    await student.browser.close();
    await teacher.browser.close();

    return {
        scenario: 'screen-tile',
        sharing,
        menu,
        checks: {
            sharingStarted: sharing === true,
            screenTileFound: !!menu.screen,
            noBanOnScreen: menu.screen ? !menu.screen.ban : false,
            noKickOnScreen: menu.screen ? !menu.screen.kick : false,
            stopOffered: menu.screen ? menu.screen.stop : false,
            cameraTileUntouched: !!menu.camera && menu.camera.ban && menu.camera.kick,
        },
    };
}

// Заставка и РЕЧЬ. Собственный голос сцену не занимает: педагог говорит — афиша
// остаётся. Заговорил кто-то другой — афиша уходит, замолчал — возвращается.
// Проверка не пустая: рядом считаем, что голос самого педагога до его же
// клиента дошёл и был громким.
async function runSplashSpeechScenario() {
    const room = 'montemeet-concert';
    const hall = await launchPeer('Zal', fixtures.speech, { room });
    await delay(3000);
    const guest = await launchPeer('Guest1', fixtures.silence, { room });
    await delay(8000);

    await hall.page.evaluate(() => {
        window.__mmHeard = {};
        const stock = MontemeetLayout.noteActivity;
        MontemeetLayout.noteActivity = (peerId, volume, top) => {
            window.__mmHeard[peerId] = Math.max(window.__mmHeard[peerId] || 0, volume || 0);
            return stock(peerId, volume, top);
        };
    });
    const splashOn = (p) =>
        p.page.evaluate(() => !!document.getElementById('montemeetSplash')?.classList.contains('is-on'));

    await delay(9000);
    const whileHallTalks = await splashOn(hall);
    const heardSelf = await hall.page.evaluate(() => window.__mmHeard[rc.peer_id] || 0);

    // выступающий — отдельный гость, чтобы речь была заведомо не своя
    const performer = await launchPeer('Guest2', fixtures.speech, { room });
    await delay(12000);
    const whilePerformer = await splashOn(hall);
    const heardPerformer = await hall.page.evaluate((id) => window.__mmHeard[id] || 0, await performer.page.evaluate(() => rc.peer_id));

    await performer.browser.close();
    await delay(12000);
    const afterPerformer = await splashOn(hall);

    await guest.browser.close();
    await hall.browser.close();

    return {
        scenario: 'splash-speech',
        whileHallTalks,
        whilePerformer,
        afterPerformer,
        heardSelf,
        heardPerformer,
        checks: {
            heardOwnVoice: heardSelf >= 3, // педагог сам звучал громко
            staysWhenISpeak: whileHallTalks === true,
            heardThePerformer: heardPerformer >= 3,
            goesWhenOtherSpeaks: whilePerformer === false,
            backAfterSilence: afterPerformer === true,
        },
    };
}

// Настройки комнаты из кабинета. Комната на сервере живёт, пока в ней хоть кто-то
// есть, и раньше применялись они ровно один раз — при её создании: педагог ставил
// галочку, заходил второй вкладкой и не находил изменений. Браузер тут не нужен —
// проверяем сам реестр и его применение к комнате.
async function runRoomPolicyScenario() {
    const file = path.join(FIXTURES, 'policy-registry.json');
    const write = (lobby) =>
        fs.writeFileSync(
            file,
            JSON.stringify({
                profiles: { concert: { title: 'Концерт', roles: 'concert', layout: { holdMs: 1500 } } },
                rooms: { 'policy-room': 'concert' },
                roomOverrides: { 'policy-room': { startMuted: false, startHidden: false, lobby } },
            })
        );

    write(false);
    process.env.MONTEMEET_PROFILES_PATH = file;
    const profiles = (await import(pathToFileURL(path.join(import.meta.dirname, 'app/src/MontemeetProfiles.js')).href))
        .default;

    const room = { _moderator: {}, _isLobbyEnabled: false };
    profiles.applyToRoom(room, 'policy-room');
    const atCreate = room._isLobbyEnabled;

    await delay(1100); // разводим записи по времени: реестр сверяется по mtime
    write(true);
    const changed = profiles.refreshRoom(room, 'policy-room');
    const afterOn = room._isLobbyEnabled;
    const secondCall = profiles.refreshRoom(room, 'policy-room'); // реестр не менялся — работы нет

    await delay(1100);
    write(false);
    profiles.refreshRoom(room, 'policy-room');
    const afterOff = room._isLobbyEnabled;

    fs.rmSync(file, { force: true });

    return {
        scenario: 'room-policy',
        atCreate,
        afterOn,
        afterOff,
        checks: {
            offAtCreate: atCreate === false,
            picksUpChange: changed === true && afterOn === true,
            idleWhenUnchanged: secondCall === false,
            picksUpChangeBack: afterOff === false,
        },
    };
}

// Зал с ОДНИМ зрителем: это всё ещё концерт (афиша работает), но раскладка —
// «один на один», и педагог видит себя в углу, а не пустую ленту.
async function runConcertSoloScenario() {
    const room = 'montemeet-concert';
    const hall = await launchPeer('Zal', fixtures.silence, { room });
    await delay(12000);

    // своя плитка: видна, показывает картинку, а не крутящийся загрузчик
    const ownTile = (p) =>
        p.page.evaluate(() => {
            const v = rc.getVideoElementByPeerId(rc.peer_id);
            const box = v ? document.getElementById(v.id + '__video') : null;
            const loader = box?.querySelector('.video-loader');
            return {
                видна: !!box && getComputedStyle(box).display !== 'none',
                ширина: box ? Math.round(box.getBoundingClientRect().width) : 0,
                идёт: !!v && !v.paused && v.readyState >= 2,
                загрузчик: !!loader && getComputedStyle(loader).display !== 'none',
            };
        });
    const hallAlone = await ownTile(hall);

    const guest = await launchPeer('Guest1', fixtures.silence, { room });
    await delay(11000);
    const hallWithGuest = await ownTile(hall);

    const state = (p) =>
        p.page.evaluate(() => ({
            solo: document.body.classList.contains('montemeet-solo'),
            splash: !!document.getElementById('montemeetSplash')?.classList.contains('is-on'),
            pip: (() => {
                const el = document.querySelector('.montemeet-self-pip');
                return !!el && getComputedStyle(el).display !== 'none';
            })(),
        }));

    const hallState = await state(hall);
    const guestState = await state(guest);

    // афиша не перестала жить от того, что раскладкой владеет вид 1:1
    await hall.page.evaluate(() => document.getElementById('stopVideoButton')?.click());
    await delay(7000);
    const guestWhenCameraOff = await state(guest);

    await guest.browser.close();
    await hall.browser.close();

    return {
        scenario: 'concert-solo',
        hallAlone,
        hallWithGuest,
        hallState,
        guestState,
        guestWhenCameraOff,
        checks: {
            aloneSeesItselfBig: hallAlone.видна && hallAlone.идёт && !hallAlone.загрузчик && hallAlone.ширина > 600,
            withGuestSeesItselfSmall:
                hallWithGuest.видна && hallWithGuest.идёт && !hallWithGuest.загрузчик && hallWithGuest.ширина < 600,
            soloOnHall: hallState.solo === true,
            soloOnGuest: guestState.solo === true,
            hallSeesItself: hallState.pip === true,
            splashOnStage: hallState.splash === true, // никто не выступает — висит афиша
            splashForGuestWhenCameraOff: guestWhenCameraOff.splash === true,
        },
    };
}

// Тост должен остаться тостом. Наша обёртка перевода привязывала Swal.fire к
// базовому классу, и Swal.mixin({toast}) молча терял свои параметры: любое
// служебное сообщение выходило модальным окном во весь экран (Иван, 2026-08-14).
async function runToastScenario() {
    const room = 'montemeet-group';
    const peer = await launchPeer('Teacher', fixtures.silence, { room });
    await delay(9000);

    const kind = async (fn) => {
        await peer.page.evaluate(fn);
        await delay(900);
        return peer.page.evaluate(() => {
            const p = document.querySelector('.swal2-popup');
            return { toast: !!p?.classList.contains('swal2-toast'), classes: p?.className ?? null };
        });
    };
    const viaUserLog = await kind(() => rc.userLog('info', 'ПРОВЕРКА-ТОСТА', 'top-end'));
    const viaMixin = await kind(() => {
        Swal.mixin({ toast: true, position: 'top-end', showConfirmButton: false, timer: 30000 }).fire({
            icon: 'info',
            title: 'ПРОВЕРКА-МИКСИНА',
        });
    });
    // Эхо чужого входа не показывается вовсе. Приходит оно по сокету — ровно так
    // его и воспроизводим: сток на такое сообщение вызывает roomAction(..., false).
    const noiseSuppressed = await peer.page.evaluate(async () => {
        document.querySelectorAll('.swal2-container').forEach((el) => el.remove());
        rc.roomAction('hostOnlyRecordingOff', false);
        await new Promise((r) => setTimeout(r, 600));
        return !document.querySelector('.swal2-popup');
    });
    // а своё собственное подтверждение — показывается
    const ownStaysVisible = await peer.page.evaluate(async () => {
        document.querySelectorAll('.swal2-container').forEach((el) => el.remove());
        rc.roomStatus('lobbyOn');
        await new Promise((r) => setTimeout(r, 600));
        return !!document.querySelector('.swal2-popup');
    });

    await peer.browser.close();
    return {
        scenario: 'toast',
        viaUserLog,
        viaMixin,
        checks: {
            userLogIsToast: viaUserLog.toast === true,
            mixinKeepsParams: viaMixin.toast === true,
            joinEchoSuppressed: noiseSuppressed === true,
            ownActionStillShown: ownStaysVisible === true,
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
    // На сенсорном экране панель обязана появиться сразу: полупрозрачная и уже
    // нажимаемая — это ровно то состояние, в которое попадал палец.
    await delay(90);
    const opacityAtReveal = await p.evaluate(
        () => getComputedStyle(document.getElementById('bottomButtons')).opacity
    );
    await delay(310); // опрос успевает вернуть класс «панель видна»
    // Здесь и проходит проверка на зубы: класс вернулся, значит CSS-запрет
    // нажатий уже снят и клик пришёл бы по кнопке — не пропустить его может
    // только сам заслон.
    const cssGuardOpen = await p.evaluate(() => document.body.classList.contains('montemeet-bar-visible'));
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
        cssGuardOpen,
        opacityAtReveal,
        checks: {
            touchScreen: coarse, // без этого проверка ничего не значит
            controlPressed: whenVisible === 1,
            barRevealed: revealed,
            noFadeOnTouch: Number(opacityAtReveal) === 1,
            cssGuardOpen, // запрет нажатий к моменту клика уже снят
            phantomBlocked: whenHidden === 0,
        },
    };
}

// ---------- демонстрация экрана и раскладка (Иван, 2026-08-18) ----------
//
// Правило: крупное — только для живой картинки, а автор трансляции обязан
// видеть, что он её ведёт. Лестница крупного одна на всех: экран собеседника →
// его лицо → своя демонстрация → ничего (равные плитки).

// что на экране у участника: крупное, лента, своё окошко в углу
const lookLayout = (p) =>
    p.page.evaluate(() => {
        const owner = (el) =>
            el
                ? el.getAttribute('name') ||
                  (el.getAttribute('volumeBar') || el.getAttribute('volume') || '').replace(/___pVolume$/, '')
                : null;
        const kind = (el) => (el ? (el.hasAttribute('name') ? 'камера' : 'экран') : null);
        const big =
            document.querySelector('#videoPinMediaContainer video') ||
            document.querySelector('#videoMediaContainer [focus-mode] video');
        const strip = [...document.querySelectorAll('#videoMediaContainer .Camera')]
            .filter((c) => getComputedStyle(c).display !== 'none')
            .map((c) => {
                const v = c.querySelector('video');
                return v
                    ? { кто: owner(v), что: kind(v) }
                    : { кто: c.id.replace(/__videoOff$/, ''), что: 'аватарка' };
            });
        const pips = [...document.querySelectorAll('.montemeet-self-pip, .montemeet-peer-pip')].map((c) => {
            const v = c.querySelector('video');
            return {
                кто: v ? owner(v) : c.id.replace(/__videoOff$/, ''),
                что: c.classList.contains('montemeet-peer-pip') ? 'лицо-автора' : 'своё',
            };
        });
        return {
            крупно: big ? { кто: owner(big), что: kind(big) } : null,
            лента: strip,
            окошки: pips,
            своёОкошко: pips.some((p) => p.что === 'своё'),
            я: rc.peer_id,
        };
    });

const startShare = (p) =>
    p.page.evaluate(async () => {
        try {
            await rc.produce(RoomClient.mediaType.screen);
            return true;
        } catch (e) {
            return false;
        }
    });

const stopShare = (p) =>
    p.page.evaluate(() => {
        rc.closeProducer(RoomClient.mediaType.screen, 'тест');
        return true;
    });

// клик по плитке участника (закрепление руками — только у педагога)
const clickPeerTile = (p, peerId) =>
    p.page.evaluate((id) => {
        const el = document.querySelector(`#videoMediaContainer video[name="${id}"]`);
        if (!el) return false;
        el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        return true;
    }, peerId);

// клик по крупному видео — снимает ручное закрепление
const clickBig = (p) =>
    p.page.evaluate(() => {
        const el = document.querySelector('#videoPinMediaContainer video');
        if (!el) return false;
        el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        return true;
    });

const inStrip = (state, who, what) => state.лента.some((t) => t.кто === who && t.что === what);

// 1к1 и демонстрация: крупно ЭКРАН у обеих сторон — у зрителя чужой, у автора
// собственный (иначе он не видит, что именно уходит собеседнику). Лицо при этом
// не пропадает ни у кого, оно в ленте. Показывают оба — каждый видит крупно
// ЧУЖОЙ экран: свой автор и так видит у себя на столе. Обратно всё
// возвращается само, когда показ закончился.
async function runSoloShareScenario() {
    const room = 'montemeet-group';
    const teacher = await launchPeer('Teacher', fixtures.silence, { room });
    await delay(3000);
    const student = await launchPeer('Student1', fixtures.silence, { room });
    await delay(9000);

    const ids = {
        teacher: await teacher.page.evaluate(() => rc.peer_id),
        student: await student.page.evaluate(() => rc.peer_id),
    };

    const before = await lookLayout(teacher);
    const started = await startShare(teacher);
    await delay(7000);
    const tShare = await lookLayout(teacher);
    const sShare = await lookLayout(student);

    await stopShare(teacher);
    await delay(7000);
    const tBack = await lookLayout(teacher);
    const sBack = await lookLayout(student);

    const startedByStudent = await startShare(student);
    await delay(7000);
    const sOwn = await lookLayout(student);
    const tSees = await lookLayout(teacher);

    // показывают оба: каждому крупно ЧУЖОЙ экран
    const startedAgain = await startShare(teacher);
    await delay(8000);
    const tBoth = await lookLayout(teacher);
    const sBoth = await lookLayout(student);

    await student.browser.close();
    await teacher.browser.close();

    return {
        scenario: 'solo-share',
        before,
        tShare,
        sShare,
        tBack,
        sOwn,
        tSees,
        tBoth,
        sBoth,
        checks: {
            sharingStarted: started === true && startedByStudent === true && startedAgain === true,
            // педагог показывает: крупно его собственный экран, лицо студента в ленте
            authorSeesOwnShareBig: tShare.крупно?.кто === ids.teacher && tShare.крупно?.что === 'экран',
            authorKeepsCompanionFace: inStrip(tShare, ids.student, 'камера'),
            authorSeesOwnCamera: inStrip(tShare, ids.teacher, 'камера'),
            authorHasNoCornerPip: tShare.своёОкошко === false,
            viewerSeesShareBig: sShare.крупно?.кто === ids.teacher && sShare.крупно?.что === 'экран',
            viewerKeepsAuthorFace: inStrip(sShare, ids.teacher, 'камера'),
            // показ закончился — вернулись к виду 1:1
            backToSoloAuthor: tBack.крупно?.кто === ids.student && tBack.своёОкошко === true,
            backToSoloViewer: sBack.крупно?.кто === ids.teacher && sBack.своёОкошко === true,
            // теперь показывает студент — всё зеркально
            studentAuthorSeesOwnShareBig: sOwn.крупно?.кто === ids.student && sOwn.крупно?.что === 'экран',
            studentKeepsTeacherFace: inStrip(sOwn, ids.teacher, 'камера'),
            teacherSeesStudentShare: tSees.крупно?.кто === ids.student && tSees.крупно?.что === 'экран',
            teacherKeepsStudentFace: inStrip(tSees, ids.student, 'камера'),
            // показывают оба — крупно чужой экран, свой остаётся в ленте
            bothSharingTeacherSeesStudentScreen:
                tBoth.крупно?.кто === ids.student && tBoth.крупно?.что === 'экран' && inStrip(tBoth, ids.teacher, 'экран'),
            bothSharingStudentSeesTeacherScreen:
                sBoth.крупно?.кто === ids.teacher && sBoth.крупно?.что === 'экран' && inStrip(sBoth, ids.student, 'экран'),
        },
    };
}

// Группа: демонстрация педагога крупно У ВСЕХ, включая его самого; лица не
// пропадают — они в ленте. Ручное закрепление осталось там, где было: педагог
// может поднять крупно лицо студента поверх своей демонстрации, а студент не
// закрепляет ничего (клик по чужой плитке у него не делает ничего).
async function runGroupShareScenario() {
    const room = 'montemeet-group';
    const teacher = await launchPeer('Teacher', fixtures.silence, { room });
    await delay(3000);
    const student1 = await launchPeer('Student1', fixtures.silence, { room });
    await delay(2000);
    const student2 = await launchPeer('Student2', fixtures.silence, { room });
    await delay(10000);

    const ids = {
        teacher: await teacher.page.evaluate(() => rc.peer_id),
        student1: await student1.page.evaluate(() => rc.peer_id),
        student2: await student2.page.evaluate(() => rc.peer_id),
    };

    const started = await startShare(teacher);
    await delay(7000);
    const tShare = await lookLayout(teacher);
    const sShare = await lookLayout(student1);

    // педагог поднимает крупно лицо студента поверх своей демонстрации
    const clicked = await clickPeerTile(teacher, ids.student1);
    await delay(4000);
    const tPinnedFace = await lookLayout(teacher);
    // клик по крупному возвращает автоматику — снова своя демонстрация
    await clickBig(teacher);
    await delay(6000);
    const tBack = await lookLayout(teacher);
    // а студенту закреплять нечего и нечем: клик по чужой плитке ничего не делает
    await clickPeerTile(student1, ids.student2);
    await delay(4000);
    const sAfterClick = await lookLayout(student1);

    await student2.browser.close();
    await student1.browser.close();
    await teacher.browser.close();

    return {
        scenario: 'group-share',
        tShare,
        sShare,
        tPinnedFace,
        tBack,
        sAfterClick,
        checks: {
            sharingStarted: started === true && clicked === true,
            // экран крупно у всех, лица не пропали
            viewerSeesShareBig: sShare.крупно?.кто === ids.teacher && sShare.крупно?.что === 'экран',
            viewerKeepsTeacherFace: inStrip(sShare, ids.teacher, 'камера'),
            authorSeesOwnShareBig: tShare.крупно?.кто === ids.teacher && tShare.крупно?.что === 'экран',
            authorKeepsStudentFaces: inStrip(tShare, ids.student1, 'камера') && inStrip(tShare, ids.student2, 'камера'),
            // ручное закрепление у педагога работает как раньше
            teacherCanPinFace: tPinnedFace.крупно?.кто === ids.student1 && tPinnedFace.крупно?.что === 'камера',
            teacherBackToOwnShare: tBack.крупно?.кто === ids.teacher && tBack.крупно?.что === 'экран',
            // студент по-прежнему не закрепляет ничего
            studentCannotPin: sAfterClick.крупно?.кто === ids.teacher && sAfterClick.крупно?.что === 'экран',
        },
    };
}

// Крупное — только для живой картинки. Все студенты выключили камеры: крупного
// нет вовсе (сетка аватарок), а если педагог показывает экран — крупной идёт
// его демонстрация. Вернувшаяся камера демонстрацию НЕ вытесняет — показ и есть
// «смотрите сюда»; крупное уходит к ней, только когда показ закончился.
async function runNoVideoBigScenario() {
    const room = 'montemeet-group';
    const teacher = await launchPeer('Teacher', fixtures.silence, { room });
    await delay(3000);
    const student1 = await launchPeer('Student1', fixtures.silence, { room });
    await delay(2000);
    const student2 = await launchPeer('Student2', fixtures.silence, { room });
    await delay(10000);

    const ids = { teacher: await teacher.page.evaluate(() => rc.peer_id) };
    const camOff = (p) => p.page.evaluate(() => !!document.getElementById('stopVideoButton')?.click());
    const camOn = (p) => p.page.evaluate(() => !!document.getElementById('startVideoButton')?.click());

    await camOff(student1);
    await camOff(student2);
    await delay(8000);
    const allDark = await lookLayout(teacher);

    const started = await startShare(teacher);
    await delay(7000);
    const withShare = await lookLayout(teacher);

    await camOn(student1);
    await delay(9000);
    const cameraBack = await lookLayout(teacher);

    await stopShare(teacher);
    await delay(8000);
    const shareOver = await lookLayout(teacher);

    await student2.browser.close();
    await student1.browser.close();
    await teacher.browser.close();

    return {
        scenario: 'no-video-big',
        allDark,
        withShare,
        cameraBack,
        shareOver,
        checks: {
            sharingStarted: started === true,
            // смотреть не на кого и показывать нечего — крупного нет
            noBigWhenNothingLive: allDark.крупно === null,
            // ...и уж точно не собственное лицо
            notOwnFaceBig: allDark.крупно?.кто !== ids.teacher,
            ownShareTakesBig: withShare.крупно?.кто === ids.teacher && withShare.крупно?.что === 'экран',
            // камера вернулась — показ остаётся крупным, лицо идёт в ленту
            shareKeepsBigWhenCameraReturns:
                cameraBack.крупно?.кто === ids.teacher &&
                cameraBack.крупно?.что === 'экран' &&
                cameraBack.лента.some((t) => t.что === 'камера' && t.кто !== ids.teacher),
            // показ закончился — крупное досталось живой камере
            cameraTakesBigAfterShare: shareOver.крупно?.что === 'камера' && shareOver.крупно?.кто !== ids.teacher,
        },
    };
}

// Телефон: ленты плиток там нет, поэтому своя камера и лицо автора демонстрации
// висят окошками в углу — и вдвоём, и в группе. Раньше в группе на телефоне не
// было видно ни себя, ни лица показывающего (Иван, 2026-08-19).
async function runPhonePipsScenario() {
    const room = 'montemeet-group';
    const teacher = await launchPeer('Teacher', fixtures.silence, { room });
    await delay(3000);
    const phone = await launchPeer('Student1', fixtures.silence, { room, phone: true });
    await delay(9000);

    const ids = {
        teacher: await teacher.page.evaluate(() => rc.peer_id),
        phone: await phone.page.evaluate(() => rc.peer_id),
    };
    const mobileDetected = await phone.page.evaluate(() => !!rc.isMobileDevice);
    const pip = (state, кто, что) => state.окошки.some((p) => p.кто === кто && p.что === что);

    const soloBefore = await lookLayout(phone);
    await startShare(teacher);
    await delay(8000);
    const soloShare = await lookLayout(phone);
    await stopShare(teacher);
    await delay(8000);
    const soloBack = await lookLayout(phone);

    const student2 = await launchPeer('Student2', fixtures.silence, { room });
    await delay(10000);
    const groupBefore = await lookLayout(phone);
    await startShare(teacher);
    await delay(8000);
    const groupShare = await lookLayout(phone);

    await student2.browser.close();
    await phone.browser.close();
    await teacher.browser.close();

    return {
        scenario: 'phone-pips',
        soloBefore,
        soloShare,
        soloBack,
        groupBefore,
        groupShare,
        checks: {
            mobileDetected, // без этого проверка ничего не значит
            // вдвоём: педагог крупно, своя камера окошком
            soloTeacherBig: soloBefore.крупно?.кто === ids.teacher && soloBefore.крупно?.что === 'камера',
            soloOwnPip: pip(soloBefore, ids.phone, 'своё'),
            // вдвоём и показ: экран крупно, в углу лицо педагога И своя камера
            soloShareBig: soloShare.крупно?.кто === ids.teacher && soloShare.крупно?.что === 'экран',
            soloShareAuthorFace: pip(soloShare, ids.teacher, 'лицо-автора'),
            soloShareOwnPip: pip(soloShare, ids.phone, 'своё'),
            // показ закончился — вернулись
            soloBackBig: soloBack.крупно?.кто === ids.teacher && soloBack.крупно?.что === 'камера',
            soloBackNoAuthorPip: !pip(soloBack, ids.teacher, 'лицо-автора'),
            // группа: своя камера окошком (её раньше не было вовсе)
            groupOwnPip: pip(groupBefore, ids.phone, 'своё'),
            groupTeacherBig: groupBefore.крупно?.кто === ids.teacher && groupBefore.крупно?.что === 'камера',
            // группа и показ: экран крупно, лицо педагога окошком
            groupShareBig: groupShare.крупно?.кто === ids.teacher && groupShare.крупно?.что === 'экран',
            groupShareAuthorFace: pip(groupShare, ids.teacher, 'лицо-автора'),
            groupShareOwnPip: pip(groupShare, ids.phone, 'своё'),
        },
    };
}

// Микрофон И КАМЕРА студента на входе решает школа, а не память браузера.
// Браузер, помнящий прошлый вход без микрофона и без камеры (так бывает после
// снятых правил «студенты входят с выключенным микрофоном / без видео»), всё
// равно должен войти слышимым и видимым: ребёнок не понимает, почему его не
// слышат и не видят (Иван, 2026-08-19).
async function runStudentMicScenario() {
    const room = 'montemeet-group';
    const teacher = await launchPeer('Teacher', fixtures.silence, { room });
    await delay(3000);
    const student = await launchPeer('Student1', fixtures.silence, {
        room,
        memory: { audio: false, video: false, audioVideo: false },
    });
    await delay(14000);

    const mine = await student.page.evaluate(() => ({
        микрофонРаботает: !!rc.producerExist(RoomClient.mediaType.audio),
        камераРаботает: !!rc.producerExist(RoomClient.mediaType.video),
        память: JSON.parse(localStorage.getItem('INIT_CONFIG') || '{}'),
        правилоМолчания: !!rc.getModerator()?.audio_start_muted,
        правилоБезВидео: !!rc.getModerator()?.video_start_hidden,
    }));
    const seen = await teacher.page.evaluate(() => {
        const one = [...rc.peers.values()].find((p) => p.peer_info?.peer_name === 'Student1');
        return { слышно: !!one?.peer_info?.peer_audio, видно: !!one?.peer_info?.peer_video };
    });

    await student.browser.close();
    await teacher.browser.close();

    return {
        scenario: 'student-mic',
        mine,
        seen,
        checks: {
            noMutePolicy: mine.правилоМолчания === false, // без этого проверки ничего не значат
            noHiddenPolicy: mine.правилоБезВидео === false,
            micProducing: mine.микрофонРаботает === true,
            cameraProducing: mine.камераРаботает === true,
            teacherSeesMicOn: seen.слышно === true,
            teacherSeesCameraOn: seen.видно === true,
            memoryHealedAudio: mine.память.audio === true,
            memoryHealedVideo: mine.память.video === true,
            memoryHealedBoth: mine.память.audioVideo === true,
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
if (which === 'tab-return' || which === 'all') {
    const r = await runTabReturnScenario();
    r.pass = Object.values(r.checks).every(Boolean);
    results.push(r);
}
if (which === 'screen-tile' || which === 'all') {
    const r = await runScreenTileScenario();
    r.pass = Object.values(r.checks).every(Boolean);
    results.push(r);
}
if (which === 'splash-speech' || which === 'all') {
    const r = await runSplashSpeechScenario();
    r.pass = Object.values(r.checks).every(Boolean);
    results.push(r);
}
if (which === 'room-policy' || which === 'all') {
    const r = await runRoomPolicyScenario();
    r.pass = Object.values(r.checks).every(Boolean);
    results.push(r);
}
if (which === 'concert-solo' || which === 'all') {
    const r = await runConcertSoloScenario();
    r.pass = Object.values(r.checks).every(Boolean);
    results.push(r);
}
if (which === 'toast' || which === 'all') {
    const r = await runToastScenario();
    r.pass = Object.values(r.checks).every(Boolean);
    results.push(r);
}
if (which === 'phantom-tap' || which === 'all') {
    const r = await runPhantomTapScenario();
    r.pass = Object.values(r.checks).every(Boolean);
    results.push(r);
}
if (which === 'solo-share' || which === 'all') {
    const r = await runSoloShareScenario();
    r.pass = Object.values(r.checks).every(Boolean);
    results.push(r);
}
if (which === 'group-share' || which === 'all') {
    const r = await runGroupShareScenario();
    r.pass = Object.values(r.checks).every(Boolean);
    results.push(r);
}
if (which === 'student-mic' || which === 'all') {
    const r = await runStudentMicScenario();
    r.pass = Object.values(r.checks).every(Boolean);
    results.push(r);
}
if (which === 'phone-pips' || which === 'all') {
    const r = await runPhonePipsScenario();
    r.pass = Object.values(r.checks).every(Boolean);
    results.push(r);
}
if (which === 'no-video-big' || which === 'all') {
    const r = await runNoVideoBigScenario();
    r.pass = Object.values(r.checks).every(Boolean);
    results.push(r);
}

// Отчёт машинам: сценарий room-policy подгружает наш загрузчик профилей, а он
// пишет в тот же поток — метка отделяет отчёт от посторонних строк (Иван, 2026-08-18)
console.log('---РЕЗУЛЬТАТЫ---');
console.log(JSON.stringify(results, null, 2));
process.exitCode = results.every((r) => r.pass) ? 0 : 1;
