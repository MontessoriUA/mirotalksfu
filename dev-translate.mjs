// Montemeet dev translate: зонд синхронного перевода. Montemeet к нему ещё не
// причастен — это замер поставщика на наших фразах урока, шаг 2 плана
// (Montemeet/app-spec/TRANSLATE.md §10).
//
// Что делает: берёт набор фраз урока (Montemeet/app-spec/translate-phrases),
// отправляет каждую поставщику ЖИВЫМ ПОТОКОМ — чанками в реальном времени, как
// шёл бы разговор, — и снимает:
//   • сколько прошло до первого переведённого слова текстом и голосом;
//   • когда перевод закончился и насколько отстал от источника;
//   • что переводчик услышал (у Qwen это бесплатно и всегда включено);
//   • выжили ли музыкальные термины и фамилии композиторов — проверка
//     автоматическая, по словарю из phrases.json;
//   • настоящий расход (у Qwen — из поля usage, у OpenAI — по минутам звука).
// Переведённый звук сохраняется в wav, чтобы послушать ушами.
//
// Поставщик за одним интерфейсом — это заодно репетиция шага 4, где подменный
// поставщик нужен уже в сервере встреч.
//
// Проверки на известные сбои (TRANSLATE.md §3.4 — то, что нашли посторонние):
//   names      — подмена имён собственных («Marcus» → «the market» у OpenAI);
//   monologue  — отставание на плотной речи, до двадцати секунд в худшем случае;
//   same-lang  — тишина вместо перевода, когда речь уже на целевом языке;
//   mixed      — китайское слово внутри русской фразы (то же, но мягче);
//   drain      — не оборвался ли перевод посередине.
//
// Ключи только из окружения, в репозиторий они не попадают:
//   TRANSLATE_QWEN_KEY      ключ Alibaba Cloud Model Studio (регион Singapore)
//   TRANSLATE_OPENAI_KEY    ключ OpenAI
//   TRANSLATE_PHRASES       папка с набором фраз (если не рядом с форком)
//
// Запуск (Node 24; на маке первым в PATH стоит Node 20):
//   node dev-translate.mjs qwen
//   node dev-translate.mjs qwen --glossary
//   node dev-translate.mjs openai --kind name
//   node dev-translate.mjs qwen --only mono-ru
//   node dev-translate.mjs qwen --limit 5 --same-lang

import fs from 'node:fs';
import path from 'node:path';
import { WebSocket } from 'ws';

// Ключи берём из .env стенда, как и сервер. Так их не надо передавать флагом
// или в командной строке — в историю оболочки они не попадают.
try {
    process.loadEnvFile(path.join(import.meta.dirname, '.env'));
} catch {
    /* .env может не быть — тогда ключи ждём из окружения */
}

// ---------- разбор аргументов ----------

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const value = (name, fallback = null) => {
    const i = argv.indexOf(`--${name}`);
    return i > -1 && argv[i + 1] ? argv[i + 1] : fallback;
};

const providerName = argv.find((a) => !a.startsWith('--') && !argv[argv.indexOf(a) - 1]?.startsWith('--')) || 'qwen';
const useGlossary = flag('glossary');
const onlyId = value('only');
const onlyKind = value('kind');
const limit = Number(value('limit', 0)) || 0;
const sameLang = flag('same-lang');

// ---------- где лежит набор фраз ----------

const HERE = import.meta.dirname;
const phrasesDir =
    process.env.TRANSLATE_PHRASES || path.resolve(HERE, '..', 'Montemeet', 'app-spec', 'translate-phrases');

if (!fs.existsSync(path.join(phrasesDir, 'phrases.json'))) {
    console.error(`Набора фраз нет: ${phrasesDir}`);
    console.error('Укажите папку в TRANSLATE_PHRASES или положите репозиторий Montemeet рядом с форком.');
    process.exit(2);
}
const spec = JSON.parse(fs.readFileSync(path.join(phrasesDir, 'phrases.json'), 'utf8'));

// ---------- wav ----------

