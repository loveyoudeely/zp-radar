require('dotenv').config();
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { NewMessage } = require("telegram/events");
const { createClient } = require("@supabase/supabase-js");
const Groq = require("groq-sdk");

// === ТЕЛЕГРАМ НАСТРОЙКИ ===
const apiId = Number(process.env.TELEGRAM_API_ID);
const apiHash = process.env.TELEGRAM_API_HASH;
// Завтра заменишь пустые кавычки на длинную строку от auth.js:
const stringSession = new StringSession(process.env.TELEGRAM_STRING_SESSION || '');
const TARGET_CHANNEL = process.env.TELEGRAM_TARGET_CHANNEL;

// === SUPABASE И GROQ ===
const missingConfiguration = [];
if (!Number.isInteger(apiId) || apiId <= 0) missingConfiguration.push('TELEGRAM_API_ID');
if (!apiHash) missingConfiguration.push('TELEGRAM_API_HASH');
if (!process.env.TELEGRAM_STRING_SESSION) missingConfiguration.push('TELEGRAM_STRING_SESSION');
if (!TARGET_CHANNEL) missingConfiguration.push('TELEGRAM_TARGET_CHANNEL');
if (!process.env.SUPABASE_URL) missingConfiguration.push('SUPABASE_URL');
if (!process.env.SUPABASE_SERVICE_ROLE_KEY) missingConfiguration.push('SUPABASE_SERVICE_ROLE_KEY');
if (!process.env.GROQ_API_KEY) missingConfiguration.push('GROQ_API_KEY');
if (missingConfiguration.length) {
  throw new Error(`Missing environment variables: ${missingConfiguration.join(', ')}`);
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

(async () => {
  console.log("Подключение к Telegram...");
  const client = new TelegramClient(stringSession, apiId, apiHash, { connectionRetries: 5 });
  await client.connect();
  console.log(`✅ Юзербот запущен! Слушаем канал: ${TARGET_CHANNEL}`);

  client.addEventHandler(async (event) => {
    const text = event.message.message;
    if (!text) return; // Игнорируем посты только с фото/видео без текста

    console.log("📩 Перехвачено сообщение:", text);

    try {
      // 1. Отправляем текст в Groq (настроен под твои 74 зоны)
      const completion = await groq.chat.completions.create({
        messages: [
          {
            role: "system",
            content: "Ты парсер. Извлеки названия районов и громад из текста. Верни ТОЛЬКО валидный JSON массив строк. Без дополнительных пояснений."
          },
          { role: "user", content: text }
        ],
        model: "llama3-8b-8192", // Используем быструю модель
      });

      const parsedZones = JSON.parse(completion.choices[0].message.content);
      
      // 2. Пишем в базу, если ИИ нашел зоны
      if (parsedZones.length > 0) {
        const { data, error } = await supabase
          .from('alerts') // Замени на актуальное название твоей таблицы в Supabase
          .insert([{ raw_text: text, zones: parsedZones }]);

        if (error) throw error;
        console.log("💾 Успешно записано в Supabase:", parsedZones);
      } else {
        console.log("⚠️ Громады/районы не найдены.");
      }

    } catch (error) {
      console.error("❌ Ошибка обработки:", error.message);
    }
  }, new NewMessage({ chats: [TARGET_CHANNEL] }));
})();