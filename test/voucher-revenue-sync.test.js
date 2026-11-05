const assert = require("node:assert/strict");
const test = require("node:test");

const { VoucherRevenueSyncScheduler } = require("../src/schedulers");

function voucherRecord(id, usedAt) {
  return {
    id,
    routerScriptId: `*${id}`,
    username: id,
    profile: "VCR-1D",
    amount: 40000,
    costPrice: 25000,
    commission: 15000,
    usedAt,
    period: "2026-11",
  };
}

test("sinkronisasi menyimpan semua transaksi sebelum menghapus script yang melewati retensi", async () => {
  const oldRecord = voucherRecord("lama", "2026-11-03T00:00:00.000Z");
  const recentRecord = voucherRecord("baru", "2026-11-05T18:00:00.000Z");
  const stored = new Set();
  let cleanupRecords = [];
  const scheduler = new VoucherRevenueSyncScheduler({
    getVoucherUsageRecords: async () => [oldRecord, recentRecord],
    deleteVoucherUsageRecords: async (records) => {
      cleanupRecords = records;
      return { removed: records.length, skipped: 0, failed: 0 };
    },
  }, {
    getTimezone: () => "Asia/Jakarta",
    storeVoucherRevenueEntries: async (records) => {
      records.forEach((record) => stored.add(record.id));
      return { saved: records.length, observed: records.length, total: stored.size, batchesUpdated: 0 };
    },
    hasVoucherRevenueEntries: (ids) => ids.every((id) => stored.has(id)),
  }, { push() {} });

  const result = await scheduler.processSync({
    retentionHours: 24,
    now: new Date("2026-11-06T00:00:00.000Z"),
  });

  assert.equal(result.saved, 2);
  assert.deepEqual(cleanupRecords.map((record) => record.id), ["lama"]);
  assert.equal(result.cleanup.removed, 1);
});

test("script MikroTik tidak dihapus ketika verifikasi database gagal", async () => {
  let cleanupCalled = false;
  const scheduler = new VoucherRevenueSyncScheduler({
    getVoucherUsageRecords: async () => [voucherRecord("belum-aman", "2026-11-01T00:00:00.000Z")],
    deleteVoucherUsageRecords: async () => {
      cleanupCalled = true;
      return { removed: 1, skipped: 0, failed: 0 };
    },
  }, {
    getTimezone: () => "Asia/Jakarta",
    storeVoucherRevenueEntries: async () => ({ saved: 1, observed: 1, total: 0, batchesUpdated: 0 }),
    hasVoucherRevenueEntries: () => false,
  }, { push() {} });

  await assert.rejects(
    () => scheduler.processSync({ retentionHours: 0, now: new Date("2026-11-06T00:00:00.000Z") }),
    /Verifikasi penyimpanan/,
  );
  assert.equal(cleanupCalled, false);
});
