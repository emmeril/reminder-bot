const assert = require("node:assert/strict");
const test = require("node:test");

const { DataManager } = require("../src/app");
const {
  CONFIG,
  DEFAULT_REMINDER_MESSAGE_TEMPLATE,
  PAYMENT_STATUS,
  PAYMENT_TYPES,
  SUBSCRIPTION_TYPES,
} = require("../src/config");
const {
  addMonthsSafely,
  getBillingPeriodParts,
  getPreviousBillingPeriod,
  makeBillingPeriodKey,
} = require("../src/utils");

function createManager(contact) {
  const manager = new DataManager({ push() {} });
  manager.contacts.set(String(contact.id), contact);
  manager.saveContacts = async () => {};
  manager.savePelanggan = async () => {};
  manager.saveCustomerAccounts = async () => {};
  manager.saveReminders = async () => {};
  manager.saveSettings = async () => {};
  manager.withDatabaseWrite = async (operation) => operation();
  manager.sequelize = {
    transaction: async (operation) => operation({}),
  };
  return manager;
}

test("transaksi Midtrans not_found yang masih baru tetap masuk antrean rekonsiliasi", () => {
  CONFIG.MIDTRANS_NOT_FOUND_RETRY_WINDOW = 30 * 60 * 1000;
  const manager = createManager({ id: "contact-midtrans-retry" });
  manager.paymentGatewayTransactions.set("RB-RETRY-NOT-FOUND", {
    orderId: "RB-RETRY-NOT-FOUND",
    contactId: "contact-midtrans-retry",
    provider: "midtrans",
    status: "FAILED",
    gatewayStatus: "not_found",
    createdAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
  });

  assert.deepEqual(
    manager.getPendingPaymentGatewayTransactions("contact-midtrans-retry").map(({ orderId }) => orderId),
    ["RB-RETRY-NOT-FOUND"]
  );
});

test("menggunakan ulang transaksi Midtrans pending untuk tagihan yang sama", () => {
  const manager = createManager({ id: "contact-midtrans-reuse" });
  manager.paymentGatewayTransactions.set("RB-REUSE", {
    orderId: "RB-REUSE",
    contactId: "contact-midtrans-reuse",
    provider: "midtrans",
    status: "PENDING",
    amount: 200000,
    periods: ["2026-08", "2026-09"],
    redirectUrl: "https://app.sandbox.midtrans.com/payment",
    createdAt: new Date().toISOString(),
  });

  const reusable = manager.findReusablePaymentGatewayTransaction({
    contactId: "contact-midtrans-reuse",
    amount: 200000,
    periods: ["2026-09", "2026-08"],
  });

  assert.equal(reusable.orderId, "RB-REUSE");
  assert.equal(manager.findReusablePaymentGatewayTransaction({
    contactId: "contact-midtrans-reuse",
    amount: 100000,
    periods: ["2026-09"],
  }), null);
});

test("pembayaran tunggakan saja tidak menandai bulan berjalan lunas", async () => {
  const { year, month } = getBillingPeriodParts();
  const currentKey = makeBillingPeriodKey(year, month);
  const contact = {
    id: "contact-1",
    name: "Pelanggan",
    phoneNumber: "6281234567890",
    createdAt: "2026-04-01T00:00:00.000Z",
    paymentStatus: PAYMENT_STATUS.UNPAID,
    paymentDate: null,
    paymentType: null,
    paymentMonths: {},
  };
  const manager = createManager(contact);

  const updated = await manager.updatePaymentStatus(
    contact.id,
    PAYMENT_STATUS.UNPAID,
    PAYMENT_TYPES.ARREARS_ONLY
  );

  assert.equal(updated.paymentStatus, PAYMENT_STATUS.UNPAID);
  assert.equal(updated.paymentMonths[currentKey].status, PAYMENT_STATUS.UNPAID);
  assert.equal(updated.paymentType, PAYMENT_TYPES.ARREARS_ONLY);
  assert.equal(updated.debtCount >= 0, true);
  assert.equal(
    Object.values(updated.paymentMonths).some((payment) => (
      payment.status === PAYMENT_STATUS.PAID
      && payment.paymentType === PAYMENT_TYPES.ARREARS_ONLY
    )),
    true
  );
});

test("pelanggan hasil konversi lama dipulihkan saat pembayaran tunggakan dicatat", async () => {
  const current = getBillingPeriodParts();
  const previous = getPreviousBillingPeriod(current.year, current.month);
  const previousKey = makeBillingPeriodKey(previous.year, previous.month);
  const currentKey = makeBillingPeriodKey(current.year, current.month);
  const schedule = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const contact = {
    id: "contact-partial-arrears",
    name: "Pelanggan Cicilan",
    phoneNumber: "6281234567801",
    createdAt: `${previousKey}-01T00:00:00.000Z`,
    subscriptionType: SUBSCRIPTION_TYPES.ONE_TIME,
    subscriptionChangedByArrears: true,
    arrearsSubscriptionDebtPeriods: [previousKey],
    monthlyPaymentAmount: 200_000,
    paymentStatus: PAYMENT_STATUS.UNPAID,
    paymentDate: null,
    paymentType: null,
    paymentMonths: {
      [previousKey]: { status: PAYMENT_STATUS.UNPAID, paidDate: null, paymentType: null },
      [currentKey]: { status: PAYMENT_STATUS.UNPAID, paidDate: null, paymentType: null },
    },
    hotspotReactivationEnabled: false,
    hotspotReactivationAt: schedule,
  };
  const manager = createManager(contact);

  await assert.rejects(
    () => manager.updatePaymentStatus(
      contact.id,
      PAYMENT_STATUS.UNPAID,
      PAYMENT_TYPES.ARREARS_ONLY,
      200_001
    ),
    /melebihi sisa tunggakan/
  );

  const partial = await manager.updatePaymentStatus(
    contact.id,
    PAYMENT_STATUS.UNPAID,
    PAYMENT_TYPES.ARREARS_ONLY,
    100_000
  );

  let storedContact = manager.getContact(contact.id);
  assert.equal(partial.paymentAppliedAmount, 100_000);
  assert.equal(partial.debtAmount, 100_000);
  assert.equal(storedContact.paymentMonths[previousKey].status, PAYMENT_STATUS.UNPAID);
  assert.equal(storedContact.paymentMonths[previousKey].paidAmount, 100_000);
  assert.equal(storedContact.subscriptionType, SUBSCRIPTION_TYPES.RECURRING);
  assert.equal(storedContact.subscriptionChangedByArrears, false);
  assert.equal(manager.reminders.size, 1);

  const paid = await manager.updatePaymentStatus(
    contact.id,
    PAYMENT_STATUS.UNPAID,
    PAYMENT_TYPES.ARREARS_ONLY,
    100_000
  );

  storedContact = manager.getContact(contact.id);
  assert.equal(paid.paymentAppliedAmount, 100_000);
  assert.equal(paid.debtAmount, 0);
  assert.equal(storedContact.paymentMonths[previousKey].status, PAYMENT_STATUS.PAID);
  assert.equal(storedContact.paymentMonths[previousKey].paidAmount, 200_000);
  assert.equal(storedContact.subscriptionType, SUBSCRIPTION_TYPES.RECURRING);
  assert.equal(manager.reminders.size, 1);
});

test("pembayaran tunggakan mempertahankan bulan berjalan yang sudah lunas", async () => {
  const current = getBillingPeriodParts();
  const previous = getPreviousBillingPeriod(current.year, current.month);
  const previousKey = makeBillingPeriodKey(previous.year, previous.month);
  const currentKey = makeBillingPeriodKey(current.year, current.month);
  const paidDate = new Date().toISOString();
  const contact = {
    id: "contact-current-paid-partial-arrears",
    name: "Pelanggan Bulan Berjalan Lunas",
    phoneNumber: "6281234567803",
    createdAt: `${previousKey}-01T00:00:00.000Z`,
    subscriptionType: SUBSCRIPTION_TYPES.RECURRING,
    monthlyPaymentAmount: 200_000,
    paymentStatus: PAYMENT_STATUS.PAID,
    paymentDate: paidDate,
    paymentType: PAYMENT_TYPES.CURRENT_ONLY,
    paymentMonths: {
      [previousKey]: { status: PAYMENT_STATUS.UNPAID, paidDate: null, paymentType: null },
      [currentKey]: {
        status: PAYMENT_STATUS.PAID,
        paidDate,
        paymentType: PAYMENT_TYPES.CURRENT_ONLY,
        paidAmount: 200_000,
      },
    },
  };
  const manager = createManager(contact);

  const updated = await manager.updatePaymentStatus(
    contact.id,
    PAYMENT_STATUS.UNPAID,
    PAYMENT_TYPES.ARREARS_ONLY,
    100_000
  );

  assert.equal(updated.currentPaymentStatus, PAYMENT_STATUS.PAID);
  assert.equal(contact.paymentMonths[currentKey].status, PAYMENT_STATUS.PAID);
  assert.equal(contact.paymentMonths[currentKey].paymentType, PAYMENT_TYPES.CURRENT_ONLY);
  assert.equal(contact.paymentMonths[previousKey].paidAmount, 100_000);
  assert.equal(updated.debtAmount, 100_000);
});

test("pembayaran tunggakan dialokasikan dari periode paling lama", async () => {
  const current = getBillingPeriodParts();
  const previous = getPreviousBillingPeriod(current.year, current.month);
  const oldest = getPreviousBillingPeriod(previous.year, previous.month);
  const oldestKey = makeBillingPeriodKey(oldest.year, oldest.month);
  const previousKey = makeBillingPeriodKey(previous.year, previous.month);
  const contact = {
    id: "contact-multiple-partial-arrears",
    name: "Pelanggan Dua Bulan",
    phoneNumber: "6281234567802",
    createdAt: `${oldestKey}-01T00:00:00.000Z`,
    subscriptionType: SUBSCRIPTION_TYPES.RECURRING,
    monthlyPaymentAmount: 100_000,
    paymentStatus: PAYMENT_STATUS.UNPAID,
    paymentMonths: {
      [oldestKey]: { status: PAYMENT_STATUS.UNPAID },
      [previousKey]: { status: PAYMENT_STATUS.UNPAID },
    },
  };
  const manager = createManager(contact);

  const updated = await manager.updatePaymentStatus(
    contact.id,
    PAYMENT_STATUS.UNPAID,
    PAYMENT_TYPES.ARREARS_ONLY,
    150_000
  );

  assert.equal(contact.paymentMonths[oldestKey].status, PAYMENT_STATUS.PAID);
  assert.equal(contact.paymentMonths[oldestKey].paidAmount, 100_000);
  assert.equal(contact.paymentMonths[previousKey].status, PAYMENT_STATUS.UNPAID);
  assert.equal(contact.paymentMonths[previousKey].paidAmount, 50_000);
  assert.equal(updated.debtAmount, 50_000);
  assert.equal(updated.debtPeriods[0].key, previousKey);
  assert.equal(updated.debtPeriods[0].remainingAmount, 50_000);
});

