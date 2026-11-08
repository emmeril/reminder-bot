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
    debtCount: 1,
    debtPeriods: [
      { key: "2026-06", label: "Juni 2026" },
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
  assert.match(sent[0].message, /Tunggakan 1 bulan: Rp 100\.000/);
  assert.match(sent[0].message, /Daftar Juni 2026/);
  assert.match(sent[0].message, /Total Rp 200\.000/);
  assert.match(sent[0].message, /\*Rincian tagihan\*/);
  assert.match(sent[0].message, /Juni 2026: Rp 100\.000/);
  assert.match(sent[0].message, /\*Total: Rp 200\.000\*/);
  assert.match(sent[0].message, /EMMERIL HOTSPOT - CS Emmeril/);
  assert.doesNotMatch(sent[0].message, /{{|}}/);
  assert.equal(result.totalAmount, 200000);
  assert.equal(result.provider, "baileys");
});

test("pengingat tagihan tidak dikirim ketika tunggakan sudah dua bulan", async () => {
  const { bot, sent } = createBot();

  await assert.rejects(
    () => bot.sendBillingDebtReminder(createContact({
      debtCount: 2,
      debtPeriods: [
        { key: "2026-06", label: "Juni 2026" },
        { key: "2026-07", label: "Juli 2026" },
      ],
    })),
    /2 tunggakan atau lebih/
  );
  assert.equal(sent.length, 0);
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

test("notifikasi pembayaran sebagian menyebut nominal dan sisa tunggakan", async () => {
  const { bot, sent } = createBot({
    paymentMessageTemplateArrearsOnly: "{{name}}\n{{paymentAmount}}\n{{remainingDebtAmount}}\n{{statusText}}\n{{noteText}}",
  });

  await bot.sendPaymentNotification(
    createContact({ billingCycle: "POSTPAID" }),
    "TRX-PARTIAL-1",
    "ARREARS-ONLY",
    { paymentAmount: 100_000, remainingDebtAmount: 100_000 }
  );

  assert.equal(sent.length, 1);
  assert.match(sent[0].message, /Rp 100\.000/);
  assert.match(sent[0].message, /Tunggakan dibayar sebagian/);
  assert.match(sent[0].message, /Sisa tunggakan: Rp 100\.000/);
  assert.doesNotMatch(sent[0].message, /{{|}}/);
});

test("notifikasi periode historis tidak menimpa teks khusus admin", async () => {
  const { bot, sent } = createBot({
    paymentMessageTemplateCurrentOnly: "Pembayaran tagihan {{billingPeriod}} diterima. Status: {{statusText}}.",
  });

  await bot.sendPaymentNotification(
    createContact({ billingCycle: "PREPAID", billingPeriodLabel: "Oktober 2026" }),
    "TRX-PREPAID-LEGACY-1",
    "CURRENT-ONLY",
    { paymentDate: "2026-11-06T09:41:00.000Z" }
  );

  assert.equal(sent.length, 1);
  assert.match(sent[0].message, /tagihan Oktober 2026 diterima/);
  assert.match(sent[0].message, /Status: Lunas Oktober 2026/);
  assert.doesNotMatch(sent[0].message, /{{|}}/);
});

test("notifikasi pembelian prabayar menyebut nominal dan masa aktif tanpa tunggakan", async () => {
  const { bot, sent } = createBot({
    prepaidPackagePaymentMessageTemplate: "{{name}}\n{{paymentAmount}}\n{{activeUntil}}\n{{statusText}}\n{{noteText}}",
  });

  await bot.sendPaymentNotification(
    createContact({ billingCycle: "PREPAID", subscriptionType: "RECURRING" }),
    "ACT-PREPAID-1",
    "ACTIVE-PERIOD",
    {
      paymentAmount: 100_000,
      paymentDate: "2026-10-28T03:00:00.000Z",
      activeUntil: "2026-11-28T03:00:00.000Z",
    }
  );

  assert.equal(sent.length, 1);
  assert.match(sent[0].message, /Rp 100\.000/);
  assert.match(sent[0].message, /28\/11\/2026/);
  assert.match(sent[0].message, /Paket aktif/);
  assert.doesNotMatch(sent[0].message, /Tunggakan tetap tercatat/);
  assert.doesNotMatch(sent[0].message, /{{|}}/);
});

test("notifikasi pembayaran menyertakan akun WiFi dari template pengaturan", async () => {
  const { bot, sent } = createBot({
    paymentMessageTemplateFullPaid: "Pembayaran {{transactionId}}",
    paymentHotspotAccountMessageTemplate: [
      "AKUN WIFI",
      "User: {{hotspotUsername}}",
      "Sandi: {{hotspotPassword}}",
      "Profil: {{hotspotProfile}}",
      "Status: {{hotspotStatus}}",
      "Aktif sampai: {{activeUntil}}",
    ].join("\n"),
  });

  await bot.sendPaymentNotification(
    createContact({
      mikrotikUsername: "wifi_pelanggan",
      mikrotikPassword: "sandi$wifi",
      mikrotikProfile: "50M",
      hotspotProvisioningStatus: "ACTIVE",
      hotspotReactivationAt: "2026-11-28T03:00:00.000Z",
    }),
    "TRX-WIFI-1",
    "FULL-PAID",
    { paymentDate: "2026-10-28T03:00:00.000Z" }
  );

  assert.equal(sent.length, 1);
  assert.match(sent[0].message, /Pembayaran TRX-WIFI-1/);
  assert.match(sent[0].message, /User: wifi_pelanggan/);
  assert.match(sent[0].message, /Sandi: sandi\$wifi/);
  assert.match(sent[0].message, /Profil: 50M/);
  assert.match(sent[0].message, /Status: Aktif/);
  assert.match(sent[0].message, /Aktif sampai: 28\/11\/2026/);
  assert.equal((sent[0].message.match(/AKUN WIFI/g) || []).length, 1);
  assert.doesNotMatch(sent[0].message, /{{|}}/);
});

test("pembelian paket IP Binding saja tidak mengirim kredensial hotspot", async () => {
  const { bot, sent } = createBot();
  await bot.sendPaymentNotification(
    createContact({
      billingCycle: "PREPAID",
      name: "Alea",
      hotspotAccessMode: "IP_BINDING_ONLY",
      mikrotikUsername: "alea",
      mikrotikPassword: "9036",
      mikrotikMacAddresses: ["AA:BB:CC:DD:EE:01"],
      hotspotProvisioningStatus: "ACTIVE",
    }),
    "ACT-IP-BINDING-1",
    "ACTIVE-PERIOD",
    { paymentAmount: 75000, paymentDate: "2026-11-08T02:30:00.000Z", activeUntil: "2026-12-08T02:30:00.000Z" }
  );

  assert.equal(sent.length, 1);
  const message = sent[0].message;
  assert.match(message, /\*Pembelian Paket WiFi\*/);
  assert.match(message, /ACT-IP-BINDING-1/);
  assert.match(message, /Rp 75\.000/);
  assert.match(message, /08\/12\/2026/);
  assert.match(message, /\*Akses WiFi\*/);
  assert.match(message, /Metode akses: IP Binding/);
  assert.match(message, /Perangkat yang terdaftar dapat terhubung/);
  assert.doesNotMatch(message, /\*Akun WiFi\*|Username:|Password:|9036|{{|}}/);
});

test("pembelian paket Hotspot saja tetap menggunakan template kredensial yang diatur", async () => {
  const { bot, sent } = createBot({
    paymentHotspotAccountMessageTemplate: "DATA HOTSPOT\nLogin: {{hotspotUsername}}\nSandi: {{hotspotPassword}}",
  });
  await bot.sendPaymentNotification(
    createContact({
      billingCycle: "PREPAID",
      hotspotAccessMode: "HOTSPOT_ONLY",
      mikrotikUsername: "wifi_al",
      mikrotikPassword: "sandinya",
      mikrotikMacAddresses: ["AA:BB:CC:DD:EE:02"],
    }),
    "ACT-HOTSPOT-ONLY",
    "ACTIVE-PERIOD",
    { activeUntil: "2026-12-08T02:30:00.000Z" }
  );

  assert.equal(sent.length, 1);
  assert.match(sent[0].message, /DATA HOTSPOT\nLogin: wifi_al\nSandi: sandinya/);
  assert.doesNotMatch(sent[0].message, /Metode akses: IP Binding|{{|}}/);
});

test("pembelian paket mode gabungan mengirim akun hotspot dan informasi IP Binding", async () => {
  const { bot, sent } = createBot();
  await bot.sendPaymentNotification(
    createContact({
      billingCycle: "PREPAID",
      hotspotAccessMode: "BOTH",
      mikrotikUsername: "wifi_both",
      mikrotikPassword: "both123",
      mikrotikMacAddresses: ["AA:BB:CC:DD:EE:03"],
    }),
    "ACT-BOTH",
    "ACTIVE-PERIOD",
    { activeUntil: "2026-12-08T02:30:00.000Z" }
  );

  assert.equal(sent.length, 1);
  assert.match(sent[0].message, /\*Akun WiFi\*[\s\S]*Username: wifi_both[\s\S]*Password: both123/);
  assert.match(sent[0].message, /\*Akses IP Binding\*[\s\S]*Metode akses: IP Binding/);
  assert.equal((sent[0].message.match(/\*Akun WiFi\*/g) || []).length, 1);
  assert.doesNotMatch(sent[0].message, /{{|}}/);
});

test("mode gabungan tanpa kredensial tetap menjelaskan IP Binding tanpa field kosong", async () => {
  const { bot, sent } = createBot();
  await bot.sendPaymentNotification(
    createContact({ billingCycle: "PREPAID", hotspotAccessMode: "BOTH", mikrotikMacAddresses: ["AA:BB:CC:DD:EE:04"] }),
    "ACT-BOTH-NO-CREDENTIALS",
    "ACTIVE-PERIOD",
    { activeUntil: "2026-12-08T02:30:00.000Z" }
  );
  assert.equal(sent.length, 1);
  assert.match(sent[0].message, /\*Akses IP Binding\*/);
  assert.doesNotMatch(sent[0].message, /\*Akun WiFi\*|Username:|Password:|{{|}}/);
});

test("template pembayaran bawaan menggunakan bahasa formal dan mudah dipahami", async () => {
  const { bot, sent } = createBot();

  await bot.sendPaymentNotification(
    createContact(),
    "TRX-FORMAL-1",
    "FULL-PAID",
    { paymentDate: "2026-10-28T03:00:00.000Z" }
  );

  assert.equal(sent.length, 1);
  assert.match(sent[0].message, /^\*Pembayaran Lunas\*/);
  assert.match(sent[0].message, /Yth\. Bapak\/Ibu Pelanggan Tunggakan/);
  assert.match(sent[0].message, /Semua tagihan Anda sudah lunas/);
  assert.match(sent[0].message, /ID transaksi: TRX-FORMAL-1/);
  assert.doesNotMatch(sent[0].message, /BUKTI|Rincian pembayaran|Hormat kami/);
  assert.doesNotMatch(sent[0].message, /{{|}}/);
});
