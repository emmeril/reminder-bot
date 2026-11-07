const assert = require("node:assert/strict");
const test = require("node:test");
const {
  generatePortalPassword,
  hashPortalPassword,
  isPortalPasswordHash,
  verifyPortalPassword,
} = require("../src/portal-password");

test("scrypt menyimpan hash berbeda meskipun password sama", async () => {
  const first = await hashPortalPassword("rahasia-portal");
  const second = await hashPortalPassword("rahasia-portal");
  assert.equal(isPortalPasswordHash(first), true);
  assert.notEqual(first, second);
  assert.equal(await verifyPortalPassword("rahasia-portal", first), true);
  assert.equal(await verifyPortalPassword("salah", first), false);
});

test("password sementara acak dan tidak sama dengan hotspot lima digit", () => {
  const first = generatePortalPassword();
  const second = generatePortalPassword();
  assert.match(first, /^[A-Za-z0-9_-]{24}$/);
  assert.notEqual(first, second);
});

test("hash rusak gagal diverifikasi tanpa exception", async () => {
  assert.equal(await verifyPortalPassword("rahasia", "scrypt:v1:abc:wrong"), false);
  assert.equal(await verifyPortalPassword("", "scrypt:v1:abc:wrong"), false);
});

test("password lama tetap bisa diverifikasi sebelum migrasi", async () => {
  assert.equal(await verifyPortalPassword("password-lama", "password-lama"), true);
  assert.equal(await verifyPortalPassword("lain", "password-lama"), false);
});