function readPcm(file) {
    const b = fs.readFileSync(file);
    let rate = 0;
    let pos = 12;
    while (pos + 8 <= b.length) {
        const id = b.toString('ascii', pos, pos + 4);
        const size = b.readUInt32LE(pos + 4);
        if (id === 'fmt ') rate = b.readUInt32LE(pos + 12);
        if (id === 'data') return { rate, pcm: b.subarray(pos + 8, Math.min(pos + 8 + size, b.length)) };
        pos += 8 + size + (size % 2);
    }
    throw new Error(`в ${path.basename(file)} нет блока data`);
}

function writeWav(file, rate, pcm) {
    const h = Buffer.alloc(44);
    h.write('RIFF', 0, 'ascii');
    h.writeUInt32LE(36 + pcm.length, 4);
    h.write('WAVEfmt ', 8, 'ascii');
    h.writeUInt32LE(16, 16);
    h.writeUInt16LE(1, 20);
    h.writeUInt16LE(1, 22);
    h.writeUInt32LE(rate, 24);
    h.writeUInt32LE(rate * 2, 28);
    h.writeUInt16LE(2, 32);
    h.writeUInt16LE(16, 34);
    h.write('data', 36, 'ascii');
    h.writeUInt32LE(pcm.length, 40);
    fs.writeFileSync(file, Buffer.concat([h, pcm]));
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- поставщики за одним интерфейсом ----------
//
// Описание протоколов — TRANSLATE.md §3.1 (Qwen) и §3.2 (OpenAI). Отличий
// немного, но все существенные: частота, размер чанка, имена событий и то, как
// задаётся язык.

const PROVIDERS = {
    qwen: {
        title: 'Qwen LiveTranslate',
        rate: 16000,
        chunkMs: 100,
        outRate: 24000,
        keyEnv: 'TRANSLATE_QWEN_KEY',
        model: () => process.env.TRANSLATE_QWEN_MODEL || 'qwen3.8-livetranslate-flash-realtime',
        url() {
            const base =
                process.env.TRANSLATE_QWEN_URL || 'wss://ap-southeast-1.maas.qwencloudapi.com/api-ws/v1/realtime';
            return `${base}?model=${this.model()}`;
        },
        start(target, glossary) {
            const translation = { language: target };
            if (glossary) translation.corpus = { phrases: glossary };
            return { type: 'session.update', session: { output_modalities: ['text', 'audio'], translation } };
        },
        append: (b64) => ({ type: 'input_audio_buffer.append', audio: b64 }),
        stop: { type: 'session.finish' },
        map(m) {
            switch (m.type) {
                case 'session.created':
                    return { kind: 'created' };
                case 'session.updated':
                    return { kind: 'ready' };
                case 'conversation.item.input_audio_transcription.delta':
                    return { kind: 'heard', text: m.delta || '' };
                case 'conversation.item.input_audio_transcription.completed':
                    return { kind: 'heardDone', text: m.transcript || '' };
                case 'response.audio_transcript.delta':
                case 'response.text.delta':
                    return { kind: 'text', text: m.delta || '' };
                case 'response.audio.delta':
                    return { kind: 'audio', b64: m.delta || '' };
                case 'response.done':
                    return { kind: 'turnDone', usage: m.response?.usage || m.usage || null };
                case 'session.finished':
                    return { kind: 'closed' };
                case 'error':
                    return { kind: 'error', message: m.error?.message || JSON.stringify(m).slice(0, 300) };
                default:
                    return null;
            }
        },
    },

    openai: {
        title: 'OpenAI gpt-realtime-translate',
        rate: 24000,
        chunkMs: 200,
        outRate: 24000,
        keyEnv: 'TRANSLATE_OPENAI_KEY',
        model: () => process.env.TRANSLATE_OPENAI_MODEL || 'gpt-realtime-translate',
        url() {
            const base = process.env.TRANSLATE_OPENAI_URL || 'wss://api.openai.com/v1/realtime/translations';
            return `${base}?model=${this.model()}`;
        },
        start(target) {
            // глоссария у модели нет вовсе — §3.2; транскрипцию входа включаем,
            // чтобы видеть, что услышал переводчик (у OpenAI это платно)
            return {
                type: 'session.update',
                session: {
                    audio: {
                        input: { transcription: { model: process.env.TRANSLATE_OPENAI_STT || 'gpt-realtime-whisper' } },
                        output: { language: target },
                    },
                },
            };
        },
        append: (b64) => ({ type: 'session.input_audio_buffer.append', audio: b64 }),
        stop: { type: 'session.close' },
        map(m) {
            switch (m.type) {
                case 'session.created':
                    return { kind: 'created' };
                case 'session.updated':
                    return { kind: 'ready' };
                case 'session.input_transcript.delta':
                    return { kind: 'heard', text: m.delta || '' };
                case 'session.output_transcript.delta':
                    return { kind: 'text', text: m.delta || '' };
                case 'session.output_audio.delta':
                    return { kind: 'audio', b64: m.delta || '' };
                case 'session.closed':
                    return { kind: 'closed' };
                case 'error':
                    return { kind: 'error', message: m.error?.message || JSON.stringify(m).slice(0, 300) };
                default:
                    return null;
            }
        },
    },
};

const provider = PROVIDERS[providerName];
if (!provider) {
    console.error(`Поставщики: ${Object.keys(PROVIDERS).join(', ')}`);
    process.exit(2);
}
const key = process.env[provider.keyEnv];
if (!key) {
    console.error(`Нет ключа: переменная ${provider.keyEnv} не задана.`);
    console.error('Ключ в репозиторий не кладём — допишите строку в .env стенда:');
    console.error(`  ${provider.keyEnv}=...`);
    console.error('и запускайте: node dev-translate.mjs ' + providerName);
    if (providerName === 'qwen') {
        console.error('\nГде взять (TRANSLATE.md §3.1): Model Studio, регион Singapore,');
        console.error('ключ sk-ws… показывается один раз; не забыть включить «Free Quota Only».');
    }
    process.exit(2);
}

// ---------- один прогон одной фразы ----------

async function runPhrase(item, { target, glossary, tailCapMs = 30000 }) {
    const wavFile = path.join(phrasesDir, 'audio', `${provider.rate / 1000}k`, `${item.id}.wav`);
    if (!fs.existsSync(wavFile)) {
        return { id: item.id, error: `нет звука ${path.basename(wavFile)} — соберите make-audio.mjs` };
    }
    const { rate, pcm } = readPcm(wavFile);
    if (rate !== provider.rate) {
        return { id: item.id, error: `звук ${rate} Гц, а нужен ${provider.rate} Гц` };
    }

    const frame = (provider.rate * 2 * provider.chunkMs) / 1000; // байт в чанке
    const out = [];
    const res = {
        id: item.id,
        kind: item.kind,
        target,
        srcSec: pcm.length / (rate * 2),
        heard: '',
        text: '',
        usage: null,
        error: null,
        firstText: null,
        firstAudio: null,
        lastAudio: null,
    };

    const ws = new WebSocket(provider.url(), { headers: { Authorization: `Bearer ${key}` } });
    let ready = false;
    let closed = false;
    let t0 = 0;
    const since = () => (t0 ? Date.now() - t0 : null);

    ws.on('message', (buf) => {
        let m;
        try {
            m = JSON.parse(buf.toString());
        } catch {
            return;
        }
        const e = provider.map(m);
        if (!e) return;
        if (e.kind === 'ready') ready = true;
        else if (e.kind === 'heard' || e.kind === 'heardDone') res.heard = e.kind === 'heardDone' ? e.text : res.heard + e.text;
        else if (e.kind === 'text') {
            if (res.firstText === null) res.firstText = since();
            res.text += e.text;
        } else if (e.kind === 'audio') {
            if (res.firstAudio === null) res.firstAudio = since();
            res.lastAudio = since();
            out.push(Buffer.from(e.b64, 'base64'));
        } else if (e.kind === 'turnDone' && e.usage) res.usage = e.usage;
        else if (e.kind === 'closed') closed = true;
        else if (e.kind === 'error') res.error = e.message;
    });

    try {
        await new Promise((resolve, reject) => {
            ws.once('open', resolve);
            ws.once('error', reject);
            setTimeout(() => reject(new Error('нет соединения за 15 с')), 15000);
        });

        ws.send(JSON.stringify(provider.start(target, glossary)));
        for (let i = 0; i < 100 && !ready && !res.error; i++) await delay(100);
        if (res.error) throw new Error(res.error);
        if (!ready) throw new Error('сессия не настроилась за 10 с');

        // поток в реальном времени: чанк раз в chunkMs, с поправкой на снос
        t0 = Date.now();
        for (let off = 0; off < pcm.length; off += frame) {
            const due = t0 + (off / frame) * provider.chunkMs;
            const wait = due - Date.now();
            if (wait > 0) await delay(wait);
            ws.send(JSON.stringify(provider.append(pcm.subarray(off, off + frame).toString('base64'))));
            if (res.error) break;
        }

        // Хвост тишины. Нужен обоим: Qwen по тишине закрывает фразу (и не
        // тарифицирует её), а OpenAI прямо требует «keep appending silence
        // while the session is active». Ждём, пока перевод дотечёт.
        const silence = Buffer.alloc(frame).toString('base64');
        const tailStart = Date.now();
        let quietSince = null;
        while (Date.now() - tailStart < tailCapMs && !res.error) {
            await delay(provider.chunkMs);
            ws.send(JSON.stringify(provider.append(silence)));
            const got = res.lastAudio !== null;
            const quiet = got && Date.now() - (t0 + res.lastAudio) > 2000;
            if (quiet) {
                quietSince = quietSince ?? Date.now();
                if (Date.now() - quietSince > 500) break;
            } else quietSince = null;
        }

        ws.send(JSON.stringify(provider.stop));
        for (let i = 0; i < 60 && !closed; i++) await delay(100);
    } catch (err) {
        res.error = res.error || err.message;
    } finally {
        try {
            ws.close();
        } catch {
            /* уже закрыт */
        }
    }

    // переведённый звук — послушать ушами
    if (out.length) {
        const dir = path.join(HERE, 'dev-translate-results', runTag);
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, `${item.id}-${target}.wav`);
        writeWav(file, provider.outRate, Buffer.concat(out));
        res.outSec = Buffer.concat(out).length / (provider.outRate * 2);
        res.outFile = path.relative(HERE, file);
    } else {
        res.outSec = 0;
    }

    // Выжили ли термины: по словарю ru→zh из phrases.json. Проверка грубая
    // (ищем ожидаемый иероглиф в переводе), но объективная и не на глаз.
    res.terms = { expected: 0, found: 0, missing: [] };
    if (target === 'zh') {
        for (const term of item.terms || []) {
            const want = spec.glossary[term] || spec.glossary[term.toLowerCase()];
            if (!want) continue;
            res.terms.expected++;
            if (res.text.includes(want)) res.terms.found++;
            else res.terms.missing.push(`${term}→${want}`);
        }
    }
    // Отставание: когда перевод доиграл относительно конца источника.
    res.drift = res.lastAudio === null ? null : res.lastAudio / 1000 - res.srcSec;
    // Обрыв посередине (§3.4, жалоба на Qwen: «output simply stopped partway
    // through»). Ловим по тому, что переведённого звука вышло заметно меньше,
    // чем было источника. Сильное отрицательное отставание — тот же признак:
    // перевод «закончился» раньше, чем человек домолчал.
    res.ratio = res.srcSec > 0 ? res.outSec / res.srcSec : null;
    res.cut = !res.error && res.ratio !== null && res.ratio < 0.5;
    return res;
}

