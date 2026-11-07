const assert = require("node:assert/strict");
const test = require("node:test");

const { DataManager } = require("../src/app");
const { verifyPortalPassword } = require("../src/portal-password");
const {
  BILLING_CYCLES,
  CONFIG,
  DETAILED_BILLING_REMINDER_MESSAGE_TEMPLATE,
  DEFAULT_REMINDER_MESSAGE_TEMPLATE,
  DEFAULT_SETTINGS,
  LEGACY_ACTIVE_PERIOD_REMINDER_MESSAGE_TEMPLATE,
  LEGACY_ACTIVE_PERIOD_REMINDER_MESSAGE_TEMPLATE_V3,
  LEGACY_ACTIVE_PERIOD_REMINDER_MESSAGE_TEMPLATE_V5,
  LEGACY_DEFAULT_REMINDER_MESSAGE_TEMPLATE_V3,
  LEGACY_DETAILED_BILLING_REMINDER_MESSAGE_TEMPLATE_V4,
  LEGACY_NOTIFICATION_TEMPLATES_V3,
  LEGACY_PREPAID_PACKAGE_REMINDER_MESSAGE_TEMPLATE_V5,
  LEGACY_PAYMENT_MESSAGE_TEMPLATE_ACTIVE_PERIOD,
  PAYMENT_STATUS,
  PAYMENT_TYPES,
  REMINDER_KINDS,
  SUBSCRIPTION_TYPES,
} = require("../src/config");
const {
  addDaysSafely,
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
  manager.saveSentReminders = async () => {};
  manager.saveSettings = async () => {};
  manager.withDatabaseWrite = async (operation) => operation();
  manager.sequelize = {
    transaction: async (operation) => operation({}),
  };
  return manager;
}

test("ringkasan dashboard menghitung layanan dan pesan terkirim hari ini", () => {
  const manager = createManager({
    id: "summary-active",
    name: "Aktif",
    phoneNumber: "628111111111",
    subscriptionType: SUBSCRIPTION_TYPES.RECURRING,
    billingCycle: BILLING_CYCLES.PREPAID,
    mikrotikUsername: "aktif",
    hotspotProvisioningStatus: "ACTIVE",
    hotspotReactivationAt: "2026-11-20T00:00:00.000Z",
  });
  manager.settings.timezone = "Asia/Jakarta";
  manager.contacts.set("summary-disabled", {
    id: "summary-disabled",
    name: "Nonaktif",
    phoneNumber: "628222222222",
    subscriptionType: SUBSCRIPTION_TYPES.RECURRING,
    billingCycle: BILLING_CYCLES.PREPAID,
    mikrotikUsername: "nonaktif",
    hotspotProvisioningStatus: "DISABLED",
    hotspotReactivationAt: "2026-11-01T00:00:00.000Z",
  });
  manager.contacts.set("summary-contact-only", {
    id: "summary-contact-only",
    name: "Tanpa Layanan",
    phoneNumber: "628333333333",
    subscriptionType: SUBSCRIPTION_TYPES.RECURRING,
    billingCycle: BILLING_CYCLES.PREPAID,
    hotspotProvisioningStatus: "NONE",
    hotspotReactivationAt: "2026-11-20T00:00:00.000Z",
  });
  manager.reminders.set("summary-reminder", {
    id: "summary-reminder",
    contactId: "summary-active",
    reminderDateTime: "2026-11-20T00:00:00.000Z",
  });
  for (const reminder of [
    { id: "sent-today", sentAt: "2026-11-06T02:00:00.000Z", deliveryStatus: "SENT_BAILEYS" },
    { id: "failed-today", sentAt: "2026-11-06T03:00:00.000Z", deliveryStatus: "FAILED" },
    { id: "skipped-today", sentAt: "2026-11-06T04:00:00.000Z", deliveryStatus: "SKIPPED_PAID" },
    { id: "sent-yesterday", sentAt: "2026-11-05T10:00:00.000Z", deliveryStatus: "SENT" },
  ]) manager.sentReminders.set(reminder.id, reminder);

  const summary = manager.getDashboardSummary(new Date("2026-11-06T05:00:00.000Z"));

  assert.equal(summary.contacts, 3);
  assert.equal(summary.activeServices, 1);
  assert.equal(summary.serviceAttention, 1);
  assert.equal(summary.paidContacts, 2);
  assert.equal(summary.unpaidContacts, 1);
  assert.equal(summary.reminders, 1);
  assert.equal(summary.sentReminders, 4);
  assert.equal(summary.sentToday, 1);
});

test("riwayat batch voucher disimpan terpisah dari komentar user MikroTik", async () => {
  const manager = createManager({ id: "contact-placeholder", phoneNumber: "6281234567890" });
  let saveCalls = 0;
  manager.saveVoucherBatches = async () => { saveCalls += 1; };
  await manager.storeVoucherBatches([{
    batchId: "batch-voucher-1",
    createdAt: "2026-11-02T12:00:00.000Z",
    profile: "4Jam",
    sellingPrice: 40000,
    quantity: 2,
    vouchers: [
      { username: "voucher-1", password: "rahasia-1" },
      { username: "voucher-2", password: "rahasia-2" },
    ],
  }]);

  assert.equal(saveCalls, 1);
  assert.equal(manager.getVoucherBatches()[0].sellingPrice, 40000);
  assert.equal(manager.getVoucherBatches()[0].vouchers[0].password, "rahasia-1");
  assert.notEqual(manager.getVoucherBatches()[0], manager.voucherBatches.get("batch-voucher-1"));

  await manager.storeVoucherBatches([{
    batchId: "batch-voucher-1",
    profile: "4Jam",
    vouchers: [{
      username: "voucher-1",
      password: "",
      used: true,
      usageStatus: "USED",
      usedAt: "2026-11-03T01:00:00.000Z",
    }],
  }]);

  const updated = manager.getVoucherBatches()[0];
  assert.equal(updated.vouchers[0].password, "rahasia-1");
  assert.equal(updated.vouchers[0].usageStatus, "USED");
  assert.equal(updated.vouchers[1].password, "rahasia-2");
  assert.equal(updated.quantity, 2);
  assert.equal(updated.generationType, "BULK");
  assert.equal(saveCalls, 2);
});

test("riwayat pendapatan voucher tersimpan permanen dan memperbarui status voucher batch", async () => {
  const manager = createManager({ id: "contact-placeholder", phoneNumber: "6281234567890" });
  manager.voucherBatches.set("batch-pendapatan", {
    batchId: "batch-pendapatan",
    vouchers: [{ username: "voucher-1", password: "rahasia", used: false, usageStatus: "UNUSED" }],
  });
  let revenueSaveCalls = 0;
  manager.upsertVoucherRevenueEntries = async () => { revenueSaveCalls += 1; };
  manager.saveVoucherBatches = async () => {};
  const entry = {
    id: "voucher-usage-1",
    username: "voucher-1",
    profile: "VCR-1D",
    amount: 40000,
    costPrice: 25000,
    commission: 15000,
    usedAt: "2026-11-03T01:00:00.000Z",
    period: "2026-11",
    validity: "1d",
    address: "10.0.0.2",
    macAddress: "AA:BB:CC:DD:EE:FF",
    batchId: "batch-pendapatan",
  };

  const first = await manager.storeVoucherRevenueEntries([entry]);
  const duplicate = await manager.storeVoucherRevenueEntries([entry]);
  const report = manager.getVoucherRevenueReport("2026-11");
  const voucher = manager.getVoucherBatch("batch-pendapatan").vouchers[0];

  assert.equal(first.saved, 1);
  assert.equal(duplicate.saved, 0);
  assert.equal(manager.hasVoucherRevenueEntries([entry.id]), true);
  assert.equal(report.summary.revenue, 40000);
  assert.equal(report.summary.quantity, 1);
  assert.equal(voucher.used, true);
  assert.equal(voucher.usageStatus, "USED");
  assert.equal(voucher.usedAt, entry.usedAt);
  assert.equal(revenueSaveCalls, 1);
});

test("seluruh riwayat batch voucher dapat dimuat tanpa batas 100 batch", () => {
  const manager = createManager({ id: "contact-placeholder", phoneNumber: "6281234567890" });
  for (let index = 0; index < 125; index += 1) {
    manager.voucherBatches.set(`batch-${index}`, {
      batchId: `batch-${index}`,
      createdAt: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
      vouchers: [{ username: `voucher-${index}`, password: `password-${index}` }],
    });
  }

  assert.equal(manager.getVoucherBatches().length, 50);
  assert.equal(manager.getVoucherBatches(100).length, 100);
  assert.equal(manager.getVoucherBatches("all").length, 125);
});

test("menghapus voucher memperbarui jumlah batch dan menghapus batch yang sudah kosong", async () => {
  const manager = createManager({ id: "contact-placeholder", phoneNumber: "6281234567890" });
  let saveCalls = 0;
  manager.saveVoucherBatches = async () => { saveCalls += 1; };
  await manager.storeVoucherBatches([{
    batchId: "batch-voucher-delete",
    quantity: 2,
    generationType: "BULK",
    vouchers: [
      { username: "voucher-1", password: "rahasia-1" },
      { username: "voucher-2", password: "rahasia-2" },
    ],
  }]);

  const first = await manager.removeVoucherFromBatch("batch-voucher-delete", "voucher-1");
  const remainingBatch = manager.getVoucherBatch("batch-voucher-delete");
  assert.equal(first.remaining, 1);
  assert.equal(first.batchRemoved, false);
  assert.equal(remainingBatch.quantity, 1);
  assert.equal(remainingBatch.generationType, "SINGLE");
  assert.equal(remainingBatch.vouchers[0].username, "voucher-2");

  const second = await manager.removeVoucherFromBatch("batch-voucher-delete", "voucher-2");
  assert.equal(second.batchRemoved, true);
  assert.equal(manager.getVoucherBatch("batch-voucher-delete"), null);
  assert.equal(saveCalls, 3);
});

test("jatuh tempo prabayar mengikuti masa aktif layanan dan bukan pembayaran periode kalender", () => {
  const now = new Date();
  const nextDate = addMonthsSafely(now, 1, "Asia/Jakarta");
  const contact = {
    id: "contact-next-due", subscriptionType: SUBSCRIPTION_TYPES.RECURRING,
    billingCycle: BILLING_CYCLES.PREPAID,
    hotspotReactivationEnabled: true, hotspotReactivationAt: nextDate.toISOString(),
    paymentMonths: {},
  };
  const manager = createManager(contact);
  const due = manager.buildDueDateInfo(contact);
  assert.equal(due.dueDate, nextDate.toISOString());
  assert.equal(due.dueStatus, "UPCOMING");
  contact.paymentMonths["2026-01"] = { status: PAYMENT_STATUS.UNPAID };
  assert.deepEqual(manager.buildDueDateInfo(contact), due);
});

test("riwayat reminder lama tidak mengalahkan reminder aktif berikutnya", () => {
  const now = new Date();
  const timeZone = "Asia/Jakarta";
  const current = getBillingPeriodParts(now, timeZone);
  const currentKey = makeBillingPeriodKey(current.year, current.month);
  const pastReminder = new Date(now.getTime() - 60_000);
  const nextReminder = addMonthsSafely(now, 1, timeZone);
  const contact = {
    id: "contact-active-due",
    name: "Pelanggan Jadwal Aktif",
    phoneNumber: "6281234567809",
    subscriptionType: SUBSCRIPTION_TYPES.RECURRING,
    paymentStatus: PAYMENT_STATUS.UNPAID,
    paymentMonths: {
      [currentKey]: { status: PAYMENT_STATUS.UNPAID },
    },
    hotspotReactivationAt: nextReminder.toISOString(),
  };
  const manager = createManager(contact);
  manager.sentReminders.set("old-sent-reminder", {
    id: "old-sent-reminder",
    contactId: contact.id,
    phoneNumber: contact.phoneNumber,
    reminderDateTime: pastReminder.toISOString(),
    sentAt: pastReminder.toISOString(),
  });
  manager.reminders.set("next-active-reminder", {
    id: "next-active-reminder",
    contactId: contact.id,
    phoneNumber: contact.phoneNumber,
    reminderDateTime: nextReminder.toISOString(),
  });

  assert.deepEqual(manager.buildDueDateInfo(contact), {
    dueDate: nextReminder.toISOString(),
    dueStatus: "UPCOMING",
  });
});

test("jatuh tempo membedakan jadwal bulanan yang hilang dan pelanggan sekali berlangganan", () => {
  const recurring = createManager({
    id: "contact-needs-schedule",
    phoneNumber: "6281234567801",
    subscriptionType: SUBSCRIPTION_TYPES.RECURRING,
    paymentStatus: PAYMENT_STATUS.UNPAID,
    paymentMonths: {},
  });
  assert.deepEqual(recurring.buildDueDateInfo(recurring.getContact("contact-needs-schedule")), {
    dueDate: null,
    dueStatus: "NOT_SCHEDULED",
  });

  const oneTime = createManager({
    id: "contact-one-time",
    phoneNumber: "6281234567802",
    subscriptionType: SUBSCRIPTION_TYPES.ONE_TIME,
    paymentStatus: PAYMENT_STATUS.PAID,
    paymentMonths: {},
  });
  assert.deepEqual(oneTime.buildDueDateInfo(oneTime.getContact("contact-one-time")), {
    dueDate: null,
    dueStatus: "NOT_APPLICABLE",
  });
});

