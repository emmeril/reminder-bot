const assert = require("node:assert/strict");
const { afterEach, beforeEach, test } = require("node:test");

const BaileysManager = require("../src/baileys-manager");
const { CONFIG } = require("../src/config");
const { DEFAULTS: AUTO_SAFETY_DEFAULTS } = require("../src/whatsapp/auto-safety-guard");

const originalConfig = {
  BAILEYS_ENABLED: CONFIG.BAILEYS_ENABLED,
  BAILEYS_INSTANCES: CONFIG.BAILEYS_INSTANCES,
  BAILEYS_AUTH_STORAGES: CONFIG.BAILEYS_AUTH_STORAGES,
  WA_MESSAGE_DELAY_MIN: CONFIG.WA_MESSAGE_DELAY_MIN,
  WA_MESSAGE_DELAY_MAX: CONFIG.WA_MESSAGE_DELAY_MAX,
  BAILEYS_RECONNECT_BASE_DELAY: CONFIG.BAILEYS_RECONNECT_BASE_DELAY,
  BAILEYS_RECONNECT_MAX_DELAY: CONFIG.BAILEYS_RECONNECT_MAX_DELAY,
  BAILEYS_RECONNECT_SERVICE_MAX_DELAY: CONFIG.BAILEYS_RECONNECT_SERVICE_MAX_DELAY,
  BAILEYS_RECONNECT_FORBIDDEN_MAX_DELAY: CONFIG.BAILEYS_RECONNECT_FORBIDDEN_MAX_DELAY,
};

beforeEach(() => {
  Object.assign(CONFIG, {
    BAILEYS_ENABLED: true,
    BAILEYS_INSTANCES: ["primary"],
    BAILEYS_AUTH_STORAGES: { primary: CONFIG.BAILEYS_AUTH_STORAGE },
    WA_MESSAGE_DELAY_MIN: 0,
    WA_MESSAGE_DELAY_MAX: 0,
    BAILEYS_RECONNECT_BASE_DELAY: 5_000,
    BAILEYS_RECONNECT_MAX_DELAY: 30_000,
    BAILEYS_RECONNECT_SERVICE_MAX_DELAY: 300_000,
    BAILEYS_RECONNECT_FORBIDDEN_MAX_DELAY: 900_000,
  });
  BaileysManager.socket = null;
  BaileysManager.initialization = null;
  BaileysManager.authState = { creds: { registered: true } };
  BaileysManager.sendQueue = Promise.resolve();
  BaileysManager.pendingQueue = 0;
  BaileysManager.failedQueue = 0;
  BaileysManager.lastSentAt = 0;
  BaileysManager.reconnectAttempts = 0;
  BaileysManager.pairingQrSeen = false;
  BaileysManager.outboundEnabled = true;
  BaileysManager.connectionCache = {
    checkedAt: Date.now(),
    connected: true,
    detail: "Baileys terhubung",
    state: "READY",
    qr: null,
    device: null,
  };
  BaileysManager.activeInstanceId = null;
  const connection = BaileysManager.getPrimaryConnection();
  connection.clearMessageRetryState();
  connection.autoSafetyGuard.reset();
  connection.autoSafetyGuard.setLimits({
    minGlobalGapMs: 0,
    recipientCooldownMs: 0,
    maxPerMinute: 1000,
    maxPerHour: 1000,
    reachoutPauseMs: 60_000,
  });
});

afterEach(() => {
  Object.assign(CONFIG, originalConfig);
  if (BaileysManager.reconnectTimer) clearTimeout(BaileysManager.reconnectTimer);
  BaileysManager.reconnectTimer = null;
  BaileysManager.pairingReset = null;
  BaileysManager.socket = null;
  BaileysManager.authState = null;
  BaileysManager.outboundEnabled = false;
  BaileysManager.pairingQrSeen = false;
  const connection = BaileysManager.getPrimaryConnection();
  connection.autoSafetyGuard.reset();
  connection.autoSafetyGuard.setLimits(AUTO_SAFETY_DEFAULTS);
});

test("memblokir pengiriman sampai operator mengaktifkannya manual", async () => {
  BaileysManager.outboundEnabled = false;
  BaileysManager.socket = {
    onWhatsApp: async () => [{ exists: true, jid: "6281234567890@s.whatsapp.net" }],
    sendMessage: async () => {
      throw new Error("tidak boleh terpanggil");
    },
  };

  await assert.rejects(
    () => BaileysManager.sendMessage("6281234567890", "Halo"),
    /belum diaktifkan/
  );

  const status = BaileysManager.enableOutbound();
  assert.equal(status.outboundEnabled, true);
  assert.equal(status.canSend, true);
});

