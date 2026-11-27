// Montemeet dev: раскладка при нескольких педагогах (записка моба ВЕБУ-27.11 §3).
//
// Студент и два РАЗНЫХ педагога (ведущие по пропуску кабинета — с 27.11 любой
// педагог ведущий в уроке), затем второй вход первого педагога, затем уход
// второго педагога. У студента после каждого шага: сколько плиток видно в
// сетке, есть ли крупное и окошко в углу. У педагога: кто у него якорь.
//
// Раскладку можно проверить ДО выкладки: LOCAL=1 подменяет в браузерах
// MontemeetLayout.js и VideoGrid.js на файлы из рабочей копии.
//
// Пропуски — JSON {ivan-nochovkin: «кука», serhii-nochovkin: «кука»}, подписанные
// на сервере на montemeet-smoke (секрет в репозитории не лежит).
// Usage: GRANTS=/путь/grants.json LOCAL=1 node dev-teacher-grid.mjs [room] [base]
import fs from 'fs';
import puppeteer from 'puppeteer-core';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ROOM = process.argv[2] || 'montemeet-smoke';
const BASE = process.argv[3] || 'https://meet.montessori.ua';
const GRANTS = JSON.parse(fs.readFileSync(process.env.GRANTS, 'utf8'));
const LOCAL = process.env.LOCAL === '1';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';
const flags = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--mute-audio', '--ignore-certificate-errors'];
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const local = {
    '/js/MontemeetLayout.js': fs.readFileSync(new URL('./public/js/MontemeetLayout.js', import.meta.url)),
    '/js/VideoGrid.js': fs.readFileSync(new URL('./public/js/VideoGrid.js', import.meta.url)),
};

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, acceptInsecureCerts: true, args: flags });

async function enter(name, grant, width = 1280, height = 800) {
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    await page.setUserAgent(UA);
    await page.setViewport({ width, height });
    if (grant) await page.setCookie({ name: 'mm_grant', value: grant, domain: new URL(BASE).hostname, path: '/', secure: true, httpOnly: true });
    if (LOCAL) {
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            const path = new URL(req.url()).pathname;
            if (local[path]) req.respond({ status: 200, contentType: 'application/javascript', body: local[path] });
            else req.continue();
        });
    }
    await page.goto(`${BASE}/join/${ROOM}?name=${encodeURIComponent(name)}&audio=0&video=1&notify=0`, { waitUntil: 'networkidle2', timeout: 40000 });
    return { name, ctx, page };
}

// Что видит участник: плитки в сетке (видимые, не в углу), крупное (фокус или
// закрепление), окошко в углу; и все плитки с тем, видны ли они.
async function look(p) {
    return p.page.evaluate(() => {
        const tiles = [...document.getElementsByClassName('Camera')];
        const name = (c) => (c.querySelector('[id$="__name"]')?.innerText || c.id).replace(/^⭐️\s*/, '').replace(/\s*🔴$/, '').trim();
        const visible = (c) => c.style.display !== 'none' && getComputedStyle(c).display !== 'none';
        const shown = tiles.filter((c) => visible(c) && !c.classList.contains('montemeet-self-pip') && !c.closest('#videoPinMediaContainer'));
        const focus = document.querySelector('[focus-mode]');
        const pinned = document.querySelector('#videoPinMediaContainer .Camera, #videoPinMediaContainer video');
        const pinName = pinned ? name(pinned.closest('.Camera') || pinned.parentElement) : null;
        return {
            presenter: typeof isPresenter !== 'undefined' && isPresenter,
            grid: shown.map(name),
            big: focus ? name(focus) : pinName ? 'закреп: ' + pinName : null,
            selfPip: !!document.querySelector('.montemeet-self-pip'),
            hiddenTwins: document.querySelectorAll('[data-mm-twin-hidden]').length,
            all: tiles.map((c) => name(c) + (visible(c) ? '' : ' [скрыта]')),
            peers: typeof rc !== 'undefined' && rc?.peers ? [...rc.peers.values()].map((x) => x.peer_info?.peer_name + (x.peer_info?.peer_presenter ? '*' : '') + (x.peer_info?.peer_account ? ' #' + x.peer_info.peer_account.slice(0, 4) : '')) : [],
        };
    });
}
const show = async (title, ...ps) => {
    console.log('\n== ' + title);
    for (const p of ps) console.log('  ' + p.name.padEnd(14), JSON.stringify(await look(p)));
};

try {
    if (process.env.TWINS === '1') {
        // Полные тёзки: два РАЗНЫХ педагога под одним именем (записка §5). Сервер
        // добавит второму « (2)», по имени они слились бы в одного — различает
        // метка аккаунта.
        const st = await enter('Студент Проба', null);
        await delay(4000);
        const a = await enter('Тёзка Проба', GRANTS['ivan-nochovkin']);
        await delay(6000);
        const b = await enter('Тёзка Проба', GRANTS['serhii-nochovkin']);
        await delay(12000);
        await show('два педагога-тёзки — у студента две плитки', st, a, b);
        process.exit(0);
    }
    const student = await enter('Студент Проба', null);
    await delay(4000);
    const t1 = await enter('Иван Проба', GRANTS['ivan-nochovkin']);
    await delay(9000);
    await show('студент и один педагог (один на один)', student, t1);

    const t2 = await enter('Сергей Проба', GRANTS['serhii-nochovkin']);
    await delay(12000);
    await show('пришёл второй педагог — у студента сетка педагогов', student, t1, t2);

    const t1b = await enter('Иван Проба', GRANTS['ivan-nochovkin']);
    await delay(12000);
    await show('второй вход первого педагога — одна плитка на педагога', student, t1b);

    await t2.ctx.close();
    await delay(12000);
    await show('второй педагог ушёл — снова один педагог (два его входа)', student);
} finally {
    await browser.close();
}
