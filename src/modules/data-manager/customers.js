const fs = require("fs/promises");
const net = require("net");
const path = require("path");
const {
  BILLING_CYCLES,
  BILLING_REMINDER_STOP_DEBT_COUNT,
  CONFIG,
  DETAILED_BILLING_REMINDER_MESSAGE_TEMPLATE,
  DEFAULT_REMINDER_MESSAGE_TEMPLATE,
  DEFAULT_SETTINGS,
  LEGACY_DEFAULT_REMINDER_MESSAGE_TEMPLATE_V3,
  LEGACY_DETAILED_BILLING_REMINDER_MESSAGE_TEMPLATE_V4,
  LEGACY_NOTIFICATION_TEMPLATES_V3,
  LEGACY_PREPAID_PACKAGE_REMINDER_MESSAGE_TEMPLATE_V5,
  PAYMENT_STATUS,
  PAYMENT_TYPES,
  REMINDER_KINDS,
  SUBSCRIPTION_TYPES,
} = require("../../config");
const {
  HOTSPOT_ACCESS_MODES,
  HOTSPOT_PROVISIONING_OPERATION,
  HOTSPOT_PROVISIONING_STATUS,
  addBillingMonths,
  compareBillingPeriods,
  getContactBillingPeriod,
  getContactBillingStartPeriod,
  getContactHotspotAccessMode,
  isOneTimeSubscriptionEnded,
  isPrepaidPackage,
  isRecurringSubscription,
  listBillingPeriods,
  normalizeBillingCycle,
  normalizeHotspotAccessMode,
  normalizeHotspotProvisioningOperation,
  normalizeHotspotProvisioningStatus,
  normalizeSubscriptionType,
  parsePaymentAmountFromMessage,
} = require("../customers/domain");
const {
  IP_BINDING_BANDWIDTH_STATUS,
  normalizeIpBindingBandwidthStatus,
  normalizeMacAddress,
  normalizeMacAddresses,
  normalizeQueueTarget,
} = require("../mikrotik/domain");
const {
  addDaysSafely,
  addMonthsSafely,
  buildHotspotEmailFromPhone,
  formatBillingPeriodLabel,
  formatUsernameFromName,
  generateId,
  getBillingPeriodKey,
  getBillingPeriodParts,
  getDateTimePartsInTimezone,
  getPreviousBillingPeriod,
  getReminderDeliveryDate,
  getSettingsReminderTemplate,
  isAutomaticBillingReminder,
  isGracePeriodReminder,
  isValidPhoneNumber,
  makeBillingPeriodKey,
  normalizePhoneNumber,
  parseBoolean,
  parseDateTimeInput,
  sanitizeInput,
  sanitizeMultilineText,
  sanitizePositiveInteger,
} = require("../../utils");
const DataManagerCore = require("./core");

class CustomerDataManager extends DataManagerCore {
  normalizeOptionalDate(value) {
    const raw = sanitizeInput(String(value || ""));
    if (!raw) return null;
    const date = parseDateTimeInput(raw, this.getTimezone()) || new Date(raw);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }

  normalizeContactHotspotFields(payload, current = {}) {
    const subscriptionType = normalizeSubscriptionType(
      payload.subscriptionType !== undefined ? payload.subscriptionType : current.subscriptionType
    );
    let enabled = payload.hotspotReactivationEnabled !== undefined
      ? parseBoolean(payload.hotspotReactivationEnabled, false)
      : parseBoolean(current.hotspotReactivationEnabled, false);
    if (subscriptionType === SUBSCRIPTION_TYPES.ONE_TIME) enabled = false;
    const username = payload.mikrotikUsername !== undefined
      ? sanitizeInput(String(payload.mikrotikUsername || ""))
      : sanitizeInput(String(current.mikrotikUsername || ""));
    const profile = payload.mikrotikProfile !== undefined
      ? sanitizeInput(String(payload.mikrotikProfile || ""))
      : sanitizeInput(String(current.mikrotikProfile || ""));
    const password = payload.mikrotikPassword !== undefined
      ? sanitizeInput(String(payload.mikrotikPassword || ""))
      : sanitizeInput(String(current.mikrotikPassword || ""));
    const reactivationAt = payload.hotspotReactivationAt !== undefined
      ? this.normalizeOptionalDate(payload.hotspotReactivationAt)
      : this.normalizeOptionalDate(current.hotspotReactivationAt);

    if (enabled && !username) throw new Error("Username hotspot wajib diisi untuk reaktivasi.");
    if (enabled && !profile) throw new Error("Profile hotspot wajib diisi untuk reaktivasi.");
    if (enabled && !reactivationAt) throw new Error("Jadwal reaktivasi wajib diisi.");
    if (!enabled && reactivationAt && !username) throw new Error("Username hotspot wajib diisi untuk jadwal nonaktif hotspot.");

    return {
      mikrotikUsername: username,
      mikrotikProfile: profile,
      mikrotikPassword: password,
      hotspotReactivationEnabled: enabled,
      hotspotReactivationAt: reactivationAt,
    };
  }

  applySubscriptionTypeTransition(contact, previousType, nextType, changedAt = new Date()) {
    const previous = normalizeSubscriptionType(previousType);
    const next = normalizeSubscriptionType(nextType, previous);
    if (previous === next) {
      return { changed: false, startedRecurring: false };
    }

    const requestedAt = changedAt instanceof Date ? changedAt : new Date(changedAt);
    const transitionAt = Number.isNaN(requestedAt.getTime()) ? new Date() : requestedAt;
    contact.subscriptionChangedByArrears = false;
    contact.arrearsSubscriptionDebtPeriods = [];
    contact.billingPausedForArrears = false;
    contact.billingPausedAfterPeriod = null;
    contact.hotspotSuspendedForArrears = false;
    contact.hotspotManualActivationWithArrears = false;

    if (next !== SUBSCRIPTION_TYPES.RECURRING) {
      contact.recurringBillingStartedAt = null;
      return { changed: true, startedRecurring: false };
    }

    const currentKey = getBillingPeriodKey(transitionAt, this.getTimezone());
    if (!contact.paymentMonths || typeof contact.paymentMonths !== "object") {
      contact.paymentMonths = {};
    }
    delete contact.recurringBillingStartedAt;
    if (!contact.paymentMonths[currentKey]) {
      contact.paymentMonths[currentKey] = {
        status: PAYMENT_STATUS.UNPAID,
        paidDate: null,
        paymentType: null,
        paidAmount: 0,
      };
    }
    const currentPayment = contact.paymentMonths[currentKey];
    const currentStatus = currentPayment.status === PAYMENT_STATUS.PAID
      ? PAYMENT_STATUS.PAID
      : PAYMENT_STATUS.UNPAID;
    contact.paymentStatus = currentStatus;
    contact.paymentDate = currentStatus === PAYMENT_STATUS.PAID
      ? currentPayment.paidDate || contact.paymentDate || null
      : null;
    contact.paymentType = currentPayment.paymentType || null;
    contact.hotspotReactivationEnabled = false;
    contact.hotspotReactivationAt = null;
    return { changed: true, startedRecurring: true, currentKey };
  }

  async saveAll() {
    await this.withDataMutation(() => (
      this.withDatabaseWrite(() => (
        this.sequelize.transaction(async (transaction) => {
          const options = { transaction };
          await this.saveContacts(options);
          await this.savePelanggan(options);
          await this.saveCustomerAccounts(options);
          await this.savePaymentGatewayTransactions(options);
          await this.saveReminders(options);
          await this.saveSentReminders(options);
          await this.saveVoucherBatches(options);
          await this.saveVoucherRevenueEntries(options);
          await this.saveRoles(options);
          await this.saveSettings(options);
        })
      ))
    ));
  }

