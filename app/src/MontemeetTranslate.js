'use strict';

// Montemeet: синхронный перевод голосом — второй, тихий канал через сервер
// (вариант Б из Montemeet/app-spec/TRANSLATE.md §6).
//
// Как устроено. Говорящий отправляет копию своего звука по уже существующему
// соединению socket.io. Сервер держит сессию с поставщиком перевода и отдаёт
// результат ТОЛЬКО тем участникам, чей язык отличается от языка говорящего.
// Медиасервер при этом не трогается вовсе: ни новых дорожек, ни PlainTransport.
//
// Ключи поставщика остаются здесь, на сервере, и в браузер не попадают.
//
// События от клиента:
//   translateJoin  { lang }   участник объявляет свой язык и включает перевод
//   translateAudio { audio }  кусок его речи, base64 PCM16 16 кГц моно
//   translateLeave {}         выключить
// События клиенту:
//   translateState { on, reason, lang, peers }
//   translateText  { from, kind, text }   kind: 'heard' — что услышали у говорящего,
//                                         'translated' — перевод текстом
//   translateVoice { from, audio }        перевод голосом, base64 PCM16 24 кГц
//
// Ключи .env (без TRANSLATE_URL и TRANSLATE_KEY модуль молчит и ничего не меняет):
//   TRANSLATE_URL         адрес поставщика, например
//                         wss://ap-southeast-1.maas.qwencloudapi.com/api-ws/v1/realtime
//   TRANSLATE_MODEL       qwen3.8-livetranslate-flash-realtime
//   TRANSLATE_KEY         ключ поставщика
//   TRANSLATE_ROOMS       комнаты, где перевод разрешён (через запятую)
//   TRANSLATE_LANGS       какие языки разрешаем, по умолчанию ru,zh,en
//   TRANSLATE_MAX_SEC     предохранитель: сколько секунд звука на комнату за
//                         урок, по умолчанию 1800 (полчаса речи ≈ $1,4)
//   TRANSLATE_GLOSSARY    путь к файлу с глоссариями (phrases.json или свой)
//
// Задержка и цена — замеры в TRANSLATE.md §10.1: до первого переведённого
// голоса около 3,4 с на русский→китайский и 1,5 с обратно, урок ≈ $0,74.

const fs = require('fs');
const path = require('path');
const { WebSocket } = require('ws');
const montemeetProfiles = require('./MontemeetProfiles'); // голос перевода по полу педагога

const list = (v) =>
    String(v || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);

const url = () => String(process.env.TRANSLATE_URL || '').trim();
const key = () => String(process.env.TRANSLATE_KEY || '').trim();
const model = () => String(process.env.TRANSLATE_MODEL || 'qwen3.8-livetranslate-flash-realtime').trim();
// Комнаты с переводом: сначала настройка кабинета, потом переменная окружения.
// Звёздочка означает «все комнаты, которыми ведает кабинет» — то есть комнаты
// педагогов. Именно все, а не вообще любые: в случайной комнате, заведённой по
// ссылке, перевод включаться не должен (Иван, 25.11: «распространить на все
// комнаты педагогов, нам для тестирования»).
const rooms = () =>
    new Set(list(montemeetProfiles.translateRooms() || process.env.TRANSLATE_ROOMS).map((s) => s.toLowerCase()));
// Языки, у которых поставщик умеет и голос, а не только текст (§3.1 TRANSLATE.md)
const VOICE_LANGS = 'zh,en,ru,ar,de,fr,es,pt,id,it,ko,th,vi,ja,tr,hi,ms,nl,ur,nb,sv,da,he,fi,pl,is,cs,fil,fa';
// Список языков задаёт админка (глобальные настройки кабинета); дальше —
// переменная окружения, и только потом всё, в чём модель умеет говорить.
// Раньше список жил лишь в .env, и правка требовала захода на сервер.
const langs = () => new Set(list(montemeetProfiles.translateLangs() || process.env.TRANSLATE_LANGS || VOICE_LANGS));
// Предел на время перевода. По умолчанию его НЕТ: перевод принудительно не
// рубим (решение Ивана 25.11). Прежние полчаса на комнату выходили боком —
// педагог может сидеть в комнате весь день, впуская и выпуская студентов, и
// счётчик копился за день. А если язык окажется не тот, педагог со студентом
// это заметят сами, посмеются и поправят. Значение в TRANSLATE_MAX_SEC
// остаётся на случай, если предел когда-нибудь понадобится; 0 или пусто —
// без ограничения. Само время мы по-прежнему считаем и пишем в состояние:
// расход видно, просто он ничего не обрывает.
const maxSec = () => Number(process.env.TRANSLATE_MAX_SEC || 0);
const overLimit = (sec) => {
    const limit = maxSec();
    return limit > 0 && sec > limit;
};