// ---------- прогон набора ----------

const runTag = `${providerName}${useGlossary ? '-glossary' : ''}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}`;

let items = spec.items.filter((i) => (onlyId ? i.id === onlyId : true)).filter((i) => (onlyKind ? i.kind === onlyKind : true));
if (limit) items = items.slice(0, limit);

const glossary = useGlossary ? spec.glossary : null;
if (useGlossary && providerName === 'openai') {
    console.log('— у OpenAI глоссария нет вовсе (§3.2), ключ --glossary для него не действует\n');
}

console.log(`Поставщик: ${provider.title} (${provider.model()})`);
console.log(`Фраз: ${items.length} | вход PCM ${provider.rate} Гц чанками ${provider.chunkMs} мс`);
console.log(`Глоссарий: ${glossary && providerName !== 'openai' ? `${Object.keys(glossary).length} терминов` : 'нет'}`);
console.log(`Результаты: dev-translate-results/${runTag}/\n`);

const results = [];
for (const item of items) {
    const r = await runPhrase(item, { target: item.target, glossary });
    results.push(r);
    const mark = r.error ? '—' : '+';
    const ms = (v) => (v === null || v === undefined ? '   —' : String(Math.round(v)).padStart(5));
    console.log(
        `${mark} ${item.id.padEnd(15)} ист ${r.srcSec.toFixed(1).padStart(4)}с` +
            ` | текст ${ms(r.firstText)}мс | голос ${ms(r.firstAudio)}мс` +
            ` | отстал ${r.drift === null ? '  —' : (r.drift > 0 ? '+' : '') + r.drift.toFixed(1)}с` +
            ` | термины ${r.terms?.expected ? `${r.terms.found}/${r.terms.expected}` : ' — '}` +
            (r.cut ? ` | ОБРЫВ? перевода ${r.outSec.toFixed(1)}с на ${r.srcSec.toFixed(1)}с речи` : '') +
            (r.error ? ` | ОШИБКА: ${r.error}` : '')
    );
    if (r.heard) console.log(`    услышал:  ${r.heard}`);
    if (r.text) console.log(`    перевёл:  ${r.text}`);
    if (!r.error && r.terms?.missing.length) console.log(`    потерял:  ${r.terms.missing.join(', ')}`);
    await delay(500); // не частить подключениями: у Qwen лимит 10 в минуту (§3.1)
}

