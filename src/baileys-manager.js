const { CONFIG } = require("./config");
const BaileysAuthStore = require("./baileys-auth-store");
const { isValidPhoneNumber, normalizePhoneNumber } = require("./utils");

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const silentLogger = {
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
  fatal() {},
  child() { return this; },
};

class BaileysManager {
  static baileys = null;

  static authStore = null;

  static authState = null;

  static saveCreds = null;

  static socket = null;

  static initialization = null;

  static reconnectTimer = null;

  static pairingReset = null;

  static reconnectAttempts = 0;

  static connectionGeneration = 0;

  static pairingQrSeen = false;

  static shuttingDown = false;

  static sendQueue = Promise.resolve();

  static pendingQueue = 0;

  static failedQueue = 0;

  static lastSentAt = 0;

  static lastActivity = null;

  // Pengiriman selalu terkunci ketika proses baru dimulai atau pairing baru
  // dibuat. Operator harus mengaktifkannya secara eksplisit dari /transport.
  static outboundEnabled = false;

  static connectionCache = {
    checkedAt: 0,
    connected: false,
    detail: "Baileys belum diinisialisasi",
    state: "UNINITIALIZED",
    qr: null,
    device: null,
  };

  static isConfigured() {
    return Boolean(CONFIG.BAILEYS_ENABLED);
  }

  static async loadBaileys() {
    if (!this.baileys) this.baileys = await import("baileys");
    return this.baileys;
  }

  static updateConnection(patch) {
    this.connectionCache = {
      ...this.connectionCache,
      ...patch,
      checkedAt: Date.now(),
    };
  }

  static hasIncompletePairing(creds) {
    return Boolean(creds?.me && creds.registered === false && !creds.account);
  }

  static async initialize() {
    if (!this.isConfigured()) {
      this.updateConnection({
        connected: false,
        detail: "Baileys dinonaktifkan",
        state: "DISABLED",
      });
      return this.connectionCache;
    }
    if (this.socket || this.initialization) return this.initialization || this.connectionCache;

    this.shuttingDown = false;
    this.initialization = this.connect().finally(() => {
      this.initialization = null;
    });
    return this.initialization;
  }

  static async connect() {
    const baileys = await this.loadBaileys();
    if (!this.authStore) {
      this.authStore = new BaileysAuthStore(CONFIG.BAILEYS_AUTH_STORAGE);
      let auth = await this.authStore.initialize(baileys);
      if (this.hasIncompletePairing(auth.state.creds)) {
        await this.authStore.clear();
        auth = await this.authStore.initialize(baileys);
      }
      this.authState = auth.state;
      this.saveCreds = auth.saveCreds;
    }

    const makeWASocket = baileys.default || baileys.makeWASocket;
    const browser = baileys.Browsers?.ubuntu
      ? baileys.Browsers.ubuntu(CONFIG.BAILEYS_BROWSER_NAME)
      : [CONFIG.BAILEYS_BROWSER_NAME, "Chrome", "1.0.0"];
    const generation = ++this.connectionGeneration;
    this.updateConnection({
      connected: false,
      detail: "Menghubungkan Baileys ke WhatsApp",
      state: "CONNECTING",
    });

    const socket = makeWASocket({
      auth: this.authState,
      browser,
      logger: silentLogger,
      printQRInTerminal: false,
      markOnlineOnConnect: false,
      syncFullHistory: false,
      shouldSyncHistoryMessage: () => false,
      generateHighQualityLinkPreview: false,
      connectTimeoutMs: Math.max(10_000, CONFIG.BAILEYS_CONNECT_TIMEOUT),
      defaultQueryTimeoutMs: Math.max(10_000, CONFIG.BAILEYS_QUERY_TIMEOUT),
    });
    this.socket = socket;

    socket.ev.on("creds.update", () => {
      if (generation !== this.connectionGeneration) return;
      this.saveCreds().catch((error) => {
        this.updateConnection({ detail: `Gagal menyimpan sesi Baileys: ${error.message}` });
      });
    });
    socket.ev.on("connection.update", (update) => {
      this.handleConnectionUpdate(update, socket, generation).catch((error) => {
        this.updateConnection({
          connected: false,
          detail: `Gagal memproses status Baileys: ${error.message}`,
          state: "ERROR",
        });
      });
    });

    return this.connectionCache;
  }

  static getDisconnectCode(lastDisconnect) {
    const error = lastDisconnect?.error;
    return error?.output?.statusCode || error?.data?.statusCode || error?.statusCode || null;
  }

