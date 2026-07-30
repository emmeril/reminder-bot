const { CONFIG } = require("./config");
const FonnteApiManager = require("./fonnte-api-manager");
const WhatsAppApiManager = require("./whatsapp-api-manager");
const { isValidPhoneNumber, normalizePhoneNumber } = require("./utils");

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

class WhatsAppLoadBalancer {
  static providerCursor = 0;

  static providerCooldowns = new Map();

  static sendQueue = Promise.resolve();

  static lastActivity = null;

  static lastSentAt = 0;

  static getProviders() {
    return [
      { name: "whatsapp-api", manager: WhatsAppApiManager },
      { name: "fonnte", manager: FonnteApiManager },
    ];
  }

  static getConfiguredProviders() {
    return this.getProviders().filter(({ manager }) => manager.isConfigured());
  }

  static isConfigured() {
    return this.getConfiguredProviders().length > 0;
  }

  static getOrderedProviders() {
    const providers = this.getConfiguredProviders();
    if (providers.length === 0) return [];

    const startIndex = this.providerCursor % providers.length;
    this.providerCursor = (this.providerCursor + 1) % providers.length;
    const rotated = [...providers.slice(startIndex), ...providers.slice(0, startIndex)];
    const now = Date.now();

    return [
      ...rotated.filter(({ name }) => (this.providerCooldowns.get(name) || 0) <= now),
      ...rotated.filter(({ name }) => (this.providerCooldowns.get(name) || 0) > now),
    ];
  }

  static async sendMessage(number, message) {
    const queuedSend = this.sendQueue.then(() => this.sendWithFailover(number, message));
    this.sendQueue = queuedSend.catch(() => {});
    return queuedSend;
  }

  static async sendWithFailover(number, message) {
    const rawNumber = normalizePhoneNumber(number);
    const normalized = rawNumber.startsWith("0")
      ? `62${rawNumber.slice(1)}`
      : (rawNumber.startsWith("62") ? rawNumber : `62${rawNumber}`);
    if (!isValidPhoneNumber(normalized)) {
      throw new Error("Invalid target phone number");
    }

    const providers = this.getOrderedProviders();
    if (providers.length === 0) {
      throw new Error(
        "Provider WhatsApp belum dikonfigurasi. Aktifkan WhatsApp API atau isi token Fonnte."
      );
    }

    const minimumDelay = Math.max(0, CONFIG.WA_MESSAGE_DELAY);
    const remainingDelay = Math.max(0, minimumDelay - (Date.now() - this.lastSentAt));
    if (remainingDelay > 0) {
      const jitter = Math.floor(Math.random() * Math.max(1, minimumDelay * 0.25));
      await sleep(remainingDelay + jitter);
    }

    const errors = [];
    for (const { name, manager } of providers) {
      try {
        const result = await manager.sendMessage(normalized, message);
        this.providerCooldowns.delete(name);
        this.lastActivity = Date.now();
        this.lastSentAt = Date.now();
        return {
          ...result,
          failover: errors.length > 0,
          providersTried: [...errors.map(({ provider }) => provider), name],
          providerErrors: errors,
        };
      } catch (error) {
        const cooldownUntil = Date.now() + Math.max(0, CONFIG.WA_PROVIDER_COOLDOWN);
        this.providerCooldowns.set(name, cooldownUntil);
        errors.push({ provider: name, message: error.message });
      }
    }

    const detail = errors.map(({ provider, message: error }) => `${provider}: ${error}`).join("; ");
    this.lastSentAt = Date.now();
    const failure = new Error(`Semua provider WhatsApp gagal: ${detail}`);
    failure.providersTried = errors.map(({ provider }) => provider);
    throw failure;
  }

  static async checkConnections(force = false) {
    const checks = await Promise.all(
      this.getProviders().map(async ({ name, manager }) => [name, await manager.checkConnection(force)])
    );

    for (const [name, connection] of checks) {
      if (connection.connected) this.providerCooldowns.delete(name);
    }

    return Object.fromEntries(checks);
  }

  static getStatus() {
    const providers = this.getProviders();
    const configuredProviders = providers
      .filter(({ manager }) => manager.isConfigured())
      .map(({ name }) => name);
    const connectedProviders = providers
      .filter(({ manager }) => manager.isConfigured() && manager.connectionCache.connected)
      .map(({ name }) => name);
    const whatsappApiStatus = WhatsAppApiManager.getStatus();
    const fonnteStatus = FonnteApiManager.getStatus();
    const isAvailable = connectedProviders.length > 0;
    const connectionErrors = providers
      .filter(({ manager }) => manager.isConfigured() && !manager.connectionCache.connected)
      .map(({ name, manager }) => `${name}: ${manager.connectionCache.detail}`);

    return {
      state: isAvailable ? "READY" : (configuredProviders.length > 0 ? "NOT_READY" : "UNCONFIGURED"),
      isAvailable,
      deviceReady: isAvailable,
      hasClient: false,
      hasPage: false,
      reconnecting: false,
      reconnectAttempts: 0,
      pendingQueue: 0,
      failedQueue: 0,
      currentQR: false,
      lastActivity: this.lastActivity ? new Date(this.lastActivity).toISOString() : null,
      whatsappProviderEnabled: configuredProviders.length > 0,
      whatsappApiEnabled: whatsappApiStatus.configured,
      fonnteEnabled: fonnteStatus.configured,
      account: whatsappApiStatus.connection.device?.account || fonnteStatus.connection.device || null,
      transportError: isAvailable ? null : connectionErrors.join("; ") || null,
      providers: {
        whatsappApi: whatsappApiStatus,
        fonnte: fonnteStatus,
      },
      loadBalancer: {
        strategy: "round-robin-with-failover",
        configuredProviders,
        connectedProviders,
        cooldownMs: Math.max(0, CONFIG.WA_PROVIDER_COOLDOWN),
      },
    };
  }
}

module.exports = WhatsAppLoadBalancer;
