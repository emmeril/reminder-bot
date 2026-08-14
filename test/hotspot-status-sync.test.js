const assert = require("node:assert/strict");
const test = require("node:test");

const { DataManager } = require("../src/app");
const { HotspotStatusSyncScheduler } = require("../src/schedulers");

function createManager(contacts = []) {
  const manager = new DataManager({ push() {} });
  manager.saveContacts = async () => {};
  manager.savePelanggan = async () => {};
  manager.withDatabaseWrite = async (operation) => operation();
  manager.sequelize = { transaction: async (operation) => operation({}) };

  for (const contact of contacts) {
    manager.contacts.set(String(contact.id), contact);
    manager.pelanggan.set(contact.mikrotikUsername, {
      username: contact.mikrotikUsername,
      contactId: contact.id,
      nomer: contact.phoneNumber,
      profile: contact.mikrotikProfile,
      status: "verified",
      hotspotProvisioningStatus: contact.hotspotProvisioningStatus,
      hotspotProvisioningError: contact.hotspotProvisioningError || "",
    });
  }
  return manager;
}

function createContact(overrides = {}) {
  return {
    id: "contact-sync",
    name: "Pelanggan Sync",
    phoneNumber: "6281234567890",
    mikrotikUsername: "pelanggan_sync",
    mikrotikProfile: "100M",
    mikrotikPassword: "67890",
    hotspotProvisioningStatus: "ACTIVE",
    hotspotProvisioningOperation: "NONE",
    hotspotProvisioningError: "",
    hotspotLastCheckedAt: "2026-08-13T00:00:00.000Z",
    hotspotLastSyncedAt: "2026-08-13T00:00:00.000Z",
    paymentMonths: {},
    ...overrides,
  };
}

const syncOptions = {
  observedAt: "2026-08-14T00:00:00.000Z",
  checkedAt: "2026-08-14T00:00:05.000Z",
};

test("sinkronisasi otomatis menandai akun yang dihapus sebagai MISSING walau sesi aktif masih tersisa", async () => {
  const contact = createContact();
  const manager = createManager([contact]);

  const result = await manager.reconcileHotspotStatuses([{
    username: contact.mikrotikUsername,
    active: true,
    source: "active",
  }], syncOptions);

  assert.equal(result.missing, 1);
  assert.equal(result.updated, 1);
  assert.equal(contact.hotspotProvisioningStatus, "MISSING");
  assert.match(contact.hotspotProvisioningError, /tidak ditemukan di MikroTik/);
  assert.equal(contact.hotspotLastCheckedAt, syncOptions.checkedAt);
  assert.equal(contact.hotspotLastSyncedAt, "2026-08-13T00:00:00.000Z");
  assert.equal(manager.pelanggan.get(contact.mikrotikUsername).hotspotProvisioningStatus, "MISSING");
});

test("sinkronisasi otomatis menandai profile, pemilik, atau disabled yang berubah", async () => {
  const contact = createContact();
  const manager = createManager([contact]);

  const result = await manager.reconcileHotspotStatuses([{
    username: contact.mikrotikUsername,
    profile: "50M",
    email: "6289999999999@localhost.local",
    disabled: true,
  }], syncOptions);

  assert.equal(result.changed, 1);
  assert.equal(contact.hotspotProvisioningStatus, "CHANGED");
  assert.match(contact.hotspotProvisioningError, /profile berbeda/);
  assert.match(contact.hotspotProvisioningError, /email pemilik berbeda/);
  assert.match(contact.hotspotProvisioningError, /akun dinonaktifkan/);
});

test("akun yang kembali cocok dipulihkan otomatis menjadi ACTIVE", async () => {
  const contact = createContact({
    hotspotProvisioningStatus: "MISSING",
    hotspotProvisioningError: "Akun sebelumnya hilang.",
  });
  const manager = createManager([contact]);

  const result = await manager.reconcileHotspotStatuses([{
    username: contact.mikrotikUsername,
    profile: contact.mikrotikProfile,
    email: "6281234567890@localhost.local",
    disabled: false,
  }], syncOptions);

  assert.equal(result.active, 1);
  assert.equal(contact.hotspotProvisioningStatus, "ACTIVE");
  assert.equal(contact.hotspotProvisioningError, "");
  assert.equal(contact.hotspotLastSyncedAt, syncOptions.checkedAt);
  assert.equal(manager.pelanggan.get(contact.mikrotikUsername).status, "verified");
});

test("sinkronisasi tidak menimpa operasi aktif, kegagalan, atau snapshot router yang kedaluwarsa", async () => {
  const contacts = [
    createContact({ id: "pending", mikrotikUsername: "pending", hotspotProvisioningStatus: "PENDING" }),
    createContact({ id: "provisioning", mikrotikUsername: "provisioning", hotspotProvisioningStatus: "PROVISIONING" }),
    createContact({ id: "failed", mikrotikUsername: "failed", hotspotProvisioningStatus: "FAILED" }),
    createContact({
      id: "fresh",
      mikrotikUsername: "fresh",
      hotspotLastSyncedAt: "2026-08-14T00:00:02.000Z",
    }),
  ];
  const manager = createManager(contacts);

  const result = await manager.reconcileHotspotStatuses([], syncOptions);

  assert.equal(result.checked, 0);
  assert.equal(result.skipped, 4);
  assert.deepEqual(
    contacts.map((contact) => contact.hotspotProvisioningStatus),
    ["PENDING", "PROVISIONING", "FAILED", "ACTIVE"]
  );
});

test("scheduler membaca seluruh user MikroTik sekali lalu menyimpan hasil rekonsiliasi", async () => {
  let routerCalls = 0;
  let reconcileCalls = 0;
  const logs = [];
  const scheduler = new HotspotStatusSyncScheduler(
    {
      async getHotspotUsers() {
        routerCalls += 1;
        return [{ username: "pelanggan_sync", profile: "100M" }];
      },
    },
    {
      async reconcileHotspotStatuses(users, options) {
        reconcileCalls += 1;
        assert.equal(users.length, 1);
        assert.ok(options.observedAt);
        return { checked: 1, active: 0, missing: 1, changed: 0, updated: 1 };
      },
    },
    { push: (...entry) => logs.push(entry) }
  );

  const result = await scheduler.processStatusSync();

  assert.equal(routerCalls, 1);
  assert.equal(reconcileCalls, 1);
  assert.equal(result.missing, 1);
  assert.equal(logs[0][0], "warn");
  assert.equal(scheduler.isProcessing, false);
});

test("kegagalan membaca MikroTik tidak mengubah database dan melepaskan lock scheduler", async () => {
  let reconcileCalls = 0;
  const scheduler = new HotspotStatusSyncScheduler(
    {
      async getHotspotUsers() {
        throw new Error("router timeout");
      },
    },
    {
      async reconcileHotspotStatuses() {
        reconcileCalls += 1;
      },
    },
    { push() {} }
  );

  await assert.rejects(() => scheduler.processStatusSync(), /router timeout/);
  assert.equal(reconcileCalls, 0);
  assert.equal(scheduler.isProcessing, false);
});
