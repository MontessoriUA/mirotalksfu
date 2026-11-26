'use strict';

/*
 * Montemeet: создание голоса педагога у поставщика перевода, заранее.
 *
 * Зачем. Клон голоса звучит естественнее готового, но снятие образца на уроке
 * стоит до десяти секунд задержки на каждую фразу — на живом занятии теряется
 * нить разговора (Иван, 24.11). Поставщик умеет третий режим: голос создаётся
 * заранее, отдельно от урока, и в сессии просто указывается его
 * идентификатор — снимать на ходу нечего, задержки нет.
 *
 * Почему это делает конференция, а не кабинет (решение Ивана 26.11): ключ
 * поставщика лежит здесь, и выносить его во второе место незачем. Кабинет
 * сохраняет образец и просит создать голос; наружу запись не выходит.
 *
 * Публичная ссылка на запись не нужна: API принимает её прямо в теле, как
 * data:audio/...;base64 (проверено по документации и живым запросом 26.11).
 *
 * Созданный голос проходит проверку на стороне поставщика: сначала он в
 * состоянии DEPLOYING, потом OK либо UNDEPLOYED (отклонён). Поэтому
 * идентификатор мы возвращаем сразу, а готовность спрашиваем отдельно.
 */

const fs = require('fs');
const path = require('path');

const KEY = () => String(process.env.TRANSLATE_KEY || '').trim();
// Адрес берём из того же хоста, что и перевод: у нас это Сингапур.
const HOST = () => {
    const url = String(process.env.TRANSLATE_URL || '').trim();
    const m = url.match(/^wss?:\/\/([^/]+)/i);
    return m ? m[1] : 'ap-southeast-1.maas.qwencloudapi.com';
};
const API = () => `https://${HOST()}/api/v1/services/audio/tts/customization`;
const MODEL = () => String(process.env.TRANSLATE_MODEL || 'qwen3.8-livetranslate-flash-realtime').trim();

const MIME = {
    '.wav': 'audio/wav',
    '.mp3': 'audio/mpeg',
    '.m4a': 'audio/mp4',
    '.ogg': 'audio/ogg',
    '.webm': 'audio/webm',
    '.flac': 'audio/flac',
};

// Поставщик разрешает в префиксе не больше десяти знаков, только буквы и цифры.
function prefixOf(room) {
    const base = String(room || 'voice')
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '');
    return (base || 'voice').slice(0, 10);
}

async function call(input, log) {
    if (!KEY()) throw new Error('нет ключа поставщика');
    const res = await fetch(API(), {
        method: 'POST',
        headers: { Authorization: `Bearer ${KEY()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'voice-enrollment', input }),
        signal: AbortSignal.timeout(120000), // запись едет целиком, даём время
    });
    const text = await res.text();
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

// Создать голос из записи на диске. Возвращает идентификатор; готовность
// придёт позже, её спрашивают отдельно.
async function createVoice({ room, file, log }) {
    const ext = path.extname(String(file || '')).toLowerCase();
    const mime = MIME[ext];
    if (!mime) throw new Error(`не тот формат записи: ${ext || 'без расширения'}`);
    const bytes = fs.readFileSync(file);
    if (!bytes.length) throw new Error('запись пустая');

    const out = await call(
        {
            action: 'create_voice',
            target_model: MODEL(),
            prefix: prefixOf(room),
            audio: `data:${mime};base64,${bytes.toString('base64')}`,
            // Педагоги ведут на русском — с этого языка и снимается голос.
            language_hints: ['ru'],
        },
        log
    );
    if (!out.voice_id) throw new Error('поставщик не вернул идентификатор');
    log?.info?.('[Voice] голос создан', { room, voice: out.voice_id, model: MODEL() });
    return { voiceId: out.voice_id, model: MODEL() };
}

// Готов ли голос: DEPLOYING — ещё проверяется, OK — можно пользоваться,
// UNDEPLOYED — проверку не прошёл.
async function voiceStatus(voiceId, log) {
    const out = await call({ action: 'query_voice', voice_id: voiceId }, log);
    return out.status || out.voice_status || null;
}

async function deleteVoice(voiceId, log) {
    await call({ action: 'delete_voice', voice_id: voiceId }, log);
    log?.info?.('[Voice] голос удалён', { voice: voiceId });
    return true;
}

module.exports = { createVoice, voiceStatus, deleteVoice, prefixOf };