test("pembayaran kalender tidak boleh memperpanjang paket prabayar di luar jalur pembelian", async () => {
  const now = new Date();
  const nextDate = addDaysSafely(now, 5, "Asia/Jakarta");
  const contact = {
    id: "contact-prepaid-payment", subscriptionType: SUBSCRIPTION_TYPES.RECURRING,
    billingCycle: BILLING_CYCLES.PREPAID, monthlyPaymentAmount: 100_000,
    hotspotReactivationEnabled: true, hotspotReactivationAt: nextDate.toISOString(),
    activePeriodPurchases: [],
  };
  const manager = createManager(contact);
  await assert.rejects(
    () => manager.updatePaymentStatus(contact.id, PAYMENT_STATUS.PAID, PAYMENT_TYPES.CURRENT_ONLY),
    /Pelanggan prabayar dibayar melalui tindakan pembelian paket satu bulan/
  );
  assert.equal(contact.hotspotReactivationAt, nextDate.toISOString());
  assert.equal(contact.activePeriodPurchases.length, 0);
  assert.equal(manager.reminders.size, 0);
});

test("prabayar menggunakan periode kalender berjalan untuk tampilan tanpa membuat tunggakan", () => {
  const reference = getBillingPeriodParts(new Date(), "Asia/Jakarta");
  const previous = getPreviousBillingPeriod(reference.year, reference.month);
  const previousKey = makeBillingPeriodKey(previous.year, previous.month);
  const currentKey = makeBillingPeriodKey(reference.year, reference.month);
  const contact = {
    id: "prepaid-cycle-period", subscriptionType: SUBSCRIPTION_TYPES.RECURRING,
    billingCycle: BILLING_CYCLES.PREPAID,
    createdAt: `${previousKey}-01T00:00:00.000Z`,
    monthlyPaymentAmount: 100_000,
    paymentMonths: {
      [previousKey]: { status: PAYMENT_STATUS.UNPAID, paidAmount: 0 },
      [currentKey]: { status: PAYMENT_STATUS.UNPAID, paidAmount: 0 },
    },
  };
  const info = createManager(contact).buildDebtInfo(contact);
  assert.equal(info.billingPeriodKey, currentKey);
  assert.equal(info.debtCount, 0);
  assert.equal(info.hasDebt, false);
  assert.equal(info.debtAmount, 0);
});

test("prabayar tidak memasuki jeda penagihan tunggakan bulanan", () => {
  const contact = {
    id: "prepaid-no-arrears-pause", subscriptionType: SUBSCRIPTION_TYPES.RECURRING,
    billingCycle: BILLING_CYCLES.PREPAID, monthlyPaymentAmount: 100_000,
  };
  const manager = createManager(contact);
  assert.equal(manager.pauseBillingForArrears(contact, { at: new Date() }), false);
  assert.notEqual(contact.billingPausedForArrears, true);
  assert.equal(contact.billingPausedAfterPeriod || null, null);
});

test("portal prabayar hanya menagihkan harga paket dan bukan hutang kalender", () => {
  const reference = getBillingPeriodParts(new Date(), "Asia/Jakarta");
  const previous = getPreviousBillingPeriod(reference.year, reference.month);
  const previousKey = makeBillingPeriodKey(previous.year, previous.month);
  const currentKey = makeBillingPeriodKey(reference.year, reference.month);
  const contact = {
    id: "prepaid-portal-no-calendar-debt", name: "Pelanggan Portal Prabayar",
    phoneNumber: "6281234567886", subscriptionType: SUBSCRIPTION_TYPES.RECURRING,
    billingCycle: BILLING_CYCLES.PREPAID, monthlyPaymentAmount: 100_000,
    paymentMonths: {
      [previousKey]: { status: PAYMENT_STATUS.UNPAID, paidAmount: 0 },
      [currentKey]: { status: PAYMENT_STATUS.UNPAID, paidAmount: 0 },
    },
  };
  const manager = createManager(contact);
  manager.customerAccounts.set(contact.id, { contactId: contact.id, username: "pelanggan_prepaid", password: "rahasia" });
  const portal = manager.getCustomerPortalData(contact.id);
  assert.equal(portal.billing.period, currentKey);
  assert.equal(portal.billing.billingCycle, BILLING_CYCLES.PREPAID);
  assert.equal(portal.billing.monthlyAmount, 100_000);
});

test("paket prabayar tidak membuat tunggakan dan pembelian awal memperpanjang masa aktif", async () => {
  const now = new Date();
  const currentPeriod = getBillingPeriodParts(now, "Asia/Jakarta");
  const oldUnpaid = getPreviousBillingPeriod(currentPeriod.year, currentPeriod.month);
  const oldUnpaidPeriod = makeBillingPeriodKey(oldUnpaid.year, oldUnpaid.month);
  const currentEnd = addDaysSafely(now, 5, "Asia/Jakarta");
  const expectedEnd = addMonthsSafely(currentEnd, 1, "Asia/Jakarta");
  const contact = {
    id: "contact-prepaid-package",
    name: "Pelanggan Paket",
    phoneNumber: "6281234567885",
    createdAt: now.toISOString(),
    subscriptionType: SUBSCRIPTION_TYPES.RECURRING,
    billingCycle: BILLING_CYCLES.PREPAID,
    monthlyPaymentAmount: 100_000,
    paymentStatus: PAYMENT_STATUS.PAID,
    paymentMonths: {
      [oldUnpaidPeriod]: { status: PAYMENT_STATUS.UNPAID, paidAmount: 0 },
    },
    activePeriodPurchases: [],
    hotspotReactivationEnabled: true,
    hotspotReactivationAt: currentEnd.toISOString(),
    hotspotProvisioningStatus: "ACTIVE",
  };
  const manager = createManager(contact);
  manager.savePaymentGatewayTransactions = async () => {};

  const before = manager.buildDebtInfo(contact);
  assert.equal(before.packageActive, true);
  assert.equal(before.hasDebt, false);
  assert.equal(before.debtCount, 0);

  await manager.createPaymentGatewayTransaction({
    orderId: "RB-PREPAID-PACKAGE-1",
    contactId: contact.id,
    amount: 100_000,
    periods: [],
    paymentType: PAYMENT_TYPES.ACTIVE_PERIOD,
  });
  const completed = await manager.completeMidtransPayment("RB-PREPAID-PACKAGE-1", {
    gross_amount: "100000",
    transaction_status: "settlement",
    transaction_id: "midtrans-package-1",
  });

  assert.equal(completed.transaction.paymentType, PAYMENT_TYPES.ACTIVE_PERIOD);
  assert.equal(contact.activePeriodPurchases.length, 1);
  assert.equal(contact.activePeriodPurchases[0].activeFrom, currentEnd.toISOString());
  assert.equal(contact.activePeriodPurchases[0].activeUntil, expectedEnd.toISOString());
  assert.equal(contact.hotspotReactivationAt, expectedEnd.toISOString());
  assert.equal(manager.buildDebtInfo(contact).debtCount, 0);
  assert.equal(Array.from(manager.reminders.values())[0].reminderKind, REMINDER_KINDS.ACTIVE_PERIOD_EXPIRY);

  const refunded = await manager.refundMidtransPayment("RB-PREPAID-PACKAGE-1", {
    gross_amount: "100000",
    transaction_status: "refund",
    refund_amount: "100000",
  });
  assert.deepEqual(refunded.reversedPeriods, ["Paket prabayar"]);
  assert.equal(contact.activePeriodPurchases.length, 0);
  assert.equal(contact.hotspotReactivationAt, currentEnd.toISOString());
  assert.equal(manager.buildDebtInfo(contact).packageActive, true);
});

test("pembayaran setelah masa aktif habis menghitung satu bulan dari waktu pembayaran", () => {
  const paidAt = new Date();
  const current = getBillingPeriodParts(paidAt, "Asia/Jakarta");
  const currentKey = makeBillingPeriodKey(current.year, current.month);
  const expiredAt = addDaysSafely(paidAt, -3, "Asia/Jakarta");
  const expectedDueDate = addMonthsSafely(paidAt, 1, "Asia/Jakarta");
  const contact = {
    id: "contact-prepaid-expired",
    createdAt: paidAt.toISOString(),
    subscriptionType: SUBSCRIPTION_TYPES.RECURRING,
    paymentStatus: PAYMENT_STATUS.PAID,
    paymentMonths: {
      [currentKey]: { status: PAYMENT_STATUS.PAID },
    },
    hotspotReactivationEnabled: false,
    hotspotReactivationAt: expiredAt.toISOString(),
  };
  const manager = createManager(contact);

  const result = manager.advanceServiceScheduleAfterPayment(contact, {
    at: paidAt,
    previousSchedule: expiredAt,
  });

  assert.equal(result.activeFrom, paidAt.toISOString());
  assert.equal(result.activeUntil, expectedDueDate.toISOString());
  assert.equal(contact.hotspotReactivationAt, expectedDueDate.toISOString());
  assert.equal(contact.hotspotReactivationEnabled, true);
});

test("reminder bulanan yang hilang dibuat ulang dari jadwal layanan", async () => {
  const nextDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const contact = {
    id: "contact-repair-reminder",
    name: "Pelanggan Bulanan",
    phoneNumber: "6281234567803",
    createdAt: new Date().toISOString(),
    subscriptionType: SUBSCRIPTION_TYPES.RECURRING,
    monthlyPaymentAmount: 100_000,
    paymentStatus: PAYMENT_STATUS.UNPAID,
    paymentMonths: {},
    hotspotReactivationAt: nextDate,
  };
  const manager = createManager(contact);
  let saves = 0;
  manager.saveReminders = async () => { saves += 1; };

  assert.equal(await manager.repairMissingRecurringReminders(), 1);
  assert.equal(manager.reminders.size, 1);
  assert.equal(manager.getSortedReminders()[0].reminderDateTime, nextDate);
  assert.equal(saves, 1);
  assert.equal(await manager.repairMissingRecurringReminders(), 0);
  assert.equal(saves, 1);
});

test("audit startup mengonversi reminder tagihan lama menjadi kedaluwarsa paket prabayar", async () => {
  const expiry = "2026-12-02T10:54:00.000Z";
  const contact = {
    id: "contact-stale-reminder", name: "Pelanggan Jadwal Berubah",
    phoneNumber: "6281234567803", subscriptionType: SUBSCRIPTION_TYPES.RECURRING,
    billingCycle: BILLING_CYCLES.PREPAID, monthlyPaymentAmount: 75_000,
    hotspotReactivationAt: expiry,
  };
  const manager = createManager(contact);
  let saves = 0;
  manager.saveReminders = async () => { saves += 1; };
  manager.reminders.set("stale-reminder", {
    id: "stale-reminder", contactId: contact.id, phoneNumber: contact.phoneNumber,
    reminderDateTime: "2026-12-01T10:54:00.000Z",
    reminderKind: REMINDER_KINDS.BILLING, templateName: "Penagihan.txt",
    message: DEFAULT_REMINDER_MESSAGE_TEMPLATE,
  });
  await manager.repairMissingRecurringReminders();
  const migrated = manager.getReminder("stale-reminder");
  assert.equal(migrated.reminderDateTime, expiry);
  assert.equal(migrated.reminderKind, REMINDER_KINDS.ACTIVE_PERIOD_EXPIRY);
  assert.equal(migrated.templateName, "PaketPrabayar");
  assert.equal(saves, 1);
  assert.equal(await manager.repairMissingRecurringReminders(), 0);
  assert.equal(saves, 1);
});

