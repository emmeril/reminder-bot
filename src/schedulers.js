const { CONFIG, DEFAULT_SETTINGS } = require("./config");
const TelegramManager = require("./telegram-manager");
const {
  addMonthsSafely,
  formatDate,
  formatDateTime,
  getDateTimePartsInTimezone,
  isValidTimeZone,
  parseNetwatchSinceDate,
  sanitizeInput,
  sanitizePositiveInteger,
  sanitizeTimeHHMM,
} = require("./utils");

class ReminderScheduler {
  constructor(notificationBot, dataManager, activityLog) {
    this.notificationBot = notificationBot;
    this.dataManager = dataManager;
    this.activityLog = activityLog;
    this.isProcessing = false;
  }

  buildNextReminder(reminder) {
    const timeZone = this.dataManager.getTimezone();
    const nextDate = addMonthsSafely(reminder.reminderDateTime, 1, timeZone);
    const nextDateText = formatDate(nextDate, timeZone);
    const nextMonthName = nextDate.toLocaleString("id-ID", { month: "long", timeZone });
    const nextMessage = reminder.message
      .replace(/\d{4}-\d{2}-\d{2}/, nextDateText)
      .replace(/bulan\s+\w+/gi, `bulan ${nextMonthName}`);

    return {
      contactId: reminder.contactId,
      reminderDateTime: nextDate,
      message: nextMessage,
      templateName: reminder.templateName || null,
    };
  }

  async rescheduleMonthlyReminder(reminder, sourceStatus = "SENT") {
    if (!this.dataManager.getSettings().autoRescheduleMonthly) return null;

    const nextReminder = this.buildNextReminder(reminder);
    const createdReminder = await this.dataManager.addReminder(nextReminder);
    this.activityLog.push("info", "scheduler", `Reminder ${reminder.id} dijadwalkan ulang bulanan`, {
      reminderId: reminder.id,
      nextReminderId: createdReminder.id,
      contactId: reminder.contactId || null,
      sourceStatus,
      nextReminderDateTime: createdReminder.reminderDateTime,
    });
    return createdReminder;
  }

  isPaidReminder(reminder) {
    const contact = this.dataManager.getResolvedReminderContact(reminder);
    return String(contact?.dueStatus || "").toUpperCase() === "PAID"
      || String(contact?.paymentStatus || "").toUpperCase() === "PAID";
  }

  getDueTime(reminder) {
    return new Date(reminder.nextDeliveryAttemptAt || reminder.reminderDateTime).getTime();
  }