test("pembayaran lunas tanpa jenis eksplisit default ke bulan berjalan", async () => {
  const contact = {
    id: "contact-2",
    name: "Pelanggan",
    phoneNumber: "6281234567891",
    createdAt: new Date().toISOString(),
    paymentStatus: PAYMENT_STATUS.UNPAID,
    paymentDate: null,
    paymentType: null,
    paymentMonths: {},
  };
  const manager = createManager(contact);

  const updated = await manager.updatePaymentStatus(contact.id, PAYMENT_STATUS.PAID);

  assert.equal(updated.paymentStatus, PAYMENT_STATUS.PAID);
  assert.equal(updated.paymentType, PAYMENT_TYPES.CURRENT_ONLY);
});

test("sekali berlangganan hanya menghitung periode mulai dan tidak membuat hutang bulanan baru", () => {
  const contact = {
    id: "contact-one-time",
    name: "Pelanggan Sekali",
    phoneNumber: "6281234567896",
    createdAt: "2026-07-10T00:00:00.000Z",
    subscriptionType: SUBSCRIPTION_TYPES.ONE_TIME,
    paymentStatus: PAYMENT_STATUS.UNPAID,
    paymentMonths: {},
  };
  const manager = createManager(contact);

  const debtInfo = manager.buildDebtInfo(contact, { year: 2026, month: 8 });

  assert.equal(debtInfo.subscriptionType, SUBSCRIPTION_TYPES.ONE_TIME);
  assert.equal(debtInfo.currentPaymentStatus, PAYMENT_STATUS.PAID);
  assert.equal(debtInfo.debtCount, 1);
  assert.equal(debtInfo.debtPeriods[0].key, "2026-07");
});

test("pelanggan berlangganan tetap menghitung periode berjalan dan tunggakan bulanan", () => {
  const contact = {
    id: "contact-recurring",
    name: "Pelanggan Bulanan",
    phoneNumber: "6281234567897",
    createdAt: "2026-07-10T00:00:00.000Z",
    subscriptionType: SUBSCRIPTION_TYPES.RECURRING,
    paymentStatus: PAYMENT_STATUS.UNPAID,
    paymentMonths: {},
  };
  const manager = createManager(contact);

  const debtInfo = manager.buildDebtInfo(contact, { year: 2026, month: 8 });

  assert.equal(debtInfo.currentPaymentStatus, PAYMENT_STATUS.UNPAID);
  assert.equal(debtInfo.debtCount, 1);
  assert.equal(debtInfo.debtPeriods[0].key, "2026-07");
});

test("pelanggan bulanan yang menunggak tetap bulanan dan reminder tetap aktif", async () => {
  const manager = new DataManager({ push() {} });
  manager.sequelize = { transaction: async (operation) => operation({}) };
  manager.withDatabaseWrite = async (operation) => operation();
  manager.saveContacts = async () => {};
  manager.saveReminders = async () => {};
  manager.saveSettings = async () => {};

  const current = getBillingPeriodParts(new Date(), manager.getTimezone());
  const previous = getPreviousBillingPeriod(current.year, current.month);
  const previousKey = makeBillingPeriodKey(previous.year, previous.month);
  const currentKey = makeBillingPeriodKey(current.year, current.month);
  const schedule = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const contact = {
    id: "contact-recurring-arrears",
    name: "Pelanggan Menunggak",
    phoneNumber: "6281234567810",
    createdAt: `${previousKey}-01T00:00:00.000Z`,
    subscriptionType: SUBSCRIPTION_TYPES.RECURRING,
    paymentStatus: PAYMENT_STATUS.UNPAID,
    paymentDate: null,
    paymentType: null,
    paymentMonths: {
      [previousKey]: {
        status: PAYMENT_STATUS.UNPAID,
        paidDate: null,
        paymentType: null,
      },
    },
    mikrotikUsername: "pelanggan-menunggak",
    mikrotikProfile: "default",
    hotspotReactivationEnabled: true,
    hotspotReactivationAt: schedule,
  };
  manager.contacts.set(contact.id, contact);
  manager.reminders.set("reminder-arrears", {
    id: "reminder-arrears",
    contactId: contact.id,
    phoneNumber: contact.phoneNumber,
    reminderDateTime: schedule,
    message: "Pengingat tagihan",
  });
  manager.settings.lastPaymentResetPeriod = currentKey;

  const result = await manager.ensureMonthlyPaymentReset();

  assert.equal(result.converted, 0);
  assert.equal(result.restored, 0);
  assert.equal(contact.subscriptionType, SUBSCRIPTION_TYPES.RECURRING);
  assert.equal(Boolean(contact.subscriptionChangedByArrears), false);
  assert.deepEqual(contact.arrearsSubscriptionDebtPeriods || [], []);
  assert.equal(contact.hotspotReactivationEnabled, true);
  assert.equal(contact.hotspotReactivationAt, schedule);
  assert.equal(manager.reminders.has("reminder-arrears"), true);
});

test("pelanggan bulanan tanpa tunggakan tetap berlangganan dan tetap dijadwalkan reaktivasi", async () => {
  const current = getBillingPeriodParts();
  const currentKey = makeBillingPeriodKey(current.year, current.month);
  const schedule = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const contact = {
    id: "contact-recurring-current",
    name: "Pelanggan Lancar",
    phoneNumber: "6281234567811",
    createdAt: new Date().toISOString(),
    subscriptionType: SUBSCRIPTION_TYPES.RECURRING,
    paymentStatus: PAYMENT_STATUS.UNPAID,
    paymentDate: null,
    paymentType: null,
    paymentMonths: {
      [currentKey]: {
        status: PAYMENT_STATUS.UNPAID,
        paidDate: null,
        paymentType: null,
      },
    },
    hotspotReactivationEnabled: true,
    hotspotReactivationAt: schedule,
  };
  const manager = createManager(contact);
  manager.settings.lastPaymentResetPeriod = currentKey;

  const result = await manager.ensureMonthlyPaymentReset();

  assert.equal(result.converted, 0);
  assert.equal(contact.subscriptionType, SUBSCRIPTION_TYPES.RECURRING);
  assert.equal(contact.hotspotReactivationEnabled, true);
  assert.equal(contact.hotspotReactivationAt, schedule);
});

test("konversi otomatis lama dipulihkan walaupun tunggakan belum lunas", () => {
  const current = getBillingPeriodParts();
  const previous = getPreviousBillingPeriod(current.year, current.month);
  const firstDebt = getPreviousBillingPeriod(previous.year, previous.month);
  const firstDebtKey = makeBillingPeriodKey(firstDebt.year, firstDebt.month);
  const previousKey = makeBillingPeriodKey(previous.year, previous.month);
  const contact = {
    id: "contact-multiple-arrears",
    name: "Pelanggan Dua Tunggakan",
    phoneNumber: "6281234567812",
    createdAt: `${firstDebtKey}-01T00:00:00.000Z`,
    subscriptionType: SUBSCRIPTION_TYPES.ONE_TIME,
    subscriptionChangedByArrears: true,
    arrearsSubscriptionDebtPeriods: [firstDebtKey, previousKey],
    paymentStatus: PAYMENT_STATUS.UNPAID,
    paymentMonths: {},
    hotspotReactivationEnabled: true,
    hotspotReactivationAt: new Date(Date.now() + 86_400_000).toISOString(),
  };
  const manager = createManager(contact);

  contact.paymentMonths[firstDebtKey] = { status: PAYMENT_STATUS.UNPAID };
  contact.paymentMonths[previousKey] = { status: PAYMENT_STATUS.UNPAID };

  const restored = manager.applyArrearsSubscriptionPolicy(contact);
  const unchanged = manager.applyArrearsSubscriptionPolicy(contact);

  assert.equal(restored.restored, true);
  assert.equal(restored.converted, false);
  assert.equal(unchanged.changed, false);
  assert.deepEqual(contact.arrearsSubscriptionDebtPeriods, []);
  assert.equal(contact.subscriptionType, SUBSCRIPTION_TYPES.RECURRING);
  assert.equal(contact.hotspotReactivationEnabled, true);
  assert.equal(manager.buildDebtInfo(contact).debtCount >= 2, true);
  assert.equal(manager.reminders.size, 1);
});

test("portal sekali berlangganan hanya menampilkan tunggakan periode awal", () => {
  const contact = {
    id: "contact-one-time-portal",
    name: "Pelanggan Sekali Portal",
    phoneNumber: "6281234567899",
    createdAt: "2026-07-10T00:00:00.000Z",
    subscriptionType: SUBSCRIPTION_TYPES.ONE_TIME,
    monthlyPaymentAmount: 125_000,
    paymentStatus: PAYMENT_STATUS.UNPAID,
    paymentMonths: {},
  };
  const manager = createManager(contact);
  manager.customerAccounts.set(contact.id, { username: "sekali", password: "portal-pass" });

  const portal = manager.getCustomerPortalData(contact.id);

  assert.equal(portal.billing.subscriptionActive, false);
  assert.equal(portal.billing.currentAmount, 0);
  assert.equal(portal.billing.debtAmount, 125_000);
  assert.equal(portal.billing.totalAmount, 125_000);
  assert.deepEqual(portal.billing.history.map((payment) => payment.period), ["2026-07"]);
});

