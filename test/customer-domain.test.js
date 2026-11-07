const test = require("node:test");
const assert = require("node:assert/strict");
const {
  HOTSPOT_ACCESS_MODES,
  getContactBillingPeriod,
  getContactHotspotAccessMode,
  normalizeBillingCycle,
  isPrepaidPackage,
  normalizeProfileMonthlyAmounts,
  parsePaymentAmountFromMessage,
} = require("../src/modules/customers/domain");

test("mode hotspot lama tetap diturunkan dari keberadaan MAC IP Binding", () => {
  assert.equal(getContactHotspotAccessMode({ mikrotikMacAddresses: [] }), HOTSPOT_ACCESS_MODES.HOTSPOT_ONLY);
  assert.equal(
    getContactHotspotAccessMode({ mikrotikMacAddresses: ["7C:AA:DE:53:5D:77"] }),
    HOTSPOT_ACCESS_MODES.BOTH
  );
});

test("semua pelanggan berlangganan memakai prabayar dan periode bulan berjalan", () => {
  const period = { year: 2026, month: 12 };
  const legacy = { subscriptionType: "RECURRING", billingCycle: "POSTPAID" };
  const prepaid = { subscriptionType: "RECURRING", billingCycle: "PREPAID" };

  assert.equal(normalizeBillingCycle("POSTPAID"), "PREPAID");
  assert.equal(isPrepaidPackage(legacy), true);
  assert.equal(isPrepaidPackage(prepaid), true);
  assert.deepEqual(getContactBillingPeriod(legacy, period), period);
  assert.deepEqual(getContactBillingPeriod(prepaid, period), period);
});

test("tarif profile dinormalisasi tanpa membedakan huruf besar kecil", () => {
  assert.deepEqual(normalizeProfileMonthlyAmounts({ Rumah: 150000, rumah: 175000 }), {
    rumah: 175000,
  });
  assert.throws(
    () => normalizeProfileMonthlyAmounts({ Rumah: -1 }, { strict: true }),
    /antara 0 sampai 1 miliar/
  );
});

test("nominal pembayaran dapat dibaca dari pesan notifikasi lama", () => {
  assert.equal(parsePaymentAmountFromMessage("Pembayaran sebesar Rp 175.000 telah diterima."), 175000);
  assert.equal(parsePaymentAmountFromMessage("Tidak ada nominal"), 0);
});
