const {
  BILLING_REMINDER_STOP_DEBT_COUNT,
  DEFAULT_SETTINGS,
  PAYMENT_STATUS,
  PAYMENT_TYPES,
} = require("../../config");
const TelegramManager = require("../../telegram-manager");
const WhatsAppProviderManager = require("../../whatsapp/provider-manager");
const {
  HOTSPOT_ACCESS_MODES,
  HOTSPOT_PROVISIONING_STATUS,
  getContactHotspotAccessMode,
  normalizeHotspotProvisioningStatus,
} = require("../customers/domain");
const {
  buildBillingDetails,
  formatBillingPeriodLabel,
  getBillingPeriodParts,
  makeBillingPeriodKey,
  normalizePhoneNumber,
  sanitizeInput,
  sanitizeMultilineText,
} = require("../../utils");

class NotificationBot {
  constructor(dataManager, activityLog, providerManager = null) {
    this.dataManager = dataManager;
    this.activityLog = activityLog;
    this.providerManager = providerManager || new WhatsAppProviderManager({ activityLog });
    this.statusCache = {
      selectedProvider: "baileys",
      whatsappProviderEnabled: true,
      isAvailable: false,
      deviceReady: false,
      outboundEnabled: false,
      transportError: "WhatsApp provider belum diinisialisasi",
      providers: {},
      transport: { configuredProviders: [], connectedProviders: [] },
    };
  }

  async initialize() {
    await this.providerManager.initialize();
    const status = await this.getTransportStatus();
    const level = status.deviceReady ? "info" : "warn";
    this.activityLog.push(
      level,
      "notification",
      status.deviceReady
        ? `WhatsApp siap melalui ${status.selectedProvider}`
        : `${status.selectedProvider} belum siap: ${status.transportError || "status tidak diketahui"}`
    );
    return status;
  }

  async sendMessage(phoneNumber, message, options = {}) {
    const settings = this.dataManager.getSettings();
    const result = await this.providerManager.sendMessage(phoneNumber, message, {
      minDelayMs: Math.max(0, Number(settings.waRandomDelayMinSeconds) || 0) * 1000,
      maxDelayMs: Math.max(0, Number(settings.waRandomDelayMaxSeconds) || 0) * 1000,
      ...options,
    });
    const deliveryConfirmed = result.deliveryStatus === "delivered" || result.deliveryStatus === "read";
    this.activityLog.push(deliveryConfirmed ? "info" : "warn", deliveryConfirmed ? "notification" : "notification.pending", deliveryConfirmed
      ? `Pesan terkirim via ${result.provider} ke ${normalizePhoneNumber(phoneNumber)}`
      : `Pesan diterima WhatsApp tetapi belum masuk ke perangkat tujuan ke ${normalizePhoneNumber(phoneNumber)}`, {
      phoneNumber: normalizePhoneNumber(phoneNumber),
      provider: result.provider,
      deliveryStatus: result.deliveryStatus || "accepted",
      messageId: result.messageId || null,
    });
    return result;
  }

  async checkPhoneNumber(phoneNumber) {
    return this.providerManager.checkPhoneNumber(phoneNumber);
  }

  async sendFile(phoneNumber, filePath, caption = "") {
    throw new Error("Pengiriman file WhatsApp tidak tersedia. Gunakan Telegram untuk backup file.");
  }

  async sendTelegramFile(chatId, filePath, caption = "") {
    return TelegramManager.sendDocument(chatId, filePath, caption);
  }

  async sendAdminBroadcast(title, body, options = {}) {
    const recipients = Array.isArray(options.recipients)
      ? [...new Set(options.recipients)]
      : this.dataManager.getAdminRecipients();
    if (recipients.length === 0) return [];

    const message = `*${title}*\n\n${body}`;
    const results = [];

    for (const phoneNumber of recipients) {
      try {
        const delivery = await this.sendMessage(phoneNumber, message, options.messageOptions || {});
        results.push({ phoneNumber, status: delivery.deliveryStatus || "accepted", deliveryStatus: delivery.deliveryStatus || "accepted" });
      } catch (error) {
        results.push({ phoneNumber, status: "failed", error: error.message });
      }
      options.onProgress?.({
        phase: "SENDING",
        completed: results.length,
        total: recipients.length,
      });
    }

    if (!options.silentLog) {
      this.activityLog.push("info", "broadcast", `${title} dikirim ke ${recipients.length} admin recipient(s)`);
    }
    return results;
  }

