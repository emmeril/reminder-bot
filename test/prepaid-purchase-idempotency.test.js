const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { DataManager, WebServer } = require("../src/app");
const AuthManager = require("../src/auth-manager");
const { CONFIG } = require("../src/config");
const { addMonthsSafely } = require("../src/utils");

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "prepaid-idempotency-"));
  const originalStorage = CONFIG.DB_STORAGE;
  CONFIG.DB_STORAGE = path.join(directory, "db.sqlite");
  t.after(async () => {
    CONFIG.DB_STORAGE = originalStorage;
    await fs.rm(directory, { recursive: true, force: true });
  });
  const log = { push() {}, list: () => [] };
  const manager = new DataManager(log);
  await manager.initDatabase();
  t.after(async () => manager.close());
  const contact = {
    id: "prepaid-test",
    name: "Pelanggan Paket",
    phoneNumber: "6281234567890",
    subscriptionType: "RECURRING",
    billingCycle: "PREPAID",
    monthlyPaymentAmount: 100000,
    mikrotikUsername: "pelanggan_paket",
    mikrotikProfile: "50M",
    hotspotProvisioningStatus: "ACTIVE",
    hotspotReactivationAt: new Date(Date.now() + 7 * 86400000).toISOString(),
    activePeriodPurchases: [],
    paymentMonths: {},
  };
  manager.contacts.set(contact.id, contact);
  manager.syncActivePeriodExpiryReminder = () => ({ changed: 0 });
  await manager.saveContacts();
  let notificationCalls = 0;
  const web = new WebServer({
    sendPaymentNotification: async () => { notificationCalls += 1; },
  }, manager, {}, log, {}, new AuthManager(log), {}, {});
  return { manager, web, contact, directory, notificationCalls: () => notificationCalls };
}

test("retry pembelian manual mengembalikan transaksi lama tanpa menambah masa aktif dua kali", async (t) => {
  const { manager, web, contact, notificationCalls } = await fixture(t);
  const requestId = "ACT-11111111-1111-4111-8111-111111111111";
  const first = await web.purchaseActivePeriod(contact.id, requestId);
  const second = await web.purchaseActivePeriod(contact.id, requestId);
  assert.equal(first.purchase.id, requestId);
  assert.equal(second.purchase.id, requestId);
  assert.equal(second.reused, true);
  assert.equal(second.purchase.activeUntil, first.purchase.activeUntil);
  assert.equal(manager.getContact(contact.id).activePeriodPurchases.length, 1);
  const status = await web.getActivePeriodPurchaseStatus(contact.id, requestId);
  assert.equal(status.status, "COMPLETED");

  await Promise.all([web.dispatchActivePeriodNotifications(), web.dispatchActivePeriodNotifications()]);
  assert.equal(notificationCalls(), 1);
  assert.equal((await manager.getActivePeriodPurchaseRequest(contact.id, requestId)).notificationStatus, "SENT");
});

test("dua request berbeda untuk pelanggan sama tidak dapat memulai pembelian ketika status belum pasti", async (t) => {
  const { manager, web, contact } = await fixture(t);
  const firstId = "ACT-22222222-2222-4222-8222-222222222222";
  const secondId = "ACT-33333333-3333-4333-8333-333333333333";
  assert.equal(await manager.beginActivePeriodPurchaseRequest(contact.id, firstId), true);
  await manager.markActivePeriodPurchaseForReview(contact.id, firstId);
  await assert.rejects(() => web.purchaseActivePeriod(contact.id, secondId), (error) => {
    assert.equal(error.statusCode, 409);
    return true;
  });
  assert.equal(manager.getContact(contact.id).activePeriodPurchases.length, 0);
});

test("setelah respons hilang, pembelian tersimpan dipulihkan dari ID yang sama", async (t) => {
  const { manager, web, contact } = await fixture(t);
  const requestId = "ACT-44444444-4444-4444-8444-444444444444";
  assert.equal(await manager.beginActivePeriodPurchaseRequest(contact.id, requestId), true);
  const activeFrom = new Date(contact.hotspotReactivationAt);
  const activeUntil = addMonthsSafely(activeFrom, 1, manager.getTimezone());
  await manager.recordActivePeriodPurchase(contact.id, {
    id: requestId,
    purchasedAt: new Date().toISOString(),
    activeFrom: activeFrom.toISOString(),
    activeUntil: activeUntil.toISOString(),
  });
  const status = await web.getActivePeriodPurchaseStatus(contact.id, requestId);
  assert.equal(status.status, "COMPLETED");
  const repeated = await web.purchaseActivePeriod(contact.id, requestId);
  assert.equal(repeated.reused, true);
  assert.equal(manager.getContact(contact.id).activePeriodPurchases.length, 1);
});

test("reservasi transaksi dan riwayat pembelian tetap ada setelah database dibuka ulang", async (t) => {
  const { manager, web, contact } = await fixture(t);
  const requestId = "ACT-55555555-5555-4555-8555-555555555555";
  const result = await web.purchaseActivePeriod(contact.id, requestId);
  const reopened = new DataManager({ push() {} });
  await reopened.initDatabase();
  await reopened.loadFromDatabase();
  t.after(async () => reopened.close());
  assert.equal((await reopened.getActivePeriodPurchaseRequest(contact.id, requestId)).status, "COMPLETED");
  assert.equal(reopened.getContact(contact.id).activePeriodPurchases.length, 1);
  assert.equal(reopened.getContact(contact.id).activePeriodPurchases[0].activeUntil, result.purchase.activeUntil);
});
