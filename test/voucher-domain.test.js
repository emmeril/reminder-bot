const assert = require("node:assert/strict");
const test = require("node:test");

const {
  VOUCHER_CHARACTER_SETS,
  buildVoucherProfileScripts,
  buildVoucherRevenueReport,
  normalizeVoucherGenerationPayload,
  normalizeVoucherProfilePayload,
  parseVoucherBatchComment,
  parseVoucherProfileMetadata,
  parseVoucherUsageRecord,
} = require("../src/modules/vouchers/domain");

test("domain voucher membaca metadata profile dan komentar batch lama maupun baru", () => {
  assert.deepEqual(
    parseVoucherProfileMetadata(':put (",remc,25000,1d,40000,,Enable,15000,")'),
    {
      expiredMode: "remc",
      validity: "1d",
      costPrice: 25000,
      sellingPrice: 40000,
      lockUser: true,
      commission: 15000,
    }
  );
  assert.deepEqual(parseVoucherBatchComment("voucher-batch-1 Reward"), {
    batchId: "batch-1",
    comment: "Reward",
  });
  assert.deepEqual(parseVoucherBatchComment("vc|batch-2|Standar"), {
    batchId: "batch-2",
    comment: "Standar",
  });
});

test("domain voucher menormalkan profile dan permintaan pembuatan tanpa bergantung pada HTTP", () => {
  const profile = normalizeVoucherProfilePayload({
    name: "Voucher Harian",
    expiredMode: "remc",
    validity: "1d",
    sharedUsers: 1,
    sellingPrice: 40000,
    costPrice: 25000,
    lockUser: true,
  });
  const generation = normalizeVoucherGenerationPayload({
    generationType: "BULK",
    quantity: 10,
    credentialMode: "SEPARATE",
    characterSet: "LOWER",
    codeLength: 6,
    prefix: "vc-",
    profile: profile.name,
    server: "all",
    dataUnit: "GB",
  });

  assert.equal(profile.name, "Voucher-Harian");
  assert.equal(profile.commission, 15000);
  assert.equal(generation.quantity, 10);
  assert.equal(generation.profile, "Voucher-Harian");
  assert.equal(VOUCHER_CHARACTER_SETS[generation.characterSet].includes("0"), false);
  assert.throws(
    () => normalizeVoucherGenerationPayload({ generationType: "BULK", quantity: 501, profile: "VCR" }),
    /Jumlah voucher/
  );
});

test("script profile hanya mencatat pendapatan untuk mode yang mendukung riwayat", () => {
  const base = {
    name: "VCR-1D",
    validity: "1d",
    sellingPrice: 40000,
    costPrice: 25000,
    commission: 15000,
    lockUser: false,
  };
  const recorded = buildVoucherProfileScripts({ ...base, expiredMode: "remc" });
  const unrecorded = buildVoucherProfileScripts({ ...base, expiredMode: "rem" });

  assert.match(recorded.onLogin, /system script add/);
  assert.match(recorded.onLogin, /comment="mikhmon"/);
  assert.doesNotMatch(unrecorded.onLogin, /system script add/);
});

test("catatan pemakaian dan ringkasan pendapatan mempunyai ID stabil", () => {
  const script = {
    ".id": "*1",
    name: "nov/03/2026-|-08:00:00-|-voucher-1-|-40000-|-10.0.0.2-|-AA:BB-|-1d-|-VCR-1D-|-vc|batch-1|Reward-|-hotspot-|-25000-|-15000",
    owner: "nov2026",
    source: "nov/03/2026",
    comment: "mikhmon",
  };
  const first = parseVoucherUsageRecord(script, new Map(), "Asia/Jakarta");
  const second = parseVoucherUsageRecord({ ...script }, new Map(), "Asia/Jakarta");
  const report = buildVoucherRevenueReport([first], "2026-11");

  assert.equal(first.id, second.id);
  assert.equal(first.batchId, "batch-1");
  assert.equal(report.summary.revenue, 40000);
  assert.equal(report.summary.costPrice, 25000);
  assert.equal(report.summary.commission, 15000);
  assert.equal(report.summary.quantity, 1);
});
