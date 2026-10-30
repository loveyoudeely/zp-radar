require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const TelegramBot = require('node-telegram-bot-api');
const { createClient } = require('@supabase/supabase-js');
const Groq = require('groq-sdk');

const telegramToken = process.env.TELEGRAM_BOT_TOKEN || 'PASTE_TELEGRAM_BOT_TOKEN_HERE';
const supabaseUrl = process.env.SUPABASE_URL || 'PASTE_SUPABASE_URL_HERE';
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || 'PASTE_SUPABASE_SERVICE_ROLE_KEY_HERE';
const groqApiKey = process.env.GROQ_API_KEY || '';
const allowedChatIds = new Set(
    (process.env.TELEGRAM_ALLOWED_CHAT_IDS || '')
        .split(',')
        .map(chatId => chatId.trim())
        .filter(Boolean)
);

// Установлено время жизни угрозы 5 минут
const threatLifetimeMinutes = 5;

const cityDistrictNames = [
    'Дніпровський',
    'Хортицький',
    'Комунарський',
    'Шевченківський',
    'Олександрівський',
    'Вознесенівський',
    'Заводський'
];
const cityMicrodistrictNames = [
    'Бабурка',
    'Павло-Кічкас',
    'Запоріжжя-Ліве',
    'Космічний',
    'Дослідна Станція',
    '1-й Південний',
    '3-й Південний',
    '4-й Південний',
    '5-й Південний',
    '1-й Шевченківський',
    '2-й Шевченківський',
    '3-й Шевченківський',
    'Зелений Яр',
    'Старе Місто',
    'Соцмісто',
    'Великий Луг',
    'Бородинський',
    'Осипенківський',
    'Верхня Хортиця',
    'Димитрова',
    'Селище ДД (Дніпро-Донбас)',
    'Вознесенський'
];

function normalizeZoneName(value) {
    return String(value || '').trim().toLocaleLowerCase('uk-UA').replace(/\s+/gu, ' ');
}

function loadAllowedZones() {
    const geojsonPath = path.join(__dirname, 'districts.geojson');
    const geojson = JSON.parse(fs.readFileSync(geojsonPath, 'utf8'));
    if (geojson.type !== 'FeatureCollection' || !Array.isArray(geojson.features)) {
        throw new Error('districts.geojson має бути GeoJSON FeatureCollection з масивом features.');
    }

    const allowedZones = new Map();
    const cityDistrictNamesByNormalized = new Map(
        cityDistrictNames.map(name => [normalizeZoneName(name), name])
    );
    for (const feature of geojson.features) {
        const properties = feature.properties || {};
        const name = String(properties.name || '').trim();
        const canonicalCityDistrict = cityDistrictNamesByNormalized.get(normalizeZoneName(name));
        if (!canonicalCityDistrict || !['Polygon', 'MultiPolygon'].includes(feature.geometry?.type)) continue;
        allowedZones.set(normalizeZoneName(canonicalCityDistrict), canonicalCityDistrict);
    }

    const missingCityDistricts = cityDistrictNames.filter(name => !allowedZones.has(normalizeZoneName(name)));
    if (missingCityDistricts.length) {
        throw new Error(`В districts.geojson відсутні райони міста: ${missingCityDistricts.join(', ')}.`);
    }

    for (const name of [...cityMicrodistrictNames, 'Космічний']) {
        allowedZones.set(normalizeZoneName(name), name);
    }

    return Array.from(allowedZones.values()).sort((left, right) => left.localeCompare(right, 'uk'));
}

function createLocationSystemPrompt(allowedZones) {
    return `Твоя задача — найти ТОЛЬКО районы и микрорайоны внутри города Запорожье. СТРОГО игнорируй Запорожскую область и населённые пункты за пределами города.
Возвращай ИСКЛЮЧИТЕЛЬНО JSON-массив строк. Без объектов, без ключей "name", без слова "район", без markdown и пояснений.
ПРАВИЛЬНО: ["Космічний", "Вознесенівський"]
НЕПРАВИЛЬНО: [{"name": "Космічний район"}]
Если зон нет — верни []. Список зон: ${JSON.stringify(allowedZones)}.`;
}

