const assert = require("node:assert/strict");
const test = require("node:test");

const { DataManager } = require("../src/app");
const { HotspotReactivationScheduler } = require("../src/schedulers");

test("reaktivasi hotspot tidak mengirim WhatsApp pelanggan", async () => {
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

  let sendCalls = 0;
  const scheduler = new HotspotReactivationScheduler(
    {
      async reactivateHotspotUser(payload) {
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
      },
    }
  );

  const result = await scheduler.reactivateContact(manager.hydrateContact(contact));

  assert.equal(result.operation, "REACTIVATE");
  assert.equal("notification" in result, false);
  assert.equal(manager.getContact(contact.id).hotspotNotificationPending, null);
  assert.equal(sendCalls, 0);
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

test("jadwal nonaktif mempertahankan akun MikroTik dan hanya menonaktifkannya", async () => {
  const manager = new DataManager({ push() {} });
  manager.saveContacts = async () => {};
  manager.savePelanggan = async () => {};
  manager.withDatabaseWrite = async (operation) => operation();
  manager.sequelize = { transaction: async (operation) => operation({}) };
  const contact = {
    id: "contact-scheduled-disable",
    name: "Pelanggan Jadwal",
    phoneNumber: "6281234567899",
    mikrotikUsername: "pelanggan_jadwal",
    mikrotikPassword: "67899",
    mikrotikProfile: "100M",
    hotspotReactivationEnabled: false,
    hotspotReactivationAt: new Date(Date.now() - 60_000).toISOString(),
    hotspotProvisioningStatus: "ACTIVE",
    paymentMonths: {},
  };
  manager.contacts.set(contact.id, contact);
  const calls = [];
  const scheduler = new HotspotReactivationScheduler(
    {
      async setHotspotUserDisabled(username, phoneNumber, disabled) {
        calls.push([username, phoneNumber, disabled]);
        return { username, password: contact.mikrotikPassword, profile: contact.mikrotikProfile, disabled };
      },
    },
    manager,
    { push() {} }
  );

  const result = await scheduler.deactivateContact(manager.hydrateContact(contact));

  assert.equal(result.operation, "DEACTIVATE");
  assert.deepEqual(calls, [[contact.mikrotikUsername, contact.phoneNumber, true]]);
  assert.equal(manager.getContact(contact.id).hotspotProvisioningStatus, "DISABLED");
  assert.equal(manager.getContact(contact.id).hotspotReactivationAt, null);
  assert.equal(manager.getContact(contact.id).hotspotReactivationEnabled, false);
});
