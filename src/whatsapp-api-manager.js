const { CONFIG } = require("./config");
const { isValidPhoneNumber, normalizePhoneNumber } = require("./utils");

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

class WhatsAppApiManager {
  static sendQueue = Promise.resolve();

  static lastSentAt = 0;

  static connectionCache = {
    checkedAt: 0,
    connected: false,
    detail: "Status WhatsApp API belum diperiksa",
  };

  static isConfigured() {
    return Boolean(
      CONFIG.WHATSAPP_API_ENABLED
      && CONFIG.WHATSAPP_API_TOKEN
      && CONFIG.WHATSAPP_API_URL
    );
  }

  static getEndpoint(pathname) {
    const baseUrl = new URL(CONFIG.WHATSAPP_API_URL);
    baseUrl.pathname = `${baseUrl.pathname.replace(/\/+$/, "")}/${pathname.replace(/^\/+/, "")}`;
    return baseUrl.toString();
  }

  static async sendMessage(number, message, options = {}) {
    const queuedSend = this.sendQueue.then(() => this.sendWithRetry(number, message, options));
    this.sendQueue = queuedSend.catch(() => {});
    return queuedSend;
  }

  static async getDeviceStatus() {
    if (!this.isConfigured()) {
      throw new Error("API WhatsApp belum dikonfigurasi");
    }

    let response;
    try {
      response = await fetch(this.getEndpoint("device/status"), {
        headers: {
          Authorization: `Bearer ${CONFIG.WHATSAPP_API_TOKEN}`,
        },
        signal: AbortSignal.timeout(Math.max(1_000, Math.min(5_000, CONFIG.WHATSAPP_API_TIMEOUT))),
      });
    } catch (cause) {
      this.connectionCache = {
        checkedAt: Date.now(),
        connected: false,
        detail: cause.message,
      };
      throw new Error(`API WhatsApp gagal dihubungi: ${cause.message}`);
    }

    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }

    if (!response.ok || payload?.status === false) {
      const errorMessage = payload?.message || payload?.error || `HTTP ${response.status}`;
      this.connectionCache = {
        checkedAt: Date.now(),
        connected: false,
        detail: errorMessage,
      };
      throw new Error(`Gagal membaca status API WhatsApp: ${errorMessage}`);
    }

    const device = payload?.device || {};
    this.connectionCache = {
      checkedAt: Date.now(),
      connected: Boolean(device.ready),
      detail: device.ready
        ? "WhatsApp API terhubung"
        : device.lastError || `WhatsApp belum siap (state: ${device.state || "UNKNOWN"})`,
      device,
    };
    return device;
  }

  static async checkConnection(force = false) {
    if (!this.isConfigured()) {
      this.connectionCache = {
        checkedAt: Date.now(),
        connected: false,
        detail: "WhatsApp API belum dikonfigurasi",
      };
      return this.connectionCache;
    }

    if (!force && Date.now() - this.connectionCache.checkedAt < 15_000) {
      return this.connectionCache;
    }

    try {
      await this.getDeviceStatus();
    } catch {
      // getDeviceStatus updates the shared connection cache with the failure detail.
    }
    return this.connectionCache;
  }

  static getStatus() {
    return {
      name: "whatsapp-api",
      enabled: CONFIG.WHATSAPP_API_ENABLED,
      configured: this.isConfigured(),
      apiUrl: CONFIG.WHATSAPP_API_URL,
      connection: this.connectionCache,
    };
  }

  static async waitForSendSlot() {
    const minimumDelay = Math.max(0, CONFIG.WA_MESSAGE_DELAY);
    const elapsed = Date.now() - this.lastSentAt;
    const remainingDelay = Math.max(0, minimumDelay - elapsed);

    if (remainingDelay > 0) {
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

  static async sendWithRetry(number, message, options = {}) {
    const maximumAttempts = Math.max(1, Math.floor(CONFIG.WA_RETRY_MAX_ATTEMPTS));

    for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
      if (!options.skipMessageDelay) {
        await this.waitForSendSlot();
      }

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

    throw new Error("API WhatsApp gagal mengirim pesan setelah retry");
  }

  static async sendRequest(number, message) {
    if (!this.isConfigured()) {
      throw new Error("API WhatsApp belum dikonfigurasi");
    }

    const normalized = normalizePhoneNumber(number);
    if (!isValidPhoneNumber(normalized)) {
      throw new Error("Invalid target phone number");
    }

    let response;
    try {
      response = await fetch(this.getEndpoint("send"), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${CONFIG.WHATSAPP_API_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          target: normalized,
          message: String(message || ""),
        }),
        signal: AbortSignal.timeout(Math.max(1_000, CONFIG.WHATSAPP_API_TIMEOUT)),
      });
    } catch (cause) {
      this.connectionCache = {
        checkedAt: Date.now(),
        connected: false,
        detail: cause.message,
      };
      const error = new Error(`API WhatsApp gagal dihubungi: ${cause.message}`);
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
      const errorMessage = payload?.message || payload?.error || `HTTP ${response.status}`;
      this.connectionCache = {
        checkedAt: Date.now(),
        connected: false,
        detail: errorMessage,
      };
      const error = new Error(`API WhatsApp gagal mengirim pesan: ${errorMessage}`);
      error.retryable = response.status === 408 || response.status === 429 || response.status >= 500;
      throw error;
    }

    const responseData = payload?.data || {};
    this.connectionCache = {
      ...this.connectionCache,
      checkedAt: Date.now(),
      connected: true,
      detail: "WhatsApp API terhubung",
    };
    return {
      status: "success",
      provider: "whatsapp-api",
      message: payload?.message || "Pesan berhasil dikirim via API WhatsApp",
      messageId: responseData.id ?? payload?.id ?? null,
      target: responseData.target || normalized,
      timestamp: responseData.timestamp ?? null,
      type: responseData.type || "chat",
    };
  }
}

module.exports = WhatsAppApiManager;
