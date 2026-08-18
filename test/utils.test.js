const assert = require("node:assert/strict");
const test = require("node:test");

const {
  assertSecureConfiguration,
  getBillingPeriodKey,
  getDateTimePartsInTimezone,
  isValidTimeZone,
  parseDateTimeInput,
} = require("../src/utils");
const { CONFIG } = require("../src/config");

test("menggunakan format 00:00 untuk tengah malam di timezone aplikasi", () => {
  const midnightJakarta = new Date("2026-08-01T17:00:00.000Z");
  const parts = getDateTimePartsInTimezone(midnightJakarta, "Asia/Jakarta");

  assert.equal(parts.dateKey, "2026-08-02");
  assert.equal(parts.timeKey, "00:00");
});

test("memvalidasi nama timezone IANA", () => {
  assert.equal(isValidTimeZone("Asia/Jakarta"), true);
  assert.equal(isValidTimeZone("timezone-tidak-valid"), false);
});

test("mem-parsing jadwal berdasarkan timezone aplikasi, bukan timezone proses", () => {
  const parsed = parseDateTimeInput("2026-08-02 10:00", "Asia/Jakarta");
  assert.equal(parsed.toISOString(), "2026-08-02T03:00:00.000Z");
});

test("periode tagihan mengikuti batas bulan timezone aplikasi", () => {
  const instant = new Date("2026-07-31T17:30:00.000Z");
  assert.equal(getBillingPeriodKey(instant, "Asia/Jakarta"), "2026-08");
  assert.equal(getBillingPeriodKey(instant, "UTC"), "2026-07");
});

test("menolak startup tanpa kredensial dashboard eksplisit", () => {
  const original = {
    WEB_API_KEY: CONFIG.WEB_API_KEY,
    AUTH_USERNAME: CONFIG.AUTH_USERNAME,
    AUTH_PASSWORD: CONFIG.AUTH_PASSWORD,
    SESSION_SECRET: CONFIG.SESSION_SECRET,
  };
  try {
    Object.assign(CONFIG, { AUTH_USERNAME: "", AUTH_PASSWORD: "", SESSION_SECRET: "" });
    assert.throws(() => assertSecureConfiguration(), /Konfigurasi keamanan tidak valid/);
  } finally {
    Object.assign(CONFIG, original);
  }
});

test("menolak API key pendek ketika akses API key diaktifkan", () => {
  const original = {
    WEB_API_KEY: CONFIG.WEB_API_KEY,
    AUTH_USERNAME: CONFIG.AUTH_USERNAME,
    AUTH_PASSWORD: CONFIG.AUTH_PASSWORD,
    SESSION_SECRET: CONFIG.SESSION_SECRET,
  };
  try {
    Object.assign(CONFIG, {
      WEB_API_KEY: "short-key",
      AUTH_USERNAME: "operator",
      AUTH_PASSWORD: "password-yang-kuat",
      SESSION_SECRET: "a".repeat(32),
    });
    assert.throws(() => assertSecureConfiguration(), /WEB_API_KEY/);
  } finally {
    Object.assign(CONFIG, original);
  }
});
