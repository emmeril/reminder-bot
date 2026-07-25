const { CONFIG } = require("./config");
const { isValidPhoneNumber, normalizePhoneNumber } = require("./utils");

const sleep = (milliseconds) => new Promise(resolve => setTimeout(resolve, milliseconds));

class FonnteManager {
  static sendQueue = Promise.resolve();

  static lastSentAt = 0;

  static isConfigured() {
    return (CONFIG.FONNTE_ENABLED || CONFIG.FONNTE_BACKUP_ENABLED) && Boolean(CONFIG.FONNTE_TOKEN);
  }

  static async sendMessage(number, message) {
    const queuedSend = this.sendQueue.then(() => this.sendWithRetry(number, message));
    this.sendQueue = queuedSend.catch(() => {});
    return queuedSend;
  }

  static async waitForSendSlot() {
    const minimumDelay = Math.max(0, CONFIG.WA_MESSAGE_DELAY);
    const elapsed = Date.now() - this.lastSentAt;
    const remainingDelay = Math.max(0, minimumDelay - elapsed);

    if (remainingDelay > 0) {
      // Jitter avoids every outbound request having an identical interval.
      const jitter = Math.floor(Math.random() * Math.max(1, minimumDelay * 0.25));
      await sleep(remainingDelay + jitter);
    }
  }

  static getRetryDelay(attempt) {
    const baseDelay = Math.max(0, CONFIG.WA_RETRY_BASE_DELAY);
    const maximumDelay = Math.max(baseDelay, CONFIG.WA_RETRY_MAX_DELAY);
    const exponentialDelay = Math.min(maximumDelay, baseDelay * (2 ** (attempt - 1)));
    const jitter = Math.floor(Math.random() * Math.max(1, exponentialDelay * 0.25));
    return exponentialDelay + jitter;
  }

  static async sendWithRetry(number, message) {
    const maximumAttempts = Math.max(1, Math.floor(CONFIG.WA_RETRY_MAX_ATTEMPTS));

    for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
      await this.waitForSendSlot();

      try {
        const result = await this.sendRequest(number, message);
        this.lastSentAt = Date.now();
        return { ...result, attempts: attempt };
      } catch (error) {
        this.lastSentAt = Date.now();
        if (!error.retryable || attempt >= maximumAttempts) throw error;
        await sleep(this.getRetryDelay(attempt));
      }
    }

    throw new Error("Fonnte gagal mengirim pesan setelah retry");
  }

  static async sendRequest(number, message) {
    if (!this.isConfigured()) {
      throw new Error("Fonnte is not configured");
    }

    const normalized = normalizePhoneNumber(number);
    if (!isValidPhoneNumber(normalized)) {
      throw new Error("Invalid target phone number");
    }

    const formData = new FormData();
    formData.append("target", normalized);
    formData.append("message", String(message || ""));

    let response;
    try {
      response = await fetch(CONFIG.FONNTE_API_URL, {
        method: "POST",
        headers: {
          Authorization: CONFIG.FONNTE_TOKEN,
        },
        body: formData,
      });
    } catch (cause) {
      const error = new Error(`Fonnte gagal dihubungi: ${cause.message}`);
      error.retryable = true;
      throw error;
    }

    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }

    if (!response.ok || payload?.status === false) {
      const errorMessage = payload?.reason
        || payload?.detail
        || payload?.message
        || `HTTP ${response.status}`;
      const error = new Error(`Fonnte gagal mengirim pesan: ${errorMessage}`);
      error.retryable = response.status === 429 || response.status >= 500;
      throw error;
    }

    return {
      status: "success",
      provider: "fonnte",
      message: payload.detail || "Message sent via Fonnte",
      messageId: Array.isArray(payload.id) ? payload.id[0] : payload.id,
      requestId: payload.requestid,
    };
  }
}

module.exports = FonnteManager;