test("pembayaran pelanggan sekali berlangganan tidak membuat record periode baru", async () => {
  const contact = {
    id: "contact-one-time-payment",
    name: "Pelanggan Sekali Bayar",
    phoneNumber: "6281234567898",
    createdAt: "2026-05-10T00:00:00.000Z",
    subscriptionType: SUBSCRIPTION_TYPES.ONE_TIME,
    paymentStatus: PAYMENT_STATUS.UNPAID,
    paymentMonths: {},
  };
  const manager = createManager(contact);
  manager.savePaymentAndReminderChanges = async () => {};

  const updated = await manager.updatePaymentStatus(contact.id, PAYMENT_STATUS.PAID, PAYMENT_TYPES.FULL_PAID);
  const currentKey = getBillingPeriodParts(new Date(), manager.getTimezone());
  const currentPeriodKey = `${currentKey.year}-${String(currentKey.month).padStart(2, "0")}`;

  assert.equal(updated.paymentStatus, PAYMENT_STATUS.PAID);
  assert.equal(updated.currentPaymentStatus, PAYMENT_STATUS.PAID);
  assert.equal(updated.subscriptionType, SUBSCRIPTION_TYPES.ONE_TIME);
  assert.equal(Boolean(updated.subscriptionChangedByArrears), false);
  assert.equal(Object.hasOwn(contact.paymentMonths, currentPeriodKey), false);
  assert.equal(contact.paymentMonths["2026-05"].status, PAYMENT_STATUS.PAID);
  assert.equal(Object.hasOwn(contact.paymentMonths, "2026-06"), false);
  assert.equal(Object.hasOwn(contact.paymentMonths, "2026-07"), false);
});

test("perubahan status pembayaran langsung memperbarui pesan reminder aktif", async () => {
  const { year, month } = getBillingPeriodParts();
  const createdAt = new Date(Date.UTC(year, month - 2, 2)).toISOString();
  const contact = {
    id: "contact-reminder",
    name: "Pelanggan Reminder",
    phoneNumber: "6281234567895",
    createdAt,
    monthlyPaymentAmount: 100_000,
    paymentStatus: PAYMENT_STATUS.UNPAID,
    paymentDate: null,
    paymentType: null,
    paymentMonths: {},
  };
  const manager = createManager(contact);
  const reminder = {
    id: "reminder-payment",
    contactId: contact.id,
    phoneNumber: contact.phoneNumber,
    paymentAmount: 100_000,
    message: "Tagihan Anda sebesar Rp 200.000 belum kami terima.",
    reminderDateTime: new Date(Date.now() + 86_400_000).toISOString(),
  };
  manager.reminders.set(reminder.id, reminder);

  await manager.updatePaymentStatus(contact.id, PAYMENT_STATUS.PAID, PAYMENT_TYPES.CURRENT_ONLY);

  assert.match(reminder.message, /Rp\s?100\.000/);
  assert.equal(reminder.messageSource, "Tagihan Anda sebesar Rp 200.000 belum kami terima.");
});

test("pesan reminder lunas kembali menjadi tagihan ketika status di-reset", async () => {
  const contact = {
    id: "contact-reminder-reset",
    name: "Pelanggan Reset",
    phoneNumber: "6281234567896",
    createdAt: new Date().toISOString(),
    monthlyPaymentAmount: 100_000,
    paymentStatus: PAYMENT_STATUS.UNPAID,
    paymentDate: null,
    paymentType: null,
    paymentMonths: {},
  };
  const manager = createManager(contact);
  const reminder = {
    id: "reminder-payment-reset",
    contactId: contact.id,
    phoneNumber: contact.phoneNumber,
    paymentAmount: 100_000,
    message: "Tagihan Anda sebesar Rp 100.000 belum kami terima.",
    reminderDateTime: new Date(Date.now() + 86_400_000).toISOString(),
  };
  manager.reminders.set(reminder.id, reminder);

  await manager.updatePaymentStatus(contact.id, PAYMENT_STATUS.PAID, PAYMENT_TYPES.FULL_PAID);
  assert.match(reminder.message, /Status pembayaran: LUNAS/);
  assert.doesNotMatch(reminder.message, /belum kami terima/);

  await manager.updatePaymentStatus(contact.id, PAYMENT_STATUS.UNPAID);
  assert.match(reminder.message, /Rp\s?100\.000/);
  assert.match(reminder.message, /belum kami terima/);
});

test("reminder baru menyimpan template variabel tanpa mengganti data pelanggan", async () => {
  const contact = {
    id: "contact-variable-reminder",
    name: "Nouval",
    phoneNumber: "6287728972090",
    createdAt: new Date().toISOString(),
    monthlyPaymentAmount: 100_000,
    paymentStatus: PAYMENT_STATUS.UNPAID,
    paymentMonths: {},
  };
  const manager = createManager(contact);

  const reminder = await manager.addReminder({
    contactId: contact.id,
    reminderDateTime: new Date(Date.now() + 86_400_000),
    message: DEFAULT_REMINDER_MESSAGE_TEMPLATE,
    templateName: "Penagihan.txt",
  });

  assert.equal(reminder.message, DEFAULT_REMINDER_MESSAGE_TEMPLATE);
  assert.equal(reminder.messageSource, DEFAULT_REMINDER_MESSAGE_TEMPLATE);
  assert.match(reminder.message, /{{name}}/);
  assert.match(reminder.message, /{{totalAmount}}/);
});

test("reminder tidak dapat dibuat untuk pelanggan sekali berlangganan", async () => {
  const contact = {
    id: "contact-one-time-reminder",
    name: "Pelanggan Sekali Reminder",
    phoneNumber: "6281234567894",
    createdAt: new Date().toISOString(),
    subscriptionType: SUBSCRIPTION_TYPES.ONE_TIME,
    monthlyPaymentAmount: 100_000,
    paymentStatus: PAYMENT_STATUS.UNPAID,
    paymentMonths: {},
  };
  const manager = createManager(contact);

  await assert.rejects(
    () => manager.addReminder({
      contactId: contact.id,
      reminderDateTime: new Date(Date.now() + 86_400_000),
      message: "Tagihan",
    }),
    /tidak diperlukan untuk pelanggan sekali berlangganan/
  );
});

test("perubahan pelanggan menjadi sekali berlangganan menghapus reminder aktif", async () => {
  const contact = {
    id: "contact-change-one-time",
    name: "Pelanggan Bulanan",
    phoneNumber: "6281234567893",
    createdAt: new Date().toISOString(),
    subscriptionType: SUBSCRIPTION_TYPES.RECURRING,
    paymentStatus: PAYMENT_STATUS.UNPAID,
    paymentMonths: {},
  };
  const manager = createManager(contact);
  manager.reminders.set("reminder-change-one-time", {
    id: "reminder-change-one-time",
    contactId: contact.id,
    phoneNumber: contact.phoneNumber,
    reminderDateTime: new Date(Date.now() + 86_400_000).toISOString(),
    message: "Tagihan bulanan",
  });
  let reminderSaves = 0;
  manager.saveReminders = async () => { reminderSaves += 1; };

  const updated = await manager.updateContact(contact.id, {
    subscriptionType: SUBSCRIPTION_TYPES.ONE_TIME,
  });

  assert.equal(updated.subscriptionType, SUBSCRIPTION_TYPES.ONE_TIME);
  assert.equal(manager.reminders.size, 0);
  assert.equal(reminderSaves, 1);
});

test("reset pembayaran bulanan juga menyegarkan pesan reminder aktif", async () => {
  const contact = {
    id: "contact-monthly-reset",
    name: "Pelanggan Bulanan",
    phoneNumber: "6281234567897",
    createdAt: new Date().toISOString(),
    monthlyPaymentAmount: 75_000,
    paymentStatus: PAYMENT_STATUS.PAID,
    paymentDate: new Date().toISOString(),
    paymentType: PAYMENT_TYPES.FULL_PAID,
    paymentMonths: {},
  };
  const manager = createManager(contact);
  const reminder = {
    id: "reminder-monthly-reset",
    contactId: contact.id,
    phoneNumber: contact.phoneNumber,
    paymentAmount: 75_000,
    message: "*Status pembayaran: LUNAS*",
    messageSource: "Tagihan Anda sebesar Rp 75.000 belum kami terima.",
    reminderDateTime: new Date(Date.now() + 86_400_000).toISOString(),
  };
  manager.reminders.set(reminder.id, reminder);

  await manager.resetAllPaymentStatus();

  assert.equal(contact.paymentStatus, PAYMENT_STATUS.UNPAID);
  assert.match(reminder.message, /Rp\s?75\.000/);
  assert.match(reminder.message, /belum kami terima/);
});

test("reminder periode berikutnya tidak mewarisi status lunas bulan berjalan", () => {
  const now = new Date();
  const timeZone = "Asia/Jakarta";
  const current = getBillingPeriodParts(now, timeZone);
  const currentKey = makeBillingPeriodKey(current.year, current.month);
  const nextDate = addMonthsSafely(now, 1, timeZone);
  const next = getBillingPeriodParts(nextDate, timeZone);
  const contact = {
    id: "contact-future-reminder",
    name: "Dinal",
    phoneNumber: "6281234567897",
    createdAt: now.toISOString(),
    subscriptionType: SUBSCRIPTION_TYPES.RECURRING,
    monthlyPaymentAmount: 100_000,
    paymentStatus: PAYMENT_STATUS.PAID,
    paymentDate: now.toISOString(),
    paymentType: PAYMENT_TYPES.CURRENT_ONLY,
    paymentMonths: {
      [currentKey]: {
        status: PAYMENT_STATUS.PAID,
        paidDate: now.toISOString(),
        paymentType: PAYMENT_TYPES.CURRENT_ONLY,
        paidAmount: 100_000,
      },
    },
  };
  const manager = createManager(contact);
  const reminder = {
    id: "future-reminder",
    contactId: contact.id,
    reminderDateTime: nextDate.toISOString(),
    message: DEFAULT_REMINDER_MESSAGE_TEMPLATE,
    messageSource: DEFAULT_REMINDER_MESSAGE_TEMPLATE,
  };

  const futureBilling = manager.buildDebtInfo(contact, next);
  manager.rewriteReminderPaymentMessage(reminder, contact);

  assert.equal(futureBilling.currentPaymentStatus, PAYMENT_STATUS.UNPAID);
  assert.equal(futureBilling.debtCount, 0);
  assert.doesNotMatch(reminder.message, /Status pembayaran: LUNAS/);
  assert.match(reminder.message, /tagihan Wifi/);
});

