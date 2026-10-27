const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const qrcode = require("qrcode-terminal");

const apiId = 38802615;
const apiHash = "037807108963ad8b486518a5282bd04c";
const stringSession = new StringSession("");

(async () => {
  const client = new TelegramClient(stringSession, apiId, apiHash, { connectionRetries: 5 });
  await client.connect();

  await client.signInUserWithQrCode(
    { apiId, apiHash },
    {
      onError: (err) => console.log("Ошибка:", err),
      qrCode: (code) => {
        // Формируем ссылку для сканирования
        const url = `tg://login?token=${code.token.toString("base64url")}`;
        console.log("\nОткрой Telegram на телефоне клиента: Настройки -> Устройства -> Подключить устройство\n");
        qrcode.generate(url, { small: true }); // Отрисовываем QR в консоли
      },
    }
  );

  console.log("\nГотово! Твоя строка сессии:");
  console.log(client.session.save());
  process.exit(0);
})();