  static isInvalidAuthDisconnect(disconnectCode) {
    const reasons = this.baileys?.DisconnectReason || {};
    return [reasons.loggedOut, reasons.badSession, reasons.multideviceMismatch]
      .filter((reason) => reason != null)
      .includes(disconnectCode);
  }

  static async handleConnectionUpdate(update, socket, generation) {
    if (generation !== this.connectionGeneration) return;

    if (update.qr) {
      this.pairingQrSeen = true;
      this.outboundEnabled = false;
      this.updateConnection({
        connected: false,
        detail: "Pindai QR WhatsApp pada halaman status transport",
        state: "PAIRING",
        qr: update.qr,
      });
    }

    if (update.connection === "connecting") {
      this.updateConnection({
        connected: false,
        detail: update.qr ? this.connectionCache.detail : "Menghubungkan Baileys ke WhatsApp",
        state: update.qr ? "PAIRING" : "CONNECTING",
      });
      return;
    }

    if (update.connection === "open") {
      this.pairingQrSeen = false;
      this.reconnectAttempts = 0;
      this.lastActivity = Date.now();
      this.updateConnection({
        connected: true,
        detail: "Baileys terhubung ke WhatsApp",
        state: "READY",
        qr: null,
        device: socket.user ? {
          account: socket.user.name || socket.user.id || null,
          id: socket.user.id || null,
          lid: socket.user.lid || null,
        } : null,
      });
      return;
    }

    if (update.connection !== "close") return;

    if (this.socket === socket) this.socket = null;
    const disconnectCode = this.getDisconnectCode(update.lastDisconnect);
    const disconnectMessage = update.lastDisconnect?.error?.message || null;
    const invalidAuth = this.isInvalidAuthDisconnect(disconnectCode);
    const unfinishedPairing = this.pairingQrSeen && this.authState?.creds?.registered !== true;
    const canReconnect = !this.shuttingDown
      && this.reconnectAttempts < Math.max(0, CONFIG.MAX_RECONNECT_ATTEMPTS);

    if ((invalidAuth || unfinishedPairing) && canReconnect) {
      this.pairingQrSeen = false;
      await this.resetAuthState();
      this.updateConnection({
        connected: false,
        detail: unfinishedPairing
          ? "Pairing WhatsApp belum selesai; menyiapkan QR baru"
          : "Sesi Baileys tidak valid; menyiapkan QR pairing WhatsApp baru",
        state: "RECONNECTING",
        qr: null,
        device: null,
      });
      this.scheduleReconnect();
      return;
    }

    this.updateConnection({
      connected: false,
      detail: invalidAuth
        ? "Sesi Baileys tidak valid. Hapus sesi lalu hubungkan ulang WhatsApp."
        : `${canReconnect ? "Koneksi Baileys terputus; menjadwalkan reconnect" : "Koneksi Baileys terputus"}${disconnectMessage ? `: ${disconnectMessage}` : ""}`,
      state: invalidAuth ? "AUTH_INVALID" : (canReconnect ? "RECONNECTING" : "DISCONNECTED"),
      qr: null,
    });

    if (canReconnect) this.scheduleReconnect();
  }

  static async resetAuthState() {
    this.connectionGeneration += 1;
    this.outboundEnabled = false;
    await this.authStore.clear();
    const auth = await this.authStore.initialize(this.baileys);
    this.authState = auth.state;
    this.saveCreds = auth.saveCreds;
  }

