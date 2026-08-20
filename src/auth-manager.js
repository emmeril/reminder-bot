const crypto = require("crypto");
const { CONFIG } = require("./config");
const { safeCompareString } = require("./utils");

class AuthManager {
  constructor(activityLog) {
    this.activityLog = activityLog;
    this.sessions = new Map();
    this.customerSessions = new Map();
    this.loginAttempts = new Map();
  }

  cleanupExpiredSessions() {
    const now = Date.now();
    this.cleanupSessionStore(this.sessions, now);
    this.cleanupSessionStore(this.customerSessions, now);

    for (const [key, attempt] of this.loginAttempts.entries()) {
      if (this.isLoginAttemptExpired(attempt, now)) {
        this.loginAttempts.delete(key);
      }
    }
  }

  cleanupSessionStore(store, now) {
    for (const [token, session] of store.entries()) {
      if (session.expiresAt <= now) store.delete(token);
    }
  }

  isLoginAttemptExpired(attempt, now = Date.now()) {
    return attempt.blockedUntil <= now
      && now - attempt.firstAttemptAt > CONFIG.AUTH_LOGIN_WINDOW;
  }

  getLoginAttemptKey(identifier) {
    return String(identifier || "unknown").slice(0, 256);
  }

  getLoginAttempt(identifier) {
    const key = this.getLoginAttemptKey(identifier);
    const now = Date.now();
    const current = this.loginAttempts.get(key);

    if (!current || this.isLoginAttemptExpired(current, now)) {
      this.loginAttempts.delete(key);
      return null;
    }

    return current;
  }

  isLoginBlocked(identifier) {
    const attempt = this.getLoginAttempt(identifier);
    return Boolean(attempt && attempt.blockedUntil > Date.now());
  }

  recordLoginFailure(identifier) {
    const key = this.getLoginAttemptKey(identifier);
    const now = Date.now();
    const maximumAttempts = Math.max(1, Math.floor(CONFIG.AUTH_MAX_LOGIN_ATTEMPTS));
    const current = this.getLoginAttempt(key);
    const attempt = current || {
      count: 0,
      firstAttemptAt: now,
      blockedUntil: 0,
    };

    attempt.count += 1;
    if (attempt.count >= maximumAttempts) {
      attempt.blockedUntil = now + Math.max(1_000, CONFIG.AUTH_LOGIN_LOCKOUT);
    }
    this.loginAttempts.set(key, attempt);
    return attempt;
  }

  clearLoginFailures(identifier) {
    this.loginAttempts.delete(this.getLoginAttemptKey(identifier));
  }

  validateCredentials(username, password) {
    return safeCompareString(username, CONFIG.AUTH_USERNAME)
      && safeCompareString(password, CONFIG.AUTH_PASSWORD);
  }

  createStoredSession(store, identity, sessionData) {
    this.cleanupExpiredSessions();
    const now = Date.now();
    const token = crypto
      .createHmac("sha256", CONFIG.SESSION_SECRET)
      .update(`${identity}:${now}:${crypto.randomBytes(16).toString("hex")}`)
      .digest("hex");

    const session = {
      ...sessionData,
      createdAt: now,
      expiresAt: now + CONFIG.SESSION_TTL,
    };

    store.set(token, session);
    return { token, session };
  }

  createSession(username) {
    return this.createStoredSession(this.sessions, username, { username });
  }

  createCustomerSession(customer) {
    const username = String(customer.username || "");
    const contactId = String(customer.contactId || "");
    return this.createStoredSession(
      this.customerSessions,
      `customer:${contactId}:${username}`,
      {
        type: "customer",
        username,
        contactId,
      }
    );
  }

  getStoredSession(store, token) {
    if (!token) return null;
    this.cleanupExpiredSessions();
    const session = store.get(token);
    const now = Date.now();

    if (!session || session.expiresAt <= now) {
      if (session) store.delete(token);
      return null;
    }

    session.expiresAt = now + CONFIG.SESSION_TTL;
    return session;
  }

  getSession(token) {
    return this.getStoredSession(this.sessions, token);
  }

  getCustomerSession(token) {
    return this.getStoredSession(this.customerSessions, token);
  }

  destroySession(token) {
    if (!token) return;
    this.sessions.delete(token);
  }

  destroyCustomerSession(token) {
    if (!token) return;
    this.customerSessions.delete(token);
  }

  destroyCustomerSessionsForContact(contactId, exceptToken = null) {
    const normalizedContactId = String(contactId || "");
    if (!normalizedContactId) return 0;
    let destroyed = 0;
    for (const [token, session] of this.customerSessions.entries()) {
      if (token === exceptToken || String(session.contactId || "") !== normalizedContactId) continue;
      this.customerSessions.delete(token);
      destroyed += 1;
    }
    return destroyed;
  }
}

module.exports = AuthManager;
