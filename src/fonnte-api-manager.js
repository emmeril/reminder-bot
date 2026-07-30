const { CONFIG } = require("./config");
const { isValidPhoneNumber, normalizePhoneNumber } = require("./utils");

class FonnteApiManager {
  static connectionCache = {
    checkedAt: 0,
    connected: false,
    detail: "Status Fonnte belum diperiksa",
  };

  static isConfigured() {
    return Boolean(CONFIG.FONNTE_ENABLED && CONFIG.FONNTE_TOKEN);
  }

  static getEndpoint(pathname) {
    const baseUrl = new URL(CONFIG.FONNTE_API_URL);
    baseUrl.pathname = `${baseUrl.pathname.replace(/\/+$/, "")}/${pathname.replace(/^\/+/, "")}`;
    return baseUrl.toString();
  }

  static getHeaders(contentType) {
    return {
      Authorization: CONFIG.FONNTE_TOKEN,
      ...(contentType ? { "Content-Type": contentType } : {}),
    };
  }

  static async readPayload(response) {
    try {
      return await response.json();
    } catch {
      return null;
    }
  }

  static async checkConnection(force = false) {
    if (!this.isConfigured()) {
      this.connectionCache = {
        checkedAt: Date.now(),
        connected: false,
        detail: "Fonnte belum dikonfigurasi",
      };
      return this.connectionCache;
    }

    const now = Date.now();
    if (!force && now - this.connectionCache.checkedAt < 15_000) {
      return this.connectionCache;
    }

    try {
      const response = await fetch(this.getEndpoint("device"), {
        method: "POST",
        headers: this.getHeaders(),
        signal: AbortSignal.timeout(Math.max(1_000, CONFIG.FONNTE_API_TIMEOUT)),
      });
      const payload = await this.readPayload(response);
      const deviceStatus = String(
        payload?.device_status || payload?.device?.status || payload?.status || ""
      ).toLowerCase();
      const connected = response.ok
        && payload?.status !== false
        && !["disconnect", "disconnected", "offline"].includes(deviceStatus);

      this.connectionCache = {
        checkedAt: now,
        connected,
        detail: connected
          ? "Fonnte terhubung"
          : payload?.reason || payload?.detail || payload?.message
            || `Fonnte belum siap (state: ${deviceStatus || "UNKNOWN"})`,
        device: payload?.device || payload?.device_number || null,
        deviceStatus: deviceStatus || null,
      };
    } catch (cause) {
      this.connectionCache = {
        checkedAt: now,
        connected: false,
        detail: `Gagal memeriksa koneksi Fonnte: ${cause.message}`,
      };
    }

    return this.connectionCache;
  }

  static getStatus() {
    return {
      name: "fonnte",
      enabled: CONFIG.FONNTE_ENABLED,
      configured: this.isConfigured(),
      apiUrl: CONFIG.FONNTE_API_URL,
      connection: this.connectionCache,
    };
  }

  static async sendMessage(number, message) {
    if (!this.isConfigured()) {
      throw new Error("Fonnte belum dikonfigurasi");
    }

    const normalized = normalizePhoneNumber(number);
    if (!isValidPhoneNumber(normalized)) {
      throw new Error("Invalid target phone number");
    }

    const body = new URLSearchParams({
      target: normalized,
      message: String(message || ""),
      countryCode: "62",
    });

    let response;
    try {
      response = await fetch(this.getEndpoint("send"), {
        method: "POST",
        headers: this.getHeaders("application/x-www-form-urlencoded"),
        body: body.toString(),
        signal: AbortSignal.timeout(Math.max(1_000, CONFIG.FONNTE_API_TIMEOUT)),
      });
    } catch (cause) {
      this.connectionCache = {
        checkedAt: Date.now(),
        connected: false,
        detail: cause.message,
      };
      throw new Error(`Fonnte gagal dihubungi: ${cause.message}`);
    }

    const payload = await this.readPayload(response);
    if (!response.ok || payload?.status !== true) {
      const detail = payload?.reason || payload?.detail || payload?.message || `HTTP ${response.status}`;
      this.connectionCache = {
        checkedAt: Date.now(),
        connected: false,
        detail,
      };
      throw new Error(`Fonnte gagal mengirim pesan: ${detail}`);
    }

    const messageId = Array.isArray(payload.id) ? payload.id[0] : payload.id || null;
    const target = Array.isArray(payload.target) ? payload.target[0] : payload.target || normalized;
    this.connectionCache = {
      ...this.connectionCache,
      checkedAt: Date.now(),
      connected: true,
      detail: "Fonnte terhubung",
    };

    return {
      status: "success",
      provider: "fonnte",
      message: payload.detail || payload.message || "Pesan masuk antrean Fonnte",
      messageId,
      target,
      timestamp: null,
      type: "chat",
    };
  }
}

module.exports = FonnteApiManager;