  static scheduleReconnect() {
    if (this.reconnectTimer || this.shuttingDown) return;

    this.reconnectAttempts += 1;
    const delay = Math.min(
      Math.max(1_000, CONFIG.MIN_RECONNECT_INTERVAL) * (2 ** (this.reconnectAttempts - 1)),
      Math.max(CONFIG.MIN_RECONNECT_INTERVAL, CONFIG.BAILEYS_RECONNECT_MAX_DELAY)
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.initialize().catch((error) => {
        this.updateConnection({
          connected: false,
          detail: `Reconnect Baileys gagal: ${error.message}`,
          state: "RECONNECTING",
        });
        this.scheduleReconnect();
      });
    }, delay);
    this.reconnectTimer.unref?.();
  }

  static async requestPairingCode() {
    throw new Error("Pairing code dinonaktifkan. Hubungkan WhatsApp dengan memindai QR.");
  }

  static async resetPairing() {
    if (!this.isConfigured()) throw new Error("Baileys dinonaktifkan");
    if (this.pairingReset) return this.pairingReset;

    this.pairingReset = (async () => {
      if (this.initialization) await this.initialization.catch(() => {});
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
      this.shuttingDown = false;
      this.outboundEnabled = false;
      this.pairingQrSeen = false;
      this.reconnectAttempts = 0;
      this.connectionGeneration += 1;

      const socket = this.socket;
      this.socket = null;
      if (socket?.end) {
        try {
          socket.end(new Error("Pairing WhatsApp direset dari halaman transport"))?.catch?.(() => {});
        } catch {}
      }

      const baileys = await this.loadBaileys();
      if (!this.authStore) {
        this.authStore = new BaileysAuthStore(CONFIG.BAILEYS_AUTH_STORAGE);
      }
      await this.authStore.clear();
      const auth = await this.authStore.initialize(baileys);
      this.authState = auth.state;
      this.saveCreds = auth.saveCreds;
      this.updateConnection({
        connected: false,
        detail: "Menyiapkan QR pairing WhatsApp baru",
        state: "RECONNECTING",
        qr: null,
        device: null,
      });

      await this.initialize();
      return this.connectionCache;
    })().finally(() => {
      this.pairingReset = null;
    });

    return this.pairingReset;
  }

  static async checkConnection() {
    if (!this.isConfigured()) return this.connectionCache;
    if (!this.socket && !this.initialization) await this.initialize();
    return this.connectionCache;
  }

  static enableOutbound() {
    if (!this.isConfigured()) throw new Error("Baileys dinonaktifkan");
    if (!this.connectionCache.connected || !this.socket) {
      throw new Error("WhatsApp belum terhubung; pengiriman belum dapat diaktifkan");
    }
    this.outboundEnabled = true;
    return this.getStatus();
  }

  static disableOutbound() {
    this.outboundEnabled = false;
    return this.getStatus();
  }

  static normalizeDelayRange(options = {}) {
    const configuredMin = Number(options.minDelayMs ?? CONFIG.WA_MESSAGE_DELAY_MIN);
    const configuredMax = Number(options.maxDelayMs ?? CONFIG.WA_MESSAGE_DELAY_MAX);
    const first = Number.isFinite(configuredMin) ? Math.max(0, Math.floor(configuredMin)) : 0;
    const second = Number.isFinite(configuredMax) ? Math.max(0, Math.floor(configuredMax)) : first;
    return {
      minDelayMs: Math.min(first, second),
      maxDelayMs: Math.max(first, second),
    };
  }

  static getRandomDelayMs(options = {}) {
    const { minDelayMs, maxDelayMs } = this.normalizeDelayRange(options);
    if (maxDelayMs <= minDelayMs) return minDelayMs;
    return minDelayMs + Math.floor(Math.random() * (maxDelayMs - minDelayMs + 1));
  }

  static async sendMessage(number, message, options = {}) {
    this.pendingQueue += 1;
    const queuedSend = this.sendQueue.then(() => this.sendOnce(number, message, options));
    this.sendQueue = queuedSend.catch(() => {});
    try {
      return await queuedSend;
    } finally {
      this.pendingQueue = Math.max(0, this.pendingQueue - 1);
    }
  }

  static assertOutboundReady() {
    let error = null;
    if (!this.isConfigured()) {
      error = new Error("Baileys dinonaktifkan");
      error.code = "WHATSAPP_PROVIDER_DISABLED";
    } else if (!this.outboundEnabled) {
      error = new Error("Pengiriman WhatsApp belum diaktifkan dari halaman transport");
      error.code = "WHATSAPP_OUTBOUND_PAUSED";
    } else if (!this.connectionCache.connected || !this.socket) {
      error = new Error(`Baileys belum terhubung (${this.connectionCache.state})`);
      error.code = "WHATSAPP_PROVIDER_UNAVAILABLE";
    }

    if (error) {
      // Kondisi transport tidak akan pulih hanya dengan mengulang item yang
      // sama. Gagal cepat agar fitur utama pemanggil dapat langsung lanjut.
      error.retryable = false;
      error.statusCode = 503;
      throw error;
    }
  }

  static async sendOnce(number, message, options = {}) {
    try {
      // Jangan menunggu jeda acak jika transport sejak awal memang tidak bisa
      // mengirim. sendRequest() tetap memeriksa ulang setelah jeda untuk
      // menangani koneksi yang berubah ketika pesan sedang menunggu.
      this.assertOutboundReady();
      const selectedDelay = this.getRandomDelayMs(options);
      const remainingDelay = Math.max(0, selectedDelay - (Date.now() - this.lastSentAt));
      if (remainingDelay > 0) await sleep(remainingDelay);

      const result = await this.sendRequest(number, message);
      this.lastSentAt = Date.now();
      return { ...result, attempts: 1 };
    } catch (error) {
      if (error?.code !== "WHATSAPP_PROVIDER_DISABLED"
        && error?.code !== "WHATSAPP_OUTBOUND_PAUSED"
        && error?.code !== "WHATSAPP_PROVIDER_UNAVAILABLE") {
        this.lastSentAt = Date.now();
      }
      this.failedQueue += 1;
      throw error;
    }
  }

  static async resolveRecipientJid(normalized) {
    const matches = await this.socket.onWhatsApp(normalized);
    const match = Array.isArray(matches) ? matches.find((item) => item?.exists) : null;
    if (!match?.jid) throw new Error("Nomor tujuan tidak terdaftar di WhatsApp");

    try {
      const lid = await this.socket.signalRepository?.lidMapping?.getLIDForPN?.(match.jid);
      return lid || match.jid;
    } catch {
      return match.jid;
    }
  }

  static async sendRequest(number, message) {
    this.assertOutboundReady();

    const normalized = normalizePhoneNumber(number);
    if (!isValidPhoneNumber(normalized)) throw new Error("Invalid target phone number");

    await this.initialize();
    this.assertOutboundReady();

    try {
      const jid = await this.resolveRecipientJid(normalized);
      const result = await this.socket.sendMessage(jid, { text: String(message || "") });
      this.lastActivity = Date.now();
      this.updateConnection({
        connected: true,
        detail: "Baileys terhubung ke WhatsApp",
        state: "READY",
      });
      return {
        status: "success",
        provider: "baileys",
        message: "Pesan berhasil dikirim via Baileys",
        messageId: result?.key?.id || null,
        target: normalized,
        targetJid: result?.key?.remoteJid || jid,
        timestamp: result?.messageTimestamp || null,
        type: "chat",
      };
    } catch (cause) {
      throw new Error(`Baileys gagal mengirim pesan: ${cause.message}`);
    }
  }

  static getStatus() {
    const configuredProviders = this.isConfigured() ? ["baileys"] : [];
    const connectedProviders = this.isConfigured() && this.connectionCache.connected ? ["baileys"] : [];
    const provider = {
      name: "baileys",
      enabled: CONFIG.BAILEYS_ENABLED,
      configured: this.isConfigured(),
      sessionPersistence: "sqlite",
      connection: this.connectionCache,
    };
    return {
      state: this.connectionCache.state,
      isAvailable: this.connectionCache.connected,
      deviceReady: this.connectionCache.connected,
      outboundEnabled: this.outboundEnabled,
      canSend: this.connectionCache.connected && this.outboundEnabled,
      hasClient: Boolean(this.socket),
      hasPage: true,
      reconnecting: this.connectionCache.state === "RECONNECTING",
      reconnectAttempts: this.reconnectAttempts,
      pendingQueue: this.pendingQueue,
      failedQueue: this.failedQueue,
      currentQR: this.connectionCache.qr || false,
      lastActivity: this.lastActivity ? new Date(this.lastActivity).toISOString() : null,
      whatsappProviderEnabled: this.isConfigured(),
      baileysEnabled: this.isConfigured(),
      account: this.connectionCache.device?.account || null,
      transportError: this.connectionCache.connected ? null : this.connectionCache.detail,
      providers: { baileys: provider },
      transport: {
        provider: "baileys",
        configuredProviders,
        connectedProviders,
        randomDelayMinMs: this.normalizeDelayRange().minDelayMs,
        randomDelayMaxMs: this.normalizeDelayRange().maxDelayMs,
      },
    };
  }

  static async shutdown() {
    this.shuttingDown = true;
    this.outboundEnabled = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.connectionGeneration += 1;
    const socket = this.socket;
    this.socket = null;
    if (socket?.end) socket.end(new Error("Application shutdown"));
    if (this.authStore) await this.authStore.close();
    this.authStore = null;
    this.authState = null;
    this.saveCreds = null;
    this.pairingReset = null;
    this.pairingQrSeen = false;
  }
}

module.exports = BaileysManager;
