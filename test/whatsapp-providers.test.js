const assert = require("node:assert/strict");
const test = require("node:test");

const AndroidProvider = require("../src/whatsapp/android-provider");
const BaileysProvider = require("../src/whatsapp/baileys-provider");
const { WhatsAppProvider } = require("../src/whatsapp/whatsapp-provider");

function response(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return payload; },
  };
}

test("WhatsAppProvider adalah interface abstrak", () => {
  assert.throws(() => new WhatsAppProvider("invalid"), /interface/);
});

test("BaileysProvider mempertahankan kontrak dan hasil BaileysManager", async () => {
  const calls = [];
  const manager = {
    isConfigured: () => true,
    initialize: async () => calls.push("connect"),
    shutdown: async () => calls.push("disconnect"),
    checkConnection: async () => {},
    sendMessage: async (phone, message) => ({ provider: "baileys", phone, message, messageId: "b-1" }),
    getStatus: () => ({
      state: "READY",
      isAvailable: true,
      canSend: true,
      outboundEnabled: true,
      deviceReady: true,
      providers: { baileys: { connection: { detail: "ready" } } },
      transport: {},
    }),
  };
  const provider = new BaileysProvider(manager);

  await provider.connect();
  const sent = await provider.sendMessage("6281234567890", "Halo");
  const status = await provider.getStatus();

  assert.equal(sent.provider, "baileys");
  assert.equal(status.state, "READY");
  assert.equal(status.ready, true);
  assert.deepEqual(calls, ["connect"]);
});

test("AndroidProvider melaporkan unavailable saat Waydroid berhenti", async () => {
  const provider = new AndroidProvider({
    fetch: async () => response({
      ready: false,
      waydroid: "stopped",
      whatsappInstalled: true,
      whatsappRunning: false,
      bridge: "connected",
      appium: "disconnected",
    }),
  });

  const status = await provider.getStatus();
  assert.equal(status.state, "UNAVAILABLE");
  assert.equal(status.ready, false);
  assert.equal(status.waydroid, "stopped");
  await assert.rejects(
    () => provider.sendMessage("6281234567890", "Halo"),
    (error) => error.code === "ANDROID_PROVIDER_UNAVAILABLE"
  );
});

test("AndroidProvider hanya menganggap pesan sent bila bridge mengonfirmasi", async () => {
  const requests = [];
  const provider = new AndroidProvider({
    fetch: async (url, options = {}) => {
      requests.push({ url, method: options.method || "GET" });
      if (url.endsWith("/v1/status")) {
        return response({
          ready: true,
          waydroid: "running",
          whatsappInstalled: true,
          whatsappRunning: true,
          whatsappReady: true,
          whatsapp: "ready",
          bridge: "connected",
          appium: "connected",
        });
      }
      return response({ confirmed: true, messageId: "android-1", confirmedAt: "2026-08-09T03:00:00.000Z" });
    },
  });

  const result = await provider.sendMessage("6281234567890", "Halo Android");
  assert.equal(result.provider, "android");
  assert.equal(result.confirmed, true);
  assert.equal(result.messageId, "android-1");
  assert.equal(requests.at(-1).method, "POST");
});

test("AndroidProvider menolak konfirmasi palsu dan bridge non-loopback", async () => {
  assert.throws(
    () => new AndroidProvider({ bridgeUrl: "http://0.0.0.0:3030" }),
    /loopback/
  );
  const provider = new AndroidProvider({
    fetch: async (url) => url.endsWith("/v1/status")
      ? response({
          ready: true,
          waydroid: "running",
          whatsappInstalled: true,
          whatsappRunning: true,
          whatsappReady: true,
          whatsapp: "ready",
          bridge: "connected",
        })
      : response({ confirmed: false }),
  });
  await assert.rejects(
    () => provider.sendMessage("6281234567890", "Halo"),
    (error) => error.code === "ANDROID_SEND_UNCONFIRMED"
  );
});

test("AndroidProvider tidak ready saat WhatsApp masih registrasi", async () => {
  const provider = new AndroidProvider({
    fetch: async () => response({
      ready: false,
      waydroid: "running",
      whatsappInstalled: true,
      whatsappRunning: true,
      whatsappReady: false,
      whatsapp: "registration_required",
      bridge: "connected",
      appium: "connected",
    }),
  });

  const status = await provider.getStatus();
  assert.equal(status.ready, false);
  assert.equal(status.whatsapp, "registration_required");
  assert.equal(status.whatsappReady, false);
});
