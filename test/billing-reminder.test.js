const assert = require("node:assert/strict");
const test = require("node:test");

const { NotificationBot } = require("../src/app");

function createBot(settings = {}) {
  const sent = [];
  const dataManager = {
    getSettings: () => ({
      companyName: "Emmeril Hotspot",
      supportSignature: "CS Emmeril",
      waRandomDelayMinSeconds: 0,
      waRandomDelayMaxSeconds: 0,
      billingReminderMessageTemplate: [
        "Halo {{name}} ({{phoneNumber}})",
        "Periode {{billingPeriod}}",
        "Bulanan {{monthlyAmount}}",
        "Berjalan {{currentAmount}}",
        "Tunggakan {{debtCount}} bulan: {{debtAmount}}",
        "Daftar {{debtPeriods}}",
        "Total {{totalAmount}}",
        "Jatuh tempo {{dueDate}}",
        "{{companyNameUpper}} - {{supportSignature}}",
      ].join("\n"),
      ...settings,
    }),
    getTimezone: () => "Asia/Jakarta",
    hydrateContact: (contact) => contact,
    formatPaymentAmount: (value) => `Rp ${Number(value).toLocaleString("id-ID")}`,
  };
  const bot = new NotificationBot(dataManager, { push() {} }, {
    async sendMessage(phoneNumber, message, options) {
      sent.push({ phoneNumber, message, options });
      return { provider: "baileys", messageId: "message-1" };
    },
  });
  return { bot, sent };
}

function createContact(overrides = {}) {
  return {
    id: "contact-billing-reminder",
    name: "Pelanggan Tunggakan",
    phoneNumber: "6281234567890",
    paymentStatus: "UNPAID",
    currentPaymentStatus: "UNPAID",
    monthlyPaymentAmount: 100000,
    hasDebt: true,
    debtCount: 2,
    debtPeriods: [
      { key: "2026-06", label: "Juni 2026" },
      { key: "2026-07", label: "Juli 2026" },
    ],
    dueDate: "2026-08-20T03:00:00.000Z",
    ...overrides,
  };
}

test("pengingat tagihan merender rincian tunggakan lalu langsung mengirim WhatsApp", async () => {
  const { bot, sent } = createBot();

  const result = await bot.sendBillingDebtReminder(createContact());

  assert.equal(sent.length, 1);
  assert.equal(sent[0].phoneNumber, "6281234567890");
  assert.match(sent[0].message, /Halo Pelanggan Tunggakan/);
  assert.match(sent[0].message, /Bulanan Rp 100\.000/);
  assert.match(sent[0].message, /Tunggakan 2 bulan: Rp 200\.000/);
  assert.match(sent[0].message, /Daftar Juni 2026, Juli 2026/);
  assert.match(sent[0].message, /Total Rp 300\.000/);
  assert.match(sent[0].message, /EMMERIL HOTSPOT - CS Emmeril/);
  assert.doesNotMatch(sent[0].message, /{{|}}/);
  assert.equal(result.totalAmount, 300000);
  assert.equal(result.provider, "baileys");
});

test("pengingat tagihan dapat dikirim untuk bulan berjalan yang sudah jatuh tempo", async () => {
  const { bot, sent } = createBot();

  const result = await bot.sendBillingDebtReminder(createContact({
    hasDebt: false,
    debtCount: 0,
    debtPeriods: [],
    dueStatus: "OVERDUE",
  }));

  assert.equal(sent.length, 1);
  assert.match(sent[0].message, /Berjalan Rp 100\.000/);
  assert.match(sent[0].message, /Tunggakan 0 bulan: Rp 0/);
  assert.match(sent[0].message, /Total Rp 100\.000/);
  assert.equal(result.totalAmount, 100000);
});

test("pengingat tunggakan sekali berlangganan tidak menambahkan tagihan bulan berjalan", async () => {
  const { bot, sent } = createBot();

  const result = await bot.sendBillingDebtReminder(createContact({
    subscriptionType: "ONE_TIME",
    subscriptionActive: false,
    paymentStatus: "PAID",
    currentPaymentStatus: "PAID",
    debtCount: 1,
    debtPeriods: [{ key: "2026-07", label: "Juli 2026" }],
  }));

  assert.equal(sent.length, 1);
  assert.match(sent[0].message, /Berjalan Rp 0/);
  assert.match(sent[0].message, /Total Rp 100\.000/);
  assert.equal(result.currentAmount, 0);
  assert.equal(result.totalAmount, 100000);
});

test("pengingat tagihan menolak pelanggan lunas atau tagihan yang belum jatuh tempo tanpa tunggakan", async () => {
  const { bot, sent } = createBot();

  await assert.rejects(
    () => bot.sendBillingDebtReminder(createContact({
      paymentStatus: "PAID",
      currentPaymentStatus: "PAID",
      hasDebt: false,
      debtCount: 0,
      debtPeriods: [],
    })),
    /jatuh tempo atau memiliki tunggakan/
  );
  await assert.rejects(
    () => bot.sendBillingDebtReminder(createContact({
      hasDebt: false,
      debtCount: 0,
      debtPeriods: [],
      dueStatus: "UPCOMING",
    })),
    /jatuh tempo atau memiliki tunggakan/
  );
  assert.equal(sent.length, 0);
});