const enabled = () => url().length > 0 && key().length > 0;
const allowedRoom = (roomId) => {
    const id = String(roomId || '').toLowerCase();
    const set = rooms();
    if (set.has('*')) return montemeetProfiles.isManagedRoom(roomId);
    return set.has(id);
};

// Глоссарий у поставщика односторонний («источник → перевод»), поэтому для
// каждого направления свой. Без обратного термины остаются иероглифами прямо в
// русском тексте — проверено замером (TRANSLATE.md §10.1a).
let glossaries = null;
// Глоссарии лежат папкой: common.json — общая музыкальная терминология, и по
// файлу на инструмент (piano, guitar, violin). В каждом — пары «русский термин
// → перевод» для ru-en и ru-zh: педагоги ведут на русском (Иван, 25.11).
// Обратные направления строим инверсией здесь же, вручную их не держим, чтобы
// не расходились; при совпадении перевода выигрывает первый термин.
//
// Зачем вообще: замеры 23.11 показали, что без глоссария поставщик переводит
// «колодочка» как «琴码» (подставка) — указание меняется на противоположное, а
// «Ганон» становится «пушкой». С глоссарием из 56 терминов сошлось 55.
const GLOSSARY_DIR =
    process.env.TRANSLATE_GLOSSARY_DIR || path.join(__dirname, '../../../Montemeet/app-spec/translate-glossary');

const DIRECTIONS_FILE = 'directions.json';

function loadGlossaries(log) {
    if (glossaries !== null) return glossaries;
    glossaries = { subjects: {}, titles: {}, byDirection: {} };
    let files = [];
    try {
        files = fs.readdirSync(GLOSSARY_DIR).filter((f) => f.endsWith('.json'));
    } catch (err) {
        log?.warn('[Translate] папка глоссариев не прочитана', { dir: GLOSSARY_DIR, error: err.message });
        return glossaries;
    }
    for (const file of files) {
        const key = file.replace(/\.json$/, '');
        try {
            const spec = JSON.parse(fs.readFileSync(path.join(GLOSSARY_DIR, file), 'utf8'));
            // Карта направлений — не словарь терминов, а указание, какие
            // словари брать в комнате этого типа.
            if (file === DIRECTIONS_FILE) {
                for (const [dir, list] of Object.entries(spec)) {
                    if (Array.isArray(list)) glossaries.byDirection[dir] = list;
                }
                continue;
            }
            glossaries.subjects[key] = spec.pairs || {};
            glossaries.titles[key] = spec.title || key;
        } catch (err) {
            log?.warn('[Translate] глоссарий не прочитан', { file, error: err.message });
        }
    }
    log?.info('[Translate] глоссарии загружены', {
        наборы: Object.keys(glossaries.subjects),
        направления: Object.keys(glossaries.byDirection),
    });
    return glossaries;
}

// Какие наборы терминов берём в комнате этого направления. Направление
// (оно же тип комнаты) кабинет выводит из направления педагога, и педагог на
// него не влияет — выбора предмета на уроке больше нет (Иван, 26.11): в
// музыкальной комнате уходят все музыкальные наборы разом, а предметные файлы
// остаются просто способом хранить термины по разделам.
function setsFor(direction, log) {
    const all = loadGlossaries(log);
    const named = all.byDirection[String(direction || '')];
    if (Array.isArray(named)) return named;
    // Направления нет в карте — берём только общий набор, если он есть.
    return all.subjects.common ? ['common'] : [];
}

