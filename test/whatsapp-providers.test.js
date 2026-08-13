const assert = require("node:assert/strict");
const test = require("node:test");

const BaileysProvider = require("../src/whatsapp/baileys-provider");
const { WhatsAppProvider } = require("../src/whatsapp/whatsapp-provider");

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
    checkPhoneNumber: async (phone) => ({ phoneNumber: phone, registered: true }),
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
  const validation = await provider.checkPhoneNumber("6281234567890");
  const status = await provider.getStatus();

  assert.equal(sent.provider, "baileys");
  assert.equal(validation.registered, true);
  assert.equal(status.state, "READY");
  assert.equal(status.ready, true);
  assert.deepEqual(calls, ["connect"]);
});
