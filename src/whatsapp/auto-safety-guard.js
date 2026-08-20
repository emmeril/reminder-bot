const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

// Conservative defaults are intentionally internal so the transport is safe
// immediately after installation without requiring environment changes.
const DEFAULTS = Object.freeze({
  minGlobalGapMs: 1_500,
  recipientCooldownMs: 30_000,
  maxPerMinute: 20,
  maxPerHour: 200,
  reachoutPauseMs: 15 * MINUTE_MS,
});

class AutoSafetyGuard {
  constructor(options = {}) {
    this.limits = { ...DEFAULTS, ...options };
    this.lastSendAt = 0;
    this.recipientSends = new Map();
    this.attempts = [];
    this.pausedUntil = 0;
  }

  setLimits(options = {}) {
    this.limits = { ...this.limits, ...options };
    return this.limits;
  }

  reset() {
    this.lastSendAt = 0;
    this.recipientSends.clear();
    this.attempts = [];
    this.pausedUntil = 0;
  }

  prune(now = Date.now()) {
    const cutoff = now - HOUR_MS;
    this.attempts = this.attempts.filter((entry) => entry.at <= now && entry.at >= cutoff);
    for (const [recipient, timestamp] of this.recipientSends) {
      if (timestamp < cutoff) this.recipientSends.delete(recipient);
    }
  }

  getPauseRemaining(now = Date.now()) {
    return Math.max(0, this.pausedUntil - now);
  }

  getDelayMs(recipient, now = Date.now()) {
    this.prune(now);
    const key = String(recipient || "");
    let delay = Math.max(0, this.limits.minGlobalGapMs - (now - this.lastSendAt));
    const recipientAt = this.recipientSends.get(key) || 0;
    delay = Math.max(delay, this.limits.recipientCooldownMs - (now - recipientAt));

    const minuteAttempts = this.attempts.filter((entry) => entry.at >= now - MINUTE_MS);
    if (minuteAttempts.length >= this.limits.maxPerMinute) {
      delay = Math.max(delay, minuteAttempts[0].at + MINUTE_MS - now);
    }

    if (this.attempts.length >= this.limits.maxPerHour) {
      delay = Math.max(delay, this.attempts[0].at + HOUR_MS - now);
    }
    return Math.max(0, delay);
  }

  markAttempt(recipient, now = Date.now()) {
    const key = String(recipient || "");
    this.lastSendAt = now;
    this.recipientSends.set(key, now);
    this.attempts.push({ at: now, recipient: key });
    this.prune(now);
  }

  pauseForReachout(now = Date.now()) {
    this.pausedUntil = Math.max(this.pausedUntil, now + this.limits.reachoutPauseMs);
    return this.pausedUntil;
  }

  getStatus(now = Date.now()) {
    this.prune(now);
    return {
      enabled: true,
      paused: this.getPauseRemaining(now) > 0,
      pauseUntil: this.pausedUntil ? new Date(this.pausedUntil).toISOString() : null,
      pauseRemainingMs: this.getPauseRemaining(now),
      attemptsLastMinute: this.attempts.filter((entry) => entry.at >= now - MINUTE_MS).length,
      attemptsLastHour: this.attempts.length,
      nextAllowedInMs: this.getDelayMs("", now),
      limits: { ...this.limits },
    };
  }
}

module.exports = AutoSafetyGuard;
module.exports.DEFAULTS = DEFAULTS;