test("status lunas tetap mengubah pesan reminder tanpa nominal pembayaran", async () => {
  const contact = {
    id: "contact-no-amount",
    name: "Pelanggan Tanpa Nominal",
    phoneNumber: "6281234567898",
    createdAt: new Date().toISOString(),
    monthlyPaymentAmount: 0,
    paymentStatus: PAYMENT_STATUS.UNPAID,
    paymentDate: null,
    paymentType: null,
    paymentMonths: {},
  };
  const manager = createManager(contact);
  const reminder = {
    id: "reminder-no-amount",
    contactId: contact.id,
    phoneNumber: contact.phoneNumber,
    message: "Tagihan internet Anda belum kami terima.",
    reminderDateTime: new Date(Date.now() + 86_400_000).toISOString(),
  };
  manager.reminders.set(reminder.id, reminder);

  await manager.updatePaymentStatus(contact.id, PAYMENT_STATUS.PAID, PAYMENT_TYPES.FULL_PAID);

  assert.match(reminder.message, /Status pembayaran: LUNAS/);
});

test("menolak kombinasi status dan jenis pembayaran yang kontradiktif", async () => {
  const contact = {
    id: "contact-3",
    name: "Pelanggan",
    phoneNumber: "6281234567892",
    createdAt: new Date().toISOString(),
    paymentStatus: PAYMENT_STATUS.UNPAID,
    paymentDate: null,
    paymentType: null,
    paymentMonths: {},
  };
  const manager = createManager(contact);

  await assert.rejects(
    () => manager.updatePaymentStatus(contact.id, PAYMENT_STATUS.PAID, PAYMENT_TYPES.ARREARS_ONLY),
    /harus membiarkan bulan berjalan/
  );
  assert.equal(contact.paymentStatus, PAYMENT_STATUS.UNPAID);
});

test("jadwal reaktivasi yang tertinggal dimajukan langsung ke masa depan", async () => {
  const now = new Date();
  const oldSchedule = new Date(now);
  oldSchedule.setMonth(oldSchedule.getMonth() - 4);
  const contact = {
    id: "contact-4",
    name: "Pelanggan",
    phoneNumber: "6281234567893",
    hotspotReactivationAt: oldSchedule.toISOString(),
    mikrotikPassword: "secret",
    mikrotikProfile: "default",
  };
  const manager = createManager(contact);

  const updated = await manager.markHotspotReactivated(contact.id, {});

  assert.equal(new Date(updated.hotspotReactivationAt).getTime() > Date.now(), true);
});

test("aktivasi manual saat masih menunggak memberi masa aktif satu bulan tanpa menghapus tunggakan", async () => {
  const activatedAt = new Date("2026-10-16T08:00:00.000Z");
  const contact = {
    id: "contact-manual-arrears",
    name: "Pelanggan Menunggak",
    phoneNumber: "6281234567810",
    subscriptionType: SUBSCRIPTION_TYPES.RECURRING,
    createdAt: "2026-09-01T00:00:00.000Z",
    monthlyPaymentAmount: 100000,
    paymentStatus: PAYMENT_STATUS.PAID,
    paymentMonths: {
      "2026-09": { status: PAYMENT_STATUS.UNPAID, paidAmount: 0 },
    },
    billingPausedForArrears: true,
    billingPausedAfterPeriod: "2026-09",
    hotspotSuspendedForArrears: true,
    hotspotReactivationEnabled: false,
    hotspotReactivationAt: null,
    mikrotikUsername: "manual_arrears",
    mikrotikProfile: "default",
  };
  const manager = createManager(contact);

  const updated = await manager.markHotspotEnabled(contact.id, {}, { at: activatedAt });

  assert.equal(updated.hotspotProvisioningStatus, "ACTIVE");
  assert.equal(updated.hotspotManualActivationWithArrears, true);
  assert.equal(updated.hotspotSuspendedForArrears, false);
  assert.equal(updated.hotspotReactivationEnabled, false);
  assert.equal(updated.hotspotReactivationAt, "2026-11-16T08:00:00.000Z");
  assert.equal(updated.billingPausedForArrears, true);
  assert.deepEqual(updated.debtPeriods.map(({ key }) => key), ["2026-09"]);
});

test("reset bulanan tidak membuat tagihan baru saat billing dijeda karena tunggakan", async () => {
  const { year, month } = getBillingPeriodParts();
  const currentKey = makeBillingPeriodKey(year, month);
  const previous = getPreviousBillingPeriod(year, month);
  const frozenKey = makeBillingPeriodKey(previous.year, previous.month);
  const contact = {
    id: "contact-paused-billing",
    name: "Pelanggan Dijeda",
    phoneNumber: "6281234567811",
    subscriptionType: SUBSCRIPTION_TYPES.RECURRING,
    createdAt: `${frozenKey}-01T00:00:00.000Z`,
    monthlyPaymentAmount: 100000,
    paymentStatus: PAYMENT_STATUS.PAID,
    paymentMonths: {
      [frozenKey]: { status: PAYMENT_STATUS.UNPAID, paidAmount: 0 },
    },
    billingPausedForArrears: true,
    billingPausedAfterPeriod: frozenKey,
  };
  const manager = createManager(contact);

  await manager.resetAllPaymentStatusUnlocked();

  assert.equal(contact.paymentMonths[currentKey], undefined);
  assert.equal(contact.paymentStatus, PAYMENT_STATUS.PAID);
  assert.equal(manager.buildDebtInfo(contact).debtCount, 1);
  assert.equal(manager.buildDebtInfo(contact).subscriptionActive, false);
});

test("perpanjangan otomatis pulih hanya setelah seluruh tunggakan lunas", async () => {
  const { year, month } = getBillingPeriodParts();
  const previous = getPreviousBillingPeriod(year, month);
  const frozenKey = makeBillingPeriodKey(previous.year, previous.month);
  const contact = {
    id: "contact-resume-after-paid",
    name: "Pelanggan Pulih",
    phoneNumber: "6281234567812",
    subscriptionType: SUBSCRIPTION_TYPES.RECURRING,
    createdAt: `${frozenKey}-01T00:00:00.000Z`,
    monthlyPaymentAmount: 100000,
    paymentStatus: PAYMENT_STATUS.PAID,
    paymentMonths: {
      [frozenKey]: { status: PAYMENT_STATUS.UNPAID, paidAmount: 0 },
    },
    billingPausedForArrears: true,
    billingPausedAfterPeriod: frozenKey,
    hotspotSuspendedForArrears: true,
    hotspotReactivationEnabled: false,
    hotspotReactivationAt: null,
  };
  const manager = createManager(contact);

  const partial = await manager.updatePaymentStatus(
    contact.id,
    PAYMENT_STATUS.UNPAID,
    PAYMENT_TYPES.ARREARS_ONLY,
    50000
  );
  assert.equal(partial.billingPausedForArrears, true);
  assert.equal(partial.hotspotReactivationEnabled, false);
  assert.equal(partial.debtAmount, 50000);

  const paid = await manager.updatePaymentStatus(
    contact.id,
    PAYMENT_STATUS.UNPAID,
    PAYMENT_TYPES.ARREARS_ONLY,
    50000
  );
  assert.equal(paid.hasDebt, false);
  assert.equal(paid.billingPausedForArrears, false);
  assert.equal(paid.hotspotReactivationEnabled, true);
  assert.equal(new Date(paid.hotspotReactivationAt).getTime() > Date.now(), true);
  assert.equal(paid.hotspotSuspendedForArrears, true);
});

test("bulan selama billing dijeda tidak berubah menjadi tunggakan setelah layanan pulih", async () => {
  const { year, month } = getBillingPeriodParts();
  const previous = getPreviousBillingPeriod(year, month);
  const frozen = getPreviousBillingPeriod(previous.year, previous.month);
  const frozenKey = makeBillingPeriodKey(frozen.year, frozen.month);
  const previousKey = makeBillingPeriodKey(previous.year, previous.month);
  const currentKey = makeBillingPeriodKey(year, month);
  const contact = {
    id: "contact-long-pause",
    name: "Pelanggan Jeda Panjang",
    phoneNumber: "6281234567814",
    subscriptionType: SUBSCRIPTION_TYPES.RECURRING,
    createdAt: `${frozenKey}-01T00:00:00.000Z`,
    monthlyPaymentAmount: 100000,
    paymentStatus: PAYMENT_STATUS.PAID,
    paymentMonths: {
      [frozenKey]: { status: PAYMENT_STATUS.UNPAID, paidAmount: 0 },
    },
    billingPausedForArrears: true,
    billingPausedAfterPeriod: frozenKey,
    hotspotSuspendedForArrears: true,
    hotspotReactivationEnabled: false,
  };
  const manager = createManager(contact);

  const paid = await manager.updatePaymentStatus(
    contact.id,
    PAYMENT_STATUS.UNPAID,
    PAYMENT_TYPES.ARREARS_ONLY,
    100000
  );

  assert.equal(paid.billingPausedForArrears, false);
  assert.equal(paid.hasDebt, false);
  assert.equal(contact.paymentMonths[previousKey].billingPaused, true);
  assert.equal(contact.paymentMonths[currentKey].billingPaused, true);
  assert.equal(contact.paymentMonths[previousKey].status, PAYMENT_STATUS.PAID);
  assert.equal(contact.paymentMonths[currentKey].status, PAYMENT_STATUS.PAID);
});

test("menolak periode pembayaran di luar rentang kalender", async () => {
  const contact = {
    id: "contact-5",
    name: "Pelanggan",
    phoneNumber: "6281234567894",
    paymentMonths: {},
  };
  const manager = createManager(contact);

  await assert.rejects(
    () => manager.setPaymentForMonth(contact.id, 2026, 13, PAYMENT_STATUS.PAID),
    /Periode pembayaran tidak valid/
  );
});