// ---------- проверка «речь уже на целевом языке» ----------
//
// §3.4: у OpenAI описано, что в таком случае модель может выдать тишину вместо
// проброса. На уроке это бытовая ситуация. Берём русскую фразу и просим перевод
// на русский же.

if (sameLang) {
    const probe = spec.items.find((i) => i.id === 'lesson-03') || spec.items[0];
    console.log('\n--- речь уже на целевом языке (ждём: либо проброс, либо тишина) ---');
    const r = await runPhrase(probe, { target: probe.lang, glossary: null, tailCapMs: 12000 });
    results.push({ ...r, id: `${r.id}/same-lang` });
    console.log(
        `${r.error ? '—' : '+'} ${probe.id} → ${probe.lang}: звука ${r.outSec.toFixed(1)}с, текст «${r.text || '(пусто)'}»` +
            (r.error ? ` | ОШИБКА: ${r.error}` : '')
    );
    console.log(r.outSec > 0.2 ? '    перевод прозвучал' : '    ТИШИНА — то самое поведение из §3.4');
}

// ---------- итог ----------

const ok = results.filter((r) => !r.error);
const srcSec = results.reduce((s, r) => s + (r.srcSec || 0), 0);
const med = (a) => (a.length ? a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)] : null);
const firstAudio = med(ok.map((r) => r.firstAudio).filter((v) => v !== null));
const drifts = ok.map((r) => r.drift).filter((v) => v !== null);
const terms = ok.reduce((a, r) => ({ e: a.e + (r.terms?.expected || 0), f: a.f + (r.terms?.found || 0) }), { e: 0, f: 0 });

