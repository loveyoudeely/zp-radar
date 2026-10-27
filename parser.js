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
const threatLifetimeMinutes = 30;
const cityDistrictNames = [
    'Дніпровський',
    'Хортицький',
    'Комунарський',
    'Шевченківський',
    'Олександрівський',
    'Вознесенівський',
    'Заводський'
];
const expectedZoneCount = 74;

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
    for (const feature of geojson.features) {
        const properties = feature.properties || {};
        const name = String(properties.name || '').trim();
        const isCityDistrict = properties.feature_type === 'city'
            && cityDistrictNames.some(cityName => normalizeZoneName(cityName) === normalizeZoneName(name));
        if (
            !name
            || (properties.feature_type !== 'district' && !isCityDistrict)
            || !['Polygon', 'MultiPolygon'].includes(feature.geometry?.type)
        ) continue;

        allowedZones.set(normalizeZoneName(name), name);
    }

    const zones = Array.from(allowedZones.values()).sort((left, right) => left.localeCompare(right, 'uk'));
    const missingCityDistricts = cityDistrictNames.filter(name => !allowedZones.has(normalizeZoneName(name)));
    if (zones.length !== expectedZoneCount || missingCityDistricts.length) {
        throw new Error(
            `Очікується ${expectedZoneCount} дозволені зони в districts.geojson, знайдено ${zones.length}.`
            + (missingCityDistricts.length ? ` Відсутні райони міста: ${missingCityDistricts.join(', ')}.` : '')
        );
    }

    return zones;
}

function createLocationSystemPrompt(allowedZones) {
    return `Твоя задача — найти ВСЕ упомянутые населенные пункты и сопоставить их с официальным списком зон (приводи названия городов и сел к названиям их громад). Возвращай результат в виде JSON-массива строк. Возвращай только точные названия зон из списка; если подходящих зон нет — верни []. Актуальный официальный список всех ${allowedZones.length} зон: ${JSON.stringify(allowedZones)}.`;
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
    } catch (error) {
        throw new Error(`Groq повернув некоректний JSON-масив локацій: ${error.message}`);
    }
    if (!Array.isArray(parsed) || !parsed.every(location => typeof location === 'string')) {
        throw new Error('Groq має повернути JSON-масив рядків локацій.');
    }

    const allowedByNormalizedName = new Map(
        allowedZones.map(location => [normalizeZoneName(location), location])
    );
    const locations = [];
    const seen = new Set();
    for (const candidate of parsed) {
        const canonicalName = allowedByNormalizedName.get(normalizeZoneName(candidate));
        if (!canonicalName) {
            console.warn('Відхилено зону, якої немає в дозволеному списку.');
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
    const response = await groq.chat.completions.create({
        model: 'qwen/qwen3.8-27b',
        temperature: 0,
        max_tokens: 1024,
        messages: [
            { role: 'system', content: locationSystemPrompt },
            { role: 'user', content: messageText }
        ]
    });

    const locations = parseLocationResponse(response.choices[0]?.message?.content, allowedZones);
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
        if (!locations.length) {
            console.warn('У повідомленні не знайдено дозволених зон.');
            await bot.sendMessage(chatId, '⚠️ Не вдалося визначити зону');
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
