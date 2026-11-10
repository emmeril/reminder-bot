const path = require("path");
const { CONFIG } = require("../../config");

async function sendManualBackups({ mikrotikService, dataManager, notificationBot, activityLog, recipients, update }) {
  if (!Array.isArray(recipients) || recipients.length === 0) {
    throw new Error("Belum ada chat Telegram tujuan backup.");
  }

  const destinations = [...new Set(recipients)];
  const total = destinations.length * 2;
  const timestamp = new Date().toLocaleString("id-ID", { timeZone: dataManager.getTimezone() });
  let completed = 0;
  const files = [];

  const sources = [
    {
      kind: "mikrotik",
      label: "MikroTik",
      createPhase: "CREATING_MIKROTIK",
      sendPhase: "SENDING_MIKROTIK",
      async create() {
        return mikrotikService.generateDailyBackupFile();
      },
    },
    {
      kind: "database",
      label: "database aplikasi",
      createPhase: "CREATING_DATABASE",
      sendPhase: "SENDING_DATABASE",
      async create() {
        const backup = await dataManager.createBackup();
        const fileName = path.basename(CONFIG.DB_STORAGE);
        return { filePath: path.join(backup.backupDir, fileName), fileName };
      },
    },
  ];

  for (const source of sources) {
    const result = {
      kind: source.kind,
      status: "failed",
      fileName: "",
      sentCount: 0,
      failedCount: 0,
      error: "",
    };
    let cleanup;
    let attempted = 0;

    try {
      update({ phase: source.createPhase, completed, total });
      const backup = await source.create();
      cleanup = backup.cleanup;
      result.fileName = backup.fileName;
      const caption = `Backup ${source.label} manual\nWaktu: ${timestamp}`;

      for (const chatId of destinations) {
        try {
          await notificationBot.sendTelegramFile(chatId, backup.filePath, caption);
          result.sentCount += 1;
        } catch (error) {
          result.failedCount += 1;
          activityLog.push("warn", "manual-backup", `Gagal mengirim backup ${source.label} via Telegram: ${error.message}`);
        } finally {
          attempted += 1;
          completed += 1;
          update({ phase: source.sendPhase, completed, total });
        }
      }

      result.status = result.failedCount === 0 ? "sent" : result.sentCount > 0 ? "partial" : "failed";
    } catch (error) {
      result.error = error.message || String(error);
      completed += destinations.length - attempted;
      update({ phase: source.createPhase, completed, total });
    } finally {
      if (cleanup) {
        try {
          await cleanup();
        } catch (error) {
          activityLog.push("warn", "manual-backup", `Gagal membersihkan backup MikroTik sementara: ${error.message}`);
        }
      }
      activityLog.push(result.status === "sent" ? "info" : "warn", "manual-backup", `Backup ${source.label} manual: ${result.status}`, {
        fileName: result.fileName,
        sentCount: result.sentCount,
        failedCount: result.failedCount,
        error: result.error,
      });
      files.push(result);
    }
  }

  return { files };
}

module.exports = { sendManualBackups };
