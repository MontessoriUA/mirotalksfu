// Montemeet dev: групповые команды веб-педагога (02.10.2026, план приложения 3.4).
//
// Headless-педагог «Zal» с фальшивой камерой входит в комнату, ждёт WAIT секунд (пока войдёт
// приложение), затем шлёт команды «всем» — как кнопки панели участников веба
// (Room.js: rc.peerAction('me', socket.id, '<действие>', true, true)): по одной через PAUSE с.
//
// share / share-stop — показ экрана педагогом и его конец (план приложения 4.5): источник
// «весь экран» выбирается сам, без окна (флаги как в dev-speaker-test, сценарий screen-tile).
// lobby-on / admit — включить зал ожидания и впустить всех ждущих (живой заход 04.10).
// peek — что принимает этот веб-участник: видео на странице, их владельцы и размер кадра
// (план приложения 4.6: виден ли показ экрана из приложения).
//
// REASON — причина в окне веба перед отключением и блокировкой (план приложения 5.2).
// NAME — под каким именем войти (по умолчанию Zal — педагог montemeet-smoke; другое имя —
// студент, когда педагогом входит само приложение).
//
// Usage: WAIT=40 ACTIONS=mute,hide node dev-group.mjs [room] [base]
import puppeteer from 'puppeteer-core';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ROOM = process.argv[2] || 'montemeet-smoke';
const BASE = process.argv[3] || 'https://meet.montessori.ua';
const WAIT = Number(process.env.WAIT || 40);
const PAUSE = Number(process.env.PAUSE || 8);
const ACTIONS = (process.env.ACTIONS ?? 'mute,hide').split(',').filter(Boolean);
const NAME = process.env.NAME || 'Zal';
const REASON = process.env.REASON || '';
// Без подмены mediasoup-client не узнаёт HeadlessChrome (как в dev-smoke).
const UA =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';
const flags = [
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    '--mute-audio',
    '--ignore-certificate-errors',
    '--auto-select-desktop-capture-source=Entire screen',
    '--auto-accept-this-tab-capture',
];
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString().slice(11, 19);

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, acceptInsecureCerts: true, args: flags });
const page = await browser.newPage();
await page.setUserAgent(UA);
await page.setViewport({ width: 1280, height: 800 });
await page.goto(`${BASE}/join/${ROOM}?name=${encodeURIComponent(NAME)}&audio=1&video=1&notify=0`, {
    waitUntil: 'networkidle2',
    timeout: 30000,
});
console.log(now(), NAME, 'вошёл, жду', WAIT, 'с');
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
    // lobby-on — включить зал ожидания (как переключатель веба, roomAction 'lobbyOn');
    // admit — впустить всех ждущих (кнопка «впустить всех», lobbyAcceptAll). Живой заход
    // 04.10: впущенный из зала студент в приложении оставался без своей записи.
    if (action === 'lobby-on' || action === 'admit') {
        const res = await page.evaluate((a) => {
            if (typeof rc === 'undefined' || !rc) return 'нет rc';
            if (a === 'lobby-on') {
                rc.roomAction('lobbyOn', true, false);
                return 'ушло';
            }
            const ids = rc.lobbyGetPeerIds();
            rc.lobbyAcceptAll();
            return 'впускаю ' + ids.length;
        }, action);
        console.log(now(), 'зал ожидания:', action, '—', res);
        await delay(PAUSE * 1000);
        continue;
    }
    if (action === 'peek') {
        const seen = await page.evaluate(() =>
            [...document.querySelectorAll('video')].map((v) => ({
                id: v.id,
                name: v.getAttribute('name'),
                bar: v.getAttribute('volumeBar'),
                size: `${v.videoWidth}x${v.videoHeight}`,
            }))
        );
        console.log(now(), 'видео на странице:', JSON.stringify(seen));
        await delay(PAUSE * 1000);
        continue;
    }
    if (action === 'share' || action === 'share-stop') {
        const res = await page.evaluate(async (a) => {
            if (typeof rc === 'undefined' || !rc) return 'нет rc';
            try {
                if (a === 'share') await rc.produce(RoomClient.mediaType.screen);
                else rc.closeProducer(RoomClient.mediaType.screen, 'dev-group');
                return 'ушло';
            } catch (e) {
                return 'ошибка: ' + (e?.message || e);
            }
        }, action);
        console.log(now(), 'показ экрана:', action, '—', res);
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
    const confirmed = await page.evaluate((reason) => {
        const b = document.querySelector('.swal2-confirm');
        if (!b) return false;
        const input = document.querySelector('.swal2-input');
        if (input && reason) input.value = reason;
        b.click();
        return true;
    }, REASON);
    console.log(now(), 'всем:', action, '—', res, confirmed ? '(подтверждено)' : '(окна не было)');
    await delay(PAUSE * 1000);
}
await browser.close();
console.log(now(), 'готово');
