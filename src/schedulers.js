const {
  BILLING_CYCLES,
  BILLING_REMINDER_STOP_DEBT_COUNT,
  CONFIG,
  DEFAULT_REMINDER_MESSAGE_TEMPLATE,
  DEFAULT_SETTINGS,
  REMINDER_KINDS,
} = require("./config");
const TelegramManager = require("./telegram-manager");
const {
  addDaysSafely,
  addMonthsSafely,
  buildBillingDetails,
  formatDate,
  formatDateTime,
  getBillingPeriodParts,
  getDateTimePartsInTimezone,
  getReminderDeliveryDate,
  getSettingsReminderTemplate,
  isAutomaticBillingReminder,
  isGracePeriodReminder,
  isValidTimeZone,
  makeBillingPeriodKey,
  normalizeNetworkHost,
  parseBoolean,
  parseNetwatchSinceDate,
  sanitizeInput,
  sanitizePositiveInteger,
  sanitizeTimeHHMM,
} = require("./utils");

function isPrepaidContact(contact) {
  return String(contact?.billingCycle || "").trim().toUpperCase() === BILLING_CYCLES.PREPAID;
}

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
    const activePeriodExpired = reminder.reminderKind === REMINDER_KINDS.ACTIVE_PERIOD_EXPIRY;
    const sourceMessage = activePeriodExpired
      ? DEFAULT_REMINDER_MESSAGE_TEMPLATE
      : String(reminder.messageSource || reminder.message || "");
    const nextMessage = sourceMessage
      .replace(/\d{4}-\d{2}-\d{2}/, nextDateText)
      .replace(/bulan\s+\w+/gi, `bulan ${nextMonthName}`);

    return {
      contactId: reminder.contactId,
      reminderDateTime: nextDate,
      reminderKind: REMINDER_KINDS.BILLING,
      message: nextMessage,
      messageSource: nextMessage,
      templateName: activePeriodExpired ? "Penagihan.txt" : reminder.templateName || null,
    };
  }

  async rescheduleMonthlyReminder(reminder, sourceStatus = "SENT") {
    if (!this.dataManager.getSettings().autoRescheduleMonthly) return null;
    if (reminder.reminderKind === REMINDER_KINDS.ACTIVE_PERIOD_EXPIRY) return null;
    const contact = this.dataManager.getResolvedReminderContact?.(reminder);
    if (contact && String(contact.subscriptionType || "RECURRING").toUpperCase().replace(/-/g, "_") === "ONE_TIME") {
      this.activityLog.push("info", "scheduler", `Reminder ${reminder.id} tidak dijadwalkan ulang karena pelanggan sekali berlangganan`, {
        reminderId: reminder.id,
        contactId: contact.id || null,
        sourceStatus,
      });
      return null;
    }
    if (isPrepaidContact(contact)) {
      this.activityLog.push("info", "scheduler", `Reminder ${reminder.id} tidak dijadwalkan ulang karena pelanggan prabayar menunggu pembelian paket berikutnya`, {
        reminderId: reminder.id,
        contactId: contact.id || reminder.contactId || null,
        sourceStatus,
      });
      return null;
    }
    const contactDebt = contact && typeof this.dataManager.buildDebtInfo === "function"
      ? this.dataManager.buildDebtInfo(contact)
      : contact;
    const debtCount = Math.max(0, Number(
      contactDebt?.debtCount ?? contactDebt?.debtPeriods?.length ?? 0
    ) || 0);
    if (debtCount >= BILLING_REMINDER_STOP_DEBT_COUNT) {
      this.activityLog.push("info", "scheduler", `Reminder ${reminder.id} tidak dijadwalkan ulang karena tunggakan sudah 2 bulan atau lebih`, {
        reminderId: reminder.id,
        contactId: contact?.id || reminder.contactId || null,
        debtCount,
        sourceStatus,
      });
      return null;
    }

    const nextReminder = this.buildNextReminder(reminder);
    const currentSchedule = new Date(contact?.hotspotReactivationAt || 0);
    if (contact
      && !parseBoolean(contact.billingPausedForArrears, false)
      && Number.isFinite(currentSchedule.getTime())
      && currentSchedule.getTime() > Date.now()) {
      nextReminder.reminderDateTime = currentSchedule;
    }
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

  getReminderBilling(reminder) {
    const contact = this.dataManager.getResolvedReminderContact(reminder);
    const scheduledAt = new Date(reminder?.reminderDateTime || Date.now());
    const periodDate = Number.isNaN(scheduledAt.getTime()) ? new Date() : scheduledAt;
    const timeZone = typeof this.dataManager.getTimezone === "function"
      ? this.dataManager.getTimezone()
      : "Asia/Jakarta";
    const period = getBillingPeriodParts(periodDate, timeZone);
    const periodBilling = contact && typeof this.dataManager.buildDebtInfo === "function"
      ? this.dataManager.buildDebtInfo(contact, period)
      : null;
    const contactState = periodBilling
      ? { ...contact, ...periodBilling }
      : (contact && typeof this.dataManager.hydrateContact === "function"
        ? this.dataManager.hydrateContact(contact)
        : contact);
    const debtCount = Math.max(0, Number(
      contactState?.debtCount ?? contactState?.debtPeriods?.length ?? 0
    ) || 0);
    const currentPaid = String(
      contactState?.currentPaymentStatus || contactState?.paymentStatus || "UNPAID"
    ).toUpperCase() === "PAID";
    const monthlyAmount = Math.max(0, Number(contactState?.monthlyPaymentAmount) || 0);
    const currentKey = contactState?.billingPeriodKey
      || makeBillingPeriodKey(period.year, period.month);
    const currentPayment = contactState?.paymentMonths?.[currentKey] || null;
    const currentPaidAmount = currentPaid
      ? monthlyAmount
      : Math.min(monthlyAmount, Math.max(0, Number(currentPayment?.paidAmount) || 0));
    const currentAmount = currentPaid ? 0 : Math.max(0, monthlyAmount - currentPaidAmount);
    const debtAmount = contactState?.debtAmount === undefined
      ? monthlyAmount * debtCount
      : Math.max(0, Number(contactState.debtAmount) || 0);

    return {
      contact: contactState,
      currentPaid,
      debtCount,
      monthlyAmount,
      currentAmount,
      debtAmount,
      totalAmount: currentAmount + debtAmount,
      totalPeriods: (currentPaid ? 0 : 1) + debtCount,
      billingPeriodKey: currentKey,
      billingPeriodLabel: contactState?.billingPeriodLabel
        || new Date(scheduledAt).toLocaleString("id-ID", {
          month: "long",
          year: "numeric",
          timeZone,
        }),
    };
  }

  formatRupiah(value) {
    return new Intl.NumberFormat("id-ID", {
      style: "currency",
      currency: "IDR",
      maximumFractionDigits: 0,
    }).format(Math.max(0, Number(value) || 0));
  }

  buildReminderMessage(reminder, now = new Date()) {
    const billing = this.getReminderBilling(reminder);
    const settings = typeof this.dataManager.getSettings === "function"
      ? this.dataManager.getSettings()
      : {};
    const timeZone = typeof this.dataManager.getTimezone === "function"
      ? this.dataManager.getTimezone()
      : "Asia/Jakarta";
    const scheduledAt = reminder.reminderDateTime || new Date();
    const graceDays = sanitizePositiveInteger(
      settings.hotspotIsolationGraceDays,
      DEFAULT_SETTINGS.hotspotIsolationGraceDays,
      0,
      30
    );
    const isolationDate = addDaysSafely(scheduledAt, graceDays, timeZone);
    const companyName = sanitizeInput(settings.companyName) || "Emmeril Hotspot";
    const supportSignature = sanitizeInput(settings.supportSignature) || "CS Emmeril Hotspot";
    const debtPeriods = (billing.contact?.debtPeriods || [])
      .map((period) => sanitizeInput(period.label || period.key || ""))
      .filter(Boolean)
      .join(", ") || billing.contact?.debtPeriodLabel || "-";
    const currentPeriodLabel = billing.billingPeriodLabel;
    const billingDetails = buildBillingDetails({
      debtPeriods: billing.contact?.debtPeriods,
      debtAmount: billing.debtAmount,
      currentPeriodLabel,
      currentAmount: billing.currentAmount,
      monthlyAmount: billing.monthlyAmount,
      totalAmount: billing.totalAmount,
      formatAmount: (value) => this.formatRupiah(value),
    });
    const variables = {
      name: billing.contact?.name || reminder.contactName || "-",
      nama: billing.contact?.name || reminder.contactName || "-",
      phoneNumber: billing.contact?.phoneNumber || reminder.phoneNumber || "-",
      date: formatDate(scheduledAt, timeZone),
      dateTime: formatDateTime(scheduledAt, timeZone),
      graceDays: String(graceDays),
      isolationDate: formatDate(isolationDate, timeZone),
      activeUntil: reminder.activePeriodUntil
        ? formatDateTime(reminder.activePeriodUntil, timeZone)
        : "-",
      billingPeriod: currentPeriodLabel,
      billingDetails,
      monthlyAmount: this.formatRupiah(billing.monthlyAmount),
      currentAmount: this.formatRupiah(billing.currentAmount),
      debtAmount: this.formatRupiah(billing.debtAmount),
      totalAmount: this.formatRupiah(billing.totalAmount),
      debtCount: String(billing.debtCount),
      debtPeriods,
      totalPeriods: String(billing.totalPeriods),
      renewalStatusInfo: billing.debtCount > 0
        ? "\nPerpanjangan otomatis: Dijeda sampai tunggakan lunas."
        : "",
      companyName,
      companyNameUpper: companyName.toUpperCase(),
      supportSignature,
    };
    const gracePeriodTemplate = String(
      settings.gracePeriodReminderMessageTemplate
        || DEFAULT_SETTINGS.gracePeriodReminderMessageTemplate
        || ""
    ).trim();
    const currentTime = new Date(now).getTime();
    const gracePeriodEndsAt = isolationDate.getTime();
    const isWithinGracePeriod = graceDays > 0
      && Number.isFinite(currentTime)
      && currentTime < gracePeriodEndsAt;
    const prepaidReminder = isPrepaidContact(billing.contact);
    const sourceMessage = isWithinGracePeriod
      && isGracePeriodReminder(reminder)
      && !prepaidReminder
      && gracePeriodTemplate
      ? gracePeriodTemplate
      : getSettingsReminderTemplate(reminder, settings) || reminder.messageSource || reminder.message || "";
    let message = String(sourceMessage);
    let usedBillingDetailsPlaceholder = false;
    let usedDetailedAmountPlaceholder = false;
    const detailedAmountVariables = new Set([
      "monthlyAmount",
      "currentAmount",
      "debtAmount",
      "debtCount",
      "debtPeriods",
      "totalPeriods",
    ]);

    for (const [key, value] of Object.entries(variables)) {
      const pattern = new RegExp(`{{\\s*${key}\\s*}}`, "gi");
      if (key === "billingDetails" && pattern.test(message)) usedBillingDetailsPlaceholder = true;
      if (detailedAmountVariables.has(key) && pattern.test(message)) usedDetailedAmountPlaceholder = true;
      message = message.replace(pattern, () => value);
    }

    if (prepaidReminder || usedBillingDetailsPlaceholder || usedDetailedAmountPlaceholder
      || billing.monthlyAmount <= 0 || billing.totalPeriods <= 0) return message;

    const amountPattern = /(?:sebesar\s*)?Rp\s*[0-9][0-9.]*(?:,[0-9]{1,2})?/i;
    if (amountPattern.test(message)) {
      message = message
        .replace(/Rp\s*[0-9][0-9.]*(?:,[0-9]{1,2})?/i, variables.totalAmount)
        .replace(/(Rp\s*[0-9][0-9.]*(?:,[0-9]{1,2})?)(?=[A-Za-z])/gi, "$1 ");
    }
    message = message.replace(
      /Tagihan WiFi Anda sebesar Rp\s*[0-9][0-9.]*(?:,[0-9]{1,2})? belum lunas\./i,
      "Tagihan WiFi Anda belum lunas."
    );
    if (/\n\nJatuh tempo:/i.test(message)) {
      return message.replace(/\n\n(?=Jatuh tempo:)/i, `\n\n${billingDetails}\n\n`);
    }
    return `${message.trim()}\n\n${billingDetails}`;
  }

  isPaidReminder(reminder) {
    return this.getReminderBilling(reminder).totalPeriods === 0;
  }

  shouldQueueGracePeriodReminder(reminder) {
    if (isGracePeriodReminder(reminder)
      || typeof this.dataManager.moveToGracePeriod !== "function") return false;

    const contact = this.dataManager.getResolvedReminderContact?.(reminder);
    const activePeriodExpiry = reminder.reminderKind === REMINDER_KINDS.ACTIVE_PERIOD_EXPIRY;
    if (isPrepaidContact(contact) && !activePeriodExpiry) return false;

    const settings = typeof this.dataManager.getSettings === "function"
      ? this.dataManager.getSettings()
      : {};
    const graceDays = sanitizePositiveInteger(
      settings.hotspotIsolationGraceDays,
      DEFAULT_SETTINGS.hotspotIsolationGraceDays,
      0,
      30
    );
    return graceDays > 0 && (activePeriodExpiry || isAutomaticBillingReminder(reminder));
  }

  async finalizeReminderDelivery(reminder, extras, sourceStatus) {
    if (this.shouldQueueGracePeriodReminder(reminder)) {
      const transition = await this.dataManager.moveToGracePeriod(reminder.id, extras);
      this.activityLog.push("info", "scheduler", `Reminder ${reminder.id} dilanjutkan ke pengingat masa tenggang`, {
        reminderId: reminder.id,
        contactId: reminder.contactId || null,
        sourceStatus,
        graceReminderDateTime: transition?.reminder?.deliveryDateTime || null,
      });
      return {
        sentReminder: transition?.sentReminder || null,
        graceScheduled: Boolean(transition?.reminder),
      };
    }

    const sentReminder = await this.dataManager.moveToSent(reminder.id, extras);
    await this.rescheduleMonthlyReminder(reminder, sourceStatus);
    return { sentReminder, graceScheduled: false };
  }

  getDueTime(reminder) {
    if (typeof this.dataManager.getReminderDeliveryDate === "function") {
      return this.dataManager.getReminderDeliveryDate(reminder).getTime();
    }
    const settings = typeof this.dataManager.getSettings === "function"
      ? this.dataManager.getSettings()
      : {};
    const timeZone = typeof this.dataManager.getTimezone === "function"
      ? this.dataManager.getTimezone()
      : "Asia/Jakarta";
    return getReminderDeliveryDate(
      reminder,
      settings.hotspotIsolationGraceDays,
      timeZone
    ).getTime();
  }

  async processDueReminders() {
    if (this.isProcessing) {
      this.activityLog.push("info", "scheduler", "Skipping run because previous cycle is still processing");
      return;
    }

    const status = this.notificationBot.getTransportStatus
      ? await this.notificationBot.getTransportStatus()
      : this.notificationBot.getStatus();
    // Semua kondisi WA tidak siap—termasuk provider dimatikan, koneksi putus,
    // dan pengiriman yang dijeda operator—tetap diproses. sendMessage() akan
    // gagal, kemudian reminder diarsipkan sebagai FAILED dan siklus bulan
    // berikutnya tetap dibuat.
    if (!status.whatsappProviderEnabled || !status.isAvailable || status.outboundEnabled !== true) {
      this.activityLog.push("warn", "scheduler", "WhatsApp is unavailable, disabled, or outbound delivery is paused; due reminders will be finalized as failed");
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

          const reminderContact = this.dataManager.getResolvedReminderContact?.(reminder);
          if (reminderContact
            && String(reminderContact.subscriptionType || "RECURRING").toUpperCase().replace(/-/g, "_") === "ONE_TIME") {
            await this.dataManager.moveToSent(reminder.id, {
              sentAt: new Date().toISOString(),
              deliveryStatus: "SKIPPED_ONE_TIME",
              providerStatus: "skipped",
            });
            claimedReminderId = null;
            this.activityLog.push("info", "scheduler", `Reminder ${reminder.id} dilewati karena pelanggan sekali berlangganan`, {
              reminderId: reminder.id,
              contactId: reminderContact.id || reminder.contactId || null,
            });
            continue;
          }

          if (reminder.deliveryAttemptedAt && !reminder.providerStatus) {
            const errorMessage = reminder.lastDeliveryError || "Pengiriman sebelumnya gagal";
            const finalized = await this.finalizeReminderDelivery(reminder, {
              sentAt: reminder.lastDeliveryAttemptAt || new Date().toISOString(),
              deliveryStatus: "FAILED",
              deliveryError: errorMessage,
              providerStatus: "failed",
              providerError: errorMessage,
            }, "FAILED");
            claimedReminderId = null;
            this.activityLog.push("warn", "delivery", `Reminder ${reminder.id} tidak dikirim ulang setelah kegagalan sebelumnya`, {
              reminderId: reminder.id,
              error: errorMessage,
              phoneNumber: reminder.phoneNumber,
              graceReminderScheduled: finalized.graceScheduled,
            });
            continue;
          }

          const billing = this.getReminderBilling(reminder);
          if (billing.debtCount >= BILLING_REMINDER_STOP_DEBT_COUNT) {
            await this.dataManager.moveToSent(reminder.id, {
              sentAt: new Date().toISOString(),
              deliveryStatus: "SKIPPED_ARREARS_LIMIT",
              providerStatus: "skipped",
            });
            claimedReminderId = null;
            this.activityLog.push("info", "scheduler", `Reminder ${reminder.id} dilewati karena tunggakan sudah 2 bulan atau lebih`, {
              reminderId: reminder.id,
              contactId: reminder.contactId || null,
              debtCount: billing.debtCount,
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
          const outgoingMessage = this.buildReminderMessage(reminder);
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
            sendResult = await this.notificationBot.sendMessage(targetPhoneNumber, outgoingMessage, {
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

            const finalized = await this.finalizeReminderDelivery(reminder, {
              sentAt: new Date().toISOString(),
              deliveryStatus: "FAILED",
              deliveryError: errorMessage,
              whatsappProvider: status.selectedProvider || null,
              providerStatus: "failed",
              providerError: errorMessage,
              message: outgoingMessage,
            }, "FAILED");
            claimedReminderId = null;
            this.activityLog.push("error", "whatsapp.message.failed", `Message failed: ${targetPhoneNumber}`, {
              event: "whatsapp.message.failed",
              reminderId: reminder.id,
              error: errorMessage,
              phoneNumber: reminder.phoneNumber,
              provider: status.selectedProvider || null,
              attempts,
              graceReminderScheduled: finalized.graceScheduled,
            });
            continue;
          }
          const provider = sendResult?.provider || "baileys";
          const deliveryStatus = provider === "baileys" ? "SENT_BAILEYS" : "SENT";
          const finalized = await this.finalizeReminderDelivery(reminder, {
            sentAt: new Date().toISOString(),
            deliveryStatus,
            whatsappProvider: provider,
            providerMessageId: sendResult?.providerMessageId || sendResult?.messageId || null,
            providerStatus: "sent",
            message: outgoingMessage,
          }, deliveryStatus);
          const sentReminder = finalized.sentReminder;
          claimedReminderId = null;

          this.activityLog.push("info", "whatsapp.message.sent", `Message sent: ${targetPhoneNumber}`, {
            event: "whatsapp.message.sent",
            reminderId: reminder.id,
            provider,
            providerMessageId: sendResult?.providerMessageId || sendResult?.messageId || null,
          });

          if (this.dataManager.getSettings().notifyAdminsOnDelivery) {
            try {
              await this.notificationBot.sendAdminBroadcast(
                "Reminder terkirim",
                `Tujuan: ${reminder.contactName || targetPhoneNumber} (${targetPhoneNumber})\nJadwal: ${formatDateTime(reminder.reminderDateTime, this.dataManager.getTimezone())}\n\n${outgoingMessage}`,
                { silentLog: true }
              );
            } catch (error) {
              this.activityLog.push("error", "notification", `Notifikasi admin reminder gagal: ${error.message}`, {
                reminderId: reminder.id,
                error: error.message,
              });
            }
          }

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

class HotspotStatusSyncScheduler {
  constructor(mikrotikService, dataManager, activityLog) {
    this.mikrotikService = mikrotikService;
    this.dataManager = dataManager;
    this.activityLog = activityLog;
    this.isProcessing = false;
  }

  async processStatusSync() {
    if (this.isProcessing) {
      return { skipped: true, reason: "Sinkronisasi sebelumnya masih berjalan." };
    }

    this.isProcessing = true;
    const observedAt = new Date().toISOString();
    try {
      const readRouterUsers = this.mikrotikService.getHotspotUsersForStatusSync
        || this.mikrotikService.getHotspotUsers;
      const managedUsernames = typeof this.dataManager.getContacts === "function"
        ? this.dataManager.getContacts().map((contact) => contact.mikrotikUsername).filter(Boolean)
        : [];
      const routerUsers = await readRouterUsers.call(this.mikrotikService, managedUsernames);
      const result = await this.dataManager.reconcileHotspotStatuses(routerUsers, {
        observedAt,
        checkedAt: new Date().toISOString(),
      });

      const bandwidth = { checked: 0, active: 0, pending: 0, failed: 0 };
      if (typeof this.mikrotikService.syncIpBindingBandwidthForCustomers === "function"
        && typeof this.dataManager.getContacts === "function"
        && typeof this.dataManager.updateContactIpBindingBandwidthStatus === "function") {
        const contacts = this.dataManager.getContacts().filter((contact) => (
          Array.isArray(contact.mikrotikMacAddresses) && contact.mikrotikMacAddresses.length > 0
        ));
        if (contacts.length > 0) {
          try {
            const bandwidthResults = await this.mikrotikService.syncIpBindingBandwidthForCustomers(
              contacts.map((contact) => ({
                contactId: contact.id,
                profile: contact.mikrotikProfile,
                macAddresses: contact.mikrotikMacAddresses,
                disabled: String(contact.hotspotProvisioningStatus || "").toUpperCase() === "DISABLED"
                  || String(contact.hotspotAccessMode || "").toUpperCase() === "HOTSPOT_ONLY",
              }))
            );
            for (const bandwidthResult of bandwidthResults) {
              bandwidth.checked += 1;
              if (bandwidthResult.status === "ACTIVE") bandwidth.active += 1;
              else if (["PARTIAL", "PENDING_DHCP", "NO_RATE_LIMIT"].includes(bandwidthResult.status)) bandwidth.pending += 1;
              else if (bandwidthResult.status === "FAILED") bandwidth.failed += 1;
              await this.dataManager.updateContactIpBindingBandwidthStatus(
                bandwidthResult.contactId,
                bandwidthResult
              );
            }
          } catch (error) {
            bandwidth.failed = contacts.length;
            this.activityLog.push("warn", "hotspot-sync", `Sinkronisasi bandwidth IP Binding gagal: ${error.message}`);
          }
        }
      }

      if (result.updated > 0) {
        const level = result.missing > 0 || result.changed > 0 ? "warn" : "info";
        this.activityLog.push(level, "hotspot-sync", `Status hotspot diperbarui untuk ${result.updated} pelanggan`, result);
      }
      if (bandwidth.failed > 0) {
        this.activityLog.push("warn", "hotspot-sync", `${bandwidth.failed} bandwidth IP Binding belum tersinkron`, bandwidth);
      }
      return { ...result, bandwidth };
    } finally {
      this.isProcessing = false;
    }
  }
}

class HotspotReactivationScheduler {
  constructor(mikrotikService, dataManager, activityLog) {
    this.mikrotikService = mikrotikService;
    this.dataManager = dataManager;
    this.activityLog = activityLog;
    this.isProcessing = false;
  }

  buildPassword(contact) {
    const savedPassword = sanitizeInput(contact.mikrotikPassword || "");
    if (savedPassword) return savedPassword;
    return String(contact.phoneNumber || "").slice(-5);
  }

  async deactivateContact(contact, options = {}) {
    if (!sanitizeInput(contact.mikrotikUsername || "")) {
      throw new Error("Username hotspot wajib diisi untuk menonaktifkan user hotspot.");
    }

    let operationPrepared = false;
    let result;
    let updatedContact;
    const updatedBindings = [];
    const accessMode = String(contact.hotspotAccessMode || (
      Array.isArray(contact.mikrotikMacAddresses) && contact.mikrotikMacAddresses.length > 0
        ? "BOTH"
        : "HOTSPOT_ONLY"
    )).toUpperCase();
    const previousUserDisabled = accessMode === "IP_BINDING_ONLY";
    const previousBindingType = accessMode === "HOTSPOT_ONLY" ? "regular" : "bypassed";
    try {
      const prepared = await this.dataManager.prepareHotspotLifecycleOperation(contact.id, "DEACTIVATE");
      operationPrepared = true;
      await this.dataManager.updateHotspotProvisioningStatus(contact.id, "PROVISIONING", { error: "" });
      result = await this.mikrotikService.setHotspotUserDisabled(
        prepared.mikrotikUsername,
        prepared.phoneNumber,
        true
      );
      let bindingsUpdated = 0;
      for (const macAddress of Array.isArray(prepared.mikrotikMacAddresses) ? prepared.mikrotikMacAddresses : []) {
        await this.mikrotikService.setIpBindingDisabled({
          macAddress,
          contactId: prepared.id,
          disabled: true,
        });
        updatedBindings.push(macAddress);
        bindingsUpdated += 1;
      }
      result.bindingsUpdated = bindingsUpdated;
      updatedContact = await this.dataManager.markHotspotDisabled(contact.id, result, {
        ...options,
        scheduled: true,
        clearSchedule: true,
      });
    } catch (error) {
      if (result) {
        for (const macAddress of updatedBindings.reverse()) {
          await this.mikrotikService.upsertIpBinding({
            macAddress,
            contactId: contact.id,
            type: previousBindingType,
          }).catch(() => {});
        }
        await this.mikrotikService.setHotspotUserDisabled(
          contact.mikrotikUsername,
          contact.phoneNumber,
          previousUserDisabled
        ).catch(() => {});
      }
      if (operationPrepared) {
        await this.dataManager.updateHotspotProvisioningStatus(contact.id, "FAILED", {
          error: error.message,
          checkedAt: new Date().toISOString(),
        }).catch((statusError) => {
          this.activityLog.push("error", "hotspot-reactivation", `Gagal menyimpan status deaktivasi ${contact.mikrotikUsername}: ${statusError.message}`);
        });
      }
      throw new Error(`Deaktivasi hotspot gagal: ${error.message}`, { cause: error });
    }
    this.activityLog.push("info", "hotspot-reactivation", `User hotspot ${result.username} dan ${result.bindingsUpdated || 0} IP Binding dinonaktifkan sesuai jadwal`, {
      contactId: contact.id,
      username: result.username,
      activeSessionsKilled: result.activeSessionsKilled,
    });

    return {
      operation: "DEACTIVATE",
      contact: updatedContact,
      notification: { sent: false, error: "Jadwal ini menonaktifkan user hotspot tanpa menghapus akun MikroTik." },
      ...result,
    };
  }

  async reactivateContact(contact, options = {}) {
    let operationPrepared = false;
    let prepared;
    let result;
    let updatedContact;
    const updatedBindings = [];
    const password = this.buildPassword(contact);
    if (!password) {
      throw new Error("Password hotspot kosong. Isi password atau nomor WhatsApp yang valid.");
    }

    try {
      prepared = await this.dataManager.prepareHotspotLifecycleOperation(contact.id, "REACTIVATE");
      operationPrepared = true;
      await this.dataManager.updateHotspotProvisioningStatus(contact.id, "PROVISIONING", { error: "" });
      result = await this.mikrotikService.reactivateHotspotUser({
        username: prepared.mikrotikUsername,
        password,
        profile: prepared.mikrotikProfile,
        phoneNumber: prepared.phoneNumber,
      });
      await this.mikrotikService.verifyHotspotCustomer({
        username: result.username,
        phoneNumber: prepared.phoneNumber,
        profile: result.profile,
      });
      const accessMode = String(prepared.hotspotAccessMode || (
        Array.isArray(prepared.mikrotikMacAddresses) && prepared.mikrotikMacAddresses.length > 0
          ? "BOTH"
          : "HOTSPOT_ONLY"
      )).toUpperCase();
      const userDisabled = accessMode === "IP_BINDING_ONLY";
      const bindingType = accessMode === "HOTSPOT_ONLY" ? "regular" : "bypassed";
      if (userDisabled) {
        await this.mikrotikService.setHotspotUserDisabled(
          prepared.mikrotikUsername,
          prepared.phoneNumber,
          true
        );
      }
      let bindingsUpdated = 0;
      for (const macAddress of Array.isArray(prepared.mikrotikMacAddresses) ? prepared.mikrotikMacAddresses : []) {
        await this.mikrotikService.upsertIpBinding({
          macAddress,
          contactId: prepared.id,
          type: bindingType,
        });
        updatedBindings.push(macAddress);
        bindingsUpdated += 1;
      }
      result.bindingsUpdated = bindingsUpdated;
      result.accessMode = accessMode;
      result.userDisabled = userDisabled;
      updatedContact = await this.dataManager.markHotspotReactivated(contact.id, result, options);
    } catch (error) {
      if (result) {
        for (const macAddress of updatedBindings.reverse()) {
          await this.mikrotikService.setIpBindingDisabled({
            macAddress,
            contactId: contact.id,
            disabled: true,
          }).catch(() => {});
        }
        await this.mikrotikService.setHotspotUserDisabled(
          contact.mikrotikUsername,
          contact.phoneNumber,
          true
        ).catch(() => {});
      }
      if (operationPrepared) {
        await this.dataManager.updateHotspotProvisioningStatus(contact.id, "FAILED", {
          error: error.message,
          checkedAt: new Date().toISOString(),
        }).catch((statusError) => {
          this.activityLog.push("error", "hotspot-reactivation", `Gagal menyimpan status reaktivasi ${contact.mikrotikUsername}: ${statusError.message}`);
        });
      }
      throw new Error(`Reaktivasi hotspot gagal: ${error.message}`, { cause: error });
    }
    this.activityLog.push("info", "hotspot-reactivation", `User hotspot ${result.username} dan ${result.bindingsUpdated || 0} IP Binding direaktivasi`, {
      contactId: contact.id,
      username: result.username,
      profile: result.profile,
      activeSessionsKilled: result.activeSessionsKilled,
      removedUsers: result.removedUsers,
      nextSchedule: updatedContact.hotspotReactivationAt,
    });

    return {
      operation: "REACTIVATE",
      contact: updatedContact,
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
      this.activityLog.push("info", "hotspot-reactivation", `Memproses ${dueContacts.length} jadwal hotspot`);
      for (const contact of dueContacts) {
        const recurring = String(contact.subscriptionType || "RECURRING").toUpperCase().replace(/-/g, "_") === "RECURRING";
        const prepaidPackage = recurring
          && String(contact.billingCycle || "").toUpperCase() === BILLING_CYCLES.PREPAID;
        const blockedByArrears = recurring
          && !prepaidPackage
          && Boolean(contact.hotspotReactivationEnabled)
          && (Boolean(contact.hasDebt)
            || String(contact.currentPaymentStatus || contact.paymentStatus || "UNPAID").toUpperCase() !== "PAID");
        const autoReactivation = !prepaidPackage
          && Boolean(contact.hotspotReactivationEnabled)
          && !blockedByArrears;
        const arrearsDisable = !prepaidPackage
          && (blockedByArrears || Boolean(contact.hotspotManualActivationWithArrears));
        try {
          const result = autoReactivation
            ? await this.reactivateContact(contact)
            : await this.deactivateContact(contact, { arrears: arrearsDisable });
          results.push({
            contactId: contact.id,
            username: contact.mikrotikUsername,
            action: autoReactivation ? "reactivate" : "disable",
            status: "success",
            result,
          });
        } catch (error) {
          const actionText = autoReactivation ? "reaktivasi" : "menonaktifkan user";
          this.activityLog.push("error", "hotspot-reactivation", `Gagal ${actionText} hotspot ${contact.mikrotikUsername || contact.name}`, {
            contactId: contact.id,
            error: error.message,
          });
          results.push({
            contactId: contact.id,
            username: contact.mikrotikUsername,
            action: autoReactivation ? "reactivate" : "disable",
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
      .replace(/{{\s*companyNameUpper\s*}}/gi, String(context.companyName || "").toUpperCase())
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
          const host = sanitizeInput(String(monitor.host || ""));
          const hostKey = normalizeNetworkHost(host);
          if (!hostKey) continue;

          const status = this.normalizeStatus(monitor.status);
          const currentSince = sanitizeInput(monitor.since || "");
          currentStatuses.set(hostKey, status);
          this.monitorStates.set(hostKey, {
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
        const host = sanitizeInput(String(monitor.host || ""));
        const hostKey = normalizeNetworkHost(host);
        if (!hostKey) continue;

        const currentStatus = this.normalizeStatus(monitor.status);
        currentStatuses.set(hostKey, currentStatus);

        const state = this.syncMonitorState(hostKey, monitor);
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
          .filter((contact) => normalizeNetworkHost(contact.linkedApHost) === hostKey);
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

        this.monitorStates.set(hostKey, {
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

class VoucherRevenueSyncScheduler {
  constructor(mikrotikService, dataManager, activityLog) {
    this.mikrotikService = mikrotikService;
    this.dataManager = dataManager;
    this.activityLog = activityLog;
    this.currentRun = null;
  }

  async processSync(options = {}) {
    if (this.currentRun) return this.currentRun;
    this.currentRun = this.runSync(options).finally(() => {
      this.currentRun = null;
    });
    return this.currentRun;
  }

  async runSync(options = {}) {
    const timeZone = this.dataManager.getTimezone();
    const records = await this.mikrotikService.getVoucherUsageRecords({ timeZone });
    const storage = await this.dataManager.storeVoucherRevenueEntries(records);
    const recordIds = records.map((record) => record.id);
    if (!this.dataManager.hasVoucherRevenueEntries(recordIds)) {
      throw new Error("Verifikasi penyimpanan riwayat pendapatan voucher gagal.");
    }

    const retentionHours = Number.isFinite(Number(options.retentionHours))
      ? Math.max(0, Number(options.retentionHours))
      : CONFIG.VOUCHER_SCRIPT_RETENTION_HOURS;
    const now = options.now instanceof Date ? options.now : new Date();
    const cutoff = now.getTime() - (retentionHours * 60 * 60 * 1000);
    const eligibleRecords = records.filter((record) => {
      const usedAt = new Date(record.usedAt).getTime();
      return !Number.isNaN(usedAt) && usedAt <= cutoff;
    });

    let cleanup = { removed: 0, skipped: 0, failed: 0 };
    if (eligibleRecords.length > 0) {
      try {
        cleanup = await this.mikrotikService.deleteVoucherUsageRecords(eligibleRecords);
      } catch (error) {
        cleanup = { removed: 0, skipped: 0, failed: eligibleRecords.length };
        this.activityLog.push("error", "voucher", `Pembersihan catatan voucher MikroTik gagal: ${error.message}`);
      }
    }

    if (storage.saved > 0 || cleanup.removed > 0 || cleanup.failed > 0 || cleanup.skipped > 0) {
      this.activityLog.push("info", "voucher", "Sinkronisasi pendapatan voucher selesai", {
        found: records.length,
        stored: storage.saved,
        totalStored: storage.total,
        batchesUpdated: storage.batchesUpdated,
        eligibleForCleanup: eligibleRecords.length,
        removedFromMikrotik: cleanup.removed,
        cleanupSkipped: cleanup.skipped,
        cleanupFailed: cleanup.failed,
        retentionHours,
      });
    }

    return {
      found: records.length,
      ...storage,
      cleanup,
      retentionHours,
    };
  }
}

module.exports = {
  ApDownNotifier,
  DatabaseBackupScheduler,
  HotspotReactivationScheduler,
  HotspotStatusSyncScheduler,
  MikrotikBackupScheduler,
  ReminderScheduler,
  VoucherRevenueSyncScheduler,
  WhatsAppProviderStatusNotifier,
};