test("reminder tagihan lama pelanggan prabayar dimigrasikan menjadi pengingat paket", async () => {
  const activeUntil = "2026-11-28T16:59:59.999Z";
  const contact = {
    id: "contact-prepaid-reminder-migration",
    name: "Pelanggan Prabayar",
    phoneNumber: "6281234567805",
    createdAt: "2026-10-28T17:00:00.000Z",
    subscriptionType: SUBSCRIPTION_TYPES.RECURRING,
    billingCycle: BILLING_CYCLES.PREPAID,
    monthlyPaymentAmount: 75_000,
    paymentStatus: PAYMENT_STATUS.PAID,
    paymentMonths: {},
    hotspotReactivationEnabled: true,
    hotspotReactivationAt: activeUntil,
    activePeriodPurchases: [{
      purchasedAt: "2026-10-28T17:00:00.000Z",
      activeUntil,
      status: PAYMENT_STATUS.PAID,
    }],
  };
  const manager = createManager(contact);
  manager.settings.hotspotIsolationGraceDays = 3;
  let saves = 0;
  manager.saveReminders = async () => { saves += 1; };
  manager.reminders.set("legacy-prepaid-billing", {
    id: "legacy-prepaid-billing",
    contactId: contact.id,
    contactName: contact.name,
    phoneNumber: contact.phoneNumber,
    reminderDateTime: activeUntil,
    reminderKind: REMINDER_KINDS.GRACE_PERIOD,
    message: DEFAULT_SETTINGS.gracePeriodReminderMessageTemplate,
    messageSource: DEFAULT_SETTINGS.gracePeriodReminderMessageTemplate,
    templateName: "Penagihan.txt",
    gracePeriodCreatedAt: "2026-11-28T17:00:00.000Z",
  });

  assert.equal(await manager.repairMissingRecurringReminders(), 0);

  const reminder = manager.getReminder("legacy-prepaid-billing");
  assert.equal(reminder.reminderKind, REMINDER_KINDS.ACTIVE_PERIOD_EXPIRY);
  assert.equal(reminder.reminderDateTime, activeUntil);
  assert.equal(reminder.activePeriodUntil, activeUntil);
  assert.equal(reminder.templateName, "PaketPrabayar");
  assert.equal(reminder.message, DEFAULT_SETTINGS.prepaidPackageReminderMessageTemplate);
  assert.equal(reminder.messageSource, DEFAULT_SETTINGS.prepaidPackageReminderMessageTemplate);
  assert.equal(Object.hasOwn(reminder, "gracePeriodCreatedAt"), false);
  assert.equal(saves, 1);

  assert.equal(await manager.repairMissingRecurringReminders(), 0);
  assert.equal(saves, 1);
});

test("audit startup menyelaraskan jatuh tempo reminder paket dengan tanggal layanan", async () => {
  const expiry = "2026-12-10T01:00:00.000Z";
  const contact = {
    id: "contact-active-period-reminder", name: "Pelanggan Paket",
    phoneNumber: "6281234567804", subscriptionType: SUBSCRIPTION_TYPES.RECURRING,
    billingCycle: BILLING_CYCLES.PREPAID, monthlyPaymentAmount: 75_000,
    hotspotReactivationAt: expiry,
  };
  const manager = createManager(contact);
  manager.reminders.set("active-period-reminder", {
    id: "active-period-reminder", contactId: contact.id, phoneNumber: contact.phoneNumber,
    reminderDateTime: "2026-12-07T01:00:00.000Z",
    reminderKind: REMINDER_KINDS.ACTIVE_PERIOD_EXPIRY,
    templateName: "PaketPrabayar", activePeriodUntil: expiry,
  });
  await manager.repairMissingRecurringReminders();
  assert.equal(manager.getReminder("active-period-reminder").reminderDateTime, expiry);
  assert.equal(manager.getReminder("active-period-reminder").reminderKind, REMINDER_KINDS.ACTIVE_PERIOD_EXPIRY);
  assert.equal(manager.reminders.size, 1);
});

test("reminder jatuh tempo berlanjut ke pengingat masa tenggang H-1", async () => {
  const manager = createManager({
    id: "contact-grace-reminder",
    name: "Pelanggan Tenggang",
    phoneNumber: "6281234567804",
    subscriptionType: SUBSCRIPTION_TYPES.RECURRING,
  });
  manager.settings.hotspotIsolationGraceDays = 3;
  manager.settings.timezone = "Asia/Jakarta";
  manager.reminders.set("grace-reminder", {
    id: "grace-reminder",
    contactId: "contact-grace-reminder",
    reminderDateTime: "2026-11-02T01:00:00.000Z",
    reminderKind: REMINDER_KINDS.BILLING,
    templateName: "Penagihan.txt",
  });

  const reminder = manager.getSortedReminders()[0];
  assert.equal(reminder.reminderDateTime, "2026-11-02T01:00:00.000Z");
  assert.equal(reminder.deliveryDateTime, "2026-11-02T01:00:00.000Z");
  assert.equal(reminder.deliveryScheduleType, "BILLING_DUE");
  assert.equal(manager.hydrateReminder({
    reminderDateTime: "2026-11-02T01:00:00.000Z",
  }).deliveryScheduleType, "STANDARD");
  assert.equal(manager.hydrateReminder({
    reminderDateTime: "2026-11-02T01:00:00.000Z",
    reminderKind: REMINDER_KINDS.BILLING,
    nextDeliveryAttemptAt: "2026-11-04T02:00:00.000Z",
  }).deliveryScheduleType, "RETRY");
  const transition = await manager.moveToGracePeriod(reminder.id, {
    sentAt: "2026-11-02T01:00:00.000Z",
    deliveryStatus: "SENT_BAILEYS",
    message: "Pengingat jatuh tempo",
  });
  assert.equal(transition.sentReminder.message, "Pengingat jatuh tempo");
  assert.equal(manager.sentReminders.size, 1);
  assert.equal(transition.reminder.reminderKind, REMINDER_KINDS.GRACE_PERIOD);
  assert.equal(transition.reminder.reminderDateTime, "2026-11-02T01:00:00.000Z");
  assert.equal(transition.reminder.deliveryDateTime, "2026-11-04T01:00:00.000Z");
  assert.equal(transition.reminder.deliveryScheduleType, "GRACE_PERIOD");
  assert.equal(await manager.claimDueReminder(reminder.id, new Date("2026-11-04T00:59:59.000Z")), null);
  assert.equal(
    (await manager.claimDueReminder(reminder.id, new Date("2026-11-04T01:00:00.000Z"))).id,
    reminder.id
  );

  delete manager.getReminder(reminder.id).processingAt;
  manager.getContact("contact-grace-reminder").hotspotReactivationAt = "2026-12-02T01:00:00.000Z";
  manager.isReminderSuppressedForArrears = () => false;
  assert.ok(manager.syncRecurringReminderSchedule(manager.getContact("contact-grace-reminder")) > 0);
  const nextBillingReminder = manager.getSortedReminders()[0];
  assert.equal(nextBillingReminder.reminderKind, REMINDER_KINDS.BILLING);
  assert.equal(nextBillingReminder.reminderDateTime, "2026-12-02T01:00:00.000Z");
  assert.equal(nextBillingReminder.deliveryDateTime, "2026-12-02T01:00:00.000Z");
  assert.equal(nextBillingReminder.deliveryScheduleType, "BILLING_DUE");
});

test("reminder paket prabayar dikirim saat jatuh tempo lalu H-1 masa tenggang", async () => {
  const activeUntil = "2026-11-10T12:08:22.960Z";
  const contact = {
    id: "contact-prepaid-grace-reminder",
    name: "Pelanggan Paket",
    phoneNumber: "6281234567806",
    subscriptionType: SUBSCRIPTION_TYPES.RECURRING,
    billingCycle: BILLING_CYCLES.PREPAID,
    monthlyPaymentAmount: 100_000,
    hotspotReactivationEnabled: true,
    hotspotReactivationAt: activeUntil,
    activePeriodPurchases: [{
      id: "purchase-prepaid-grace",
      purchasedAt: "2026-10-10T12:08:22.960Z",
      activeUntil,
    }],
  };
  const manager = createManager(contact);
  manager.settings.hotspotIsolationGraceDays = 3;
  manager.settings.timezone = "Asia/Jakarta";

  const synced = manager.syncActivePeriodExpiryReminder(contact, contact.activePeriodPurchases[0]);
  assert.equal(synced.reminder.reminderDateTime, activeUntil);
  assert.equal(manager.hydrateReminder(synced.reminder).deliveryDateTime, activeUntil);

  const transition = await manager.moveToGracePeriod(synced.reminder.id, {
    sentAt: activeUntil,
    deliveryStatus: "SENT_BAILEYS",
    message: "Pengingat paket jatuh tempo",
  });
  assert.equal(transition.reminder.reminderKind, REMINDER_KINDS.ACTIVE_PERIOD_EXPIRY);
  assert.ok(transition.reminder.gracePeriodCreatedAt);
  assert.equal(transition.reminder.deliveryDateTime, "2026-11-12T12:08:22.960Z");
  assert.equal(transition.reminder.deliveryScheduleType, "GRACE_PERIOD");

  manager.syncRecurringReminderSchedule(contact);
  const preserved = manager.getReminder(synced.reminder.id);
  assert.ok(preserved.gracePeriodCreatedAt);
  assert.equal(manager.hydrateReminder(preserved).deliveryDateTime, "2026-11-12T12:08:22.960Z");
});

test("jadwal reminder dihapus dan tidak dapat dibuat saat tunggakan mencapai dua bulan", async () => {
  const current = getBillingPeriodParts(new Date(), "Asia/Jakarta");
  const previous = getPreviousBillingPeriod(current.year, current.month);
  const older = getPreviousBillingPeriod(previous.year, previous.month);
  const previousKey = makeBillingPeriodKey(previous.year, previous.month);
  const olderKey = makeBillingPeriodKey(older.year, older.month);
  const contact = {
    id: "contact-reminder-suppressed",
    name: "Pelanggan Dua Tunggakan",
    phoneNumber: "6281234567805",
    createdAt: `${olderKey}-01T00:00:00.000Z`,
    subscriptionType: SUBSCRIPTION_TYPES.RECURRING,
    monthlyPaymentAmount: 100_000,
    paymentStatus: PAYMENT_STATUS.UNPAID,
    paymentMonths: {
      [olderKey]: { status: PAYMENT_STATUS.UNPAID, paidAmount: 0 },
      [previousKey]: { status: PAYMENT_STATUS.UNPAID, paidAmount: 0 },
    },
    hotspotReactivationAt: new Date(Date.now() + 86_400_000).toISOString(),
  };
  const manager = createManager(contact);
  manager.reminders.set("suppressed-reminder", {
    id: "suppressed-reminder",
    contactId: contact.id,
    phoneNumber: contact.phoneNumber,
    reminderDateTime: new Date(Date.now() + 86_400_000).toISOString(),
    message: "Pengingat tagihan",
  });
  let saves = 0;
  manager.saveReminders = async () => { saves += 1; };

  assert.equal(await manager.repairMissingRecurringReminders(), 0);
  assert.equal(manager.reminders.size, 0);
  assert.equal(saves, 1);
  await assert.rejects(
    () => manager.addReminder({
      contactId: contact.id,
      reminderDateTime: new Date(Date.now() + 86_400_000),
      message: "Pengingat baru",
    }),
    /2 tunggakan atau lebih/
  );

  contact.paymentMonths[olderKey] = { status: PAYMENT_STATUS.PAID, paidAmount: 100_000 };
  assert.equal(manager.updateContactReminderMessages(contact), 1);
  assert.equal(manager.reminders.size, 1);
});

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
  const existingDueDate = addDaysSafely(new Date(), 7, "Asia/Jakarta").toISOString();
  const contact = {
    id: "contact-1",
    name: "Pelanggan",
    phoneNumber: "6281234567890",
    createdAt: "2026-04-01T00:00:00.000Z",
    paymentStatus: PAYMENT_STATUS.UNPAID,
    paymentDate: null,
    paymentType: null,
    paymentMonths: {},
    hotspotReactivationEnabled: true,
    hotspotReactivationAt: existingDueDate,
  };
  const manager = createManager(contact);

  const updated = await manager.updatePaymentStatus(
    contact.id,
    PAYMENT_STATUS.UNPAID,
    PAYMENT_TYPES.ARREARS_ONLY
  );

  assert.equal(updated.paymentStatus, PAYMENT_STATUS.UNPAID);
  assert.equal(updated.hotspotReactivationAt, existingDueDate);
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

