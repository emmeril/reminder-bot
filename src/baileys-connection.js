const { CONFIG } = require("./config");
const BaileysAuthStore = require("./baileys-auth-store");
const { isValidPhoneNumber, normalizePhoneNumber } = require("./utils");

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

class BoundedCache {
  constructor(limit = 1000) {
    this.limit = limit;
    this.values = new Map();
  }

  get(key) {
    return this.values.get(key);
  }

  set(key, value) {
    this.values.delete(key);
    this.values.set(key, value);
    while (this.values.size > this.limit) {
      this.values.delete(this.values.keys().next().value);
    }
  }

  del(key) {
    this.values.delete(key);
  }

  flushAll() {
    this.values.clear();
  }
}

const silentLogger = {
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
  fatal() {},
  child() { return this; },
};

class BaileysConnection {
  constructor(options = {}) {
    this.id = options.id || "primary";
    this.authStorage = options.authStorage || CONFIG.BAILEYS_AUTH_STORAGE;
    this.browserName = options.browserName || CONFIG.BAILEYS_BROWSER_NAME;
  }

  baileys = null;

  authStore = null;

  authState = null;

  saveCreds = null;

  socket = null;

  initialization = null;

  reconnectTimer = null;

  pairingReset = null;

  reconnectAttempts = 0;

  connectionGeneration = 0;

  pairingQrSeen = false;

  shuttingDown = false;

  sendQueue = Promise.resolve();

  pendingQueue = 0;

  failedQueue = 0;

  lastSentAt = 0;

  lastActivity = null;

  messageStore = new Map();

  messageStoreLimit = 1000;

  msgRetryCounterCache = new BoundedCache(1000);

  messageAckFailures = new Map();

  messageAckStatuses = new Map();

  messageAckWaiters = new Map();

  // Pengiriman aktif otomatis setelah koneksi WhatsApp benar-benar terbuka.
  // Selama pairing/reconnect belum selesai nilainya tetap false.
  outboundEnabled = false;

  connectionCache = {
    checkedAt: 0,
    connected: false,
    detail: "Baileys belum diinisialisasi",
    state: "UNINITIALIZED",
    qr: null,
    device: null,
  };

  isConfigured() {
    return Boolean(CONFIG.BAILEYS_ENABLED);
  }

  async loadBaileys() {
    if (!this.baileys) this.baileys = await import("baileys");
    return this.baileys;
  }

  updateConnection(patch) {
    this.connectionCache = {
      ...this.connectionCache,
      ...patch,
      checkedAt: Date.now(),
    };
  }

