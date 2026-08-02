const assert = require("node:assert/strict");
const test = require("node:test");

const {
  getDateTimePartsInTimezone,
  isValidTimeZone,
} = require("../src/utils");

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
