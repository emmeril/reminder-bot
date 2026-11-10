const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test, afterEach } = require("node:test");

const { CONFIG } = require("../src/config");
const { sendManualBackups } = require("../src/modules/web-server/manual-backup");

const originalStorage = CONFIG.DB_STORAGE;
const dirs = [];

afterEach(async () => {
  CONFIG.DB_STORAGE = originalStorage;
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function createFixture({ failMikrotik = false, failDatabase = false, failDelivery = () => false } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "backup-bundle-"));
  dirs.push(directory);
  CONFIG.DB_STORAGE = path.join(directory, "database.sqlite");
  const routerFile = path.join(directory, "router.rsc");
  const databaseDir = path.join(directory, "local-backups");
  const state = { created: [], cleaned: 0, sent: [], progress: [], logs: [] };

  const mikrotikService = {
    async generateDailyBackupFile() {
      state.created.push("mikrotik");
      if (failMikrotik) throw new Error("Router tidak terhubung");
      await fs.writeFile(routerFile, "router configuration");
      return {
        filePath: routerFile,
        fileName: "router.rsc",
        async cleanup() {
          state.cleaned += 1;
          await fs.rm(routerFile);
        },
      };
    },
  };
  const dataManager = {
    getTimezone: () => "Asia/Jakarta",
    async createBackup() {
      state.created.push("database");
      if (failDatabase) throw new Error("SQLite tidak tersedia");
      await fs.mkdir(databaseDir, { recursive: true });
      await fs.writeFile(path.join(databaseDir, "database.sqlite"), "sqlite snapshot");
      return { backupDir: databaseDir };
    },
  };
  const notificationBot = {
    async sendTelegramFile(chatId, filePath, caption) {
      const content = await fs.readFile(filePath, "utf8");
      state.sent.push({ chatId, filePath, caption, content });
      if (failDelivery(chatId, filePath)) throw new Error("Telegram gagal");
    },
  };
  const activityLog = {
    push(level, source, message, details) { state.logs.push({ level, source, message, details }); },
  };
  return {
    state, directory,
    args: { mikrotikService, dataManager, notificationBot, activityLog,
      recipients: ["101", "202"], update: (progress) => state.progress.push(progress) },
  };
}

test("tombol manual membuat dua file, mengirim ke semua chat dan membersihkan export sementara", async () => {
  const { state, directory, args } = await createFixture();
  const result = await sendManualBackups(args);
  assert.deepEqual(state.created, ["mikrotik", "database"]);
  assert.deepEqual(result.files.map(({ kind, status, sentCount, failedCount }) => ({
    kind, status, sentCount, failedCount,
  })), [
    { kind: "mikrotik", status: "sent", sentCount: 2, failedCount: 0 },
    { kind: "database", status: "sent", sentCount: 2, failedCount: 0 },
  ]);
  assert.deepEqual(state.sent.map(({ chatId }) => chatId), ["101", "202", "101", "202"]);
  assert.equal(state.sent[0].content, "router configuration");
  assert.equal(state.sent[2].content, "sqlite snapshot");
  assert.match(state.sent[2].caption, /Backup database aplikasi manual/);
  assert.equal(state.cleaned, 1);
  await assert.rejects(fs.stat(path.join(directory, "router.rsc")), { code: "ENOENT" });
  assert.equal(await fs.readFile(path.join(directory, "local-backups", "database.sqlite"), "utf8"), "sqlite snapshot");
  assert.equal(state.progress.at(-1).completed, 4);
  assert.equal(state.progress.at(-1).total, 4);
  assert.equal(state.logs.filter((entry) => entry.source === "manual-backup" && entry.level === "info").length, 2);
});

test("gagal membuat MikroTik tetap mengirim backup database", async () => {
  const { state, args } = await createFixture({ failMikrotik: true });
  const result = await sendManualBackups(args);
  assert.equal(result.files[0].status, "failed");
  assert.equal(result.files[0].error, "Router tidak terhubung");
  assert.equal(result.files[1].status, "sent");
  assert.equal(state.sent.length, 2);
  assert.deepEqual(state.created, ["mikrotik", "database"]);
  assert.equal(state.progress.at(-1).completed, 4);
});

test("gagal membuat database tetap mengirim dan membersihkan backup MikroTik", async () => {
  const { state, args } = await createFixture({ failDatabase: true });
  const result = await sendManualBackups(args);
  assert.equal(result.files[0].status, "sent");
  assert.equal(result.files[1].status, "failed");
  assert.match(result.files[1].error, /SQLite/);
  assert.equal(state.sent.length, 2);
  assert.equal(state.cleaned, 1);
});

test("kegagalan sebagian tujuan Telegram dilaporkan per file tanpa menggugurkan kiriman lain", async () => {
  const { state, args } = await createFixture({ failDelivery: (chatId, filePath) => (
    chatId === "202" && filePath.endsWith(".sqlite")
  ) });
  const result = await sendManualBackups(args);
  assert.equal(result.files[0].status, "sent");
  assert.equal(result.files[1].status, "partial");
  assert.equal(result.files[1].sentCount, 1);
  assert.equal(result.files[1].failedCount, 1);
  assert.equal(state.sent.length, 4);
  assert.ok(state.logs.some((entry) => entry.level === "warn" && /database aplikasi/.test(entry.message)));
});

test("semua tujuan gagal tetap memberikan dua status gagal dan menuntaskan pekerjaan", async () => {
  const { state, args } = await createFixture({ failDelivery: () => true });
  const result = await sendManualBackups(args);
  assert.deepEqual(result.files.map((item) => item.status), ["failed", "failed"]);
  assert.deepEqual(result.files.map((item) => item.failedCount), [2, 2]);
  assert.equal(state.cleaned, 1);
  assert.equal(state.progress.at(-1).completed, 4);
});

test("chat yang sama tidak dikirimi dua kali untuk satu file", async () => {
  const { state, args } = await createFixture();
  args.recipients = ["101", "101"];
  await sendManualBackups(args);
  assert.deepEqual(state.sent.map(({ chatId }) => chatId), ["101", "101"]);
  assert.equal(state.progress.at(-1).total, 2);
});

test("tidak memulai pembuatan file tanpa tujuan Telegram", async () => {
  const { state, args } = await createFixture();
  args.recipients = [];
  await assert.rejects(() => sendManualBackups(args), /chat Telegram/);
  assert.equal(state.created.length, 0);
});
