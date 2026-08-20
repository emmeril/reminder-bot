const assert = require("node:assert/strict");
const { afterEach, test } = require("node:test");

const AuthManager = require("../src/auth-manager");
const { CONFIG } = require("../src/config");

const originalConfig = {
  AUTH_MAX_LOGIN_ATTEMPTS: CONFIG.AUTH_MAX_LOGIN_ATTEMPTS,
  AUTH_LOGIN_WINDOW: CONFIG.AUTH_LOGIN_WINDOW,
  AUTH_LOGIN_LOCKOUT: CONFIG.AUTH_LOGIN_LOCKOUT,
  SESSION_TTL: CONFIG.SESSION_TTL,
};

afterEach(() => {
  Object.assign(CONFIG, originalConfig);
});

test("memblokir percobaan login berulang dan mereset blokir setelah login sukses", () => {
  Object.assign(CONFIG, {
    AUTH_MAX_LOGIN_ATTEMPTS: 2,
    AUTH_LOGIN_WINDOW: 60_000,
    AUTH_LOGIN_LOCKOUT: 60_000,
  });
  const manager = new AuthManager({ push() {} });

  manager.recordLoginFailure("127.0.0.1");
  assert.equal(manager.isLoginBlocked("127.0.0.1"), false);

  manager.recordLoginFailure("127.0.0.1");
  assert.equal(manager.isLoginBlocked("127.0.0.1"), true);

  manager.clearLoginFailures("127.0.0.1");
  assert.equal(manager.isLoginBlocked("127.0.0.1"), false);
});

test("sesi pelanggan terpisah dari sesi administrator", () => {
  const manager = new AuthManager({ push() {} });
  const admin = manager.createSession("admin");
  const { token } = manager.createCustomerSession({
    username: "pelanggan_satu",
    contactId: "contact-1",
  });

  assert.equal(manager.getCustomerSession(admin.token), null);
  assert.equal(manager.getSession(token), null);
  assert.equal(manager.getCustomerSession(token).contactId, "contact-1");

  manager.destroyCustomerSession(token);
  assert.equal(manager.getCustomerSession(token), null);
});

test("perubahan password dapat mengakhiri sesi pelanggan lain pada akun yang sama", () => {
  const manager = new AuthManager({ push() {} });
  const first = manager.createCustomerSession({ username: "pelanggan_satu", contactId: "contact-1" });
  const second = manager.createCustomerSession({ username: "pelanggan_satu", contactId: "contact-1" });
  const other = manager.createCustomerSession({ username: "pelanggan_dua", contactId: "contact-2" });

  assert.equal(manager.destroyCustomerSessionsForContact("contact-1", first.token), 1);
  assert.ok(manager.getCustomerSession(first.token));
  assert.equal(manager.getCustomerSession(second.token), null);
  assert.ok(manager.getCustomerSession(other.token));
});

test("sesi kedaluwarsa dibersihkan dan sesi aktif memperpanjang masa berlaku", () => {
  CONFIG.SESSION_TTL = 1_000;
  const manager = new AuthManager({ push() {} });
  const originalNow = Date.now;
  let now = 10_000;
  Date.now = () => now;

  try {
    const active = manager.createSession("admin");
    const expired = manager.createCustomerSession({
      username: "pelanggan_satu",
      contactId: "contact-1",
    });

    now = 10_500;
    assert.equal(manager.getSession(active.token).expiresAt, 11_500);

    now = 11_001;
    manager.cleanupExpiredSessions();
    assert.equal(manager.getCustomerSession(expired.token), null);
    assert.ok(manager.getSession(active.token));
  } finally {
    Date.now = originalNow;
  }
});