test("WA dijeda gagal cepat tanpa menunggu delay dan tanpa retry", async () => {
  BaileysManager.outboundEnabled = false;
  BaileysManager.lastSentAt = Date.now();

  const startedAt = Date.now();
  await assert.rejects(
    () => BaileysManager.sendMessage("6281234567890", "Halo", {
      minDelayMs: 60_000,
      maxDelayMs: 60_000,
    }),
    (error) => {
      assert.equal(error.code, "WHATSAPP_OUTBOUND_PAUSED");
      assert.equal(error.retryable, false);
      return true;
    }
  );

  assert.ok(Date.now() - startedAt < 1_000);
});

test("WA terputus gagal cepat tanpa menunggu delay dan tanpa retry", async () => {
  BaileysManager.connectionCache.connected = false;
  BaileysManager.connectionCache.state = "DISCONNECTED";
  BaileysManager.socket = null;
  BaileysManager.lastSentAt = Date.now();

  const startedAt = Date.now();
  await assert.rejects(
    () => BaileysManager.sendMessage("6281234567890", "Halo", {
      minDelayMs: 60_000,
      maxDelayMs: 60_000,
    }),
    (error) => {
      assert.equal(error.code, "WHATSAPP_PROVIDER_UNAVAILABLE");
      assert.equal(error.retryable, false);
      return true;
    }
  );

  assert.ok(Date.now() - startedAt < 1_000);
});

test("mengirim pesan ke LID ketika mapping PN tersedia", async () => {
  let request;
  BaileysManager.socket = {
    onWhatsApp: async () => [{ exists: true, jid: "6281234567890@s.whatsapp.net" }],
    signalRepository: {
      lidMapping: {
        getLIDForPN: async () => "123456789@lid",
      },
    },
    sendMessage: async (jid, content) => {
      request = { jid, content };
      return {
        key: { id: "message-1", remoteJid: jid },
        message: { conversation: "Halo" },
        messageTimestamp: 123,
      };
    },
  };

  const result = await BaileysManager.sendMessage("6281234567890", "Halo");

  assert.deepEqual(request, { jid: "123456789@lid", content: { text: "Halo" } });
  assert.equal(result.provider, "baileys");
  assert.equal(result.messageId, "message-1");
  assert.equal(result.targetJid, "123456789@lid");
  assert.deepEqual(await BaileysManager.getPrimaryConnection().getStoredMessage({
    id: "message-1",
    remoteJid: "123456789@lid",
  }), { conversation: "Halo" });
});

test("menggunakan LID dari hasil pemeriksaan nomor sebelum mapping lokal", async () => {
  let request;
  BaileysManager.socket = {
    onWhatsApp: async () => [{
      exists: true,
      jid: "6281234567890@s.whatsapp.net",
      lid: "987654321@lid",
    }],
    signalRepository: {
      lidMapping: {
        getLIDForPN: async () => "stale@lid",
      },
    },
    sendMessage: async (jid, content) => {
      request = { jid, content };
      return {
        key: { id: "message-lid", remoteJid: jid },
        message: { conversation: "Halo" },
      };
    },
  };

  const result = await BaileysManager.sendMessage("6281234567890", "Halo");

  assert.deepEqual(request, { jid: "987654321@lid", content: { text: "Halo" } });
  assert.equal(result.targetJid, "987654321@lid");
});

