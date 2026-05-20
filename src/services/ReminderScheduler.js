const { formatDate, formatDateTime, addMonthsSafely } = require("../utils");
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

    if (!this.notificationBot.isReady) {
      this.activityLog.push("info", "scheduler", "Skipping run because WhatsApp is not ready");
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
          await this.notificationBot.sendMessage(targetPhoneNumber, reminder.message);
          const sentReminder = await this.dataManager.moveToSent(reminder.id, {
            sentAt: new Date().toISOString(),
            deliveryStatus: "SENT",
          });

          this.activityLog.push("info", "delivery", `Reminder sent to ${targetPhoneNumber}`, {
            reminderId: reminder.id,
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
            this.notificationBot.scheduleReconnect();
            break;
          }
        }
      }
    } finally {
      this.isProcessing = false;
    }
  }
}

module.exports = ReminderScheduler;
