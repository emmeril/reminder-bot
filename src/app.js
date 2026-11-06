require("dotenv").config({ quiet: true });

const cron = require("node-cron");
const { CONFIG, MONTH_NAMES } = require("./config");
const ActivityLog = require("./activity-log");
const AuthManager = require("./auth-manager");
const { MidtransService } = require("./midtrans-service");
const {
  ApDownNotifier,
  DatabaseBackupScheduler,
  HotspotReactivationScheduler,
  HotspotStatusSyncScheduler,
  MikrotikBackupScheduler,
  ReminderScheduler,
  VoucherRevenueSyncScheduler,
  WhatsAppProviderStatusNotifier,
} = require("./schedulers");
const TemplateManager = require("./template-manager");
const DataManager = require("./modules/data-manager/service");
const MikrotikService = require("./modules/mikrotik/service");
const NotificationBot = require("./modules/notifications/service");
const WebServer = require("./modules/web-server/service");
const {
  assertSecureConfiguration,
  collectSecurityWarnings,
  getBillingPeriodParts,
} = require("./utils");

// ===============================
// SEND MONTHLY RESET NOTIFICATION
// ===============================

async function sendMonthlyResetNotification(notificationBot, dataManager, activityLog) {
  const resetResult = await dataManager.ensureMonthlyPaymentReset();
  if (!resetResult.reset) {
    return;
  }

  const count = resetResult.count;
  const settings = dataManager.getSettings();
  const now = new Date();
  const { year: currentYear, month: currentMonth } = getBillingPeriodParts(
    now,
    dataManager.getTimezone()
  );
  const overdue = dataManager.getOverdueContacts(currentYear, currentMonth);

  activityLog.push("info", "billing", `Monthly payment status reset completed for ${count} contact(s)`);

  if (!settings.notifyAdminsOnPaymentReset || !notificationBot.getStatus().whatsappProviderEnabled) {
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

async function runScheduledTasks(tasks, activityLog) {
  const results = await Promise.allSettled(
    tasks.map((task) => Promise.resolve().then(() => task.run()))
  );

  results.forEach((result, index) => {
    if (result.status !== "rejected") return;
    const errorMessage = result.reason?.message || String(result.reason);
    activityLog.push("error", "scheduler", `Scheduled task ${tasks[index].name} failed: ${errorMessage}`, {
      task: tasks[index].name,
      error: errorMessage,
    });
  });

  return results;
}

// ===============================
// APPLICATION BOOTSTRAP
// ===============================

async function bootstrap() {
  assertSecureConfiguration();
  if (!cron.validate(CONFIG.CRON_SCHEDULE)
    || !cron.validate(CONFIG.HOTSPOT_STATUS_SYNC_SCHEDULE)
    || !cron.validate(CONFIG.SENT_HISTORY_CLEANUP_SCHEDULE)
    || !cron.validate(CONFIG.VOUCHER_REVENUE_SYNC_SCHEDULE)) {
    throw new Error("Konfigurasi cron tidak valid.");
  }

  const activityLog = new ActivityLog();
  for (const warning of collectSecurityWarnings()) {
    activityLog.push("warn", "config", warning);
  }

  const authManager = new AuthManager(activityLog);
  const dataManager = new DataManager(activityLog);
  const templateManager = new TemplateManager(activityLog);
  const notificationBot = new NotificationBot(dataManager, activityLog);
  const mikrotikService = new MikrotikService(activityLog);
  const apDownNotifier = new ApDownNotifier(mikrotikService, notificationBot, dataManager, activityLog);
  const whatsappProviderStatusNotifier = new WhatsAppProviderStatusNotifier(
    notificationBot,
    dataManager,
    activityLog
  );
  const mikrotikBackupScheduler = new MikrotikBackupScheduler(
    mikrotikService,
    notificationBot,
    dataManager,
    activityLog
  );
  const databaseBackupScheduler = new DatabaseBackupScheduler(dataManager, activityLog);
  const hotspotReactivationScheduler = new HotspotReactivationScheduler(
    mikrotikService,
    dataManager,
    activityLog
  );
  const hotspotStatusSyncScheduler = new HotspotStatusSyncScheduler(
    mikrotikService,
    dataManager,
    activityLog
  );
  const voucherRevenueSyncScheduler = new VoucherRevenueSyncScheduler(
    mikrotikService,
    dataManager,
    activityLog
  );

  await dataManager.loadAll();
  await dataManager.syncActiveRemindersWithTemplates(await templateManager.listTemplates());

  const reminderScheduler = new ReminderScheduler(notificationBot, dataManager, activityLog);
  const webServer = new WebServer(
    notificationBot,
    dataManager,
    templateManager,
    activityLog,
    reminderScheduler,
    authManager,
    mikrotikService,
    hotspotReactivationScheduler,
    null,
    voucherRevenueSyncScheduler
  );

  await sendMonthlyResetNotification(notificationBot, dataManager, activityLog);

  const scheduledJobs = [];
  const intervals = [];
  const backgroundTasks = new Set();
  const trackBackgroundTask = (promise) => {
    const task = Promise.resolve(promise);
    backgroundTasks.add(task);
    task.then(
      () => backgroundTasks.delete(task),
      () => backgroundTasks.delete(task)
    );
    return task;
  };
  scheduledJobs.push(cron.schedule(CONFIG.CRON_SCHEDULE, () => {
    void trackBackgroundTask(runScheduledTasks([
      { name: "reminders", run: () => reminderScheduler.processDueReminders() },
      { name: "ap-monitor", run: () => apDownNotifier.processNetwatchChanges() },
      { name: "whatsapp-provider-status", run: () => whatsappProviderStatusNotifier.processStatusChanges() },
      { name: "mikrotik-backup", run: () => mikrotikBackupScheduler.processDailyBackup() },
      { name: "database-backup", run: () => databaseBackupScheduler.processDailyBackup() },
      { name: "hotspot-reactivation", run: () => hotspotReactivationScheduler.processDueReactivations() },
      { name: "midtrans-payments", run: () => webServer.reconcilePendingMidtransPayments() },
      { name: "monthly-payment-reset", run: () => sendMonthlyResetNotification(notificationBot, dataManager, activityLog) },
    ], activityLog));
  }));

  scheduledJobs.push(cron.schedule(CONFIG.HOTSPOT_STATUS_SYNC_SCHEDULE, () => {
    void trackBackgroundTask(runScheduledTasks([
      { name: "hotspot-status-sync", run: () => hotspotStatusSyncScheduler.processStatusSync() },
    ], activityLog));
  }));

  scheduledJobs.push(cron.schedule(CONFIG.VOUCHER_REVENUE_SYNC_SCHEDULE, () => {
    void trackBackgroundTask(runScheduledTasks([
      { name: "voucher-revenue-sync", run: () => voucherRevenueSyncScheduler.processSync() },
    ], activityLog));
  }));

  scheduledJobs.push(cron.schedule(CONFIG.SENT_HISTORY_CLEANUP_SCHEDULE, () => {
    void trackBackgroundTask(dataManager.cleanupSentHistory().catch((error) => {
      activityLog.push("error", "storage", `Sent History auto-clean failed: ${error.message}`);
    }));
  }));

  intervals.push(setInterval(() => {
    void trackBackgroundTask(dataManager.saveAll().catch((error) => {
      activityLog.push("error", "storage", `Auto-save failed: ${error.message}`);
    }));
  }, CONFIG.AUTO_SAVE_INTERVAL));

  intervals.push(setInterval(() => {
    authManager.cleanupExpiredSessions();
  }, 60 * 60 * 1000));

  let shutdownPromise = null;
  const shutdown = (reason = "manual") => {
    if (shutdownPromise) return shutdownPromise;

    shutdownPromise = (async () => {
      activityLog.push("info", "shutdown", `Graceful shutdown dimulai: ${reason}`);
      webServer.ready = false;
      scheduledJobs.forEach((job) => {
        job.stop();
        job.destroy?.();
      });
      intervals.forEach((interval) => clearInterval(interval));

      const shutdownWork = (async () => {
        await webServer.stop();
        await Promise.allSettled([...backgroundTasks]);
        await notificationBot.shutdown().catch((error) => {
          activityLog.push("error", "shutdown", `Transport gagal dihentikan: ${error.message}`);
        });
        await dataManager.saveAll().catch((error) => {
          activityLog.push("error", "shutdown", `Penyimpanan akhir gagal: ${error.message}`);
        });
        await dataManager.close().catch((error) => {
          activityLog.push("error", "shutdown", `Database gagal ditutup: ${error.message}`);
        });
      })();

      let timeoutId;
      try {
        await Promise.race([
          shutdownWork,
          new Promise((_, reject) => {
            timeoutId = setTimeout(() => reject(new Error("Graceful shutdown timeout.")), Math.max(1_000, CONFIG.SHUTDOWN_TIMEOUT));
            timeoutId.unref?.();
          }),
        ]);
        activityLog.push("info", "shutdown", "Graceful shutdown selesai");
      } finally {
        clearTimeout(timeoutId);
      }
    })();
    return shutdownPromise;
  };

  const terminate = (reason, exitCode) => {
    shutdown(reason)
      .catch((error) => {
        activityLog.push("error", "shutdown", `Graceful shutdown gagal: ${error.message}`);
      })
      .finally(() => process.exit(exitCode));
  };
  const handleSigint = () => terminate("SIGINT", 0);
  const handleSigterm = () => terminate("SIGTERM", 0);
  const handleUncaughtException = (error) => {
    activityLog.push("error", "runtime", `Uncaught exception: ${error.message}`, { stack: error.stack });
    terminate("uncaughtException", 1);
  };
  const handleUnhandledRejection = (reason) => {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    activityLog.push("error", "runtime", `Unhandled rejection: ${error.message}`, { stack: error.stack });
    terminate("unhandledRejection", 1);
  };

  process.once("SIGINT", handleSigint);
  process.once("SIGTERM", handleSigterm);
  process.once("uncaughtException", handleUncaughtException);
  process.once("unhandledRejection", handleUnhandledRejection);

  await webServer.start();
  void trackBackgroundTask(voucherRevenueSyncScheduler.processSync().catch((error) => {
    activityLog.push("error", "voucher", `Sinkronisasi awal pendapatan voucher gagal: ${error.message}`);
  }));
  const notificationInitialization = notificationBot.initialize()
    .then(() => activityLog.push("info", "notification", "Notification transport initialized"))
    .catch((error) => {
      activityLog.push("error", "notification", `Initial notification startup failed: ${error.message}`);
    });

  return {
    activityLog,
    dataManager,
    notificationBot,
    notificationInitialization,
    webServer,
    async shutdown(reason = "manual") {
      process.removeListener("SIGINT", handleSigint);
      process.removeListener("SIGTERM", handleSigterm);
      process.removeListener("uncaughtException", handleUncaughtException);
      process.removeListener("unhandledRejection", handleUnhandledRejection);
      return shutdown(reason);
    },
  };
}

module.exports = {
  DataManager,
  MidtransService,
  MikrotikService,
  NotificationBot,
  WebServer,
  bootstrap,
  runScheduledTasks,
};
