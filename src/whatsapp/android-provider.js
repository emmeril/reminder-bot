const { isValidPhoneNumber, normalizePhoneNumber } = require("../utils");
const { PROVIDER_STATES, WhatsAppProvider, WhatsAppProviderError } = require("./whatsapp-provider");

function assertLoopbackBridgeUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new WhatsAppProviderError("ANDROID_PROVIDER_UNAVAILABLE", "ANDROID_BRIDGE_URL tidak valid");
  }

  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "::1"].includes(url.hostname)) {
    throw new WhatsAppProviderError(
      "ANDROID_PROVIDER_UNAVAILABLE",
      "Android bridge wajib menggunakan HTTP loopback (127.0.0.1/localhost)"
    );
  }
  return url.toString().replace(/\/$/, "");
}

class AndroidProvider extends WhatsAppProvider {
  constructor(options = {}) {
    super("android");
    this.bridgeUrl = assertLoopbackBridgeUrl(options.bridgeUrl || "http://127.0.0.1:3030");
    this.bridgeToken = String(options.bridgeToken || "").trim();
    this.timeoutMs = Math.max(1000, Number(options.timeoutMs) || 15000);
    this.fetch = options.fetch || global.fetch;
    this.statusCache = this.unavailableStatus("Android bridge belum diperiksa");
  }

  unavailableStatus(detail, patch = {}) {
    return {
      provider: this.name,
      state: PROVIDER_STATES.UNAVAILABLE,
      configured: true,
      connected: false,
      ready: false,
      canSend: false,
      outboundEnabled: false,
      detail,
      waydroid: "unknown",
      whatsapp: "unknown",
      bridge: "disconnected",
      whatsappInstalled: false,
      whatsappRunning: false,
      ...patch,
    };
  }

  async request(pathname, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs || this.timeoutMs);
    timer.unref?.();
    try {
      const response = await this.fetch(`${this.bridgeUrl}${pathname}`, {
        ...options,
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          ...(this.bridgeToken ? { authorization: `Bearer ${this.bridgeToken}` } : {}),
          ...(options.headers || {}),
        },
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new WhatsAppProviderError(
          payload.code || "ANDROID_PROVIDER_UNAVAILABLE",
          payload.error || `Android bridge merespons HTTP ${response.status}`,
          { retryable: payload.retryable !== false, statusCode: response.status }
        );
      }
      return payload;
    } catch (error) {
      if (error instanceof WhatsAppProviderError) throw error;
      const detail = error.name === "AbortError"
        ? `Android bridge timeout setelah ${options.timeoutMs || this.timeoutMs}ms`
        : `Android bridge tidak dapat dihubungi: ${error.message}`;
      throw new WhatsAppProviderError("ANDROID_PROVIDER_UNAVAILABLE", detail, { cause: error });
    } finally {
      clearTimeout(timer);
    }
  }

  normalizeStatus(payload = {}) {
    const ready = payload.ready === true
      && payload.waydroid === "running"
      && payload.whatsappInstalled === true
      && payload.whatsappRunning === true
      && payload.bridge === "connected";
    let state = PROVIDER_STATES.UNAVAILABLE;
    if (ready) state = PROVIDER_STATES.READY;
    else if (payload.state === "connecting") state = PROVIDER_STATES.CONNECTING;
    else if (payload.error) state = PROVIDER_STATES.ERROR;

    return {
      provider: this.name,
      state,
      configured: true,
      connected: ready,
      ready,
      canSend: ready,
      outboundEnabled: ready,
      detail: payload.detail || payload.error || (ready ? "WhatsApp Android siap" : "WhatsApp Android belum siap"),
      waydroid: payload.waydroid || "unknown",
      whatsapp: ready ? "ready" : (payload.whatsappRunning ? "running" : "stopped"),
      bridge: payload.bridge || "disconnected",
      whatsappInstalled: payload.whatsappInstalled === true,
      whatsappRunning: payload.whatsappRunning === true,
      appium: payload.appium || "unknown",
      checkedAt: payload.checkedAt || new Date().toISOString(),
    };
  }

  async connect() {
    return this.getStatus({ refresh: true });
  }

  async disconnect() {
    this.statusCache = this.unavailableStatus("Android provider dihentikan");
    return this.statusCache;
  }

  async getStatus() {
    try {
      const payload = await this.request("/v1/status", { method: "GET" });
      this.statusCache = this.normalizeStatus(payload);
    } catch (error) {
      this.statusCache = this.unavailableStatus(error.message, {
        errorCode: error.code || "ANDROID_PROVIDER_UNAVAILABLE",
      });
    }
    return this.statusCache;
  }

  async sendMessage(phone, message) {
    const normalized = normalizePhoneNumber(phone);
    const content = String(message || "").trim();
    if (!isValidPhoneNumber(normalized)) {
      throw new WhatsAppProviderError("INVALID_PHONE", "Nomor tujuan WhatsApp tidak valid", {
        retryable: false,
        statusCode: 400,
      });
    }
    if (!content || content.length > 4096) {
      throw new WhatsAppProviderError("INVALID_MESSAGE", "Pesan wajib diisi dan maksimal 4096 karakter", {
        retryable: false,
        statusCode: 400,
      });
    }

    const status = await this.getStatus();
    if (!status.ready) {
      throw new WhatsAppProviderError(
        "ANDROID_PROVIDER_UNAVAILABLE",
        status.detail || "WhatsApp Android belum siap"
      );
    }

    const result = await this.request("/v1/messages", {
      method: "POST",
      timeoutMs: Math.max(this.timeoutMs, 60000),
      body: JSON.stringify({ phone: normalized, message: content }),
    });
    if (result.confirmed !== true || !result.messageId) {
      throw new WhatsAppProviderError(
        "ANDROID_SEND_UNCONFIRMED",
        result.error || "Bridge tidak memberikan konfirmasi pesan terkirim"
      );
    }

    return {
      status: "success",
      provider: this.name,
      message: "Pesan dikonfirmasi terkirim melalui WhatsApp Android",
      messageId: result.messageId,
      providerMessageId: result.providerMessageId || result.messageId,
      target: normalized,
      timestamp: result.confirmedAt || new Date().toISOString(),
      confirmed: true,
      type: "chat",
    };
  }
}

module.exports = AndroidProvider;
module.exports.assertLoopbackBridgeUrl = assertLoopbackBridgeUrl;