  async processDueReminders() {
    if (this.isProcessing) {
      this.activityLog.push("info", "scheduler", "Skipping run because previous cycle is still processing");
      return;
    }

    const status = this.notificationBot.getTransportStatus
      ? await this.notificationBot.getTransportStatus()
      : this.notificationBot.getStatus();
    if (!status.whatsappProviderEnabled) {
      this.activityLog.push("info", "scheduler", "Skipping run because no WhatsApp provider is configured");
      return;
    }
    if (status.outboundEnabled !== true) {
      const pendingCount = this.dataManager.markDueRemindersPending
        ? await this.dataManager.markDueRemindersPending(new Date(), status.selectedProvider || null)
        : 0;
      this.activityLog.push("info", "scheduler", "Skipping run because outbound WhatsApp delivery is paused");
      if (pendingCount > 0) {
        this.activityLog.push("info", "whatsapp.message.queued", `${pendingCount} due reminder(s) tetap pending`, {
          event: "whatsapp.message.queued",
          provider: status.selectedProvider || null,
          pendingCount,
        });
      }
      return;
    }

    // Provider yang putus tetap diproses. sendMessage() akan mencatat kegagalan
    // per reminder, lalu reminder tersebut diarsipkan dan siklus bulan berikutnya
    // tetap dibuat. Hanya pengiriman yang memang sengaja dipause yang ditahan.
    if (!status.isAvailable) {
      this.activityLog.push("warn", "scheduler", "WhatsApp is not ready; due reminders will be finalized as failed");
    }

    this.isProcessing = true;

    try {
      const now = Date.now();
      const dueReminders = this.dataManager.getSortedReminders().filter(
        (reminder) => this.getDueTime(reminder) <= now
      );

      if (dueReminders.length === 0) {
        return;
      }

      this.activityLog.push("info", "scheduler", `Processing ${dueReminders.length} due reminder(s)`);

      for (const dueReminder of dueReminders) {
        let claimedReminderId = null;
        let activeReminder = dueReminder;
        try {
          const reminder = await this.dataManager.claimDueReminder(dueReminder.id, new Date());
          if (!reminder) {
            this.activityLog.push("info", "scheduler", `Reminder ${dueReminder.id} dilewati karena sudah berubah atau sedang diproses`);
            continue;
          }
          claimedReminderId = reminder.id;
          activeReminder = reminder;

          if (reminder.deliveryAttemptedAt && !reminder.providerStatus) {
            const errorMessage = reminder.lastDeliveryError || "Pengiriman sebelumnya gagal";
            await this.dataManager.moveToSent(reminder.id, {
              sentAt: reminder.lastDeliveryAttemptAt || new Date().toISOString(),
              deliveryStatus: "FAILED",
              deliveryError: errorMessage,
              providerStatus: "failed",
              providerError: errorMessage,
            });
            claimedReminderId = null;
            await this.rescheduleMonthlyReminder(reminder, "FAILED");
            this.activityLog.push("warn", "delivery", `Reminder ${reminder.id} tidak dikirim ulang setelah kegagalan sebelumnya`, {
              reminderId: reminder.id,
              error: errorMessage,
              phoneNumber: reminder.phoneNumber,
              retryScheduled: false,
            });
            continue;
          }

          if (this.isPaidReminder(reminder)) {
            await this.dataManager.moveToSent(reminder.id, {
              sentAt: new Date().toISOString(),
              deliveryStatus: "SKIPPED_PAID",
            });
            claimedReminderId = null;
            await this.rescheduleMonthlyReminder(reminder, "SKIPPED_PAID");
            this.activityLog.push("info", "scheduler", `Reminder ${reminder.id} dilewati karena status jatuh tempo sudah lunas`, {
              reminderId: reminder.id,
              contactId: reminder.contactId || null,
              phoneNumber: reminder.phoneNumber,
            });
            continue;
          }

          const targetPhoneNumber = reminder.phoneNumber;
          const attemptedReminder = await this.dataManager.markReminderDeliveryAttempt(
            reminder.id,
            status.selectedProvider || null
          );
          if (!attemptedReminder) {
            this.activityLog.push("warn", "delivery", `Reminder ${reminder.id} dilewati karena sudah pernah dicoba`, {
              reminderId: reminder.id,
              phoneNumber: reminder.phoneNumber,
            });
            continue;
          }
          let sendResult;
          try {
            sendResult = await this.notificationBot.sendMessage(targetPhoneNumber, reminder.message, {
              maxAttempts: 1,
              context: { type: "reminder", reminderId: reminder.id },
            });
            if (sendResult?.unconfirmed === true || sendResult?.confirmed === false) {
              const error = new Error("Provider tidak memberikan konfirmasi pengiriman");
              error.code = "WHATSAPP_SEND_UNCONFIRMED";
              throw error;
            }
          } catch (error) {
            const errorMessage = error?.message || String(error);
            const attempts = Math.max(1, Number(attemptedReminder.deliveryAttempts) || 1);

            await this.dataManager.moveToSent(reminder.id, {
              sentAt: new Date().toISOString(),
              deliveryStatus: "FAILED",
              deliveryError: errorMessage,
              whatsappProvider: status.selectedProvider || null,
              providerStatus: "failed",
              providerError: errorMessage,
            });
            claimedReminderId = null;
            await this.rescheduleMonthlyReminder(reminder, "FAILED");
            this.activityLog.push("error", "whatsapp.message.failed", `Message failed: ${targetPhoneNumber}`, {
              event: "whatsapp.message.failed",
              reminderId: reminder.id,
              error: errorMessage,
              phoneNumber: reminder.phoneNumber,
              provider: status.selectedProvider || null,
              attempts,
              retryScheduled: false,
            });
            continue;
          }
          const provider = sendResult?.provider || "baileys";
          const deliveryStatus = provider === "baileys" ? "SENT_BAILEYS" : "SENT";
          const sentReminder = await this.dataManager.moveToSent(reminder.id, {
            sentAt: new Date().toISOString(),
            deliveryStatus,
            whatsappProvider: provider,
            providerMessageId: sendResult?.providerMessageId || sendResult?.messageId || null,
            providerStatus: "sent",
          });
          claimedReminderId = null;

          this.activityLog.push("info", "whatsapp.message.sent", `Message sent: ${targetPhoneNumber}`, {
            event: "whatsapp.message.sent",
            reminderId: reminder.id,
            provider,
            providerMessageId: sendResult?.providerMessageId || sendResult?.messageId || null,
          });

          if (this.dataManager.getSettings().notifyAdminsOnDelivery) {
            await this.notificationBot.sendAdminBroadcast(
              "Reminder terkirim",
              `Tujuan: ${reminder.contactName || targetPhoneNumber} (${targetPhoneNumber})\nJadwal: ${formatDateTime(reminder.reminderDateTime, this.dataManager.getTimezone())}\n\n${reminder.message}`,
              { silentLog: true }
            );
          }

          await this.rescheduleMonthlyReminder(reminder, deliveryStatus);

          if (!sentReminder) {
            this.activityLog.push("error", "delivery", "Sent reminder could not be archived", {
              reminderId: reminder.id,
            });
          }
        } catch (error) {
          const errorMessage = error?.message || String(error);
          this.activityLog.push("error", "delivery", `Failed to send reminder ${activeReminder.id}: ${errorMessage}`, {
            error: errorMessage,
            phoneNumber: activeReminder.phoneNumber,
          });

          if (errorMessage.toLowerCase().includes("whatsapp belum dikonfigurasi")) {
            break;
          }
        } finally {
          if (claimedReminderId) {
            await this.dataManager.releaseReminderClaim(claimedReminderId).catch((releaseError) => {
              this.activityLog.push("error", "scheduler", `Failed to release reminder claim ${claimedReminderId}`, {
                error: releaseError.message,
              });
            });
          }
        }
      }
    } finally {
      this.isProcessing = false;
    }
  }
}