test("menolak timezone aplikasi yang tidak dikenal", async () => {
  const manager = new DataManager({ push() {} });
  manager.saveSettings = async () => {};

  await assert.rejects(
    () => manager.updateSettings({ timezone: "timezone-tidak-valid" }),
    /Timezone aplikasi tidak valid/
  );
});

test("menunda isolir pelanggan belum lunas sesuai masa tenggang", async () => {
  const contact = {
    id: "contact-isolation-grace",
    name: "Pelanggan Masa Tenggang",
    phoneNumber: "6281234567801",
    subscriptionType: SUBSCRIPTION_TYPES.RECURRING,
    paymentStatus: PAYMENT_STATUS.UNPAID,
    paymentMonths: {},
    mikrotikUsername: "pelanggan_grace",
    mikrotikProfile: "default",
    hotspotReactivationEnabled: true,
    hotspotReactivationAt: "2026-10-18T01:00:00.000Z",
  };
  const manager = createManager(contact);
  await manager.updateSettings({ hotspotIsolationGraceDays: 3 });

  assert.equal(manager.getDueHotspotReactivationContacts(new Date("2026-10-21T00:59:59.000Z")).length, 0);
  assert.deepEqual(
    manager.getDueHotspotReactivationContacts(new Date("2026-10-21T01:00:00.000Z")).map(({ id }) => id),
    [contact.id]
  );
});

test("masa tenggang isolir tidak menunda siklus pelanggan yang sudah lunas", async () => {
  const contact = {
    id: "contact-paid-cycle",
    name: "Pelanggan Lunas",
    phoneNumber: "6281234567802",
    subscriptionType: SUBSCRIPTION_TYPES.RECURRING,
    paymentStatus: PAYMENT_STATUS.PAID,
    paymentMonths: {},
    mikrotikUsername: "pelanggan_lunas",
    mikrotikProfile: "default",
    hotspotReactivationEnabled: true,
    hotspotReactivationAt: "2026-10-18T01:00:00.000Z",
  };
  const manager = createManager(contact);
  manager.hydrateContact = (value) => ({
    ...value,
    hasDebt: false,
    currentPaymentStatus: PAYMENT_STATUS.PAID,
  });
  await manager.updateSettings({ hotspotIsolationGraceDays: 3 });

  assert.deepEqual(
    manager.getDueHotspotReactivationContacts(new Date("2026-10-18T01:00:00.000Z")).map(({ id }) => id),
    [contact.id]
  );
});

test("masa tenggang isolir dibatasi antara 0 sampai 30 hari", async () => {
  const manager = new DataManager({ push() {} });
  manager.saveSettings = async () => {};

  assert.equal((await manager.updateSettings({ hotspotIsolationGraceDays: 3 })).hotspotIsolationGraceDays, 3);
  assert.equal((await manager.updateSettings({ hotspotIsolationGraceDays: 31 })).hotspotIsolationGraceDays, 3);
  assert.equal((await manager.updateSettings({ hotspotIsolationGraceDays: 0 })).hotspotIsolationGraceDays, 0);
});

test("menyimpan template pengingat tagihan dari menu pengaturan", async () => {
  const manager = new DataManager({ push() {} });
  manager.saveSettings = async () => {};

  const settings = await manager.updateSettings({
    billingReminderMessageTemplate: "Halo {{name}}, total tagihan {{totalAmount}}.",
  });

  assert.equal(
    settings.billingReminderMessageTemplate,
    "Halo {{name}}, total tagihan {{totalAmount}}."
  );
});

test("menyimpan template pengiriman akun pelanggan dari menu pengaturan", async () => {
  const manager = new DataManager({ push() {} });
  manager.saveSettings = async () => {};

  const settings = await manager.updateSettings({
    customerAccountMessageTemplate: "Halo {{name}}.\n\n{{portalAccountDetails}}\n\n{{portalAccessGuide}}",
  });

  assert.equal(
    settings.customerAccountMessageTemplate,
    "Halo {{name}}.\n\n{{portalAccountDetails}}\n\n{{portalAccessGuide}}"
  );
});

test("tarif profile MikroTik memperbarui nominal pelanggan dan reminder", async () => {
  const contact = {
    id: "contact-profile-tariff",
    name: "Pelanggan Profile",
    phoneNumber: "6281234567893",
    mikrotikProfile: "30Hari",
    monthlyPaymentAmount: 100_000,
    createdAt: new Date().toISOString(),
    paymentStatus: PAYMENT_STATUS.UNPAID,
    paymentMonths: {},
  };
  const manager = createManager(contact);
  manager.reminders.set("reminder-profile-tariff", {
    id: "reminder-profile-tariff",
    contactId: contact.id,
    phoneNumber: contact.phoneNumber,
    message: "Tagihan sebesar Rp 100.000",
    messageSource: "Tagihan sebesar Rp 100.000",
    paymentAmount: 100_000,
  });

  await manager.updateSettings({ profileMonthlyAmounts: { "30Hari": 40_000 } });

  assert.equal(contact.monthlyPaymentAmount, 40_000);
  assert.equal(manager.reminders.get("reminder-profile-tariff").paymentAmount, 40_000);
  assert.match(manager.reminders.get("reminder-profile-tariff").message, /Rp\s?40\.000/);
});

test("nominal pelanggan dapat dicustom meskipun profile memiliki tarif default", async () => {
  const contact = {
    id: "contact-profile-fixed-price",
    name: "Pelanggan Profile Fixed",
    phoneNumber: "6281234567892",
    mikrotikProfile: "30Hari",
    monthlyPaymentAmount: 40_000,
    paymentStatus: PAYMENT_STATUS.UNPAID,
    paymentMonths: {},
  };
  const manager = createManager(contact);
  await manager.updateSettings({ profileMonthlyAmounts: { "30Hari": 40_000 } });

  const customized = await manager.updateContactPaymentAmount(contact.id, 50_000);
  assert.equal(customized.monthlyPaymentAmount, 50_000);
  assert.equal(customized.monthlyPaymentAmountCustomized, true);

  await manager.updateSettings({ profileMonthlyAmounts: { "30Hari": 60_000 } });
  assert.equal(contact.monthlyPaymentAmount, 50_000);

  const reset = await manager.updateContactPaymentAmount(contact.id, undefined, { useProfileDefault: true });
  assert.equal(reset.monthlyPaymentAmount, 60_000);
  assert.equal(reset.monthlyPaymentAmountCustomized, false);
});

test("pengaturan tidak lagi menyimpan template notifikasi reaktivasi hotspot", async () => {
  const manager = new DataManager({ push() {} });
  manager.saveSettings = async () => {};
  manager.settings.hotspotReactivationMessageTemplate = "Template lama";

  const settings = await manager.updateSettings({
    hotspotReactivationMessageTemplate: "Template baru",
  });

  assert.equal("hotspotReactivationMessageTemplate" in settings, false);
  assert.equal("hotspotReactivationMessageTemplate" in manager.settings, false);
});

test("migration mengganti reminder Penagihan existing dengan template variabel satu kali", async () => {
  const contact = {
    id: "contact-reminder-migration",
    name: "Nouval",
    phoneNumber: "6287728972090",
    createdAt: new Date().toISOString(),
    monthlyPaymentAmount: 100_000,
    paymentStatus: PAYMENT_STATUS.UNPAID,
    paymentMonths: {},
  };
  const manager = createManager(contact);
  manager.saveSettings = async () => {};
  manager.settings.reminderVariableTemplateMigrationVersion = 0;
  manager.reminders.set("billing", {
    id: "billing",
    contactId: contact.id,
    phoneNumber: contact.phoneNumber,
    message: "Yth. Nouval, tagihan Rp 100.000 jatuh tempo 2026-08-15.",
    messageSource: "Yth. Nouval, tagihan Rp 100.000 jatuh tempo 2026-08-15.",
    reminderDateTime: "2026-08-15T01:00:00.000Z",
    templateName: "Penagihan.txt",
  });
  manager.reminders.set("custom", {
    id: "custom",
    contactId: contact.id,
    phoneNumber: contact.phoneNumber,
    message: "Pesan khusus pelanggan.",
    messageSource: "Pesan khusus pelanggan.",
    reminderDateTime: "2026-08-16T01:00:00.000Z",
    templateName: "Info.txt",
  });

  const first = await manager.migrateReminderVariableTemplates();
  const second = await manager.migrateReminderVariableTemplates();

  assert.equal(first.migrated, 1);
  assert.equal(second.migrated, 0);
  assert.equal(manager.reminders.get("billing").messageSource, DEFAULT_REMINDER_MESSAGE_TEMPLATE);
  assert.equal(manager.reminders.get("billing").message, DEFAULT_REMINDER_MESSAGE_TEMPLATE);
  assert.equal(manager.reminders.get("custom").message, "Pesan khusus pelanggan.");
  assert.equal(manager.settings.reminderVariableTemplateMigrationVersion, 1);
});

test("registrasi pelanggan MikroTik membuat jadwal sebulan dari waktu registrasi", async () => {
  const manager = new DataManager({ push() {} });
  manager.sequelize = {
    transaction: async (operation) => operation({}),
  };
  manager.withDatabaseWrite = async (operation) => operation();
  manager.saveContacts = async () => {};
  manager.savePelanggan = async () => {};
  manager.saveReminders = async () => {};
  const result = await manager.upsertPelangganFromRegistration({
    name: "Pelanggan Baru",
    phoneNumber: "6281234567800",
    username: "pelanggan_baru",
    profile: "100M",
    password: "67800",
    linkedApHost: "10.0.0.20",
    hotspotReactivationEnabled: true,
    hotspotReactivationAt: "2027-01-01T00:00:00.000Z",
  });

  assert.equal(result.contact.linkedApHost, "10.0.0.20");
  assert.equal(result.contact.hotspotReactivationEnabled, true);
  assert.equal(
    result.contact.hotspotReactivationAt,
    addMonthsSafely(result.contact.createdAt, 1, manager.getTimezone()).toISOString()
  );
  assert.equal(result.contact.hotspotProvisioningStatus, "ACTIVE");
  assert.equal(result.pelanggan.hotspotProvisioningStatus, "ACTIVE");
  const reminders = Array.from(manager.reminders.values());
  assert.equal(reminders.length, 1);
  assert.equal(reminders[0].contactId, result.contact.id);
  assert.equal(reminders[0].reminderDateTime, result.contact.hotspotReactivationAt);
  assert.equal(reminders[0].templateName, "Penagihan.txt");
  assert.equal(manager.ensureRecurringReminder(result.contact).created, false);
  assert.equal(manager.reminders.size, 1);
});

