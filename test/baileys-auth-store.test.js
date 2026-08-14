const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { afterEach, test } = require("node:test");

const BaileysAuthStore = require("../src/baileys-auth-store");

const temporaryDirectories = [];
const mockBaileys = {
  BufferJSON: {
    replacer: (_key, value) => value,
    reviver: (_key, value) => value,
  },
  initAuthCreds: () => ({ registered: false, marker: "new" }),
  proto: {
    Message: {
      AppStateSyncKeyData: {
        create: (value) => ({ ...value, hydrated: true }),
      },
    },
  },
};

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    fs.rm(directory, { recursive: true, force: true })
  )));
});

test("menyimpan creds dan seluruh jenis key auth Baileys", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "reminder-baileys-"));
  temporaryDirectories.push(directory);
  const storagePath = path.join(directory, "auth.sqlite");
  const store = new BaileysAuthStore(storagePath);
  const auth = await store.initialize(mockBaileys);

  auth.state.creds.registered = true;
  await auth.saveCreds();
  await auth.state.keys.set({
    "lid-mapping": { pn1: { lid: "100@lid" } },
    "device-list": { device1: { devices: [1, 2] } },
    tctoken: { token1: { token: "secret" } },
    "app-state-sync-key": { sync1: { keyData: "value" } },
  });
  await store.saveMessage(
    { remoteJid: "6281234567890@s.whatsapp.net", id: "message-1" },
    { conversation: "Halo" }
  );
  await store.close();

  const reopened = new BaileysAuthStore(storagePath);
  const restored = await reopened.initialize(mockBaileys);

  assert.equal(restored.state.creds.registered, true);
  assert.deepEqual(await restored.state.keys.get("lid-mapping", ["pn1"]), {
    pn1: { lid: "100@lid" },
  });
  assert.deepEqual(await restored.state.keys.get("device-list", ["device1"]), {
    device1: { devices: [1, 2] },
  });
  assert.deepEqual(await restored.state.keys.get("tctoken", ["token1"]), {
    token1: { token: "secret" },
  });
  assert.deepEqual(await restored.state.keys.get("app-state-sync-key", ["sync1"]), {
    sync1: { keyData: "value", hydrated: true },
  });
  assert.deepEqual(await reopened.getMessage({
    remoteJid: "6281234567890@s.whatsapp.net",
    id: "message-1",
  }), { conversation: "Halo" });
  await reopened.clear();
  assert.equal(await reopened.getMessage({
    remoteJid: "6281234567890@s.whatsapp.net",
    id: "message-1",
  }), undefined);
  await reopened.close();
});
