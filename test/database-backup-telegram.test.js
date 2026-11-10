const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { afterEach, test } = require("node:test");

const TelegramManager = require("../src/telegram-manager");
const { CONFIG, DEFAULT_SETTINGS } = require("../src/config");
const { DatabaseBackupScheduler } = require("../src/schedulers");

const originalConfig = {
  DB_PATH: CONFIG.DB_PATH,
  DB_STORAGE: CONFIG.DB_STORAGE,
  TELEGRAM_BOT_TOKEN: CONFIG.TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_IDS: CONFIG.TELEGRAM_CHAT_IDS,
};
const originalSendDocument = TelegramManager.sendDocument;
const directories = [];

afterEach(async () => {
  Object.assign(CONFIG, originalConfig);
  TelegramManager.sendDocument = originalSendDocument;
  await Promise.all(directories.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function fixture({ enabled = true, chatIds = "101,202" } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "reminder-db-telegram-"));
  directories.push(directory);
  Object.assign(CONFIG, {
    DB_PATH: directory,
    DB_STORAGE: path.join(directory, "reminder_bot.sqlite"),
    TELEGRAM_BOT_TOKEN: "test-token",
    TELEGRAM_CHAT_IDS: chatIds,
  });
  const state = {
    databaseBackupLastRunDate: "",
    databaseBackupSnapshotName: "",
    databaseBackupTelegramLastRunDate: "",
    backupCount: 0,
    sendDateCount: 0,
    logs: [],
  };
  const dataManager = {
    getSettings() {
      return {
        ...DEFAULT_SETTINGS,
        databaseBackupTime: "00:00",
        mikrotikBackupTime: "23:59",
        mikrotikBackupTimezone: "UTC",
        enableDatabaseBackupToTelegram: enabled,
        databaseBackupLastRunDate: state.databaseBackupLastRunDate,
        databaseBackupSnapshotName: state.databaseBackupSnapshotName,
        databaseBackupTelegramLastRunDate: state.databaseBackupTelegramLastRunDate,
      };
    },
    async createBackup() {
      state.backupCount += 1;
      const name = new Date().toISOString().replace(/[:.]/g, "-");
      const backupDir = path.join(directory, "backups", name);
      await fs.mkdir(backupDir, { recursive: true });
      await fs.writeFile(path.join(backupDir, "reminder_bot.sqlite"), "sqlite-snapshot");
      return { backupDir, deletedCount: 0 };
    },
    async markDatabaseBackupRun(dateKey, backupDir) {
      state.databaseBackupLastRunDate = dateKey;
      state.databaseBackupSnapshotName = path.basename(backupDir);
    },
    async markDatabaseBackupTelegramRun(dateKey) {
      state.databaseBackupTelegramLastRunDate = dateKey;
      state.sendDateCount += 1;
    },
  };
  const scheduler = new DatabaseBackupScheduler(dataManager, {
    push(level, source, message) {
      state.logs.push({ level, source, message });
    },
  });
  return { scheduler, dataManager, state, directory };
}

test("waktu backup database independen dari waktu MikroTik", async () => {
  const { scheduler, dataManager } = await fixture({ enabled: false });
  const configured = dataManager.getSettings();
  assert.equal(scheduler.isDueNow(configured).configuredTime, "00:00");
  assert.equal(scheduler.isDueNow(configured).due, true);
  await scheduler.processDailyBackup();
  await scheduler.processDailyBackup();
  assert.equal(scheduler.isProcessing, false);
});

test("backup lokal dibuat sekali walaupun Telegram dimatikan", async () => {
  const { scheduler, state } = await fixture({ enabled: false });
  let sendCount = 0;
  TelegramManager.sendDocument = async () => { sendCount += 1; };
  await scheduler.processDailyBackup();
  await scheduler.processDailyBackup();
  assert.equal(state.backupCount, 1);
  assert.equal(sendCount, 0);
  assert.match(state.databaseBackupLastRunDate, /^\d{4}-\d{2}-\d{2}$/);
});

test("jadwal database mengirim snapshot SQLite ke seluruh chat Telegram satu kali per hari", async () => {
  const { scheduler, state } = await fixture();
  const sent = [];
  TelegramManager.sendDocument = async (chatId, filePath, caption) => {
    sent.push({ chatId, filePath, caption, content: await fs.readFile(filePath, "utf8") });
  };
  await scheduler.processDailyBackup();
  await scheduler.processDailyBackup();
  assert.equal(state.backupCount, 1);
  assert.equal(state.sendDateCount, 1);
  assert.equal(sent.length, 2);
  assert.deepEqual(sent.map(({ chatId }) => chatId), ["101", "202"]);
  assert.ok(sent.every((entry) => entry.filePath.endsWith("reminder_bot.sqlite")));
  assert.ok(sent.every((entry) => entry.content === "sqlite-snapshot"));
  assert.ok(sent.every((entry) => entry.caption.includes("Backup database aplikasi (SQLite)")));
  assert.equal(state.databaseBackupTelegramLastRunDate, state.databaseBackupLastRunDate);
});

test("Telegram belum dikonfigurasi tidak membatalkan backup lokal dan bisa dikirim kemudian", async () => {
  const { scheduler, state } = await fixture();
  CONFIG.TELEGRAM_BOT_TOKEN = "";
  TelegramManager.sendDocument = async () => {};
  await scheduler.processDailyBackup();
  assert.equal(state.backupCount, 1);
  assert.equal(state.databaseBackupTelegramLastRunDate, "");
  CONFIG.TELEGRAM_BOT_TOKEN = "test-token";
  scheduler.nextTelegramAttemptAt = 0;
  let sent = 0;
  TelegramManager.sendDocument = async () => { sent += 1; };
  await scheduler.processDailyBackup();
  assert.equal(state.backupCount, 1);
  assert.equal(sent, 2);
  assert.equal(state.sendDateCount, 1);
});

test("gagal kirim seluruh tujuan dicoba ulang tanpa membuat backup baru", async () => {
  const { scheduler, state } = await fixture({ chatIds: "101" });
  TelegramManager.sendDocument = async () => { throw new Error("koneksi terputus"); };
  await scheduler.processDailyBackup();
  assert.equal(state.backupCount, 1);
  assert.equal(state.sendDateCount, 0);
  const firstAttempt = scheduler.nextTelegramAttemptAt;
  assert.ok(firstAttempt > Date.now());
  await scheduler.processDailyBackup();
  assert.equal(state.backupCount, 1);
  scheduler.nextTelegramAttemptAt = 0;
  let sends = 0;
  TelegramManager.sendDocument = async () => { sends += 1; };
  await scheduler.processDailyBackup();
  assert.equal(sends, 1);
  assert.equal(state.backupCount, 1);
  assert.equal(state.sendDateCount, 1);
});

test("snapshot hilang dibuat ulang sebelum dikirim ke Telegram", async () => {
  const { scheduler, state, directory } = await fixture({ chatIds: "101" });
  await scheduler.processDailyBackup();
  assert.equal(state.backupCount, 1);
  const oldDir = path.join(directory, "backups", state.databaseBackupSnapshotName);
  await fs.rm(oldDir, { recursive: true, force: true });
  state.databaseBackupTelegramLastRunDate = "";
  scheduler.nextTelegramAttemptAt = 0;
  let sent = 0;
  TelegramManager.sendDocument = async () => { sent += 1; };
  await scheduler.processDailyBackup();
  assert.equal(state.backupCount, 2);
  assert.equal(sent, 1);
});

test("keberhasilan sebagian tujuan tidak mengirim ulang ke chat yang sudah menerima", async () => {
  const { scheduler, state } = await fixture();
  let attempts = 0;
  TelegramManager.sendDocument = async (chatId) => {
    attempts += 1;
    if (chatId === "202") throw new Error("chat tidak dapat diakses");
  };
  await scheduler.processDailyBackup();
  await scheduler.processDailyBackup();
  assert.equal(attempts, 2);
  assert.equal(state.sendDateCount, 1);
  assert.ok(state.logs.some((entry) => entry.source === "database-backup" && entry.level === "warn"));
});


test("konfigurasi database lama mempertahankan jam backup MikroTik sebagai jadwal awal", async () => {
  const { DataManager } = require("../src/app");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "reminder-legacy-settings-"));
  directories.push(directory);
  const originalGetPath = DataManager.prototype.getPath;
  const manager = new DataManager({ push() {} });
  manager.getPath = (name) => path.join(directory, name);
  await fs.writeFile(path.join(directory, "settings.json"), JSON.stringify({ mikrotikBackupTime: "04:20" }));
  try {
    const settings = await manager.loadLegacySettings();
    assert.equal(settings.databaseBackupTime, "04:20");
    await fs.writeFile(path.join(directory, "settings.json"), JSON.stringify({
      mikrotikBackupTime: "04:20",
      databaseBackupTime: "05:45",
    }));
    const updated = await manager.loadLegacySettings();
    assert.equal(updated.databaseBackupTime, "05:45");
  } finally {
    manager.getPath = originalGetPath;
  }
});
