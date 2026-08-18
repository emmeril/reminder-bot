const { CONFIG } = require("./config");
const BaileysConnection = require("./baileys-connection");

class BaileysManager {
  static connections = new Map();

  static activeInstanceId = null;

  // Alias berikut mempertahankan kontrak manager lama untuk instalasi dan
  // integrasi yang masih mengakses koneksi pertama secara langsung.
  static get baileys() { return this.getPrimaryConnection().baileys; }
  static set baileys(value) { this.getPrimaryConnection().baileys = value; }
  static get authStore() { return this.getPrimaryConnection().authStore; }
  static set authStore(value) { this.getPrimaryConnection().authStore = value; }
  static get authState() { return this.getPrimaryConnection().authState; }
  static set authState(value) { this.getPrimaryConnection().authState = value; }
  static get saveCreds() { return this.getPrimaryConnection().saveCreds; }
  static set saveCreds(value) { this.getPrimaryConnection().saveCreds = value; }
  static get socket() { return this.getPrimaryConnection().socket; }
  static set socket(value) { this.getPrimaryConnection().socket = value; }
  static get initialization() { return this.getPrimaryConnection().initialization; }
  static set initialization(value) { this.getPrimaryConnection().initialization = value; }
  static get reconnectTimer() { return this.getPrimaryConnection().reconnectTimer; }
  static set reconnectTimer(value) { this.getPrimaryConnection().reconnectTimer = value; }
  static get pairingReset() { return this.getPrimaryConnection().pairingReset; }
  static set pairingReset(value) { this.getPrimaryConnection().pairingReset = value; }
  static get reconnectAttempts() { return this.getPrimaryConnection().reconnectAttempts; }
  static set reconnectAttempts(value) { this.getPrimaryConnection().reconnectAttempts = value; }
  static get connectionGeneration() { return this.getPrimaryConnection().connectionGeneration; }
  static set connectionGeneration(value) { this.getPrimaryConnection().connectionGeneration = value; }
  static get pairingQrSeen() { return this.getPrimaryConnection().pairingQrSeen; }
  static set pairingQrSeen(value) { this.getPrimaryConnection().pairingQrSeen = value; }
  static get sendQueue() { return this.getPrimaryConnection().sendQueue; }
  static set sendQueue(value) { this.getPrimaryConnection().sendQueue = value; }
  static get pendingQueue() { return this.getPrimaryConnection().pendingQueue; }
  static set pendingQueue(value) { this.getPrimaryConnection().pendingQueue = value; }
  static get failedQueue() { return this.getPrimaryConnection().failedQueue; }
  static set failedQueue(value) { this.getPrimaryConnection().failedQueue = value; }
  static get lastSentAt() { return this.getPrimaryConnection().lastSentAt; }
  static set lastSentAt(value) { this.getPrimaryConnection().lastSentAt = value; }
  static get outboundEnabled() { return this.getPrimaryConnection().outboundEnabled; }
  static set outboundEnabled(value) { this.getPrimaryConnection().outboundEnabled = value; }
  static get connectionCache() { return this.getPrimaryConnection().connectionCache; }
  static set connectionCache(value) { this.getPrimaryConnection().connectionCache = value; }

  static getInstanceIds() {
    return Array.isArray(CONFIG.BAILEYS_INSTANCES) && CONFIG.BAILEYS_INSTANCES.length > 0
      ? CONFIG.BAILEYS_INSTANCES
      : ["primary"];
  }

  static isConfigured() {
    return Boolean(CONFIG.BAILEYS_ENABLED);
  }

  static getConnection(instanceId = null) {
    const id = instanceId || this.getInstanceIds()[0];
    if (!this.getInstanceIds().includes(id)) {
      const error = new Error(`Instance Baileys tidak dikenal: ${id}`);
      error.code = "BAILEYS_INSTANCE_NOT_FOUND";
      throw error;
    }

    if (!this.connections.has(id)) {
      const authStorage = CONFIG.BAILEYS_AUTH_STORAGES?.[id] || CONFIG.BAILEYS_AUTH_STORAGE;
      const duplicate = [...this.connections.values()]
        .find((connection) => connection.authStorage === authStorage);
      if (duplicate) {
        throw new Error(
          `Instance Baileys ${id} dan ${duplicate.id} tidak boleh memakai auth storage yang sama: ${authStorage}`
        );
      }
      this.connections.set(id, new BaileysConnection({
        id,
        authStorage,
        browserName: CONFIG.BAILEYS_BROWSER_NAME,
      }));
    }
    return this.connections.get(id);
  }

