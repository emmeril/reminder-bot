const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { afterEach, test } = require("node:test");

const { MikrotikService } = require("../src/app");
const { CONFIG } = require("../src/config");

const temporaryDirectories = [];
const originalDbPath = CONFIG.DB_PATH;

afterEach(async () => {
  CONFIG.DB_PATH = originalDbPath;
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    fs.rm(directory, { recursive: true, force: true })
  )));
});

test("membersihkan file export di router dan file lokal saat download gagal", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "reminder-mikrotik-"));
  temporaryDirectories.push(directory);
  CONFIG.DB_PATH = directory;

  let cleanupCalls = 0;
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
  service.withConnection = async (operation) => operation(connection, { config: { ftpPort: 21 } });
  service.createRouterExportFile = async () => {};
  service.waitForRouterFile = async () => {};
  service.resolveFtpPort = async () => 21;
  service.downloadRouterFile = async (_config, _remoteFile, destinationPath) => {
    await fs.writeFile(destinationPath, "partial");
    throw new Error("FTP gagal");
  };

  await assert.rejects(() => service.generateDailyBackupFile(), /FTP gagal/);
  assert.equal(cleanupCalls, 1);
  assert.deepEqual(await fs.readdir(path.join(directory, "backups", "mikrotik")), []);
});
