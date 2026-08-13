const assert = require("node:assert/strict");
const { afterEach, beforeEach, test } = require("node:test");

const BaileysManager = require("../src/baileys-manager");
const { CONFIG } = require("../src/config");

const originalConfig = {
  BAILEYS_ENABLED: CONFIG.BAILEYS_ENABLED,
  BAILEYS_INSTANCES: CONFIG.BAILEYS_INSTANCES,
  BAILEYS_AUTH_STORAGES: CONFIG.BAILEYS_AUTH_STORAGES,
  WA_MESSAGE_DELAY_MIN: CONFIG.WA_MESSAGE_DELAY_MIN,
  WA_MESSAGE_DELAY_MAX: CONFIG.WA_MESSAGE_DELAY_MAX,
};

beforeEach(() => {
  Object.assign(CONFIG, {
    BAILEYS_ENABLED: true,
    BAILEYS_INSTANCES: ["primary"],
    BAILEYS_AUTH_STORAGES: { primary: CONFIG.BAILEYS_AUTH_STORAGE },
    WA_MESSAGE_DELAY_MIN: 0,
    WA_MESSAGE_DELAY_MAX: 0,
  });
  BaileysManager.socket = null;
  BaileysManager.initialization = null;
  BaileysManager.authState = { creds: { registered: true } };
  BaileysManager.sendQueue = Promise.resolve();
  BaileysManager.pendingQueue = 0;
  BaileysManager.failedQueue = 0;
  BaileysManager.lastSentAt = 0;
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
      return { key: { id: "message-1", remoteJid: jid }, messageTimestamp: 123 };
    },
  };

  const result = await BaileysManager.sendMessage("6281234567890", "Halo");

  assert.deepEqual(request, { jid: "123456789@lid", content: { text: "Halo" } });
  assert.equal(result.provider, "baileys");
  assert.equal(result.messageId, "message-1");
  assert.equal(result.targetJid, "123456789@lid");
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

test("menganggap sesi rusak sebagai auth invalid agar QR baru dapat dibuat", () => {
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