test("melaporkan penolakan 463 walaupun sendMessage sempat mengembalikan ID", async () => {
  const connection = BaileysManager.getPrimaryConnection();
  BaileysManager.socket = {
    onWhatsApp: async () => [{
      exists: true,
      jid: "6281234567890@s.whatsapp.net",
      lid: "987654321@lid",
    }],
    sendMessage: async (jid) => {
      const result = {
        key: { id: "message-rejected", remoteJid: jid, fromMe: true },
        message: { conversation: "Halo" },
      };
      setImmediate(() => connection.handleMessageUpdates([{
        key: result.key,
        update: { status: 0, messageStubParameters: ["463"] },
      }], { ERROR: 0 }));
      return result;
    },
  };

  await assert.rejects(
    () => BaileysManager.sendMessage("6281234567890", "Halo"),
    (error) => {
      assert.equal(error.code, "WHATSAPP_REACHOUT_RESTRICTED");
      assert.equal(error.statusCode, 429);
      assert.match(error.message, /pelanggan sudah membalas/);
      return true;
    }
  );

  assert.equal(connection.autoSafetyGuard.getStatus().paused, true);
  await assert.rejects(
    () => BaileysManager.sendMessage("6289999999999", "Pesan berikutnya"),
    (error) => {
      assert.equal(error.code, "WHATSAPP_AUTOMATIC_SAFETY_PAUSE");
      assert.equal(error.retryable, false);
      return true;
    }
  );
});

test("mengembalikan accepted ketika belum ada delivery ACK", async () => {
  BaileysManager.socket = {
    onWhatsApp: async () => [{ exists: true, jid: "6281234567890@s.whatsapp.net" }],
    sendMessage: async (jid) => ({
      key: { id: "message-accepted", remoteJid: jid, fromMe: true },
      message: { conversation: "Halo" },
    }),
  };

  const result = await BaileysManager.sendMessage("6281234567890", "Halo");

  assert.equal(result.deliveryStatus, "accepted");
  assert.equal(result.deliveryConfirmed, false);
});

test("socket memakai sync bawaan Baileys dan menyediakan message retry store", async () => {
  const connection = BaileysManager.getPrimaryConnection();
  const originalBaileys = connection.baileys;
  const originalAuthStore = connection.authStore;
  const originalAuthState = connection.authState;
  let socketConfig;

  connection.authStore = {};
  connection.authState = { creds: { registered: true }, keys: {} };
  connection.baileys = {
    default: (config) => {
      socketConfig = config;
      return { ev: { on() {} } };
    },
    Browsers: { ubuntu: (name) => ["Ubuntu", name, "1.0.0"] },
  };

  try {
    await connection.connect();
  } finally {
    connection.socket = null;
    connection.baileys = originalBaileys;
    connection.authStore = originalAuthStore;
    connection.authState = originalAuthState;
  }

  assert.equal(Object.hasOwn(socketConfig, "shouldSyncHistoryMessage"), false);
  assert.equal(Object.hasOwn(socketConfig, "printQRInTerminal"), false);
  assert.equal(typeof socketConfig.getMessage, "function");
  assert.equal(socketConfig.msgRetryCounterCache, connection.msgRetryCounterCache);
});

test("menolak nomor yang tidak terdaftar di WhatsApp tanpa retry", async () => {
  BaileysManager.socket = {
    onWhatsApp: async () => [],
  };

  await assert.rejects(
    () => BaileysManager.sendMessage("6281234567890", "Halo"),
    /tidak terdaftar/
  );
  assert.equal(BaileysManager.failedQueue, 1);
});

test("memvalidasi nomor WhatsApp walaupun pengiriman sedang dijeda", async () => {
  BaileysManager.outboundEnabled = false;
  BaileysManager.socket = {
    onWhatsApp: async () => [{ exists: true, jid: "6281234567890@s.whatsapp.net" }],
  };

  const result = await BaileysManager.checkPhoneNumber("0812-3456-7890".replace(/^0/, "62"));

  assert.equal(result.phoneNumber, "6281234567890");
  assert.equal(result.registered, true);
  assert.equal(result.jid, "6281234567890@s.whatsapp.net");
});

test("validasi nomor melaporkan akun yang tidak terdaftar tanpa mengirim pesan", async () => {
  let sendCalls = 0;
  BaileysManager.socket = {
    onWhatsApp: async () => [],
    sendMessage: async () => { sendCalls += 1; },
  };

  const result = await BaileysManager.checkPhoneNumber("6281234567890");

  assert.equal(result.registered, false);
  assert.equal(result.jid, null);
  assert.equal(sendCalls, 0);
});

test("kegagalan query validasi nomor dilaporkan sebagai gangguan WhatsApp", async () => {
  BaileysManager.socket = {
    onWhatsApp: async () => { throw new Error("query timeout"); },
  };

  await assert.rejects(
    () => BaileysManager.checkPhoneNumber("6281234567890"),
    (error) => {
      assert.equal(error.code, "WHATSAPP_NUMBER_CHECK_FAILED");
      assert.equal(error.statusCode, 503);
      assert.match(error.message, /query timeout/);
      return true;
    }
  );
});