class MikrotikBackupScheduler {
  constructor(mikrotikService, notificationBot, dataManager, activityLog) {
    this.mikrotikService = mikrotikService;
    this.notificationBot = notificationBot;
    this.dataManager = dataManager;
    this.activityLog = activityLog;
    this.isProcessing = false;
  }

  isDueNow(settings) {
    const requestedTimeZone = settings.mikrotikBackupTimezone || settings.timezone || "Asia/Jakarta";
    const timeZone = [...new Set([requestedTimeZone, settings.timezone, "Asia/Jakarta"].filter(Boolean))]
      .find(isValidTimeZone)
      || "Asia/Jakarta";
    const configuredTime = sanitizeTimeHHMM(settings.mikrotikBackupTime, DEFAULT_SETTINGS.mikrotikBackupTime);
    if (timeZone !== requestedTimeZone) {
      this.activityLog.push("warn", "mikrotik-backup", `Timezone backup MikroTik tidak valid (${requestedTimeZone}), fallback ke ${timeZone}`);
    }
    const nowParts = getDateTimePartsInTimezone(new Date(), timeZone);

    return {
      due: nowParts.timeKey >= configuredTime,
      nowParts,
      configuredTime,
      timeZone,
    };
  }

  async processDailyBackup() {
    if (this.isProcessing) return;

    const settings = this.dataManager.getSettings();
    if (!settings.enableMikrotikBackupToWa) {
      return;
    }

    const scheduleCheck = this.isDueNow(settings);
    if (!scheduleCheck.due) return;

    if (settings.mikrotikBackupLastRunDate === scheduleCheck.nowParts.dateKey) {
      this.activityLog.push("info", "mikrotik-backup", "Backup MikroTik sudah dikirim untuk hari ini");
      return;
    }

    const recipients = TelegramManager.getChatIds();
    if (recipients.length === 0) {
      this.activityLog.push("warn", "mikrotik-backup", "Backup MikroTik dilewati karena TELEGRAM_CHAT_IDS kosong");
      return;
    }

    if (!TelegramManager.isConfigured()) {
      this.activityLog.push("warn", "mikrotik-backup", "Backup MikroTik dilewati karena Telegram belum dikonfigurasi");
      return;
    }

    this.isProcessing = true;
    let backup = null;
    try {
      backup = await this.mikrotikService.generateDailyBackupFile();
      const { filePath, fileName } = backup;
      const caption = `Backup MikroTik harian (${scheduleCheck.nowParts.dateKey})\nWaktu: ${scheduleCheck.configuredTime} ${scheduleCheck.timeZone}`;

      const results = [];
      for (const chatId of recipients) {
        try {
          await TelegramManager.sendDocument(chatId, filePath, caption);
          results.push({ chatId, status: "sent", provider: "telegram" });
        } catch (error) {
          results.push({ chatId, status: "failed", error: error.message, provider: "telegram" });
        }
      }

      const sentCount = results.filter((item) => item.status === "sent").length;
      const failedCount = results.length - sentCount;

      if (sentCount > 0) {
        await this.dataManager.markMikrotikBackupRun(scheduleCheck.nowParts.dateKey);
      }

      this.activityLog.push("info", "mikrotik-backup", "Pengiriman backup MikroTik harian selesai", {
        fileName,
        sentCount,
        failedCount,
        schedule: `${scheduleCheck.configuredTime} ${scheduleCheck.timeZone}`,
      });
    } catch (error) {
      this.activityLog.push("error", "mikrotik-backup", `Backup MikroTik harian gagal: ${error.message}`);
    } finally {
      await backup?.cleanup?.().catch((error) => {
        this.activityLog.push("warn", "mikrotik-backup", `Gagal membersihkan file backup sementara: ${error.message}`);
      });
      this.isProcessing = false;
    }
  }
}

