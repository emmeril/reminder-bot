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

  static reconnectAttempts = 0;

  static connectionGeneration = 0;

  static pairingReady = false;

  static shuttingDown = false;

  static sendQueue = Promise.resolve();

  static pendingQueue = 0;

  static failedQueue = 0;

  static lastSentAt = 0;

  static lastActivity = null;

  static connectionCache = {
    checkedAt: 0,
    connected: false,
    detail: "Baileys belum diinisialisasi",
    state: "UNINITIALIZED",
    qr: null,
    pairingCode: null,
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
      const auth = await this.authStore.initialize(baileys);
      this.authState = auth.state;
      this.saveCreds = auth.saveCreds;
    }

    const makeWASocket = baileys.default || baileys.makeWASocket;
    const browser = baileys.Browsers?.ubuntu
      ? baileys.Browsers.ubuntu(CONFIG.BAILEYS_BROWSER_NAME)
      : [CONFIG.BAILEYS_BROWSER_NAME, "Chrome", "1.0.0"];
    const generation = ++this.connectionGeneration;
    this.pairingReady = false;

    this.updateConnection({
      connected: false,
      detail: "Menghubungkan Baileys ke WhatsApp",
      state: "CONNECTING",
    });

    const socket = makeWASocket({
      auth: this.authState,
      browser,
      logger: silentLogger,
      // Pairing codes are displayed by the dashboard, not printed by Baileys.
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

  static async handleConnectionUpdate(update, socket, generation) {
    if (generation !== this.connectionGeneration) return;

    if (update.qr) {
      this.pairingReady = true;
      this.updateConnection({
        connected: false,
        detail: "Pindai QR WhatsApp pada halaman status transport",
        state: "PAIRING",
        qr: update.qr,
      });
    }

    if (update.connection === "connecting") {
      this.pairingReady = true;
      this.updateConnection({
        connected: false,
        detail: update.qr ? this.connectionCache.detail : "Menghubungkan Baileys ke WhatsApp",
        state: update.qr ? "PAIRING" : "CONNECTING",
      });
      return;
    }

    if (update.connection === "open") {
      this.reconnectAttempts = 0;
      this.pairingReady = false;
      this.lastActivity = Date.now();
      this.updateConnection({
        connected: true,
        detail: "Baileys terhubung ke WhatsApp",
        state: "READY",
        qr: null,
        pairingCode: null,
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
    const loggedOut = disconnectCode === this.baileys.DisconnectReason?.loggedOut;
    const canReconnect = !this.shuttingDown
      && this.reconnectAttempts < Math.max(0, CONFIG.MAX_RECONNECT_ATTEMPTS);

    if (loggedOut && canReconnect) {
      await this.resetAuthState();
      this.updateConnection({
        connected: false,
        detail: "Sesi Baileys tidak valid; menyiapkan pairing WhatsApp baru",
        state: "RECONNECTING",
        qr: null,
        pairingCode: null,
        device: null,
      });
      this.scheduleReconnect();
      return;
    }

    this.updateConnection({
      connected: false,
      detail: loggedOut
        ? "Sesi Baileys keluar. Hubungkan ulang WhatsApp."
        : `${canReconnect ? "Koneksi Baileys terputus; menjadwalkan reconnect" : "Koneksi Baileys terputus"}${disconnectMessage ? `: ${disconnectMessage}` : ""}`,
      state: loggedOut ? "LOGGED_OUT" : (canReconnect ? "RECONNECTING" : "DISCONNECTED"),
      qr: null,
    });

    if (canReconnect) this.scheduleReconnect();
  }

  static async resetAuthState() {
    this.connectionGeneration += 1;
    await this.authStore.clear();
    const auth = await this.authStore.initialize(this.baileys);
    this.authState = auth.state;
    this.saveCreds = auth.saveCreds;
    this.reconnectAttempts = 0;
  }

  static scheduleReconnect() {
    if (this.reconnectTimer || this.shuttingDown) return;

    this.reconnectAttempts += 1;
    const delay = Math.min(
      Math.max(1_000, CONFIG.MIN_RECONNECT_INTERVAL) * (2 ** (this.reconnectAttempts - 1)),
      Math.max(CONFIG.MIN_RECONNECT_INTERVAL, CONFIG.WA_RETRY_MAX_DELAY)
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

  static async requestPairingCode(number) {
    const normalized = normalizePhoneNumber(number).replace(/^\+/, "");
    if (!isValidPhoneNumber(normalized)) {
      throw new Error("Nomor pairing harus dalam format E.164 tanpa tanda plus");
    }

    await this.initialize();
    if (!this.socket?.requestPairingCode) {
      throw new Error("Socket Baileys belum siap untuk membuat pairing code");
    }
    if (this.authState?.creds?.registered) {
      throw new Error("Sesi WhatsApp sudah terdaftar. Hapus sesi terlebih dahulu untuk pairing ulang.");
    }

    const socket = this.socket;
    if (typeof socket.waitForSocketOpen === "function") {
      try {
        await socket.waitForSocketOpen();
      } catch (error) {
        throw new Error(`Baileys belum siap membuat pairing code: ${error.message}`);
      }
    } else {
      // Keep compatibility with older Baileys builds and lightweight test doubles.
      for (let attempt = 0; attempt < 30 && !this.pairingReady; attempt += 1) {
        await sleep(500);
      }
      if (!this.pairingReady) {
        throw new Error("Baileys belum mencapai tahap pairing. Coba lagi beberapa saat.");
      }
    }
    if (this.socket !== socket) {
      throw new Error("Socket Baileys berubah saat menyiapkan pairing code. Coba lagi.");
    }

    const code = await socket.requestPairingCode(normalized);
    this.updateConnection({
      connected: false,
      detail: "Masukkan pairing code di menu Perangkat tertaut WhatsApp",
      state: "PAIRING",
      pairingCode: code,
    });
    return code;
  }

  static async checkConnection(force = false) {
    if (!this.isConfigured()) return this.connectionCache;
    if (!this.socket && !this.initialization) await this.initialize();
    if (force && this.connectionCache.connected && this.socket?.sendPresenceUpdate) {
      await this.socket.sendPresenceUpdate("available").catch(() => {});
      await this.socket.sendPresenceUpdate("unavailable").catch(() => {});
    }
    return this.connectionCache;
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
    const queuedSend = this.sendQueue.then(() => this.sendWithRetry(number, message, options));
    this.sendQueue = queuedSend.catch(() => {});
    try {
      return await queuedSend;
    } finally {
      this.pendingQueue = Math.max(0, this.pendingQueue - 1);
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
    const selectedDelay = this.getRandomDelayMs(options);
    const remainingDelay = Math.max(0, selectedDelay - (Date.now() - this.lastSentAt));
    if (remainingDelay > 0) await sleep(remainingDelay);

    for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
      try {
        const result = await this.sendRequest(number, message);
        this.lastSentAt = Date.now();
        return { ...result, attempts: attempt };
      } catch (error) {
        this.lastSentAt = Date.now();
        if (!error.retryable || attempt >= maximumAttempts) {
          this.failedQueue += 1;
          throw error;
        }
        await sleep(this.getRetryDelay(attempt));
      }
    }

    throw new Error("Baileys gagal mengirim pesan setelah retry");
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
    if (!this.isConfigured()) throw new Error("Baileys dinonaktifkan");

    const normalized = normalizePhoneNumber(number);
    if (!isValidPhoneNumber(normalized)) throw new Error("Invalid target phone number");

    await this.initialize();
    if (!this.connectionCache.connected || !this.socket) {
      const error = new Error(`Baileys belum terhubung (${this.connectionCache.state})`);
      error.retryable = ["CONNECTING", "RECONNECTING"].includes(this.connectionCache.state);
      throw error;
    }

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
      const error = new Error(`Baileys gagal mengirim pesan: ${cause.message}`);
      error.retryable = !/tidak terdaftar|invalid/i.test(cause.message);
      throw error;
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
      hasClient: Boolean(this.socket),
      hasPage: true,
      reconnecting: this.connectionCache.state === "RECONNECTING",
      reconnectAttempts: this.reconnectAttempts,
      pendingQueue: this.pendingQueue,
      failedQueue: this.failedQueue,
      currentQR: this.connectionCache.qr || false,
      currentPairingCode: this.connectionCache.pairingCode || null,
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
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.connectionGeneration += 1;
    this.pairingReady = false;
    const socket = this.socket;
    this.socket = null;
    if (socket?.end) socket.end(new Error("Application shutdown"));
    if (this.authStore) await this.authStore.close();
    this.authStore = null;
    this.authState = null;
    this.saveCreds = null;
  }
}

module.exports = BaileysManager;
