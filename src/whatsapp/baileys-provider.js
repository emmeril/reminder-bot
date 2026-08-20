const BaileysManager = require("../baileys-manager");
const { PROVIDER_STATES, WhatsAppProvider } = require("./whatsapp-provider");

const STATE_MAP = {
  READY: PROVIDER_STATES.READY,
  CONNECTING: PROVIDER_STATES.CONNECTING,
  RECONNECTING: PROVIDER_STATES.CONNECTING,
  PAIRING: PROVIDER_STATES.QR_REQUIRED,
  ERROR: PROVIDER_STATES.ERROR,
  AUTH_INVALID: PROVIDER_STATES.ERROR,
  DISABLED: PROVIDER_STATES.UNAVAILABLE,
  UNINITIALIZED: PROVIDER_STATES.DISCONNECTED,
  DISCONNECTED: PROVIDER_STATES.DISCONNECTED,
};

class BaileysProvider extends WhatsAppProvider {
  constructor(manager = BaileysManager) {
    super("baileys");
    this.manager = manager;
  }

  isConfigured() {
    return this.manager.isConfigured();
  }

  async connect() {
    return this.manager.initialize();
  }

  async disconnect() {
    return this.manager.shutdown();
  }

  async reconnect() {
    if (!this.isConfigured()) return this.getStatus();
    await this.manager.shutdown();
    await this.manager.initialize();
    return this.getStatus();
  }

  async checkConnection() {
    return this.manager.checkConnection();
  }

  async sendMessage(phone, message, options = {}) {
    return this.manager.sendMessage(phone, message, options);
  }

  async checkPhoneNumber(phone) {
    return this.manager.checkPhoneNumber(phone);
  }

  enableOutbound() {
    return this.manager.enableOutbound();
  }

  disableOutbound() {
    return this.manager.disableOutbound();
  }

  setDeliveryStatusHandler(handler) {
    return this.manager.setDeliveryStatusHandler?.(handler);
  }

  resetPairing(instanceId = null) {
    return this.manager.resetPairing(instanceId);
  }

  async getStatus() {
    const raw = this.manager.getStatus();
    const mappedState = STATE_MAP[raw.state] || PROVIDER_STATES.ERROR;
    const state = raw.isAvailable && raw.canSend !== true ? PROVIDER_STATES.CONNECTED : mappedState;
    return {
      ...raw,
      provider: this.name,
      state,
      rawState: raw.state,
      configured: this.isConfigured(),
      connected: raw.isAvailable === true,
      ready: raw.canSend === true,
      canSend: raw.canSend === true,
      detail: raw.isAvailable && raw.canSend !== true
        ? "Baileys terhubung; pengiriman masih dijeda"
        : (raw.transportError || raw.providers?.baileys?.connection?.detail || null),
      whatsapp: raw.deviceReady ? "ready" : "disconnected",
    };
  }
}

module.exports = BaileysProvider;