test("sekali berlangganan mengubah jadwal menjadi penonaktifan tanpa menghapus tanggal", async () => {
  const manager = new DataManager({ push() {} });
  manager.sequelize = { transaction: async (operation) => operation({}) };
  manager.withDatabaseWrite = async (operation) => operation();
  manager.saveContacts = async () => {};
  manager.savePelanggan = async () => {};
  manager.saveReminders = async () => {};
  manager.saveCustomerAccounts = async () => {};

  const result = await manager.addContact({
    name: "Pelanggan Sekali Hotspot",
    phoneNumber: "6281234567801",
    subscriptionType: SUBSCRIPTION_TYPES.ONE_TIME,
    mikrotikUsername: "pelanggan-sekali",
    mikrotikProfile: "default",
    hotspotReactivationEnabled: true,
    hotspotReactivationAt: "2026-09-01 00:00",
  });

  assert.equal(result.subscriptionType, SUBSCRIPTION_TYPES.ONE_TIME);
  assert.equal(result.hotspotReactivationEnabled, false);
  assert.equal(
    result.hotspotReactivationAt,
    addMonthsSafely(result.createdAt, 1, manager.getTimezone()).toISOString()
  );

  const reactivated = await manager.markHotspotReactivated(result.id, { password: "hotspot-pass", profile: "default" });
  assert.equal(reactivated.hotspotReactivationEnabled, false);
  assert.equal(reactivated.hotspotReactivationAt, null);
});

test("migrasi jadwal layanan memakai tanggal dan jam registrasi pertama", async () => {
  const manager = new DataManager({ push() {} });
  manager.sequelize = { transaction: async (operation) => operation({}) };
  manager.withDatabaseWrite = async (operation) => operation();
  manager.saveContacts = async () => {};
  manager.saveSettings = async () => {};

  const registeredAt = "2026-10-14T06:13:00.000Z";
  const expectedSchedule = "2026-11-14T06:13:00.000Z";
  manager.contacts.set("recurring-anchor", {
    id: "recurring-anchor",
    name: "Pelanggan Bulanan",
    createdAt: registeredAt,
    subscriptionType: SUBSCRIPTION_TYPES.RECURRING,
    hotspotReactivationEnabled: true,
    hotspotReactivationAt: "2026-11-01T00:00:00.000Z",
  });
  manager.contacts.set("one-time-anchor", {
    id: "one-time-anchor",
    name: "Pelanggan Sekali",
    mikrotikUsername: "one-time-anchor",
    subscriptionType: SUBSCRIPTION_TYPES.ONE_TIME,
    hotspotReactivationEnabled: false,
    hotspotReactivationAt: null,
  });
  manager.pelanggan.set("one-time-anchor", {
    username: "one-time-anchor",
    contactId: "one-time-anchor",
    tanggalDaftar: registeredAt,
  });

  const first = await manager.migrateServiceSchedulesFromRegistration({
    now: "2026-10-14T00:00:00.000Z",
  });
  const second = await manager.migrateServiceSchedulesFromRegistration({
    now: "2026-10-14T00:00:00.000Z",
  });

  assert.equal(first.migrated, 2);
  assert.equal(first.skipped, 0);
  assert.equal(manager.contacts.get("recurring-anchor").hotspotReactivationAt, expectedSchedule);
  assert.equal(manager.contacts.get("recurring-anchor").hotspotReactivationEnabled, true);
  assert.equal(manager.contacts.get("one-time-anchor").hotspotReactivationAt, expectedSchedule);
  assert.equal(manager.contacts.get("one-time-anchor").hotspotReactivationEnabled, false);
  assert.equal(manager.settings.serviceScheduleAnchorMigrationVersion, 1);
  assert.equal(second.migrated, 0);
});

test("persiapan akun hotspot menyimpan pelanggan sebagai PENDING", async () => {
  const manager = new DataManager({ push() {} });
  manager.sequelize = {
    transaction: async (operation) => operation({}),
  };
  manager.withDatabaseWrite = async (operation) => operation();
  manager.saveContacts = async () => {};
  manager.savePelanggan = async () => {};
  manager.saveReminders = async () => {};

  const result = await manager.prepareHotspotRegistration({
    name: "Pelanggan Pending",
    phoneNumber: "6281234567803",
    profile: "50M",
    sendCredentials: true,
  });

  assert.equal(result.contact.mikrotikUsername, "pelanggan_pending");
  assert.equal(result.contact.mikrotikPassword, "67803");
  assert.equal(result.contact.hotspotProvisioningStatus, "PENDING");
  assert.equal(result.contact.hotspotSendCredentials, true);
  assert.equal(result.pelanggan.hotspotProvisioningStatus, "PENDING");
});

test("akun portal dibuat otomatis dari kredensial hotspot pelanggan lama", async () => {
  const manager = new DataManager({ push() {} });
  manager.contacts.set("contact-portal", {
    id: "contact-portal",
    name: "Pelanggan Portal",
    phoneNumber: "6281234567810",
    mikrotikUsername: "pelanggan_portal",
    mikrotikPassword: "67810",
    mikrotikProfile: "50M",
    hotspotProvisioningStatus: "ACTIVE",
    monthlyPaymentAmount: 150000,
    paymentStatus: PAYMENT_STATUS.UNPAID,
    paymentMonths: {},
    createdAt: new Date().toISOString(),
  });

  const count = await manager.synchronizeCustomerPortalAccounts();
  const account = manager.findCustomerPortalAccount("PELANGGAN_PORTAL");
  const portal = manager.getCustomerPortalData("contact-portal");

  assert.equal(count, 1);
  assert.equal(account.account.password, "67810");
  assert.equal(account.contact.id, "contact-portal");
  assert.equal(portal.customer.name, "Pelanggan Portal");
  assert.equal(portal.hotspot.username, "pelanggan_portal");
  assert.equal(portal.hotspot.password, "67810");
  assert.equal(portal.account.username, "pelanggan_portal");
  assert.equal(portal.billing.monthlyAmount, 150000);
});

test("kontak baru dengan akun hotspot langsung mendapat akun portal", async () => {
  const manager = new DataManager({ push() {} });
  manager.sequelize = { transaction: async (operation) => operation({}) };
  manager.withDatabaseWrite = async (operation) => operation();
  manager.saveContacts = async () => {};
  manager.savePelanggan = async () => {};
  manager.saveReminders = async () => {};

  const contact = await manager.addContact({
    name: "Pelanggan Langsung",
    phoneNumber: "6281234567811",
    mikrotikUsername: "pelanggan_langsung",
    mikrotikPassword: "67811",
    mikrotikProfile: "100M",
  });

  const account = manager.findCustomerPortalAccount("pelanggan_langsung");
  assert.equal(account.contact.id, contact.id);
  assert.equal(account.account.password, "67811");
});

test("portal menyembunyikan kredensial hotspot yang tidak ada lagi di MikroTik", () => {
  const manager = new DataManager({ push() {} });
  const contact = {
    id: "contact-hotspot-missing",
    name: "Pelanggan Tanpa Hotspot",
    phoneNumber: "6281234567820",
    mikrotikUsername: "hotspot_hilang",
    mikrotikPassword: "67820",
    mikrotikProfile: "50M",
    hotspotProvisioningStatus: "MISSING",
    paymentStatus: PAYMENT_STATUS.UNPAID,
    paymentMonths: {},
    createdAt: new Date().toISOString(),
  };
  manager.contacts.set(contact.id, contact);
  manager.pelanggan.set(contact.mikrotikUsername, {
    username: contact.mikrotikUsername,
    password: contact.mikrotikPassword,
    profile: contact.mikrotikProfile,
    contactId: contact.id,
    hotspotProvisioningStatus: "MISSING",
  });
  manager.customerAccounts.set(contact.id, {
    contactId: contact.id,
    username: "akun_tanpa_hotspot",
    password: "portal-67820",
  });

  assert.equal(manager.getCustomerPortalData(contact.id).hotspot, null);

  contact.hotspotProvisioningStatus = "CHANGED";
  contact.hotspotProvisioningError = 'Data akun "hotspot_hilang" di MikroTik berubah: akun dinonaktifkan.';
  assert.equal(manager.getCustomerPortalData(contact.id).hotspot, null);

  contact.hotspotProvisioningStatus = "ACTIVE";
  contact.hotspotProvisioningError = "";
  const restoredPortal = manager.getCustomerPortalData(contact.id);
  assert.equal(restoredPortal.hotspot.username, "hotspot_hilang");
  assert.equal(restoredPortal.hotspot.status, "ACTIVE");
});

test("perubahan password hotspot memperbarui Contact dan Pelanggan secara atomik", async () => {
  const manager = new DataManager({ push() {} });
  manager.sequelize = { transaction: async (operation) => operation({}) };
  manager.withDatabaseWrite = async (operation) => operation();
  manager.saveContacts = async () => {};
  manager.savePelanggan = async () => {};
  const contact = {
    id: "contact-change-password",
    name: "Pelanggan Password",
    phoneNumber: "6281234567812",
    mikrotikUsername: "pelanggan_password",
    mikrotikPassword: "67812",
    mikrotikProfile: "50M",
    hotspotProvisioningStatus: "ACTIVE",
    paymentStatus: PAYMENT_STATUS.UNPAID,
    paymentMonths: {},
    createdAt: new Date().toISOString(),
  };
  manager.contacts.set(contact.id, contact);
  manager.pelanggan.set("pelanggan_password", {
    username: "pelanggan_password",
    password: "67812",
    profile: "50M",
    contactId: contact.id,
  });
  manager.customerAccounts.set(contact.id, {
    contactId: contact.id,
    username: "akun_pelanggan_password",
    password: "login-67812",
  });

  const portal = await manager.updateCustomerHotspotPassword(contact.id, "67812", "baru-67812");

  assert.equal(contact.mikrotikPassword, "baru-67812");
  assert.equal(manager.pelanggan.get("pelanggan_password").password, "baru-67812");
  assert.equal(manager.customerAccounts.get(contact.id).password, "login-67812");
  assert.equal(contact.hotspotProvisioningStatus, "ACTIVE");
  assert.equal(portal.hotspot.password, "baru-67812");
  assert.equal(portal.account.username, "akun_pelanggan_password");
  await assert.rejects(
    () => manager.updateCustomerHotspotPassword(contact.id, "67812", "lain-67812"),
    /Password hotspot saat ini tidak sesuai/
  );
});