test("data sekali berlangganan lama otomatis menjadi prabayar tanpa menghidupkan paket kedaluwarsa", async () => {
  const manager = new DataManager({ push() {} });
  manager.sequelize = { transaction: async (operation) => operation({}) };
  manager.withDatabaseWrite = async (operation) => operation();
  manager.saveContacts = async () => {};
  manager.saveSettings = async () => {};

  manager.contacts.set("legacy-active", {
    id: "legacy-active",
    name: "Pelanggan Lama Aktif",
    phoneNumber: "6281234567001",
    createdAt: "2026-10-01T00:00:00.000Z",
    subscriptionType: SUBSCRIPTION_TYPES.ONE_TIME,
    monthlyPaymentAmount: 50_000,
    paymentStatus: PAYMENT_STATUS.PAID,
    paymentDate: "2026-10-20T00:00:00.000Z",
    paymentType: PAYMENT_TYPES.CURRENT_ONLY,
    paymentMonths: {
      "2026-10": {
        status: PAYMENT_STATUS.PAID,
        paidDate: "2026-10-20T00:00:00.000Z",
        paymentType: PAYMENT_TYPES.CURRENT_ONLY,
      },
    },
    hotspotReactivationEnabled: false,
    hotspotReactivationAt: "2026-12-01T00:00:00.000Z",
  });
  manager.contacts.set("legacy-expired", {
    id: "legacy-expired",
    name: "Pelanggan Lama Kedaluwarsa",
    phoneNumber: "6281234567002",
    createdAt: "2026-09-01T00:00:00.000Z",
    subscriptionType: SUBSCRIPTION_TYPES.ONE_TIME,
    monthlyPaymentAmount: 75_000,
    paymentStatus: PAYMENT_STATUS.PAID,
    paymentDate: "2026-09-01T00:00:00.000Z",
    paymentType: PAYMENT_TYPES.CURRENT_ONLY,
    paymentMonths: {
      "2026-09": {
        status: PAYMENT_STATUS.PAID,
        paidDate: "2026-09-01T00:00:00.000Z",
        paymentType: PAYMENT_TYPES.CURRENT_ONLY,
      },
    },
    hotspotReactivationEnabled: false,
    hotspotReactivationAt: "2026-10-01T00:00:00.000Z",
  });

  manager.normalizeLoadedContacts();
  const migrated = await manager.migrateOneTimeSubscriptionsToPrepaid({
    now: "2026-11-04T00:00:00.000Z",
    save: false,
  });

  const active = manager.getContact("legacy-active");
  const expired = manager.getContact("legacy-expired");
  assert.deepEqual(migrated, { migrated: 2, purchasesMigrated: 2 });
  assert.equal(active.subscriptionType, SUBSCRIPTION_TYPES.RECURRING);
  assert.equal(active.billingCycle, BILLING_CYCLES.PREPAID);
  assert.equal(active.hotspotReactivationEnabled, true);
  assert.equal(active.hotspotReactivationAt, "2026-12-01T00:00:00.000Z");
  assert.equal(active.paymentStatus, PAYMENT_STATUS.PAID);
  assert.equal(active.paymentType, PAYMENT_TYPES.ACTIVE_PERIOD);
  assert.equal(active.activePeriodPurchases[0].paymentProvider, "migration");
  assert.equal(expired.subscriptionType, SUBSCRIPTION_TYPES.RECURRING);
  assert.equal(expired.billingCycle, BILLING_CYCLES.PREPAID);
  assert.equal(expired.hotspotReactivationEnabled, false);
  assert.equal(expired.hotspotReactivationAt, null);
  assert.equal(expired.paymentStatus, PAYMENT_STATUS.UNPAID);
  assert.equal(expired.activePeriodPurchases[0].activeUntil, "2026-10-01T00:00:00.000Z");

  const scheduleMigration = await manager.migrateServiceSchedulesFromRegistration({
    now: "2026-11-04T00:00:00.000Z",
  });
  assert.equal(scheduleMigration.migrated, 0);
  assert.equal(scheduleMigration.skipped, 2);
  assert.equal(expired.hotspotReactivationAt, null);

  const repeated = await manager.migrateOneTimeSubscriptionsToPrepaid({
    now: "2026-11-04T00:00:00.000Z",
    save: false,
  });
  assert.deepEqual(repeated, { migrated: 0, purchasesMigrated: 0 });
});