class DatabaseBackupScheduler {
  constructor(dataManager, activityLog) {
    this.dataManager = dataManager;
    this.activityLog = activityLog;
    this.isProcessing = false;
  }

  isDueNow(settings) {
    const requestedTimeZone = settings.mikrotikBackupTimezone || settings.timezone || "Asia/Jakarta";
    const timeZone = [...new Set([requestedTimeZone, settings.timezone, "Asia/Jakarta"].filter(Boolean))]
      .find(isValidTimeZone)
      || "Asia/Jakarta";
    const configuredTime = sanitizeTimeHHMM(settings.mikrotikBackupTime, DEFAULT_SETTINGS.mikrotikBackupTime);
    const nowParts = getDateTimePartsInTimezone(new Date(), timeZone);

    return {
      due: nowParts.timeKey >= configuredTime,
      nowParts,
      configuredTime,
      timeZone,
    };
  }

  async processDailyBackup() {
    if (this.isProcessing) return;

    const settings = this.dataManager.getSettings();
    const scheduleCheck = this.isDueNow(settings);
    if (!scheduleCheck.due || settings.databaseBackupLastRunDate === scheduleCheck.nowParts.dateKey) {
      return;
    }

    this.isProcessing = true;
    try {
      const backup = await this.dataManager.createBackup();
      await this.dataManager.markDatabaseBackupRun(scheduleCheck.nowParts.dateKey);
      this.activityLog.push("info", "database-backup", "Backup database harian selesai", {
        backupDir: backup.backupDir,
        deletedCount: backup.deletedCount,
        retentionDays: CONFIG.DB_BACKUP_RETENTION_DAYS,
        schedule: `${scheduleCheck.configuredTime} ${scheduleCheck.timeZone}`,
      });
    } catch (error) {
      this.activityLog.push("error", "database-backup", `Backup database harian gagal: ${error.message}`);
    } finally {
      this.isProcessing = false;
    }
  }
}

class HotspotReactivationScheduler {
  constructor(mikrotikService, dataManager, activityLog, notificationBot = null) {
    this.mikrotikService = mikrotikService;
    this.dataManager = dataManager;
    this.activityLog = activityLog;
    this.notificationBot = notificationBot;
    this.isProcessing = false;
  }

  buildPassword(contact) {
    const savedPassword = sanitizeInput(contact.mikrotikPassword || "");
    if (savedPassword) return savedPassword;
    return String(contact.phoneNumber || "").slice(-5);
  }

  renderReactivationMessage(template, context) {
    return String(template || "")
      .replace(/{{\s*name\s*}}/gi, context.name || "")
      .replace(/{{\s*phoneNumber\s*}}/gi, context.phoneNumber || "")
      .replace(/{{\s*username\s*}}/gi, context.username || "")
      .replace(/{{\s*password\s*}}/gi, context.password || "")
      .replace(/{{\s*profile\s*}}/gi, context.profile || "")
      .replace(/{{\s*reactivatedAt\s*}}/gi, context.reactivatedAt || "")
      .replace(/{{\s*nextReactivationAt\s*}}/gi, context.nextReactivationAt || "")
      .replace(/{{\s*supportSignature\s*}}/gi, context.supportSignature || "CS Emmeril Hotspot")
      .replace(/{{\s*companyName\s*}}/gi, context.companyName || "");
  }

  buildReactivationNotification(contact, reactivationResult, updatedContact) {
    const settings = this.dataManager.getSettings();
    const template = sanitizeInput(settings.hotspotReactivationMessageTemplate)
      ? settings.hotspotReactivationMessageTemplate
      : DEFAULT_SETTINGS.hotspotReactivationMessageTemplate;
    return {
      phoneNumber: updatedContact.phoneNumber || contact.phoneNumber,
      message: this.renderReactivationMessage(template, {
        name: updatedContact.name || contact.name,
        phoneNumber: updatedContact.phoneNumber || contact.phoneNumber,
        username: reactivationResult.username,
        password: reactivationResult.password,
        profile: reactivationResult.profile,
        reactivatedAt: formatDateTime(updatedContact.hotspotLastReactivatedAt || new Date(), this.dataManager.getTimezone()),
        nextReactivationAt: updatedContact.hotspotReactivationAt
          ? formatDateTime(updatedContact.hotspotReactivationAt, this.dataManager.getTimezone())
          : "",
        supportSignature: settings.supportSignature || "CS Emmeril Hotspot",
        companyName: settings.companyName || "",
      }),
    };
  }