  async initialize() {
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

  async connect() {
    const baileys = await this.loadBaileys();
    if (!this.authStore) {
      this.authStore = new BaileysAuthStore(this.authStorage);
      const auth = await this.authStore.initialize(baileys);
      this.authState = auth.state;
      this.saveCreds = auth.saveCreds;
    }

    const makeWASocket = baileys.default || baileys.makeWASocket;
    const browser = baileys.Browsers?.ubuntu
      ? baileys.Browsers.ubuntu(`${this.browserName} (${this.id})`)
      : [`${this.browserName} (${this.id})`, "Chrome", "1.0.0"];
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
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
      msgRetryCounterCache: this.msgRetryCounterCache,
      getMessage: async (key) => this.getStoredMessage(key),
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
    socket.ev.on("messages.update", (updates) => {
      if (generation !== this.connectionGeneration) return;
      this.handleMessageUpdates(updates, baileys.WAMessageStatus);
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

  getDisconnectCode(lastDisconnect) {
    const error = lastDisconnect?.error;
    return error?.output?.statusCode || error?.data?.statusCode || error?.statusCode || null;
  }

  getDisconnectReason(disconnectCode) {
    const reason = this.baileys?.DisconnectReason?.[disconnectCode];
    return typeof reason === "string" ? reason : "unknown";
  }

  getStreamDisconnectReason(lastDisconnect) {
    const message = String(lastDisconnect?.error?.message || "");
    const match = message.match(/Stream Errored \(([^)]+)\)/i);
    return match ? match[1].trim().toLowerCase() : null;
  }

  isInvalidAuthDisconnect(disconnectCode, streamReason = null) {
    const reasons = this.baileys?.DisconnectReason || {};
    if (streamReason === "conflict") return false;
    return [reasons.loggedOut, reasons.badSession, reasons.multideviceMismatch]
      .filter((reason) => reason != null)
      .includes(disconnectCode);
  }

  getReconnectDelayMs(disconnectCode, attempt = this.reconnectAttempts, randomValue = Math.random()) {
    const reasons = this.baileys?.DisconnectReason || {};
    const standardBase = Math.max(1_000, CONFIG.BAILEYS_RECONNECT_BASE_DELAY);
    const standardMax = Math.max(standardBase, CONFIG.BAILEYS_RECONNECT_MAX_DELAY);
    let baseDelay = standardBase;
    let maxDelay = standardMax;

    if (disconnectCode === reasons.unavailableService) {
      baseDelay = Math.max(10_000, standardBase);
      maxDelay = Math.max(baseDelay, CONFIG.BAILEYS_RECONNECT_SERVICE_MAX_DELAY);
    } else if (disconnectCode === reasons.forbidden) {
      baseDelay = Math.max(60_000, standardBase);
      maxDelay = Math.max(baseDelay, CONFIG.BAILEYS_RECONNECT_FORBIDDEN_MAX_DELAY);
    }

    const exponent = Math.min(Math.max(0, attempt - 1), 20);
    const exponentialDelay = Math.min(baseDelay * (2 ** exponent), maxDelay);
    const boundedRandom = Math.min(1, Math.max(0, Number(randomValue) || 0));
    return Math.max(1_000, Math.round(exponentialDelay * (0.8 + (boundedRandom * 0.4))));
  }

  async handleConnectionUpdate(update, socket, generation) {
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
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
      this.pairingQrSeen = false;
      this.outboundEnabled = true;
      this.reconnectAttempts = 0;
      this.lastActivity = Date.now();
      this.updateConnection({
        connected: true,
        detail: "Baileys terhubung ke WhatsApp",
        state: "READY",
        qr: null,
        reconnectDelayMs: null,
        nextReconnectAt: null,
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
    this.outboundEnabled = false;
    const disconnectCode = this.getDisconnectCode(update.lastDisconnect);
    const disconnectMessage = update.lastDisconnect?.error?.message || null;
    const streamReason = this.getStreamDisconnectReason(update.lastDisconnect);
    const enumReason = this.getDisconnectReason(disconnectCode);
    const disconnectReason = streamReason === "conflict" ? "connectionReplaced" : enumReason;
    const invalidAuth = this.isInvalidAuthDisconnect(disconnectCode, streamReason);
    const restartRequired = disconnectCode === this.baileys?.DisconnectReason?.restartRequired;
    const badSession = disconnectCode === this.baileys?.DisconnectReason?.badSession;
    const canReconnect = !this.shuttingDown;
    const disconnectedAt = Date.now();

    const logMessage = String(disconnectMessage || "tanpa pesan")
      .replace(/\s+/g, " ")
      .slice(0, 500);
    console.warn(
      `[${new Date(disconnectedAt).toISOString()}] [Baileys:${this.id}] koneksi ditutup; kode=${disconnectCode ?? "unknown"}; alasan=${disconnectReason}; pesan=${logMessage}`
    );

    // Setelah QR dipindai, WhatsApp biasanya meminta socket direstart. Sesi
    // yang baru diterima wajib dipertahankan dan dipakai untuk reconnect,
    // sama seperti perilaku WhatsApp Web.
    if (restartRequired && canReconnect) {
      this.pairingQrSeen = false;
      await this.saveCreds?.();
      this.updateConnection({
        connected: false,
        detail: "QR diterima; menyelesaikan koneksi WhatsApp",
        state: "RECONNECTING",
        qr: null,
        lastDisconnectCode: disconnectCode,
        lastDisconnectReason: disconnectReason,
        lastDisconnectAt: disconnectedAt,
      });
      this.scheduleReconnect(disconnectCode);
      return;
    }

    // Baileys dapat memetakan stream error yang tidak dikenal ke badSession
    // (500). Pertahankan auth dan coba reconnect agar gangguan sementara tidak
    // menghapus tautan perangkat yang masih valid.
    if (badSession && canReconnect) {
      this.pairingQrSeen = false;
      this.updateConnection({
        connected: false,
        detail: "Sesi Baileys bermasalah (badSession); mencoba reconnect tanpa menghapus auth",
        state: "RECONNECTING",
        qr: null,
        lastDisconnectCode: disconnectCode,
        lastDisconnectReason: disconnectReason,
        lastDisconnectAt: disconnectedAt,
      });
      this.scheduleReconnect(disconnectCode);
      return;
    }

    // Auth tidak pernah dihapus otomatis. Logout atau mismatch harus
    // dikonfirmasi operator lewat tombol reset pairing agar error protokol
    // tidak dapat menghilangkan sesi secara destruktif.
    if (invalidAuth) {
      this.pairingQrSeen = false;
      this.updateConnection({
        connected: false,
        detail: `Sesi WhatsApp perlu ditautkan ulang (${disconnectReason}, kode ${disconnectCode ?? "unknown"}). Auth dipertahankan sampai reset manual dikonfirmasi.`,
        state: "AUTH_INVALID",
        qr: null,
        device: null,
        lastDisconnectCode: disconnectCode,
        lastDisconnectReason: disconnectReason,
        lastDisconnectAt: disconnectedAt,
      });
      return;
    }

    this.updateConnection({
      connected: false,
      detail: `${canReconnect ? "Koneksi Baileys terputus; menjadwalkan reconnect" : "Koneksi Baileys terputus"} (${disconnectReason}, kode ${disconnectCode ?? "unknown"})${disconnectMessage ? `: ${disconnectMessage}` : ""}`,
      state: canReconnect ? "RECONNECTING" : "DISCONNECTED",
      qr: null,
      lastDisconnectCode: disconnectCode,
      lastDisconnectReason: disconnectReason,
      lastDisconnectAt: disconnectedAt,
    });

    if (canReconnect) this.scheduleReconnect(disconnectCode);
  }

  scheduleReconnect(disconnectCode = this.connectionCache.lastDisconnectCode) {
    if (this.reconnectTimer || this.shuttingDown) return;

    this.reconnectAttempts += 1;
    const delay = this.getReconnectDelayMs(disconnectCode, this.reconnectAttempts);
    this.updateConnection({
      reconnectDelayMs: delay,
      nextReconnectAt: Date.now() + delay,
    });
    console.warn(
      `[${new Date().toISOString()}] [Baileys:${this.id}] reconnect dijadwalkan; percobaan=${this.reconnectAttempts}; jeda_ms=${delay}; kode=${disconnectCode ?? "unknown"}`
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.updateConnection({ reconnectDelayMs: null, nextReconnectAt: null });
      this.initialize().catch((error) => {
        this.updateConnection({
          connected: false,
          detail: `Reconnect Baileys gagal: ${error.message}`,
          state: "RECONNECTING",
        });
        this.scheduleReconnect(disconnectCode);
      });
    }, delay);
    this.reconnectTimer.unref?.();
  }

  async requestPairingCode() {
    throw new Error("Pairing code dinonaktifkan. Hubungkan WhatsApp dengan memindai QR.");
  }

  async resetPairing() {
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
          await socket.end(new Error("Pairing WhatsApp direset dari halaman transport"));
        } catch {}
      }

      const baileys = await this.loadBaileys();
      if (!this.authStore) {
        this.authStore = new BaileysAuthStore(this.authStorage);
      }
      this.clearMessageRetryState();
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

  async checkConnection() {
    if (!this.isConfigured()) return this.connectionCache;
    if (!this.socket && !this.initialization) await this.initialize();
    return this.connectionCache;
  }

  enableOutbound() {
    if (!this.isConfigured()) throw new Error("Baileys dinonaktifkan");
    if (!this.connectionCache.connected || !this.socket) {
      throw new Error("WhatsApp belum terhubung; pengiriman belum dapat diaktifkan");
    }
    this.outboundEnabled = true;
    return this.getStatus();
  }

  disableOutbound() {
    this.outboundEnabled = false;
    return this.getStatus();
  }

  normalizeDelayRange(options = {}) {
    const configuredMin = Number(options.minDelayMs ?? CONFIG.WA_MESSAGE_DELAY_MIN);
    const configuredMax = Number(options.maxDelayMs ?? CONFIG.WA_MESSAGE_DELAY_MAX);
    const first = Number.isFinite(configuredMin) ? Math.max(0, Math.floor(configuredMin)) : 0;
    const second = Number.isFinite(configuredMax) ? Math.max(0, Math.floor(configuredMax)) : first;
    return {
      minDelayMs: Math.min(first, second),
      maxDelayMs: Math.max(first, second),
    };
  }

  getRandomDelayMs(options = {}) {
    const { minDelayMs, maxDelayMs } = this.normalizeDelayRange(options);
    if (maxDelayMs <= minDelayMs) return minDelayMs;
    return minDelayMs + Math.floor(Math.random() * (maxDelayMs - minDelayMs + 1));
  }

  async sendMessage(number, message, options = {}) {
    this.pendingQueue += 1;
    const queuedSend = this.sendQueue.then(() => this.sendOnce(number, message, options));
    this.sendQueue = queuedSend.catch(() => {});
    try {
      return await queuedSend;
    } finally {
      this.pendingQueue = Math.max(0, this.pendingQueue - 1);
    }
  }

  assertOutboundReady() {
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

  async sendOnce(number, message, options = {}) {
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

  async resolveRecipientJid(normalized) {
    const result = await this.checkPhoneNumber(normalized);
    if (!result.registered || !result.jid) {
      const error = new Error("Nomor tujuan tidak terdaftar di WhatsApp");
      error.code = "WHATSAPP_NUMBER_NOT_REGISTERED";
      error.retryable = false;
      error.statusCode = 422;
      throw error;
    }

    // USync sudah mengembalikan LID terbaru untuk nomor ini. Gunakan nilai
    // tersebut sebelum membaca mapping lokal yang mungkin belum tersinkron.
    if (result.lid) return result.lid;

    try {
      const lid = await this.socket.signalRepository?.lidMapping?.getLIDForPN?.(result.jid);
      return lid || result.jid;
    } catch {
      return result.jid;
    }
  }

  getMessageStoreKey(key) {
    const remoteJid = String(key?.remoteJid || "");
    const participant = String(key?.participant || "");
    const messageId = String(key?.id || "");
    return remoteJid && messageId ? `${remoteJid}:${participant}:${messageId}` : null;
  }

  rememberMessage(message) {
    const storeKey = this.getMessageStoreKey(message?.key);
    if (!storeKey || !message?.message) return;

    this.messageStore.delete(storeKey);
    this.messageStore.set(storeKey, message.message);
    while (this.messageStore.size > this.messageStoreLimit) {
      this.messageStore.delete(this.messageStore.keys().next().value);
    }
  }

  async getStoredMessage(key) {
    const storeKey = this.getMessageStoreKey(key);
    if (!storeKey) return undefined;
    if (this.messageStore.has(storeKey)) return this.messageStore.get(storeKey);

    const message = await this.authStore?.getMessage?.(key);
    if (message) this.rememberMessage({ key, message });
    return message;
  }

  clearMessageRetryState() {
    this.messageStore.clear();
    this.msgRetryCounterCache.flushAll();
  }

  createMessageAckError(update) {
    const parameters = Array.isArray(update?.update?.messageStubParameters)
      ? update.update.messageStubParameters.map(String)
      : [];
    const serverCode = parameters[0] || null;
    const isReachoutRestricted = serverCode === "463";
    const error = new Error(isReachoutRestricted
      ? "WhatsApp menolak pengiriman dari perangkat tertaut (kode 463). Pastikan pelanggan sudah membalas chat dari perangkat utama, lalu coba kirim kembali beberapa saat lagi."
      : `WhatsApp menolak pesan${serverCode ? ` (kode ${serverCode})` : ""}.`);
    error.code = isReachoutRestricted ? "WHATSAPP_REACHOUT_RESTRICTED" : "WHATSAPP_MESSAGE_REJECTED";
    error.retryable = false;
    error.statusCode = isReachoutRestricted ? 429 : 502;
    return error;
  }

  handleMessageUpdates(updates, messageStatus = {}) {
    const errorStatus = messageStatus?.ERROR ?? 0;
    const serverAckStatus = messageStatus?.SERVER_ACK ?? 2;
    const deliveryAckStatus = messageStatus?.DELIVERY_ACK ?? 3;
    const readStatus = messageStatus?.READ ?? 4;
    for (const update of Array.isArray(updates) ? updates : []) {
      const messageId = String(update?.key?.id || "");
      const status = update?.update?.status;
      const numericStatus = Number(status);
      if (!messageId || update?.key?.fromMe !== true) continue;

      if (numericStatus !== Number(errorStatus) && !(numericStatus >= serverAckStatus)) continue;

      if (numericStatus >= serverAckStatus && numericStatus !== Number(errorStatus)) {
        const deliveryStatus = numericStatus >= readStatus
          ? "read"
          : (numericStatus >= deliveryAckStatus ? "delivered" : "accepted");
        const waiter = this.messageAckWaiters.get(messageId);
        if (waiter) {
          this.messageAckWaiters.delete(messageId);
          clearTimeout(waiter.timer);
          waiter.resolve({ type: "status", deliveryStatus });
        } else {
          this.messageAckStatuses.set(messageId, { deliveryStatus, recordedAt: Date.now() });
        }
        continue;
      }

      const error = this.createMessageAckError(update);
      const waiter = this.messageAckWaiters.get(messageId);
      if (waiter) {
        this.messageAckWaiters.delete(messageId);
        clearTimeout(waiter.timer);
        waiter.resolve({ type: "error", error });
      } else {
        this.messageAckFailures.set(messageId, { error, recordedAt: Date.now() });
      }
      console.warn(`[Baileys:${this.id}] pesan ditolak WhatsApp; id=${messageId}; kode=${error.code}`);
    }

    const cutoff = Date.now() - 60_000;
    for (const [messageId, failure] of this.messageAckFailures) {
      if (failure.recordedAt < cutoff) this.messageAckFailures.delete(messageId);
    }
    for (const [messageId, status] of this.messageAckStatuses) {
      if (status.recordedAt < cutoff) this.messageAckStatuses.delete(messageId);
    }
  }

  async waitForImmediateMessageFailure(messageId, timeoutMs = 2_000) {
    if (!messageId) return "accepted";
    const existing = this.messageAckFailures.get(messageId);
    if (existing) {
      this.messageAckFailures.delete(messageId);
      throw existing.error;
    }
    const existingStatus = this.messageAckStatuses.get(messageId);
    if (existingStatus) {
      this.messageAckStatuses.delete(messageId);
      return existingStatus.deliveryStatus;
    }

    const outcome = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.messageAckWaiters.delete(messageId);
        resolve({ type: "timeout" });
      }, timeoutMs);
      this.messageAckWaiters.set(messageId, { resolve, timer });
    });
    if (outcome?.type === "error") throw outcome.error;
    return outcome?.deliveryStatus || "accepted";
  }

  async checkPhoneNumber(number) {
    const normalized = normalizePhoneNumber(number);
    if (!isValidPhoneNumber(normalized)) {
      const error = new Error("Nomor WhatsApp harus berformat 628xxx.");
      error.code = "INVALID_PHONE_NUMBER";
      error.retryable = false;
      error.statusCode = 400;
      throw error;
    }

    await this.initialize();
    if (!this.isConfigured() || !this.connectionCache.connected || !this.socket) {
      const error = new Error("WhatsApp belum terhubung; nomor belum dapat diperiksa.");
      error.code = "WHATSAPP_PROVIDER_UNAVAILABLE";
      error.retryable = false;
      error.statusCode = 503;
      throw error;
    }

    let matches;
    try {
      matches = await this.socket.onWhatsApp(normalized);
    } catch (cause) {
      const error = new Error(`Gagal memeriksa nomor ke WhatsApp: ${cause.message}`, { cause });
      error.code = "WHATSAPP_NUMBER_CHECK_FAILED";
      error.retryable = false;
      error.statusCode = 503;
      throw error;
    }
    const match = Array.isArray(matches) ? matches.find((item) => item?.exists && item?.jid) : null;
    return {
      phoneNumber: normalized,
      registered: Boolean(match),
      jid: match?.jid || null,
      lid: match?.lid || null,
    };
  }

  async sendRequest(number, message) {
    this.assertOutboundReady();

    const normalized = normalizePhoneNumber(number);
    if (!isValidPhoneNumber(normalized)) throw new Error("Invalid target phone number");

    await this.initialize();
    this.assertOutboundReady();

    try {
      const jid = await this.resolveRecipientJid(normalized);
      const result = await this.socket.sendMessage(jid, { text: String(message || "") });
      this.rememberMessage(result);
      await this.authStore?.saveMessage?.(result?.key, result?.message).catch(() => {});
      const deliveryStatus = await this.waitForImmediateMessageFailure(result?.key?.id);
      this.lastActivity = Date.now();
      this.updateConnection({
        connected: true,
        detail: "Baileys terhubung ke WhatsApp",
        state: "READY",
      });
      return {
        status: "success",
        provider: "baileys",
        message: deliveryStatus === "accepted"
          ? "Pesan diterima server WhatsApp; pengiriman ke perangkat tujuan masih menunggu."
          : "Pesan berhasil dikirim via Baileys",
        messageId: result?.key?.id || null,
        target: normalized,
        targetJid: result?.key?.remoteJid || jid,
        timestamp: result?.messageTimestamp || null,
        type: "chat",
        deliveryStatus,
        deliveryConfirmed: deliveryStatus === "delivered" || deliveryStatus === "read",
      };
    } catch (cause) {
      const error = new Error(`Baileys gagal mengirim pesan: ${cause.message}`, { cause });
      error.code = cause.code;
      error.retryable = cause.retryable;
      error.statusCode = cause.statusCode;
      throw error;
    }
  }

  getStatus() {
    const configuredProviders = this.isConfigured() ? [`baileys:${this.id}`] : [];
    const connectedProviders = this.isConfigured() && this.connectionCache.connected
      ? [`baileys:${this.id}`]
      : [];
    const provider = {
      name: "baileys",
      enabled: CONFIG.BAILEYS_ENABLED,
      configured: this.isConfigured(),
      sessionPersistence: "sqlite",
      connection: this.connectionCache,
    };
    return {
      state: this.connectionCache.state,
      instanceId: this.id,
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

  async shutdown() {
    this.shuttingDown = true;
    this.outboundEnabled = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.connectionGeneration += 1;
    for (const waiter of this.messageAckWaiters.values()) {
      clearTimeout(waiter.timer);
      waiter.resolve(null);
    }
    this.messageAckWaiters.clear();
    this.messageAckFailures.clear();
    this.messageAckStatuses.clear();
    const socket = this.socket;
    this.socket = null;
    if (socket?.end) {
      try {
        await socket.end(new Error("Application shutdown"));
      } catch {}
    }
    if (this.authStore) await this.authStore.close();
    this.authStore = null;
    this.authState = null;
    this.saveCreds = null;
    this.pairingReset = null;
    this.pairingQrSeen = false;
  }
}

module.exports = BaileysConnection;
