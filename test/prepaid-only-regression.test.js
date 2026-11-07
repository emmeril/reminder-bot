const assert = require("node:assert/strict");
const test = require("node:test");

const { DataManager } = require("../src/app");
const { BILLING_CYCLES, PAYMENT_TYPES, REMINDER_KINDS } = require("../src/config");
const { getContactBillingPeriod, isPrepaidPackage, normalizeBillingCycle } = require("../src/modules/customers/domain");
const { addMonthsSafely } = require("../src/utils");

function managerWith(contact) {
  const manager = new DataManager({ push() {} });
  if (contact) manager.contacts.set(String(contact.id), contact);
  manager.saveContacts = async () => {};
  manager.savePelanggan = async () => {};
  manager.saveCustomerAccounts = async () => {};
  manager.savePaymentGatewayTransactions = async () => {};
  manager.saveReminders = async () => {};
  manager.withDatabaseWrite = async operation => operation();
  manager.sequelize = { transaction: async operation => operation({}) };
  return manager;
}

test("prabayar: mode selain PREPAID tidak bisa digunakan untuk pelanggan baru", async () => {
  const manager = managerWith();
  const customer = await manager.addContact({
    name: "Pelanggan Paket",
    phoneNumber: "6281234567801",
    billingCycle: "POSTPAID",
    monthlyPaymentAmount: 100_000,
  });
  assert.equal(customer.billingCycle, BILLING_CYCLES.PREPAID);
  assert.equal(normalizeBillingCycle("POSTPAID"), BILLING_CYCLES.PREPAID);
  assert.equal(isPrepaidPackage(customer), true);
  assert.deepEqual(getContactBillingPeriod(customer, { year: 2026, month: 11 }), { year: 2026, month: 11 });
  assert.equal(manager.buildDebtInfo(manager.getContact(customer.id)).debtCount, 0);
});

test("prabayar: tanggal kedaluwarsa paket menentukan status, bukan tunggakan historis", () => {
  const activeUntil = new Date(Date.now() + 86_400_000).toISOString();
  const contact = {
    id: "prepaid-expiry",
    subscriptionType: "RECURRING",
    billingCycle: "PREPAID",
    monthlyPaymentAmount: 75_000,
    hotspotReactivationAt: activeUntil,
    paymentMonths: { "2026-01": { status: "UNPAID" } },
  };
  const manager = managerWith(contact);
  const active = manager.buildDebtInfo(contact);
  assert.equal(active.packageActive, true);
  assert.equal(active.hasDebt, false);
  assert.equal(active.debtCount, 0);
  contact.hotspotReactivationAt = new Date(Date.now() - 86_400_000).toISOString();
  const expired = manager.buildDebtInfo(contact);
  assert.equal(expired.packageActive, false);
  assert.equal(expired.hasDebt, false);
  assert.equal(expired.debtCount, 0);
});

test("prabayar: pembelian paket tidak membuat reminder ganda ketika ID pembayaran diproses ulang", async () => {
  const contact = {
    id: "prepaid-dedupe",
    name: "Pelanggan Paket",
    phoneNumber: "6281234567802",
    subscriptionType: "RECURRING",
    billingCycle: "PREPAID",
    monthlyPaymentAmount: 100_000,
    activePeriodPurchases: [],
    paymentMonths: {},
    hotspotReactivationAt: null,
  };
  const manager = managerWith(contact);
  const purchasedAt = new Date("2026-11-07T02:00:00.000Z");
  const activeUntil = addMonthsSafely(purchasedAt, 1, "Asia/Jakarta");
  const purchase = {
    id: "PREPAID-TEST-DEDUPE-1",
    purchasedAt: purchasedAt.toISOString(),
    activeFrom: purchasedAt.toISOString(),
    activeUntil: activeUntil.toISOString(),
  };
  const first = await manager.recordActivePeriodPurchase(contact.id, purchase);
  const second = await manager.recordActivePeriodPurchase(contact.id, purchase);
  assert.equal(first.added, true);
  assert.equal(second.added, false);
  assert.equal(contact.activePeriodPurchases.length, 1);
  assert.equal(contact.activePeriodPurchases[0].paymentType, PAYMENT_TYPES.ACTIVE_PERIOD);
  assert.equal(contact.hotspotReactivationAt, activeUntil.toISOString());
  assert.equal(manager.reminders.size, 1);
  assert.equal([...manager.reminders.values()][0].reminderKind, REMINDER_KINDS.ACTIVE_PERIOD_EXPIRY);
});

test("prabayar: pembelian periode tidak menyebabkan hutang baru pada bulan berikutnya", () => {
  const activeUntil = new Date("2027-02-07T02:00:00.000Z").toISOString();
  const contact = {
    id: "prepaid-no-arrears",
    subscriptionType: "RECURRING",
    billingCycle: "PREPAID",
    monthlyPaymentAmount: 100_000,
    hotspotReactivationAt: activeUntil,
    paymentMonths: { "2026-10": { status: "UNPAID" } },
  };
  const manager = managerWith(contact);
  const future = manager.buildDebtInfo(contact, { year: 2027, month: 1 });
  assert.equal(future.debtCount, 0);
  assert.equal(future.debtAmount, 0);
  assert.equal(future.hasDebt, false);
  assert.equal(future.packageActive, true);
});
