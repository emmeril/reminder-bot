const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { DataManager } = require("../src/app");
const { BILLING_CYCLES, SUBSCRIPTION_TYPES, PAYMENT_STATUS } = require("../src/config");

test("tab Tagihan prabayar tidak menampilkan kolom dan form tunggakan", () => {
  const html = fs.readFileSync(path.join(__dirname, "../public/index.html"), "utf8");
  const section = html.split('id="customer-billing-panel"')[1].split('id="customer-hotspot-panel"')[0];
  assert.ok(section);
  assert.match(section, /<span>Status Paket<\/span>/);
  assert.match(section, /<span>Aktif Sampai<\/span>/);
  assert.doesNotMatch(section, /data-label="Tunggakan"/);
  assert.doesNotMatch(section, /'contactBilling', 'debt'/);
  assert.match(section, /colspan="9"/);

  const modal = html.split('id="billing-action-title"')[1].split('id="billing-action-footer"')[0];
  assert.ok(modal);
  assert.doesNotMatch(modal, /Sisa tunggakan|payArrears\(|ARREARS-ONLY|FULL-PAID/);
  assert.match(modal, /purchaseActivePeriod\(/);
});

test("rekap Excel prabayar tidak membuat sheet tunggakan tetapi mempertahankan riwayat", async () => {
  const now = Date.now();
  const activeUntil = new Date(now + 30 * 24 * 3600 * 1000).toISOString();
  const expiredAt = new Date(now - 24 * 3600 * 1000).toISOString();
  const manager = new DataManager({ push() {} });
  manager.contacts.set("active", {
    id: "active", name: "Pelanggan Aktif", phoneNumber: "628111111111",
    subscriptionType: SUBSCRIPTION_TYPES.RECURRING, billingCycle: BILLING_CYCLES.PREPAID,
    hotspotReactivationAt: activeUntil, monthlyPaymentAmount: 75000,
    activePeriodPurchases: [{
      id: "purchase-1", status: PAYMENT_STATUS.PAID, paymentType: "ACTIVE-PERIOD",
      purchasedAt: new Date(now - 3600 * 1000).toISOString(),
      activeFrom: new Date(now - 3600 * 1000).toISOString(), activeUntil, amount: 75000,
    }],
  });
  manager.contacts.set("expired", {
    id: "expired", name: "Pelanggan Nonaktif", phoneNumber: "628122222222",
    subscriptionType: SUBSCRIPTION_TYPES.RECURRING, billingCycle: BILLING_CYCLES.PREPAID,
    hotspotReactivationAt: expiredAt, monthlyPaymentAmount: 75000,
  });

  const workbook = await manager.createPaymentRecapWorkbook();
  assert.ok(workbook.getWorksheet("Ringkasan"));
  assert.ok(workbook.getWorksheet("Semua Pelanggan"));
  assert.ok(workbook.getWorksheet("Paket Aktif"));
  assert.ok(workbook.getWorksheet("Paket Tidak Aktif"));
  assert.ok(workbook.getWorksheet("Riwayat Pembayaran"));
  assert.equal(workbook.getWorksheet("Memiliki Tunggakan"), undefined);

  const all = workbook.getWorksheet("Semua Pelanggan");
  const headers = all.getRow(1).values.join(" ");
  assert.match(headers, /Status Paket|Aktif Sampai/);
  assert.doesNotMatch(headers, /Tunggakan/);
  const summary = workbook.getWorksheet("Ringkasan");
  assert.equal(summary.getRow(4).getCell(2).value, 2);
  assert.equal(summary.getRow(5).getCell(2).value, 1);
  assert.equal(summary.getRow(6).getCell(2).value, 1);
  assert.equal(workbook.getWorksheet("Riwayat Pembayaran").rowCount >= 2, true);
  assert.equal(workbook.getWorksheet("Paket Aktif").rowCount, 2);
  assert.equal(workbook.getWorksheet("Paket Tidak Aktif").rowCount, 2);
});
