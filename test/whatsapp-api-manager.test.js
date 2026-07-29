const assert = require("node:assert/strict");
const { afterEach, beforeEach, test } = require("node:test");

const { CONFIG } = require("../src/config");
const WhatsAppApiManager = require("../src/whatsapp-api-manager");

const originalConfig = {
  WHATSAPP_API_ENABLED: CONFIG.WHATSAPP_API_ENABLED,
  WHATSAPP_API_TOKEN: CONFIG.WHATSAPP_API_TOKEN,
  WHATSAPP_API_URL: CONFIG.WHATSAPP_API_URL,
  WHATSAPP_API_TIMEOUT: CONFIG.WHATSAPP_API_TIMEOUT,
  WA_MESSAGE_DELAY: CONFIG.WA_MESSAGE_DELAY,
  WA_RETRY_MAX_ATTEMPTS: CONFIG.WA_RETRY_MAX_ATTEMPTS,
  WA_RETRY_BASE_DELAY: CONFIG.WA_RETRY_BASE_DELAY,
  WA_RETRY_MAX_DELAY: CONFIG.WA_RETRY_MAX_DELAY,
};
const originalFetch = global.fetch;

beforeEach(() => {
  Object.assign(CONFIG, {
    WHATSAPP_API_ENABLED: true,
    WHATSAPP_API_TOKEN: "test-token-123456789",
    WHATSAPP_API_URL: "http://127.0.0.1:3000",
    WHATSAPP_API_TIMEOUT: 5_000,
    WA_MESSAGE_DELAY: 0,
    WA_RETRY_MAX_ATTEMPTS: 1,
    WA_RETRY_BASE_DELAY: 0,
    WA_RETRY_MAX_DELAY: 0,
  });
  WhatsAppApiManager.sendQueue = Promise.resolve();
  WhatsAppApiManager.lastSentAt = 0;
});

afterEach(() => {
  Object.assign(CONFIG, originalConfig);
  global.fetch = originalFetch;
});

test("mengirim payload JSON sesuai README API WhatsApp", async () => {
  let capturedUrl;
  let capturedOptions;
  global.fetch = async (url, options) => {
    capturedUrl = url;
    capturedOptions = options;
    return new Response(JSON.stringify({
      status: true,
      message: "Pesan berhasil dikirim",
      data: { id: "message-id-1" },
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  const result = await WhatsAppApiManager.sendMessage("6281234567890", "Halo");

  assert.equal(capturedUrl, "http://127.0.0.1:3000/send");
  assert.equal(capturedOptions.method, "POST");
  assert.equal(capturedOptions.headers.Authorization, "Bearer test-token-123456789");
  assert.equal(capturedOptions.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(capturedOptions.body), {
    target: "6281234567890",
    message: "Halo",
  });
  assert.equal(result.provider, "whatsapp-api");
  assert.equal(result.messageId, "message-id-1");
  assert.equal(result.target, "6281234567890");
  assert.equal(result.timestamp, null);
  assert.equal(result.type, "chat");
  assert.equal(result.attempts, 1);
});

test("meneruskan pesan error dari API WhatsApp", async () => {
  global.fetch = async () => new Response(JSON.stringify({
    status: false,
    error: "WHATSAPP_NOT_READY",
    message: "WhatsApp belum terhubung. Pindai QR terlebih dahulu.",
  }), {
    status: 503,
    headers: { "Content-Type": "application/json" },
  });

  await assert.rejects(
    () => WhatsAppApiManager.sendMessage("6281234567890", "Halo"),
    /WhatsApp belum terhubung/
  );
});

test("membaca status perangkat dari endpoint README", async () => {
  let capturedUrl;
  global.fetch = async (url) => {
    capturedUrl = url;
    return new Response(JSON.stringify({
      status: true,
      device: { state: "READY", ready: true },
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  const status = await WhatsAppApiManager.getDeviceStatus();

  assert.equal(capturedUrl, "http://127.0.0.1:3000/device/status");
  assert.deepEqual(status, { state: "READY", ready: true });
});

test("menganggap metadata pesan null sebagai pengiriman sukses", async () => {
  global.fetch = async () => new Response(JSON.stringify({
    status: true,
    message: "Pesan berhasil dikirim",
    data: {
      id: null,
      target: "6281234567890",
      timestamp: null,
      type: "chat",
    },
  }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

  const result = await WhatsAppApiManager.sendMessage("6281234567890", "Halo");

  assert.equal(result.status, "success");
  assert.equal(result.messageId, null);
  assert.equal(result.timestamp, null);
  assert.equal(result.type, "chat");
  assert.equal(result.unconfirmed, undefined);
});