  async sendContactBroadcast(title, body, options = {}) {
    const contacts = this.dataManager.getContacts();
    if (contacts.length === 0) return [];

    const results = [];

    for (const contact of contacts) {
      try {
        const renderedBody =
          typeof options.renderMessage === "function"
            ? options.renderMessage(contact, body)
            : body;
        const message = `*${title}*\n\n${renderedBody}`;
        const delivery = await this.sendMessage(contact.phoneNumber, message);
        results.push({ phoneNumber: contact.phoneNumber, name: contact.name, status: delivery.deliveryStatus || "accepted", deliveryStatus: delivery.deliveryStatus || "accepted" });
      } catch (error) {
        results.push({ phoneNumber: contact.phoneNumber, name: contact.name, status: "failed", error: error.message });
      }
      options.onProgress?.({
        phase: "SENDING",
        completed: results.length,
        total: contacts.length,
      });
    }

    const successCount = results.filter((result) => ["accepted", "sent", "delivered", "read"].includes(result.status)).length;
    const failedCount = results.filter((result) => result.status === "failed").length;

    if (!options.silentLog) {
      this.activityLog.push("info", "broadcast", `${title} dikirim ke ${successCount} contact(s), ${failedCount} gagal`);
    }
    return results;
  }

  getPaymentHotspotStatusText(contact) {
    const status = normalizeHotspotProvisioningStatus(
      contact?.hotspotProvisioningStatus,
      contact?.mikrotikUsername
        ? HOTSPOT_PROVISIONING_STATUS.ACTIVE
        : HOTSPOT_PROVISIONING_STATUS.NONE
    );
    const labels = {
      [HOTSPOT_PROVISIONING_STATUS.NONE]: "Belum tersedia",
      [HOTSPOT_PROVISIONING_STATUS.PENDING]: "Menunggu aktivasi",
      [HOTSPOT_PROVISIONING_STATUS.PROVISIONING]: "Sedang diaktifkan",
      [HOTSPOT_PROVISIONING_STATUS.ACTIVE]: "Aktif",
      [HOTSPOT_PROVISIONING_STATUS.FAILED]: "Aktivasi perlu diperiksa",
      [HOTSPOT_PROVISIONING_STATUS.DEACTIVATED]: "Nonaktif",
      [HOTSPOT_PROVISIONING_STATUS.DISABLED]: "Nonaktif",
      [HOTSPOT_PROVISIONING_STATUS.MISSING]: "Tidak tersedia di MikroTik",
      [HOTSPOT_PROVISIONING_STATUS.CHANGED]: "Perlu sinkronisasi",
    };
    return labels[status] || "Belum tersedia";
  }