test("setiap pesan hanya dicoba sekali walaupun opsi lama meminta lebih banyak percobaan", async () => {
  let attempts = 0;
  BaileysManager.socket = {
    onWhatsApp: async () => [{ exists: true, jid: "6281234567890@s.whatsapp.net" }],
    sendMessage: async () => {
      attempts += 1;
      throw new Error("koneksi sementara gagal");
    },
  };

  await assert.rejects(
    () => BaileysManager.sendMessage("6281234567890", "Halo", { maxAttempts: 3 }),
    /koneksi sementara gagal/
  );
  assert.equal(attempts, 1);
});

test("menonaktifkan pairing code agar koneksi hanya melalui QR", async () => {
  await assert.rejects(
    () => BaileysManager.requestPairingCode("6281234567890"),
    /Pairing code dinonaktifkan.*QR/
  );
});

test("mereset pairing dan membuka socket baru tanpa restart aplikasi", async () => {
  const connection = BaileysManager.getPrimaryConnection();
  const originalInitialize = connection.initialize;
  const originalAuthStore = BaileysManager.authStore;
  const originalBaileys = BaileysManager.baileys;
  let socketEnded = false;
  let authCleared = false;
  let initialized = false;
  const freshState = { creds: { registered: false } };

  BaileysManager.baileys = {};
  BaileysManager.socket = {
    end() {
      socketEnded = true;
    },
  };
  BaileysManager.authStore = {
    async clear() {
      authCleared = true;
    },
    async initialize() {
      return { state: freshState, saveCreds: async () => {} };
    },
  };
  connection.initialize = async () => {
    initialized = true;
    return BaileysManager.connectionCache;
  };

  try {
    await BaileysManager.resetPairing();
  } finally {
    connection.initialize = originalInitialize;
    BaileysManager.authStore = originalAuthStore;
    BaileysManager.baileys = originalBaileys;
  }

  assert.equal(socketEnded, true);
  assert.equal(authCleared, true);
  assert.equal(initialized, true);
  assert.equal(BaileysManager.authState, freshState);
  assert.equal(BaileysManager.connectionCache.state, "RECONNECTING");
});

test("reset pairing menunggu socket lama berhenti sebelum menghapus auth", async () => {
  const connection = BaileysManager.getPrimaryConnection();
  const originalInitialize = connection.initialize;
  const originalAuthStore = connection.authStore;
  const originalBaileys = connection.baileys;
  const events = [];
  let releaseSocket;

  connection.baileys = {};
  connection.socket = {
    end: async () => {
      events.push("end-start");
      await new Promise((resolve) => { releaseSocket = resolve; });
      events.push("end-finish");
    },
  };
  connection.authStore = {
    async clear() { events.push("auth-clear"); },
    async initialize() {
      return { state: { creds: { registered: false } }, saveCreds: async () => {} };
    },
  };
  connection.initialize = async () => connection.connectionCache;

  try {
    const reset = connection.resetPairing();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(events, ["end-start"]);
    releaseSocket();
    await reset;
  } finally {
    connection.initialize = originalInitialize;
    connection.authStore = originalAuthStore;
    connection.baileys = originalBaileys;
  }

  assert.deepEqual(events, ["end-start", "end-finish", "auth-clear"]);
});

test("restart setelah scan mempertahankan auth dan menyelesaikan pairing yang sama", async () => {
  const originalBaileys = BaileysManager.baileys;
  let reconnectScheduled = false;
  let credsSaved = false;
  const pairedState = { creds: { registered: true, me: { id: "6281@s.whatsapp.net" } } };

  BaileysManager.baileys = {
    DisconnectReason: { restartRequired: 515 },
  };
  BaileysManager.authState = pairedState;
  BaileysManager.saveCreds = async () => { credsSaved = true; };
  BaileysManager.socket = {};
  const generation = BaileysManager.connectionGeneration;
  const socket = BaileysManager.socket;
  const connection = BaileysManager.getPrimaryConnection();
  const originalScheduleReconnect = connection.scheduleReconnect;
  connection.scheduleReconnect = () => { reconnectScheduled = true; };

  try {
    await BaileysManager.handleConnectionUpdate({ qr: "qr-baru", connection: "connecting" }, socket, generation);
    await BaileysManager.handleConnectionUpdate({
      connection: "close",
      lastDisconnect: { error: { output: { statusCode: 515 }, message: "restart required" } },
    }, socket, generation);
  } finally {
    connection.scheduleReconnect = originalScheduleReconnect;
    BaileysManager.baileys = originalBaileys;
  }

  assert.equal(reconnectScheduled, true);
  assert.equal(credsSaved, true);
  assert.equal(BaileysManager.authState, pairedState);
  assert.equal(BaileysManager.connectionCache.state, "RECONNECTING");
  assert.match(BaileysManager.connectionCache.detail, /QR diterima/);
});