// Деньги: у Qwen вход звука и выход звука стоят по-разному ($7,5 и $30 за
// 1 млн токенов, TRANSLATE.md §3.1), поэтому считаем по разбивке, а не по
// общему числу токенов. Если разбивки нет — говорим об этом прямо.
const tok = ok.reduce(
    (a, r) => ({
        total: a.total + (r.usage?.total_tokens || 0),
        input: a.input + (r.usage?.input_tokens || 0),
        output: a.output + (r.usage?.output_tokens || 0),
    }),
    { total: 0, input: 0, output: 0 }
);

console.log('\n================ итог ================');
console.log(`прошло: ${ok.length}/${results.length}`);
console.log(`до первого переведённого голоса, медиана: ${firstAudio === null ? '—' : Math.round(firstAudio) + ' мс'}`);
console.log(
    `отставание от источника: медиана ${drifts.length ? med(drifts).toFixed(1) + ' с' : '—'}` +
        (drifts.length ? `, худшее ${Math.max(...drifts).toFixed(1)} с` : '')
);
console.log(`термины на месте: ${terms.e ? `${terms.f} из ${terms.e}` : '—'}`);
const cuts = ok.filter((r) => r.cut);
console.log(
    `подозрение на обрыв перевода: ${cuts.length ? `${cuts.length} (${cuts.map((r) => r.id).join(', ')})` : 'нет'}`
);
console.log(`звука отправлено: ${srcSec.toFixed(0)} с`);
if (tok.input || tok.output) {
    const cost = (tok.input / 1e6) * 7.5 + (tok.output / 1e6) * 30;
    console.log(`расход по usage: вход ${tok.input} + выход ${tok.output} токенов = $${cost.toFixed(4)}`);
    // Прямой пересчёт завышает: зонд открывает сессию на КАЖДУЮ фразу, поэтому
    // на каждую ложатся постоянные текстовые токены настройки сессии и хвост
    // тишины, который VAD дотарифицировал до закрытия фразы. На уроке сессия
    // одна на весь урок, и это платится один раз. Честная оценка — по одним
    // звуковым токенам: 7 на секунду входа и 12,5 на секунду выхода (§3.1).
    const inA = ok.reduce((s, r) => s + (r.usage?.input_tokens_details?.audio_tokens || 0), 0);
    const outA = ok.reduce((s, r) => s + (r.usage?.output_tokens_details?.audio_tokens || 0), 0);
    const outT = ok.reduce((s, r) => s + (r.usage?.output_tokens_details?.text_tokens || 0), 0);
    if (srcSec > 0) {
        console.log(`  тот же расход в лоб на урок (18 мин речи): $${((cost / (srcSec / 60)) * 18).toFixed(2)} — ЗАВЫШЕНО`);
        if (inA && outA) {
            const perSec = ((inA / 1e6) * 7.5 + (outA / 1e6) * 30 + (outT / 1e6) * 20) / srcSec;
            console.log(`  звука затарифицировано ${(inA / 7).toFixed(0)} с на ${srcSec.toFixed(0)} с речи — разницу добрала тишина до закрытия фразы`);
            console.log(`  по звуковым токенам на урок (одна сессия на урок): ≈ $${(perSec * 18 * 60).toFixed(2)}`);
        }
    }
} else if (tok.total) {
    console.log(`расход по usage: ${tok.total} токенов, разбивки на вход и выход нет`);
    console.log('  — посмотрите usage в results.json: цена входа и выхода различается вчетверо');
} else {
    console.log(`расход: поставщик usage не отдаёт; по минутам звука ≈ $${((srcSec / 60) * 0.034).toFixed(2)}`);
    console.log(`на урок 45 мин при 18 мин речи это ≈ $${(18 * 0.034).toFixed(2)}`);
}

const dir = path.join(HERE, 'dev-translate-results', runTag);
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(
    path.join(dir, 'results.json'),
    JSON.stringify({ provider: providerName, model: provider.model(), glossary: !!glossary, runTag, results }, null, 2)
);
console.log(`\nподробности: dev-translate-results/${runTag}/results.json`);
console.log('переведённый звук там же — послушать обязательно, числа разборчивости не показывают');

process.exit(results.some((r) => r.error) ? 1 : 0);
