const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
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

test("mengizinkan export melalui API tanpa TLS dengan peringatan keamanan", async () => {
  const logs = [];
  const connection = {
    menu: () => ({
      where: () => ({ remove: async () => {} }),
    }),
  };
  const service = new MikrotikService({
    push(level, source, message) {
      logs.push({ level, source, message });
    },
  });
  service.withConnection = async (operation) => operation(connection, { config: { tls: null } });
  service.createRouterExportFile = async () => {};
  service.waitForRouterFile = async () => {};
  service.downloadRouterFile = async (_connection, _remoteFile, destinationPath) => {
    await fs.writeFile(destinationPath, "/system identity set name=router");
  };

  const backup = await service.generateDailyBackupFile();
  try {
    assert.match(await fs.readFile(backup.filePath, "utf8"), /system identity/);
    assert.equal(logs.some((entry) => entry.level === "warn" && /tanpa TLS/.test(entry.message)), true);
  } finally {
    await backup.cleanup();
  }
});

test("membaca isi export melalui perintah file get API", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "reminder-api-backup-"));
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

test("menggunakan fallback FTP ketika contents tidak tersedia melalui API", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "reminder-ftp-backup-"));
  const destination = path.join(directory, "backup.rsc");
  const logs = [];
  let ftpCall = null;
  const service = new MikrotikService({
    push(level, source, message, metadata) {
      logs.push({ level, source, message, metadata });
    },
  });
  const connection = {
    menu: () => ({
      print: async () => [{ ".id": "*1", name: "backup.rsc" }],
      exec: async () => [],
    }),
  };
  service.resolveFtpPort = async () => 1234;
  service.downloadRouterFileViaFtp = async (config, ftpPort, remoteFileName, destinationPath) => {
    ftpCall = { config, ftpPort, remoteFileName };
    await fs.writeFile(destinationPath, "/system identity set name=router-via-ftp");
  };

  const config = { host: "192.0.2.1", user: "api", password: "secret", ftpPort: 1234 };
  try {
    await service.downloadRouterFile(connection, "backup.rsc", destination, config);
    assert.deepEqual(ftpCall, { config, ftpPort: 1234, remoteFileName: "backup.rsc" });
    assert.match(await fs.readFile(destination, "utf8"), /router-via-ftp/);
    assert.equal(logs.some((entry) => entry.level === "warn" && /fallback FTP/.test(entry.message)), true);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("melaporkan kegagalan jika API dan fallback FTP sama-sama gagal", async () => {
  const service = new MikrotikService({ push() {} });
  const connection = {
    menu: () => ({
      print: async () => [{ ".id": "*1", name: "backup.rsc" }],
      exec: async () => [],
    }),
  };
  service.resolveFtpPort = async () => 21;
  service.downloadRouterFileViaFtp = async () => {
    throw new Error("connection refused");
  };

  await assert.rejects(
    () => service.downloadRouterFile(connection, "backup.rsc", "/tmp/backup-never-created.rsc", {
      host: "192.0.2.1",
      user: "api",
      password: "secret",
    }),
    /API dan FTP: connection refused/
  );
});
