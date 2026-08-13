const { CONFIG } = require("../config");
const BaileysProvider = require("./baileys-provider");
const WhatsAppQueue = require("./whatsapp-queue");

class WhatsAppProviderManager {
  constructor(options = {}) {
    this.activityLog = options.activityLog || null;
    this.provider = options.provider || options.providers?.baileys || new BaileysProvider();
    this.providers = { baileys: this.provider };
    this.queue = options.queue || new WhatsAppQueue({
      concurrency: CONFIG.WHATSAPP_QUEUE_CONCURRENCY,
      retryLimit: CONFIG.WHATSAPP_RETRY_LIMIT,
      retryDelayMs: CONFIG.WHATSAPP_RETRY_DELAY * 1000,
      activityLog: this.activityLog,
    });
  }

  async initialize() {
    await this.provider.connect();
    return this.provider;
  }

  async currentProvider() {
    return this.provider;
  }

  async sendMessage(phone, message, options = {}) {
    return this.queue.enqueue(
      () => this.provider.sendMessage(phone, message, options),
      { phone, provider: "baileys", context: options.context || null },
      { maxAttempts: options.maxAttempts }
    );
  }

  async getStatus() {
    const status = await this.provider.getStatus();
    const queue = this.queue.getStatus();
    const providerStatus = {
      name: "baileys",
      active: true,
      configured: status.configured !== false,
      connection: {
        connected: status.connected === true,
        detail: status.detail,
      },
    };

    return {
      ...status,
      status: status.connected ? "connected" : String(status.state || "unavailable").toLowerCase(),
      selectedProvider: "baileys",
      whatsappProviderEnabled: status.configured !== false,
      isAvailable: status.connected === true,
      // Perangkat yang sudah tertaut tetap READY walaupun operator belum
      // mengaktifkan pengiriman. Izin kirim dilaporkan terpisah lewat
      // outboundEnabled/canSend.
      deviceReady: status.connected === true,
      outboundEnabled: status.outboundEnabled === true,
      pendingQueue: queue.waiting + queue.active,
      failedQueue: queue.counts.failed,
      queue,
      providers: { baileys: providerStatus },
      transport: {
        ...status.transport,
        provider: "baileys",
        configuredProviders: status.transport?.configuredProviders
          || (providerStatus.configured ? ["baileys"] : []),
        connectedProviders: status.transport?.connectedProviders
          || (status.connected ? ["baileys"] : []),
      },
      transportError: status.ready ? null : status.detail,
    };
  }

  async reconnect() {
    await this.provider.reconnect();
    return this.getStatus();
  }

  async testConnection() {
    const status = await this.getStatus();
    if (!status.deviceReady) {
      const error = new Error(status.transportError || "WhatsApp belum siap");
      error.code = status.errorCode || "WHATSAPP_PROVIDER_UNAVAILABLE";
      error.statusCode = 503;
      throw error;
    }
    return status;
  }

  async shutdown() {
    this.queue.shutdown();
    await this.provider.disconnect().catch(() => {});
  }
}

module.exports = WhatsAppProviderManager;
