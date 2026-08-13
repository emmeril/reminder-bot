const assert = require("node:assert/strict");
const test = require("node:test");

const WhatsAppProviderManager = require("../src/whatsapp/provider-manager");
const WhatsAppQueue = require("../src/whatsapp/whatsapp-queue");

function fakeProvider(ready = true) {
  return {
    name: "baileys",
    isConfigured: () => true,
    connectCalls: 0,
    disconnectCalls: 0,
    async connect() { this.connectCalls += 1; },
    async disconnect() { this.disconnectCalls += 1; },
    async reconnect() {},
    async getStatus() {
      return {
        provider: "baileys",
        state: ready ? "READY" : "UNAVAILABLE",
        configured: true,
        connected: ready,
        ready,
        canSend: ready,
        outboundEnabled: ready,
        detail: ready ? "ready" : "unavailable",
      };
    },
    async sendMessage(phone, message) {
      return { provider: "baileys", target: phone, message, messageId: "baileys-1", confirmed: true };
    },
    async checkPhoneNumber(phone) {
      return { phoneNumber: phone, registered: true };
    },
  };
}

test("provider manager mengirim dan melaporkan status Baileys", async () => {
  const baileys = fakeProvider();
  const manager = new WhatsAppProviderManager({
    provider: baileys,
    queue: new WhatsAppQueue({ concurrency: 1, retryLimit: 1, retryDelayMs: 0 }),
  });

  await manager.initialize();
  const sent = await manager.sendMessage("6281234567890", "Halo");
  const validation = await manager.checkPhoneNumber("6281234567890");
  const status = await manager.getStatus();

  assert.equal(sent.provider, "baileys");
  assert.equal(validation.registered, true);
  assert.equal(status.selectedProvider, "baileys");
  assert.deepEqual(status.transport.configuredProviders, ["baileys"]);
  assert.deepEqual(status.transport.connectedProviders, ["baileys"]);
  assert.equal(baileys.connectCalls, 1);
});

test("perangkat terhubung tetap deviceReady saat pengiriman masih dijeda", async () => {
  const baileys = fakeProvider();
  baileys.getStatus = async () => ({
    provider: "baileys",
    state: "CONNECTED",
    configured: true,
    connected: true,
    ready: false,
    canSend: false,
    outboundEnabled: false,
    detail: "Baileys terhubung; pengiriman masih dijeda",
  });
  const manager = new WhatsAppProviderManager({
    provider: baileys,
    queue: new WhatsAppQueue({ concurrency: 1, retryLimit: 1, retryDelayMs: 0 }),
  });

  const status = await manager.getStatus();

  assert.equal(status.status, "connected");
  assert.equal(status.deviceReady, true);
  assert.equal(status.isAvailable, true);
  assert.equal(status.outboundEnabled, false);
});
