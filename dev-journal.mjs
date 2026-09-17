// Montemeet dev journal: журнал событий комнат пишет то, что должен, и не даёт
// клиенту подменить свои поля (app/src/MontemeetEvents.js).
//
// Сценарии:
//   diag-types  — новые виды mmDiag от приложения (audio-route, audio-core)
//                 попадают в журнал, неизвестный вид отбрасывается;
//   diag-fields — клиент не перебивает серверные поля записи (t, room, ev,
//                 peer, what), обычная запись info от веба не меняется;
//   ice-failed  — транспорт, который начал соединяться и за 20 с так и не
//                 соединился, даёт ровно одну запись link с ice=failed;
//                 обычный вход и уход раньше срока такой записи не дают.
//
// Запуск (сервер форка поднят на https://localhost:3010, комната spec-lesson
// есть в реестре — см. Montemeet/app-spec/ENV.md):
//   node dev-journal.mjs [diag-types|diag-fields|ice-failed]   (по умолчанию все)
//
// Для ice-failed скрипт сам поднимает второй экземпляр сервера на :3013 с
// недостижимым объявленным адресом (203.0.113.1, TEST-NET-3) и своим каталогом
// журнала, а в конце гасит его.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';
import puppeteer from 'puppeteer-core';

process.env.DOTENV_CONFIG_QUIET = 'true';

const BASE = process.env.MM_TEST_BASE || 'https://localhost:3010';
const ROOM = process.env.MM_TEST_ROOM || 'spec-lesson';
const CHROME = process.env.MM_TEST_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const EVENTS_DIR = process.env.MONTEMEET_EVENTS_DIR || path.join(import.meta.dirname, 'montemeet-events');
const FAIL_PORT = 3013;
// обычный Chrome: «HeadlessChrome» клиентская библиотека mediasoup не признаёт,
// и страница входит в комнату без медиа
const UA =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';
const FAIL_T = 20; // секунд — порог из MontemeetEvents.js (ICE_FAILED_MS)
const TIMEOUT = 8000;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const today = () => new Date().toLocaleDateString('sv');

// ---------- сырое соединение engine.io ----------

function open(base = BASE) {
    const url = base.replace(/^http/, 'ws') + '/socket.io/?EIO=4&transport=websocket';
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(url, { rejectUnauthorized: false });
        const acks = new Map();
        let next = 0;
        let sid = null;
        const api = {
            get sid() {
                return sid;
            },
            emit(event, data, wantAck = false) {
                const args = data === undefined ? [event] : [event, data];
                if (!wantAck) return ws.send('42' + JSON.stringify(args));
                const id = next++;
                ws.send('42' + id + JSON.stringify(args));
                return new Promise((res, rej) => {
                    acks.set(id, res);
                    setTimeout(() => acks.has(id) && (acks.delete(id), rej(new Error('ответа нет'))), TIMEOUT);
                });
            },
            close: () => ws.close(),
        };
        ws.on('message', (buf) => {
            const s = buf.toString();
            if (s === '2') return ws.send('3');
            if (s.startsWith('0')) return ws.send('40');
            if (s.startsWith('40')) {
                sid = JSON.parse(s.slice(2)).sid;
                return resolve(api);
            }
            const m = s.match(/^43(\d+)(\[.*)$/s);
            if (m && acks.has(Number(m[1]))) {
                const res = acks.get(Number(m[1]));
                acks.delete(Number(m[1]));
                res(JSON.parse(m[2])[0]);
            }
        });
        ws.on('error', reject);
        setTimeout(() => reject(new Error('нет рукопожатия')), TIMEOUT);
    });
}

async function joinRaw(name) {
    const c = await open();
    await c.emit('createRoom', { room_id: ROOM }, true);
    const res = await c.emit(
        'join',
        {
            room_id: ROOM,
            peer_info: { peer_name: name, peer_id: c.sid, peer_uuid: 'journal-' + name, peer_audio: false, peer_video: false },
        },
        true
    );
    if (typeof res === 'string') throw new Error('вход отклонён: ' + res);
    return c;
}

// записи журнала за сегодня, появившиеся после отметки
function journalSince(mark, dir = EVENTS_DIR) {
    let text = '';
    try {
        text = fs.readFileSync(path.join(dir, `${today()}.ndjson`), 'utf-8');
    } catch (e) {
        return [];
    }
    return text
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
        .filter((r) => r.t >= mark);
}