  async sendReactivationNotification(contact) {
    const pending = contact.hotspotNotificationPending;
    if (!pending?.message || !pending?.phoneNumber) {
      return { sent: true, skipped: true, contact };
    }

    const claim = await this.dataManager.claimHotspotNotificationAttempt(contact.id, pending.id);
    if (!claim) {
      return { sent: true, skipped: true, contact: this.dataManager.getContact(contact.id) || contact };
    }
    const notification = claim.notification;

    if (!this.notificationBot) {
      const error = "Transport notifikasi belum tersedia.";
      const updatedContact = await this.dataManager.completeHotspotNotificationAttempt(contact.id, {
        sent: false,
        error,
      });
      return { sent: false, error, contact: updatedContact };
    }

    try {
      await this.notificationBot.sendMessage(notification.phoneNumber, notification.message);
      const updatedContact = await this.dataManager.completeHotspotNotificationAttempt(contact.id, { sent: true });
      this.activityLog.push("info", "hotspot-reactivation", `Notifikasi akun hotspot terkirim ke ${notification.phoneNumber}`, {
        contactId: contact.id,
        notificationId: notification.id,
      });
      return { sent: true, contact: updatedContact };
    } catch (error) {
      const updatedContact = await this.dataManager.completeHotspotNotificationAttempt(contact.id, {
        sent: false,
        error: error.message,
      });
      this.activityLog.push("error", "hotspot-reactivation", `Gagal kirim notifikasi akun hotspot ke ${notification.phoneNumber}`, {
        contactId: contact.id,
        notificationId: notification.id,
        error: error.message,
      });
      return {
        sent: false,
        error: error.message,
        contact: updatedContact,
      };
    }
  }

  async deactivateContact(contact, options = {}) {
    if (!sanitizeInput(contact.mikrotikUsername || "")) {
      throw new Error("Username hotspot wajib diisi untuk menghapus user hotspot.");
    }

    const result = await this.mikrotikService.deleteHotspotUser(contact.mikrotikUsername);
    const updatedContact = await this.dataManager.markHotspotDeactivated(contact.id, result, options);
    this.activityLog.push("info", "hotspot-reactivation", `User hotspot ${result.username} dihapus sesuai jadwal non-auto reaktivasi`, {
      contactId: contact.id,
      username: result.username,
      activeSessionsKilled: result.activeSessionsKilled,
      removedUsers: result.removedUsers,
    });

    return {
      contact: updatedContact,
      notification: { sent: false, error: "Jadwal non-auto reaktivasi hanya menghapus user hotspot." },
      ...result,
    };
  }

  async reactivateContact(contact, options = {}) {
    const { deferNotification = false, ...persistenceOptions } = options;
    const password = this.buildPassword(contact);
    if (!password) {
      throw new Error("Password hotspot kosong. Isi password atau nomor WhatsApp yang valid.");
    }

    const result = await this.mikrotikService.reactivateHotspotUser({
      username: contact.mikrotikUsername,
      password,
      profile: contact.mikrotikProfile,
      phoneNumber: contact.phoneNumber,
    });

    const updatedContact = await this.dataManager.markHotspotReactivated(contact.id, result, {
      ...persistenceOptions,
      pendingNotificationBuilder: (updated) => this.buildReactivationNotification(contact, result, updated),
    });
    this.activityLog.push("info", "hotspot-reactivation", `User hotspot ${result.username} direaktivasi`, {
      contactId: contact.id,
      username: result.username,
      profile: result.profile,
      activeSessionsKilled: result.activeSessionsKilled,
      removedUsers: result.removedUsers,
      nextSchedule: updatedContact.hotspotReactivationAt,
    });

    const notification = deferNotification
      ? { sent: false, pending: true }
      : await this.sendReactivationNotification(updatedContact);

    return {
      contact: notification.contact || updatedContact,
      notification,
      ...result,
    };
  }