  static getPrimaryConnection() {
    return this.getConnection(this.getInstanceIds()[0]);
  }

  static async initialize() {
    if (!this.isConfigured()) return this.getStatus();
    const results = await Promise.allSettled(
      this.getInstanceIds().map((id) => this.getConnection(id).initialize())
    );
    const firstFailure = results.find((result) => result.status === "rejected");
    if (firstFailure && results.every((result) => result.status === "rejected")) {
      throw firstFailure.reason;
    }
    return this.getStatus();
  }

  static selectConnection() {
    const ready = this.getInstanceIds()
      .map((id) => this.getConnection(id))
      .filter((connection) => connection.getStatus().canSend === true);
    if (ready.length === 0) return null;

    const active = ready.find((connection) => connection.id === this.activeInstanceId);
    const selected = active || ready[0];
    this.activeInstanceId = selected.id;
    return selected;
  }

  static async sendMessage(number, message, options = {}) {
    const connection = this.selectConnection();
    if (!connection) {
      const statuses = this.getInstanceIds().map((id) => this.getConnection(id).getStatus());
      const connected = statuses.some((status) => status.deviceReady);
      const error = new Error(connected
        ? "Pengiriman WhatsApp belum diaktifkan dari halaman transport"
        : "Semua koneksi Baileys sedang terputus");
      error.code = connected ? "WHATSAPP_OUTBOUND_PAUSED" : "WHATSAPP_PROVIDER_UNAVAILABLE";
      error.retryable = false;
      error.statusCode = 503;
      throw error;
    }

    const result = await connection.sendMessage(number, message, options);
    return { ...result, instanceId: connection.id };
  }

  static async checkPhoneNumber(number) {
    const connection = this.getInstanceIds()
      .map((id) => this.getConnection(id))
      .find((item) => item.getStatus().deviceReady === true);
    if (!connection) {
      const error = new Error("WhatsApp belum terhubung; nomor belum dapat diperiksa.");
      error.code = "WHATSAPP_PROVIDER_UNAVAILABLE";
      error.retryable = false;
      error.statusCode = 503;
      throw error;
    }

    const result = await connection.checkPhoneNumber(number);
    return { ...result, instanceId: connection.id };
  }

  static async checkConnection() {
    await Promise.allSettled(
      this.getInstanceIds().map((id) => this.getConnection(id).checkConnection())
    );
    return this.getStatus();
  }

  static enableOutbound() {
    let enabled = 0;
    for (const id of this.getInstanceIds()) {
      const connection = this.getConnection(id);
      if (connection.getStatus().deviceReady) {
        connection.enableOutbound();
        enabled += 1;
      }
    }
    if (enabled === 0) throw new Error("WhatsApp belum terhubung; pengiriman belum dapat diaktifkan");
    return this.getStatus();
  }

  static disableOutbound() {
    for (const id of this.getInstanceIds()) this.getConnection(id).disableOutbound();
    return this.getStatus();
  }

  static async resetPairing(instanceId = null) {
    const connection = this.getConnection(instanceId);
    if (this.activeInstanceId === connection.id) this.activeInstanceId = null;
    await connection.resetPairing();
    return this.getStatus();
  }

  static async reconnect() {
    await this.shutdown();
    return this.initialize();
  }

  static async requestPairingCode() {
    throw new Error("Pairing code dinonaktifkan. Hubungkan WhatsApp dengan memindai QR.");
  }

  static handleConnectionUpdate(...args) {
    return this.getPrimaryConnection().handleConnectionUpdate(...args);
  }

  static isInvalidAuthDisconnect(...args) {
    return this.getPrimaryConnection().isInvalidAuthDisconnect(...args);
  }

  static scheduleReconnect(...args) {
    return this.getPrimaryConnection().scheduleReconnect(...args);
  }