const results = [];
const check = (scenario, checks, extra = {}) => {
    const pass = Object.values(checks).every(Boolean);
    results.push({ scenario, pass, checks, ...extra });
    console.log(`${pass ? '+' : '—'} ${scenario}`, JSON.stringify(checks));
};

// ---------- diag-types ----------

async function diagTypes() {
    const mark = new Date().toISOString();
    const name = 'Diag' + Date.now().toString(36).slice(-4);
    const c = await joinRaw(name);
    c.emit('mmDiag', { type: 'audio-route', route: 'bt', why: 'system' });
    c.emit('mmDiag', { type: 'audio-core', state: 'restart', aec: true, ms: 120 });
    c.emit('mmDiag', { type: 'no-such-kind', x: 1 });
    await delay(1200);
    c.close();
    const mine = journalSince(mark).filter((r) => r.ev === 'device' && r.peer === name);
    const route = mine.find((r) => r.what === 'audio-route');
    const core = mine.find((r) => r.what === 'audio-core');
    check('diag-types', {
        routeWritten: !!route && route.route === 'bt' && route.why === 'system',
        coreWritten: !!core && core.state === 'restart' && core.aec === true && core.ms === 120,
        unknownDropped: !mine.some((r) => r.what === 'no-such-kind'),
    });
}

// ---------- diag-fields ----------

async function diagFields() {
    const mark = new Date().toISOString();
    const name = 'Fields' + Date.now().toString(36).slice(-4);
    const c = await joinRaw(name);
    c.emit('mmDiag', {
        type: 'info',
        dev: 'phone',
        room: 'x-room',
        peer: 'y-peer',
        ev: 'z-ev',
        what: 'w-what',
        t: '1999-01-01T00:00:00.000Z',
        mode: 'ok',
        Room: 'x-room-2', // регистр тоже не спасает
    });
    await delay(1200);
    c.close();
    const all = journalSince(mark);
    const rec = all.find((r) => r.ev === 'device' && r.peer === name);
    check(
        'diag-fields',
        {
            written: !!rec,
            roomIsReal: rec?.room === ROOM,
            peerIsReal: rec?.peer === name,
            evIsDevice: rec?.ev === 'device',
            whatIsInfo: rec?.what === 'info',
            timeIsReal: !!rec && rec.t >= mark,
            clientFieldKept: rec?.dev === 'phone' && rec?.mode === 'ok',
            noCaseVariant: !!rec && !('Room' in rec),
            noForgedRecord: !all.some((r) => r.room === 'x-room' || r.peer === 'y-peer' || r.ev === 'z-ev'),
        },
        { record: rec }
    );
}

// обычная запись info от настоящей страницы — такая же, как до правки
async function webInfo() {
    const mark = new Date().toISOString();
    const name = 'Web' + Date.now().toString(36).slice(-4);
    const b = await launch();
    const p = await page(b);
    await p.goto(`${BASE}/join/${ROOM}?name=${name}&notify=0`, { waitUntil: 'domcontentloaded' });
    await delay(9000); // MontemeetDiag шлёт первое сообщение через 3 с после входа
    await b.close();
    const rec = journalSince(mark).find((r) => r.ev === 'device' && r.peer === name && r.what === 'info');
    const keys = rec ? Object.keys(rec).join(',') : '';
    check(
        'diag-web-info',
        {
            written: !!rec,
            keyOrder: keys.startsWith('t,room,ev,peer,what,dev'),
            fields: !!rec && typeof rec.touch === 'number' && typeof rec.coarse === 'boolean',
        },
        { keys }
    );
}

// ---------- ice-failed ----------

function launch(extraArgs = []) {
    return puppeteer.launch({
        executablePath: CHROME,
        headless: true,
        acceptInsecureCerts: true,
        args: [
            '--use-fake-device-for-media-stream',
            '--use-fake-ui-for-media-stream',
            '--autoplay-policy=no-user-gesture-required',
            '--mute-audio',
            '--ignore-certificate-errors',
            ...extraArgs,
        ],
    });
}

async function page(browser) {
    const p = await browser.newPage();
    await p.setUserAgent(UA);
    return p;
}