test("scan QR yang berhasil langsung mengaktifkan pengiriman", async () => {
  BaileysManager.outboundEnabled = false;
  BaileysManager.pairingQrSeen = true;
  const generation = BaileysManager.connectionGeneration;
  const socket = {
    user: {
      id: "6281234567890@s.whatsapp.net",
      name: "Reminder Bot",
    },
  };
  BaileysManager.socket = socket;

  await BaileysManager.handleConnectionUpdate({ connection: "open" }, socket, generation);

  const status = BaileysManager.getStatus();
  assert.equal(status.deviceReady, true);
  assert.equal(status.outboundEnabled, true);
  assert.equal(status.canSend, true);
  assert.equal(status.state, "READY");
  assert.equal(status.account, "Reminder Bot");
});

test("mengenali kode disconnect yang berkaitan dengan auth", () => {
  BaileysManager.baileys = {
    DisconnectReason: {
      loggedOut: 401,
      badSession: 500,
      multideviceMismatch: 411,
    },
  };

  assert.equal(BaileysManager.isInvalidAuthDisconnect(401), true);
  assert.equal(BaileysManager.isInvalidAuthDisconnect(500), true);
  assert.equal(BaileysManager.isInvalidAuthDisconnect(411), true);
  assert.equal(BaileysManager.isInvalidAuthDisconnect(408), false);
});

test("badSession mencoba reconnect tanpa menghapus auth", async () => {
  const connection = BaileysManager.getPrimaryConnection();
  const originalBaileys = connection.baileys;
  const originalAuthStore = connection.authStore;
  const originalScheduleReconnect = connection.scheduleReconnect;
  let authCleared = false;
  let reconnectScheduled = false;

  connection.baileys = {
    DisconnectReason: {
      500: "badSession",
      badSession: 500,
      loggedOut: 401,
      multideviceMismatch: 411,
      restartRequired: 515,
    },
  };
  connection.authStore = { clear: async () => { authCleared = true; } };
  connection.scheduleReconnect = () => { reconnectScheduled = true; };
  connection.socket = {};
  const socket = connection.socket;
  const generation = connection.connectionGeneration;

  try {
    await connection.handleConnectionUpdate({
      connection: "close",
      lastDisconnect: { error: { output: { statusCode: 500 }, message: "unknown stream error" } },
    }, socket, generation);
  } finally {
    connection.baileys = originalBaileys;
    connection.authStore = originalAuthStore;
    connection.scheduleReconnect = originalScheduleReconnect;
  }

  assert.equal(authCleared, false);
  assert.equal(reconnectScheduled, true);
  assert.equal(connection.connectionCache.state, "RECONNECTING");
  assert.equal(connection.connectionCache.lastDisconnectCode, 500);
  assert.match(connection.connectionCache.detail, /tanpa menghapus auth/);
});

test("loggedOut mempertahankan auth dan menunggu reset manual", async () => {
  const connection = BaileysManager.getPrimaryConnection();
  const originalBaileys = connection.baileys;
  const originalAuthStore = connection.authStore;
  const originalScheduleReconnect = connection.scheduleReconnect;
  let authCleared = false;
  let reconnectScheduled = false;

  connection.baileys = {
    DisconnectReason: {
      401: "loggedOut",
      badSession: 500,
      loggedOut: 401,
      multideviceMismatch: 411,
      restartRequired: 515,
    },
  };
  connection.authStore = { clear: async () => { authCleared = true; } };
  connection.scheduleReconnect = () => { reconnectScheduled = true; };
  connection.socket = {};
  const socket = connection.socket;
  const generation = connection.connectionGeneration;

  try {
    await connection.handleConnectionUpdate({
      connection: "close",
      lastDisconnect: { error: { output: { statusCode: 401 }, message: "logged out" } },
    }, socket, generation);
  } finally {
    connection.baileys = originalBaileys;
    connection.authStore = originalAuthStore;
    connection.scheduleReconnect = originalScheduleReconnect;
  }

  assert.equal(authCleared, false);
  assert.equal(reconnectScheduled, false);
  assert.equal(connection.connectionCache.state, "AUTH_INVALID");
  assert.equal(connection.connectionCache.lastDisconnectReason, "loggedOut");
  assert.match(connection.connectionCache.detail, /reset manual/);
});

