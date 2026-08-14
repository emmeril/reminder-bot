const assert = require("node:assert/strict");
const test = require("node:test");

const { DataManager } = require("../src/app");
const {
  PAYMENT_STATUS,
  PAYMENT_TYPES,
} = require("../src/config");
const {
  getBillingPeriodParts,
  makeBillingPeriodKey,
} = require("../src/utils");

function createManager(contact) {
  const manager = new DataManager({ push() {} });
  manager.contacts.set(String(contact.id), contact);
  manager.saveContacts = async () => {};
  manager.saveReminders = async () => {};
  manager.withDatabaseWrite = async (operation) => operation();
  manager.sequelize = {
    transaction: async (operation) => operation({}),
  };
  return manager;
}

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

test("registrasi pelanggan MikroTik menyimpan AP dan jadwal reaktivasi dari form", async () => {
  const manager = new DataManager({ push() {} });
  manager.sequelize = {
    transaction: async (operation) => operation({}),
  };
  manager.withDatabaseWrite = async (operation) => operation();
  manager.saveContacts = async () => {};
  manager.savePelanggan = async () => {};
  const reactivationAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  const result = await manager.upsertPelangganFromRegistration({
    name: "Pelanggan Baru",
    phoneNumber: "6281234567800",
    username: "pelanggan_baru",
    profile: "100M",
    password: "67800",
    linkedApHost: "10.0.0.20",
    hotspotReactivationEnabled: true,
    hotspotReactivationAt: reactivationAt,
  });

  assert.equal(result.contact.linkedApHost, "10.0.0.20");
  assert.equal(result.contact.hotspotReactivationEnabled, true);
  assert.equal(result.contact.hotspotReactivationAt, reactivationAt);
  assert.equal(result.contact.hotspotProvisioningStatus, "ACTIVE");
  assert.equal(result.pelanggan.hotspotProvisioningStatus, "ACTIVE");
});

test("persiapan akun hotspot menyimpan pelanggan sebagai PENDING", async () => {
  const manager = new DataManager({ push() {} });
  manager.sequelize = {
    transaction: async (operation) => operation({}),
  };
  manager.withDatabaseWrite = async (operation) => operation();
  manager.saveContacts = async () => {};
  manager.savePelanggan = async () => {};

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

test("status FAILED menyimpan error tanpa menghapus pelanggan", async () => {
  const manager = new DataManager({ push() {} });
  manager.sequelize = {
    transaction: async (operation) => operation({}),
  };
  manager.withDatabaseWrite = async (operation) => operation();
  manager.saveContacts = async () => {};
  manager.savePelanggan = async () => {};
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
  assert.equal(result.hotspotNotificationPending.message, undefined);
  assert.equal(result.hotspotNotificationPending.attempts, 1);
});
