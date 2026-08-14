const assert = require("node:assert/strict");
const test = require("node:test");

const { DataManager } = require("../src/app");
const { HotspotReactivationScheduler } = require("../src/schedulers");

test("notifikasi kredensial yang gagal ditutup tanpa percobaan ulang", async () => {
  const manager = new DataManager({ push() {} });
  manager.saveContacts = async () => {};
  manager.savePelanggan = async () => {};
  manager.withDatabaseWrite = async (operation) => operation();
  manager.sequelize = { transaction: async (operation) => operation({}) };
  const contact = {
    id: "contact-retry",
    name: "Pelanggan",
    phoneNumber: "6281234567890",
    mikrotikUsername: "pelanggan",
    mikrotikPassword: "secret",
    mikrotikProfile: "100M",
    hotspotReactivationEnabled: true,
    hotspotReactivationAt: new Date(Date.now() - 60_000).toISOString(),
    paymentMonths: {},
    createdAt: new Date().toISOString(),
  };
  manager.contacts.set(contact.id, contact);

  let routerCalls = 0;
  let sendCalls = 0;
  const scheduler = new HotspotReactivationScheduler(
    {
      async reactivateHotspotUser(payload) {
        routerCalls += 1;
        return { ...payload, activeSessionsKilled: 0, removedUsers: 1 };
      },
      async verifyHotspotCustomer(payload) {
        return payload;
      },
    },
    manager,
    { push() {} },
    {
      async sendMessage() {
        sendCalls += 1;
        if (sendCalls === 1) throw new Error("transport sementara gagal");
      },
    }
  );

  const first = await scheduler.reactivateContact(manager.hydrateContact(contact));
  assert.equal(first.notification.sent, false);
  assert.equal(manager.getContact(contact.id).hotspotNotificationPending, null);
  assert.equal(manager.getContact(contact.id).hotspotNotificationLastStatus, "FAILED");

  await scheduler.processDueReactivations();

  assert.equal(routerCalls, 1);
  assert.equal(sendCalls, 1);
  assert.equal(manager.getContact(contact.id).hotspotNotificationPending, null);
});

test("menyelesaikan semua pekerjaan router sebelum memproses notifikasi WA", async () => {
  const manager = new DataManager({ push() {} });
  manager.saveContacts = async () => {};
  manager.savePelanggan = async () => {};
  manager.withDatabaseWrite = async (operation) => operation();
  manager.sequelize = { transaction: async (operation) => operation({}) };
  const contacts = ["satu", "dua"].map((name, index) => ({
    id: `contact-${name}`,
    name,
    phoneNumber: `628123456789${index}`,
    mikrotikUsername: name,
    mikrotikPassword: "secret",
    mikrotikProfile: "100M",
    hotspotReactivationEnabled: true,
    hotspotReactivationAt: new Date(Date.now() - 60_000).toISOString(),
    paymentMonths: {},
    createdAt: new Date().toISOString(),
  }));
  for (const contact of contacts) manager.contacts.set(contact.id, contact);

  let routerCalls = 0;
  const routerCallsObservedByWa = [];
  const scheduler = new HotspotReactivationScheduler(
    {
      async reactivateHotspotUser(payload) {
        routerCalls += 1;
        return { ...payload, activeSessionsKilled: 0, removedUsers: 1 };
      },
      async verifyHotspotCustomer(payload) {
        return payload;
      },
    },
    manager,
    { push() {} },
    {
      async sendMessage() {
        routerCallsObservedByWa.push(routerCalls);
        throw new Error("WhatsApp sedang gagal");
      },
    }
  );

  const results = await scheduler.processDueReactivations();

  assert.equal(routerCalls, 2);
  assert.deepEqual(routerCallsObservedByWa, [2, 2]);
  assert.equal(
    results.filter((item) => item.action === "reactivate" && item.status === "success").length,
    2
  );
});

test("kegagalan reaktivasi disimpan sebagai FAILED tanpa memajukan jadwal", async () => {
  const manager = new DataManager({ push() {} });
  manager.saveContacts = async () => {};
  manager.savePelanggan = async () => {};
  manager.withDatabaseWrite = async (operation) => operation();
  manager.sequelize = { transaction: async (operation) => operation({}) };
  const originalSchedule = new Date(Date.now() - 60_000).toISOString();
  const contact = {
    id: "contact-reactivation-failed",
    name: "Pelanggan Gagal",
    phoneNumber: "6281234567898",
    mikrotikUsername: "pelanggan_gagal",
    mikrotikPassword: "67898",
    mikrotikProfile: "100M",
    hotspotReactivationEnabled: true,
    hotspotReactivationAt: originalSchedule,
    hotspotProvisioningStatus: "ACTIVE",
    paymentMonths: {},
  };
  manager.contacts.set(contact.id, contact);
  const scheduler = new HotspotReactivationScheduler(
    {
      async reactivateHotspotUser() {
        throw new Error("router timeout");
      },
      async verifyHotspotCustomer(payload) {
        return payload;
      },
    },
    manager,
    { push() {} }
  );

  await assert.rejects(
    () => scheduler.reactivateContact(manager.hydrateContact(contact)),
    /Reaktivasi hotspot gagal: router timeout/
  );

  const failed = manager.getContact(contact.id);
  assert.equal(failed.hotspotProvisioningStatus, "FAILED");
  assert.equal(failed.hotspotProvisioningOperation, "REACTIVATE");
  assert.equal(failed.hotspotReactivationAt, originalSchedule);
  assert.match(failed.hotspotProvisioningError, /router timeout/);
});