  async processDueReactivations() {
    if (this.isProcessing) {
      this.activityLog.push("info", "hotspot-reactivation", "Reaktivasi dilewati karena proses sebelumnya masih berjalan");
      return [];
    }

    const dueContacts = this.dataManager.getDueHotspotReactivationContacts();
    const hasPendingNotifications = this.dataManager.getPendingHotspotNotificationContacts().length > 0;
    if (dueContacts.length === 0 && !hasPendingNotifications) {
      return [];
    }

    this.isProcessing = true;
    const results = [];

    try {
      this.activityLog.push("info", "hotspot-reactivation", `Memproses ${dueContacts.length} jadwal hotspot`);
      for (const contact of dueContacts) {
        const autoReactivation = Boolean(contact.hotspotReactivationEnabled);
        try {
          const result = autoReactivation
            ? await this.reactivateContact(contact, { deferNotification: true })
            : await this.deactivateContact(contact);
          results.push({
            contactId: contact.id,
            username: contact.mikrotikUsername,
            action: autoReactivation ? "reactivate" : "delete",
            status: "success",
            result,
          });
        } catch (error) {
          const actionText = autoReactivation ? "reaktivasi" : "hapus user";
          this.activityLog.push("error", "hotspot-reactivation", `Gagal ${actionText} hotspot ${contact.mikrotikUsername || contact.name}`, {
            contactId: contact.id,
            error: error.message,
          });
          results.push({
            contactId: contact.id,
            username: contact.mikrotikUsername,
            action: autoReactivation ? "reactivate" : "delete",
            status: "failed",
            error: error.message,
          });
        }
      }

      // Pekerjaan router selalu diselesaikan lebih dulu. Gangguan WhatsApp hanya
      // memengaruhi tahap notifikasi dan tidak menahan reaktivasi kontak lain.
      const pendingNotificationContacts = this.dataManager.getPendingHotspotNotificationContacts();
      for (const contact of pendingNotificationContacts) {
        try {
          const notification = await this.sendReactivationNotification(contact);
          results.push({
            contactId: contact.id,
            username: contact.mikrotikUsername,
            action: "notify",
            status: notification.sent ? "success" : "failed",
            notification,
          });
        } catch (error) {
          this.activityLog.push("error", "hotspot-reactivation", `Pengiriman notifikasi hotspot gagal untuk ${contact.phoneNumber}`, {
            contactId: contact.id,
            error: error.message,
          });
          results.push({
            contactId: contact.id,
            username: contact.mikrotikUsername,
            action: "notify",
            status: "failed",
            error: error.message,
          });
        }
      }
    } finally {
      this.isProcessing = false;
    }

    return results;
  }
}

class ApDownNotifier {
  constructor(mikrotikService, notificationBot, dataManager, activityLog) {
    this.mikrotikService = mikrotikService;
    this.notificationBot = notificationBot;
    this.dataManager = dataManager;
    this.activityLog = activityLog;
    this.monitorStates = new Map();
    this.isInitialized = false;
    this.isProcessing = false;
  }

  normalizeStatus(value) {
    return String(value || "UNKNOWN").trim().toUpperCase();
  }

  getMinimumDownMinutes() {
    const settings = this.dataManager.getSettings();
    return sanitizePositiveInteger(
      settings.apDownMinimumDownMinutes || settings.apDownConfirmationChecks,
      DEFAULT_SETTINGS.apDownMinimumDownMinutes,
      1,
      120
    );
  }

  getSinceAgeMinutes(monitor, state) {
    const sinceDate = parseNetwatchSinceDate(monitor.since);
    if (sinceDate) {
      return Math.max(0, (Date.now() - sinceDate.getTime()) / 60000);
    }

    if (!state.firstObservedAt) {
      return null;
    }

    return Math.max(0, (Date.now() - state.firstObservedAt) / 60000);
  }

  syncMonitorState(host, monitor) {
    const currentStatus = this.normalizeStatus(monitor.status);
    const currentSince = sanitizeInput(monitor.since || "");
    const previousState = this.monitorStates.get(host) || {
      alertAttempted: false,
      lastStatus: "UNKNOWN",
      lastSince: "",
      firstObservedAt: null,
      attemptedContactIds: new Set(),
    };

    if (currentStatus !== "DOWN") {
      if (previousState.alertAttempted || previousState.lastStatus === "DOWN") {
        this.activityLog.push("info", "ap-monitor", `AP ${host} kembali ${currentStatus}; status alert direset`);
      }

      const nextState = {
        alertAttempted: false,
        lastStatus: currentStatus,
        lastSince: currentSince,
        firstObservedAt: null,
        attemptedContactIds: new Set(),
      };
      this.monitorStates.set(host, nextState);
      return nextState;
    }

    const sinceChanged = previousState.lastSince !== currentSince;
    const isNewIncident = previousState.lastStatus !== "DOWN" || sinceChanged;
    const nextState = {
      ...previousState,
      alertAttempted: isNewIncident ? false : previousState.alertAttempted,
      lastStatus: currentStatus,
      lastSince: currentSince,
      firstObservedAt: isNewIncident || !previousState.firstObservedAt ? Date.now() : previousState.firstObservedAt,
      attemptedContactIds: isNewIncident
        ? new Set()
        : new Set(previousState.attemptedContactIds || []),
    };

    this.monitorStates.set(host, nextState);
    return nextState;
  }

