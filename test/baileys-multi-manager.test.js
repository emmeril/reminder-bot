const assert = require("node:assert/strict");
const { afterEach, beforeEach, test } = require("node:test");

const BaileysManager = require("../src/baileys-manager");
const { CONFIG } = require("../src/config");

const originalConfig = {
  BAILEYS_ENABLED: CONFIG.BAILEYS_ENABLED,
  BAILEYS_INSTANCES: CONFIG.BAILEYS_INSTANCES,
  BAILEYS_AUTH_STORAGES: CONFIG.BAILEYS_AUTH_STORAGES,
};

function fakeConnection(id, options = {}) {
  return {
    id,
    enabled: options.enabled !== false,
    sent: [],
    getStatus() {
      return {
        state: options.connected === false ? "DISCONNECTED" : "READY",
        deviceReady: options.connected !== false,
        outboundEnabled: this.enabled,
        canSend: options.connected !== false && this.enabled,
        currentQR: options.qr || false,
        account: `${id}-account`,
        reconnectAttempts: 0,
        lastActivity: null,
        providers: { baileys: { connection: { detail: "ready" } } },
        transport: {},
      };
    },
    async sendMessage(phone, message) {
      this.sent.push({ phone, message });
      return { provider: "baileys", messageId: `${id}-1` };
    },
    enableOutbound() { this.enabled = true; },
    disableOutbound() { this.enabled = false; },
    normalizeDelayRange() { return { minDelayMs: 0, maxDelayMs: 0 }; },
    async initialize() {},
    async checkConnection() {},
    async shutdown() {},
  };
}

beforeEach(() => {
  CONFIG.BAILEYS_ENABLED = true;
  CONFIG.BAILEYS_INSTANCES = ["primary", "backup"];
  CONFIG.BAILEYS_AUTH_STORAGES = {
    primary: "/tmp/primary.sqlite",
    backup: "/tmp/backup.sqlite",
  };
  BaileysManager.connections = new Map();
  BaileysManager.activeInstanceId = null;
});

afterEach(() => {
  Object.assign(CONFIG, originalConfig);
  BaileysManager.connections = new Map();
  BaileysManager.activeInstanceId = null;
});

test("memilih primary saat sehat lalu berpindah ke backup saat primary putus", async () => {
  const primary = fakeConnection("primary");
  const backup = fakeConnection("backup");
  BaileysManager.connections.set("primary", primary);
  BaileysManager.connections.set("backup", backup);

  const first = await BaileysManager.sendMessage("6281234567890", "Pertama");
  assert.equal(first.instanceId, "primary");

  primary.getStatus = () => ({
    state: "DISCONNECTED",
    deviceReady: false,
    outboundEnabled: false,
    canSend: false,
    providers: { baileys: { connection: { detail: "down" } } },
  });
  const second = await BaileysManager.sendMessage("6281234567890", "Kedua");

  assert.equal(second.instanceId, "backup");
  assert.equal(primary.sent.length, 1);
  assert.equal(backup.sent.length, 1);
});

test("melaporkan setiap instance dan storage auth-nya dibuat terpisah", () => {
  const primary = BaileysManager.getConnection("primary");
  const backup = BaileysManager.getConnection("backup");

  assert.equal(primary.authStorage, "/tmp/primary.sqlite");
  assert.equal(backup.authStorage, "/tmp/backup.sqlite");
  assert.notEqual(primary.authStorage, backup.authStorage);
});

test("menolak dua instance yang memakai storage auth yang sama", () => {
  CONFIG.BAILEYS_AUTH_STORAGES.backup = CONFIG.BAILEYS_AUTH_STORAGES.primary;
  BaileysManager.getConnection("primary");

  assert.throws(
    () => BaileysManager.getConnection("backup"),
    /tidak boleh memakai auth storage yang sama/
  );
});