// Словарь для пары языков «откуда → куда» в комнате этого направления.
function glossaryFor(fromLang, toLang, direction, log) {
    const all = loadGlossaries(log);
    if (!fromLang || !toLang || fromLang === toLang) return null;

    const out = {};
    for (const key of setsFor(direction, log)) {
        const pairs = key && all.subjects[key];
        if (!pairs) continue;
        const direct = pairs[`${fromLang}-${toLang}`];
        if (direct) {
            Object.assign(out, direct);
            continue;
        }
        // обратного направления в файле нет — строим из прямого
        const back = pairs[`${toLang}-${fromLang}`];
        if (!back) continue;
        for (const [term, translated] of Object.entries(back)) {
            if (!(translated in out)) out[translated] = term;
        }
    }
    const n = Object.keys(out).length;
    return n ? out : null;
}

// На каком языке сказано — по письменности. Этого хватает: кириллица,
// иероглифы и латиница различаются надёжно, а английский с французским нам
// различать не нужно — они оба латиница и оба «не русский, не китайский».
//
// Зачем. Если говорящий перешёл на язык слушателя, переводить нечего, но
// поставщик всё равно может озвучить фразу заново, и она дублирует живую речь
// (заход 24.11: Иван объявил себя англоговорящим, перешёл на русский — и
// переводчик повторил его по-русски поверх). У Qwen для этого есть
// same_language_skip_options, но версия 3.8 его не поддерживает; у OpenAI
// такое поведение встроено.
function scriptOf(text) {
    const t = String(text || '');
    if (/[\u4e00-\u9fff]/.test(t)) return 'zh';
    if (/[\u0400-\u04ff]/.test(t)) return 'ru';
    if (/[A-Za-z]/.test(t)) return 'latin';
    return null;
}

const scriptForTarget = (target) => (target === 'zh' ? 'zh' : target === 'ru' ? 'ru' : 'latin');

// ---------- сессия с поставщиком ----------
//
// Одна на пару «говорящий → целевой язык». Держится открытой, пока участник в
// комнате: соединение само по себе не тарифицируется, а тишину поставщик
// отфильтровывает своим определением речи (TRANSLATE.md §3.1).

// Голос перевода. Автоподбора по полу говорящего у поставщика нет, зато есть
// клонирование: он снимает голос с речи говорящего и говорит похожим — значит
// и пол совпадает сам. Доплаты за это нет, тарификация прежняя, по токенам.
// Пока клон не готов, звучит голос по умолчанию.
//
// Клон копирует и акцент: английская речь с русским акцентом так же прозвучит
// и в переводе (Иван, 24.11). Это свойство клонирования, а не сбой, — кому
// мешает, выбирает женский или мужской голос.
const VOICES = { female: 'Tina', male: 'Andre' };

// Ход разговора и скорость голоса — по замеру 27.11 на живых записях Ивана
// (TRANSLATE.md §10.4), решение Ивана: «1.15 — естественно звучит».
//
// server_vad вместо speaker_detection (умолчание поставщика для 3.8):
// первый звук стабильно на секунду раньше (2,4 против 3,4 с в девяти прогонах
// из девяти), и нет фиксированного порога 0,5, ниже которого звук «не доходит
// до модели» — по документации, — а с ним и тихое начало фразы. Распознавать
// говорящих нам незачем: у каждого говорящего своя сессия.
//
// speech_rate в документации 3.8 нет, но поставщик его принимает и применяет.
// Без него голос перевода длиннее самой речи: на монологе 42 с — 53 с, и
// студент дослушивает педагога через 12–17 с после того, как тот замолчал;
// с 1,15 — 40,6 с, через 3–4 с. Дальше 1,15 речь уже не ускоряется (1,25 дал
// ту же длину), а 1,2 на китайском «звучит как молотящий робот» (Иван).
//
// Оба — переменными окружения, чтобы откатить без выкладки кода.
const TURN = () => {
    const t = String(process.env.TRANSLATE_TURN || 'server_vad').trim();
    return t === 'speaker_detection' ? t : 'server_vad';
};
const SPEECH_RATE = () => {
    const v = Number(process.env.TRANSLATE_SPEECH_RATE || 1.15);
    return Number.isFinite(v) && v >= 0.5 && v <= 2 ? v : 1.15;
};

