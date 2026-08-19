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
    for (const [token, session] of this.sessions.entries()) {
      if (session.expiresAt <= now) {
        this.sessions.delete(token);
      }
    }

    for (const [token, session] of this.customerSessions.entries()) {
      if (session.expiresAt <= now) {
        this.customerSessions.delete(token);
      }
    }

    for (const [key, attempt] of this.loginAttempts.entries()) {
      if (attempt.blockedUntil <= now && now - attempt.firstAttemptAt > CONFIG.AUTH_LOGIN_WINDOW) {
        this.loginAttempts.delete(key);
      }
    }
  }

  getLoginAttemptKey(identifier) {
    return String(identifier || "unknown").slice(0, 256);
  }

  getLoginAttempt(identifier) {
    const key = this.getLoginAttemptKey(identifier);
    const now = Date.now();
    const current = this.loginAttempts.get(key);

    if (!current || (current.blockedUntil <= now && now - current.firstAttemptAt > CONFIG.AUTH_LOGIN_WINDOW)) {
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

  createSession(username) {
    this.cleanupExpiredSessions();
    const token = crypto
      .createHmac("sha256", CONFIG.SESSION_SECRET)
      .update(`${username}:${Date.now()}:${crypto.randomBytes(16).toString("hex")}`)
      .digest("hex");

    const session = {
      username,
      createdAt: Date.now(),
      expiresAt: Date.now() + CONFIG.SESSION_TTL,
    };

    this.sessions.set(token, session);
    return { token, session };
  }

  createCustomerSession(customer) {
    this.cleanupExpiredSessions();
    const username = String(customer.username || "");
    const contactId = String(customer.contactId || "");
    const token = crypto
      .createHmac("sha256", CONFIG.SESSION_SECRET)
      .update(`customer:${contactId}:${username}:${Date.now()}:${crypto.randomBytes(16).toString("hex")}`)
      .digest("hex");

    const session = {
      type: "customer",
      username,
      contactId,
      createdAt: Date.now(),
      expiresAt: Date.now() + CONFIG.SESSION_TTL,
    };

    this.customerSessions.set(token, session);
    return { token, session };
  }

  getSession(token) {
    if (!token) return null;
    this.cleanupExpiredSessions();
    const session = this.sessions.get(token);
    if (!session) return null;
    if (session.expiresAt <= Date.now()) {
      this.sessions.delete(token);
      return null;
    }
    session.expiresAt = Date.now() + CONFIG.SESSION_TTL;
    return session;
  }

  getCustomerSession(token) {
    if (!token) return null;
    this.cleanupExpiredSessions();
    const session = this.customerSessions.get(token);
    if (!session) return null;
    if (session.expiresAt <= Date.now()) {
      this.customerSessions.delete(token);
      return null;
    }
    session.expiresAt = Date.now() + CONFIG.SESSION_TTL;
    return session;
  }

  destroySession(token) {
    if (!token) return;
    this.sessions.delete(token);
  }

  destroyCustomerSession(token) {
    if (!token) return;
    this.customerSessions.delete(token);
  }
}

module.exports = AuthManager;