test("perubahan password akun pelanggan tidak mengubah kredensial hotspot", async () => {
  const manager = new DataManager({ push() {} });
  manager.sequelize = { transaction: async (operation) => operation({}) };
  manager.withDatabaseWrite = async (operation) => operation();
  manager.saveCustomerAccounts = async () => {};
  const contact = {
    id: "contact-change-portal-password",
    name: "Pelanggan Portal Password",
    phoneNumber: "6281234567821",
    mikrotikUsername: "pelanggan_portal_password",
    mikrotikPassword: "hotspot-67821",
    mikrotikProfile: "50M",
    hotspotProvisioningStatus: "ACTIVE",
    paymentStatus: PAYMENT_STATUS.UNPAID,
    paymentMonths: {},
    createdAt: new Date().toISOString(),
  };
  manager.contacts.set(contact.id, contact);
  manager.pelanggan.set(contact.mikrotikUsername, {
    username: contact.mikrotikUsername,
    password: contact.mikrotikPassword,
    profile: contact.mikrotikProfile,
    contactId: contact.id,
  });
  manager.customerAccounts.set(contact.id, {
    contactId: contact.id,
    username: "akun_portal_password",
    password: "portal-lama",
  });

  const portal = await manager.updateCustomerPortalPassword(contact.id, "portal-lama", "portal-baru");

  assert.equal(manager.customerAccounts.get(contact.id).password, "portal-baru");
  assert.equal(contact.mikrotikPassword, "hotspot-67821");
  assert.equal(manager.pelanggan.get(contact.mikrotikUsername).password, "hotspot-67821");
  assert.equal(portal.account.username, "akun_portal_password");
  assert.equal(portal.hotspot.password, "hotspot-67821");
  await assert.rejects(
    () => manager.updateCustomerPortalPassword(contact.id, "portal-lama", "portal-lain"),
    /Password akun pelanggan saat ini tidak sesuai/
  );
});

test("pembayaran Midtrans menandai periode transaksi lunas secara atomik", async () => {
  const manager = new DataManager({ push() {} });
  manager.sequelize = { transaction: async (operation) => operation({}) };
  manager.withDatabaseWrite = async (operation) => operation();
  manager.saveContacts = async () => {};
  manager.savePaymentGatewayTransactions = async () => {};
  manager.saveReminders = async () => {};
  const contact = {
    id: "contact-midtrans",
    name: "Pelanggan Midtrans",
    phoneNumber: "6281234567822",
    monthlyPaymentAmount: 100000,
    paymentStatus: PAYMENT_STATUS.UNPAID,
    paymentMonths: {
      "2026-07": { status: PAYMENT_STATUS.UNPAID },
      "2026-08": { status: PAYMENT_STATUS.UNPAID },
    },
    createdAt: "2026-07-01T00:00:00.000Z",
  };
  manager.contacts.set(contact.id, contact);
  manager.paymentGatewayTransactions.set("RB-MIDTRANS-1", {
    orderId: "RB-MIDTRANS-1",
    contactId: contact.id,
    amount: 200000,
    periods: ["2026-07", "2026-08"],
    status: "PENDING",
  });

  const result = await manager.completeMidtransPayment("RB-MIDTRANS-1", {
    order_id: "RB-MIDTRANS-1",
    gross_amount: "200000.00",
    transaction_status: "settlement",
    transaction_id: "gateway-transaction-1",
    payment_type: "bank_transfer",
    settlement_time: "2026-08-19 16:00:00",
  });

  assert.equal(result.alreadyProcessed, false);
  assert.equal(contact.paymentMonths["2026-07"].status, PAYMENT_STATUS.PAID);
  assert.equal(contact.paymentMonths["2026-08"].status, PAYMENT_STATUS.PAID);
  assert.equal(contact.paymentMonths["2026-08"].transactionId, "RB-MIDTRANS-1");
  assert.equal(manager.paymentGatewayTransactions.get("RB-MIDTRANS-1").status, "PAID");
  assert.equal(manager.paymentGatewayTransactions.get("RB-MIDTRANS-1").paymentMethod, "bank_transfer");
});

test("refund Midtrans membalik hanya periode yang masih dimiliki transaksi tersebut", async () => {
  const manager = new DataManager({ push() {} });
  manager.sequelize = { transaction: async (operation) => operation({}) };
  manager.withDatabaseWrite = async (operation) => operation();
  manager.saveContacts = async () => {};
  manager.savePaymentGatewayTransactions = async () => {};
  manager.saveReminders = async () => {};
  const { year, month } = getBillingPeriodParts();
  const currentKey = makeBillingPeriodKey(year, month);
  const previousKey = makeBillingPeriodKey(month === 1 ? year - 1 : year, month === 1 ? 12 : month - 1);
  const contact = {
    id: "contact-midtrans-refund",
    name: "Pelanggan Refund",
    phoneNumber: "6281234567823",
    monthlyPaymentAmount: 100000,
    paymentStatus: PAYMENT_STATUS.PAID,
    paymentType: PAYMENT_TYPES.FULL_PAID,
    paymentMonths: {
      [currentKey]: {
        status: PAYMENT_STATUS.PAID,
        transactionId: "RB-REFUND",
        paymentProvider: "midtrans",
      },
      [previousKey]: {
        status: PAYMENT_STATUS.PAID,
        transactionId: "MANUAL-REPLACEMENT",
        paymentProvider: "manual",
      },
    },
    createdAt: new Date().toISOString(),
  };
  manager.contacts.set(contact.id, contact);
  manager.paymentGatewayTransactions.set("RB-REFUND", {
    orderId: "RB-REFUND",
    contactId: contact.id,
    amount: 200000,
    periods: [previousKey, currentKey],
    transactionId: "gateway-refund",
    status: "PAID",
  });

  const result = await manager.refundMidtransPayment("RB-REFUND", {
    gross_amount: "200000.00",
    transaction_status: "refund",
    transaction_id: "gateway-refund",
    refund_amount: "200000.00",
  });

  assert.deepEqual(result.reversedPeriods, [currentKey]);
  assert.equal(contact.paymentMonths[currentKey].status, PAYMENT_STATUS.UNPAID);
  assert.equal(contact.paymentMonths[previousKey].status, PAYMENT_STATUS.PAID);
  assert.equal(contact.paymentStatus, PAYMENT_STATUS.UNPAID);
  assert.equal(result.transaction.status, "REFUNDED");
});

test("refund sebagian Midtrans dicatat tanpa membatalkan seluruh periode", async () => {
  const manager = new DataManager({ push() {} });
  manager.sequelize = { transaction: async (operation) => operation({}) };
  manager.withDatabaseWrite = async (operation) => operation();
  manager.saveContacts = async () => {};
  manager.savePaymentGatewayTransactions = async () => {};
  manager.saveReminders = async () => {};
  const currentKey = getBillingPeriodParts();
  const period = makeBillingPeriodKey(currentKey.year, currentKey.month);
  const contact = {
    id: "contact-midtrans-partial-refund",
    paymentStatus: PAYMENT_STATUS.PAID,
    paymentMonths: {
      [period]: { status: PAYMENT_STATUS.PAID, transactionId: "RB-PARTIAL", paymentProvider: "midtrans" },
    },
    createdAt: new Date().toISOString(),
  };
  manager.contacts.set(contact.id, contact);
  manager.paymentGatewayTransactions.set("RB-PARTIAL", {
    orderId: "RB-PARTIAL",
    contactId: contact.id,
    amount: 100000,
    periods: [period],
    status: "PAID",
  });

  const result = await manager.refundMidtransPayment("RB-PARTIAL", {
    gross_amount: "100000.00",
    transaction_status: "partial_refund",
    refund_amount: "25000.00",
  }, { partial: true });

  assert.deepEqual(result.reversedPeriods, []);
  assert.equal(contact.paymentMonths[period].status, PAYMENT_STATUS.PAID);
  assert.equal(result.transaction.status, "PARTIALLY_REFUNDED");
  assert.equal(result.transaction.refundAmount, 25000);
  assert.equal(result.transaction.manualReviewRequired, true);

  const repeated = await manager.refundMidtransPayment("RB-PARTIAL", {
    gross_amount: "100000.00",
    transaction_status: "partial_refund",
    refund_amount: "50000.00",
  }, { partial: true });

  assert.equal(repeated.alreadyProcessed, false);
  assert.equal(repeated.transaction.refundAmount, 50000);
});

test("status FAILED menyimpan error tanpa menghapus pelanggan", async () => {
  const manager = new DataManager({ push() {} });
  manager.sequelize = {
    transaction: async (operation) => operation({}),
  };
  manager.withDatabaseWrite = async (operation) => operation();
  manager.saveContacts = async () => {};
  manager.savePelanggan = async () => {};
  manager.saveReminders = async () => {};
  const prepared = await manager.prepareHotspotRegistration({
    name: "Pelanggan Tetap Ada",
    phoneNumber: "6281234567804",
    profile: "50M",
  });

  const result = await manager.updateHotspotProvisioningStatus(
    prepared.contact.id,
    "FAILED",
    { error: "MikroTik timeout" }
  );

  assert.equal(manager.contacts.size, 1);
  assert.equal(manager.pelanggan.size, 1);
  assert.equal(result.contact.hotspotProvisioningStatus, "FAILED");
  assert.equal(result.contact.hotspotProvisioningError, "MikroTik timeout");
  assert.equal(result.pelanggan.hotspotProvisioningStatus, "FAILED");
});

