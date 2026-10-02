// Montemeet dev: групповые команды веб-педагога (02.10.2026, план приложения 3.4).
//
// Headless-педагог «Zal» с фальшивой камерой входит в комнату, ждёт WAIT секунд (пока войдёт
// приложение), затем шлёт команды «всем» — как кнопки панели участников веба
// (Room.js: rc.peerAction('me', socket.id, '<действие>', true, true)): по одной через PAUSE с.
//
// Usage: WAIT=40 ACTIONS=mute,hide node dev-group.mjs [room] [base]
import puppeteer from 'puppeteer-core';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ROOM = process.argv[2] || 'montemeet-smoke';
const BASE = process.argv[3] || 'https://meet.montessori.ua';
const WAIT = Number(process.env.WAIT || 40);
const PAUSE = Number(process.env.PAUSE || 8);
const ACTIONS = (process.env.ACTIONS || 'mute,hide').split(',').filter(Boolean);
// Без подмены mediasoup-client не узнаёт HeadlessChrome (как в dev-smoke).
const UA =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';
const flags = [
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    '--mute-audio',
    '--ignore-certificate-errors',
];
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString().slice(11, 19);

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, acceptInsecureCerts: true, args: flags });
const page = await browser.newPage();
await page.setUserAgent(UA);
await page.setViewport({ width: 1280, height: 800 });
await page.goto(`${BASE}/join/${ROOM}?name=Zal&audio=1&video=1&notify=0`, { waitUntil: 'networkidle2', timeout: 30000 });
console.log(now(), 'педагог вошёл, жду', WAIT, 'с');
await delay(WAIT * 1000);
for (const action of ACTIONS) {
    // rec-start / rec-stop — начало и конец записи урока (план приложения 3.5): веб шлёт
    // recordingAction с enums.recording.start / stop, без окна подтверждения.
    if (action === 'rec-start' || action === 'rec-stop') {
        const res = await page.evaluate((a) => {
            if (typeof rc === 'undefined' || !rc) return 'нет rc';
            rc.recordingAction(a === 'rec-start' ? enums.recording.start : enums.recording.stop);
            return 'ушло';
        }, action);
        console.log(now(), 'запись:', action, '—', res);
        await delay(PAUSE * 1000);
        continue;
    }
    const res = await page.evaluate((a) => {
        if (typeof rc === 'undefined' || !rc) return 'нет rc';
        const id = typeof socket !== 'undefined' && socket?.id ? socket.id : rc.peer_id;
        rc.peerAction('me', id, a, true, true);
        return 'ушло от ' + id;
    }, action);
    // Групповую команду веб шлёт только после «Да» во всплывающем окне (confirmPeerAction).
    await delay(1000);
    const confirmed = await page.evaluate(() => {
        const b = document.querySelector('.swal2-confirm');
        if (!b) return false;
        b.click();
        return true;
    });
    console.log(now(), 'всем:', action, '—', res, confirmed ? '(подтверждено)' : '(окна не было)');
    await delay(PAUSE * 1000);
}
await browser.close();
console.log(now(), 'готово');
