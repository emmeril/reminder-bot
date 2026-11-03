const assert = require("node:assert/strict");
const test = require("node:test");

const { NotificationBot } = require("../src/app");

test("broadcast menghitung accepted, delivered, dan read sebagai sukses serta melaporkan progres", async () => {
  const logs = [];
  const progress = [];
  const contacts = [
    { name: "Ayu", phoneNumber: "628111111111" },
    { name: "Budi", phoneNumber: "628222222222" },
    { name: "Citra", phoneNumber: "628333333333" },
  ];
  const deliveries = ["accepted", "delivered", "read"];
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

  await bot.sendContactBroadcast("Info", "Pesan", {
    onProgress: (update) => progress.push(update),
  });

  assert.match(logs.at(-1).message, /3 contact\(s\), 0 gagal/);
  assert.deepEqual(progress, [
    { phase: "SENDING", completed: 1, total: 3 },
    { phase: "SENDING", completed: 2, total: 3 },
    { phase: "SENDING", completed: 3, total: 3 },
  ]);
});