  static normalizeDelayRange(...args) {
    return this.getPrimaryConnection().normalizeDelayRange(...args);
  }

  static getRandomDelayMs(...args) {
    return this.getPrimaryConnection().getRandomDelayMs(...args);
  }

  static getStatus() {
    const instances = this.getInstanceIds().map((id) => {
      const status = this.getConnection(id).getStatus();
      return {
        id,
        role: id === this.getInstanceIds()[0] ? "primary" : "backup",
        state: status.state,
        connected: status.deviceReady === true,
        outboundEnabled: status.outboundEnabled === true,
        canSend: status.canSend === true,
        currentQR: status.currentQR || false,
        account: status.account || null,
        detail: status.transportError || status.providers?.baileys?.connection?.detail || null,
        reconnectAttempts: status.reconnectAttempts,
        reconnectDelayMs: status.providers?.baileys?.connection?.reconnectDelayMs ?? null,
        nextReconnectAt: status.providers?.baileys?.connection?.nextReconnectAt || null,
        lastActivity: status.lastActivity,
        lastDisconnectCode: status.providers?.baileys?.connection?.lastDisconnectCode ?? null,
        lastDisconnectReason: status.providers?.baileys?.connection?.lastDisconnectReason || null,
        lastDisconnectAt: status.providers?.baileys?.connection?.lastDisconnectAt || null,
      };
    });
    const connected = instances.filter((instance) => instance.connected);
    const sendable = instances.filter((instance) => instance.canSend);
    const active = this.selectConnection();
    const pairing = instances.find((instance) => instance.currentQR)
      || instances.find((instance) => !instance.connected)
      || instances[0];

    return {
      state: sendable.length > 0 ? "READY" : (connected.length > 0 ? "CONNECTED" : pairing.state),
      isAvailable: connected.length > 0,
      deviceReady: connected.length > 0,
      outboundEnabled: sendable.length > 0,
      canSend: sendable.length > 0,
      hasClient: instances.some((instance) => instance.state !== "UNINITIALIZED"),
      hasPage: true,
      reconnecting: instances.some((instance) => instance.state === "RECONNECTING"),
      reconnectAttempts: instances.reduce((total, instance) => total + (instance.reconnectAttempts || 0), 0),
      pendingQueue: this.getInstanceIds()
        .reduce((total, id) => total + (this.getConnection(id).pendingQueue || 0), 0),
      failedQueue: this.getInstanceIds()
        .reduce((total, id) => total + (this.getConnection(id).failedQueue || 0), 0),
      currentQR: pairing.currentQR || false,
      pairingInstanceId: pairing.id,
      lastActivity: active?.getStatus().lastActivity || null,
      whatsappProviderEnabled: this.isConfigured(),
      baileysEnabled: this.isConfigured(),
      account: active?.getStatus().account || connected[0]?.account || null,
      activeInstanceId: active?.id || null,
      instances,
      transportError: connected.length > 0
        ? null
        : (pairing.detail || "Semua koneksi Baileys sedang terputus"),
      providers: {
        baileys: {
          name: "baileys",
          enabled: CONFIG.BAILEYS_ENABLED,
          configured: this.isConfigured(),
          sessionPersistence: "sqlite",
          connection: {
            connected: connected.length > 0,
            state: connected.length > 0 ? "READY" : pairing.state,
            detail: connected.length > 0
              ? `${connected.length}/${instances.length} koneksi Baileys terhubung`
              : pairing.detail,
          },
        },
      },
      transport: {
        provider: "baileys",
        configuredProviders: this.isConfigured() ? instances.map((instance) => `baileys:${instance.id}`) : [],
        connectedProviders: connected.map((instance) => `baileys:${instance.id}`),
        activeInstanceId: active?.id || null,
        randomDelayMinMs: this.getPrimaryConnection().normalizeDelayRange().minDelayMs,
        randomDelayMaxMs: this.getPrimaryConnection().normalizeDelayRange().maxDelayMs,
      },
    };
  }

  static async shutdown() {
    const connections = [...this.connections.values()];
    this.activeInstanceId = null;
    await Promise.allSettled(connections.map((connection) => connection.shutdown()));
  }
}

module.exports = BaileysManager;
