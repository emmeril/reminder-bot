const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { test } = require("node:test");

const { MikrotikService } = require("../src/app");

test("membersihkan file export di router dan file lokal saat download gagal", async () => {
  let cleanupCalls = 0;
  let localDirectory = null;
  const connection = {
    menu: () => ({
      where: () => ({
        remove: async () => {
          cleanupCalls += 1;
        },
      }),
    }),
  };
  const service = new MikrotikService({ push() {} });
  service.withConnection = async (operation) => operation(connection, { config: { tls: {} } });
  service.createRouterExportFile = async () => {};
  service.waitForRouterFile = async () => {};
  service.downloadRouterFile = async (_connection, _remoteFile, destinationPath) => {
    localDirectory = path.dirname(destinationPath);
    await fs.writeFile(destinationPath, "partial");
    throw new Error("API gagal");
  };

  await assert.rejects(() => service.generateDailyBackupFile(), /API gagal/);
  assert.equal(cleanupCalls, 1);
  await assert.rejects(() => fs.stat(localDirectory), { code: "ENOENT" });
});

test("menolak export sensitif melalui koneksi MikroTik tanpa TLS", async () => {
  const service = new MikrotikService({ push() {} });
  service.withConnection = async (operation) => operation({}, { config: { tls: null } });
  await assert.rejects(() => service.generateDailyBackupFile(), /API-SSL/);
});

test("membaca isi export melalui perintah file get API", async () => {
  const directory = await fs.mkdtemp(path.join("/tmp", "reminder-api-backup-"));
  const destination = path.join(directory, "backup.rsc");
  let getPayload = null;
  const service = new MikrotikService({ push() {} });
  const connection = {
    menu: () => ({
      print: async () => [{ ".id": "*1", name: "backup.rsc" }],
      exec: async (_command, payload) => {
        getPayload = payload;
        return { ret: "/system identity set name=router" };
      },
    }),
  };

  try {
    await service.downloadRouterFile(connection, "backup.rsc", destination);
    assert.equal(getPayload.number, "*1");
    assert.equal(getPayload["value-name"], "contents");
    assert.match(await fs.readFile(destination, "utf8"), /system identity/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