  async createBackup(now = new Date()) {
    if (process.env.DATABASE_URL) {
      throw new Error("Backup database otomatis hanya tersedia untuk database SQLite lokal.");
    }

    const timestamp = now.toISOString().replace(/[:.]/g, "-");
    const backupDir = path.join(CONFIG.DB_PATH, "backups", timestamp);
    await fs.mkdir(backupDir, { recursive: true });

    try {
      await this.withDatabaseWrite(async () => {
        const backupFile = path.join(backupDir, path.basename(CONFIG.DB_STORAGE));
        const escapedBackupFile = backupFile.replace(/'/g, "''");
        await this.sequelize.query(`VACUUM INTO '${escapedBackupFile}'`);
        await fs.chmod(backupFile, 0o600);
      });
    } catch (error) {
      await fs.rm(backupDir, { recursive: true, force: true });
      throw error;
    }

    const deletedCount = await this.cleanupDatabaseBackups(now);

    this.activityLog.push("info", "storage", "Backup database dibuat", { backupDir, deletedCount });
    return { backupDir, deletedCount };
  }

  async cleanupDatabaseBackups(now = new Date()) {
    const backupRoot = path.join(CONFIG.DB_PATH, "backups");
    const retentionDays = Math.max(1, CONFIG.DB_BACKUP_RETENTION_DAYS);
    const cutoffTime = now.getTime() - (retentionDays * 24 * 60 * 60 * 1000);
    const entries = await fs.readdir(backupRoot, { withFileTypes: true }).catch((error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    let deletedCount = 0;

    for (const entry of entries) {
      if (!entry.isDirectory() || !/^\d{4}-\d{2}-\d{2}T/.test(entry.name)) continue;

      const backupDir = path.join(backupRoot, entry.name);
      const stats = await fs.stat(backupDir);
      if (stats.mtimeMs > cutoffTime) continue;

      await fs.rm(backupDir, { recursive: true, force: true });
      deletedCount += 1;
    }

    return deletedCount;
  }

  getSortedContacts() {
    return Array.from(this.contacts.values())
      .map((contact) => this.hydrateContact(contact))
      .sort((a, b) => a.name.localeCompare(b.name, "id-ID"));
  }

  getContacts() {
    return Array.from(this.contacts.values()).map((contact) => this.hydrateContact(contact));
  }

  getSortedReminders() {
    return Array.from(this.reminders.values())
      .map((reminder) => this.hydrateReminder(reminder))
      .sort((a, b) => new Date(a.deliveryDateTime) - new Date(b.deliveryDateTime));
  }

  getSentReminders() {
    return Array.from(this.sentReminders.values())
      .map((reminder) => this.hydrateReminder(reminder))
      .sort((a, b) => new Date(b.sentAt || b.reminderDateTime) - new Date(a.sentAt || a.reminderDateTime));
  }

  getDashboardSummary(now = new Date()) {
    const contacts = this.getSortedContacts();
    const reminders = this.getSortedReminders();
    const sentReminders = this.getSentReminders();
    const paid = contacts.filter((contact) => contact.paymentStatus === PAYMENT_STATUS.PAID).length;
    const unpaid = contacts.length - paid;
    const debt = contacts.filter((contact) => contact.hasDebt).length;
    const managedServices = contacts.filter((contact) => {
      const status = normalizeHotspotProvisioningStatus(contact.hotspotProvisioningStatus);
      return Boolean(contact.mikrotikUsername)
        || normalizeMacAddresses(contact.mikrotikMacAddresses).length > 0
        || status !== HOTSPOT_PROVISIONING_STATUS.NONE;
    });
    const activeServices = managedServices.filter((contact) => (
      normalizeHotspotProvisioningStatus(contact.hotspotProvisioningStatus)
        === HOTSPOT_PROVISIONING_STATUS.ACTIVE
    )).length;
    const successfulDeliveryStatuses = new Set(["SENT", "SENT_BAILEYS", "ACCEPTED", "DELIVERED", "READ"]);
    const todayKey = getDateTimePartsInTimezone(now, this.getTimezone()).dateKey;
    const sentToday = sentReminders.filter((reminder) => {
      if (!successfulDeliveryStatuses.has(String(reminder.deliveryStatus || "").toUpperCase())) return false;
      const sentAt = new Date(reminder.sentAt || reminder.reminderDateTime || "");
      return !Number.isNaN(sentAt.getTime())
        && getDateTimePartsInTimezone(sentAt, this.getTimezone()).dateKey === todayKey;
    }).length;
    return {
      contacts: contacts.length,
      pelanggan: this.pelanggan.size,
      reminders: reminders.length,
      sentReminders: sentReminders.length,
      sentToday,
      paidContacts: paid,
      unpaidContacts: unpaid,
      debtContacts: debt,
      activeServices,
      serviceAttention: managedServices.length - activeServices,
      adminRecipients: this.getAdminRecipients().length,
      nextReminderAt: reminders[0]?.deliveryDateTime || reminders[0]?.reminderDateTime || null,
    };
  }

  findContactByPhone(phoneNumber) {
    return Array.from(this.contacts.values()).find((contact) => contact.phoneNumber === phoneNumber);
  }

  hasContactPhone(phoneNumber, excludeId = null) {
    return Array.from(this.contacts.values()).some(
      (contact) => contact.phoneNumber === phoneNumber && String(contact.id) !== String(excludeId)
    );
  }

  hasContactHotspotUsername(username, excludeId = null) {
    const normalized = sanitizeInput(String(username || "")).toLowerCase();
    if (!normalized) return false;
    return Array.from(this.contacts.values()).some((contact) => (
      sanitizeInput(String(contact.mikrotikUsername || "")).toLowerCase() === normalized
      && String(contact.id) !== String(excludeId)
    ));
  }

  hasContactMikrotikMac(macAddress, excludeId = null) {
    const normalized = normalizeMacAddress(macAddress);
    if (!normalized) return false;
    return Array.from(this.contacts.values()).some((contact) => (
      normalizeMacAddresses(contact.mikrotikMacAddresses).includes(normalized)
      && String(contact.id) !== String(excludeId)
    ));
  }

  async setContactMikrotikMacAddresses(contactId, macAddresses) {
    return this.withDataMutation(async () => {
      const contact = this.getContact(contactId);
      if (!contact) throw new Error("Kontak tidak ditemukan.");
      const normalized = normalizeMacAddresses(macAddresses);
      const duplicate = normalized.find((macAddress) => this.hasContactMikrotikMac(macAddress, contact.id));
      if (duplicate) throw new Error(`MAC ${duplicate} sudah terhubung ke pelanggan lain.`);
      contact.mikrotikMacAddresses = normalized;
      if (normalized.length === 0) {
        contact.hotspotAccessMode = HOTSPOT_ACCESS_MODES.HOTSPOT_ONLY;
      } else {
        contact.hotspotAccessMode = getContactHotspotAccessMode(contact);
      }
      contact.updatedAt = new Date().toISOString();
      await this.saveContacts();
      return this.hydrateContact(contact);
    });
  }

  async setContactHotspotAccessMode(contactId, mode) {
    return this.withDataMutation(async () => {
      const contact = this.getContact(contactId);
      if (!contact) throw new Error("Kontak tidak ditemukan.");
      const accessMode = normalizeHotspotAccessMode(mode, "");
      if (!accessMode) throw new Error("Mode akses hotspot tidak valid.");
      if (accessMode !== HOTSPOT_ACCESS_MODES.HOTSPOT_ONLY
        && normalizeMacAddresses(contact.mikrotikMacAddresses).length === 0) {
        throw new Error("Tambahkan minimal satu MAC IP Binding untuk memakai mode ini.");
      }
      const now = new Date().toISOString();
      contact.hotspotAccessMode = accessMode;
      contact.hotspotProvisioningStatus = HOTSPOT_PROVISIONING_STATUS.ACTIVE;
      contact.hotspotProvisioningOperation = HOTSPOT_PROVISIONING_OPERATION.NONE;
      contact.hotspotProvisioningPrevious = null;
      contact.hotspotProvisioningError = "";
      contact.hotspotLastCheckedAt = now;
      contact.hotspotLastSyncedAt = now;
      contact.updatedAt = now;

      const pelanggan = this.pelanggan.get(contact.mikrotikUsername) || Array.from(this.pelanggan.values()).find(
        (item) => String(item.contactId || "") === String(contact.id)
      ) || null;
      if (pelanggan) {
        pelanggan.hotspotAccessMode = accessMode;
        pelanggan.status = "verified";
        pelanggan.hotspotProvisioningStatus = HOTSPOT_PROVISIONING_STATUS.ACTIVE;
        pelanggan.hotspotProvisioningError = "";
        pelanggan.hotspotLastCheckedAt = now;
        pelanggan.hotspotLastSyncedAt = now;
        pelanggan.tanggalUpdate = now;
      }

      await this.withDatabaseWrite(() => this.sequelize.transaction(async (transaction) => {
        const options = { transaction };
        await this.saveContacts(options);
        await this.savePelanggan(options);
      }));
      return this.hydrateContact(contact);
    });
  }

  async updateContactIpBindingBandwidthStatus(contactId, result = {}) {
    return this.withDataMutation(async () => {
      const contact = this.getContact(contactId);
      if (!contact) throw new Error("Kontak tidak ditemukan.");
      const macAddresses = normalizeMacAddresses(contact.mikrotikMacAddresses);
      const devices = (Array.isArray(result.devices) ? result.devices : [])
        .map((device) => {
          let macAddress;
          try {
            macAddress = normalizeMacAddress(device?.macAddress);
          } catch (_error) {
            return null;
          }
          if (!macAddresses.includes(macAddress)) return null;
          const address = net.isIP(String(device?.address || "").trim()) === 4
            ? String(device.address).trim()
            : "";
          return {
            macAddress,
            address,
            source: ["DHCP", "HOTSPOT"].includes(String(device?.source || "").toUpperCase())
              ? String(device.source).toUpperCase()
              : "",
            status: address ? "READY" : "PENDING_DHCP",
          };
        })
        .filter(Boolean);
      contact.ipBindingBandwidthStatus = normalizeIpBindingBandwidthStatus(
        result.status,
        macAddresses.length > 0 ? IP_BINDING_BANDWIDTH_STATUS.FAILED : IP_BINDING_BANDWIDTH_STATUS.NONE
      );
      contact.ipBindingBandwidthRateLimit = sanitizeInput(String(result.rateLimit || ""));
      contact.ipBindingBandwidthTargetAddresses = normalizeQueueTarget(result.targetAddresses);
      contact.ipBindingBandwidthPendingMacAddresses = normalizeMacAddresses(
        result.pendingMacAddresses
      ).filter((macAddress) => macAddresses.includes(macAddress));
      contact.ipBindingBandwidthDevices = devices;
      contact.ipBindingBandwidthError = sanitizeInput(String(result.error || ""));
      contact.ipBindingBandwidthLastSyncedAt = this.normalizeOptionalDate(result.syncedAt || new Date());
      const queueNames = [...new Set((Array.isArray(result.queueNames)
        ? result.queueNames
        : [result.queueName])
        .map((name) => sanitizeInput(String(name || "")))
        .filter(Boolean))];
      contact.ipBindingBandwidthQueueNames = queueNames;
      contact.ipBindingBandwidthQueueName = queueNames[0] || "";
      await this.saveContacts();
      return this.hydrateContact(contact);
    });
  }

  getContact(id) {
    return this.contacts.get(String(id)) || null;
  }

  getReminder(id) {
    return this.reminders.get(String(id)) || null;
  }

  getResolvedReminderContact(reminder) {
    if (reminder?.contactId) {
      const contact = this.getContact(reminder.contactId);
      if (contact) return contact;
    }

    if (reminder?.phoneNumber) {
      return this.findContactByPhone(reminder.phoneNumber) || null;
    }

    return null;
  }

  hydrateReminder(reminder) {
    const contact = this.getResolvedReminderContact(reminder);
    const deliveryDate = this.getReminderDeliveryDate(reminder);
    const retryDate = new Date(reminder.nextDeliveryAttemptAt || "");
    const graceDays = sanitizePositiveInteger(
      this.getSettings().hotspotIsolationGraceDays,
      DEFAULT_SETTINGS.hotspotIsolationGraceDays,
      0,
      30
    );
    let deliveryScheduleType = "STANDARD";
    if (!Number.isNaN(retryDate.getTime())) {
      deliveryScheduleType = "RETRY";
    } else if (graceDays > 0 && isGracePeriodReminder(reminder)) {
      deliveryScheduleType = "GRACE_PERIOD";
    } else if (isAutomaticBillingReminder(reminder)) {
      deliveryScheduleType = "BILLING_DUE";
    }
    return {
      ...reminder,
      contactId: reminder.contactId || contact?.id || null,
      contactName: contact?.name || reminder.contactName || null,
      phoneNumber: contact?.phoneNumber || reminder.phoneNumber || null,
      subscriptionType: normalizeSubscriptionType(contact?.subscriptionType || reminder.subscriptionType),
      billingCycle: normalizeBillingCycle(contact?.billingCycle || reminder.billingCycle),
      paymentAmount: Math.max(0, Number(reminder.paymentAmount ?? contact?.monthlyPaymentAmount) || 0),
      deliveryDateTime: Number.isNaN(deliveryDate.getTime()) ? reminder.reminderDateTime : deliveryDate.toISOString(),
      deliveryScheduleType,
    };
  }

  getReminderDeliveryDate(reminder) {
    return getReminderDeliveryDate(
      reminder,
      this.getSettings().hotspotIsolationGraceDays,
      this.getTimezone()
    );
  }

  buildDueDateInfo(contact) {
    if (!isRecurringSubscription(contact)) {
      return {
        dueDate: null,
        dueStatus: "NOT_APPLICABLE",
      };
    }

    if (isPrepaidPackage(contact)) {
      const activeUntil = contact.hotspotReactivationAt
        ? new Date(contact.hotspotReactivationAt)
        : null;
      if (!activeUntil || !Number.isFinite(activeUntil.getTime())) {
        return { dueDate: null, dueStatus: "NOT_SCHEDULED" };
      }
      return {
        dueDate: activeUntil.toISOString(),
        dueStatus: activeUntil.getTime() > Date.now() ? "UPCOMING" : "OVERDUE",
      };
    }

    const timeZone = this.getTimezone();
    const { year, month } = getBillingPeriodParts(new Date(), timeZone);
    const activePeriodKey = makeBillingPeriodKey(year, month);
    const activeBillingPeriod = getContactBillingPeriod(contact, { year, month });
    const activeBillingPeriodKey = makeBillingPeriodKey(
      activeBillingPeriod.year,
      activeBillingPeriod.month
    );
    const isContactReminder = (reminder) => {
      if (String(reminder.contactId || "") === String(contact.id)) return true;
      return reminder.phoneNumber && reminder.phoneNumber === contact.phoneNumber;
    };

    const activeReminders = Array.from(this.reminders.values())
      .filter(isContactReminder)
      .map((reminder) => ({ ...reminder, active: true }));
    const reminders = [
      ...activeReminders,
      ...Array.from(this.sentReminders.values())
        .filter(isContactReminder)
        .map((reminder) => ({ ...reminder, active: false })),
    ];

    const parsedReminders = reminders
      .map((reminder) => ({
        ...reminder,
        reminderDate: new Date(reminder.reminderDateTime),
      }))
      .filter((reminder) => !Number.isNaN(reminder.reminderDate.getTime()))
      .map((reminder) => ({
        ...reminder,
        timestamp: reminder.reminderDate.getTime(),
        periodKey: getBillingPeriodKey(reminder.reminderDate, timeZone),
        billingPeriod: getContactBillingPeriod(
          contact,
          getBillingPeriodParts(reminder.reminderDate, timeZone)
        ),
      }))
      .map((reminder) => ({
        ...reminder,
        billingPeriodKey: makeBillingPeriodKey(
          reminder.billingPeriod.year,
          reminder.billingPeriod.month
        ),
      }))
      .sort((a, b) => a.timestamp - b.timestamp);

    const nowTs = Date.now();
    const activePeriodReminders = parsedReminders.filter((reminder) => reminder.periodKey === activePeriodKey);
    const nextInActivePeriod = activePeriodReminders.find((reminder) => reminder.timestamp >= nowTs) || null;
    const latestInActivePeriod = activePeriodReminders.length > 0
      ? activePeriodReminders[activePeriodReminders.length - 1]
      : null;
    const nextActiveReminder = parsedReminders.find(
      (reminder) => reminder.active && reminder.timestamp >= nowTs
    ) || null;
    const dueReminder = nextInActivePeriod || nextActiveReminder || latestInActivePeriod;
    const dueDate = dueReminder ? new Date(dueReminder.timestamp).toISOString() : null;

    let dueStatus = "NOT_SCHEDULED";
    if (dueDate) {
      const periodPaymentStatus = String(
        contact.paymentMonths?.[dueReminder.billingPeriodKey]?.status
          || (dueReminder.billingPeriodKey === activeBillingPeriodKey
            ? contact.paymentStatus
            : PAYMENT_STATUS.UNPAID)
      ).toUpperCase();
      if (periodPaymentStatus === PAYMENT_STATUS.PAID) {
        dueStatus = "PAID";
      } else if (dueReminder.timestamp < nowTs) {
        dueStatus = "OVERDUE";
      } else {
        dueStatus = "UPCOMING";
      }
    }

    return {
      dueDate,
      dueStatus,
    };
  }

  getPaymentPaidAmount(payment, monthlyAmount) {
    const normalizedMonthlyAmount = Math.max(0, Math.floor(Number(monthlyAmount) || 0));
    if (!payment || normalizedMonthlyAmount <= 0) return 0;
    if (String(payment.status || "").toUpperCase() === PAYMENT_STATUS.PAID) {
      return normalizedMonthlyAmount;
    }
    return Math.min(
      normalizedMonthlyAmount,
      Math.max(0, Math.floor(Number(payment.paidAmount) || 0))
    );
  }

  getPaymentRemainingAmount(payment, monthlyAmount) {
    const normalizedMonthlyAmount = Math.max(0, Math.floor(Number(monthlyAmount) || 0));
    return Math.max(0, normalizedMonthlyAmount - this.getPaymentPaidAmount(payment, normalizedMonthlyAmount));
  }

  buildDebtInfo(contact, options = {}) {
    const timeZone = this.getTimezone();
    const activePeriod = getBillingPeriodParts(new Date(), timeZone);
    const referencePeriod = options.year && options.month
      ? { year: options.year, month: options.month }
      : activePeriod;
    const { year, month } = options.billingPeriod === true
      ? referencePeriod
      : getContactBillingPeriod(contact, referencePeriod);
    const currentKey = makeBillingPeriodKey(year, month);
    const paymentMonths = contact.paymentMonths || {};
    const monthlyAmount = Math.max(0, Math.floor(Number(contact.monthlyPaymentAmount) || 0));
    const currentPayment = paymentMonths[currentKey] || null;
    const previous = getPreviousBillingPeriod(year, month);
    const startPeriod = getContactBillingStartPeriod(contact, timeZone);
    if (isPrepaidPackage(contact)) {
      const requestedAt = options.at ? new Date(options.at) : new Date();
      const now = Number.isNaN(requestedAt.getTime()) ? new Date() : requestedAt;
      const activeUntil = contact.hotspotReactivationAt
        ? new Date(contact.hotspotReactivationAt)
        : null;
      const packageActive = Boolean(
        activeUntil
        && Number.isFinite(activeUntil.getTime())
        && activeUntil.getTime() > now.getTime()
      );
      const paymentStatus = packageActive ? PAYMENT_STATUS.PAID : PAYMENT_STATUS.UNPAID;
      return {
        hasDebt: false,
        debtPeriod: null,
        debtPeriodLabel: "",
        debtPeriods: [],
        debtCount: 0,
        debtAmount: 0,
        debtNote: "",
        previousPaymentStatus: PAYMENT_STATUS.PAID,
        paymentStatus,
        currentPaymentStatus: paymentStatus,
        currentPaymentType: packageActive ? PAYMENT_TYPES.ACTIVE_PERIOD : null,
        subscriptionType: normalizeSubscriptionType(contact.subscriptionType),
        billingCycle: BILLING_CYCLES.PREPAID,
        billingPeriodKey: currentKey,
        billingPeriodLabel: "Paket prabayar",
        subscriptionActive: true,
        packageActive,
        packageActiveUntil: packageActive ? activeUntil.toISOString() : null,
        billingPausedForArrears: false,
        billingPausedAfterPeriod: null,
      };
    }
    const billingPausedForArrears = isRecurringSubscription(contact)
      && parseBoolean(contact.billingPausedForArrears, false);
    const pausedAfterPeriod = /^\d{4}-\d{2}$/.test(String(contact.billingPausedAfterPeriod || ""))
      ? {
          year: Number(String(contact.billingPausedAfterPeriod).slice(0, 4)),
          month: Number(String(contact.billingPausedAfterPeriod).slice(5, 7)),
        }
      : previous;
    const debtEndPeriod = billingPausedForArrears
      ? (compareBillingPeriods(pausedAfterPeriod, { year, month }) <= 0
        ? pausedAfterPeriod
        : { year, month })
      : previous;
    const billingPeriods = isRecurringSubscription(contact)
      ? listBillingPeriods(startPeriod, debtEndPeriod)
      : (compareBillingPeriods(startPeriod, previous) <= 0 ? [startPeriod] : []);
    const legacyOneTimePeriods = !isRecurringSubscription(contact)
      ? Object.entries(paymentMonths)
        .filter(([key, payment]) => /^\d{4}-\d{2}$/.test(key)
          && payment?.status !== PAYMENT_STATUS.PAID
          && key !== currentKey)
        .map(([key, payment]) => ({
          year: Number(key.slice(0, 4)),
          month: Number(key.slice(5, 7)),
          status: payment?.status || PAYMENT_STATUS.UNPAID,
        }))
      : [];
    const debtPeriods = [...billingPeriods, ...legacyOneTimePeriods]
      .filter((period, index, all) => all.findIndex((candidate) => candidate.year === period.year && candidate.month === period.month) === index)
      .filter((period) => {
        const key = makeBillingPeriodKey(period.year, period.month);
        return paymentMonths[key]?.status !== PAYMENT_STATUS.PAID;
      })
      .map((period) => {
        const key = makeBillingPeriodKey(period.year, period.month);
        const payment = paymentMonths[key] || null;
        const paidAmount = this.getPaymentPaidAmount(payment, monthlyAmount);
        return {
          key,
          label: formatBillingPeriodLabel(period.year, period.month),
          status: payment?.status || PAYMENT_STATUS.UNPAID,
          paidAmount,
          remainingAmount: this.getPaymentRemainingAmount(payment, monthlyAmount),
        };
      });
    const hasDebt = debtPeriods.length > 0;
    const firstDebt = debtPeriods[0] || null;
    const debtAmount = debtPeriods.reduce((total, period) => total + period.remainingAmount, 0);
    const subscriptionEnded = isOneTimeSubscriptionEnded(contact, { year, month }, timeZone);
    const activeBillingPeriod = getContactBillingPeriod(contact, activePeriod);
    const isActivePeriod = year === activeBillingPeriod.year && month === activeBillingPeriod.month;
    const billingStarted = compareBillingPeriods(startPeriod, { year, month }) <= 0;
    const effectivePaymentStatus = subscriptionEnded
      || billingPausedForArrears
      ? PAYMENT_STATUS.PAID
      : (currentPayment?.status || (isActivePeriod
        ? String(contact.paymentStatus || PAYMENT_STATUS.UNPAID).toUpperCase()
        : PAYMENT_STATUS.UNPAID));

    return {
      hasDebt,
      debtPeriod: firstDebt?.key || makeBillingPeriodKey(previous.year, previous.month),
      debtPeriodLabel: firstDebt?.label || formatBillingPeriodLabel(previous.year, previous.month),
      debtPeriods,
      debtCount: debtPeriods.length,
      debtAmount,
      debtNote: hasDebt
        ? `Sisa tunggakan ${this.formatPaymentAmount(debtAmount)} untuk ${debtPeriods.map((period) => period.label).join(", ")}.`
        : "",
      previousPaymentStatus: paymentMonths[makeBillingPeriodKey(previous.year, previous.month)]?.status || PAYMENT_STATUS.UNPAID,
      paymentStatus: effectivePaymentStatus,
      currentPaymentStatus: effectivePaymentStatus,
      currentPaymentType: currentPayment?.paymentType || null,
      subscriptionType: normalizeSubscriptionType(contact.subscriptionType),
      billingCycle: normalizeBillingCycle(contact.billingCycle),
      billingPeriodKey: currentKey,
      billingPeriodLabel: formatBillingPeriodLabel(year, month),
      subscriptionActive: !subscriptionEnded && !billingPausedForArrears,
      billingPausedForArrears,
      billingPausedAfterPeriod: billingPausedForArrears
        ? makeBillingPeriodKey(debtEndPeriod.year, debtEndPeriod.month)
        : null,
    };
  }

  pauseBillingForArrears(contact, options = {}) {
    if (!contact || !isRecurringSubscription(contact) || isPrepaidPackage(contact)) return false;
    const alreadyPaused = parseBoolean(contact.billingPausedForArrears, false)
      && /^\d{4}-\d{2}$/.test(String(contact.billingPausedAfterPeriod || ""));
    const requestedAt = options.at ? new Date(options.at) : new Date();
    const now = Number.isNaN(requestedAt.getTime()) ? new Date() : requestedAt;
    const referencePeriod = getBillingPeriodParts(now, this.getTimezone());
    const { year, month } = getContactBillingPeriod(contact, referencePeriod);
    const currentKey = makeBillingPeriodKey(year, month);
    if (!contact.paymentMonths || typeof contact.paymentMonths !== "object") {
      contact.paymentMonths = {};
    }
    const currentPayment = contact.paymentMonths[currentKey] || {};
    if (!alreadyPaused && currentPayment.status !== PAYMENT_STATUS.PAID) {
      contact.paymentMonths[currentKey] = {
        ...currentPayment,
        status: PAYMENT_STATUS.UNPAID,
        paidDate: null,
        paymentType: currentPayment.paymentType || null,
        paidAmount: this.getPaymentPaidAmount(currentPayment, contact.monthlyPaymentAmount),
      };
    }
    contact.billingPausedForArrears = true;
    if (!alreadyPaused) contact.billingPausedAfterPeriod = currentKey;
    contact.hotspotSuspendedForArrears = options.suspended !== false;
    contact.hotspotManualActivationWithArrears = false;
    contact.paymentStatus = PAYMENT_STATUS.PAID;
    contact.paymentDate = null;
    contact.paymentType = null;
    return true;
  }

  buildActivePeriodPurchase(contact, payload = {}) {
    if (!contact || !isRecurringSubscription(contact)) {
      throw new Error("Pembelian masa aktif hanya tersedia untuk pelanggan bulanan.");
    }
    if (!isPrepaidPackage(contact) && !this.buildDebtInfo(contact).hasDebt) {
      throw new Error("Pembelian masa aktif hanya tersedia untuk pelanggan yang memiliki tunggakan.");
    }

    const amount = Math.max(0, Math.floor(Number(contact.monthlyPaymentAmount) || 0));
    if (amount <= 0) {
      throw new Error("Nominal bulanan harus diisi sebelum membeli masa aktif.");
    }

    const purchasedAt = new Date(payload.purchasedAt || new Date());
    const activeFrom = new Date(payload.activeFrom || purchasedAt);
    const activeUntil = new Date(payload.activeUntil || addMonthsSafely(activeFrom, 1, this.getTimezone()));
    if ([purchasedAt, activeFrom, activeUntil].some((value) => Number.isNaN(value.getTime()))) {
      throw new Error("Waktu pembelian masa aktif tidak valid.");
    }
    if (activeUntil.getTime() <= activeFrom.getTime()) {
      throw new Error("Batas masa aktif harus setelah waktu mulai.");
    }

    const id = sanitizeInput(String(payload.id || ""));
    if (!id) throw new Error("ID transaksi pembelian masa aktif tidak valid.");

    return {
      id,
      paymentType: PAYMENT_TYPES.ACTIVE_PERIOD,
      status: PAYMENT_STATUS.PAID,
      amount,
      purchasedAt: purchasedAt.toISOString(),
      activeFrom: activeFrom.toISOString(),
      activeUntil: activeUntil.toISOString(),
      paymentProvider: sanitizeInput(String(payload.paymentProvider || "manual")) || "manual",
    };
  }

  applyActivePeriodPurchase(contact, payload = {}) {
    const purchase = this.buildActivePeriodPurchase(contact, payload);
    if (!Array.isArray(contact.activePeriodPurchases)) contact.activePeriodPurchases = [];
    const existing = contact.activePeriodPurchases.find((item) => String(item.id) === purchase.id);
    if (existing) return { purchase: existing, added: false };

    contact.activePeriodPurchases.push(purchase);
    contact.billingPausedForArrears = false;
    contact.billingPausedAfterPeriod = null;
    contact.hotspotSuspendedForArrears = false;
    contact.hotspotManualActivationWithArrears = false;
    contact.hotspotReactivationEnabled = true;
    contact.hotspotReactivationAt = purchase.activeUntil;
    contact.paymentStatus = PAYMENT_STATUS.PAID;
    contact.paymentDate = purchase.purchasedAt;
    contact.paymentType = PAYMENT_TYPES.ACTIVE_PERIOD;
    contact.updatedAt = purchase.purchasedAt;
    return { purchase, added: true };
  }

  async recordActivePeriodPurchase(contactId, payload = {}) {
    return this.withDataMutation(async () => {
      const contact = this.getContact(contactId);
      if (!contact) throw new Error("Kontak tidak ditemukan.");
      const result = this.applyActivePeriodPurchase(contact, payload);
      if (result.added) {
        const reminderResult = this.syncActivePeriodExpiryReminder(contact, result.purchase);
        await this.savePaymentAndReminderChanges(reminderResult.changed);
      }
      return {
        ...result,
        contact: this.hydrateContact(contact),
      };
    });
  }

  resumeAutomaticRenewalIfArrearsSettled(contact, options = {}) {
    if (!contact || isPrepaidPackage(contact)
      || !parseBoolean(contact.billingPausedForArrears, false)) return false;
    if (this.buildDebtInfo(contact).hasDebt) return false;

    const requestedAt = options.at ? new Date(options.at) : new Date();
    const now = Number.isNaN(requestedAt.getTime()) ? new Date() : requestedAt;
    const currentSchedule = new Date(contact.hotspotReactivationAt || 0);
    const hasFutureSchedule = Number.isFinite(currentSchedule.getTime())
      && currentSchedule.getTime() > now.getTime();
    const pausedAfterKey = String(contact.billingPausedAfterPeriod || "");
    if (/^\d{4}-\d{2}$/.test(pausedAfterKey)) {
      const pausedAfter = {
        year: Number(pausedAfterKey.slice(0, 4)),
        month: Number(pausedAfterKey.slice(5, 7)),
      };
      const firstPausedPeriod = addBillingMonths(pausedAfter, 1);
      const currentPeriod = getContactBillingPeriod(
        contact,
        getBillingPeriodParts(now, this.getTimezone())
      );
      const monthlyAmount = Math.max(0, Math.floor(Number(contact.monthlyPaymentAmount) || 0));
      if (!contact.paymentMonths || typeof contact.paymentMonths !== "object") {
        contact.paymentMonths = {};
      }
      for (const period of listBillingPeriods(firstPausedPeriod, currentPeriod)) {
        const key = makeBillingPeriodKey(period.year, period.month);
        contact.paymentMonths[key] = {
          ...(contact.paymentMonths[key] || {}),
          status: PAYMENT_STATUS.PAID,
          paidDate: null,
          paymentType: null,
          paidAmount: monthlyAmount,
          billingPaused: true,
        };
      }
    }

    contact.billingPausedForArrears = false;
    contact.billingPausedAfterPeriod = null;
    contact.hotspotManualActivationWithArrears = false;
    contact.hotspotReactivationEnabled = isRecurringSubscription(contact);
    if (isRecurringSubscription(contact) && !hasFutureSchedule) {
      contact.hotspotReactivationAt = addMonthsSafely(now, 1, this.getTimezone()).toISOString();
    }
    contact.paymentStatus = PAYMENT_STATUS.PAID;
    contact.paymentDate = contact.paymentDate || now.toISOString();
    contact.paymentType = contact.paymentType || PAYMENT_TYPES.FULL_PAID;
    return true;
  }

  applyArrearsSubscriptionPolicy(contact, options = {}) {
    const updatedAt = options.updatedAt || new Date().toISOString();
    if (!parseBoolean(contact.subscriptionChangedByArrears, false)) {
      return { changed: false, converted: false, restored: false, remindersAdded: 0, remindersRemoved: 0 };
    }

    contact.subscriptionType = SUBSCRIPTION_TYPES.RECURRING;
    contact.subscriptionChangedByArrears = false;
    contact.arrearsSubscriptionDebtPeriods = [];
    contact.hotspotReactivationEnabled = true;
    if (!contact.hotspotReactivationAt) {
      contact.hotspotReactivationAt = this.getNextServiceScheduleFromRegistration(contact);
    } else {
      let nextSchedule = new Date(contact.hotspotReactivationAt);
      const now = new Date();
      while (!Number.isNaN(nextSchedule.getTime()) && nextSchedule.getTime() <= now.getTime()) {
        nextSchedule = addMonthsSafely(nextSchedule, 1, this.getTimezone());
      }
      contact.hotspotReactivationAt = Number.isNaN(nextSchedule.getTime())
        ? this.getNextServiceScheduleFromRegistration(contact)
        : nextSchedule.toISOString();
    }

    const referencePeriod = getBillingPeriodParts(new Date(), this.getTimezone());
    const currentPeriod = getContactBillingPeriod(contact, referencePeriod);
    const currentKey = makeBillingPeriodKey(currentPeriod.year, currentPeriod.month);
    const currentPayment = contact.paymentMonths?.[currentKey];
    contact.paymentStatus = currentPayment?.status === PAYMENT_STATUS.PAID
      ? PAYMENT_STATUS.PAID
      : PAYMENT_STATUS.UNPAID;
    contact.paymentDate = contact.paymentStatus === PAYMENT_STATUS.PAID
      ? currentPayment?.paidDate || null
      : null;
    contact.paymentType = contact.paymentStatus === PAYMENT_STATUS.PAID
      ? currentPayment?.paymentType || null
      : null;
    contact.updatedAt = updatedAt;
    const reminderResult = this.ensureRecurringReminder(contact);

    this.activityLog.push("info", "billing", `Pelanggan ${contact.name || contact.id} dipulihkan sebagai pelanggan bulanan; tunggakan tetap tercatat`, {
      contactId: contact.id,
      hotspotSchedule: contact.hotspotReactivationAt || null,
    });

    return {
      changed: true,
      converted: false,
      restored: true,
      remindersAdded: reminderResult.created ? 1 : 0,
      remindersRemoved: 0,
    };
  }

  usesRecurringBilling(contact) {
    return isRecurringSubscription(contact) || parseBoolean(contact.subscriptionChangedByArrears, false);
  }

  enforceArrearsSubscriptionPolicy(options = {}) {
    let converted = 0;
    let restored = 0;
    let remindersAdded = 0;
    let remindersRemoved = 0;

    for (const contact of this.contacts.values()) {
      const result = this.applyArrearsSubscriptionPolicy(contact, options);
      if (!result.changed) continue;
      if (result.converted) converted += 1;
      if (result.restored) restored += 1;
      remindersAdded += result.remindersAdded;
      remindersRemoved += result.remindersRemoved;
    }

    return { changed: converted + restored, converted, restored, remindersAdded, remindersRemoved };
  }

  hydrateContact(contact) {
    const debtInfo = this.buildDebtInfo(contact);
    const dueDateInfo = this.buildDueDateInfo(contact);
    const graceDays = sanitizePositiveInteger(
      this.getSettings().hotspotIsolationGraceDays,
      DEFAULT_SETTINGS.hotspotIsolationGraceDays,
      0,
      30
    );
    const isPrepaidSchedule = isPrepaidPackage(contact)
      && Boolean(contact.hotspotReactivationEnabled);
    const activeUntil = isPrepaidSchedule && contact.hotspotReactivationAt
      ? new Date(contact.hotspotReactivationAt)
      : null;
    const hotspotGraceEndsAt = graceDays > 0
      && activeUntil
      && Number.isFinite(activeUntil.getTime())
      ? addDaysSafely(activeUntil, graceDays, this.getTimezone()).toISOString()
      : null;
    return {
      ...contact,
      ...debtInfo,
      ...dueDateInfo,
      hotspotGraceDays: isPrepaidSchedule ? graceDays : 0,
      hotspotGraceEndsAt,
    };
  }

  toPublicContact(contact) {
    const result = this.hydrateContact(contact);
    delete result.mikrotikPassword;
    delete result.hotspotProvisioningPrevious;
    delete result.subscriptionChangedByArrears;
    delete result.arrearsSubscriptionDebtPeriods;
    delete result.prepaidReminderDeliveries;
    if (result.hotspotNotificationPending) {
      result.hotspotNotificationPending = {
        attempts: result.hotspotNotificationPending.attempts || 0,
        nextAttemptAt: result.hotspotNotificationPending.nextAttemptAt || null,
        lastError: result.hotspotNotificationPending.lastError || null,
      };
    }
    return result;
  }

  async normalizeReminderRelations() {
    let hasChanges = false;

    for (const reminder of this.reminders.values()) {
      const contact = this.getResolvedReminderContact(reminder);
      if (contact) {
        if (String(reminder.contactId || "") !== String(contact.id)) {
          reminder.contactId = String(contact.id);
          hasChanges = true;
        }
        if (reminder.phoneNumber !== contact.phoneNumber) {
          reminder.phoneNumber = contact.phoneNumber;
          hasChanges = true;
        }
        if (reminder.contactName !== contact.name) {
          reminder.contactName = contact.name;
          hasChanges = true;
        }
      }
    }

    if (hasChanges) {
      await this.saveReminders();
    }
  }

  async removeNonRecurringReminders() {
    const removed = [];
    for (const [id, reminder] of this.reminders.entries()) {
      const contact = this.getResolvedReminderContact(reminder);
      if (contact && !isRecurringSubscription(contact)) {
        this.reminders.delete(id);
        removed.push({ id, contactId: contact.id });
      }
    }
    if (removed.length > 0) {
      await this.saveReminders();
      this.activityLog.push("info", "storage", `${removed.length} reminder pelanggan sekali berlangganan dihapus dari jadwal aktif`, {
        removed,
      });
    }
    return removed.length;
  }

  async repairMissingRecurringReminders() {
    let created = 0;
    let updated = 0;
    let removed = 0;
    for (const contact of this.contacts.values()) {
      if (this.isReminderSuppressedForArrears(contact)) {
        removed += this.removeRemindersForContact(contact.id);
        continue;
      }

      const existing = Array.from(this.reminders.values()).find((reminder) => {
        const resolvedContact = this.getResolvedReminderContact(reminder);
        return String(resolvedContact?.id || reminder.contactId || "") === String(contact.id);
      });
      if (!existing) {
        if (this.ensureRecurringReminder(contact).created) created += 1;
        continue;
      }

      if (isPrepaidPackage(contact)) {
        if (!existing.processingAt) {
          updated += this.syncRecurringReminderSchedule(contact);
        }
        continue;
      }

      const serviceSchedule = this.normalizeOptionalDate(contact.hotspotReactivationAt);
      const reminderSchedule = this.normalizeOptionalDate(existing.reminderDateTime);
      const isTemporaryActivePeriod = existing.reminderKind === REMINDER_KINDS.ACTIVE_PERIOD_EXPIRY;
      if (isRecurringSubscription(contact)
        && !isTemporaryActivePeriod
        && serviceSchedule
        && reminderSchedule !== serviceSchedule) {
        updated += this.syncRecurringReminderSchedule(contact);
      }
    }
    if (created > 0 || updated > 0 || removed > 0) {
      await this.saveReminders();
      this.activityLog.push("info", "storage", "Jadwal reminder pelanggan bulanan diselaraskan", {
        created,
        updated,
        removed,
      });
    }
    return created;
  }

  isReminderSuppressedForArrears(contact) {
    return Boolean(contact)
      && this.buildDebtInfo(contact).debtCount >= BILLING_REMINDER_STOP_DEBT_COUNT;
  }

  removeRemindersForContact(contactId) {
    let removed = 0;
    for (const [id, reminder] of this.reminders.entries()) {
      const contact = this.getResolvedReminderContact(reminder);
      if (String(contact?.id || reminder.contactId || "") === String(contactId)) {
        this.reminders.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  async migrateReminderPaymentAmounts() {
    let contactsChanged = false;
    let remindersChanged = false;
    for (const reminder of this.reminders.values()) {
      const amount = Number(reminder.paymentAmount) || parsePaymentAmountFromMessage(reminder.message);
      const contact = this.getResolvedReminderContact(reminder);
      if (amount > 0 && !Number(reminder.paymentAmount)) {
        reminder.paymentAmount = amount;
        remindersChanged = true;
      }
      if (contact && amount > 0 && !Number(contact.monthlyPaymentAmount)) {
        contact.monthlyPaymentAmount = amount;
        contactsChanged = true;
      }
      if (contact && this.rewriteReminderPaymentMessage(reminder, contact)) {
        remindersChanged = true;
      }
    }
    for (const reminder of this.sentReminders.values()) {
      const amount = Number(reminder.paymentAmount) || parsePaymentAmountFromMessage(reminder.message);
      const contact = this.getResolvedReminderContact(reminder);
      if (amount > 0 && !Number(reminder.paymentAmount)) {
        reminder.paymentAmount = amount;
        remindersChanged = true;
      }
      if (contact && amount > 0 && !Number(contact.monthlyPaymentAmount)) {
        contact.monthlyPaymentAmount = amount;
        contactsChanged = true;
      }
    }
    if (contactsChanged) await this.saveContacts();
    if (remindersChanged) await this.saveReminders();
    if (remindersChanged) await this.saveSentReminders();
  }

  async migrateReminderVariableTemplates() {
    return this.withDataMutation(async () => {
      const settings = this.getSettings();
      if (Number(settings.reminderVariableTemplateMigrationVersion) >= 2) {
        return { migrated: 0, version: 2 };
      }

      let migrated = 0;
      for (const reminder of this.reminders.values()) {
        if (String(reminder.templateName || "").toLowerCase() !== "penagihan.txt") continue;
        reminder.messageSource = DEFAULT_REMINDER_MESSAGE_TEMPLATE;
        reminder.message = DEFAULT_REMINDER_MESSAGE_TEMPLATE;
        const contact = this.getResolvedReminderContact(reminder);
        if (contact) this.rewriteReminderPaymentMessage(reminder, contact);
        migrated += 1;
      }

      this.settings = {
        ...settings,
        reminderVariableTemplateMigrationVersion: 2,
      };
      await this.withDatabaseWrite(() => this.sequelize.transaction(async (transaction) => {
        const options = { transaction };
        if (migrated > 0) await this.saveReminders(options);
        await this.saveSettings(options);
      }));
      this.activityLog.push("info", "storage", `Template variabel diterapkan ke ${migrated} reminder aktif`, {
        migration: "reminder-variable-template-v2",
        migrated,
      });
      return { migrated, version: 2 };
    });
  }

  async migrateFormalNotificationTemplates() {
    return this.withDataMutation(async () => {
      const settings = this.getSettings();
      const currentVersion = Number(settings.notificationTemplateCopyMigrationVersion) || 0;
      if (currentVersion >= 6) {
        return { migrated: false, remindersUpdated: 0, version: 6 };
      }

      const templateKeys = [
        "apDownMessageTemplate",
        "customerAccountMessageTemplate",
        "billingReminderMessageTemplate",
        "paymentMessageTemplateArrearsOnly",
        "paymentMessageTemplateCurrentOnly",
        "paymentMessageTemplateFullPaid",
        "prepaidPackagePaymentMessageTemplate",
        "paymentHotspotAccountMessageTemplate",
        "prepaidPackageReminderMessageTemplate",
      ];
      this.settings = { ...settings };
      if (currentVersion < 2) {
        for (const key of templateKeys) {
          this.settings[key] = DEFAULT_SETTINGS[key];
        }
      }
      for (const [key, legacyTemplate] of Object.entries(LEGACY_NOTIFICATION_TEMPLATES_V3)) {
        if (this.settings[key] === legacyTemplate) {
          this.settings[key] = DEFAULT_SETTINGS[key];
        }
      }
      if (this.settings.billingReminderMessageTemplate
        === LEGACY_DETAILED_BILLING_REMINDER_MESSAGE_TEMPLATE_V4) {
        this.settings.billingReminderMessageTemplate =
          DETAILED_BILLING_REMINDER_MESSAGE_TEMPLATE;
      }
      if (this.settings.prepaidPackageReminderMessageTemplate
        === LEGACY_PREPAID_PACKAGE_REMINDER_MESSAGE_TEMPLATE_V5) {
        this.settings.prepaidPackageReminderMessageTemplate =
          DEFAULT_SETTINGS.prepaidPackageReminderMessageTemplate;
      }
      this.settings.notificationTemplateCopyMigrationVersion = 6;

      let remindersUpdated = 0;
      for (const reminder of this.reminders.values()) {
        const templateName = String(reminder.templateName || "").toLowerCase();
        const currentMessage = String(reminder.message || "");
        const currentSource = String(reminder.messageSource || "");
        let messageTemplate = null;
        const usesLegacyBillingCopy = [currentMessage, currentSource]
          .includes(LEGACY_DEFAULT_REMINDER_MESSAGE_TEMPLATE_V3);
        const usesLegacyGraceCopy = [currentMessage, currentSource]
          .includes(LEGACY_NOTIFICATION_TEMPLATES_V3.gracePeriodReminderMessageTemplate);
        if (templateName === "penagihan.txt"
          && (currentVersion < 2 || usesLegacyBillingCopy || usesLegacyGraceCopy)) {
          messageTemplate = usesLegacyGraceCopy
            ? DEFAULT_SETTINGS.gracePeriodReminderMessageTemplate
            : DEFAULT_REMINDER_MESSAGE_TEMPLATE;
        } else if (reminder.reminderKind === REMINDER_KINDS.ACTIVE_PERIOD_EXPIRY) {
          const legacyPrepaidCopy = [
            LEGACY_NOTIFICATION_TEMPLATES_V3.prepaidPackageReminderMessageTemplate,
            LEGACY_PREPAID_PACKAGE_REMINDER_MESSAGE_TEMPLATE_V5,
          ];
          if (currentVersion < 2 || legacyPrepaidCopy.includes(reminder.messageSource)
            || legacyPrepaidCopy.includes(reminder.message)) {
            messageTemplate = this.settings.prepaidPackageReminderMessageTemplate;
          }
        }
        if (!messageTemplate) continue;

        reminder.message = messageTemplate;
        reminder.messageSource = messageTemplate;
        const contact = this.getResolvedReminderContact(reminder);
        if (contact) this.rewriteReminderPaymentMessage(reminder, contact);
        remindersUpdated += 1;
      }

      await this.withDatabaseWrite(() => this.sequelize.transaction(async (transaction) => {
        const options = { transaction };
        await this.saveSettings(options);
        if (remindersUpdated > 0) await this.saveReminders(options);
      }));
      this.activityLog.push("info", "storage", "Template notifikasi diselaraskan dengan siklus pembayaran", {
        migration: "billing-cycle-notification-copy-v6",
        remindersUpdated,
      });
      return { migrated: true, remindersUpdated, version: 6 };
    });
  }

  async migrateExistingPaidServiceSchedules(options = {}) {
    return this.withDataMutation(async () => {
      const settings = this.getSettings();
      if (Number(settings.prepaidScheduleMigrationVersion) >= 3) {
        return {
          migrated: false,
          contactsUpdated: 0,
          remindersUpdated: 0,
          alreadyAligned: 0,
          skipped: 0,
          version: 3,
        };
      }

      let contactsUpdated = 0;
      let remindersUpdated = 0;
      let alreadyAligned = 0;
      let skipped = 0;
      const migrationTime = options.now ? new Date(options.now) : new Date();
      const updatedAt = Number.isNaN(migrationTime.getTime())
        ? new Date().toISOString()
        : migrationTime.toISOString();

      for (const contact of this.contacts.values()) {
        if (!isRecurringSubscription(contact)
          || parseBoolean(contact.billingPausedForArrears, false)) {
          skipped += 1;
          continue;
        }

        const latestPaidEntry = Object.entries(contact.paymentMonths || {})
          .filter(([period, payment]) => (
            /^\d{4}-\d{2}$/.test(period)
            && payment?.status === PAYMENT_STATUS.PAID
            && payment?.paidDate
            && !parseBoolean(payment?.billingPaused, false)
            && !Number.isNaN(new Date(payment.paidDate).getTime())
          ))
          .sort((left, right) => {
            const paidDateDifference = new Date(right[1].paidDate).getTime()
              - new Date(left[1].paidDate).getTime();
            return paidDateDifference || right[0].localeCompare(left[0]);
          })[0] || null;
        if (!latestPaidEntry || this.buildDebtInfo(contact).hasDebt) {
          skipped += 1;
          continue;
        }

        const [, payment] = latestPaidEntry;
        const expectedSchedule = addMonthsSafely(payment.paidDate, 1, this.getTimezone());
        if (!Number.isFinite(expectedSchedule.getTime())
          || expectedSchedule.getTime() <= migrationTime.getTime()) {
          skipped += 1;
          continue;
        }
        const currentSchedule = new Date(contact.hotspotReactivationAt || 0);
        const scheduleIsValid = Number.isFinite(currentSchedule.getTime());
        const scheduleAlreadyAdvanced = scheduleIsValid
          && currentSchedule.getTime() === expectedSchedule.getTime()
          && parseBoolean(contact.hotspotReactivationEnabled, false);

        if (scheduleAlreadyAdvanced) {
          alreadyAligned += 1;
        } else {
          contact.hotspotReactivationAt = expectedSchedule.toISOString();
          contact.hotspotReactivationEnabled = true;
          contact.hotspotManualActivationWithArrears = false;
          contact.updatedAt = updatedAt;
          contactsUpdated += 1;
        }
        const alignedSchedule = new Date(contact.hotspotReactivationAt || 0);
        if (Number.isFinite(alignedSchedule.getTime())
          && alignedSchedule.getTime() > migrationTime.getTime()) {
          remindersUpdated += this.syncRecurringReminderSchedule(contact);
        }
      }

      this.settings = {
        ...settings,
        prepaidScheduleMigrationVersion: 3,
      };
      await this.withDatabaseWrite(() => this.sequelize.transaction(async (transaction) => {
        const saveOptions = { transaction };
        if (contactsUpdated > 0) await this.saveContacts(saveOptions);
        if (remindersUpdated > 0) await this.saveReminders(saveOptions);
        await this.saveSettings(saveOptions);
      }));
      this.activityLog.push("info", "storage", "Jadwal pembayaran lama diselaraskan dengan sistem masa aktif", {
        migration: "prepaid-schedule-v3",
        contactsUpdated,
        remindersUpdated,
        alreadyAligned,
        skipped,
      });
      return {
        migrated: true,
        contactsUpdated,
        remindersUpdated,
        alreadyAligned,
        skipped,
        version: 3,
      };
    });
  }

  formatPaymentAmount(amount) {
    return new Intl.NumberFormat("id-ID", {
      style: "currency",
      currency: "IDR",
      maximumFractionDigits: 0,
    }).format(Math.max(0, Number(amount) || 0));
  }

  rewriteReminderPaymentMessage(reminder, contact) {
    const monthlyAmount = Math.max(0, Number(contact.monthlyPaymentAmount ?? reminder.paymentAmount) || 0);
    const sourceMessage = sanitizeMultilineText(reminder.messageSource || reminder.message);
    if (!sourceMessage) return false;
    let changed = false;
    if (!reminder.messageSource) {
      reminder.messageSource = sourceMessage;
      changed = true;
    }
    if (Number(reminder.paymentAmount) !== monthlyAmount) {
      reminder.paymentAmount = monthlyAmount;
      changed = true;
    }

    if (reminder.reminderKind === REMINDER_KINDS.ACTIVE_PERIOD_EXPIRY) {
      if (reminder.message !== sourceMessage) {
        reminder.message = sourceMessage;
        changed = true;
      }
      return changed;
    }

    const scheduledAt = new Date(reminder.reminderDateTime || Date.now());
    const periodDate = Number.isNaN(scheduledAt.getTime()) ? new Date() : scheduledAt;
    const debtInfo = this.buildDebtInfo(
      contact,
      getBillingPeriodParts(periodDate, this.getTimezone())
    );
    const debtCount = Math.max(0, Number(debtInfo.debtCount) || 0);
    const currentPaid = String(debtInfo.currentPaymentStatus || contact.paymentStatus || "UNPAID").toUpperCase() === PAYMENT_STATUS.PAID;
    const totalPeriods = (currentPaid ? 0 : 1) + debtCount;
    const currentAmount = currentPaid ? 0 : monthlyAmount;
    const totalAmount = currentAmount + Math.max(0, Number(debtInfo.debtAmount) || 0);
    const hasBillingVariables = /{{\s*(?:billingDetails|monthlyAmount|currentAmount|debtAmount|totalAmount|debtCount|debtPeriods|totalPeriods)\s*}}/i.test(sourceMessage);

    let nextMessage;
    if (totalPeriods <= 0) {
      nextMessage = `*Status pembayaran: LUNAS*\n\nSeluruh tagihan ${contact.name || "pelanggan"} sudah lunas. Reminder ini akan dilewati otomatis selama status pembayaran tetap lunas.`;
    } else if (monthlyAmount <= 0) {
      nextMessage = sourceMessage;
    } else if (hasBillingVariables) {
      nextMessage = sourceMessage;
    } else {
      const totalText = this.formatPaymentAmount(totalAmount);
      const amountPattern = /Rp\s*[0-9][0-9.]*(?:,[0-9]{1,2})?/i;
      nextMessage = amountPattern.test(sourceMessage)
        ? sourceMessage.replace(amountPattern, totalText).replace(/(Rp\s*[0-9][0-9.]*(?:,[0-9]{1,2})?)(?=[A-Za-z])/gi, "$1 ")
        : `${sourceMessage.trim()}\n\n*Total tagihan: ${totalText}*`;
    }

    if (nextMessage === reminder.message) return changed;
    reminder.message = nextMessage;
    return true;
  }

  updateContactReminderMessages(contact) {
    if (this.isReminderSuppressedForArrears(contact)) {
      return this.removeRemindersForContact(contact.id);
    }

    let changed = 0;
    let matched = false;
    for (const reminder of this.reminders.values()) {
      const resolvedContact = this.getResolvedReminderContact(reminder);
      if (!resolvedContact || String(resolvedContact.id) !== String(contact.id)) continue;
      matched = true;
      if (this.rewriteReminderPaymentMessage(reminder, contact)) {
        changed += 1;
      }
    }
    if (!matched && this.ensureRecurringReminder(contact).created) changed += 1;
    return changed;
  }

  advanceServiceScheduleAfterPayment(contact, options = {}) {
    if (!contact || !isRecurringSubscription(contact)) {
      return { changed: false, activeFrom: null, activeUntil: null };
    }

    const requestedAt = options.at ? new Date(options.at) : new Date();
    const paidAt = Number.isNaN(requestedAt.getTime()) ? new Date() : requestedAt;
    const billingPeriod = getContactBillingPeriod(
      contact,
      getBillingPeriodParts(paidAt, this.getTimezone())
    );
    const currentPeriod = options.paymentPeriodKey
      || makeBillingPeriodKey(billingPeriod.year, billingPeriod.month);
    const currentPayment = contact.paymentMonths?.[currentPeriod];
    if (currentPayment?.status !== PAYMENT_STATUS.PAID || this.buildDebtInfo(contact).hasDebt) {
      return { changed: false, activeFrom: null, activeUntil: null };
    }

    const activeFrom = paidAt;
    const activeUntil = addMonthsSafely(activeFrom, 1, this.getTimezone());
    const nextSchedule = activeUntil.toISOString();
    const changed = contact.hotspotReactivationAt !== nextSchedule
      || !parseBoolean(contact.hotspotReactivationEnabled, false);

    contact.hotspotReactivationAt = nextSchedule;
    contact.hotspotReactivationEnabled = true;
    contact.hotspotManualActivationWithArrears = false;
    return {
      changed,
      activeFrom: activeFrom.toISOString(),
      activeUntil: nextSchedule,
    };
  }

  syncRecurringReminderSchedule(contact) {
    if (!contact || !isRecurringSubscription(contact)) return 0;
    if (this.isReminderSuppressedForArrears(contact)) {
      return this.removeRemindersForContact(contact.id);
    }
    const reminderDateTime = this.normalizeOptionalDate(contact.hotspotReactivationAt);
    if (!reminderDateTime) {
      return isPrepaidPackage(contact) ? this.removeRemindersForContact(contact.id) : 0;
    }
    if (isPrepaidPackage(contact)) {
      const latestPurchase = Array.isArray(contact.activePeriodPurchases)
        ? contact.activePeriodPurchases.at(-1)
        : null;
      return this.syncActivePeriodExpiryReminder(contact, {
        purchasedAt: latestPurchase?.purchasedAt || contact.createdAt || new Date().toISOString(),
        activeUntil: reminderDateTime,
      }).changed;
    }

    const ensured = this.ensureRecurringReminder(contact);
    const reminder = ensured.reminder;
    if (!reminder || reminder.processingAt) return ensured.created ? 1 : 0;

    let changed = ensured.created ? 1 : 0;
    if (reminder.reminderDateTime !== reminderDateTime) {
      reminder.reminderDateTime = reminderDateTime;
      changed += 1;
    }
    if ([REMINDER_KINDS.ACTIVE_PERIOD_EXPIRY, REMINDER_KINDS.GRACE_PERIOD].includes(reminder.reminderKind)) {
      reminder.reminderKind = REMINDER_KINDS.BILLING;
      reminder.message = DEFAULT_REMINDER_MESSAGE_TEMPLATE;
      reminder.messageSource = DEFAULT_REMINDER_MESSAGE_TEMPLATE;
      reminder.templateName = "Penagihan.txt";
      delete reminder.activePeriodUntil;
      delete reminder.gracePeriodCreatedAt;
      changed += 1;
    }
    for (const field of [
      "nextDeliveryAttemptAt",
      "deliveryAttemptedAt",
      "lastDeliveryAttemptAt",
      "lastDeliveryError",
      "deliveryAttempts",
    ]) {
      if (!Object.hasOwn(reminder, field)) continue;
      delete reminder[field];
      changed += 1;
    }
    if (this.rewriteReminderPaymentMessage(reminder, contact)) changed += 1;
    return changed;
  }

  syncActiveRemindersWithSettings(settings = this.getSettings()) {
    let updated = 0;
    for (const reminder of this.reminders.values()) {
      if (reminder.processingAt || reminder.deliveryAttemptedAt) continue;
      const messageTemplate = getSettingsReminderTemplate(reminder, settings);
      if (messageTemplate === null) continue;
      if (reminder.messageSource === messageTemplate && reminder.message === messageTemplate) continue;

      reminder.messageSource = messageTemplate;
      reminder.message = messageTemplate;
      updated += 1;
    }
    return updated;
  }

  async syncActiveRemindersWithTemplates(templates) {
    const latestTemplates = new Map(
      (Array.isArray(templates) ? templates : [])
        .map((template) => [
          sanitizeInput(String(template?.name || "")).toLowerCase(),
          sanitizeMultilineText(template?.content),
        ])
        .filter(([name, content]) => name && content)
    );

    if (latestTemplates.size === 0) {
      return { matched: 0, updated: 0 };
    }

    return this.withDataMutation(async () => {
      let matched = 0;
      let updated = 0;

      for (const reminder of this.reminders.values()) {
        const templateName = sanitizeInput(String(reminder.templateName || "")).toLowerCase();
        const latestContent = latestTemplates.get(templateName);
        if (!latestContent) continue;
        matched += 1;

        if (sanitizeMultilineText(reminder.messageSource || reminder.message) === latestContent) continue;

        reminder.messageSource = latestContent;
        reminder.message = latestContent;
        const contact = this.getResolvedReminderContact(reminder);
        if (contact) this.rewriteReminderPaymentMessage(reminder, contact);
        updated += 1;
      }

      if (updated > 0) {
        await this.saveReminders();
        this.activityLog.push("info", "templates", `${updated} jadwal reminder disinkronkan dengan template terbaru`, {
          templates: Array.from(latestTemplates.keys()),
          matched,
          updated,
        });
      }

      return { matched, updated };
    });
  }

  ensureRecurringReminder(contact) {
    if (!contact || !isRecurringSubscription(contact)) {
      return { created: false, reminder: null };
    }
    if (this.isReminderSuppressedForArrears(contact)) {
      return { created: false, reminder: null, suppressed: true };
    }
    if (isPrepaidPackage(contact)) {
      const activeUntil = this.normalizeOptionalDate(contact.hotspotReactivationAt);
      if (!activeUntil) return { created: false, reminder: null };
      const latestPurchase = Array.isArray(contact.activePeriodPurchases)
        ? contact.activePeriodPurchases.at(-1)
        : null;
      const synced = this.syncActivePeriodExpiryReminder(contact, {
        purchasedAt: latestPurchase?.purchasedAt || contact.createdAt || new Date().toISOString(),
        activeUntil,
      });
      return { created: synced.created, reminder: synced.reminder };
    }

    const existing = Array.from(this.reminders.values()).find((reminder) => {
      const resolvedContact = this.getResolvedReminderContact(reminder);
      return String(resolvedContact?.id || reminder.contactId || "") === String(contact.id);
    });
    if (existing) return { created: false, reminder: existing };

    const reminderDateTime = this.normalizeOptionalDate(
      contact.hotspotReactivationAt || this.getNextServiceScheduleFromRegistration(contact)
    );
    if (!reminderDateTime) return { created: false, reminder: null };

    const reminder = {
      id: generateId(),
      contactId: String(contact.id),
      contactName: contact.name,
      phoneNumber: contact.phoneNumber,
      paymentAmount: Math.max(0, Number(contact.monthlyPaymentAmount) || 0),
      reminderDateTime,
      reminderKind: REMINDER_KINDS.BILLING,
      message: DEFAULT_REMINDER_MESSAGE_TEMPLATE,
      messageSource: DEFAULT_REMINDER_MESSAGE_TEMPLATE,
      templateName: "Penagihan.txt",
      createdAt: new Date().toISOString(),
    };
    this.rewriteReminderPaymentMessage(reminder, contact);
    this.reminders.set(String(reminder.id), reminder);
    this.activityLog.push("info", "billing", `Jadwal reminder otomatis dibuat untuk ${contact.name || contact.id}`, {
      contactId: contact.id,
      reminderId: reminder.id,
      reminderDateTime,
    });
    return { created: true, reminder };
  }

  getPrepaidReminderStageDetails(reminder) {
    const contact = this.getResolvedReminderContact(reminder);
    if (!contact || !isPrepaidPackage(contact)) return null;
    if (![REMINDER_KINDS.ACTIVE_PERIOD_EXPIRY, REMINDER_KINDS.GRACE_PERIOD]
      .includes(reminder?.reminderKind)) return null;

    const activeUntil = this.normalizeOptionalDate(
      reminder.activePeriodUntil || reminder.reminderDateTime
    );
    if (!activeUntil) return null;
    return {
      contact,
      activeUntil,
      stage: isGracePeriodReminder(reminder) ? "GRACE_PERIOD" : "EXPIRY",
    };
  }

  getPrepaidReminderStageByPeriod(contact, activeUntil, stage) {
    return contact?.prepaidReminderDeliveries?.[activeUntil]?.[stage] || null;
  }

  getPrepaidReminderStageRecord(reminder) {
    const details = this.getPrepaidReminderStageDetails(reminder);
    return details
      ? this.getPrepaidReminderStageByPeriod(details.contact, details.activeUntil, details.stage)
      : null;
  }

  recordPrepaidReminderStage(reminder, status, at = null) {
    const details = this.getPrepaidReminderStageDetails(reminder);
    if (!details) return false;

    const { contact, activeUntil, stage } = details;
    const previous = this.getPrepaidReminderStageByPeriod(contact, activeUntil, stage);
    const reminderId = String(reminder.sourceReminderId || reminder.id);
    if (previous && (previous.status !== "PROCESSING" || previous.reminderId !== reminderId)) {
      return false;
    }
    const nextStatus = String(status || "UNCONFIRMED").toUpperCase();
    if (previous?.status === nextStatus) return false;

    if (!contact.prepaidReminderDeliveries
      || typeof contact.prepaidReminderDeliveries !== "object"
      || Array.isArray(contact.prepaidReminderDeliveries)) {
      contact.prepaidReminderDeliveries = {};
    }
    contact.prepaidReminderDeliveries[activeUntil] = {
      ...contact.prepaidReminderDeliveries[activeUntil],
      [stage]: {
        status: nextStatus,
        reminderId,
        at: at || new Date().toISOString(),
      },
    };
    return true;
  }

  async restorePrepaidReminderDeliveryHistory() {
    return this.withDataMutation(async () => {
      let restored = 0;
      const history = Array.from(this.sentReminders.values())
        .sort((a, b) => new Date(a.sentAt || 0) - new Date(b.sentAt || 0));
      for (const reminder of history) {
        const status = String(reminder.deliveryStatus || "UNCONFIRMED").toUpperCase();
        if (this.recordPrepaidReminderStage(reminder, status, reminder.sentAt)) {
          restored += 1;
        }
      }
      if (restored > 0) await this.saveContacts();
      return restored;
    });
  }

  syncActivePeriodExpiryReminder(contact, purchase) {
    if (!contact || !purchase?.activeUntil) return { changed: 0, created: false, reminder: null };
    if (this.isReminderSuppressedForArrears(contact)) {
      const removed = this.removeRemindersForContact(contact.id);
      return { changed: removed, created: false, reminder: null, suppressed: true };
    }

    const activeUntil = new Date(purchase.activeUntil);
    const purchasedAt = new Date(purchase.purchasedAt || Date.now());
    if (Number.isNaN(activeUntil.getTime()) || Number.isNaN(purchasedAt.getTime())) {
      throw new Error("Jadwal reminder masa aktif tidak valid.");
    }

    const reminderDate = activeUntil;
    const periodUntil = activeUntil.toISOString();
    const expiryDelivery = this.getPrepaidReminderStageByPeriod(contact, periodUntil, "EXPIRY");
    const graceDelivery = this.getPrepaidReminderStageByPeriod(contact, periodUntil, "GRACE_PERIOD");
    const graceDays = sanitizePositiveInteger(
      this.getSettings().hotspotIsolationGraceDays,
      DEFAULT_SETTINGS.hotspotIsolationGraceDays,
      0,
      30
    );
    const existing = Array.from(this.reminders.values()).find((reminder) => {
      const resolvedContact = this.getResolvedReminderContact(reminder);
      return String(resolvedContact?.id || reminder.contactId || "") === String(contact.id)
        && !reminder.processingAt;
    });
    const samePeriod = Boolean(existing
      && this.normalizeOptionalDate(existing.activePeriodUntil || existing.reminderDateTime) === periodUntil);
    const graceCompleted = graceDelivery && graceDelivery.status !== "PROCESSING";
    const expiryCompleted = expiryDelivery && expiryDelivery.status !== "PROCESSING";

    if (samePeriod && (graceCompleted || (graceDays === 0 && expiryCompleted))) {
      this.reminders.delete(String(existing.id));
      return { changed: 1, created: false, reminder: null };
    }
    if (!existing && (graceDelivery || (expiryDelivery && (graceDays === 0 || !expiryCompleted)))) {
      return { changed: 0, created: false, reminder: null };
    }

    const created = !existing;
    const previousState = existing ? JSON.stringify(existing) : null;
    const preserveGracePeriod = Boolean(
      (samePeriod && existing.reminderKind === REMINDER_KINDS.ACTIVE_PERIOD_EXPIRY
        && isGracePeriodReminder(existing)) || (expiryCompleted && graceDays > 0)
    );
    const reminder = existing || {
      id: generateId(),
      contactId: String(contact.id),
      contactName: contact.name,
      phoneNumber: contact.phoneNumber,
      createdAt: new Date().toISOString(),
    };
    const messageTemplate = sanitizeMultilineText(this.getSettings().prepaidPackageReminderMessageTemplate)
      || DEFAULT_SETTINGS.prepaidPackageReminderMessageTemplate;

    Object.assign(reminder, {
      contactId: String(contact.id),
      contactName: contact.name,
      phoneNumber: contact.phoneNumber,
      paymentAmount: Math.max(0, Number(contact.monthlyPaymentAmount) || 0),
      reminderDateTime: reminderDate.toISOString(),
      reminderKind: REMINDER_KINDS.ACTIVE_PERIOD_EXPIRY,
      activePeriodUntil: activeUntil.toISOString(),
      message: messageTemplate,
      messageSource: messageTemplate,
      templateName: "PaketPrabayar",
    });
    if (!samePeriod) {
      delete reminder.nextDeliveryAttemptAt;
      delete reminder.deliveryAttemptedAt;
      delete reminder.lastDeliveryAttemptAt;
      delete reminder.lastDeliveryError;
      delete reminder.deliveryAttempts;
      delete reminder.whatsappProvider;
      delete reminder.providerMessageId;
      delete reminder.providerStatus;
      delete reminder.providerError;
    }
    if (preserveGracePeriod) {
      reminder.gracePeriodCreatedAt = reminder.gracePeriodCreatedAt
        || expiryDelivery?.at || new Date().toISOString();
    } else {
      delete reminder.gracePeriodCreatedAt;
    }
    this.rewriteReminderPaymentMessage(reminder, contact);
    this.reminders.set(String(reminder.id), reminder);
    const changed = created || previousState !== JSON.stringify(reminder);
    if (changed) {
      this.activityLog.push("info", "billing", `Reminder masa aktif diselaraskan untuk ${contact.name || contact.id}`, {
        contactId: contact.id,
        reminderId: reminder.id,
        reminderDateTime: reminder.reminderDateTime,
        activeUntil: reminder.activePeriodUntil,
        created,
      });
    }
    return { changed: changed ? 1 : 0, created, reminder };
  }

  restoreBillingReminderAfterActivePeriod(contact) {
    if (!contact) return 0;
    if (this.isReminderSuppressedForArrears(contact)) {
      return this.removeRemindersForContact(contact.id);
    }
    const reminderDateTime = this.normalizeOptionalDate(
      contact.hotspotReactivationAt || this.getNextServiceScheduleFromRegistration(contact)
    );
    if (!reminderDateTime) return 0;

    let changed = 0;
    for (const reminder of this.reminders.values()) {
      const resolvedContact = this.getResolvedReminderContact(reminder);
      if (String(resolvedContact?.id || reminder.contactId || "") !== String(contact.id)) continue;
      if (reminder.reminderKind !== REMINDER_KINDS.ACTIVE_PERIOD_EXPIRY) continue;

      reminder.reminderDateTime = reminderDateTime;
      reminder.reminderKind = REMINDER_KINDS.BILLING;
      reminder.message = DEFAULT_REMINDER_MESSAGE_TEMPLATE;
      reminder.messageSource = DEFAULT_REMINDER_MESSAGE_TEMPLATE;
      reminder.templateName = "Penagihan.txt";
      delete reminder.activePeriodUntil;
      delete reminder.nextDeliveryAttemptAt;
      delete reminder.deliveryAttemptedAt;
      delete reminder.lastDeliveryAttemptAt;
      delete reminder.lastDeliveryError;
      delete reminder.deliveryAttempts;
      this.rewriteReminderPaymentMessage(reminder, contact);
      changed += 1;
    }
    return changed;
  }

  async savePaymentAndReminderChanges(remindersChanged) {
    if (!remindersChanged) {
      await this.saveContacts();
      return;
    }

    await this.withDatabaseWrite(() => this.sequelize.transaction(async (transaction) => {
      const options = { transaction };
      await this.saveContacts(options);
      await this.saveReminders(options);
    }));
  }

  async addContact(payload) {
    return this.withDataMutation(async () => {
      const name = sanitizeInput(payload.name);
      const phoneNumber = normalizePhoneNumber(payload.phoneNumber);
      const linkedApHost = sanitizeInput(String(payload.linkedApHost || ""));
      const subscriptionType = SUBSCRIPTION_TYPES.RECURRING;
      const billingCycle = BILLING_CYCLES.PREPAID;
      const hotspotFields = this.normalizeContactHotspotFields({ ...payload, subscriptionType });

      if (!name) throw new Error("Nama kontak wajib diisi.");
      if (!isValidPhoneNumber(phoneNumber)) throw new Error("Nomor kontak harus berformat 628xxx.");
      if (this.hasContactPhone(phoneNumber)) throw new Error("Nomor kontak sudah digunakan.");

      const now = new Date().toISOString();
      const initialServiceSchedule = addMonthsSafely(now, 1, this.getTimezone()).toISOString();
      const { year: initialYear, month: initialMonth } = getBillingPeriodParts(new Date(now), this.getTimezone());
      const initialPeriod = makeBillingPeriodKey(initialYear, initialMonth);
      const prepaidPackage = true;
      const monthlyPaymentAmount = sanitizePositiveInteger(payload.monthlyPaymentAmount, 0, 0, 1_000_000_000);
      const contact = {
        id: generateId(),
        name,
        phoneNumber,
        monthlyPaymentAmount,
        monthlyPaymentAmountCustomized: payload.monthlyPaymentAmount !== undefined,
        subscriptionType,
        billingCycle,
        subscriptionChangedByArrears: false,
        arrearsSubscriptionDebtPeriods: [],
        billingPausedForArrears: false,
        billingPausedAfterPeriod: null,
        hotspotSuspendedForArrears: false,
        hotspotManualActivationWithArrears: false,
        activePeriodPurchases: prepaidPackage && monthlyPaymentAmount > 0 ? [{
          id: `REG-${Date.now()}`,
          paymentType: PAYMENT_TYPES.ACTIVE_PERIOD,
          status: PAYMENT_STATUS.PAID,
          amount: monthlyPaymentAmount,
          purchasedAt: now,
          activeFrom: now,
          activeUntil: initialServiceSchedule,
          paymentProvider: "manual",
        }] : [],
        paymentStatus: PAYMENT_STATUS.PAID,
        paymentDate: now,
        paymentType: PAYMENT_TYPES.ACTIVE_PERIOD,
        paymentMonths: {
          [initialPeriod]: { status: PAYMENT_STATUS.PAID, paidDate: now, paymentType: PAYMENT_TYPES.ACTIVE_PERIOD },
        },
        linkedApHost,
        ...hotspotFields,
        hotspotReactivationEnabled: true,
        hotspotReactivationAt: initialServiceSchedule,
        hotspotLastReactivatedAt: this.normalizeOptionalDate(payload.hotspotLastReactivatedAt),
        hotspotLastDeactivatedAt: this.normalizeOptionalDate(payload.hotspotLastDeactivatedAt),
        createdAt: now,
        updatedAt: now,
      };
      this.applyProfileMonthlyAmount(contact);

      this.contacts.set(contact.id, contact);
      const reminderCreated = this.ensureRecurringReminder(contact).created;
      await this.synchronizeCustomerPortalAccounts({ save: false });
      if (this.sequelize) {
        await this.withDatabaseWrite(() => this.sequelize.transaction(async (transaction) => {
          const options = { transaction };
          await this.saveContacts(options);
          await this.savePelanggan(options);
          await this.saveCustomerAccounts(options);
          if (reminderCreated) await this.saveReminders(options);
        }));
      } else {
        await this.saveContacts();
        if (reminderCreated) await this.saveReminders();
      }
      return contact;
    });
  }

  async upsertPelangganFromRegistration(payload) {
    return this.withDataMutation(async () => {
      const name = sanitizeInput(payload.name);
      const phoneNumber = normalizePhoneNumber(payload.phoneNumber);
      const username = sanitizeInput(payload.username);
      const profile = sanitizeInput(payload.profile);
      const password = sanitizeInput(payload.password);

      if (!name) throw new Error("Nama pelanggan wajib diisi.");
      if (!username) throw new Error("Username hotspot wajib diisi.");
      if (!isValidPhoneNumber(phoneNumber)) throw new Error("Nomor pelanggan harus berformat 628xxx.");
      if (!profile) throw new Error("Profile hotspot wajib diisi.");
      if (!password) throw new Error("Password hotspot wajib diisi.");

      const provisioningStatus = normalizeHotspotProvisioningStatus(
        payload.hotspotProvisioningStatus,
        HOTSPOT_PROVISIONING_STATUS.ACTIVE
      );
      const provisioningError = provisioningStatus === HOTSPOT_PROVISIONING_STATUS.ACTIVE
        ? ""
        : sanitizeInput(String(payload.hotspotProvisioningError || ""));
      const hotspotLastCheckedAt = this.normalizeOptionalDate(payload.hotspotLastCheckedAt);
      const hotspotLastSyncedAt = this.normalizeOptionalDate(payload.hotspotLastSyncedAt);
      const provisioningOperation = normalizeHotspotProvisioningOperation(
        payload.hotspotProvisioningOperation,
        provisioningStatus === HOTSPOT_PROVISIONING_STATUS.ACTIVE
          ? HOTSPOT_PROVISIONING_OPERATION.NONE
          : HOTSPOT_PROVISIONING_OPERATION.CREATE
      );

      const now = new Date().toISOString();
      const initialServiceSchedule = addMonthsSafely(now, 1, this.getTimezone()).toISOString();
      const { year: initialYear, month: initialMonth } = getBillingPeriodParts(new Date(now), this.getTimezone());
      const initialPeriod = makeBillingPeriodKey(initialYear, initialMonth);
      let contact = this.findContactByPhone(phoneNumber);
      let reminderMessagesChanged = 0;
      const usernameOwner = this.pelanggan.get(username);
      if (usernameOwner
        && String(usernameOwner.contactId || "") !== String(contact?.id || "")
        && normalizePhoneNumber(usernameOwner.nomer) !== phoneNumber) {
        throw new Error(`Username hotspot "${username}" sudah terhubung ke pelanggan lain.`);
      }
      const linkedApHost = payload.linkedApHost !== undefined
        ? sanitizeInput(String(payload.linkedApHost || ""))
        : sanitizeInput(String(contact?.linkedApHost || ""));
      const hotspotFields = this.normalizeContactHotspotFields({
        ...payload,
        subscriptionType: SUBSCRIPTION_TYPES.RECURRING,
        mikrotikUsername: username,
        mikrotikProfile: profile,
        mikrotikPassword: password,
      }, contact || {});

      if (!contact) {
        const subscriptionType = SUBSCRIPTION_TYPES.RECURRING;
        const billingCycle = BILLING_CYCLES.PREPAID;
        const prepaidPackage = true;
        contact = {
          id: String(generateId()),
          name,
          phoneNumber,
          monthlyPaymentAmount: sanitizePositiveInteger(payload.monthlyPaymentAmount, 0, 0, 1_000_000_000),
          monthlyPaymentAmountCustomized: payload.monthlyPaymentAmount !== undefined,
          subscriptionType,
          billingCycle,
          subscriptionChangedByArrears: false,
          arrearsSubscriptionDebtPeriods: [],
          billingPausedForArrears: false,
          billingPausedAfterPeriod: null,
          hotspotSuspendedForArrears: false,
          hotspotManualActivationWithArrears: false,
          activePeriodPurchases: [],
          paymentStatus: PAYMENT_STATUS.PAID,
          paymentDate: now,
          paymentType: PAYMENT_TYPES.ACTIVE_PERIOD,
          paymentMonths: {
            [initialPeriod]: { status: PAYMENT_STATUS.PAID, paidDate: now, paymentType: PAYMENT_TYPES.ACTIVE_PERIOD },
          },
          linkedApHost,
          ...hotspotFields,
          hotspotReactivationEnabled: true,
          hotspotReactivationAt: initialServiceSchedule,
          hotspotProvisioningStatus: provisioningStatus,
          hotspotProvisioningError: provisioningError,
          hotspotLastCheckedAt,
          hotspotLastSyncedAt,
          hotspotSendCredentials: parseBoolean(payload.sendCredentials, false),
          hotspotProvisioningOperation: provisioningOperation,
          hotspotProvisioningPrevious: null,
          hotspotLastReactivatedAt: null,
          hotspotLastDeactivatedAt: null,
          createdAt: now,
          updatedAt: now,
        };
        this.applyProfileMonthlyAmount(contact);
        if (prepaidPackage && Number(contact.monthlyPaymentAmount) > 0) {
          contact.activePeriodPurchases.push({
            id: `REG-${Date.now()}`,
            paymentType: PAYMENT_TYPES.ACTIVE_PERIOD,
            status: PAYMENT_STATUS.PAID,
            amount: Math.floor(Number(contact.monthlyPaymentAmount)),
            purchasedAt: now,
            activeFrom: now,
            activeUntil: initialServiceSchedule,
            paymentProvider: "manual",
          });
        }
        this.contacts.set(contact.id, contact);
      } else {
        contact.name = name;
        const previousSubscriptionType = contact.subscriptionType;
        contact.subscriptionType = SUBSCRIPTION_TYPES.RECURRING;
        contact.billingCycle = BILLING_CYCLES.PREPAID;
        contact.linkedApHost = linkedApHost;
        if (payload.monthlyPaymentAmount !== undefined) {
          contact.monthlyPaymentAmount = sanitizePositiveInteger(
            payload.monthlyPaymentAmount,
            Number(contact.monthlyPaymentAmount) || 0,
            0,
            1_000_000_000
          );
          contact.monthlyPaymentAmountCustomized = true;
        }
        Object.assign(contact, hotspotFields);
        const subscriptionTransition = previousSubscriptionType !== contact.subscriptionType
          ? this.applySubscriptionTypeTransition(
              contact,
              previousSubscriptionType,
              contact.subscriptionType,
              new Date(now)
            )
          : { changed: false, startedRecurring: false };
        if (!subscriptionTransition.startedRecurring && !contact.hotspotReactivationAt) {
          contact.hotspotReactivationAt = this.getNextServiceScheduleFromRegistration(contact);
          contact.hotspotReactivationEnabled = isRecurringSubscription(contact);
        }
        if (this.applyProfileMonthlyAmount(contact)) {
          reminderMessagesChanged = this.updateContactReminderMessages(contact);
        }
        contact.hotspotProvisioningStatus = provisioningStatus;
        contact.hotspotProvisioningError = provisioningError;
        contact.hotspotLastCheckedAt = hotspotLastCheckedAt;
        contact.hotspotLastSyncedAt = hotspotLastSyncedAt;
        contact.hotspotProvisioningOperation = provisioningOperation;
        contact.hotspotProvisioningPrevious = null;
        if (payload.sendCredentials !== undefined) {
          contact.hotspotSendCredentials = parseBoolean(payload.sendCredentials, false);
        }
        contact.updatedAt = now;
      }

      const previous = this.pelanggan.get(username) || {};
      for (const [storedUsername, storedPelanggan] of this.pelanggan.entries()) {
        if (storedUsername !== username
          && String(storedPelanggan.contactId || "") === String(contact.id)) {
          this.pelanggan.delete(storedUsername);
        }
      }
      const pelanggan = {
        ...previous,
        username,
        nama: name,
        nomer: phoneNumber,
        profile,
        password,
        contactId: contact.id,
        status: provisioningStatus === HOTSPOT_PROVISIONING_STATUS.ACTIVE
          ? "verified"
          : provisioningStatus.toLowerCase(),
        hotspotProvisioningStatus: provisioningStatus,
        hotspotProvisioningError: provisioningError,
        hotspotLastCheckedAt,
        hotspotLastSyncedAt,
        hotspotSendCredentials: parseBoolean(
          payload.sendCredentials,
          contact.hotspotSendCredentials
        ),
        tanggalDaftar: previous.tanggalDaftar || now,
        tanggalUpdate: now,
      };

      this.pelanggan.set(username, pelanggan);
      const reminderCreated = this.ensureRecurringReminder(contact).created;
      await this.synchronizeCustomerPortalAccounts({ save: false });
      await this.withDatabaseWrite(() => this.sequelize.transaction(async (transaction) => {
        const options = { transaction };
        await this.saveContacts(options);
        await this.savePelanggan(options);
        await this.saveCustomerAccounts(options);
        if (reminderCreated || reminderMessagesChanged > 0) {
          await this.saveReminders(options);
        }
      }));
      return { contact, pelanggan };
    });
  }

  async prepareHotspotRegistration(payload) {
    const name = sanitizeInput(payload.name);
    const phoneNumber = normalizePhoneNumber(payload.phoneNumber);
    const profile = sanitizeInput(payload.profile);
    const username = formatUsernameFromName(name);
    const password = phoneNumber.slice(-5);

    if (!name) throw new Error("Nama pelanggan wajib diisi.");
    if (!isValidPhoneNumber(phoneNumber)) throw new Error("Nomor pelanggan harus berformat 628xxx.");
    if (!profile) throw new Error("Profile hotspot wajib dipilih.");
    if (!username) throw new Error("Nama pelanggan tidak bisa dijadikan username hotspot.");

    return this.upsertPelangganFromRegistration({
      ...payload,
      name,
      phoneNumber,
      username,
      password,
      profile,
      hotspotProvisioningStatus: HOTSPOT_PROVISIONING_STATUS.PENDING,
      hotspotProvisioningOperation: HOTSPOT_PROVISIONING_OPERATION.CREATE,
      hotspotProvisioningError: "",
      hotspotLastCheckedAt: null,
      hotspotLastSyncedAt: null,
    });
  }

  async updateHotspotProvisioningStatus(contactId, status, options = {}) {
    return this.withDataMutation(async () => {
      const contact = this.getContact(contactId);
      if (!contact) throw new Error("Kontak tidak ditemukan.");

      const normalizedStatus = normalizeHotspotProvisioningStatus(status, "");
      if (!normalizedStatus) throw new Error("Status provisioning hotspot tidak valid.");

      const now = new Date().toISOString();
      const errorMessage = normalizedStatus === HOTSPOT_PROVISIONING_STATUS.ACTIVE
        ? ""
        : sanitizeInput(String(Object.hasOwn(options, "error")
          ? options.error
          : contact.hotspotProvisioningError || ""));
      const checkedAt = options.checkedAt !== undefined
        ? this.normalizeOptionalDate(options.checkedAt)
        : (normalizedStatus === HOTSPOT_PROVISIONING_STATUS.ACTIVE ? now : contact.hotspotLastCheckedAt || null);
      const syncedAt = options.syncedAt !== undefined
        ? this.normalizeOptionalDate(options.syncedAt)
        : (normalizedStatus === HOTSPOT_PROVISIONING_STATUS.ACTIVE ? now : contact.hotspotLastSyncedAt || null);

      contact.hotspotProvisioningStatus = normalizedStatus;
      contact.hotspotProvisioningError = errorMessage;
      contact.hotspotLastCheckedAt = checkedAt;
      contact.hotspotLastSyncedAt = syncedAt;
      if ([HOTSPOT_PROVISIONING_STATUS.ACTIVE, HOTSPOT_PROVISIONING_STATUS.DEACTIVATED, HOTSPOT_PROVISIONING_STATUS.DISABLED]
        .includes(normalizedStatus)) {
        contact.hotspotProvisioningOperation = HOTSPOT_PROVISIONING_OPERATION.NONE;
        contact.hotspotProvisioningPrevious = null;
      }
      contact.updatedAt = now;

      let pelanggan = this.pelanggan.get(contact.mikrotikUsername) || null;
      if (!pelanggan) {
        pelanggan = Array.from(this.pelanggan.values()).find(
          (item) => String(item.contactId || "") === String(contact.id)
        ) || null;
      }
      if (pelanggan) {
        pelanggan.status = normalizedStatus === HOTSPOT_PROVISIONING_STATUS.ACTIVE
          ? "verified"
          : normalizedStatus.toLowerCase();
        pelanggan.hotspotProvisioningStatus = normalizedStatus;
        pelanggan.hotspotProvisioningError = errorMessage;
        pelanggan.hotspotLastCheckedAt = checkedAt;
        pelanggan.hotspotLastSyncedAt = syncedAt;
        pelanggan.tanggalUpdate = now;
      }

      await this.withDatabaseWrite(() => this.sequelize.transaction(async (transaction) => {
        const saveOptions = { transaction };
        await this.saveContacts(saveOptions);
        await this.savePelanggan(saveOptions);
      }));
      return { contact, pelanggan };
    });
  }

  async prepareContactUpdate(id, payload) {
    return this.withDataMutation(async () => {
      const contact = this.getContact(id);
      if (!contact) throw new Error("Kontak tidak ditemukan.");
      const previousPhone = contact.phoneNumber;
      const previousHotspot = {
        username: sanitizeInput(String(contact.mikrotikUsername || "")),
        profile: sanitizeInput(String(contact.mikrotikProfile || "")),
        password: sanitizeInput(String(contact.mikrotikPassword || "")),
        phoneNumber: previousPhone,
      };

      const nextName = payload.name !== undefined ? sanitizeInput(payload.name) : contact.name;
      const nextPhone = payload.phoneNumber !== undefined ? normalizePhoneNumber(payload.phoneNumber) : contact.phoneNumber;
      const nextLinkedApHost = payload.linkedApHost !== undefined
        ? sanitizeInput(String(payload.linkedApHost || ""))
        : sanitizeInput(String(contact.linkedApHost || ""));
      const nextSubscriptionType = SUBSCRIPTION_TYPES.RECURRING;
      const nextBillingCycle = BILLING_CYCLES.PREPAID;
      const nextUsername = payload.mikrotikUsername !== undefined
        ? sanitizeInput(String(payload.mikrotikUsername || ""))
        : previousHotspot.username;
      const nextProfile = payload.mikrotikProfile !== undefined
        ? sanitizeInput(String(payload.mikrotikProfile || ""))
        : previousHotspot.profile;
      const requestedPassword = payload.mikrotikPassword !== undefined
        ? sanitizeInput(String(payload.mikrotikPassword || ""))
        : previousHotspot.password;
      const nextPassword = requestedPassword || ((nextUsername && nextProfile) ? nextPhone.slice(-5) : "");

      if (!nextName) throw new Error("Nama kontak wajib diisi.");
      if (!isValidPhoneNumber(nextPhone)) throw new Error("Nomor kontak harus berformat 628xxx.");
      if (this.hasContactPhone(nextPhone, id)) throw new Error("Nomor kontak sudah digunakan.");
      if (nextUsername && this.hasContactHotspotUsername(nextUsername, id)) {
        throw new Error(`Username hotspot "${nextUsername}" sudah terhubung ke pelanggan lain.`);
      }
      if (Boolean(nextUsername) !== Boolean(nextProfile)) {
        throw new Error("Username dan profile hotspot harus diisi bersamaan.");
      }

      const hotspotFields = this.normalizeContactHotspotFields({
        ...payload,
        subscriptionType: nextSubscriptionType,
        mikrotikUsername: nextUsername,
        mikrotikProfile: nextProfile,
        mikrotikPassword: nextPassword,
      }, contact);
      const phoneChanged = nextPhone !== previousPhone;
      const hotspotChanged = previousHotspot.username !== nextUsername
        || previousHotspot.profile !== nextProfile
        || previousHotspot.password !== nextPassword
        || (phoneChanged && Boolean(previousHotspot.username || nextUsername));
      const unlinked = !nextUsername && !nextProfile;
      const previousSubscriptionType = contact.subscriptionType;
      const previousBillingCycle = normalizeBillingCycle(contact.billingCycle);
      const subscriptionTypeChanged = nextSubscriptionType !== previousSubscriptionType;
      const billingCycleChanged = nextBillingCycle !== previousBillingCycle;
      let hotspotSyncRequired = false;
      const transitionAt = new Date();
      const now = transitionAt.toISOString();

      contact.name = nextName;
      contact.phoneNumber = nextPhone;
      contact.linkedApHost = nextLinkedApHost;
      contact.subscriptionType = nextSubscriptionType;
      contact.billingCycle = nextBillingCycle;
      if (!isRecurringSubscription(contact)) this.removeRemindersForContact(contact.id);
      if (payload.monthlyPaymentAmount !== undefined) {
        contact.monthlyPaymentAmount = sanitizePositiveInteger(
          payload.monthlyPaymentAmount,
          Number(contact.monthlyPaymentAmount) || 0,
          0,
          1_000_000_000
        );
        contact.monthlyPaymentAmountCustomized = true;
      }
      Object.assign(contact, hotspotFields);
      if (subscriptionTypeChanged) {
        this.applySubscriptionTypeTransition(
          contact,
          previousSubscriptionType,
          nextSubscriptionType,
          transitionAt
        );
      }
      if (billingCycleChanged) {
        if (isPrepaidPackage(contact)) {
          contact.billingPausedForArrears = false;
          contact.billingPausedAfterPeriod = null;
          contact.hotspotSuspendedForArrears = false;
          contact.hotspotManualActivationWithArrears = false;
          const packageState = this.buildDebtInfo(contact, { at: transitionAt });
          contact.paymentStatus = packageState.currentPaymentStatus;
          contact.paymentDate = packageState.packageActive ? contact.paymentDate || now : null;
          contact.paymentType = packageState.packageActive ? PAYMENT_TYPES.ACTIVE_PERIOD : null;
        } else {
          const referencePeriod = getBillingPeriodParts(transitionAt, this.getTimezone());
          const billingPeriod = getContactBillingPeriod(contact, referencePeriod);
          const billingKey = makeBillingPeriodKey(billingPeriod.year, billingPeriod.month);
          const billingStarted = compareBillingPeriods(
            getContactBillingStartPeriod(contact, this.getTimezone()),
            billingPeriod
          ) <= 0;
          const payment = contact.paymentMonths?.[billingKey] || null;
          const paid = payment?.status === PAYMENT_STATUS.PAID;
          contact.paymentStatus = paid ? PAYMENT_STATUS.PAID : PAYMENT_STATUS.UNPAID;
          contact.paymentDate = paid && billingStarted ? payment?.paidDate || null : null;
          contact.paymentType = paid && billingStarted ? payment?.paymentType || null : null;
        }
      }
      if (this.applyProfileMonthlyAmount(contact)) this.updateContactReminderMessages(contact);

      if (unlinked) {
        contact.mikrotikPassword = "";
        contact.hotspotProvisioningStatus = HOTSPOT_PROVISIONING_STATUS.NONE;
        contact.hotspotProvisioningError = "";
        contact.hotspotProvisioningOperation = HOTSPOT_PROVISIONING_OPERATION.NONE;
        contact.hotspotProvisioningPrevious = null;
        contact.hotspotLastCheckedAt = null;
        contact.hotspotLastSyncedAt = null;
        contact.hotspotSuspendedForArrears = false;
        contact.hotspotManualActivationWithArrears = false;
      } else if (hotspotChanged) {
        const currentOperation = normalizeHotspotProvisioningOperation(
          contact.hotspotProvisioningOperation,
          HOTSPOT_PROVISIONING_OPERATION.NONE
        );
        let provisioningPrevious = null;
        if (currentOperation === HOTSPOT_PROVISIONING_OPERATION.UPDATE
          && contact.hotspotProvisioningPrevious?.username) {
          provisioningPrevious = { ...contact.hotspotProvisioningPrevious };
        } else if (currentOperation !== HOTSPOT_PROVISIONING_OPERATION.CREATE
          && normalizeHotspotProvisioningStatus(contact.hotspotProvisioningStatus) === HOTSPOT_PROVISIONING_STATUS.ACTIVE
          && previousHotspot.username) {
          provisioningPrevious = previousHotspot;
        }

        contact.hotspotProvisioningStatus = HOTSPOT_PROVISIONING_STATUS.PENDING;
        contact.hotspotProvisioningError = "";
        contact.hotspotProvisioningOperation = provisioningPrevious
          ? HOTSPOT_PROVISIONING_OPERATION.UPDATE
          : HOTSPOT_PROVISIONING_OPERATION.CREATE;
        contact.hotspotProvisioningPrevious = provisioningPrevious;
        hotspotSyncRequired = true;
      }
      contact.updatedAt = now;

      if (isRecurringSubscription(contact)) {
        this.syncRecurringReminderSchedule(contact);
      }

      for (const reminder of this.reminders.values()) {
        if (String(reminder.contactId) === String(id) || reminder.phoneNumber === previousPhone) {
          reminder.contactId = String(contact.id);
          reminder.phoneNumber = contact.phoneNumber;
          reminder.contactName = contact.name;
        }
      }

      let pelanggan = this.pelanggan.get(previousHotspot.username) || Array.from(this.pelanggan.values()).find(
        (item) => String(item.contactId || "") === String(contact.id)
      ) || null;
      for (const [storedUsername, storedPelanggan] of this.pelanggan.entries()) {
        if (String(storedPelanggan.contactId || "") === String(contact.id)) {
          this.pelanggan.delete(storedUsername);
        }
      }
      if (!unlinked) {
        pelanggan = {
          ...(pelanggan || {}),
          username: nextUsername,
          nama: nextName,
          nomer: nextPhone,
          profile: nextProfile,
          password: nextPassword,
          contactId: contact.id,
          status: contact.hotspotProvisioningStatus === HOTSPOT_PROVISIONING_STATUS.ACTIVE
            ? "verified"
            : String(contact.hotspotProvisioningStatus || HOTSPOT_PROVISIONING_STATUS.PENDING).toLowerCase(),
          hotspotProvisioningStatus: contact.hotspotProvisioningStatus,
          hotspotProvisioningError: contact.hotspotProvisioningError || "",
          hotspotLastCheckedAt: contact.hotspotLastCheckedAt || null,
          hotspotLastSyncedAt: contact.hotspotLastSyncedAt || null,
          tanggalDaftar: pelanggan?.tanggalDaftar || contact.createdAt || now,
          tanggalUpdate: now,
        };
        this.pelanggan.set(nextUsername, pelanggan);
      } else {
        pelanggan = null;
      }

      await this.synchronizeCustomerPortalAccounts({ save: false });
      await this.withDatabaseWrite(() => this.sequelize.transaction(async (transaction) => {
        const options = { transaction };
        await this.saveContacts(options);
        await this.savePelanggan(options);
        await this.saveCustomerAccounts(options);
        await this.saveReminders(options);
      }));
      return { contact, pelanggan, hotspotSyncRequired };
    });
  }

  async updateContact(id, payload) {
    const result = await this.prepareContactUpdate(id, payload);
    return result.contact;
  }

  async updateContactPaymentAmount(id, amount, options = {}) {
    return this.withDataMutation(async () => {
      const contact = this.getContact(id);
      if (!contact) throw new Error("Kontak tidak ditemukan.");
      if (options.useProfileDefault) {
        const profileAmount = this.getProfileMonthlyAmount(contact.mikrotikProfile);
        if (profileAmount === null) {
          throw new Error(`Tarif profile "${contact.mikrotikProfile || "MikroTik"}" belum diatur.`);
        }
        contact.monthlyPaymentAmount = profileAmount;
        contact.monthlyPaymentAmountCustomized = false;
      } else {
        const parsed = Number(amount);
        if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1_000_000_000) {
          throw new Error("Nominal pembayaran harus antara 0 sampai 1 miliar.");
        }
        contact.monthlyPaymentAmount = Math.floor(parsed);
        contact.monthlyPaymentAmountCustomized = true;
      }
      contact.updatedAt = new Date().toISOString();
      const remindersChanged = this.updateContactReminderMessages(contact);
      await this.savePaymentAndReminderChanges(remindersChanged);
      return this.hydrateContact(contact);
    });
  }

  getDueHotspotReactivationContacts(now = new Date()) {
    const nowTime = now.getTime();
    if (Number.isNaN(nowTime)) return [];

    const settings = this.getSettings();
    const isolationGraceDays = sanitizePositiveInteger(
      settings.hotspotIsolationGraceDays,
      DEFAULT_SETTINGS.hotspotIsolationGraceDays,
      0,
      30
    );

    return this.getSortedContacts().filter((contact) => {
      if (!contact.hotspotReactivationAt || !contact.mikrotikUsername) return false;
      if (contact.hotspotReactivationEnabled && !contact.mikrotikProfile) return false;
      const recurring = isRecurringSubscription(contact);
      const blockedByArrears = recurring
        && !isPrepaidPackage(contact)
        && Boolean(contact.hotspotReactivationEnabled)
        && (Boolean(contact.hasDebt)
          || String(contact.currentPaymentStatus || contact.paymentStatus || PAYMENT_STATUS.UNPAID).toUpperCase() !== PAYMENT_STATUS.PAID);
      const hasPrepaidGracePeriod = isPrepaidPackage(contact)
        && Boolean(contact.hotspotReactivationEnabled)
        && isolationGraceDays > 0;
      const dueDate = blockedByArrears || hasPrepaidGracePeriod
        ? addDaysSafely(contact.hotspotReactivationAt, isolationGraceDays, this.getTimezone())
        : new Date(contact.hotspotReactivationAt);
      const dueTime = dueDate.getTime();
      return Number.isFinite(dueTime) && dueTime <= nowTime;
    });
  }

  async reconcileHotspotStatuses(routerUsers, options = {}) {
    return this.withDataMutation(async () => {
      const observedAt = this.normalizeOptionalDate(options.observedAt) || new Date().toISOString();
      const checkedAt = this.normalizeOptionalDate(options.checkedAt) || new Date().toISOString();
      const observedTime = new Date(observedAt).getTime();
      const usersByUsername = new Map();

      for (const routerUser of Array.isArray(routerUsers) ? routerUsers : []) {
        const username = sanitizeInput(routerUser?.username || routerUser?.name || "");
        if (username) usersByUsername.set(username.toLowerCase(), routerUser);
      }
      const summary = {
        checked: 0,
        active: 0,
        missing: 0,
      changed: 0,
      deactivated: 0,
      disabled: 0,
        skipped: 0,
        updated: 0,
      };

      for (const contact of this.contacts.values()) {
        const username = sanitizeInput(contact.mikrotikUsername || "");
        const expectedProfile = sanitizeInput(contact.mikrotikProfile || "");
        if (!username) continue;
        if (!expectedProfile) {
          summary.skipped += 1;
          continue;
        }

        const currentStatus = normalizeHotspotProvisioningStatus(
          contact.hotspotProvisioningStatus,
          HOTSPOT_PROVISIONING_STATUS.ACTIVE
        );
        if ([
          HOTSPOT_PROVISIONING_STATUS.PENDING,
          HOTSPOT_PROVISIONING_STATUS.PROVISIONING,
          HOTSPOT_PROVISIONING_STATUS.FAILED,
        ].includes(currentStatus)) {
          summary.skipped += 1;
          continue;
        }

        const lastSyncedTime = new Date(contact.hotspotLastSyncedAt || 0).getTime();
        if (Number.isFinite(lastSyncedTime) && lastSyncedTime > observedTime) {
          summary.skipped += 1;
          continue;
        }

        const matchedRouterUser = usersByUsername.get(username.toLowerCase()) || null;
        const routerUser = matchedRouterUser?.source === "active" ? null : matchedRouterUser;
        let nextStatus;
        let nextError = "";

        if (!routerUser) {
          if (currentStatus === HOTSPOT_PROVISIONING_STATUS.DEACTIVATED) {
            nextStatus = HOTSPOT_PROVISIONING_STATUS.DEACTIVATED;
          } else {
            nextStatus = HOTSPOT_PROVISIONING_STATUS.MISSING;
            nextError = `Akun "${username}" tidak ditemukan di MikroTik saat sinkronisasi otomatis.`;
          }
        } else {
          const differences = [];
          const actualProfile = sanitizeInput(routerUser.profile || "");
          const expectedEmail = buildHotspotEmailFromPhone(contact.phoneNumber);
          const actualEmail = sanitizeInput(routerUser.email || "").toLowerCase();
          const disabled = routerUser.disabled === true
            || String(routerUser.disabled || "").toLowerCase() === "true";
          const accessMode = getContactHotspotAccessMode(contact);
          const serviceShouldBeDisabled = currentStatus === HOTSPOT_PROVISIONING_STATUS.DISABLED;
          const expectedUserDisabled = serviceShouldBeDisabled
            || accessMode === HOTSPOT_ACCESS_MODES.IP_BINDING_ONLY;

          if (expectedProfile && actualProfile !== expectedProfile) differences.push("profile berbeda");
          if (expectedEmail && actualEmail !== expectedEmail.toLowerCase()) {
            differences.push("email pemilik berbeda");
          }
          if (disabled !== expectedUserDisabled) {
            differences.push(expectedUserDisabled
              ? "akun seharusnya nonaktif sesuai mode akses"
              : "akun dinonaktifkan");
          }

          if (differences.length > 0) {
            nextStatus = HOTSPOT_PROVISIONING_STATUS.CHANGED;
            nextError = `Data akun "${username}" di MikroTik berubah: ${differences.join(", ")}.`;
          } else if (serviceShouldBeDisabled) {
            nextStatus = HOTSPOT_PROVISIONING_STATUS.DISABLED;
            nextError = sanitizeInput(contact.hotspotProvisioningError || "")
              || "Akses hotspot dinonaktifkan.";
          } else {
            nextStatus = HOTSPOT_PROVISIONING_STATUS.ACTIVE;
          }
        }

        const previousError = sanitizeInput(contact.hotspotProvisioningError || "");
        const currentOperation = normalizeHotspotProvisioningOperation(
          contact.hotspotProvisioningOperation,
          HOTSPOT_PROVISIONING_OPERATION.NONE
        );
        let stateChanged = currentStatus !== nextStatus || previousError !== nextError;
        if (nextStatus === HOTSPOT_PROVISIONING_STATUS.ACTIVE
          && (currentOperation !== HOTSPOT_PROVISIONING_OPERATION.NONE
            || contact.hotspotProvisioningPrevious)) {
          stateChanged = true;
        }
        contact.hotspotProvisioningStatus = nextStatus;
        contact.hotspotProvisioningError = nextError;
        contact.hotspotLastCheckedAt = checkedAt;
        if (nextStatus === HOTSPOT_PROVISIONING_STATUS.ACTIVE) {
          contact.hotspotLastSyncedAt = checkedAt;
          contact.hotspotProvisioningOperation = HOTSPOT_PROVISIONING_OPERATION.NONE;
          contact.hotspotProvisioningPrevious = null;
        }

        const pelanggan = this.pelanggan.get(username) || Array.from(this.pelanggan.values()).find(
          (item) => String(item.contactId || "") === String(contact.id)
        ) || null;
        if (pelanggan) {
          const nextPelangganStatus = nextStatus === HOTSPOT_PROVISIONING_STATUS.ACTIVE
            ? "verified"
            : nextStatus.toLowerCase();
          if (pelanggan.status !== nextPelangganStatus
            || pelanggan.hotspotProvisioningStatus !== nextStatus
            || sanitizeInput(pelanggan.hotspotProvisioningError || "") !== nextError) {
            stateChanged = true;
          }
          pelanggan.status = nextPelangganStatus;
          pelanggan.hotspotProvisioningStatus = nextStatus;
          pelanggan.hotspotProvisioningError = nextError;
          pelanggan.hotspotLastCheckedAt = checkedAt;
          if (nextStatus === HOTSPOT_PROVISIONING_STATUS.ACTIVE) {
            pelanggan.hotspotLastSyncedAt = checkedAt;
          }
          if (stateChanged) pelanggan.tanggalUpdate = checkedAt;
        }
        if (stateChanged) contact.updatedAt = checkedAt;

        summary.checked += 1;
        summary.updated += stateChanged ? 1 : 0;
        if (nextStatus === HOTSPOT_PROVISIONING_STATUS.ACTIVE) summary.active += 1;
        if (nextStatus === HOTSPOT_PROVISIONING_STATUS.MISSING) summary.missing += 1;
        if (nextStatus === HOTSPOT_PROVISIONING_STATUS.CHANGED) summary.changed += 1;
        if (nextStatus === HOTSPOT_PROVISIONING_STATUS.DEACTIVATED) summary.deactivated += 1;
        if (nextStatus === HOTSPOT_PROVISIONING_STATUS.DISABLED) summary.disabled += 1;
      }

      if (summary.updated > 0) {
        await this.withDatabaseWrite(() => this.sequelize.transaction(async (transaction) => {
          const saveOptions = { transaction };
          await this.saveContacts(saveOptions);
          await this.savePelanggan(saveOptions);
        }));
      }

      return summary;
    });
  }

  async prepareHotspotLifecycleOperation(contactId, operation) {
    return this.withDataMutation(async () => {
      const contact = this.getContact(contactId);
      if (!contact) throw new Error("Kontak tidak ditemukan.");
      const normalizedOperation = normalizeHotspotProvisioningOperation(operation, "");
      if (![HOTSPOT_PROVISIONING_OPERATION.REACTIVATE, HOTSPOT_PROVISIONING_OPERATION.DEACTIVATE, HOTSPOT_PROVISIONING_OPERATION.ENABLE, HOTSPOT_PROVISIONING_OPERATION.DISABLE]
        .includes(normalizedOperation)) {
        throw new Error("Operasi lifecycle hotspot tidak valid.");
      }
      if (!contact.mikrotikUsername) throw new Error("Username hotspot wajib diisi.");
      if ([HOTSPOT_PROVISIONING_OPERATION.REACTIVATE, HOTSPOT_PROVISIONING_OPERATION.ENABLE].includes(normalizedOperation)
        && !contact.mikrotikProfile) {
        throw new Error("Profile hotspot wajib diisi untuk reaktivasi.");
      }

      const now = new Date().toISOString();
      contact.hotspotProvisioningStatus = HOTSPOT_PROVISIONING_STATUS.PENDING;
      contact.hotspotProvisioningOperation = normalizedOperation;
      contact.hotspotProvisioningError = "";
      contact.hotspotNotificationPending = null;
      contact.updatedAt = now;

      const pelanggan = this.pelanggan.get(contact.mikrotikUsername) || Array.from(this.pelanggan.values()).find(
        (item) => String(item.contactId || "") === String(contact.id)
      ) || null;
      if (pelanggan) {
        pelanggan.status = "pending";
        pelanggan.hotspotProvisioningStatus = HOTSPOT_PROVISIONING_STATUS.PENDING;
        pelanggan.hotspotProvisioningError = "";
        pelanggan.tanggalUpdate = now;
      }

      await this.withDatabaseWrite(() => this.sequelize.transaction(async (transaction) => {
        const saveOptions = { transaction };
        await this.saveContacts(saveOptions);
        await this.savePelanggan(saveOptions);
      }));
      return this.hydrateContact(contact);
    });
  }

  async markHotspotDeactivated(contactId, result, options = {}) {
    return this.withDataMutation(async () => {
      const contact = this.getContact(contactId);
      if (!contact) throw new Error("Kontak tidak ditemukan.");

      const now = new Date();
      contact.hotspotLastDeactivatedAt = now.toISOString();
      contact.hotspotReactivationEnabled = false;
      contact.hotspotReactivationAt = null;
      contact.hotspotNotificationPending = null;
      contact.hotspotProvisioningStatus = HOTSPOT_PROVISIONING_STATUS.DEACTIVATED;
      contact.hotspotProvisioningOperation = HOTSPOT_PROVISIONING_OPERATION.NONE;
      contact.hotspotProvisioningPrevious = null;
      contact.hotspotProvisioningError = "";
      contact.hotspotLastCheckedAt = now.toISOString();
      contact.hotspotLastSyncedAt = now.toISOString();
      contact.updatedAt = now.toISOString();

      const pelanggan = this.pelanggan.get(contact.mikrotikUsername) || Array.from(this.pelanggan.values()).find(
        (item) => String(item.contactId || "") === String(contact.id)
      ) || null;
      if (pelanggan) {
        pelanggan.status = "deactivated";
        pelanggan.hotspotProvisioningStatus = HOTSPOT_PROVISIONING_STATUS.DEACTIVATED;
        pelanggan.hotspotProvisioningError = "";
        pelanggan.hotspotLastCheckedAt = contact.hotspotLastCheckedAt;
        pelanggan.hotspotLastSyncedAt = contact.hotspotLastSyncedAt;
        pelanggan.tanggalUpdate = contact.updatedAt;
      }

      if (options.transaction) {
        await this.saveContacts(options);
        await this.savePelanggan(options);
      } else {
        await this.withDatabaseWrite(() => this.sequelize.transaction(async (transaction) => {
          const saveOptions = { transaction };
          await this.saveContacts(saveOptions);
          await this.savePelanggan(saveOptions);
        }));
      }
      return this.hydrateContact(contact);
    });
  }

  async markHotspotDisabled(contactId, result, options = {}) {
    return this.withDataMutation(async () => {
      const contact = this.getContact(contactId);
      if (!contact) throw new Error("Kontak tidak ditemukan.");
      const now = new Date().toISOString();
      contact.hotspotProvisioningStatus = HOTSPOT_PROVISIONING_STATUS.DISABLED;
      contact.hotspotProvisioningOperation = HOTSPOT_PROVISIONING_OPERATION.NONE;
      contact.hotspotProvisioningPrevious = null;
      contact.hotspotProvisioningError = options.scheduled
        ? "Akun hotspot dinonaktifkan di MikroTik sesuai jadwal."
        : "Akun hotspot dinonaktifkan di MikroTik oleh administrator.";
      contact.hotspotLastCheckedAt = now;
      contact.hotspotLastSyncedAt = now;
      if (options.arrears) {
        this.pauseBillingForArrears(contact, { at: now, suspended: true });
        contact.hotspotProvisioningError = "Akun hotspot dinonaktifkan karena masih memiliki tunggakan.";
      } else {
        contact.hotspotSuspendedForArrears = false;
        contact.hotspotManualActivationWithArrears = false;
      }
      if (options.clearSchedule) {
        contact.hotspotReactivationEnabled = false;
        contact.hotspotReactivationAt = null;
      }
      contact.updatedAt = now;
      const pelanggan = this.pelanggan.get(contact.mikrotikUsername) || Array.from(this.pelanggan.values()).find(
        (item) => String(item.contactId || "") === String(contact.id)
      ) || null;
      if (pelanggan) {
        pelanggan.status = "disabled";
        pelanggan.hotspotProvisioningStatus = HOTSPOT_PROVISIONING_STATUS.DISABLED;
        pelanggan.hotspotProvisioningError = contact.hotspotProvisioningError;
        pelanggan.hotspotLastCheckedAt = now;
        pelanggan.hotspotLastSyncedAt = now;
        pelanggan.tanggalUpdate = now;
      }
      if (options.transaction) {
        await this.saveContacts(options);
        await this.savePelanggan(options);
      } else {
        await this.withDatabaseWrite(() => this.sequelize.transaction(async (transaction) => {
          const saveOptions = { transaction };
          await this.saveContacts(saveOptions);
          await this.savePelanggan(saveOptions);
        }));
      }
      return this.hydrateContact(contact);
    });
  }

  async markHotspotEnabled(contactId, result, options = {}) {
    return this.withDataMutation(async () => {
      const contact = this.getContact(contactId);
      if (!contact) throw new Error("Kontak tidak ditemukan.");
      const requestedAt = options.at ? new Date(options.at) : new Date();
      const activatedAt = Number.isNaN(requestedAt.getTime()) ? new Date() : requestedAt;
      const now = activatedAt.toISOString();
      const manualArrearsActivation = parseBoolean(contact.billingPausedForArrears, false)
        && this.buildDebtInfo(contact).hasDebt;
      contact.hotspotProvisioningStatus = HOTSPOT_PROVISIONING_STATUS.ACTIVE;
      contact.hotspotProvisioningOperation = HOTSPOT_PROVISIONING_OPERATION.NONE;
      contact.hotspotProvisioningPrevious = null;
      contact.hotspotProvisioningError = "";
      contact.hotspotLastCheckedAt = now;
      contact.hotspotLastSyncedAt = now;
      contact.mikrotikPassword = sanitizeInput(result?.password || contact.mikrotikPassword || "");
      contact.mikrotikProfile = sanitizeInput(result?.profile || contact.mikrotikProfile || "");
      contact.hotspotSuspendedForArrears = false;
      if (manualArrearsActivation) {
        contact.hotspotManualActivationWithArrears = true;
        contact.hotspotReactivationEnabled = false;
        contact.hotspotReactivationAt = addMonthsSafely(activatedAt, 1, this.getTimezone()).toISOString();
      } else {
        contact.hotspotManualActivationWithArrears = false;
      }
      const activePeriodResult = options.activePeriodPurchase
        ? this.applyActivePeriodPurchase(contact, options.activePeriodPurchase)
        : null;
      const remindersChanged = activePeriodResult?.added
        ? this.syncActivePeriodExpiryReminder(contact, activePeriodResult.purchase).changed
        : 0;
      contact.updatedAt = now;
      const pelanggan = this.pelanggan.get(contact.mikrotikUsername) || Array.from(this.pelanggan.values()).find(
        (item) => String(item.contactId || "") === String(contact.id)
      ) || null;
      if (pelanggan) {
        pelanggan.status = "verified";
        pelanggan.hotspotProvisioningStatus = HOTSPOT_PROVISIONING_STATUS.ACTIVE;
        pelanggan.hotspotProvisioningError = "";
        pelanggan.hotspotLastCheckedAt = now;
        pelanggan.hotspotLastSyncedAt = now;
        pelanggan.password = contact.mikrotikPassword || pelanggan.password;
        pelanggan.profile = contact.mikrotikProfile || pelanggan.profile;
        pelanggan.tanggalUpdate = now;
      }
      if (options.transaction) {
        await this.saveContacts(options);
        await this.savePelanggan(options);
        if (remindersChanged) await this.saveReminders(options);
      } else {
        await this.withDatabaseWrite(() => this.sequelize.transaction(async (transaction) => {
          const saveOptions = { transaction };
          await this.saveContacts(saveOptions);
          await this.savePelanggan(saveOptions);
          if (remindersChanged) await this.saveReminders(saveOptions);
        }));
      }
      return this.hydrateContact(contact);
    });
  }

  async markHotspotReactivated(contactId, result, options = {}) {
    return this.withDataMutation(async () => {
      const contact = this.getContact(contactId);
      if (!contact) throw new Error("Kontak tidak ditemukan.");

      const requestedAt = options.at ? new Date(options.at) : new Date();
      const now = Number.isNaN(requestedAt.getTime()) ? new Date() : requestedAt;
      const manualArrearsActivation = parseBoolean(contact.billingPausedForArrears, false)
        && this.buildDebtInfo(contact).hasDebt;
      const previousSchedule = contact.hotspotReactivationAt || now.toISOString();
      let nextSchedule = null;
      if (isRecurringSubscription(contact)) {
        if (manualArrearsActivation) {
          nextSchedule = addMonthsSafely(now, 1, this.getTimezone());
        } else {
          nextSchedule = addMonthsSafely(previousSchedule, 1, this.getTimezone());
          while (nextSchedule.getTime() <= now.getTime()) {
            nextSchedule = addMonthsSafely(nextSchedule, 1, this.getTimezone());
          }
        }
      }
      contact.hotspotLastReactivatedAt = now.toISOString();
      contact.hotspotReactivationEnabled = isRecurringSubscription(contact) && !manualArrearsActivation;
      contact.hotspotReactivationAt = nextSchedule ? nextSchedule.toISOString() : null;
      contact.hotspotSuspendedForArrears = false;
      contact.hotspotManualActivationWithArrears = manualArrearsActivation;
      contact.mikrotikPassword = sanitizeInput(result?.password || contact.mikrotikPassword || "");
      contact.mikrotikProfile = sanitizeInput(result?.profile || contact.mikrotikProfile || "");
      contact.hotspotProvisioningStatus = HOTSPOT_PROVISIONING_STATUS.ACTIVE;
      contact.hotspotProvisioningOperation = HOTSPOT_PROVISIONING_OPERATION.NONE;
      contact.hotspotProvisioningPrevious = null;
      contact.hotspotProvisioningError = "";
      contact.hotspotLastCheckedAt = now.toISOString();
      contact.hotspotLastSyncedAt = now.toISOString();
      contact.updatedAt = now.toISOString();
      contact.hotspotNotificationPending = null;

      const pelanggan = this.pelanggan.get(contact.mikrotikUsername) || Array.from(this.pelanggan.values()).find(
        (item) => String(item.contactId || "") === String(contact.id)
      ) || null;
      if (pelanggan) {
        pelanggan.status = "verified";
        pelanggan.profile = contact.mikrotikProfile;
        pelanggan.password = contact.mikrotikPassword;
        pelanggan.hotspotProvisioningStatus = HOTSPOT_PROVISIONING_STATUS.ACTIVE;
        pelanggan.hotspotProvisioningError = "";
        pelanggan.hotspotLastCheckedAt = contact.hotspotLastCheckedAt;
        pelanggan.hotspotLastSyncedAt = contact.hotspotLastSyncedAt;
        pelanggan.tanggalUpdate = contact.updatedAt;
      }

      if (options.transaction) {
        await this.saveContacts(options);
        await this.savePelanggan(options);
      } else {
        await this.withDatabaseWrite(() => this.sequelize.transaction(async (transaction) => {
          const saveOptions = { transaction };
          await this.saveContacts(saveOptions);
          await this.savePelanggan(saveOptions);
        }));
      }
      return this.hydrateContact(contact);
    });
  }

  async markReminderDeliveryAttempt(id, provider = null) {
    return this.withDataMutation(async () => {
      const reminder = this.getReminder(id);
      if (!reminder || reminder.deliveryAttemptedAt || this.getPrepaidReminderStageRecord(reminder)) {
        return null;
      }

      const now = new Date().toISOString();
      reminder.deliveryAttempts = Math.max(0, Number(reminder.deliveryAttempts) || 0) + 1;
      reminder.deliveryAttemptedAt = reminder.deliveryAttemptedAt || now;
      reminder.lastDeliveryAttemptAt = now;
      reminder.whatsappProvider = provider || reminder.whatsappProvider || null;
      reminder.providerStatus = "processing";
      reminder.providerError = null;
      const stageRecorded = this.recordPrepaidReminderStage(reminder, "PROCESSING", now);
      if (stageRecorded) {
        await this.withDatabaseWrite(() => this.sequelize.transaction(async (transaction) => {
          const options = { transaction };
          await this.saveReminders(options);
          await this.saveContacts(options);
        }));
      } else {
        await this.saveReminders();
      }
      return this.hydrateReminder(reminder);
    });
  }

  async markDueRemindersPending(now = new Date(), provider = null) {
    return this.withDataMutation(async () => {
      let changed = 0;
      for (const reminder of this.reminders.values()) {
        const dueAt = this.getReminderDeliveryDate(reminder).getTime();
        if (!Number.isFinite(dueAt) || dueAt > now.getTime() || reminder.processingAt) continue;
        if (reminder.providerStatus !== "pending" || reminder.whatsappProvider !== provider) {
          reminder.providerStatus = "pending";
          reminder.whatsappProvider = provider;
          changed += 1;
        }
      }
      if (changed > 0) await this.saveReminders();
      return changed;
    });
  }

  async scheduleReminderRetry(id, error, options = {}) {
    return this.withDataMutation(async () => {
      const reminder = this.getReminder(id);
      if (!reminder) return null;
      const delaySeconds = Math.max(1, Number(options.delaySeconds) || CONFIG.WHATSAPP_RETRY_DELAY);
      reminder.nextDeliveryAttemptAt = new Date(Date.now() + delaySeconds * 1000).toISOString();
      reminder.providerStatus = "retry";
      reminder.providerError = sanitizeInput(error?.message || error || "Pengiriman WhatsApp gagal");
      reminder.lastDeliveryError = reminder.providerError;
      reminder.whatsappProvider = options.provider || reminder.whatsappProvider || null;
      delete reminder.processingAt;
      await this.saveReminders();
      return this.hydrateReminder(reminder);
    });
  }

  assertContactDeletionAllowed(id) {
    const pending = this.getPendingPaymentGatewayTransactions(id);
    if (pending.length > 0) {
      const error = new Error("Pelanggan masih memiliki transaksi Midtrans aktif. Selesaikan atau batalkan transaksi sebelum menghapus pelanggan.");
      error.statusCode = 409;
      throw error;
    }
  }

  async deleteContact(id) {
    return this.withDataMutation(async () => {
      const contact = this.getContact(id);
      if (!contact) throw new Error("Kontak tidak ditemukan.");
      this.assertContactDeletionAllowed(id);

      this.contacts.delete(String(id));
      this.customerAccounts.delete(String(id));
      for (const [username, pelanggan] of this.pelanggan.entries()) {
        if (String(pelanggan.contactId || "") === String(id)) {
          this.pelanggan.delete(username);
        }
      }

      const relatedReminderIds = Array.from(this.reminders.values())
        .filter((reminder) => String(reminder.contactId) === String(contact.id) || reminder.phoneNumber === contact.phoneNumber)
        .map((reminder) => String(reminder.id));

      for (const reminderId of relatedReminderIds) {
        this.reminders.delete(reminderId);
      }

      await this.withDatabaseWrite(() => this.sequelize.transaction(async (transaction) => {
        const options = { transaction };
        await this.saveContacts(options);
        await this.savePelanggan(options);
        await this.saveCustomerAccounts(options);
        await this.saveReminders(options);
      }));
      return { deletedContact: contact, deletedReminders: relatedReminderIds.length };
    });
  }

  async addReminder(payload) {
    return this.withDataMutation(async () => {
      const contact = this.getContact(payload.contactId);
      const message = sanitizeMultilineText(payload.message);
      const reminderDate = payload.reminderDateTime instanceof Date
        ? payload.reminderDateTime
        : new Date(payload.reminderDateTime);

      if (!contact) throw new Error("Contact reminder tidak ditemukan.");
      if (!isRecurringSubscription(contact)) {
        throw new Error("Reminder tidak diperlukan untuk pelanggan sekali berlangganan.");
      }
      if (this.isReminderSuppressedForArrears(contact)) {
        throw new Error("Reminder tidak dibuat untuk pelanggan dengan 2 tunggakan atau lebih.");
      }
      if (!message) throw new Error("Isi reminder wajib diisi.");
      if (Number.isNaN(reminderDate.getTime())) throw new Error("Tanggal reminder tidak valid.");

      const reminder = {
        id: generateId(),
        contactId: String(contact.id),
        contactName: contact.name,
        phoneNumber: contact.phoneNumber,
        paymentAmount: Math.max(0, Number(contact.monthlyPaymentAmount) || 0),
        reminderDateTime: reminderDate.toISOString(),
        reminderKind: Object.values(REMINDER_KINDS).includes(payload.reminderKind)
          ? payload.reminderKind
          : undefined,
        message,
        messageSource: sanitizeMultilineText(payload.messageSource || message),
        templateName: payload.templateName ? sanitizeInput(payload.templateName) : null,
        createdAt: new Date().toISOString(),
      };

      this.rewriteReminderPaymentMessage(reminder, contact);

      this.reminders.set(reminder.id, reminder);
      await this.saveReminders();
      return this.hydrateReminder(reminder);
    });
  }

  async claimDueReminder(id, now = new Date()) {
    return this.withDataMutation(async () => {
      const reminder = this.getReminder(id);
      if (!reminder) return null;

      const reminderTime = this.getReminderDeliveryDate(reminder).getTime();
      if (!Number.isFinite(reminderTime) || reminderTime > now.getTime()) {
        return null;
      }

      const previousDelivery = this.getPrepaidReminderStageRecord(reminder);
      if (previousDelivery) {
        if (previousDelivery.reminderId !== String(reminder.id)
          || previousDelivery.status !== "PROCESSING") {
          this.reminders.delete(String(id));
          await this.saveReminders();
          return null;
        }
        reminder.deliveryAttemptedAt = reminder.deliveryAttemptedAt || previousDelivery.at;
        reminder.lastDeliveryAttemptAt = reminder.lastDeliveryAttemptAt || previousDelivery.at;
        reminder.providerStatus = "processing";
      }

      const processingStartedAt = reminder.processingAt ? new Date(reminder.processingAt).getTime() : null;
      if (Number.isFinite(processingStartedAt) && (Date.now() - processingStartedAt) < 15 * 60 * 1000) {
        return null;
      }

      reminder.processingAt = new Date().toISOString();
      await this.saveReminders();
      return this.hydrateReminder(reminder);
    });
  }

  async releaseReminderClaim(id) {
    return this.withDataMutation(async () => {
      const reminder = this.getReminder(id);
      if (!reminder || !reminder.processingAt) return null;
      delete reminder.processingAt;
      await this.saveReminders();
      return this.hydrateReminder(reminder);
    });
  }

  async moveToSent(id, extras = {}) {
    return this.withDataMutation(async () => {
      const reminder = this.getReminder(id);
      if (!reminder) return null;

      const sentReminder = {
        ...this.hydrateReminder(reminder),
        message: extras.message || reminder.message,
        sentAt: extras.sentAt || new Date().toISOString(),
        deliveryStatus: extras.deliveryStatus || "SENT",
        whatsappProvider: extras.whatsappProvider || reminder.whatsappProvider || null,
        providerMessageId: extras.providerMessageId || reminder.providerMessageId || null,
        providerStatus: extras.providerStatus || (extras.deliveryStatus === "FAILED" ? "failed" : "sent"),
        providerError: extras.providerError || extras.deliveryError || reminder.providerError || null,
      };
      if (extras.deliveryError) {
        sentReminder.deliveryError = sanitizeInput(extras.deliveryError);
      }
      delete sentReminder.processingAt;
      delete sentReminder.nextDeliveryAttemptAt;

      const stageRecorded = this.recordPrepaidReminderStage(
        reminder, sentReminder.deliveryStatus, sentReminder.sentAt
      );
      this.sentReminders.set(String(id), sentReminder);
      this.reminders.delete(String(id));
      await this.withDatabaseWrite(() => this.sequelize.transaction(async (transaction) => {
        const options = { transaction };
        await this.saveReminders(options);
        await this.saveSentReminders(options);
        if (stageRecorded) await this.saveContacts(options);
      }));
      return sentReminder;
    });
  }

  async moveToGracePeriod(id, extras = {}) {
    return this.withDataMutation(async () => {
      const reminder = this.getReminder(id);
      if (!reminder) return null;

      const historyId = generateId();
      const sentReminder = {
        ...this.hydrateReminder(reminder),
        id: historyId,
        sourceReminderId: String(id),
        message: extras.message || reminder.message,
        sentAt: extras.sentAt || new Date().toISOString(),
        deliveryStatus: extras.deliveryStatus || "SENT",
        whatsappProvider: extras.whatsappProvider || reminder.whatsappProvider || null,
        providerMessageId: extras.providerMessageId || reminder.providerMessageId || null,
        providerStatus: extras.providerStatus || (extras.deliveryStatus === "FAILED" ? "failed" : "sent"),
        providerError: extras.providerError || extras.deliveryError || reminder.providerError || null,
      };
      if (extras.deliveryError) {
        sentReminder.deliveryError = sanitizeInput(extras.deliveryError);
      }
      delete sentReminder.processingAt;
      delete sentReminder.nextDeliveryAttemptAt;

      if (reminder.reminderKind !== REMINDER_KINDS.ACTIVE_PERIOD_EXPIRY) {
        reminder.reminderKind = REMINDER_KINDS.GRACE_PERIOD;
      }
      reminder.gracePeriodCreatedAt = new Date().toISOString();
      for (const field of [
        "processingAt",
        "nextDeliveryAttemptAt",
        "deliveryAttemptedAt",
        "lastDeliveryAttemptAt",
        "lastDeliveryError",
        "deliveryAttempts",
        "whatsappProvider",
        "providerMessageId",
        "providerStatus",
        "providerError",
      ]) {
        delete reminder[field];
      }

      const stageRecorded = this.recordPrepaidReminderStage(
        sentReminder, sentReminder.deliveryStatus, sentReminder.sentAt
      );
      this.sentReminders.set(historyId, sentReminder);
      await this.withDatabaseWrite(() => this.sequelize.transaction(async (transaction) => {
        const options = { transaction };
        await this.saveReminders(options);
        await this.saveSentReminders(options);
        if (stageRecorded) await this.saveContacts(options);
      }));
      return {
        sentReminder,
        reminder: this.hydrateReminder(reminder),
      };
    });
  }

  getAdminRecipients() {
    return Array.from(this.roles.entries())
      .filter(([, role]) => role === "admin")
      .map(([phoneNumber]) => phoneNumber)
      .sort();
  }

  async setAdminRecipients(numbers) {
    return this.withDataMutation(async () => {
      this.roles = new Map();
      for (const number of numbers) {
        this.roles.set(number, "admin");
      }
      await this.saveRoles();
      return this.getAdminRecipients();
    });
  }

}

module.exports = CustomerDataManager;
