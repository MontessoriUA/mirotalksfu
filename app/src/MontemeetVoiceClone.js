'use strict';

/*
 * Montemeet: создание голоса педагога у поставщика перевода, заранее.
 *
 * Зачем. Клон голоса звучит естественнее готового, но снятие образца на уроке
 * стоит задержки на первой фразе — на живом занятии теряется нить разговора
 * (Иван, 24.11). Поставщик умеет третий режим: голос создаётся заранее,
 * отдельно от урока, и в сессии просто указывается его идентификатор —
 * снимать на ходу нечего.
 *
 * Почему это делает конференция, а не кабинет (решение Ивана 26.11): ключ
 * поставщика лежит здесь, и выносить его во второе место незачем. Кабинет
 * сохраняет образец и просит создать голос; наружу запись не выходит —
 * поставщик принимает её прямо в теле запроса, как data:audio/...;base64
 * (проверено живым запросом 26.11).
 *
 * ВАЖНО про формат запроса. У поставщика их два, и они не взаимозаменяемы.
 * Для моделей синтеза речи — model «voice-enrollment», action «create_voice»,
 * prefix, запись строкой. Для realtime-моделей, к которым относится и наша
 * переводческая, — model «qwen-voice-enrollment», action «create»,
 * preferred_name, запись объектом audio.data. 26.11 я пробовал первый формат и
 * получил «preprocess service not found», откуда сделал неверный вывод, будто
 * заранее созданный голос для переводческой модели поставщик не делает. Иван
 * усомнился; перепроверка вторым форматом в тот же день прошла с первого
 * запроса.
 *
 * Замер 26.11 на тридцати секундах речи, перевод на английский: первый звук
 * через 5,5 с с заранее созданным голосом против 7,3 с со снятием образца на
 * ходу (готовый женский Tina — 5,4 с). То есть заранее созданный голос звучит
 * как педагог, а задержку даёт как у готового.
 *
 * Состояния DEPLOYING/OK, как у моделей синтеза, здесь нет: query отвечает
 * записью о голосе сразу после создания, и голос сразу пригоден. Поэтому
 * спрашивать готовность отдельно не нужно — достаточно знать, что голос есть.
 */

const fs = require('fs');
const path = require('path');

const KEY = () => String(process.env.TRANSLATE_QWEN_KEY || process.env.TRANSLATE_KEY || '').trim();
// Адрес берём из того же хоста, что и перевод: у нас это Сингапур.
const HOST = () => {
    const url = String(process.env.TRANSLATE_URL || '').trim();
    const m = url.match(/^wss?:\/\/([^/]+)/i);
    return m ? m[1] : 'ap-southeast-1.maas.qwencloudapi.com';
};
const API = () => `https://${HOST()}/api/v1/services/audio/tts/customization`;
const MODEL = () => String(process.env.TRANSLATE_MODEL || 'qwen3.8-livetranslate-flash-realtime').trim();
const ENROLL = 'qwen-voice-enrollment';

const MIME = {
    '.wav': 'audio/wav',
    '.mp3': 'audio/mpeg',
    '.m4a': 'audio/mp4',
    '.ogg': 'audio/ogg',
    '.webm': 'audio/webm',
    '.flac': 'audio/flac',
};

// Имя голоса у поставщика: только буквы и цифры. Из имени комнаты, чтобы в
// списке у поставщика было видно, чей это голос.
function nameOf(room) {
    const base = String(room || 'voice')
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '');
    return ('mm' + (base || 'voice')).slice(0, 20);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(input, log) {
    if (!KEY()) throw new Error('нет ключа поставщика');
    // Предел запросов у поставщика жёсткий, а образцы грузятся пачкой: на
    // «слишком часто» ждём и пробуем снова, иначе админка получит отказ на
    // ровном месте.
    for (let attempt = 1; ; attempt++) {
        const res = await fetch(API(), {
            method: 'POST',
            headers: { Authorization: `Bearer ${KEY()}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: ENROLL, input }),
            signal: AbortSignal.timeout(180000), // запись едет целиком, даём время
        });
        const text = await res.text();
        if (res.status === 429 && attempt <= 5) {
            log?.debug?.('[Voice] поставщик просит подождать', { action: input.action, attempt });
            await sleep(12000);
            continue;
        }
        let data = {};
        try {
            data = JSON.parse(text);
        } catch (e) {
            throw new Error(`ответ не разобрался: ${text.slice(0, 120)}`);
        }
        if (!res.ok || data.code) {
            throw new Error(data.message || data.code || `код ${res.status}`);
        }
        log?.debug?.('[Voice] ответ поставщика', { action: input.action, request: data.request_id });
        return data.output || {};
    }
}

// Создать голос из записи на диске. Возвращает идентификатор; он пригоден
// сразу. Если передан replace — прежний голос этого педагога удаляется, чтобы
// у поставщика не копились ненужные.
async function createVoice({ room, file, replace = '', log }) {
    const ext = path.extname(String(file || '')).toLowerCase();
    const mime = MIME[ext];
    if (!mime) throw new Error(`не тот формат записи: ${ext || 'без расширения'}`);
    const bytes = fs.readFileSync(file);
    if (!bytes.length) throw new Error('запись пустая');

    const out = await call(
        {
            action: 'create',
            target_model: MODEL(),
            preferred_name: nameOf(room),
            audio: { data: `data:${mime};base64,${bytes.toString('base64')}` },
        },
        log
    );
    const voiceId = out.voice || out.voice_id;
    if (!voiceId) throw new Error('поставщик не вернул идентификатор');
    log?.info?.('[Voice] голос создан', { room, voice: voiceId, model: MODEL() });

    if (replace && replace !== voiceId) {
        try {
            await deleteVoice(replace, log);
        } catch (err) {
            log?.warn?.('[Voice] прежний голос не удалился', { voice: replace, error: err.message });
        }
    }
    return { voiceId, model: out.target_model || MODEL() };
}

// Что поставщик знает про голос. Нет такого — вернём null, а не исключение:
// звонящему важно отличить «нет» от «не дозвонились».
async function voiceInfo(voiceId, log) {
    let out;
    try {
        out = await call({ action: 'query', voice: voiceId }, log);
    } catch (err) {
        if (/missing|invalid|not found|не найд/i.test(err.message)) return null;
        throw err;
    }
    if (!out.voice) return null;
    return { voiceId: out.voice, model: out.target_model || null, language: out.language || null, createdAt: out.gmt_create || null };
}

// Все голоса, созданные под нашу модель. Постранично по десять.
async function listVoices(log) {
    const all = [];
    for (let page = 0; page < 20; page++) {
        const out = await call({ action: 'list', target_model: MODEL(), page_index: page, page_size: 10 }, log);
        const part = out.voice_list || [];
        all.push(...part);
        if (part.length < 10) break;
    }
    return all.map((v) => ({ voiceId: v.voice, model: v.target_model, language: v.language, createdAt: v.gmt_create }));
}

async function deleteVoice(voiceId, log) {
    await call({ action: 'delete', voice: voiceId }, log);
    log?.info?.('[Voice] голос удалён', { voice: voiceId });
    return true;
}

module.exports = { createVoice, voiceInfo, listVoices, deleteVoice, nameOf };
