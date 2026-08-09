const { CONFIG } = require("../config");
const AndroidProvider = require("./android-provider");
const BaileysProvider = require("./baileys-provider");
const WhatsAppQueue = require("./whatsapp-queue");

const ALLOWED_PROVIDERS = new Set(["baileys", "android"]);

class WhatsAppProviderManager {
  constructor(options = {}) {
    this.activityLog = options.activityLog || null;
    this.getSelectedProvider = options.getSelectedProvider || (() => CONFIG.WHATSAPP_PROVIDER);
    this.providers = options.providers || {
      baileys: new BaileysProvider(),
      android: new AndroidProvider({
        bridgeUrl: CONFIG.ANDROID_BRIDGE_URL,
        bridgeToken: CONFIG.ANDROID_BRIDGE_TOKEN,
        timeoutMs: CONFIG.ANDROID_BRIDGE_TIMEOUT,
      }),
    };
    this.selected = null;
    this.lastObserved = new Map();
    this.queue = options.queue || new WhatsAppQueue({
      concurrency: CONFIG.WHATSAPP_QUEUE_CONCURRENCY,
      retryLimit: CONFIG.WHATSAPP_RETRY_LIMIT,
      retryDelayMs: CONFIG.WHATSAPP_RETRY_DELAY * 1000,
      activityLog: this.activityLog,
    });
  }

  static normalizeProvider(value) {
    const provider = String(value || "").trim().toLowerCase();
    if (!ALLOWED_PROVIDERS.has(provider)) {
      const error = new Error("WhatsApp provider harus 'baileys' atau 'android'.");
      error.statusCode = 400;
      throw error;
    }
    return provider;
  }

  desiredProvider() {
    return WhatsAppProviderManager.normalizeProvider(this.getSelectedProvider() || CONFIG.WHATSAPP_PROVIDER);
  }

  async select(providerName, options = {}) {
    const next = WhatsAppProviderManager.normalizeProvider(providerName);
    if (this.selected === next && !options.force) return this.providers[next];
    const previous = this.selected;
    if (previous && previous !== next) {
      await this.providers[previous].disconnect().catch(() => {});
      this.observeStatus(previous, { connected: false, bridge: "disconnected" });
    }
    this.selected = next;
    if (options.connect !== false) await this.providers[next].connect();
    if (previous && previous !== next) {
      this.activityLog?.push("info", "whatsapp.provider.changed", `WhatsApp provider changed: ${previous} -> ${next}`, {
        event: "whatsapp.provider.changed",
        previous,
        provider: next,
      });
    }
    return this.providers[next];
  }

  async currentProvider(options = {}) {
    const desired = this.desiredProvider();
    if (this.selected !== desired) return this.select(desired, options);
    return this.providers[desired];
  }

  async initialize() {
    return this.select(this.desiredProvider(), { force: true });
  }

  async sendMessage(phone, message, options = {}) {
    const provider = await this.currentProvider();
    return this.queue.enqueue(
      () => provider.sendMessage(phone, message, options),
      { phone, provider: provider.name, context: options.context || null },
      { maxAttempts: options.maxAttempts }
    );
  }

  async getStatus(options = {}) {
    const provider = await this.currentProvider({ connect: options.connect !== false });
    const status = await provider.getStatus();
    const providers = {};
    for (const [name, instance] of Object.entries(this.providers)) {
      if (name === provider.name) {
        providers[name] = {
          name,
          active: true,
          configured: status.configured !== false,
          connection: {
            connected: status.connected === true,
            detail: status.detail,
          },
        };
      } else {
        providers[name] = {
          name,
          active: false,
          configured: name === "baileys" ? instance.isConfigured() : true,
          connection: { connected: false, detail: "Provider tidak dipilih" },
        };
      }
    }
    const queue = this.queue.getStatus();
    this.observeStatus(provider.name, status);
    return {
      ...status,
      status: status.ready ? "connected" : String(status.state || "unavailable").toLowerCase(),
      selectedProvider: provider.name,
      whatsappProviderEnabled: status.configured !== false,
      isAvailable: status.connected === true,
      deviceReady: status.ready === true,
      outboundEnabled: status.outboundEnabled === true,
      pendingQueue: queue.waiting + queue.active,
      failedQueue: queue.counts.failed,
      queue,
      providers,
      transport: {
        provider: provider.name,
        configuredProviders: Object.values(providers).filter((item) => item.configured).map((item) => item.name),
        connectedProviders: status.connected ? [provider.name] : [],
      },
      transportError: status.ready ? null : status.detail,
    };
  }

  observeStatus(providerName, status) {
    const previous = this.lastObserved.get(providerName);
    const current = {
      connected: status.connected === true,
      bridgeConnected: status.bridge === "connected",
    };
    this.lastObserved.set(providerName, current);
    if (providerName !== "android") return;

    if ((!previous && current.connected) || (previous && previous.connected !== current.connected)) {
      const event = current.connected ? "whatsapp.android.connected" : "whatsapp.android.disconnected";
      this.activityLog?.push(current.connected ? "info" : "warn", event, current.connected
        ? "WhatsApp Android connected"
        : "WhatsApp Android disconnected", { event });
    }
    if ((!previous && current.bridgeConnected) || (previous && previous.bridgeConnected !== current.bridgeConnected)) {
      const event = current.bridgeConnected ? "whatsapp.bridge.connected" : "whatsapp.bridge.disconnected";
      this.activityLog?.push(current.bridgeConnected ? "info" : "warn", event, current.bridgeConnected
        ? "WhatsApp bridge connected"
        : "WhatsApp bridge disconnected", { event });
    }
  }

  async reconnect() {
    const provider = await this.currentProvider({ connect: false });
    await provider.reconnect();
    return this.getStatus();
  }

  async testConnection() {
    const status = await this.getStatus();
    if (!status.deviceReady) {
      const error = new Error(status.transportError || "WhatsApp provider belum siap");
      error.code = status.errorCode || "WHATSAPP_PROVIDER_UNAVAILABLE";
      error.statusCode = 503;
      throw error;
    }
    return status;
  }

  async shutdown() {
    this.queue.shutdown();
    await Promise.allSettled(Object.values(this.providers).map((provider) => provider.disconnect()));
  }
}

module.exports = WhatsAppProviderManager;
module.exports.ALLOWED_PROVIDERS = ALLOWED_PROVIDERS;