test("edit akun hotspot menyimpan snapshot lama sebagai PENDING UPDATE", async () => {
  const manager = new DataManager({ push() {} });
  manager.sequelize = { transaction: async (operation) => operation({}) };
  manager.withDatabaseWrite = async (operation) => operation();
  manager.saveContacts = async () => {};
  manager.savePelanggan = async () => {};
  manager.saveReminders = async () => {};
  manager.settings.profileMonthlyAmounts = { "100M": 120_000 };
  const contact = {
    id: "contact-edit-hotspot",
    name: "Pelanggan Lama",
    phoneNumber: "6281234567805",
    mikrotikUsername: "pelanggan_lama",
    mikrotikProfile: "50M",
    mikrotikPassword: "67805",
    hotspotProvisioningStatus: "ACTIVE",
    hotspotProvisioningOperation: "NONE",
    monthlyPaymentAmount: 50_000,
    paymentMonths: {},
    createdAt: new Date().toISOString(),
  };
  manager.contacts.set(contact.id, contact);
  manager.pelanggan.set(contact.mikrotikUsername, {
    username: contact.mikrotikUsername,
    nomer: contact.phoneNumber,
    profile: contact.mikrotikProfile,
    password: contact.mikrotikPassword,
    contactId: contact.id,
  });
  manager.customerAccounts.set(contact.id, {
    contactId: contact.id,
    username: "akun_pelanggan_lama",
    password: "portal-67805",
  });

  const result = await manager.prepareContactUpdate(contact.id, {
    name: "Pelanggan Baru",
    phoneNumber: "6281234567806",
    mikrotikUsername: "pelanggan_baru",
    mikrotikProfile: "100M",
    mikrotikPassword: "67806",
  });

  assert.equal(result.hotspotSyncRequired, true);
  assert.equal(result.contact.hotspotProvisioningStatus, "PENDING");
  assert.equal(result.contact.hotspotProvisioningOperation, "UPDATE");
  assert.equal(result.contact.monthlyPaymentAmount, 120_000);
  assert.deepEqual(result.contact.hotspotProvisioningPrevious, {
    username: "pelanggan_lama",
    profile: "50M",
    password: "67805",
    phoneNumber: "6281234567805",
  });
  assert.equal(manager.pelanggan.has("pelanggan_lama"), false);
  assert.equal(manager.pelanggan.get("pelanggan_baru").status, "pending");
  assert.equal(manager.customerAccounts.get(contact.id).username, "akun_pelanggan_lama");
  assert.equal(manager.customerAccounts.get(contact.id).password, "portal-67805");

  const failed = await manager.updateHotspotProvisioningStatus(
    contact.id,
    "FAILED",
    { error: "router timeout" }
  );
  assert.equal(failed.contact.hotspotProvisioningOperation, "UPDATE");
  assert.equal(failed.contact.hotspotProvisioningPrevious.username, "pelanggan_lama");
});

test("edit kontak yang baru diberi hotspot membuat akun pelanggan terpisah", async () => {
  const manager = new DataManager({ push() {} });
  manager.sequelize = { transaction: async (operation) => operation({}) };
  manager.withDatabaseWrite = async (operation) => operation();
  manager.saveContacts = async () => {};
  manager.savePelanggan = async () => {};
  manager.saveReminders = async () => {};
  const contact = {
    id: "contact-new-hotspot",
    name: "Pelanggan Baru Hotspot",
    phoneNumber: "6281234567820",
    mikrotikUsername: "",
    mikrotikProfile: "",
    mikrotikPassword: "",
    hotspotProvisioningStatus: "NONE",
    hotspotProvisioningOperation: "NONE",
    paymentMonths: {},
    createdAt: "2026-08-19T00:00:00.000Z",
    updatedAt: "2026-08-19T00:00:00.000Z",
  };
  manager.contacts.set(contact.id, contact);

  await manager.prepareContactUpdate(contact.id, {
    mikrotikUsername: "pelanggan_baru_hotspot",
    mikrotikProfile: "50M",
    mikrotikPassword: "67820",
  });

  assert.deepEqual(manager.customerAccounts.get(contact.id), {
    contactId: contact.id,
    username: "pelanggan_baru_hotspot",
    password: "67820",
    createdAt: contact.createdAt,
    updatedAt: contact.updatedAt,
  });
  assert.equal(manager.pelanggan.get("pelanggan_baru_hotspot").password, "67820");
});

test("edit data umum tidak memicu sinkronisasi ulang hotspot", async () => {
  const manager = new DataManager({ push() {} });
  manager.sequelize = { transaction: async (operation) => operation({}) };
  manager.withDatabaseWrite = async (operation) => operation();
  manager.saveContacts = async () => {};
  manager.savePelanggan = async () => {};
  manager.saveReminders = async () => {};
  const contact = {
    id: "contact-edit-general",
    name: "Nama Lama",
    phoneNumber: "6281234567807",
    linkedApHost: "",
    mikrotikUsername: "nama_lama",
    mikrotikProfile: "50M",
    mikrotikPassword: "67807",
    hotspotProvisioningStatus: "ACTIVE",
    hotspotProvisioningOperation: "NONE",
    paymentMonths: {},
  };
  manager.contacts.set(contact.id, contact);

  const result = await manager.prepareContactUpdate(contact.id, {
    name: "Nama Baru",
    linkedApHost: "10.0.0.9",
  });

  assert.equal(result.hotspotSyncRequired, false);
  assert.equal(result.contact.hotspotProvisioningStatus, "ACTIVE");
  assert.equal(result.contact.hotspotProvisioningPrevious, undefined);
});

test("mengosongkan user dan profile hanya melepas hubungan hotspot dari aplikasi", async () => {
  const manager = new DataManager({ push() {} });
  manager.sequelize = { transaction: async (operation) => operation({}) };
  manager.withDatabaseWrite = async (operation) => operation();
  manager.saveContacts = async () => {};
  manager.savePelanggan = async () => {};
  manager.saveReminders = async () => {};
  const contact = {
    id: "contact-unlink-hotspot",
    name: "Pelanggan Unlink",
    phoneNumber: "6281234567808",
    mikrotikUsername: "pelanggan_unlink",
    mikrotikProfile: "50M",
    mikrotikPassword: "67808",
    hotspotProvisioningStatus: "ACTIVE",
    hotspotProvisioningOperation: "NONE",
    hotspotReactivationEnabled: false,
    paymentMonths: {},
  };
  manager.contacts.set(contact.id, contact);
  manager.pelanggan.set(contact.mikrotikUsername, {
    username: contact.mikrotikUsername,
    contactId: contact.id,
  });

  const result = await manager.prepareContactUpdate(contact.id, {
    mikrotikUsername: "",
    mikrotikProfile: "",
    hotspotReactivationEnabled: false,
    hotspotReactivationAt: "",
  });

  assert.equal(result.hotspotSyncRequired, false);
  assert.equal(result.contact.hotspotProvisioningStatus, "NONE");
  assert.equal(result.contact.mikrotikPassword, "");
  assert.equal(manager.pelanggan.size, 0);
});

test("lifecycle reaktivasi dan deaktivasi memperbarui status Contact serta Pelanggan", async () => {
  const manager = new DataManager({ push() {} });
  manager.sequelize = { transaction: async (operation) => operation({}) };
  manager.withDatabaseWrite = async (operation) => operation();
  manager.saveContacts = async () => {};
  manager.savePelanggan = async () => {};
  const contact = {
    id: "contact-lifecycle-hotspot",
    name: "Pelanggan Lifecycle",
    phoneNumber: "6281234567809",
    mikrotikUsername: "pelanggan_lifecycle",
    mikrotikProfile: "100M",
    mikrotikPassword: "67809",
    hotspotProvisioningStatus: "ACTIVE",
    hotspotReactivationEnabled: false,
    hotspotReactivationAt: new Date().toISOString(),
    paymentMonths: {},
  };
  manager.contacts.set(contact.id, contact);
  manager.pelanggan.set(contact.mikrotikUsername, {
    username: contact.mikrotikUsername,
    contactId: contact.id,
  });

  await manager.prepareHotspotLifecycleOperation(contact.id, "REACTIVATE");
  assert.equal(contact.hotspotProvisioningStatus, "PENDING");
  assert.equal(contact.hotspotProvisioningOperation, "REACTIVATE");

  await manager.markHotspotReactivated(contact.id, {
    password: contact.mikrotikPassword,
    profile: contact.mikrotikProfile,
  });
  assert.equal(contact.hotspotProvisioningStatus, "ACTIVE");
  assert.equal(contact.hotspotProvisioningOperation, "NONE");
  assert.equal(manager.pelanggan.get(contact.mikrotikUsername).status, "verified");

  await manager.prepareHotspotLifecycleOperation(contact.id, "DEACTIVATE");
  await manager.markHotspotDeactivated(contact.id, { removedUsers: 1 });
  assert.equal(contact.hotspotProvisioningStatus, "DEACTIVATED");
  assert.equal(contact.hotspotProvisioningOperation, "NONE");
  assert.equal(manager.pelanggan.get(contact.mikrotikUsername).status, "deactivated");
});

test("mengembalikan state in-memory ketika penyimpanan database gagal", async () => {
  const manager = new DataManager({ push() {} });
  manager.saveContacts = async () => {
    throw new Error("database gagal");
  };

  await assert.rejects(
    () => manager.addContact({ name: "Audit", phoneNumber: "6281234567801" }),
    /database gagal/
  );
  assert.equal(manager.contacts.size, 0);
});

test("response publik tidak membocorkan password hotspot atau isi antrean kredensial", () => {
  const manager = new DataManager({ push() {} });
  const contact = {
    id: "public-contact",
    name: "Pelanggan",
    phoneNumber: "6281234567802",
    mikrotikPassword: "router-secret",
    hotspotProvisioningPrevious: {
      username: "akun-lama",
      password: "password-lama",
    },
    hotspotNotificationPending: {
      message: "Password router-secret",
      attempts: 1,
      nextAttemptAt: new Date().toISOString(),
    },
    paymentMonths: {},
  };
  manager.contacts.set(contact.id, contact);

  const result = manager.toPublicContact(contact);
  assert.equal("mikrotikPassword" in result, false);
  assert.equal("hotspotProvisioningPrevious" in result, false);
  assert.equal(result.hotspotNotificationPending.message, undefined);
  assert.equal(result.hotspotNotificationPending.attempts, 1);
});
