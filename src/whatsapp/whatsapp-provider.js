const PROVIDER_STATES = Object.freeze({
  CONNECTED: "CONNECTED",
  DISCONNECTED: "DISCONNECTED",
  CONNECTING: "CONNECTING",
  QR_REQUIRED: "QR_REQUIRED",
  READY: "READY",
  ERROR: "ERROR",
  UNAVAILABLE: "UNAVAILABLE",
});

class WhatsAppProviderError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "WhatsAppProviderError";
    this.code = code;
    this.retryable = options.retryable !== false;
    this.statusCode = options.statusCode || 503;
  }
}

class WhatsAppProvider {
  constructor(name) {
    if (new.target === WhatsAppProvider) {
      throw new TypeError("WhatsAppProvider adalah interface dan tidak dapat dibuat langsung");
    }
    this.name = name;
  }

  async connect() {
    throw new Error("connect() belum diimplementasikan");
  }

  async disconnect() {
    throw new Error("disconnect() belum diimplementasikan");
  }

  async getStatus() {
    throw new Error("getStatus() belum diimplementasikan");
  }

  async sendMessage(_phone, _message, _options = {}) {
    throw new Error("sendMessage() belum diimplementasikan");
  }

  async isReady() {
    const status = await this.getStatus();
    return status.state === PROVIDER_STATES.READY && status.canSend === true;
  }

  async reconnect() {
    await this.disconnect();
    return this.connect();
  }
}

module.exports = {
  PROVIDER_STATES,
  WhatsAppProvider,
  WhatsAppProviderError,
};
