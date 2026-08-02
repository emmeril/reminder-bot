const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { afterEach, test } = require("node:test");

const { DataManager } = require("../src/app");
const { CONFIG, DEFAULT_SETTINGS } = require("../src/config");
const { DatabaseBackupScheduler } = require("../src/schedulers");

const temporaryDirectories = [];
const originalDbPath = CONFIG.DB_PATH;
const originalDbStorage = CONFIG.DB_STORAGE;
const originalRetentionDays = CONFIG.DB_BACKUP_RETENTION_DAYS;

afterEach(async () => {
  CONFIG.DB_PATH = originalDbPath;
  CONFIG.DB_STORAGE = originalDbStorage;
  CONFIG.DB_BACKUP_RETENTION_DAYS = originalRetentionDays;
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    fs.rm(directory, { recursive: true, force: true })
  )));
});

test("membuat backup SQLite dan menghapus backup database berumur 3 hari", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "reminder-database-backup-"));
  temporaryDirectories.push(directory);
  CONFIG.DB_PATH = directory;
  CONFIG.DB_STORAGE = path.join(directory, "reminder_bot.sqlite");
  CONFIG.DB_BACKUP_RETENTION_DAYS = 3;

  const now = new Date("2026-08-02T02:00:00.000Z");
  const backupRoot = path.join(directory, "backups");
  const expiredDir = path.join(backupRoot, "2026-07-30T02-00-00-000Z");
  const recentDir = path.join(backupRoot, "2026-07-31T02-00-00-000Z");
  const mikrotikDir = path.join(backupRoot, "mikrotik");

  await Promise.all([
    fs.mkdir(expiredDir, { recursive: true }),
    fs.mkdir(recentDir, { recursive: true }),
    fs.mkdir(mikrotikDir, { recursive: true }),
  ]);
  await fs.utimes(expiredDir, new Date("2026-07-30T02:00:00.000Z"), new Date("2026-07-30T02:00:00.000Z"));
  await fs.utimes(recentDir, new Date("2026-07-31T02:00:00.000Z"), new Date("2026-07-31T02:00:00.000Z"));

  const manager = new DataManager({ push() {} });
  manager.sequelize = {
    async query(sql) {
      const escapedPath = sql.match(/VACUUM INTO '(.+)'/)[1];
      await fs.writeFile(escapedPath.replace(/''/g, "'"), "sqlite-backup");
    },
  };

  const result = await manager.createBackup(now);

  assert.equal(result.deletedCount, 1);
  await assert.rejects(() => fs.stat(expiredDir), { code: "ENOENT" });
  assert.equal((await fs.stat(recentDir)).isDirectory(), true);
  assert.equal((await fs.stat(mikrotikDir)).isDirectory(), true);
  assert.equal(
    await fs.readFile(path.join(result.backupDir, "reminder_bot.sqlite"), "utf8"),
    "sqlite-backup"
  );
});

test("scheduler database hanya menjalankan satu backup per tanggal", async () => {
  let lastRunDate = "";
  let backupCount = 0;
  const dataManager = {
    getSettings() {
      return {
        ...DEFAULT_SETTINGS,
        mikrotikBackupTime: "00:00",
        mikrotikBackupTimezone: "UTC",
        databaseBackupLastRunDate: lastRunDate,
      };
    },
    async createBackup() {
      backupCount += 1;
      return { backupDir: "/tmp/backup", deletedCount: 0 };
    },
    async markDatabaseBackupRun(dateKey) {
      lastRunDate = dateKey;
    },
  };
  const scheduler = new DatabaseBackupScheduler(dataManager, { push() {} });

  await scheduler.processDailyBackup();
  await scheduler.processDailyBackup();

  assert.equal(backupCount, 1);
  assert.match(lastRunDate, /^\d{4}-\d{2}-\d{2}$/);
});