test("pelanggan prabayar tidak menghasilkan tunggakan dari bulan lampau", () => {
  const contact = {
    id: "contact-recurring", name: "Pelanggan Bulanan",
    createdAt: "2026-07-10T00:00:00.000Z",
    subscriptionType: SUBSCRIPTION_TYPES.RECURRING, billingCycle: BILLING_CYCLES.PREPAID,
    paymentStatus: PAYMENT_STATUS.UNPAID, paymentMonths: {},
  };
  const info = createManager(contact).buildDebtInfo(contact, { year: 2026, month: 8 });
  assert.equal(info.debtCount, 0);
  assert.equal(info.debtAmount, 0);
  assert.deepEqual(info.debtPeriods, []);
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

test("konversi otomatis lama dipulihkan tanpa membuat reminder untuk dua tunggakan", () => {
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
  assert.equal(manager.reminders.size, 0);
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

test("pembayaran lunas memindahkan reminder ke jatuh tempo berikutnya", async () => {
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
  const previousReminderTime = new Date(reminder.reminderDateTime).getTime();

  await manager.updatePaymentStatus(contact.id, PAYMENT_STATUS.PAID, PAYMENT_TYPES.FULL_PAID);
  const nextReminderTime = new Date(reminder.reminderDateTime).getTime();
  assert.equal(nextReminderTime > previousReminderTime, true);
  assert.match(reminder.message, /Rp\s?100\.000/);
  assert.match(reminder.message, /belum kami terima/);

  await manager.updatePaymentStatus(contact.id, PAYMENT_STATUS.UNPAID);
  const current = getBillingPeriodParts(new Date(), manager.getTimezone());
  const currentKey = makeBillingPeriodKey(current.year, current.month);
  assert.equal(new Date(reminder.reminderDateTime).getTime(), nextReminderTime);
  assert.match(reminder.message, /Rp\s?200\.000/);
  assert.match(reminder.message, /belum kami terima/);
  assert.equal(contact.paymentMonths[currentKey].status, PAYMENT_STATUS.UNPAID);
  assert.equal(contact.paymentMonths[currentKey].paidAmount, 0);
  assert.equal(
    manager.getPaymentRemainingAmount(contact.paymentMonths[currentKey], contact.monthlyPaymentAmount),
    contact.monthlyPaymentAmount
  );
});

test("koreksi periode lama tetap menjadi tunggakan setelah pembayaran lunas semua", async () => {
  const now = new Date();
  const current = getBillingPeriodParts(now, "Asia/Jakarta");
  const previous = getPreviousBillingPeriod(current.year, current.month);
  const previousKey = makeBillingPeriodKey(previous.year, previous.month);
  const contact = {
    id: "contact-corrected-old-debt",
    name: "Pelanggan Koreksi",
    phoneNumber: "6281234567897",
    createdAt: addMonthsSafely(now, -1, "Asia/Jakarta").toISOString(),
    subscriptionType: SUBSCRIPTION_TYPES.RECURRING,
    monthlyPaymentAmount: 100_000,
    paymentStatus: PAYMENT_STATUS.UNPAID,
    paymentDate: null,
    paymentType: null,
    paymentMonths: {},
  };
  const manager = createManager(contact);

  await manager.updatePaymentStatus(contact.id, PAYMENT_STATUS.PAID, PAYMENT_TYPES.FULL_PAID);
  await manager.setPaymentForMonth(
    contact.id,
    previous.year,
    previous.month,
    PAYMENT_STATUS.UNPAID
  );

  const debtInfo = manager.buildDebtInfo(contact);
  assert.equal(contact.paymentType, PAYMENT_TYPES.FULL_PAID);
  assert.equal(debtInfo.hasDebt, true);
  assert.deepEqual(debtInfo.debtPeriods.map((period) => period.key), [previousKey]);
  assert.equal(debtInfo.debtAmount, contact.monthlyPaymentAmount);
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
  assert.match(reminder.message, /{{billingDetails}}/);
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

test("permintaan mengubah pelanggan menjadi sekali berlangganan tetap memakai bulanan prabayar", async () => {
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

  assert.equal(updated.subscriptionType, SUBSCRIPTION_TYPES.RECURRING);
  assert.equal(updated.billingCycle, BILLING_CYCLES.PREPAID);
  assert.equal(manager.reminders.size, 0);
  assert.equal(reminderSaves, 1);
});

test("konversi pelanggan sekali ke pascabayar mempertahankan periode yang belum dibayar", async () => {
  const now = new Date();
  const current = getBillingPeriodParts(now, "Asia/Jakarta");
  const previous = getPreviousBillingPeriod(current.year, current.month);
  const older = getPreviousBillingPeriod(previous.year, previous.month);
  const currentKey = makeBillingPeriodKey(current.year, current.month);
  const previousKey = makeBillingPeriodKey(previous.year, previous.month);
  const olderKey = makeBillingPeriodKey(older.year, older.month);
  const contact = {
    id: "contact-one-time-to-recurring",
    name: "Pelanggan Konversi",
    phoneNumber: "6281234567892",
    createdAt: `${olderKey}-01T00:00:00.000Z`,
    subscriptionType: SUBSCRIPTION_TYPES.ONE_TIME,
    monthlyPaymentAmount: 75_000,
    paymentStatus: PAYMENT_STATUS.PAID,
    paymentDate: `${olderKey}-01T00:00:00.000Z`,
    paymentType: PAYMENT_TYPES.FULL_PAID,
    paymentMonths: {
      [olderKey]: { status: PAYMENT_STATUS.PAID, paidAmount: 75_000 },
      [previousKey]: { status: PAYMENT_STATUS.UNPAID, paidAmount: 0 },
    },
    hotspotReactivationEnabled: false,
    hotspotReactivationAt: null,
  };
  const manager = createManager(contact);

  const converted = await manager.updateContact(contact.id, {
    subscriptionType: SUBSCRIPTION_TYPES.RECURRING,
    billingCycle: BILLING_CYCLES.POSTPAID,
  });

  assert.equal(converted.subscriptionType, SUBSCRIPTION_TYPES.RECURRING);
  assert.equal(converted.paymentStatus, PAYMENT_STATUS.UNPAID);
  assert.equal(converted.paymentMonths[currentKey].status, PAYMENT_STATUS.UNPAID);
  assert.equal(converted.paymentMonths[currentKey].paidAmount, 0);
  assert.equal(converted.hotspotReactivationAt, null);
  assert.equal(converted.hotspotReactivationEnabled, false);
  assert.equal(converted.paymentMonths[previousKey].status, PAYMENT_STATUS.UNPAID);
  assert.equal(manager.buildDebtInfo(contact).billingPeriodKey, previousKey);
  assert.equal(manager.buildDebtInfo(contact).debtCount, 0);

  const paid = await manager.updatePaymentStatus(
    contact.id,
    PAYMENT_STATUS.PAID,
    PAYMENT_TYPES.CURRENT_ONLY
  );
  assert.equal(paid.paymentMonths[previousKey].status, PAYMENT_STATUS.PAID);
  assert.equal(paid.paymentMonths[previousKey].paidAmount, 75_000);
  assert.equal(paid.paymentMonths[currentKey].status, PAYMENT_STATUS.UNPAID);
  assert.ok(new Date(paid.hotspotReactivationAt).getTime() > Date.now());
  assert.equal(paid.hotspotReactivationEnabled, true);
  assert.equal(paid.serviceActiveUntil, paid.hotspotReactivationAt);
  assert.equal(manager.buildDebtInfo(contact).debtCount, 0);
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
  assert.match(reminder.message, /Pengingat Pembayaran WiFi/);
});

test("pembayaran tanpa nominal tetap memindahkan reminder ke periode berikutnya", async () => {
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
  const previousReminderTime = new Date(reminder.reminderDateTime).getTime();

  await manager.updatePaymentStatus(contact.id, PAYMENT_STATUS.PAID, PAYMENT_TYPES.FULL_PAID);

  assert.equal(new Date(reminder.reminderDateTime).getTime() > previousReminderTime, true);
  assert.equal(reminder.message, "Tagihan internet Anda belum kami terima.");
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

test("pembelian masa aktif mengaktifkan hotspot satu bulan tanpa mengurangi tunggakan", async () => {
  const purchasedAt = new Date();
  const current = getBillingPeriodParts(purchasedAt);
  const previous = getPreviousBillingPeriod(current.year, current.month);
  const debtKey = makeBillingPeriodKey(previous.year, previous.month);
  const activeUntil = addMonthsSafely(purchasedAt, 1, "Asia/Jakarta");
  const contact = {
    id: "contact-active-period-purchase",
    name: "Pelanggan Masa Aktif",
    phoneNumber: "6281234567815",
    subscriptionType: SUBSCRIPTION_TYPES.RECURRING,
    createdAt: `${debtKey}-01T00:00:00.000Z`,
    monthlyPaymentAmount: 100000,
    paymentStatus: PAYMENT_STATUS.PAID,
    paymentMonths: {
      [debtKey]: { status: PAYMENT_STATUS.UNPAID, paidAmount: 0 },
    },
    billingPausedForArrears: false,
    billingPausedAfterPeriod: null,
    hotspotSuspendedForArrears: true,
    hotspotReactivationEnabled: false,
    hotspotReactivationAt: null,
    mikrotikUsername: "active_period",
    mikrotikProfile: "default",
  };
  const manager = createManager(contact);
  manager.settings.hotspotIsolationGraceDays = 3;

  const updated = await manager.markHotspotEnabled(contact.id, {}, {
    at: purchasedAt,
    activePeriodPurchase: {
      id: "ACT-TEST-1",
      purchasedAt,
      activeFrom: purchasedAt,
      activeUntil,
    },
  });

  assert.equal(updated.hotspotProvisioningStatus, "ACTIVE");
  assert.equal(updated.hotspotManualActivationWithArrears, true);
  assert.equal(updated.hotspotReactivationEnabled, false);
  assert.equal(updated.hotspotReactivationAt, activeUntil.toISOString());
  assert.equal(updated.billingPausedForArrears, true);
  assert.equal(updated.debtAmount, 100000);
  assert.equal(updated.activePeriodPurchases.length, 1);
  assert.equal(updated.activePeriodPurchases[0].amount, 100000);
  assert.equal(updated.activePeriodPurchases[0].paymentType, PAYMENT_TYPES.ACTIVE_PERIOD);
  assert.equal(contact.paymentMonths[debtKey].status, PAYMENT_STATUS.UNPAID);
  const expiryReminder = manager.getSortedReminders()[0];
  assert.equal(expiryReminder.reminderKind, REMINDER_KINDS.ACTIVE_PERIOD_EXPIRY);
  assert.equal(expiryReminder.activePeriodUntil, activeUntil.toISOString());
  assert.equal(
    expiryReminder.reminderDateTime,
    activeUntil.toISOString()
  );
  manager.customerAccounts.set(contact.id, { username: "active_period", password: "portal-pass" });
  const portal = manager.getCustomerPortalData(contact.id);
  const purchaseHistory = portal.billing.history.find((item) => item.paymentType === PAYMENT_TYPES.ACTIVE_PERIOD);
  assert.equal(purchaseHistory.paidAmount, 100000);
  assert.equal(purchaseHistory.activeUntil, activeUntil.toISOString());
});

test("pembelian masa aktif berikutnya memperpanjang jadwal dari batas aktif terakhir", async () => {
  const purchasedAt = new Date();
  const current = getBillingPeriodParts(purchasedAt);
  const previous = getPreviousBillingPeriod(current.year, current.month);
  const debtKey = makeBillingPeriodKey(previous.year, previous.month);
  const firstActiveUntil = addMonthsSafely(purchasedAt, 1, "Asia/Jakarta");
  const secondActiveUntil = addMonthsSafely(firstActiveUntil, 1, "Asia/Jakarta");
  const contact = {
    id: "contact-active-period-extension",
    name: "Pelanggan Perpanjangan Masa Aktif",
    phoneNumber: "6281234567816",
    subscriptionType: SUBSCRIPTION_TYPES.RECURRING,
    createdAt: `${debtKey}-01T00:00:00.000Z`,
    monthlyPaymentAmount: 100000,
    paymentStatus: PAYMENT_STATUS.PAID,
    paymentMonths: {
      [debtKey]: { status: PAYMENT_STATUS.UNPAID, paidAmount: 0 },
    },
    billingPausedForArrears: true,
    billingPausedAfterPeriod: debtKey,
    hotspotManualActivationWithArrears: true,
    hotspotProvisioningStatus: "ACTIVE",
    hotspotReactivationEnabled: false,
    hotspotReactivationAt: firstActiveUntil.toISOString(),
    activePeriodPurchases: [{
      id: "ACT-TEST-1",
      paymentType: PAYMENT_TYPES.ACTIVE_PERIOD,
      status: PAYMENT_STATUS.PAID,
      amount: 100000,
      purchasedAt: purchasedAt.toISOString(),
      activeFrom: purchasedAt.toISOString(),
      activeUntil: firstActiveUntil.toISOString(),
      paymentProvider: "manual",
    }],
  };
  const manager = createManager(contact);
  manager.settings.hotspotIsolationGraceDays = 3;
  manager.reminders.set("active-period-reminder", {
    id: "active-period-reminder",
    contactId: contact.id,
    contactName: contact.name,
    phoneNumber: contact.phoneNumber,
    reminderDateTime: firstActiveUntil.toISOString(),
    reminderKind: REMINDER_KINDS.ACTIVE_PERIOD_EXPIRY,
    activePeriodUntil: firstActiveUntil.toISOString(),
    message: manager.settings.activePeriodReminderMessageTemplate,
    messageSource: manager.settings.activePeriodReminderMessageTemplate,
  });

  const result = await manager.recordActivePeriodPurchase(contact.id, {
    id: "ACT-TEST-2",
    purchasedAt,
    activeFrom: firstActiveUntil,
    activeUntil: secondActiveUntil,
  });

  assert.equal(result.contact.activePeriodPurchases.length, 2);
  assert.equal(result.contact.hotspotReactivationAt, secondActiveUntil.toISOString());
  assert.equal(result.contact.debtAmount, 100000);
  assert.equal(contact.paymentMonths[debtKey].status, PAYMENT_STATUS.UNPAID);
  const expiryReminder = manager.getReminder("active-period-reminder");
  assert.equal(expiryReminder.activePeriodUntil, secondActiveUntil.toISOString());
  assert.equal(
    expiryReminder.reminderDateTime,
    secondActiveUntil.toISOString()
  );
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
  const activeUntil = addMonthsSafely(new Date(), 1, "Asia/Jakarta");
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
    hotspotManualActivationWithArrears: true,
    hotspotProvisioningStatus: "ACTIVE",
    hotspotReactivationEnabled: false,
    hotspotReactivationAt: activeUntil.toISOString(),
  };
  const manager = createManager(contact);
  manager.reminders.set("active-period-reminder-paid", {
    id: "active-period-reminder-paid",
    contactId: contact.id,
    contactName: contact.name,
    phoneNumber: contact.phoneNumber,
    reminderDateTime: addDaysSafely(activeUntil, -3, "Asia/Jakarta").toISOString(),
    reminderKind: REMINDER_KINDS.ACTIVE_PERIOD_EXPIRY,
    activePeriodUntil: activeUntil.toISOString(),
    message: manager.settings.activePeriodReminderMessageTemplate,
    messageSource: manager.settings.activePeriodReminderMessageTemplate,
  });

  const partial = await manager.updatePaymentStatus(
    contact.id,
    PAYMENT_STATUS.UNPAID,
    PAYMENT_TYPES.ARREARS_ONLY,
    50000
  );
  assert.equal(partial.billingPausedForArrears, true);
  assert.equal(partial.hotspotReactivationEnabled, false);
  assert.equal(partial.debtAmount, 50000);
  assert.equal(manager.getReminder("active-period-reminder-paid").reminderKind, REMINDER_KINDS.ACTIVE_PERIOD_EXPIRY);

  const paid = await manager.updatePaymentStatus(
    contact.id,
    PAYMENT_STATUS.UNPAID,
    PAYMENT_TYPES.ARREARS_ONLY,
    50000
  );
  assert.equal(paid.hasDebt, false);
  assert.equal(paid.billingPausedForArrears, false);
  assert.equal(paid.hotspotReactivationEnabled, true);
  assert.equal(paid.hotspotReactivationAt, activeUntil.toISOString());
  assert.equal(paid.hotspotSuspendedForArrears, true);
  const restoredReminder = manager.getReminder("active-period-reminder-paid");
  assert.equal(restoredReminder.reminderKind, REMINDER_KINDS.BILLING);
  assert.equal(restoredReminder.reminderDateTime, activeUntil.toISOString());
  assert.equal(restoredReminder.activePeriodUntil, undefined);
  assert.equal(restoredReminder.templateName, "Penagihan.txt");
});

test("pembayaran tunggakan terakhir memindahkan reminder biasa ke jadwal masa aktif baru", async () => {
  const paidAt = new Date();
  const current = getBillingPeriodParts(paidAt, "Asia/Jakarta");
  const previous = getPreviousBillingPeriod(current.year, current.month);
  const previousKey = makeBillingPeriodKey(previous.year, previous.month);
  const expiredSchedule = addDaysSafely(paidAt, -3, "Asia/Jakarta");
  const oldReminderDate = addMonthsSafely(expiredSchedule, 1, "Asia/Jakarta");
  const contact = {
    id: "contact-last-arrears-reminder-sync",
    name: "Pelanggan Tunggakan Terakhir",
    phoneNumber: "6281234567830",
    createdAt: `${previousKey}-01T00:00:00.000Z`,
    subscriptionType: SUBSCRIPTION_TYPES.RECURRING,
    monthlyPaymentAmount: 75_000,
    paymentStatus: PAYMENT_STATUS.PAID,
    paymentMonths: {
      [previousKey]: { status: PAYMENT_STATUS.UNPAID, paidAmount: 0 },
    },
    billingPausedForArrears: true,
    billingPausedAfterPeriod: previousKey,
    hotspotReactivationEnabled: false,
    hotspotReactivationAt: expiredSchedule.toISOString(),
  };
  const manager = createManager(contact);
  manager.reminders.set("last-arrears-reminder", {
    id: "last-arrears-reminder",
    contactId: contact.id,
    phoneNumber: contact.phoneNumber,
    reminderDateTime: oldReminderDate.toISOString(),
    reminderKind: REMINDER_KINDS.BILLING,
    message: DEFAULT_REMINDER_MESSAGE_TEMPLATE,
    messageSource: DEFAULT_REMINDER_MESSAGE_TEMPLATE,
    templateName: "Penagihan.txt",
  });

  const paid = await manager.updatePaymentStatus(
    contact.id,
    PAYMENT_STATUS.UNPAID,
    PAYMENT_TYPES.ARREARS_ONLY,
    75_000
  );

  assert.equal(paid.hasDebt, false);
  assert.equal(paid.billingPausedForArrears, false);
  assert.equal(paid.hotspotReactivationEnabled, true);
  assert.equal(new Date(paid.hotspotReactivationAt).getTime() > paidAt.getTime(), true);
  assert.equal(
    manager.getReminder("last-arrears-reminder").reminderDateTime,
    paid.hotspotReactivationAt
  );
});

test("pencatatan pembayaran periode yang sama tidak menambah masa aktif dua kali", async () => {
  const now = new Date();
  const current = getBillingPeriodParts(now, "Asia/Jakarta");
  const currentKey = makeBillingPeriodKey(current.year, current.month);
  const previousDueDate = addDaysSafely(now, 10, "Asia/Jakarta");
  const contact = {
    id: "contact-duplicate-current-payment",
    name: "Pelanggan Pembayaran Ganda",
    phoneNumber: "6281234567831",
    createdAt: now.toISOString(),
    subscriptionType: SUBSCRIPTION_TYPES.RECURRING,
    monthlyPaymentAmount: 75_000,
    paymentStatus: PAYMENT_STATUS.UNPAID,
    paymentMonths: {
      [currentKey]: { status: PAYMENT_STATUS.UNPAID, paidAmount: 0 },
    },
    hotspotReactivationEnabled: true,
    hotspotReactivationAt: previousDueDate.toISOString(),
  };
  const manager = createManager(contact);
  manager.reminders.set("duplicate-payment-reminder", {
    id: "duplicate-payment-reminder",
    contactId: contact.id,
    phoneNumber: contact.phoneNumber,
    reminderDateTime: previousDueDate.toISOString(),
    reminderKind: REMINDER_KINDS.BILLING,
    message: DEFAULT_REMINDER_MESSAGE_TEMPLATE,
    messageSource: DEFAULT_REMINDER_MESSAGE_TEMPLATE,
    templateName: "Penagihan.txt",
  });

  const first = await manager.updatePaymentStatus(
    contact.id,
    PAYMENT_STATUS.PAID,
    PAYMENT_TYPES.CURRENT_ONLY
  );
  const firstPaidDate = contact.paymentMonths[currentKey].paidDate;
  const expectedDueDate = addMonthsSafely(firstPaidDate, 1, "Asia/Jakarta");
  const duplicate = await manager.setPaymentForMonth(
    contact.id,
    current.year,
    current.month,
    PAYMENT_STATUS.PAID,
    PAYMENT_TYPES.CURRENT_ONLY
  );

  assert.equal(first.paymentRecorded, true);
  assert.equal(duplicate.paymentRecorded, false);
  assert.equal(contact.paymentMonths[currentKey].paidDate, firstPaidDate);
  assert.equal(contact.hotspotReactivationAt, expectedDueDate.toISOString());
  assert.equal(
    manager.getReminder("duplicate-payment-reminder").reminderDateTime,
    expectedDueDate.toISOString()
  );
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
    billingCycle: BILLING_CYCLES.POSTPAID,
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

test("menunda penonaktifan paket prabayar sampai masa tenggang selesai", async () => {
  const contact = {
    id: "contact-prepaid-isolation-grace",
    name: "Pelanggan Paket Tenggang",
    phoneNumber: "6281234567809",
    subscriptionType: SUBSCRIPTION_TYPES.RECURRING,
    billingCycle: BILLING_CYCLES.PREPAID,
    mikrotikUsername: "pelanggan_paket_grace",
    mikrotikProfile: "default",
    hotspotReactivationEnabled: true,
    hotspotReactivationAt: "2026-11-10T12:08:22.960Z",
  };
  const manager = createManager(contact);
  await manager.updateSettings({ hotspotIsolationGraceDays: 3 });

  assert.equal(
    manager.getDueHotspotReactivationContacts(new Date("2026-11-13T12:08:22.959Z")).length,
    0
  );
  assert.deepEqual(
    manager.getDueHotspotReactivationContacts(new Date("2026-11-13T12:08:22.960Z")).map(({ id }) => id),
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

test("menyimpan template pengingat masa tenggang", async () => {
  const manager = new DataManager({ push() {} });
  manager.saveSettings = async () => {};

  const settings = await manager.updateSettings({
    gracePeriodReminderMessageTemplate: "Halo {{name}}, masa tenggang berakhir {{isolationDate}}.",
  });

  assert.equal(
    settings.gracePeriodReminderMessageTemplate,
    "Halo {{name}}, masa tenggang berakhir {{isolationDate}}."
  );
});

test("menyimpan template pengingat berakhirnya masa aktif", async () => {
  const manager = new DataManager({ push() {} });
  manager.saveSettings = async () => {};

  const settings = await manager.updateSettings({
    activePeriodReminderMessageTemplate: "Halo {{name}}, masa aktif berakhir {{activeUntil}}.",
  });

  assert.equal(
    settings.activePeriodReminderMessageTemplate,
    "Halo {{name}}, masa aktif berakhir {{activeUntil}}."
  );
});

test("perubahan template notifikasi menyinkronkan reminder bawaan tanpa mengubah jadwal atau pesan lain", async () => {
  const manager = createManager({
    id: "contact-settings-template",
    name: "Pelanggan Template",
    phoneNumber: "6281234567803",
    monthlyPaymentAmount: 100_000,
  });
  const originalContacts = structuredClone(manager.contacts);
  const reminderDefinitions = [
    { id: "active-period", templateName: "MasaAktifSementara" },
    { id: "prepaid-package", templateName: "PaketPrabayar" },
    { id: "custom", templateName: null },
    { id: "file-template", templateName: "Info.txt" },
    { id: "billing", templateName: "PaketPrabayar", reminderKind: REMINDER_KINDS.BILLING },
    { id: "processing-active", templateName: "MasaAktifSementara", processingAt: "2026-11-10T01:00:00.000Z" },
    { id: "processing-prepaid", templateName: "PaketPrabayar", processingAt: "2026-11-10T01:00:00.000Z" },
    { id: "attempted-active", templateName: "MasaAktifSementara", deliveryAttemptedAt: "2026-11-10T01:00:00.000Z" },
    { id: "attempted-prepaid", templateName: "PaketPrabayar", deliveryAttemptedAt: "2026-11-10T01:00:00.000Z" },
  ];
  for (const definition of reminderDefinitions) {
    manager.reminders.set(definition.id, {
      contactId: "contact-settings-template",
      reminderKind: REMINDER_KINDS.ACTIVE_PERIOD_EXPIRY,
      reminderDateTime: "2026-11-10T01:00:00.000Z",
      activePeriodUntil: "2026-11-10T01:00:00.000Z",
      nextDeliveryAttemptAt: "2026-11-11T01:00:00.000Z",
      gracePeriodCreatedAt: "2026-11-10T01:00:00.000Z",
      message: `Pesan lama ${definition.id}`,
      messageSource: `Pesan lama ${definition.id}`,
      ...definition,
    });
  }
  manager.sentReminders.set("sent", {
    ...manager.reminders.get("active-period"),
    id: "sent",
    sentAt: "2026-11-10T01:05:00.000Z",
    deliveryStatus: "SENT",
  });
  const originalReminders = structuredClone(manager.reminders);
  const originalSentReminders = structuredClone(manager.sentReminders);
  const transaction = {};
  manager.sequelize.transaction = async (operation) => operation(transaction);
  let savedSettings;
  const reminderWrites = [];
  manager.saveSettings = async (options = {}) => {
    savedSettings = { settings: structuredClone(manager.settings), transaction: options.transaction };
  };
  manager.saveReminders = async (options = {}) => {
    reminderWrites.push({ reminders: structuredClone(manager.reminders), transaction: options.transaction });
  };
  const payload = {
    activePeriodReminderMessageTemplate: "Halo {{name}}, masa aktif baru sampai {{activeUntil}}.",
    prepaidPackageReminderMessageTemplate: "Paket terbaru {{name}} berakhir {{activeUntil}}.",
  };

  await manager.updateSettings(payload);

  assert.equal(savedSettings.transaction, transaction);
  assert.equal(savedSettings.settings.activePeriodReminderMessageTemplate, payload.activePeriodReminderMessageTemplate);
  assert.equal(savedSettings.settings.prepaidPackageReminderMessageTemplate, payload.prepaidPackageReminderMessageTemplate);
  assert.equal(reminderWrites.length, 1);
  assert.equal(reminderWrites[0].transaction, transaction);
  assert.deepEqual(reminderWrites[0].reminders, manager.reminders);
  for (const [id, messageTemplate] of [
    ["active-period", payload.activePeriodReminderMessageTemplate],
    ["prepaid-package", payload.prepaidPackageReminderMessageTemplate],
  ]) {
    assert.deepEqual(manager.reminders.get(id), {
      ...originalReminders.get(id),
      message: messageTemplate,
      messageSource: messageTemplate,
    });
  }
  for (const { id } of reminderDefinitions.slice(2)) {
    assert.deepEqual(manager.reminders.get(id), originalReminders.get(id), id);
  }
  assert.deepEqual(manager.contacts, originalContacts);
  assert.deepEqual(manager.sentReminders, originalSentReminders);

  await manager.updateSettings(payload);
  assert.equal(reminderWrites.length, 1);
});

test("kegagalan menyimpan reminder mengembalikan perubahan template notifikasi", async () => {
  const manager = new DataManager({ push() {} });
  manager.reminders.set("active-period", {
    id: "active-period",
    reminderKind: REMINDER_KINDS.ACTIVE_PERIOD_EXPIRY,
    templateName: "MasaAktifSementara",
    reminderDateTime: "2026-11-10T01:00:00.000Z",
    message: "Pesan lama",
    messageSource: "Pesan lama",
  });
  const originalSettings = structuredClone(manager.settings);
  const originalReminders = structuredClone(manager.reminders);
  const transaction = {};
  manager.sequelize = { transaction: async (operation) => operation(transaction) };
  let settingsSaved = false;
  manager.saveSettings = async (options) => {
    assert.equal(options.transaction, transaction);
    settingsSaved = true;
  };
  manager.saveReminders = async (options) => {
    assert.equal(options.transaction, transaction);
    throw new Error("database gagal menyimpan reminder");
  };

  await assert.rejects(
    () => manager.updateSettings({ activePeriodReminderMessageTemplate: "Template baru {{name}}" }),
    /database gagal menyimpan reminder/
  );

  assert.equal(settingsSaved, true);
  assert.deepEqual(manager.settings, originalSettings);
  assert.deepEqual(manager.reminders, originalReminders);
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

test("menyimpan template akun WiFi setelah pembayaran dari menu pengaturan", async () => {
  const manager = new DataManager({ push() {} });
  manager.saveSettings = async () => {};

  const template = "Akun WiFi\n{{hotspotUsername}}\n{{hotspotPassword}}\n{{hotspotStatus}}";
  const settings = await manager.updateSettings({
    paymentHotspotAccountMessageTemplate: template,
  });

  assert.equal(settings.paymentHotspotAccountMessageTemplate, template);
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

test("migration mengganti reminder Penagihan existing dengan template masa tenggang satu kali", async () => {
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
  manager.settings.reminderVariableTemplateMigrationVersion = 1;
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
  assert.equal(manager.settings.reminderVariableTemplateMigrationVersion, 2);
});

test("migration menerapkan bahasa ringkas pada template notifikasi dan reminder aktif", async () => {
  const contact = {
    id: "contact-formal-copy-migration",
    name: "Pelanggan Formal",
    phoneNumber: "6281234567898",
    subscriptionType: SUBSCRIPTION_TYPES.RECURRING,
    monthlyPaymentAmount: 100_000,
    paymentStatus: PAYMENT_STATUS.UNPAID,
    paymentMonths: {},
  };
  const manager = createManager(contact);
  manager.settings.apDownMessageTemplate = "Pesan lama";
  manager.settings.notificationTemplateCopyMigrationVersion = 0;
  manager.reminders.set("formal-billing", {
    id: "formal-billing",
    contactId: contact.id,
    reminderDateTime: "2026-11-30T01:00:00.000Z",
    templateName: "Penagihan.txt",
    message: "Pesan tagihan lama",
    messageSource: "Pesan tagihan lama",
  });
  manager.reminders.set("formal-active-period", {
    id: "formal-active-period",
    contactId: contact.id,
    reminderDateTime: "2026-11-27T01:00:00.000Z",
    reminderKind: REMINDER_KINDS.ACTIVE_PERIOD_EXPIRY,
    activePeriodUntil: "2026-11-30T01:00:00.000Z",
    templateName: "MasaAktifSementara",
    message: "Pesan masa aktif lama",
    messageSource: "Pesan masa aktif lama",
  });

  const first = await manager.migrateFormalNotificationTemplates();
  const second = await manager.migrateFormalNotificationTemplates();

  assert.deepEqual(first, { migrated: true, remindersUpdated: 2, version: 6 });
  assert.deepEqual(second, { migrated: false, remindersUpdated: 0, version: 6 });
  assert.equal(manager.settings.apDownMessageTemplate, DEFAULT_SETTINGS.apDownMessageTemplate);
  assert.equal(manager.settings.billingReminderMessageTemplate, DEFAULT_SETTINGS.billingReminderMessageTemplate);
  assert.equal(manager.settings.paymentHotspotAccountMessageTemplate, DEFAULT_SETTINGS.paymentHotspotAccountMessageTemplate);
  assert.equal(manager.settings.notificationTemplateCopyMigrationVersion, 6);
  assert.equal(manager.reminders.get("formal-billing").messageSource, DEFAULT_REMINDER_MESSAGE_TEMPLATE);
  assert.equal(
    manager.reminders.get("formal-active-period").messageSource,
    DEFAULT_SETTINGS.activePeriodReminderMessageTemplate
  );
});

test("migration memperjelas template masa aktif lama tanpa menimpa template khusus", async () => {
  const contact = {
    id: "contact-temporary-active-copy",
    name: "Pelanggan Pascabayar",
    phoneNumber: "6281234567899",
    subscriptionType: SUBSCRIPTION_TYPES.RECURRING,
    billingCycle: BILLING_CYCLES.POSTPAID,
    monthlyPaymentAmount: 100_000,
    paymentStatus: PAYMENT_STATUS.UNPAID,
    paymentMonths: {},
  };
  const manager = createManager(contact);
  manager.settings.notificationTemplateCopyMigrationVersion = 2;
  manager.settings.paymentMessageTemplateActivePeriod =
    LEGACY_PAYMENT_MESSAGE_TEMPLATE_ACTIVE_PERIOD;
  manager.settings.activePeriodReminderMessageTemplate =
    LEGACY_ACTIVE_PERIOD_REMINDER_MESSAGE_TEMPLATE;
  manager.settings.billingReminderMessageTemplate = "Template tagihan khusus";
  manager.reminders.set("temporary-active-period", {
    id: "temporary-active-period",
    contactId: contact.id,
    reminderKind: REMINDER_KINDS.ACTIVE_PERIOD_EXPIRY,
    reminderDateTime: "2026-11-27T01:00:00.000Z",
    activePeriodUntil: "2026-11-30T01:00:00.000Z",
    templateName: "MasaAktifSementara",
    message: LEGACY_ACTIVE_PERIOD_REMINDER_MESSAGE_TEMPLATE,
    messageSource: LEGACY_ACTIVE_PERIOD_REMINDER_MESSAGE_TEMPLATE,
  });
  manager.reminders.set("custom-active-period", {
    id: "custom-active-period",
    contactId: contact.id,
    reminderKind: REMINDER_KINDS.ACTIVE_PERIOD_EXPIRY,
    reminderDateTime: "2026-12-27T01:00:00.000Z",
    activePeriodUntil: "2026-12-30T01:00:00.000Z",
    templateName: "MasaAktifSementara",
    message: "Pesan khusus masa aktif",
    messageSource: "Pesan khusus masa aktif",
  });

  const result = await manager.migrateFormalNotificationTemplates();

  assert.deepEqual(result, { migrated: true, remindersUpdated: 1, version: 6 });
  assert.equal(
    manager.settings.paymentMessageTemplateActivePeriod,
    DEFAULT_SETTINGS.paymentMessageTemplateActivePeriod
  );
  assert.equal(
    manager.settings.activePeriodReminderMessageTemplate,
    DEFAULT_SETTINGS.activePeriodReminderMessageTemplate
  );
  assert.equal(manager.settings.billingReminderMessageTemplate, "Template tagihan khusus");
  assert.equal(
    manager.reminders.get("temporary-active-period").messageSource,
    DEFAULT_SETTINGS.activePeriodReminderMessageTemplate
  );
  assert.equal(
    manager.reminders.get("custom-active-period").messageSource,
    "Pesan khusus masa aktif"
  );
});

test("migration memperbarui pesan bawaan versi tiga tanpa menimpa pesan kustom", async () => {
  const postpaid = {
    id: "contact-copy-v3-postpaid",
    name: "Pelanggan Pascabayar",
    phoneNumber: "6281234567801",
    subscriptionType: SUBSCRIPTION_TYPES.RECURRING,
    billingCycle: BILLING_CYCLES.POSTPAID,
    monthlyPaymentAmount: 100_000,
    paymentStatus: PAYMENT_STATUS.UNPAID,
    paymentMonths: {},
  };
  const prepaid = {
    ...postpaid,
    id: "contact-copy-v3-prepaid",
    name: "Pelanggan Prabayar",
    phoneNumber: "6281234567802",
    billingCycle: BILLING_CYCLES.PREPAID,
  };
  const manager = createManager(postpaid);
  manager.contacts.set(prepaid.id, prepaid);
  manager.settings.notificationTemplateCopyMigrationVersion = 3;
  manager.settings.billingReminderMessageTemplate =
    LEGACY_NOTIFICATION_TEMPLATES_V3.billingReminderMessageTemplate;
  manager.settings.gracePeriodReminderMessageTemplate =
    LEGACY_NOTIFICATION_TEMPLATES_V3.gracePeriodReminderMessageTemplate;
  manager.settings.activePeriodReminderMessageTemplate =
    LEGACY_ACTIVE_PERIOD_REMINDER_MESSAGE_TEMPLATE_V3;
  manager.settings.prepaidPackageReminderMessageTemplate =
    LEGACY_NOTIFICATION_TEMPLATES_V3.prepaidPackageReminderMessageTemplate;
  manager.settings.apDownMessageTemplate = "Pesan jaringan khusus";
  manager.reminders.set("billing-copy-v3", {
    id: "billing-copy-v3",
    contactId: postpaid.id,
    reminderDateTime: "2026-11-30T01:00:00.000Z",
    reminderKind: REMINDER_KINDS.BILLING,
    templateName: "Penagihan.txt",
    message: LEGACY_DEFAULT_REMINDER_MESSAGE_TEMPLATE_V3,
    messageSource: LEGACY_DEFAULT_REMINDER_MESSAGE_TEMPLATE_V3,
  });
  manager.reminders.set("prepaid-copy-v3", {
    id: "prepaid-copy-v3",
    contactId: prepaid.id,
    reminderDateTime: "2026-11-27T01:00:00.000Z",
    reminderKind: REMINDER_KINDS.ACTIVE_PERIOD_EXPIRY,
    activePeriodUntil: "2026-11-30T01:00:00.000Z",
    templateName: "PaketPrabayar",
    message: LEGACY_NOTIFICATION_TEMPLATES_V3.prepaidPackageReminderMessageTemplate,
    messageSource: LEGACY_NOTIFICATION_TEMPLATES_V3.prepaidPackageReminderMessageTemplate,
  });

  const result = await manager.migrateFormalNotificationTemplates();

  assert.deepEqual(result, { migrated: true, remindersUpdated: 2, version: 6 });
  assert.equal(manager.settings.notificationTemplateCopyMigrationVersion, 6);
  assert.equal(manager.settings.billingReminderMessageTemplate, DEFAULT_SETTINGS.billingReminderMessageTemplate);
  assert.equal(manager.settings.gracePeriodReminderMessageTemplate, DEFAULT_SETTINGS.gracePeriodReminderMessageTemplate);
  assert.equal(manager.settings.activePeriodReminderMessageTemplate, DEFAULT_SETTINGS.activePeriodReminderMessageTemplate);
  assert.equal(manager.settings.prepaidPackageReminderMessageTemplate, DEFAULT_SETTINGS.prepaidPackageReminderMessageTemplate);
  assert.equal(manager.settings.apDownMessageTemplate, "Pesan jaringan khusus");
  assert.equal(manager.reminders.get("billing-copy-v3").messageSource, DEFAULT_REMINDER_MESSAGE_TEMPLATE);
  assert.equal(
    manager.reminders.get("prepaid-copy-v3").messageSource,
    DEFAULT_SETTINGS.prepaidPackageReminderMessageTemplate
  );
});

test("migration memperbarui bahasa template tagihan rinci versi empat", async () => {
  const manager = createManager({
    id: "contact-copy-v4",
    name: "Pelanggan Rinci",
    phoneNumber: "6281234567803",
    subscriptionType: SUBSCRIPTION_TYPES.RECURRING,
    billingCycle: BILLING_CYCLES.POSTPAID,
    monthlyPaymentAmount: 100_000,
    paymentStatus: PAYMENT_STATUS.UNPAID,
    paymentMonths: {},
  });
  manager.settings.notificationTemplateCopyMigrationVersion = 4;
  manager.settings.billingReminderMessageTemplate =
    LEGACY_DETAILED_BILLING_REMINDER_MESSAGE_TEMPLATE_V4;

  const result = await manager.migrateFormalNotificationTemplates();

  assert.deepEqual(result, { migrated: true, remindersUpdated: 0, version: 6 });
  assert.equal(manager.settings.notificationTemplateCopyMigrationVersion, 6);
  assert.equal(
    manager.settings.billingReminderMessageTemplate,
    DETAILED_BILLING_REMINDER_MESSAGE_TEMPLATE
  );
});

test("migration memperbarui template masa aktif untuk alur masa tenggang", async () => {
  const postpaid = {
    id: "contact-copy-v5-postpaid",
    name: "Pelanggan Masa Aktif",
    phoneNumber: "6281234567807",
    subscriptionType: SUBSCRIPTION_TYPES.RECURRING,
    billingCycle: BILLING_CYCLES.POSTPAID,
  };
  const prepaid = {
    ...postpaid,
    id: "contact-copy-v5-prepaid",
    name: "Pelanggan Paket",
    phoneNumber: "6281234567808",
    billingCycle: BILLING_CYCLES.PREPAID,
  };
  const manager = createManager(postpaid);
  manager.contacts.set(prepaid.id, prepaid);
  manager.settings.notificationTemplateCopyMigrationVersion = 5;
  manager.settings.activePeriodReminderMessageTemplate =
    LEGACY_ACTIVE_PERIOD_REMINDER_MESSAGE_TEMPLATE_V5;
  manager.settings.prepaidPackageReminderMessageTemplate =
    LEGACY_PREPAID_PACKAGE_REMINDER_MESSAGE_TEMPLATE_V5;
  manager.reminders.set("active-copy-v5", {
    id: "active-copy-v5",
    contactId: postpaid.id,
    reminderKind: REMINDER_KINDS.ACTIVE_PERIOD_EXPIRY,
    message: LEGACY_ACTIVE_PERIOD_REMINDER_MESSAGE_TEMPLATE_V5,
    messageSource: LEGACY_ACTIVE_PERIOD_REMINDER_MESSAGE_TEMPLATE_V5,
  });
  manager.reminders.set("prepaid-copy-v5", {
    id: "prepaid-copy-v5",
    contactId: prepaid.id,
    reminderKind: REMINDER_KINDS.ACTIVE_PERIOD_EXPIRY,
    message: LEGACY_PREPAID_PACKAGE_REMINDER_MESSAGE_TEMPLATE_V5,
    messageSource: LEGACY_PREPAID_PACKAGE_REMINDER_MESSAGE_TEMPLATE_V5,
  });

  const result = await manager.migrateFormalNotificationTemplates();

  assert.deepEqual(result, { migrated: true, remindersUpdated: 2, version: 6 });
  assert.equal(
    manager.reminders.get("active-copy-v5").messageSource,
    DEFAULT_SETTINGS.activePeriodReminderMessageTemplate
  );
  assert.equal(
    manager.reminders.get("prepaid-copy-v5").messageSource,
    DEFAULT_SETTINGS.prepaidPackageReminderMessageTemplate
  );
  assert.match(manager.settings.prepaidPackageReminderMessageTemplate, /Masa tenggang: \{\{graceDays\}\} hari/);
});

test("migration menyelaraskan pembayaran lama tanpa memperpanjang jadwal dua kali", async () => {
  const paidAt = new Date();
  const current = getBillingPeriodParts(paidAt, "Asia/Jakarta");
  const currentKey = makeBillingPeriodKey(current.year, current.month);
  const alignedDueDate = addMonthsSafely(paidAt, 1, "Asia/Jakarta");
  const createPaidContact = (id, dueDate) => ({
    id,
    name: `Pelanggan ${id}`,
    phoneNumber: id === "stale" ? "6281234567805" : "6281234567806",
    createdAt: paidAt.toISOString(),
    subscriptionType: SUBSCRIPTION_TYPES.RECURRING,
    monthlyPaymentAmount: 100_000,
    paymentStatus: PAYMENT_STATUS.PAID,
    paymentDate: paidAt.toISOString(),
    paymentType: PAYMENT_TYPES.CURRENT_ONLY,
    paymentMonths: {
      [currentKey]: {
        status: PAYMENT_STATUS.PAID,
        paidDate: paidAt.toISOString(),
        paymentType: PAYMENT_TYPES.CURRENT_ONLY,
        paidAmount: 100_000,
      },
    },
    hotspotReactivationEnabled: true,
    hotspotReactivationAt: dueDate.toISOString(),
  });
  const staleContact = createPaidContact("stale", paidAt);
  const alignedContact = createPaidContact("aligned", alignedDueDate);
  const previous = getPreviousBillingPeriod(current.year, current.month);
  const previousKey = makeBillingPeriodKey(previous.year, previous.month);
  const graceDueDate = addDaysSafely(paidAt, -1, "Asia/Jakarta");
  const graceReminderDate = addMonthsSafely(graceDueDate, 1, "Asia/Jakarta");
  const graceContact = {
    id: "grace",
    name: "Pelanggan Masa Tenggang",
    phoneNumber: "6281234567807",
    createdAt: `${previousKey}-01T00:00:00.000Z`,
    subscriptionType: SUBSCRIPTION_TYPES.RECURRING,
    monthlyPaymentAmount: 100_000,
    paymentStatus: PAYMENT_STATUS.UNPAID,
    paymentMonths: {
      [previousKey]: {
        status: PAYMENT_STATUS.PAID,
        paidDate: addMonthsSafely(paidAt, -1, "Asia/Jakarta").toISOString(),
        paymentType: PAYMENT_TYPES.CURRENT_ONLY,
        paidAmount: 100_000,
      },
    },
    hotspotReactivationEnabled: true,
    hotspotReactivationAt: graceDueDate.toISOString(),
  };
  const manager = createManager(staleContact);
  manager.contacts.set(alignedContact.id, alignedContact);
  manager.contacts.set(graceContact.id, graceContact);
  manager.settings.prepaidScheduleMigrationVersion = 2;
  for (const contact of [staleContact, alignedContact, graceContact]) {
    manager.reminders.set(`reminder-${contact.id}`, {
      id: `reminder-${contact.id}`,
      contactId: contact.id,
      phoneNumber: contact.phoneNumber,
      reminderDateTime: contact.id === "grace"
        ? graceReminderDate.toISOString()
        : paidAt.toISOString(),
      reminderKind: REMINDER_KINDS.BILLING,
      message: DEFAULT_REMINDER_MESSAGE_TEMPLATE,
      messageSource: DEFAULT_REMINDER_MESSAGE_TEMPLATE,
      templateName: "Penagihan.txt",
    });
  }

  const first = await manager.migrateExistingPaidServiceSchedules({ now: paidAt });
  const second = await manager.migrateExistingPaidServiceSchedules({ now: paidAt });

  assert.equal(first.migrated, true);
  assert.equal(first.contactsUpdated, 1);
  assert.equal(first.alreadyAligned, 1);
  assert.equal(first.skipped, 1);
  assert.equal(first.remindersUpdated >= 2, true);
  assert.equal(second.migrated, false);
  assert.equal(staleContact.hotspotReactivationAt, alignedDueDate.toISOString());
  assert.equal(alignedContact.hotspotReactivationAt, alignedDueDate.toISOString());
  assert.equal(
    manager.getReminder("reminder-stale").reminderDateTime,
    alignedDueDate.toISOString()
  );
  assert.equal(
    manager.getReminder("reminder-aligned").reminderDateTime,
    alignedDueDate.toISOString()
  );
  assert.equal(
    manager.getReminder("reminder-grace").reminderDateTime,
    graceReminderDate.toISOString()
  );
  assert.equal(manager.settings.prepaidScheduleMigrationVersion, 3);
});

test("perubahan template menyinkronkan semua jadwal reminder aktif yang terkait", async () => {
  const contact = {
    id: "contact-template-sync",
    name: "Nouval",
    phoneNumber: "6287728972090",
    subscriptionType: SUBSCRIPTION_TYPES.RECURRING,
    monthlyPaymentAmount: 100_000,
    paymentStatus: PAYMENT_STATUS.UNPAID,
    paymentMonths: {},
  };
  const manager = createManager(contact);
  let saveCount = 0;
  manager.saveReminders = async () => { saveCount += 1; };
  manager.reminders.set("billing-one", {
    id: "billing-one",
    contactId: contact.id,
    message: "Template lama satu",
    messageSource: "Template lama satu",
    reminderDateTime: "2026-11-15T01:00:00.000Z",
    templateName: "Penagihan.txt",
  });
  manager.reminders.set("billing-two", {
    id: "billing-two",
    contactId: contact.id,
    message: "Template lama dua",
    messageSource: "Template lama dua",
    reminderDateTime: "2026-12-15T01:00:00.000Z",
    templateName: "penagihan.TXT",
  });
  manager.reminders.set("other", {
    id: "other",
    contactId: contact.id,
    message: "Pesan lain",
    messageSource: "Pesan lain",
    reminderDateTime: "2026-11-16T01:00:00.000Z",
    templateName: "Info.txt",
  });

  const result = await manager.syncActiveRemindersWithTemplates([{
    name: "Penagihan.txt",
    content: "Tagihan terbaru untuk {{name}} sebesar {{totalAmount}}.",
  }]);

  assert.deepEqual(result, { matched: 2, updated: 2 });
  assert.equal(manager.reminders.get("billing-one").messageSource, "Tagihan terbaru untuk {{name}} sebesar {{totalAmount}}.");
  assert.equal(manager.reminders.get("billing-two").messageSource, "Tagihan terbaru untuk {{name}} sebesar {{totalAmount}}.");
  assert.equal(manager.reminders.get("other").messageSource, "Pesan lain");
  assert.equal(saveCount, 1);

  assert.deepEqual(
    await manager.syncActiveRemindersWithTemplates([{
      name: "Penagihan.txt",
      content: "Tagihan terbaru untuk {{name}} sebesar {{totalAmount}}.",
    }]),
    { matched: 2, updated: 0 }
  );
  assert.equal(saveCount, 1);
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
  assert.equal(reminders[0].templateName, "PaketPrabayar");
  assert.equal(reminders[0].reminderKind, REMINDER_KINDS.ACTIVE_PERIOD_EXPIRY);
  assert.equal(manager.ensureRecurringReminder(result.contact).created, false);
  assert.equal(manager.reminders.size, 1);
});

test("pelanggan baru mengabaikan tipe sekali berlangganan dan memakai bulanan prabayar", async () => {
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

  assert.equal(result.subscriptionType, SUBSCRIPTION_TYPES.RECURRING);
  assert.equal(result.billingCycle, BILLING_CYCLES.PREPAID);
  assert.equal(result.hotspotReactivationEnabled, true);
  assert.equal(
    result.hotspotReactivationAt,
    addMonthsSafely(result.createdAt, 1, manager.getTimezone()).toISOString()
  );
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

test("akun portal otomatis memakai password acak terpisah dari hotspot", async () => {
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
  assert.match(account.account.password, /^scrypt:v1:/);
  assert.equal(await verifyPortalPassword("67810", account.account.password), false);
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
  assert.match(account.account.password, /^scrypt:v1:/);
  assert.equal(await verifyPortalPassword("67811", account.account.password), false);
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

  assert.match(manager.customerAccounts.get(contact.id).password, /^scrypt:v1:/);
  assert.equal(await verifyPortalPassword("portal-baru", manager.customerAccounts.get(contact.id).password), true);
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

test("pembayaran dan refund Midtrans memajukan lalu mengembalikan jatuh tempo", async () => {
  const manager = new DataManager({ push() {} });
  manager.sequelize = { transaction: async (operation) => operation({}) };
  manager.withDatabaseWrite = async (operation) => operation();
  manager.saveContacts = async () => {};
  manager.savePaymentGatewayTransactions = async () => {};
  manager.saveReminders = async () => {};
  const now = new Date();
  const current = getBillingPeriodParts(now, "Asia/Jakarta");
  const currentKey = makeBillingPeriodKey(current.year, current.month);
  const previousDueDate = addDaysSafely(now, 4, "Asia/Jakarta");
  const contact = {
    id: "contact-midtrans-prepaid",
    name: "Pelanggan Midtrans Prabayar",
    phoneNumber: "6281234567828",
    subscriptionType: SUBSCRIPTION_TYPES.RECURRING,
    monthlyPaymentAmount: 100_000,
    paymentStatus: PAYMENT_STATUS.UNPAID,
    paymentMonths: {
      [currentKey]: { status: PAYMENT_STATUS.UNPAID },
    },
    hotspotReactivationEnabled: true,
    hotspotReactivationAt: previousDueDate.toISOString(),
    createdAt: now.toISOString(),
  };
  manager.contacts.set(contact.id, contact);
  manager.reminders.set("reminder-midtrans-prepaid", {
    id: "reminder-midtrans-prepaid",
    contactId: contact.id,
    phoneNumber: contact.phoneNumber,
    reminderDateTime: previousDueDate.toISOString(),
    reminderKind: REMINDER_KINDS.BILLING,
    message: DEFAULT_REMINDER_MESSAGE_TEMPLATE,
    messageSource: DEFAULT_REMINDER_MESSAGE_TEMPLATE,
    templateName: "Penagihan.txt",
  });
  manager.paymentGatewayTransactions.set("RB-MIDTRANS-PREPAID", {
    orderId: "RB-MIDTRANS-PREPAID",
    contactId: contact.id,
    amount: 100_000,
    periods: [currentKey],
    status: "PENDING",
  });

  await manager.completeMidtransPayment("RB-MIDTRANS-PREPAID", {
    gross_amount: "100000.00",
    transaction_status: "settlement",
    transaction_id: "gateway-prepaid",
    payment_type: "bank_transfer",
  });

  const transaction = manager.getPaymentGatewayTransaction("RB-MIDTRANS-PREPAID");
  const expectedDueDate = addMonthsSafely(
    contact.paymentMonths[currentKey].paidDate,
    1,
    "Asia/Jakarta"
  );
  assert.equal(contact.hotspotReactivationAt, expectedDueDate.toISOString());
  assert.equal(transaction.serviceScheduleBeforePayment, previousDueDate.toISOString());
  assert.equal(transaction.serviceScheduleAfterPayment, expectedDueDate.toISOString());
  assert.equal(
    manager.getReminder("reminder-midtrans-prepaid").reminderDateTime,
    expectedDueDate.toISOString()
  );

  await manager.refundMidtransPayment("RB-MIDTRANS-PREPAID", {
    gross_amount: "100000.00",
    transaction_status: "refund",
    transaction_id: "gateway-prepaid",
    refund_amount: "100000.00",
  });

  assert.equal(contact.hotspotReactivationAt, previousDueDate.toISOString());
  assert.equal(contact.hotspotReactivationEnabled, true);
  assert.equal(
    manager.getReminder("reminder-midtrans-prepaid").reminderDateTime,
    previousDueDate.toISOString()
  );
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
  assert.match(manager.customerAccounts.get(contact.id).password, /^scrypt:v1:/);
  assert.equal(await verifyPortalPassword("portal-67805", manager.customerAccounts.get(contact.id).password), true);

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

  const portalAccount = manager.customerAccounts.get(contact.id);
  assert.equal(portalAccount.contactId, contact.id);
  assert.equal(portalAccount.username, "pelanggan_baru_hotspot");
  assert.match(portalAccount.password, /^scrypt:v1:/);
  assert.equal(await verifyPortalPassword("67820", portalAccount.password), false);
  assert.equal(portalAccount.createdAt, contact.createdAt);
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

test("edit jadwal layanan langsung menyinkronkan reminder tagihan", async () => {
  const manager = new DataManager({ push() {} });
  manager.sequelize = { transaction: async (operation) => operation({}) };
  manager.withDatabaseWrite = async (operation) => operation();
  manager.saveContacts = async () => {};
  manager.savePelanggan = async () => {};
  manager.saveCustomerAccounts = async () => {};
  manager.saveReminders = async () => {};
  const oldSchedule = "2026-12-01T10:54:00.000Z";
  const newSchedule = "2026-12-02T10:54:00.000Z";
  const contact = {
    id: "contact-edit-service-schedule",
    name: "Pelanggan Jadwal",
    phoneNumber: "6281234567821",
    createdAt: new Date().toISOString(),
    subscriptionType: SUBSCRIPTION_TYPES.RECURRING,
    mikrotikUsername: "pelanggan_jadwal",
    mikrotikProfile: "30H-2user",
    mikrotikPassword: "67821",
    hotspotProvisioningStatus: "ACTIVE",
    hotspotProvisioningOperation: "NONE",
    hotspotReactivationEnabled: true,
    hotspotReactivationAt: oldSchedule,
    monthlyPaymentAmount: 75_000,
    paymentStatus: PAYMENT_STATUS.UNPAID,
    paymentMonths: {},
  };
  manager.contacts.set(contact.id, contact);
  manager.reminders.set("service-schedule-reminder", {
    id: "service-schedule-reminder",
    contactId: contact.id,
    contactName: contact.name,
    phoneNumber: contact.phoneNumber,
    reminderDateTime: oldSchedule,
    reminderKind: REMINDER_KINDS.BILLING,
    message: DEFAULT_REMINDER_MESSAGE_TEMPLATE,
    messageSource: DEFAULT_REMINDER_MESSAGE_TEMPLATE,
    templateName: "Penagihan.txt",
  });

  const result = await manager.prepareContactUpdate(contact.id, {
    hotspotReactivationEnabled: true,
    hotspotReactivationAt: newSchedule,
  });

  assert.equal(result.hotspotSyncRequired, false);
  assert.equal(result.contact.hotspotReactivationAt, newSchedule);
  assert.equal(
    manager.getReminder("service-schedule-reminder").reminderDateTime,
    newSchedule
  );
  assert.equal(manager.buildDueDateInfo(contact).dueDate, newSchedule);
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

test("hapus pelanggan ditolak saat transaksi Midtrans masih pending", async () => {
  const manager = createManager({ id: "delete-pending", name: "Pending", phoneNumber: "6281234567999", paymentMonths: {} });
  manager.paymentGatewayTransactions.set("RB-PENDING", {
    orderId: "RB-PENDING", contactId: "delete-pending", provider: "midtrans",
    status: "PENDING", createdAt: new Date().toISOString(),
  });
  await assert.rejects(() => manager.deleteContact("delete-pending"), (error) => (
    error.statusCode === 409 && /transaksi Midtrans aktif/.test(error.message)
  ));
  assert.ok(manager.getContact("delete-pending"));
  assert.ok(manager.getPaymentGatewayTransaction("RB-PENDING"));
});

test("transaksi Midtrans not_found yang baru tetap memblokir hapus", async () => {
  const manager = createManager({ id: "delete-notfound", name: "Pending", phoneNumber: "6281234567998", paymentMonths: {} });
  manager.paymentGatewayTransactions.set("RB-RETRY", {
    orderId: "RB-RETRY", contactId: "delete-notfound", provider: "midtrans",
    status: "FAILED", gatewayStatus: "not_found", createdAt: new Date().toISOString(),
  });
  await assert.rejects(() => manager.deleteContact("delete-notfound"), (error) => error.statusCode === 409);
  assert.ok(manager.getContact("delete-notfound"));
});

test("reset portal menggunakan hash dan rollback mempertahankan password lama", async () => {
  const manager = createManager({
    id: "portal-rollback", name: "Portal", phoneNumber: "6281234567997",
    mikrotikUsername: "portal-rollback", mikrotikPassword: "wifi-unchanged", paymentMonths: {},
  });
  manager.customerAccounts.set("portal-rollback", {
    contactId: "portal-rollback", username: "portal-rollback", password: "legacy-secret",
  });
  await manager.synchronizeCustomerPortalAccounts({ save: false });
  const previous = manager.customerAccounts.get("portal-rollback").password;
  assert.match(previous, /^scrypt:v1:/);
  const rotated = await manager.resetCustomerPortalPassword("portal-rollback", "temporary-password-123");
  assert.equal(await verifyPortalPassword("temporary-password-123", rotated.currentHash), true);
  assert.equal(await verifyPortalPassword("legacy-secret", rotated.currentHash), false);
  assert.equal(await manager.restoreCustomerPortalPassword("portal-rollback", rotated.previousHash, rotated.currentHash), true);
  assert.equal(await verifyPortalPassword("legacy-secret", manager.customerAccounts.get("portal-rollback").password), true);
  assert.equal(manager.getContact("portal-rollback").mikrotikPassword, "wifi-unchanged");
});

test("reminder yang sudah dicoba tidak mencatat percobaan kedua", async () => {
  const manager = createManager({ id: "claim-1", phoneNumber: "6281234567996", paymentMonths: {} });
  manager.reminders.set("rem-1", {
    id: "rem-1", contactId: "claim-1", reminderDateTime: new Date(Date.now() - 60000).toISOString(),
    deliveryAttemptedAt: new Date().toISOString(), providerStatus: "processing",
  });
  assert.equal(await manager.markReminderDeliveryAttempt("rem-1", "baileys"), null);
  assert.equal(manager.getReminder("rem-1").deliveryAttempts, undefined);
});
