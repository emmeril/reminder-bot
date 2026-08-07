const assert = require("node:assert/strict");
const { afterEach, beforeEach, test } = require("node:test");

const BaileysManager = require("../src/baileys-manager");
const { CONFIG } = require("../src/config");

const originalConfig = {
  BAILEYS_ENABLED: CONFIG.BAILEYS_ENABLED,
  WA_MESSAGE_DELAY_MIN: CONFIG.WA_MESSAGE_DELAY_MIN,
  WA_MESSAGE_DELAY_MAX: CONFIG.WA_MESSAGE_DELAY_MAX,
  WA_RETRY_MAX_ATTEMPTS: CONFIG.WA_RETRY_MAX_ATTEMPTS,
};

beforeEach(() => {
  Object.assign(CONFIG, {
    BAILEYS_ENABLED: true,
    WA_MESSAGE_DELAY_MIN: 0,
    WA_MESSAGE_DELAY_MAX: 0,
    WA_RETRY_MAX_ATTEMPTS: 1,
  });
  BaileysManager.socket = null;
  BaileysManager.initialization = null;
  BaileysManager.authState = { creds: { registered: true } };
  BaileysManager.sendQueue = Promise.resolve();
  BaileysManager.pendingQueue = 0;
  BaileysManager.failedQueue = 0;
  BaileysManager.lastSentAt = 0;
  BaileysManager.outboundEnabled = true;
  BaileysManager.connectionCache = {
    checkedAt: Date.now(),
    connected: true,
    detail: "Baileys terhubung",
    state: "READY",
    qr: null,
    device: null,
  };
});

afterEach(() => {
  Object.assign(CONFIG, originalConfig);
  if (BaileysManager.reconnectTimer) clearTimeout(BaileysManager.reconnectTimer);
  BaileysManager.reconnectTimer = null;
  BaileysManager.pairingReset = null;
  BaileysManager.socket = null;
  BaileysManager.authState = null;
  BaileysManager.outboundEnabled = false;
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

test("batas percobaan per pesan dapat menonaktifkan retry bawaan", async () => {
  let attempts = 0;
  CONFIG.WA_RETRY_MAX_ATTEMPTS = 3;
  BaileysManager.socket = {
    onWhatsApp: async () => [{ exists: true, jid: "6281234567890@s.whatsapp.net" }],
    sendMessage: async () => {
      attempts += 1;
      throw new Error("koneksi sementara gagal");
    },
  };

  await assert.rejects(
    () => BaileysManager.sendMessage("6281234567890", "Halo", { maxAttempts: 1 }),
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
  const originalInitialize = BaileysManager.initialize;
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
  BaileysManager.initialize = async () => {
    initialized = true;
    return BaileysManager.connectionCache;
  };

  try {
    await BaileysManager.resetPairing();
  } finally {
    BaileysManager.initialize = originalInitialize;
    BaileysManager.authStore = originalAuthStore;
    BaileysManager.baileys = originalBaileys;
  }

  assert.equal(socketEnded, true);
  assert.equal(authCleared, true);
  assert.equal(initialized, true);
  assert.equal(BaileysManager.authState, freshState);
  assert.equal(BaileysManager.connectionCache.state, "RECONNECTING");
});

test("mendeteksi state setengah pairing yang mencegah QR baru", () => {
  assert.equal(BaileysManager.hasIncompletePairing({ registered: false }), false);
  assert.equal(BaileysManager.hasIncompletePairing({ registered: true, me: { id: "6281@s.whatsapp.net" } }), false);
  assert.equal(BaileysManager.hasIncompletePairing({ registered: false, me: { id: "6281@s.whatsapp.net" } }), true);
  assert.equal(BaileysManager.hasIncompletePairing({
    registered: false,
    me: { id: "6281@s.whatsapp.net" },
    account: { details: "paired" },
  }), false);
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