  buildPaymentAccessDetails(contact, options = {}, settings = {}) {
    const storedContact = contact?.id && typeof this.dataManager.getContact === "function"
      ? this.dataManager.getContact(contact.id)
      : null;
    const account = { ...(contact || {}), ...(storedContact || {}) };
    const accessMode = getContactHotspotAccessMode(account);
    const portalHotspot = contact?.id && typeof this.dataManager.getCustomerPortalData === "function"
      ? this.dataManager.getCustomerPortalData(contact.id)?.hotspot
      : null;
    const username = sanitizeInput(String(account.mikrotikUsername || portalHotspot?.username || ""));
    const password = sanitizeInput(String(account.mikrotikPassword || portalHotspot?.password || ""));
    const profile = sanitizeInput(String(account.mikrotikProfile || portalHotspot?.profile || "")) || "-";
    const status = this.getPaymentHotspotStatusText({
      ...account,
      mikrotikUsername: username,
      hotspotProvisioningStatus: account.hotspotProvisioningStatus || portalHotspot?.status,
    });
    const activeUntilValue = (
      options.activeUntil
      || contact?.serviceActiveUntil
      || account.hotspotReactivationAt
      || portalHotspot?.activeUntil
    );
    const activeUntilDate = activeUntilValue ? new Date(activeUntilValue) : null;
    const activeUntil = !activeUntilDate || Number.isNaN(activeUntilDate.getTime())
      ? "-"
      : activeUntilDate.toLocaleString("id-ID", {
          day: "2-digit",
          month: "2-digit",
          year: "numeric",
          hour: "2-digit",
          minute: "2-digit",
          timeZone: this.dataManager.getTimezone(),
        });
    const template = sanitizeMultilineText(settings.paymentHotspotAccountMessageTemplate)
      || DEFAULT_SETTINGS.paymentHotspotAccountMessageTemplate;
    const hotspotDetails = accessMode !== HOTSPOT_ACCESS_MODES.IP_BINDING_ONLY && username && password
      ? template
          .replace(/{{\s*hotspotUsername\s*}}/gi, () => username)
          .replace(/{{\s*hotspotPassword\s*}}/gi, () => password)
          .replace(/{{\s*hotspotProfile\s*}}/gi, () => profile)
          .replace(/{{\s*hotspotStatus\s*}}/gi, () => status)
          .replace(/{{\s*activeUntil\s*}}/gi, () => activeUntil)
          .replace(/\n{3,}/g, "\n\n")
          .trim()
      : "";
    if (accessMode === HOTSPOT_ACCESS_MODES.HOTSPOT_ONLY) return hotspotDetails;

    const ipBindingDetails = [
      accessMode === HOTSPOT_ACCESS_MODES.IP_BINDING_ONLY ? "*Akses WiFi*" : "*Akses IP Binding*",
      "Metode akses: IP Binding",
      `Status: ${status}`,
      `Aktif sampai: ${activeUntil}`,
      "",
      "Perangkat yang terdaftar dapat terhubung ke internet secara otomatis tanpa memasukkan username dan password.",
    ].join("\n");
    return [hotspotDetails, ipBindingDetails].filter(Boolean).join("\n\n");
  }

  async sendPaymentNotification(contact, transactionId, paymentType = "DEFAULT", options = {}) {
    const paymentDate = options.paymentDate
      ? new Date(options.paymentDate)
      : (contact.paymentDate ? new Date(contact.paymentDate) : new Date());
    const formattedDate = paymentDate.toLocaleString("id-ID", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: this.dataManager.getTimezone(),
    });

    let statusText = "Lunas";
    let noteText = "Pembayaran sudah dicatat.";
    const paymentAmount = Math.max(0, Math.floor(Number(options.paymentAmount) || 0));
    const remainingDebtAmount = Math.max(0, Math.floor(Number(options.remainingDebtAmount) || 0));
    const activeUntilDate = options.activeUntil ? new Date(options.activeUntil) : null;
    const formattedActiveUntil = activeUntilDate && !Number.isNaN(activeUntilDate.getTime())
      ? activeUntilDate.toLocaleString("id-ID", {
          day: "2-digit",
          month: "2-digit",
          year: "numeric",
          hour: "2-digit",
          minute: "2-digit",
          timeZone: this.dataManager.getTimezone(),
        })
      : "-";
    const billingPeriodLabel = sanitizeInput(String(contact.billingPeriodLabel || ""))
      || "periode tagihan";

