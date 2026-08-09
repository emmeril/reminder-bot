const assert = require("node:assert/strict");
const test = require("node:test");

const WhatsAppProviderManager = require("../src/whatsapp/provider-manager");
const WhatsAppQueue = require("../src/whatsapp/whatsapp-queue");

function fakeProvider(name, ready = true) {
  return {
    name,
    isConfigured: () => true,
    connectCalls: 0,
    disconnectCalls: 0,
    async connect() { this.connectCalls += 1; },
    async disconnect() { this.disconnectCalls += 1; },
    async reconnect() {},
    async getStatus() {
      return {
        provider: name,
        state: ready ? "READY" : "UNAVAILABLE",
        configured: true,
        connected: ready,
        ready,
        canSend: ready,
        outboundEnabled: ready,
        detail: ready ? "ready" : "unavailable",
        bridge: name === "android" && ready ? "connected" : null,
      };
    },
    async sendMessage(phone, message) {
      return { provider: name, target: phone, message, messageId: `${name}-1`, confirmed: true };
    },
  };
}

test("provider manager default Baileys tetap mengirim melalui adapter existing", async () => {
  let selected = "baileys";
  const baileys = fakeProvider("baileys");
  const android = fakeProvider("android");
  const manager = new WhatsAppProviderManager({
    getSelectedProvider: () => selected,
    providers: { baileys, android },
    queue: new WhatsAppQueue({ concurrency: 1, retryLimit: 1, retryDelayMs: 0 }),
  });

  await manager.initialize();
  const sent = await manager.sendMessage("6281234567890", "Halo");
  assert.equal(sent.provider, "baileys");

  selected = "android";
  const status = await manager.getStatus();
  assert.equal(status.selectedProvider, "android");
  assert.equal(status.deviceReady, true);
  assert.equal(baileys.disconnectCalls, 1);
});

test("provider manager menolak nilai provider di luar allowlist", () => {
  assert.throws(() => WhatsAppProviderManager.normalizeProvider("fake"), /baileys.*android/);
});