  renderApDownMessage(template, context) {
    return String(template || "")
      .replace(/{{\s*name\s*}}/gi, context.name || "")
      .replace(/{{\s*host\s*}}/gi, context.host || "")
      .replace(/{{\s*status\s*}}/gi, context.status || "")
      .replace(/{{\s*supportSignature\s*}}/gi, context.supportSignature || "CS Emmeril Hotspot")
      .replace(/{{\s*companyName\s*}}/gi, context.companyName || "");
  }

  async processNetwatchChanges() {
    if (this.isProcessing) {
      this.activityLog.push("info", "ap-monitor", "Pemeriksaan AP dilewati karena proses sebelumnya masih berjalan");
      return;
    }

    this.isProcessing = true;
    try {
      const monitors = await this.mikrotikService.getNetwatchStatus();
      const currentStatuses = new Map();
      const settings = this.dataManager.getSettings();

      if (!this.isInitialized) {
        for (const monitor of monitors) {
          const host = String(monitor.host || "");
          if (!host) continue;

          const status = this.normalizeStatus(monitor.status);
          const currentSince = sanitizeInput(monitor.since || "");
          currentStatuses.set(host, status);
          this.monitorStates.set(host, {
            alertAttempted: false,
            lastStatus: status,
            lastSince: currentSince,
            firstObservedAt: status === "DOWN" ? Date.now() : null,
            attemptedContactIds: new Set(),
          });
        }

        this.isInitialized = true;
        return;
      }

      const minimumDownMinutes = this.getMinimumDownMinutes();

      for (const monitor of monitors) {
        const host = String(monitor.host || "");
        if (!host) continue;

        const currentStatus = this.normalizeStatus(monitor.status);
        currentStatuses.set(host, currentStatus);

        const state = this.syncMonitorState(host, monitor);
        if (currentStatus !== "DOWN") continue;
        if (settings.notifyContactsOnApDown === false) continue;

        const sinceAgeMinutes = this.getSinceAgeMinutes(monitor, state);
        if (sinceAgeMinutes === null) {
          this.activityLog.push(
            "warn",
            "ap-monitor",
            `AP ${host} status DOWN tapi nilai since belum bisa dibaca, menunggu pembacaan berikutnya`
          );
          continue;
        }

        if (sinceAgeMinutes < minimumDownMinutes) {
          this.activityLog.push(
            "info",
            "ap-monitor",
            `AP ${host} DOWN sejak ${sanitizeInput(monitor.since || "-")} (${sinceAgeMinutes.toFixed(1)} menit), menunggu hingga ${minimumDownMinutes} menit`
          );
          continue;
        }

        const linkedContacts = this.dataManager
          .getContacts()
          .filter((contact) => String(contact.linkedApHost || "") === host);
        const attemptedContactIds = new Set(state.attemptedContactIds || []);

        for (const contact of linkedContacts) {
          if (attemptedContactIds.has(String(contact.id))) continue;
          attemptedContactIds.add(String(contact.id));

          try {
            const message = this.renderApDownMessage(settings.apDownMessageTemplate, {
              name: contact.name,
              host,
              status: currentStatus,
              supportSignature: settings.supportSignature || "CS Emmeril Hotspot",
              companyName: settings.companyName || "",
            });
            await this.notificationBot.sendMessage(contact.phoneNumber, message);
            this.activityLog.push("info", "ap-monitor", `Notifikasi AP DOWN terkirim ke ${contact.phoneNumber}`, {
              host,
              contactId: contact.id,
            });
          } catch (error) {
            this.activityLog.push("error", "ap-monitor", `Gagal kirim notifikasi AP DOWN ke ${contact.phoneNumber}`, {
              host,
              error: error.message,
              contactId: contact.id,
            });
          }
        }

        this.monitorStates.set(host, {
          ...state,
          alertAttempted: linkedContacts.length > 0
            && linkedContacts.every((contact) => attemptedContactIds.has(String(contact.id))),
          attemptedContactIds,
        });
      }

      for (const host of Array.from(this.monitorStates.keys())) {
        if (!currentStatuses.has(host)) {
          this.monitorStates.delete(host);
        }
      }
    } finally {
      this.isProcessing = false;
    }
  }
}

