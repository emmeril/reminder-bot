const assert = require("node:assert/strict");
const { afterEach, beforeEach, test } = require("node:test");

const { CONFIG } = require("../src/config");
const FonnteApiManager = require("../src/fonnte-api-manager");
const WhatsAppApiManager = require("../src/whatsapp-api-manager");
const WhatsAppLoadBalancer = require("../src/whatsapp-load-balancer");

const originalConfig = {
  WHATSAPP_API_ENABLED: CONFIG.WHATSAPP_API_ENABLED,
  WHATSAPP_API_TOKEN: CONFIG.WHATSAPP_API_TOKEN,
  FONNTE_ENABLED: CONFIG.FONNTE_ENABLED,
  FONNTE_TOKEN: CONFIG.FONNTE_TOKEN,
  FONNTE_API_URL: CONFIG.FONNTE_API_URL,
  FONNTE_API_TIMEOUT: CONFIG.FONNTE_API_TIMEOUT,
  WA_PROVIDER_COOLDOWN: CONFIG.WA_PROVIDER_COOLDOWN,
  WA_MESSAGE_DELAY: CONFIG.WA_MESSAGE_DELAY,
};
const originalApiSend = WhatsAppApiManager.sendMessage;
const originalFonnteSend = FonnteApiManager.sendMessage;
const originalFetch = global.fetch;

beforeEach(() => {
  Object.assign(CONFIG, {
    WHATSAPP_API_ENABLED: true,
    WHATSAPP_API_TOKEN: "test-api-token",
    FONNTE_ENABLED: true,
    FONNTE_TOKEN: "test-fonnte-token",
    FONNTE_API_URL: "https://api.fonnte.com",
    FONNTE_API_TIMEOUT: 5_000,
    WA_PROVIDER_COOLDOWN: 60_000,
    WA_MESSAGE_DELAY: 0,
  });
  WhatsAppLoadBalancer.providerCursor = 0;
  WhatsAppLoadBalancer.providerCooldowns = new Map();
  WhatsAppLoadBalancer.sendQueue = Promise.resolve();
  WhatsAppLoadBalancer.lastActivity = null;
  WhatsAppLoadBalancer.lastSentAt = 0;
});

afterEach(() => {
  Object.assign(CONFIG, originalConfig);
  WhatsAppApiManager.sendMessage = originalApiSend;
  FonnteApiManager.sendMessage = originalFonnteSend;
  global.fetch = originalFetch;
});

test("membagi pesan round-robin ke provider yang dikonfigurasi", async () => {
  const calls = [];
  WhatsAppApiManager.sendMessage = async () => {
    calls.push("whatsapp-api");
    return { status: "success", provider: "whatsapp-api" };
  };
  FonnteApiManager.sendMessage = async () => {
    calls.push("fonnte");
    return { status: "success", provider: "fonnte" };
  };

  const first = await WhatsAppLoadBalancer.sendMessage("08123456789", "first");
  const second = await WhatsAppLoadBalancer.sendMessage("08123456789", "second");

  assert.equal(first.provider, "whatsapp-api");
  assert.equal(second.provider, "fonnte");
  assert.deepEqual(calls, ["whatsapp-api", "fonnte"]);
});

test("failover dan sementara menghindari provider yang gagal", async () => {
  const calls = [];
  WhatsAppApiManager.sendMessage = async () => {
    calls.push("whatsapp-api");
    throw new Error("primary offline");
  };
  FonnteApiManager.sendMessage = async () => {
    calls.push("fonnte");
    return { status: "success", provider: "fonnte" };
  };

  const first = await WhatsAppLoadBalancer.sendMessage("08123456789", "first");
  const second = await WhatsAppLoadBalancer.sendMessage("08123456789", "second");
  const third = await WhatsAppLoadBalancer.sendMessage("08123456789", "third");

  assert.equal(first.provider, "fonnte");
  assert.equal(first.failover, true);
  assert.deepEqual(first.providersTried, ["whatsapp-api", "fonnte"]);
  assert.equal(second.provider, "fonnte");
  assert.equal(third.provider, "fonnte");
  assert.deepEqual(calls, ["whatsapp-api", "fonnte", "fonnte", "fonnte"]);
});

test("melaporkan semua provider yang gagal", async () => {
  WhatsAppApiManager.sendMessage = async () => {
    throw new Error("primary offline");
  };
  FonnteApiManager.sendMessage = async () => {
    throw new Error("backup offline");
  };

  await assert.rejects(
    () => WhatsAppLoadBalancer.sendMessage("6281234567890", "message"),
    (error) => {
      assert.match(error.message, /Semua provider WhatsApp gagal/);
      assert.deepEqual(error.providersTried, ["whatsapp-api", "fonnte"]);
      return true;
    }
  );
});

test("mengirim request Fonnte dengan token dan target ternormalisasi", async () => {
  let request;
  global.fetch = async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify({
      status: true,
      detail: "success! message in queue",
      id: ["message-1"],
      target: ["6281234567890"],
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  const result = await FonnteApiManager.sendMessage("6281234567890", "voucher");
  const payload = new URLSearchParams(request.options.body);

  assert.equal(request.url, "https://api.fonnte.com/send");
  assert.equal(request.options.headers.Authorization, "test-fonnte-token");
  assert.equal(payload.get("target"), "6281234567890");
  assert.equal(payload.get("message"), "voucher");
  assert.equal(result.provider, "fonnte");
  assert.equal(result.messageId, "message-1");
});
