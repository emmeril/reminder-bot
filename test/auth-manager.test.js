const assert = require("node:assert/strict");
const { afterEach, test } = require("node:test");

const AuthManager = require("../src/auth-manager");
const { CONFIG } = require("../src/config");

const originalConfig = {
  AUTH_MAX_LOGIN_ATTEMPTS: CONFIG.AUTH_MAX_LOGIN_ATTEMPTS,
  AUTH_LOGIN_WINDOW: CONFIG.AUTH_LOGIN_WINDOW,
  AUTH_LOGIN_LOCKOUT: CONFIG.AUTH_LOGIN_LOCKOUT,
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
  const { token } = manager.createCustomerSession({
    username: "pelanggan_satu",
    contactId: "contact-1",
  });

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
