const assert = require("node:assert/strict");
const test = require("node:test");

const { NotificationBot } = require("../src/app");

test("log broadcast menghitung status delivered dan read sebagai sukses", async () => {
  const logs = [];
  const contacts = [
    { name: "Ayu", phoneNumber: "628111111111" },
    { name: "Budi", phoneNumber: "628222222222" },
  ];
  const deliveries = ["delivered", "read"];
  const bot = new NotificationBot({
    getContacts: () => contacts,
    getSettings: () => ({ waRandomDelayMinSeconds: 0, waRandomDelayMaxSeconds: 0 }),
  }, {
    push(level, source, message) {
      logs.push({ level, source, message });
    },
  }, {
    async sendMessage() {
      return { provider: "baileys", deliveryStatus: deliveries.shift() };
    },
  });

  await bot.sendContactBroadcast("Info", "Pesan");

  assert.match(logs.at(-1).message, /2 contact\(s\), 0 gagal/);
});