    if (paymentType === "ARREARS-ONLY") {
      statusText = remainingDebtAmount > 0 ? "Tunggakan dibayar sebagian" : "Tunggakan lunas";
      noteText = paymentAmount > 0
        ? `Pembayaran ${this.dataManager.formatPaymentAmount(paymentAmount)} digunakan untuk tunggakan paling lama. Sisa tunggakan: ${this.dataManager.formatPaymentAmount(remainingDebtAmount)}.`
        : "Pembayaran tunggakan sudah dicatat.";
    } else if (paymentType === "CURRENT-ONLY") {
      statusText = `Lunas ${billingPeriodLabel}`;
      noteText = `Tagihan ${billingPeriodLabel} sudah lunas.`;
    } else if (paymentType === "FULL-PAID") {
      statusText = "Lunas";
      noteText = "Semua tagihan sudah lunas.";
    } else if (paymentType === PAYMENT_TYPES.ACTIVE_PERIOD) {
      statusText = "Paket aktif";
      noteText = `Paket WiFi aktif sampai ${formattedActiveUntil}.`;
    }
    const settings = this.dataManager.getSettings();
    let messageTemplate = sanitizeMultilineText(settings.paymentMessageTemplateCurrentOnly)
      || DEFAULT_SETTINGS.paymentMessageTemplateCurrentOnly;
    if (paymentType === PAYMENT_TYPES.ARREARS_ONLY) {
      messageTemplate = sanitizeMultilineText(settings.paymentMessageTemplateArrearsOnly)
        || DEFAULT_SETTINGS.paymentMessageTemplateArrearsOnly;
    } else if (paymentType === PAYMENT_TYPES.FULL_PAID) {
      messageTemplate = sanitizeMultilineText(settings.paymentMessageTemplateFullPaid)
        || DEFAULT_SETTINGS.paymentMessageTemplateFullPaid;
    } else if (paymentType === PAYMENT_TYPES.ACTIVE_PERIOD) {
      messageTemplate = sanitizeMultilineText(settings.prepaidPackagePaymentMessageTemplate)
        || DEFAULT_SETTINGS.prepaidPackagePaymentMessageTemplate;
    }
    const companyName = sanitizeInput(settings.companyName) || "Emmeril Hotspot";
    const supportSignature = sanitizeInput(settings.supportSignature) || "CS Emmeril Hotspot";
    const hotspotAccountDetails = this.buildPaymentAccessDetails(contact, options, settings);
    const placesHotspotAccount = /{{\s*hotspotAccountDetails\s*}}/i.test(messageTemplate);

    let message = messageTemplate
      .replace(/{{\s*name\s*}}/gi, () => contact.name || "-")
      .replace(/{{\s*transactionId\s*}}/gi, () => transactionId || "-")
      .replace(/{{\s*paymentDate\s*}}/gi, () => formattedDate)
      .replace(/{{\s*billingPeriod\s*}}/gi, () => billingPeriodLabel)
      .replace(/{{\s*paymentAmount\s*}}/gi, () => this.dataManager.formatPaymentAmount(paymentAmount))
      .replace(/{{\s*remainingDebtAmount\s*}}/gi, () => this.dataManager.formatPaymentAmount(remainingDebtAmount))
      .replace(/{{\s*activeUntil\s*}}/gi, () => formattedActiveUntil)
      .replace(/{{\s*statusText\s*}}/gi, () => statusText)
      .replace(/{{\s*noteText\s*}}/gi, () => noteText)
      .replace(/{{\s*companyName\s*}}/gi, () => companyName)
      .replace(/{{\s*companyNameUpper\s*}}/gi, () => companyName.toUpperCase())
      .replace(/{{\s*supportSignature\s*}}/gi, () => supportSignature)
      .replace(/{{\s*hotspotAccountDetails\s*}}/gi, () => hotspotAccountDetails);
    if (hotspotAccountDetails && !placesHotspotAccount) {
      message = `${message}\n\n${hotspotAccountDetails}`;
    }
    message = message.replace(/\n{3,}/g, "\n\n").trim();