class Session {
    constructor({
        roomId,
        fromId,
        fromName,
        source,
        target,
        direction,
        voice,
        readyVoice,
        log,
        onText,
        onVoice,
        onFail,
    }) {
        this.voice = voice || 'clone';
        this.roomId = roomId;
        this.fromId = fromId;
        this.fromName = fromName;
        this.target = target;
        this.source = source || null; // язык говорящего — нужен для глоссария
        this.direction = direction || null; // направление комнаты: от него словарь
        this.readyVoice = readyVoice || null; // заранее созданный голос { id, model }
        this.log = log;
        this.onText = onText;
        this.onVoice = onVoice;
        this.onFail = onFail;

        this.ws = null;
        this.ready = false;
        this.closed = false;
        this.queued = [];
        this.sentSec = 0;
        this.openedAt = 0;
        this.reopenAt = 0;
        this.open();
    }

    open() {
        if (this.closed) return;
        // Не чаще раза в 5 с: у поставщика предел на число подключений в минуту
        const now = Date.now();
        if (now < this.reopenAt) return;
        this.reopenAt = now + 5000;
        this.openedAt = now;
        this.ready = false;

        let ws;
        try {
            ws = new WebSocket(`${url()}?model=${model()}`, { headers: { Authorization: `Bearer ${key()}` } });
        } catch (err) {
            this.log?.warn('[Translate] не удалось открыть сессию', { error: err.message });
            return;
        }
        this.ws = ws;

        ws.on('open', () => {
            const translation = { language: this.target };
            const g = glossaryFor(this.source, this.target, this.direction, this.log);
            if (g) translation.corpus = { phrases: g };

            const session = {
                output_modalities: ['text', 'audio'],
                translation,
                audio: { input: { turn_detection: { type: TURN() } } },
            };
            if (SPEECH_RATE() !== 1) session.speech_rate = SPEECH_RATE();
            if (this.voice === 'clone' && this.readyVoice && this.readyVoice.model === model()) {
                // Готовый голос: снимать образец на уроке не нужно, и задержки
                // от этого нет. Модель сверяем: голос привязан к ней, и после
                // смены модели старый не подойдёт (26.11).
                session.enable_voice_clone = true;
                session.voice_clone_options = { frequency: 'never' };
                session.voice = this.readyVoice.id;
            } else if (this.voice === 'clone') {
                // Голос снимается с речи говорящего один раз, в начале сессии.
                // Сначала стояло 'always' — снимать перед каждым ответом; на
                // живом уроке это дало лишние паузы перед каждой фразой и срывы
                // воспроизведения (Иван, 24.11): поставщик успевает снять
                // образец, и только потом говорит. 'once' — его же значение по
                // умолчанию, и голос остаётся тем же на весь разговор.
                session.enable_voice_clone = true;
                session.voice_clone_options = { frequency: 'once' };
                session.voice = 'default'; // при клонировании обязан быть такой
            } else if (VOICES[this.voice]) {
                // audio уже несёт настройку хода разговора — не затирать
                session.audio.output = { voice: VOICES[this.voice] };
            }
            ws.send(JSON.stringify({ type: 'session.update', session }));

            // Ответа ждём с оглядкой на часы. Поставщик может держать
            // соединение открытым и не прислать session.updated вовсе —
            // например, не понравилось поле в настройке. Тогда ready остаётся
            // false, закрытия нет, переоткрытия нет: тишина и пустые субтитры
            // до конца урока (разбор 25.11). Восемь секунд — с запасом: первый
            // голос приходит через 1,5-3,5 с (TRANSLATE.md §10.1).
            clearTimeout(this.readyTimer);
            this.readyTimer = setTimeout(() => {
                if (this.ready || this.closed) return;
                this.log?.warn('[Translate] поставщик не подтвердил настройку — переоткрываю', { room: this.roomId });
                try {
                    ws.close();
                } catch (e) {
                    /* уже закрыт */
                }
            }, 8000);
        });

        ws.on('message', (buf) => {
            let m;
            try {
                m = JSON.parse(buf.toString());
            } catch {
                return;
            }
            switch (m.type) {
                case 'session.updated':
                    clearTimeout(this.readyTimer);
                    this.ready = true;
                    for (const chunk of this.queued.splice(0, this.queued.length)) this.push(chunk);
                    break;
                case 'conversation.item.input_audio_transcription.delta':
                case 'conversation.item.input_audio_transcription.completed': {
                    const text = m.transcript || m.delta || '';
                    if (!text) break;
                    const said = scriptOf(text);
                    if (said && said !== this.heardScript) {
                        this.heardScript = said;
                        this.log?.info('[Translate] язык говорящего', {
                            room: this.roomId,
                            target: this.target,
                            сказано: said,
                            дублировать: said === scriptForTarget(this.target) ? 'нет' : 'переводим',
                        });
                    }
                    if (m.type.endsWith('completed')) this.onText?.('heard', text);
                    break;
                }
                case 'response.audio_transcript.delta':
                    if (m.delta && !this.sameAsTarget()) this.onText?.('translated', m.delta);
                    break;
                case 'response.audio.delta':
                    if (m.delta && !this.sameAsTarget()) this.onVoice?.(m.delta);
                    break;
                case 'error':
                    this.log?.warn('[Translate] ошибка сессии', {
                        room: this.roomId,
                        target: this.target,
                        message: m.error?.message,
                    });
                    break;
                default:
                    break;
            }
        });

        // Обрыв — обычное дело: поставщик рвёт соединение, когда накопилось
        // много звука без смыслового результата. На музыкальном уроке с паузами
        // это основной сценарий, поэтому просто открываем заново (§3.1).
        const reopen = () => {
            if (this.closed) return;
            this.ready = false;
            this.ws = null;
            // Ждём ровно столько, сколько осталось до разрешённой попытки.
            // Фиксированная секунда упиралась в ограничение по частоте и
            // возвращалась, ничего не перепланировав: сессия числилась живой,
            // звук копился и выбрасывался, перевод замолкал до конца урока
            // (разбор 25.11). Нижняя граница обязательна — иначе забьём
            // поставщика и получим запрет по частоте подключений.
            setTimeout(() => this.open(), Math.max(1000, this.reopenAt - Date.now()));
        };
        ws.on('close', reopen);
        ws.on('error', (err) => {
            this.log?.warn('[Translate] сессия отвалилась', { room: this.roomId, error: err.message });
            try {
                ws.close();
            } catch {
                /* уже закрыт */
            }
        });
    }