test("conflict berkode 401 diperlakukan sebagai connectionReplaced dan direconnect", async () => {
  const connection = BaileysManager.getPrimaryConnection();
  const originalBaileys = connection.baileys;
  const originalScheduleReconnect = connection.scheduleReconnect;
  let reconnectCode = null;

  connection.baileys = {
    DisconnectReason: {
      401: "loggedOut",
      badSession: 500,
      loggedOut: 401,
      multideviceMismatch: 411,
      restartRequired: 515,
    },
  };
  connection.scheduleReconnect = (code) => { reconnectCode = code; };
  connection.socket = {};
  const socket = connection.socket;
  const generation = connection.connectionGeneration;

  try {
    await connection.handleConnectionUpdate({
      connection: "close",
      lastDisconnect: { error: { output: { statusCode: 401 }, message: "Stream Errored (conflict)" } },
    }, socket, generation);
  } finally {
    connection.baileys = originalBaileys;
    connection.scheduleReconnect = originalScheduleReconnect;
  }

  assert.equal(reconnectCode, 401);
  assert.equal(connection.connectionCache.state, "RECONNECTING");
  assert.equal(connection.connectionCache.lastDisconnectReason, "connectionReplaced");
});

test("reconnect tetap dijadwalkan setelah melewati batas percobaan lama", async () => {
  const connection = BaileysManager.getPrimaryConnection();
  const originalBaileys = connection.baileys;
  const originalScheduleReconnect = connection.scheduleReconnect;
  let reconnectScheduled = false;

  connection.baileys = {
    DisconnectReason: {
      503: "unavailableService",
      unavailableService: 503,
      badSession: 500,
      loggedOut: 401,
      multideviceMismatch: 411,
      restartRequired: 515,
    },
  };
  connection.reconnectAttempts = 25;
  connection.scheduleReconnect = () => { reconnectScheduled = true; };
  connection.socket = {};
  const socket = connection.socket;
  const generation = connection.connectionGeneration;

  try {
    await connection.handleConnectionUpdate({
      connection: "close",
      lastDisconnect: { error: { output: { statusCode: 503 }, message: "service unavailable" } },
    }, socket, generation);
  } finally {
    connection.baileys = originalBaileys;
    connection.scheduleReconnect = originalScheduleReconnect;
  }

  assert.equal(reconnectScheduled, true);
  assert.equal(connection.connectionCache.state, "RECONNECTING");
});

test("backoff membedakan koneksi biasa, unavailable service, dan forbidden", () => {
  const connection = BaileysManager.getPrimaryConnection();
  const originalBaileys = connection.baileys;
  connection.baileys = {
    DisconnectReason: {
      unavailableService: 503,
      forbidden: 403,
    },
  };

  try {
    assert.equal(connection.getReconnectDelayMs(428, 1, 0.5), 5_000);
    assert.equal(connection.getReconnectDelayMs(503, 1, 0.5), 10_000);
    assert.equal(connection.getReconnectDelayMs(403, 1, 0.5), 60_000);
    assert.equal(connection.getReconnectDelayMs(428, 10, 0.5), 30_000);
    assert.equal(connection.getReconnectDelayMs(503, 10, 0.5), 300_000);
    assert.equal(connection.getReconnectDelayMs(403, 10, 0.5), 900_000);
  } finally {
    connection.baileys = originalBaileys;
  }
});

test("menormalkan rentang jeda yang tertukar", () => {
  const originalRandom = Math.random;
  try {
    Math.random = () => 0;
    assert.equal(BaileysManager.getRandomDelayMs({ minDelayMs: 5000, maxDelayMs: 2000 }), 2000);
    Math.random = () => 0.999999;
    assert.equal(BaileysManager.getRandomDelayMs({ minDelayMs: 2000, maxDelayMs: 5000 }), 5000);
  } finally {
    Math.random = originalRandom;
  }
});