async function startFailingServer(dir) {
    const env = {
        ...process.env,
        SERVER_LISTEN_PORT: String(FAIL_PORT),
        SERVER_HOST_URL: `https://localhost:${FAIL_PORT}`,
        SFU_ANNOUNCED_IP: '203.0.113.1', // TEST-NET-3: пакеты туда не дойдут
        SFU_MIN_PORT: '41000',
        SFU_MAX_PORT: '41100',
        MONTEMEET_EVENTS_DIR: dir,
        MONTEMEET_JOURNAL_FILE: path.join(dir, 'journal.ndjson'),
    };
    const child = spawn(process.execPath, ['app/src/Server.js'], {
        cwd: import.meta.dirname,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const started = Date.now();
    while (Date.now() - started < 30000) {
        try {
            const res = await fetch(`https://localhost:${FAIL_PORT}/config`);
            if (res.ok) return child;
        } catch (e) {
            /* ещё не поднялся */
        }
        if (child.exitCode !== null) break;
        await delay(500);
    }
    child.kill('SIGKILL');
    throw new Error('второй сервер не поднялся: ' + out.slice(-400));
}

async function iceFailed() {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // самоподписанный сертификат стенда
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-journal-'));
    const server = await startFailingServer(dir);
    const failBase = `https://localhost:${FAIL_PORT}`;
    const browsers = [];
    try {
        const mark = new Date().toISOString();
        const join = async (name) => {
            const b = await launch();
            browsers.push(b);
            const p = await page(b);
            await p.goto(`${failBase}/join/${ROOM}?name=${name}&notify=0`, { waitUntil: 'domcontentloaded' });
            return b;
        };
        const failed = (who) =>
            journalSince(mark, dir).filter((r) => r.ev === 'link' && r.peer === who && r.ice === 'failed');

        // 1. Один в комнате: передающий транспорт начинает соединяться (и не
        // может), принимающему принимать нечего — он не соединяется вовсе и
        // сбоем не считается
        await join('Alone');
        await delay((FAIL_T + 10) * 1000);
        const alonePhase1 = failed('Alone');

        // 2. Гость входит и уходит раньше срока — его сбоя нет. Зато у первого
        // теперь есть что принимать: его приём начинает соединяться и через
        // срок тоже записывается
        const early = await join('Early');
        await delay(8000);
        await early.close();
        await delay((FAIL_T + 6) * 1000);
        const aloneAll = failed('Alone');
        const repeated = aloneAll.filter((r) => r.dir === 'send').length;
        check(
            'ice-failed',
            {
                aloneSendFailedOnce: alonePhase1.length === 1 && alonePhase1[0].dir === 'send',
                waitAndAge: alonePhase1.length === 1 && alonePhase1[0].wait >= FAIL_T && alonePhase1[0].age >= alonePhase1[0].wait,
                noProtoNet: alonePhase1.length === 1 && !alonePhase1[0].proto && !alonePhase1[0].net,
                idleRecvNotReported: !alonePhase1.some((r) => r.dir === 'recv'),
                recvReportedOnceUsed: aloneAll.filter((r) => r.dir === 'recv').length === 1,
                notRepeated: repeated === 1,
                earlyLeaverNotReported: failed('Early').length === 0,
            },
            { aloneAll }
        );
    } finally {
        for (const b of browsers) await b.close().catch(() => {});
        server.kill('SIGTERM');
        await delay(1500);
        if (server.exitCode === null) server.kill('SIGKILL');
        fs.rmSync(dir, { recursive: true, force: true });
    }

    // обычный вход на рабочем сервере — такой записи нет
    const mark = new Date().toISOString();
    const name = 'Fine' + Date.now().toString(36).slice(-4);
    const b = await launch();
    try {
        const p = await page(b);
        await p.goto(`${BASE}/join/${ROOM}?name=${name}&notify=0`, { waitUntil: 'domcontentloaded' });
        await delay((FAIL_T + 8) * 1000);
    } finally {
        await b.close();
    }
    const recs = journalSince(mark);
    const links = recs.filter((r) => r.ev === 'link' && r.peer === name);
    check('ice-ok', {
        connected: links.some((r) => r.ice === 'completed' || r.ice === 'connected'),
        noFailedRecord: !links.some((r) => r.ice === 'failed'),
    });
}

// ---------- прогон ----------

const which = process.argv[2] || 'all';
if (which === 'diag-types' || which === 'all') await diagTypes();
if (which === 'diag-fields' || which === 'all') {
    await diagFields();
    await webInfo();
}
if (which === 'ice-failed' || which === 'all') await iceFailed();

const ok = results.length > 0 && results.every((r) => r.pass);
console.log('---РЕЗУЛЬТАТЫ---');
console.log(JSON.stringify(results, null, 2));
process.exitCode = ok ? 0 : 1;
