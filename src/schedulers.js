const { DEFAULT_SETTINGS } = require("./config");
const {
  addMonthsSafely,
  formatDate,
  formatDateTime,
  getDateTimePartsInTimezone,
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
    const nextDate = addMonthsSafely(reminder.reminderDateTime, 1);
    const nextDateText = formatDate(nextDate);
    const nextMonthName = nextDate.toLocaleString("id-ID", { month: "long" });
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

  async processDueReminders() {
    if (this.isProcessing) {
      this.activityLog.push("info", "scheduler", "Skipping run because previous cycle is still processing");
      return;
    }

    const status = this.notificationBot.getStatus();
    if (!status.isAvailable && !status.fonnteEnabled) {
      this.activityLog.push("info", "scheduler", "Skipping run because notification transport is not ready");
      return;
    }

    this.isProcessing = true;

    try {
      const now = Date.now();
      const dueReminders = this.dataManager.getSortedReminders().filter(
        (reminder) => new Date(reminder.reminderDateTime).getTime() <= now
      );

      if (dueReminders.length === 0) {
        return;
      }

      this.activityLog.push("info", "scheduler", `Processing ${dueReminders.length} due reminder(s)`);

      for (const reminder of dueReminders) {
        try {
          const targetPhoneNumber = reminder.phoneNumber;
          const sendResult = await this.notificationBot.sendMessage(targetPhoneNumber, reminder.message);
          const provider = sendResult?.provider || "whatsapp-web";
          const deliveryStatus = sendResult?.unconfirmed
            ? "SENT_UNCONFIRMED"
            : (provider === "fonnte" ? "SENT_FONNTE" : "SENT");
          const sentReminder = await this.dataManager.moveToSent(reminder.id, {
            sentAt: new Date().toISOString(),
            deliveryStatus,
          });

          this.activityLog.push("info", "delivery", `Reminder sent to ${targetPhoneNumber} via ${provider}`, {
            reminderId: reminder.id,
            provider,
          });

          if (this.dataManager.getSettings().notifyAdminsOnDelivery) {
            await this.notificationBot.sendAdminBroadcast(
              "Reminder terkirim",
              `Tujuan: ${reminder.contactName || targetPhoneNumber} (${targetPhoneNumber})\nJadwal: ${formatDateTime(reminder.reminderDateTime)}\n\n${reminder.message}`,
              { silentLog: true }
            );
          }

          if (this.dataManager.getSettings().autoRescheduleMonthly) {
            const nextReminder = this.buildNextReminder(reminder);
            await this.dataManager.addReminder(nextReminder);
          }

          if (!sentReminder) {
            this.activityLog.push("error", "delivery", "Sent reminder could not be archived", {
              reminderId: reminder.id,
            });
          }
        } catch (error) {
          this.activityLog.push("error", "delivery", `Failed to send reminder ${reminder.id}`, {
            error: error.message,
            phoneNumber: reminder.phoneNumber,
          });
          if (String(error.message).toLowerCase().includes("not ready")) {
            // The WhatsAppManager handles reconnect automatically
            break;
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
    let timeZone = settings.mikrotikBackupTimezone || settings.timezone || "Asia/Jakarta";
    const configuredTime = sanitizeTimeHHMM(settings.mikrotikBackupTime, DEFAULT_SETTINGS.mikrotikBackupTime);
    let nowParts;

    try {
      nowParts = getDateTimePartsInTimezone(new Date(), timeZone);
    } catch (error) {
      const fallbackTimeZones = [settings.timezone, "Asia/Jakarta"].filter(Boolean);
      const fallbackTimeZone = fallbackTimeZones.find((candidate) => candidate !== timeZone) || "Asia/Jakarta";
      this.activityLog.push("warn", "mikrotik-backup", `Timezone backup MikroTik tidak valid (${timeZone}), fallback ke ${fallbackTimeZone}`);
      timeZone = fallbackTimeZone;
      nowParts = getDateTimePartsInTimezone(new Date(), timeZone);
    }

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

    const recipients = this.dataManager.getAdminRecipients();
    if (recipients.length === 0) {
      this.activityLog.push("warn", "mikrotik-backup", "Backup MikroTik dilewati karena admin recipients kosong");
      return;
    }

    const status = this.notificationBot.getStatus();
    if (!status.isAvailable) {
      this.activityLog.push("warn", "mikrotik-backup", "Backup MikroTik dilewati karena transport WA belum siap");
      return;
    }

    this.isProcessing = true;
    try {
      const { filePath, fileName } = await this.mikrotikService.generateDailyBackupFile();
      const caption = `Backup MikroTik harian (${scheduleCheck.nowParts.dateKey})\nWaktu: ${scheduleCheck.configuredTime} ${scheduleCheck.timeZone}`;

      const results = [];
      for (const phoneNumber of recipients) {
        try {
          await this.notificationBot.sendFile(phoneNumber, filePath, caption);
          results.push({ phoneNumber, status: "sent" });
        } catch (error) {
          results.push({ phoneNumber, status: "failed", error: error.message });
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

  async sendReactivationNotification(contact, reactivationResult, updatedContact) {
    if (!this.notificationBot) {
      return { sent: false, error: "Transport notifikasi belum tersedia." };
    }

    const settings = this.dataManager.getSettings();
    const template = sanitizeInput(settings.hotspotReactivationMessageTemplate)
      ? settings.hotspotReactivationMessageTemplate
      : DEFAULT_SETTINGS.hotspotReactivationMessageTemplate;
    const message = this.renderReactivationMessage(template, {
      name: updatedContact.name || contact.name,
      phoneNumber: updatedContact.phoneNumber || contact.phoneNumber,
      username: reactivationResult.username,
      password: reactivationResult.password,
      profile: reactivationResult.profile,
      reactivatedAt: formatDateTime(updatedContact.hotspotLastReactivatedAt || new Date()),
      nextReactivationAt: updatedContact.hotspotReactivationAt ? formatDateTime(updatedContact.hotspotReactivationAt) : "",
      supportSignature: settings.supportSignature || "CS Emmeril Hotspot",
      companyName: settings.companyName || "",
    });

    try {
      await this.notificationBot.sendMessage(updatedContact.phoneNumber || contact.phoneNumber, message);
      this.activityLog.push("info", "hotspot-reactivation", `Notifikasi akun hotspot terkirim ke ${updatedContact.phoneNumber || contact.phoneNumber}`, {
        contactId: updatedContact.id || contact.id,
        username: reactivationResult.username,
      });
      return { sent: true };
    } catch (error) {
      this.activityLog.push("error", "hotspot-reactivation", `Gagal kirim notifikasi akun hotspot ke ${updatedContact.phoneNumber || contact.phoneNumber}`, {
        contactId: updatedContact.id || contact.id,
        username: reactivationResult.username,
        error: error.message,
      });
      return { sent: false, error: error.message };
    }
  }

  async reactivateContact(contact, options = {}) {
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

    const updatedContact = await this.dataManager.markHotspotReactivated(contact.id, result, options);
    this.activityLog.push("info", "hotspot-reactivation", `User hotspot ${result.username} direaktivasi`, {
      contactId: contact.id,
      username: result.username,
      profile: result.profile,
      activeSessionsKilled: result.activeSessionsKilled,
      removedUsers: result.removedUsers,
      nextSchedule: updatedContact.hotspotReactivationAt,
    });

    const notification = await this.sendReactivationNotification(contact, result, updatedContact);

    return {
      contact: updatedContact,
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
    if (dueContacts.length === 0) {
      return [];
    }

    this.isProcessing = true;
    const results = [];

    try {
      this.activityLog.push("info", "hotspot-reactivation", `Memproses ${dueContacts.length} reaktivasi hotspot`);
      for (const contact of dueContacts) {
        try {
          const result = await this.reactivateContact(contact);
          results.push({ contactId: contact.id, username: contact.mikrotikUsername, status: "success", result });
        } catch (error) {
          this.activityLog.push("error", "hotspot-reactivation", `Gagal reaktivasi hotspot ${contact.mikrotikUsername || contact.name}`, {
            contactId: contact.id,
            error: error.message,
          });
          results.push({ contactId: contact.id, username: contact.mikrotikUsername, status: "failed", error: error.message });
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
      alertSent: false,
      lastStatus: "UNKNOWN",
      lastSince: "",
      firstObservedAt: null,
    };

    if (currentStatus !== "DOWN") {
      if (previousState.alertSent || previousState.lastStatus === "DOWN") {
        this.activityLog.push("info", "ap-monitor", `AP ${host} kembali ${currentStatus}; status alert direset`);
      }

      const nextState = {
        alertSent: false,
        lastStatus: currentStatus,
        lastSince: currentSince,
        firstObservedAt: null,
      };
      this.monitorStates.set(host, nextState);
      return nextState;
    }

    const sinceChanged = previousState.lastSince !== currentSince;
    const nextState = {
      ...previousState,
      lastStatus: currentStatus,
      lastSince: currentSince,
      firstObservedAt: sinceChanged || !previousState.firstObservedAt ? Date.now() : previousState.firstObservedAt,
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
    const monitors = await this.mikrotikService.getNetwatchStatus();
    const currentStatuses = new Map();

    if (!this.isInitialized) {
      for (const monitor of monitors) {
        const host = String(monitor.host || "");
        if (!host) continue;

        const status = this.normalizeStatus(monitor.status);
        const currentSince = sanitizeInput(monitor.since || "");
        currentStatuses.set(host, status);
        this.monitorStates.set(host, {
          alertSent: false,
          lastStatus: status,
          lastSince: currentSince,
          firstObservedAt: status === "DOWN" ? Date.now() : null,
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
      if (state.alertSent) continue;

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

      if (linkedContacts.length === 0) {
        this.monitorStates.set(host, {
          ...state,
          alertSent: true,
        });
        continue;
      }

      for (const contact of linkedContacts) {
        try {
          const settings = this.dataManager.getSettings();
          const message = this.renderApDownMessage(settings.apDownMessageTemplate, {
            name: contact.name,
            host,
            status: currentStatus,
            supportSignature: settings.supportSignature || "CS Emmeril Hotspot",
            companyName: settings.companyName || "",
          });
          await this.notificationBot.sendMessage(
            contact.phoneNumber,
            message
          );
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
        alertSent: true,
      });
    }

    for (const host of Array.from(this.monitorStates.keys())) {
      if (!currentStatuses.has(host)) {
        this.monitorStates.delete(host);
      }
    }
  }
}

module.exports = {
  ApDownNotifier,
  HotspotReactivationScheduler,
  MikrotikBackupScheduler,
  ReminderScheduler,
};