    // Говорят ли уже на языке слушателя. Пока ничего не услышали — переводим:
    // лучше лишняя фраза, чем проглоченная.
    sameAsTarget() {
        return this.heardScript !== null && this.heardScript === scriptForTarget(this.target);
    }

    push(b64) {
        if (this.closed) return;
        if (!this.ready || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
            // Копим немного, пока сессия поднимается: иначе теряется начало фразы
            if (this.queued.length < 50) this.queued.push(b64);
            return;
        }
        this.sentSec += Buffer.byteLength(b64, 'base64') / 2 / 16000 || 0;
        if (overLimit(this.sentSec)) {
            this.onFail?.('limit');
            this.stop();
            return;
        }
        try {
            this.ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: b64 }));
        } catch (err) {
            this.log?.warn('[Translate] не отправилось', { error: err.message });
        }
    }

    stop() {
        if (this.closed) return;
        this.closed = true;
        clearTimeout(this.readyTimer);
        const ws = this.ws;
        this.ws = null;
        if (!ws) return;
        try {
            // Закрывать сокет сразу нельзя: поставщик не узнает, что звук
            // кончился, и остаток перевода пропадёт.
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'session.finish' }));
            setTimeout(() => {
                try {
                    ws.close();
                } catch {
                    /* уже закрыт */
                }
            }, 500);
        } catch {
            /* уже закрыт */
        }
    }
}

// ---------- участники и комнаты ----------

const roomsState = new Map(); // roomId -> { peers: Map(socketId -> {lang, name}), sessions: Map(key -> Session), sec }

function stateOf(roomId) {
    if (!roomsState.has(roomId)) {
        // Голос педагога по умолчанию — по его полу из справочника школы; нет
        // записи (служебная комната, концерт) — женский, он нейтральнее на слух.
        const byGender = montemeetProfiles.presenterVoice(roomId) || 'female';

        // Голос держим отдельно для речи педагога и для речи студента: это разные
        // люди, и одинаковый голос на обе стороны путает — слушателю не понятно,
        // кого ему сейчас переводят (Иван, 24.11). 'clone' — голос самого
        // говорящего, его поставщик снимает перед каждым ответом.
        // Если голос педагога создан заранее и под ту же модель, что в сессии,
        // умолчание — он: причина предпочитать готовый голос отпала, потому что
        // снимать образец на уроке больше не нужно (замер 26.11: 5,5 с до
        // первого звука против 5,4 с у готового). Без заранее созданного голоса
        // умолчание прежнее — готовый: клон со снятием образца на ходу стоит
        // почти двух лишних секунд на первой фразе, и нить разговора теряется
        // (Иван, 24.11). В обоих случаях это только умолчание, педагог меняет
        // голос значком в панели.
        const ready = montemeetProfiles.presenterVoiceId(roomId);
        const teacherVoice = ready && ready.id && ready.model === model() ? 'clone' : byGender;

        roomsState.set(roomId, {
            peers: new Map(),
            sessions: new Map(),
            sec: 0,
            voices: { teacher: teacherVoice, student: 'female' },
        });
    }
    return roomsState.get(roomId);
}