class WhatsAppProviderStatusNotifier {
  constructor(notificationBot, dataManager, activityLog) {
    this.notificationBot = notificationBot;
    this.dataManager = dataManager;
    this.activityLog = activityLog;
    this.previousStatuses = new Map();
    this.pendingChanges = [];
    this.isInitialized = false;
    this.isProcessing = false;
  }

  getProviderStatuses(status) {
    return new Map(
      Object.values(status.providers || {})
        .filter((provider) => provider?.configured && provider.active !== false)
        .map((provider) => [provider.name, {
          connected: Boolean(provider.connection?.connected),
          detail: sanitizeInput(provider.connection?.detail || "Status tidak diketahui"),
        }])
    );
  }

  getChanges(currentStatuses) {
    const changes = [];
    for (const [name, current] of currentStatuses) {
      const previous = this.previousStatuses.get(name);
      if (previous && previous.connected !== current.connected) {
        changes.push({ name, previous, current });
      }
    }
    return changes;
  }

  buildAlert(status) {
    const providerLines = Object.values(status.providers || {})
      .filter((provider) => provider?.configured && provider.active !== false)
      .map((provider) => {
        const connection = provider.connection || {};
        return `- ${provider.name}: ${connection.connected ? "ONLINE" : "DOWN"} (${sanitizeInput(connection.detail || "status tidak diketahui")})`;
      });
    const changeLines = this.pendingChanges.map(({ name, previous, current }) => (
      `- ${name}: ${previous.connected ? "ONLINE" : "DOWN"} -> ${current.connected ? "ONLINE" : "DOWN"}`
    ));
    const hasDownProvider = Object.values(status.providers || {})
      .some((provider) => provider?.configured && provider.active !== false && !provider.connection?.connected);

    return {
      title: hasDownProvider ? "Alert provider WhatsApp" : "Provider WhatsApp pulih",
      body: `Perubahan status:\n${changeLines.join("\n")}\n\nStatus provider saat ini:\n${providerLines.join("\n")}`,
    };
  }

  async processStatusChanges() {
    if (this.isProcessing) return;
    this.isProcessing = true;

    try {
      const status = await this.notificationBot.getTransportStatus();
      const currentStatuses = this.getProviderStatuses(status);

      if (!this.isInitialized) {
        this.previousStatuses = currentStatuses;
        this.isInitialized = true;
        return;
      }

      const changes = this.getChanges(currentStatuses);
      this.previousStatuses = currentStatuses;

      const settings = this.dataManager.getSettings();
      if (!settings.notifyAdminsOnConnectionChange) {
        this.pendingChanges = [];
        return;
      }

      if (changes.length > 0) {
        this.pendingChanges = [...this.pendingChanges, ...changes].slice(-10);
      }
      if (this.pendingChanges.length === 0) return;

      const connectedProviders = status.transport?.connectedProviders || [];
      if (connectedProviders.length === 0) {
        this.activityLog.push("warn", "notification", "Alert status provider WhatsApp ditunda karena semua provider sedang DOWN");
        return;
      }

      const { title, body } = this.buildAlert(status);
      const recipients = this.dataManager.getAdminRecipients();
      this.pendingChanges = [];
      const results = await this.notificationBot.sendAdminBroadcast(title, body, {
        silentLog: true,
        recipients,
      });
      const sentCount = results.filter((result) => result.status === "sent").length;
      const failedCount = results.length - sentCount;

      if (results.length > 0 && failedCount === 0) {
        this.activityLog.push("info", "notification", `${title} terkirim ke ${sentCount} admin recipient(s)`);
      } else {
        this.activityLog.push("warn", "notification", `${title} selesai tanpa retry otomatis`, {
          sentCount,
          failedCount,
        });
      }
    } catch (error) {
      this.activityLog.push("error", "notification", `Gagal memeriksa perubahan status provider WhatsApp: ${error.message}`);
    } finally {
      this.isProcessing = false;
    }
  }
}

module.exports = {
  ApDownNotifier,
  DatabaseBackupScheduler,
  HotspotReactivationScheduler,
  MikrotikBackupScheduler,
  ReminderScheduler,
  WhatsAppProviderStatusNotifier,
};
