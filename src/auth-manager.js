const crypto = require("crypto");
const { CONFIG } = require("./config");
const { safeCompareString } = require("./utils");

class AuthManager {
  constructor(activityLog) {
    this.activityLog = activityLog;
    this.sessions = new Map();
  }

  cleanupExpiredSessions() {
    const now = Date.now();
    for (const [token, session] of this.sessions.entries()) {
      if (session.expiresAt <= now) {
        this.sessions.delete(token);
      }
    }
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

  destroySession(token) {
    if (!token) return;
    this.sessions.delete(token);
  }
}

module.exports = AuthManager;