// Кому нужен перевод речи этого участника: всем, у кого язык другой.
function targetsFor(st, fromId) {
    const from = st.peers.get(fromId);
    if (!from) return [];
    const out = new Set();
    for (const [id, p] of st.peers) if (id !== fromId && p.lang && p.lang !== from.lang) out.add(p.lang);
    return [...out];
}

function broadcastState(io, roomId) {
    const st = stateOf(roomId);
    // Признак ведущего в списке нужен студенту: по нему его панель показывает
    // язык педагога — выбрать его студент не может, но видеть должен, иначе
    // непонятно, на какой язык его переводят (Иван, 24.11).
    const peers = [...st.peers.entries()].map(([id, p]) => ({
        id,
        name: p.name,
        lang: p.lang,
        presenter: !!p.presenter,
    }));
    for (const id of st.peers.keys()) {
        io.to(id).emit('translateState', {
            on: true,
            lang: st.peers.get(id).lang,
            peers,
            voices: { ...st.voices },
            spentSec: Math.round(st.sec),
            presenter: !!st.peers.get(id).presenter,
        });
    }
}

function register({ io, socket, roomId, peerName, log, isPresenter, peersInRoom }) {
    if (!enabled() || !allowedRoom(roomId)) return;

    // Сразу говорим устройству, что перевод в этой комнате есть, — чтобы оно не
    // гадало. Клиент до 24.11 выяснял это пробой `translateJoin` с повтором, и
    // тому, кого педагог впускал из зала ожидания позже 18 секунд, попытки уже
    // кончались: обработчики к нему приходили, а кнопка не появлялась (стенд
    // 24.11, после починки самой регистрации).
    try {
        socket.emit('mmTranslateReady', {
            presenter: !!isPresenter?.(),
            // какие языки сервер примет: панель показывала все, а сервер молча
            // отвергал лишние, и перевод оставался на прежнем языке — выглядело
            // как «немецкий даёт английский» (Иван, 24.11)
            langs: [...langs()],
            // Есть ли у педагога этой комнаты заранее созданный голос. Панель до
            // включения перевода о выборе сервера не знает — свой голос она шлёт
            // сама, из значков, — так что умолчание ей нужно сказать заранее,
            // иначе серверное останется неиспользованным.
            ownVoice: stateOf(roomId).voices.teacher === 'clone',
            // Какой голос считает умолчанием сам сервер. Нужен панели, когда
            // своего голоса нет: кнопку «голос говорящего» она тогда прячет, а
            // если в памяти браузера остался прежний выбор «как говорящий» —
            // ставит вместо него этот (Иван, 26.11).
            voice: stateOf(roomId).voices.teacher,
        });
    } catch (e) {
        /* сокет уже ушёл — ничего страшного */
    }

    socket.on('translateJoin', ({ lang } = {}, cb) => {
        const want = String(lang || '').trim();
        if (!langs().has(want)) {
            // Пустой язык — это проба «есть ли перевод в комнате». Отвечаем и
            // заодно говорим, ведущий ли спрашивает: от этого зависит, покажет
            // ли ему браузер управление за всех.
            return cb?.({ error: 'язык не разрешён', presenter: !!isPresenter?.() });
        }
        const st = stateOf(roomId);
        st.peers.set(socket.id, { lang: want, name: peerName, presenter: !!isPresenter?.() });
        log?.info('[Translate] участник включил перевод', { room: roomId, peer: peerName, lang: want });
        broadcastState(io, roomId);
        cb?.({ ok: true, lang: want });
    });

    socket.on('translateAudio', ({ audio } = {}) => {
        if (!audio) return;
        const st = stateOf(roomId);
        if (!st.peers.has(socket.id)) return;
        if (overLimit(st.sec)) return;

        const targets = targetsFor(st, socket.id);

        // Собеседник сменил язык — прежняя сессия больше не нужна. Раньше она
        // висела до таймаута поставщика («Response stream timeout», заход
        // 24.11) и зря занимала подключение.
        for (const [k, session] of st.sessions) {
            if (!k.startsWith(`${socket.id}->`)) continue;
            const target = k.slice(k.indexOf('->') + 2);
            if (!targets.includes(target)) {
                session.stop();
                st.sessions.delete(k);
                log?.info('[Translate] язык собеседника сменился, сессия закрыта', { room: roomId, target });
            }
        }

        for (const target of targets) {
            const sessionKey = `${socket.id}->${target}`;
            let session = st.sessions.get(sessionKey);
            if (!session) {
                // Пишем, с каким языком и голосом открываем сессию: при
                // переключении языков педагог слышал английский вместо
                // выбранного (Иван, 24.11), а поставщик языки принимает —
                // проверено зондом. Значит смотреть надо на то, что просим мы.
                log?.info('[Translate] открываю сессию', {
                    room: roomId,
                    from: peerName,
                    'на язык': target,
                    голос: isPresenter?.() ? st.voices.teacher : st.voices.student,
                    ход: TURN(),
                    скорость: SPEECH_RATE(),
                });
                session = new Session({
                    roomId,
                    fromId: socket.id,
                    fromName: peerName,
                    source: st.peers.get(socket.id)?.lang || null,
                    target,
                    // Направление комнаты — её профиль в реестре: кабинет
                    // выводит его из направления педагога, так что словарь
                    // определён заранее и выбирать на уроке нечего.
                    direction: montemeetProfiles.forRoom(roomId)?.name || null,
                    // готовый голос берём только для речи педагога: он его и
                    // записывал
                    readyVoice: isPresenter?.() ? montemeetProfiles.presenterVoiceId(roomId) : null,
                    voice: isPresenter?.() ? st.voices.teacher : st.voices.student,
                    log,
                    onText: (kind, text) => {
                        for (const [id, p] of st.peers) {
                            if (id !== socket.id && p.lang === target) {
                                io.to(id).emit('translateText', { from: peerName, kind, text });
                            }
                        }
                        // говорящему возвращаем только «что услышали»: по нему
                        // видно, правильно ли его разобрали
                        if (kind === 'heard') io.to(socket.id).emit('translateText', { from: peerName, kind, text });
                    },
                    onVoice: (b64) => {
                        for (const [id, p] of st.peers) {
                            if (id !== socket.id && p.lang === target) {
                                io.to(id).emit('translateVoice', { from: peerName, audio: b64 });
                            }
                        }
                    },
                    onFail: (reason) => {
                        log?.warn('[Translate] перевод выключен', { room: roomId, reason });
                        // Убираем сессии этого говорящего из карты: закрытая
                        // сессия оставалась в ней навсегда, новая не создавалась,
                        // и включить перевод обратно было нельзя, пока все не
                        // выйдут из комнаты (разбор 25.11).
                        for (const [k, s2] of st.sessions) {
                            if (!k.startsWith(`${socket.id}->`)) continue;
                            try {
                                s2.stop();
                            } catch (e) {
                                /* уже закрыта */
                            }
                            st.sessions.delete(k);
                        }
                        for (const id of st.peers.keys()) io.to(id).emit('translateState', { on: false, reason });
                    },
                });
                st.sessions.set(sessionKey, session);
            }
            session.push(audio);
        }
        st.sec += Buffer.byteLength(audio, 'base64') / 2 / 16000;
    });

    // Ведущий включает перевод за всех и выбирает язык каждому. На уроке у
    // педагога заняты руки, а студент может и не найти кнопку — поэтому всё
    // управление собрано у него (решение Ивана 24.11).
    // Параметр нарочно НЕ langs: так называется функция разрешённых языков
    // выше, и одноимённый параметр её затенял — «langs is not a function»,
    // перевод не включался вовсе (заход 24.11).
    // Ведущий выбирает голос перевода: клон говорящего, женский или мужской.
    socket.on('translateVoiceMode', ({ side = 'teacher', voice } = {}, cb) => {
        if (!isPresenter?.()) return cb?.({ error: 'только ведущий' });
        const which = side === 'student' ? 'student' : 'teacher';
        const want = String(voice || '').trim();
        if (!['clone', 'female', 'male'].includes(want)) return cb?.({ error: 'нет такого голоса' });
        const st = stateOf(roomId);
        if (st.voices[which] === want) return cb?.({ ok: true, side: which, voice: want });
        st.voices[which] = want;
        // Сессии переоткроются с новым голосом: сменить его на ходу поставщик
        // не обещает, настройку ждут до первого звука. Закрываем только те,
        // чья сторона изменилась, — чужой разговор рвать незачем.
        const presenterIds = new Set((peersInRoom?.() || []).filter((p) => p.presenter).map((p) => p.id));
        for (const [key, session] of st.sessions) {
            const fromId = key.slice(0, key.indexOf('->'));
            const sideOfSession = presenterIds.has(fromId) ? 'teacher' : 'student';
            if (sideOfSession !== which) continue;
            session.stop();
            st.sessions.delete(key);
        }
        log?.info('[Translate] ведущий сменил голос перевода', { room: roomId, side: which, voice: want });
        cb?.({ ok: true, side: which, voice: want });
    });

    socket.on('translateForAll', ({ on = true, me = '', others = '', voice = '', langs: wanted = {} } = {}, cb) => {
        if (!isPresenter?.()) {
            log?.info('[Translate] не ведущий пытался включить перевод за всех', { room: roomId, peer: peerName });
            return cb?.({ error: 'только ведущий' });
        }
        const st = stateOf(roomId);
        if (voice && typeof voice === 'object') {
            for (const which of ['teacher', 'student']) {
                if (['clone', 'female', 'male'].includes(voice[which])) st.voices[which] = voice[which];
            }
        } else if (['clone', 'female', 'male'].includes(voice)) {
            st.voices.teacher = st.voices.student = voice; // прежний вид запроса
        }
        const known = wanted && typeof wanted === 'object' ? wanted : {};

        if (!on) {
            for (const [, s] of st.sessions) s.stop();
            st.sessions.clear();
            const ids = [...st.peers.keys()];
            st.peers.clear();
            for (const id of ids) io.to(id).emit('translateState', { on: false, reason: 'ведущий выключил' });
            log?.info('[Translate] ведущий выключил перевод за всех', { room: roomId });
            return cb?.({ ok: true, on: false });
        }

        // Языки раздаём по списку комнаты, а не по тому, что прислал браузер:
        // на момент нажатия он ещё никого не знает — состояние перевода
        // приходит позже, и команда уходила одному себе (заход 24.11).
        const room = peersInRoom?.() || [];
        const plan = new Map();
        for (const p of room) {
            const lang = p.id === socket.id ? me : others;
            if (lang && langs().has(lang)) plan.set(p.id, { lang, name: p.name });
        }
        // то, что браузер прислал поимённо, имеет приоритет
        for (const [id, lang] of Object.entries(known)) {
            if (langs().has(lang)) plan.set(id, { lang, name: plan.get(id)?.name || '' });
        }

        let set = 0;
        for (const [id, { lang, name }] of plan) {
            const was = st.peers.get(id);
            st.peers.set(id, { lang, name: was?.name || name || '', presenter: !!was?.presenter });
            if (id !== socket.id) io.to(id).emit('translateTurnOn', { lang });
            set++;
        }
        broadcastState(io, roomId);
        log?.info('[Translate] ведущий включил перевод за всех', { room: roomId, участников: set });
        cb?.({ ok: true, on: true, set });
    });

    const leave = () => {
        const st = roomsState.get(roomId);
        if (!st || !st.peers.has(socket.id)) return;
        st.peers.delete(socket.id);
        for (const [k, s] of st.sessions) {
            if (k.startsWith(`${socket.id}->`)) {
                s.stop();
                st.sessions.delete(k);
            }
        }
        if (st.peers.size === 0) roomsState.delete(roomId);
        else broadcastState(io, roomId);
        log?.info('[Translate] участник вышел', { room: roomId, peer: peerName });
    };

    socket.on('translateLeave', leave);
    socket.on('disconnect', leave);
}

module.exports = { enabled, allowedRoom, register, maxSec, langs };