    await this.sendMessage(contact.phoneNumber, message, options);
    this.activityLog.push("info", "payment", `Notifikasi pembayaran terkirim ke ${contact.phoneNumber}`, {
      transactionId,
      contactId: contact.id,
    });
    return { phoneNumber: contact.phoneNumber, transactionId };
  }

  async sendBillingDebtReminder(contact, options = {}) {
    const contactState = typeof this.dataManager.hydrateContact === "function"
      ? this.dataManager.hydrateContact(contact)
      : contact;
    const currentStatus = String(
      contactState.currentPaymentStatus || contactState.paymentStatus || PAYMENT_STATUS.UNPAID
    ).toUpperCase();
    const debtCount = Math.max(0, Number(
      contactState.debtCount ?? contactState.debtPeriods?.length ?? 0
    ) || 0);
    const hasDebt = Boolean(contactState.hasDebt && debtCount > 0);

    if (debtCount >= BILLING_REMINDER_STOP_DEBT_COUNT) {
      throw new Error("Pengingat tagihan tidak dikirim untuk pelanggan dengan 2 tunggakan atau lebih.");
    }

    const isOverdue = String(contactState.dueStatus || "").toUpperCase() === "OVERDUE";
    if (!hasDebt && (currentStatus !== PAYMENT_STATUS.UNPAID || !isOverdue)) {
      throw new Error("Pengingat hanya dapat dikirim untuk tagihan yang jatuh tempo atau memiliki tunggakan.");
    }

    const monthlyAmount = Math.max(0, Number(contactState.monthlyPaymentAmount) || 0);
    const timeZone = this.dataManager.getTimezone();
    const { year, month } = getBillingPeriodParts(new Date(), timeZone);
    const currentKey = contactState.billingPeriodKey || makeBillingPeriodKey(year, month);
    const currentPayment = contactState.paymentMonths?.[currentKey] || null;
    const currentPaidAmount = currentStatus === PAYMENT_STATUS.PAID
      ? monthlyAmount
      : Math.min(monthlyAmount, Math.max(0, Number(currentPayment?.paidAmount) || 0));
    const currentAmount = currentStatus === PAYMENT_STATUS.PAID
      ? 0
      : Math.max(0, monthlyAmount - currentPaidAmount);
    const debtAmount = contactState.debtAmount === undefined
      ? monthlyAmount * debtCount
      : Math.max(0, Number(contactState.debtAmount) || 0);
    const totalAmount = currentAmount + debtAmount;
    const settings = this.dataManager.getSettings();
    const messageTemplate = sanitizeMultilineText(settings.billingReminderMessageTemplate)
      || DEFAULT_SETTINGS.billingReminderMessageTemplate;
    const companyName = sanitizeInput(settings.companyName) || "Emmeril Hotspot";
    const supportSignature = sanitizeInput(settings.supportSignature) || "CS Emmeril Hotspot";
    const debtPeriods = (contactState.debtPeriods || [])
      .map((period) => sanitizeInput(period.label || period.key || ""))
      .filter(Boolean)
      .join(", ") || contactState.debtPeriodLabel || "-";
    const dueDateValue = contactState.dueDate ? new Date(contactState.dueDate) : null;
    const dueDate = dueDateValue && !Number.isNaN(dueDateValue.getTime())
      ? dueDateValue.toLocaleString("id-ID", {
          day: "2-digit",
          month: "long",
          year: "numeric",
          hour: "2-digit",
          minute: "2-digit",
          timeZone,
        })
      : "Belum dijadwalkan";
    const formatAmount = (value) => this.dataManager.formatPaymentAmount(value);
    const billingPeriod = contactState.billingPeriodLabel || formatBillingPeriodLabel(year, month);
    const billingDetails = buildBillingDetails({
      debtPeriods: contactState.debtPeriods,
      debtAmount,
      currentPeriodLabel: billingPeriod,
      currentAmount,
      monthlyAmount,
      totalAmount,
      formatAmount,
    });
    const variables = {
      name: contactState.name || "-",
      phoneNumber: contactState.phoneNumber || "-",
      monthlyAmount: formatAmount(monthlyAmount),
      currentAmount: formatAmount(currentAmount),
      debtAmount: formatAmount(debtAmount),
      totalAmount: formatAmount(totalAmount),
      debtCount: String(debtCount),
      debtPeriods,
      billingPeriod,
      billingDetails,
      dueDate,
      companyName,
      companyNameUpper: companyName.toUpperCase(),
      supportSignature,
    };
    let message = messageTemplate;
    const placesBillingDetails = /{{\s*billingDetails\s*}}/i.test(messageTemplate);
    for (const [key, value] of Object.entries(variables)) {
      message = message.replace(new RegExp(`{{\\s*${key}\\s*}}`, "gi"), () => value);
    }
    if (!placesBillingDetails) {
      const legacyDetailsPattern = /\n\nPeriode: [^\n]*\nTagihan bulan ini: [^\n]*\nTunggakan: [^\n]*\nPeriode tunggakan: [^\n]*\nTotal: [^\n]*(?=\nJatuh tempo:)/i;
      if (legacyDetailsPattern.test(message)) {
        message = message.replace(legacyDetailsPattern, `\n\n${billingDetails}\n`);
      } else if (/\n(?=Jatuh tempo\b)/i.test(message)) {
        message = message.replace(/\n(?=Jatuh tempo\b)/i, `\n${billingDetails}\n\n`);
      } else {
        message = `${message.trim()}\n\n${billingDetails}`;
      }
    }

    const delivery = await this.sendMessage(contactState.phoneNumber, message, options);
    this.activityLog.push("info", "billing-reminder", `Pengingat tagihan terkirim ke ${contactState.phoneNumber}`, {
      contactId: contactState.id,
      debtCount,
      totalAmount,
      provider: delivery.provider,
    });
    return {
      phoneNumber: contactState.phoneNumber,
      debtCount,
      debtPeriods,
      monthlyAmount,
      currentAmount,
      debtAmount,
      totalAmount,
      provider: delivery.provider,
      messageId: delivery.messageId || null,
    };
  }

  async notifyAdminsIfEnabled(title, body) {
    const settings = this.dataManager.getSettings();
    if (!settings.notifyAdminsOnConnectionChange) return [];
    return this.sendAdminBroadcast(title, body, { silentLog: true });
  }

  getStatus() {
    const status = this.statusCache;
    const settings = this.dataManager.getSettings();
    return {
      ...status,
      transport: {
        ...status.transport,
        randomDelayMinMs: Math.max(0, Number(settings.waRandomDelayMinSeconds) || 0) * 1000,
        randomDelayMaxMs: Math.max(0, Number(settings.waRandomDelayMaxSeconds) || 0) * 1000,
      },
      telegramEnabled: TelegramManager.isConfigured(),
      telegramRecipients: TelegramManager.getChatIds().length,
    };
  }

  async getTransportStatus() {
    try {
      this.statusCache = await this.providerManager.getStatus();
      return this.getStatus();
    } catch (error) {
      return {
        ...this.getStatus(),
        state: "UNREACHABLE",
        isAvailable: false,
        deviceReady: false,
        transportError: error.message,
      };
    }
  }

  async resetPairing(instanceId = null) {
    const provider = await this.providerManager.currentProvider({ connect: false });
    if (provider.name !== "baileys" || typeof provider.resetPairing !== "function") {
      throw new Error("Reset pairing hanya tersedia untuk provider Baileys.");
    }
    await provider.resetPairing(instanceId);
    return this.getTransportStatus();
  }

  enableOutbound() {
    const provider = this.providerManager.providers.baileys;
    if (provider?.name === "baileys" && typeof provider.enableOutbound === "function") {
      return provider.enableOutbound();
    }
    return this.getStatus();
  }

  disableOutbound() {
    const provider = this.providerManager.providers.baileys;
    if (provider?.name === "baileys" && typeof provider.disableOutbound === "function") {
      return provider.disableOutbound();
    }
    return this.getStatus();
  }

  async reconnect() {
    this.statusCache = await this.providerManager.reconnect();
    return this.getStatus();
  }

  async testConnection() {
    this.statusCache = await this.providerManager.testConnection();
    return this.getStatus();
  }

  async shutdown() {
    return this.providerManager.shutdown();
  }
}


module.exports = NotificationBot;
