require("dotenv").config();

const cron = require("node-cron");

const { CONFIG, MONTH_NAMES } = require("./src/config");
const { collectSecurityWarnings } = require("./src/utils");
const { ActivityLog, AuthManager, MikrotikService, DataManager, TemplateManager, NotificationBot, ReminderScheduler, ApDownNotifier, WebServer } = require("./src/services");
async function sendMonthlyResetNotification(notificationBot, dataManager, activityLog) {
  const resetResult = await dataManager.ensureMonthlyPaymentReset();
  if (!resetResult.reset) {
    return;
  }

  const count = resetResult.count;
  const settings = dataManager.getSettings();
  const now = new Date();
  const currentMonth = now.getMonth() + 1;
  const currentYear = now.getFullYear();
  const prevMonth = currentMonth === 1 ? 12 : currentMonth - 1;
  const prevYear = currentMonth === 1 ? currentYear - 1 : currentYear;
  const overdue = dataManager.getOverdueContacts(prevYear, prevMonth);

  activityLog.push("info", "billing", `Monthly payment status reset completed for ${count} contact(s)`);

  if (!settings.notifyAdminsOnPaymentReset || !notificationBot.isReady) {
    return;
  }

  let body = `Status pembayaran bulan ${MONTH_NAMES[currentMonth]} ${currentYear} telah direset.\n\nKontak yang direset: ${count}.`;
  if (overdue.length > 0) {
    body += `\n\nMasih ada ${overdue.length} kontak dengan tunggakan dari periode sebelumnya:\n${overdue.slice(0, 8).map((item, index) => `${index + 1}. ${item.name}`).join("\n")}`;
    if (overdue.length > 8) {
      body += `\n...dan ${overdue.length - 8} lainnya.`;
    }
  } else {
    body += "\n\nTidak ada tunggakan dari periode sebelumnya.";
  }

  await notificationBot.sendAdminBroadcast("Reset pembayaran bulanan", body);
}

(async () => {
  const activityLog = new ActivityLog();
  for (const warning of collectSecurityWarnings(CONFIG)) {
    activityLog.push("warn", "config", warning);
  }

  const authManager = new AuthManager(activityLog);
  const dataManager = new DataManager(activityLog);
  const templateManager = new TemplateManager(activityLog);
  const notificationBot = new NotificationBot(dataManager, activityLog);
  const mikrotikService = new MikrotikService(activityLog);
  const apDownNotifier = new ApDownNotifier(mikrotikService, notificationBot, dataManager, activityLog);

  await dataManager.loadAll();

  const reminderScheduler = new ReminderScheduler(notificationBot, dataManager, activityLog);
  const webServer = new WebServer(
    notificationBot,
    dataManager,
    templateManager,
    activityLog,
    reminderScheduler,
    authManager,
    mikrotikService
  );

  await dataManager.ensureMonthlyPaymentReset();

  cron.schedule(CONFIG.CRON_SCHEDULE, () => {
    Promise.all([
      reminderScheduler.processDueReminders(),
      apDownNotifier.processNetwatchChanges(),
    ]).catch((error) => {
      activityLog.push("error", "scheduler", `Cron execution failed: ${error.message}`);
    });
  });

  cron.schedule(CONFIG.RESET_PAYMENT_SCHEDULE, () => {
    sendMonthlyResetNotification(notificationBot, dataManager, activityLog).catch((error) => {
      activityLog.push("error", "billing", `Monthly reset failed: ${error.message}`);
    });
  });

  setInterval(() => {
    dataManager.saveAll().catch((error) => {
      activityLog.push("error", "storage", `Auto-save failed: ${error.message}`);
    });
  }, CONFIG.AUTO_SAVE_INTERVAL);

  setInterval(() => {
    dataManager.createBackup().catch((error) => {
      activityLog.push("error", "storage", `Backup failed: ${error.message}`);
    });
  }, CONFIG.BACKUP_INTERVAL);

  setInterval(() => {
    authManager.cleanupExpiredSessions();
  }, 60 * 60 * 1000);

  process.on("SIGINT", async () => {
    activityLog.push("info", "shutdown", "Saving data before shutdown");
    await dataManager.saveAll();
    process.exit(0);
  });

  process.on("uncaughtException", async (error) => {
    activityLog.push("error", "runtime", `Uncaught exception: ${error.message}`);
    await dataManager.saveAll();
    process.exit(1);
  });

  process.on("unhandledRejection", async (reason) => {
    const message = reason instanceof Error ? reason.message : String(reason);
    activityLog.push("error", "runtime", `Unhandled rejection: ${message}`);
    await dataManager.saveAll();
    process.exit(1);
  });

  webServer.start();
  notificationBot.initialize()
    .then(() => notificationBot.startKeepAlive())
    .catch((error) => {
      activityLog.push("error", "whatsapp", `Initial WhatsApp startup failed: ${error.message}`);
      notificationBot.scheduleReconnect();
    });
})();