function normalizeText(value) {
    return String(value || '')
        .normalize('NFKC')
        .toLocaleLowerCase('uk-UA')
        .replace(/[’‘`]/gu, "'")
        .replace(/\s+/gu, ' ')
        .trim();
}

function parseLocationResponse(value, allowedZones) {
    const content = String(value || '').trim().replace(/^```(?:json)?\s*|\s*```$/giu, '').trim();
    let parsed;
    try {
        parsed = JSON.parse(content);
    } catch {
        return null;
    }
    if (!Array.isArray(parsed)) return null;

    const cleanLocations = parsed.map(item => {
        if (typeof item === 'string') return item;
        if (!item || typeof item !== 'object' || Array.isArray(item)) return '';
        const candidate = [item.name, item.location, ...Object.values(item)]
            .find(value => typeof value === 'string' && value.trim());
        return typeof candidate === 'string' ? candidate : '';
    }).map(location => location.replace(/\s+район$/iu, '').trim()).filter(Boolean);

    const allowedByNormalizedName = new Map(
        allowedZones.map(location => [normalizeZoneName(location), location])
    );
    const locations = [];
    const seen = new Set();
    for (const candidate of cleanLocations) {
        const canonicalName = allowedByNormalizedName.get(normalizeZoneName(candidate));
        if (!canonicalName) {
            console.warn(`Відхилено зону (немає в списку міста або це область): ${candidate}`);
            continue;
        }
        if (!seen.has(canonicalName)) {
            seen.add(canonicalName);
            locations.push(canonicalName);
        }
    }
    return locations;
}

async function extractLocations(groq, messageText, allowedZones, locationSystemPrompt) {
    let response;
    try {
        response = await groq.chat.completions.create({
            model: 'llama3-8b-8192', // Быстрая модель, лучше держит JSON и меньше ест лимиты
            temperature: 0,
            max_tokens: 50, // Срезали лимит, чтобы избежать ошибки 429
            messages: [
                { role: 'system', content: locationSystemPrompt },
                { role: 'user', content: messageText }
            ]
        });
    } catch (error) {
        if (error?.status === 429) {
            console.error('Лимит запросов Groq (429). Ждем следующего сообщения.');
        } else {
            console.error('Ошибка API Groq:', error.message);
        }
        return null;
    }

    const locations = parseLocationResponse(response.choices?.[0]?.message?.content, allowedZones);
    if (locations === null) return null;
    console.log(`Визначені дозволені зони: ${locations.length}`);
    return locations;
}

function detectThreatType(messageText) {
    const text = normalizeText(messageText);
    if (/(^|[^\p{L}\p{N}])(шахед|shahed|бпла|дрон|мопед|uav)(?=$|[^\p{L}\p{N}])/iu.test(text)) return 'Шахед';
    if (/(^|[^\p{L}\p{N}])(ракета|ракетний|ракетна|ракету|крилата ракета)(?=$|[^\p{L}\p{N}])/iu.test(text)) return 'Ракета';
    if (/(^|[^\p{L}\p{N}])каб(?=$|[^\p{L}\p{N}])/iu.test(text) || /керована авіабомба/iu.test(text)) return 'КАБ';
    if (/артилер/iu.test(text)) return 'Артилерія';
    return 'Невідома загроза';
}

function isCancellation(messageText) {
    return /(^|[^\p{L}\p{N}])(відбій|скасовано|не підтверджено|хибна тривога|помилкова тривога)(?=$|[^\p{L}\p{N}])/iu
        .test(normalizeText(messageText));
}

function validateConfiguration() {
    const missing = [];
    if (!telegramToken || telegramToken === 'PASTE_TELEGRAM_BOT_TOKEN_HERE') {
        missing.push('TELEGRAM_BOT_TOKEN');
    }
    if (!supabaseUrl || supabaseUrl === 'PASTE_SUPABASE_URL_HERE') {
        missing.push('SUPABASE_URL');
    }
    if (!supabaseServiceRoleKey || supabaseServiceRoleKey === 'PASTE_SUPABASE_SERVICE_ROLE_KEY_HERE') {
        missing.push('SUPABASE_SERVICE_ROLE_KEY');
    }
    if (!groqApiKey) missing.push('GROQ_API_KEY');
    if (!allowedChatIds.size) missing.push('TELEGRAM_ALLOWED_CHAT_IDS');
    if (missing.length) {
        throw new Error(`Заполните переменные окружения: ${missing.join(', ')}.`);
    }
}

async function main() {
    validateConfiguration();
    const allowedZones = loadAllowedZones();
    const locationSystemPrompt = createLocationSystemPrompt(allowedZones);

    const supabase = createClient(supabaseUrl, supabaseServiceRoleKey, {
        auth: { persistSession: false, autoRefreshToken: false }
    });
    const groq = new Groq({ apiKey: groqApiKey });
    const bot = new TelegramBot(telegramToken, { polling: true });

    async function handleMessage(message) {
        const chatId = String(message.chat.id);
        if (!allowedChatIds.has(chatId)) {
            console.warn(`Сообщение из неразрешённого Telegram чата проигнорировано: ${chatId}`);
            return;
        }

        const messageText = message.text || message.caption || '';
        if (!messageText.trim() || messageText.startsWith('/')) return;
        if (isCancellation(messageText)) {
            await bot.sendMessage(chatId, 'ℹ️ Повідомлення про відбій пропущено; активні записи не змінювалися.');
            return;
        }

        const locations = await extractLocations(groq, messageText, allowedZones, locationSystemPrompt);
        if (locations === null) return;
        if (!locations.length) {
            console.warn('У повідомленні не знайдено дозволених зон.');
            return;
        }

        const expiresAt = new Date(Date.now() + threatLifetimeMinutes * 60_000).toISOString();
        const threatType = detectThreatType(messageText);
        const savedLocations = [];
        const failedLocations = [];
        for (const location of locations) {
            const { error } = await supabase.from('active_threats').insert({
                location,
                threat_type: threatType,
                status: 'active',
                expires_at: expiresAt
            });

            if (error) {
                const message = error.code === '42703' && /status/iu.test(error.message)
                    ? 'У таблиці active_threats немає стовпця status. Додайте його SQL-міграцією перед запуском бота.'
                    : error.message;
                failedLocations.push(location);
                console.error(`Не вдалося зберегти зону ${location}: ${message}`);
                continue;
            }

            savedLocations.push(location);
            console.log(`Загрозу збережено: ${location} (${threatType})`);
        }

        if (savedLocations.length) {
            await bot.sendMessage(chatId, `✅ Зафіксовано загрозу для зон: ${savedLocations.join(', ')}`);
        }
        if (failedLocations.length) {
            await bot.sendMessage(chatId, `❌ Не вдалося записати зони: ${failedLocations.join(', ')}`);
        }
    }

    bot.on('message', message => {
        handleMessage(message).catch(async error => {
            console.error('Не удалось обработать сообщение Telegram:', error.message);
            try {
                await bot.sendMessage(message.chat.id, `❌ Не вдалося обробити повідомлення: ${error.message}`);
            } catch (replyError) {
                console.error('Не удалось отправить сообщение об ошибке в Telegram:', replyError.message);
            }
        });
    });

    bot.on('polling_error', error => {
        console.error('Помилка Telegram polling:', error.message);
    });

    console.log('Telegram parser запущен; бот принимает сообщения только из разрешённых чатов.');
}

main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
});