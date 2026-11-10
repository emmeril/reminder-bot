const fs = require("fs/promises");
const net = require("net");
const path = require("path");
const ExcelJS = require("exceljs");
const {
  DEFAULT_SETTINGS,
  PAYMENT_STATUS,
  PAYMENT_TYPES,
} = require("../../config");
const {
  PAYMENT_TYPE_LABELS,
  compareBillingPeriods,
  formatReportDate,
  getContactBillingPeriod,
  getContactBillingStartPeriod,
  isOneTimeSubscriptionEnded,
  isPrepaidPackage,
  isRecurringSubscription,
  listBillingPeriods,
  normalizeProfileMonthlyAmounts,
  styleReportSheet,
} = require("../customers/domain");
const {
  formatBillingPeriodLabel,
  getBillingPeriodKey,
  getBillingPeriodParts,
  getPreviousBillingPeriod,
  isValidTimeZone,
  makeBillingPeriodKey,
  parseBoolean,
  sanitizeInput,
  sanitizeMultilineText,
  sanitizePositiveInteger,
  sanitizeTimeHHMM,
} = require("../../utils");
const CustomerDataManager = require("./customers");

class DataManager extends CustomerDataManager {
  getSettings() {
    const settings = { ...DEFAULT_SETTINGS, ...this.settings };
    settings.profileMonthlyAmounts = normalizeProfileMonthlyAmounts(settings.profileMonthlyAmounts);
    delete settings.monthlyPaymentAmount;
    delete settings.hotspotReactivationMessageTemplate;
    return settings;
  }

  getProfileMonthlyAmount(profileName) {
    const profile = sanitizeInput(String(profileName || "")).toLowerCase();
    if (!profile) return null;
    const entries = Object.entries(this.getSettings().profileMonthlyAmounts || {});
    const match = entries.find(([name]) => name.toLowerCase() === profile);
    return match ? Number(match[1]) : null;
  }

  applyProfileMonthlyAmount(contact, profileName = contact?.mikrotikProfile) {
    const amount = this.getProfileMonthlyAmount(profileName);
    if (!contact || contact.monthlyPaymentAmountCustomized || amount === null
      || Number(contact.monthlyPaymentAmount) === amount) return false;
    contact.monthlyPaymentAmount = amount;
    return true;
  }

  async updateSettings(payload) {
    return this.withDataMutation(async () => {
      const current = this.getSettings();
      const requestedTimezone = payload.timezone !== undefined
        ? sanitizeInput(payload.timezone)
        : current.timezone;
      const requestedBackupTimezone = payload.mikrotikBackupTimezone !== undefined
        ? sanitizeInput(payload.mikrotikBackupTimezone)
        : current.mikrotikBackupTimezone;
      if (!isValidTimeZone(requestedTimezone)) {
        throw new Error("Timezone aplikasi tidak valid.");
      }
      if (!isValidTimeZone(requestedBackupTimezone || requestedTimezone)) {
        throw new Error("Timezone backup MikroTik tidak valid.");
      }
      const requestedDelayMin = payload.waRandomDelayMinSeconds !== undefined
        ? sanitizePositiveInteger(payload.waRandomDelayMinSeconds, current.waRandomDelayMinSeconds, 0, 300)
        : current.waRandomDelayMinSeconds;
      const requestedDelayMax = payload.waRandomDelayMaxSeconds !== undefined
        ? sanitizePositiveInteger(payload.waRandomDelayMaxSeconds, current.waRandomDelayMaxSeconds, 0, 300)
        : current.waRandomDelayMaxSeconds;
      const requestedProfileMonthlyAmounts = payload.profileMonthlyAmounts !== undefined
        ? normalizeProfileMonthlyAmounts(payload.profileMonthlyAmounts, { strict: true })
        : current.profileMonthlyAmounts;
      this.settings = {
        ...current,
        dashboardTitle: payload.dashboardTitle !== undefined ? sanitizeInput(payload.dashboardTitle) || current.dashboardTitle : current.dashboardTitle,
        companyName: payload.companyName !== undefined ? sanitizeInput(payload.companyName) || current.companyName : current.companyName,
        supportSignature: payload.supportSignature !== undefined ? sanitizeInput(payload.supportSignature) || current.supportSignature : current.supportSignature,
        apDownMessageTemplate: payload.apDownMessageTemplate !== undefined
          ? sanitizeMultilineText(payload.apDownMessageTemplate) || current.apDownMessageTemplate
          : current.apDownMessageTemplate,
        customerAccountMessageTemplate: payload.customerAccountMessageTemplate !== undefined
          ? sanitizeMultilineText(payload.customerAccountMessageTemplate) || current.customerAccountMessageTemplate
          : current.customerAccountMessageTemplate,
        paymentMessageTemplateArrearsOnly: payload.paymentMessageTemplateArrearsOnly !== undefined
          ? sanitizeMultilineText(payload.paymentMessageTemplateArrearsOnly) || current.paymentMessageTemplateArrearsOnly
          : current.paymentMessageTemplateArrearsOnly,
        paymentMessageTemplateCurrentOnly: payload.paymentMessageTemplateCurrentOnly !== undefined
          ? sanitizeMultilineText(payload.paymentMessageTemplateCurrentOnly) || current.paymentMessageTemplateCurrentOnly
          : current.paymentMessageTemplateCurrentOnly,
        paymentMessageTemplateFullPaid: payload.paymentMessageTemplateFullPaid !== undefined
          ? sanitizeMultilineText(payload.paymentMessageTemplateFullPaid) || current.paymentMessageTemplateFullPaid
          : current.paymentMessageTemplateFullPaid,
        prepaidPackagePaymentMessageTemplate: payload.prepaidPackagePaymentMessageTemplate !== undefined
          ? sanitizeMultilineText(payload.prepaidPackagePaymentMessageTemplate) || current.prepaidPackagePaymentMessageTemplate
          : current.prepaidPackagePaymentMessageTemplate,
        paymentHotspotAccountMessageTemplate: payload.paymentHotspotAccountMessageTemplate !== undefined
          ? sanitizeMultilineText(payload.paymentHotspotAccountMessageTemplate) || current.paymentHotspotAccountMessageTemplate
          : current.paymentHotspotAccountMessageTemplate,
        paymentIpBindingAccessMessageTemplate: payload.paymentIpBindingAccessMessageTemplate !== undefined
          ? sanitizeMultilineText(payload.paymentIpBindingAccessMessageTemplate) || current.paymentIpBindingAccessMessageTemplate
          : current.paymentIpBindingAccessMessageTemplate,
        prepaidPackageReminderMessageTemplate: payload.prepaidPackageReminderMessageTemplate !== undefined
          ? sanitizeMultilineText(payload.prepaidPackageReminderMessageTemplate) || current.prepaidPackageReminderMessageTemplate
          : current.prepaidPackageReminderMessageTemplate,
        gracePeriodReminderMessageTemplate: payload.gracePeriodReminderMessageTemplate !== undefined
          ? sanitizeMultilineText(payload.gracePeriodReminderMessageTemplate) || current.gracePeriodReminderMessageTemplate
          : current.gracePeriodReminderMessageTemplate,
        billingReminderMessageTemplate: payload.billingReminderMessageTemplate !== undefined
          ? sanitizeMultilineText(payload.billingReminderMessageTemplate) || current.billingReminderMessageTemplate
          : current.billingReminderMessageTemplate,
        apDownMinimumDownMinutes: payload.apDownMinimumDownMinutes !== undefined
          ? sanitizePositiveInteger(
              payload.apDownMinimumDownMinutes,
              current.apDownMinimumDownMinutes || current.apDownConfirmationChecks || DEFAULT_SETTINGS.apDownMinimumDownMinutes,
              1,
              120
            )
          : (current.apDownMinimumDownMinutes || current.apDownConfirmationChecks || DEFAULT_SETTINGS.apDownMinimumDownMinutes),
        timezone: requestedTimezone,
        hotspotIsolationGraceDays: payload.hotspotIsolationGraceDays !== undefined
          ? sanitizePositiveInteger(
              payload.hotspotIsolationGraceDays,
              current.hotspotIsolationGraceDays,
              0,
              30
            )
          : current.hotspotIsolationGraceDays,
        autoRescheduleMonthly: payload.autoRescheduleMonthly !== undefined ? parseBoolean(payload.autoRescheduleMonthly, current.autoRescheduleMonthly) : current.autoRescheduleMonthly,
        notifyContactsOnApDown: payload.notifyContactsOnApDown !== undefined ? parseBoolean(payload.notifyContactsOnApDown, current.notifyContactsOnApDown) : current.notifyContactsOnApDown,
        notifyAdminsOnDelivery: payload.notifyAdminsOnDelivery !== undefined ? parseBoolean(payload.notifyAdminsOnDelivery, current.notifyAdminsOnDelivery) : current.notifyAdminsOnDelivery,
        notifyAdminsOnConnectionChange: payload.notifyAdminsOnConnectionChange !== undefined ? parseBoolean(payload.notifyAdminsOnConnectionChange, current.notifyAdminsOnConnectionChange) : current.notifyAdminsOnConnectionChange,
        notifyAdminsOnPaymentReset: payload.notifyAdminsOnPaymentReset !== undefined ? parseBoolean(payload.notifyAdminsOnPaymentReset, current.notifyAdminsOnPaymentReset) : current.notifyAdminsOnPaymentReset,
        waRandomDelayMinSeconds: Math.min(requestedDelayMin, requestedDelayMax),
        waRandomDelayMaxSeconds: Math.max(requestedDelayMin, requestedDelayMax),
        enableMikrotikBackupToWa: payload.enableMikrotikBackupToWa !== undefined
          ? parseBoolean(payload.enableMikrotikBackupToWa, current.enableMikrotikBackupToWa)
          : current.enableMikrotikBackupToWa,
        mikrotikBackupTime: payload.mikrotikBackupTime !== undefined
          ? sanitizeTimeHHMM(payload.mikrotikBackupTime, current.mikrotikBackupTime || DEFAULT_SETTINGS.mikrotikBackupTime)
          : current.mikrotikBackupTime,
        mikrotikBackupTimezone: requestedBackupTimezone || requestedTimezone,
        databaseBackupTime: payload.databaseBackupTime !== undefined
          ? sanitizeTimeHHMM(payload.databaseBackupTime, current.databaseBackupTime || DEFAULT_SETTINGS.databaseBackupTime)
          : current.databaseBackupTime,
        enableDatabaseBackupToTelegram: payload.enableDatabaseBackupToTelegram !== undefined
          ? parseBoolean(payload.enableDatabaseBackupToTelegram, current.enableDatabaseBackupToTelegram)
          : current.enableDatabaseBackupToTelegram,
        profileMonthlyAmounts: requestedProfileMonthlyAmounts,
        mikrotikBackupLastRunDate: payload.mikrotikBackupLastRunDate !== undefined
          ? sanitizeInput(payload.mikrotikBackupLastRunDate)
          : current.mikrotikBackupLastRunDate,
        databaseBackupLastRunDate: current.databaseBackupLastRunDate,
        databaseBackupSnapshotName: current.databaseBackupSnapshotName,
        databaseBackupTelegramLastRunDate: current.databaseBackupTelegramLastRunDate,
      };
      let contactsChanged = false;
      let remindersChanged = this.syncActiveRemindersWithSettings(this.settings);
      const updatedAt = new Date().toISOString();
      for (const contact of this.contacts.values()) {
        if (!this.applyProfileMonthlyAmount(contact)) continue;
        contact.updatedAt = updatedAt;
        contactsChanged = true;
        remindersChanged += this.updateContactReminderMessages(contact);
      }

      if (this.sequelize && (contactsChanged || remindersChanged > 0)) {
        await this.withDatabaseWrite(() => this.sequelize.transaction(async (transaction) => {
          const options = { transaction };
          await this.saveSettings(options);
          if (contactsChanged) await this.saveContacts(options);
          if (remindersChanged > 0) await this.saveReminders(options);
        }));
      } else {
        await this.saveSettings();
        if (contactsChanged) await this.saveContacts();
        if (remindersChanged > 0) await this.saveReminders();
      }
      return this.getSettings();
    });
  }

  async markMikrotikBackupRun(dateKey) {
    return this.withDataMutation(async () => {
      this.settings = {
        ...this.getSettings(),
        mikrotikBackupLastRunDate: sanitizeInput(dateKey),
      };
      await this.saveSettings();
      return this.settings.mikrotikBackupLastRunDate;
    });
  }

  async markDatabaseBackupRun(dateKey, backupDir) {
    return this.withDataMutation(async () => {
      const snapshotName = path.basename(String(backupDir || ""));
      this.settings = {
        ...this.getSettings(),
        databaseBackupLastRunDate: sanitizeInput(dateKey),
        databaseBackupSnapshotName: /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/.test(snapshotName)
          ? snapshotName
          : "",
      };
      await this.saveSettings();
      return this.settings.databaseBackupLastRunDate;
    });
  }

  async markDatabaseBackupTelegramRun(dateKey) {
    return this.withDataMutation(async () => {
      this.settings = {
        ...this.getSettings(),
        databaseBackupTelegramLastRunDate: sanitizeInput(dateKey),
      };
      await this.saveSettings();
      return this.settings.databaseBackupTelegramLastRunDate;
    });
  }

  getContactsByStatus(status) {
    return this.getSortedContacts().filter((contact) => contact.paymentStatus === status);
  }

  getPaymentsByMonth(year, month) {
    const key = `${year}-${String(month).padStart(2, "0")}`;
    return this.getSortedContacts().filter((contact) => {
      if (contact.paymentMonths?.[key]?.status === PAYMENT_STATUS.PAID) return true;
      return (contact.activePeriodPurchases || []).some((purchase) => (
        purchase?.status === PAYMENT_STATUS.PAID
        && getBillingPeriodKey(purchase.purchasedAt, this.getTimezone()) === key
      ));
    });
  }

  getAllPaymentsHistory() {
    const history = {};
    for (const contact of this.contacts.values()) {
      const recordedPeriods = new Set();
      for (const [key, payment] of Object.entries(contact.paymentMonths || {})) {
        if (!payment || payment.status !== PAYMENT_STATUS.PAID) continue;
        if (!history[key]) {
          history[key] = { contacts: [], total: 0 };
        }
        history[key].contacts.push(contact);
        history[key].total += 1;
        recordedPeriods.add(key);
      }
      for (const purchase of contact.activePeriodPurchases || []) {
        if (purchase?.status !== PAYMENT_STATUS.PAID || !purchase.purchasedAt) continue;
        const key = getBillingPeriodKey(purchase.purchasedAt, this.getTimezone());
        if (recordedPeriods.has(key)) continue;
        if (!history[key]) history[key] = { contacts: [], total: 0 };
        history[key].contacts.push(contact);
        history[key].total += 1;
        recordedPeriods.add(key);
      }
    }
    return history;
  }

  async createPaymentRecapWorkbook() {
    const workbook = new ExcelJS.Workbook();
    const contacts = this.getSortedContacts();
    const paidContacts = contacts.filter((contact) => contact.paymentStatus === PAYMENT_STATUS.PAID);
    const unpaidContacts = contacts.filter((contact) => contact.paymentStatus !== PAYMENT_STATUS.PAID);
    const debtContacts = contacts.filter((contact) => contact.hasDebt);
    const now = new Date();
    const timeZone = this.getTimezone();
    const { year, month } = getBillingPeriodParts(now, timeZone);

    workbook.creator = "Reminder Bot";
    workbook.created = now;
    workbook.modified = now;

    const summary = workbook.addWorksheet("Ringkasan");
    summary.columns = [
      { header: "Keterangan", key: "label" },
      { header: "Jumlah / Nilai", key: "value" },
    ];
    summary.addRows([
      { label: "Periode Rekap", value: formatBillingPeriodLabel(year, month) },
      { label: "Dibuat Pada", value: formatReportDate(now, true, timeZone) },
      { label: "Total Pelanggan", value: contacts.length },
      { label: "Sudah Lunas Bulan Ini", value: paidContacts.length },
      { label: "Belum Lunas Bulan Ini", value: unpaidContacts.length },
      { label: "Pelanggan Memiliki Tunggakan", value: debtContacts.length },
    ]);
    styleReportSheet(summary);

    const contactColumns = [
      { header: "No", key: "number" },
      { header: "Nama", key: "name" },
      { header: "Nomor WhatsApp", key: "phoneNumber" },
      { header: "Status Bulan Ini", key: "status" },
      { header: "Jenis Pembayaran", key: "paymentType" },
      { header: "Tanggal Pembayaran", key: "paymentDate" },
      { header: "Jumlah Tunggakan (Bulan)", key: "debtCount" },
      { header: "Sisa Tunggakan", key: "debtAmount" },
      { header: "Periode Tunggakan", key: "debtPeriods" },
      { header: "Jatuh Tempo", key: "dueDate" },
      { header: "Status Jatuh Tempo", key: "dueStatus" },
      { header: "Username Hotspot", key: "mikrotikUsername" },
      { header: "Profile Hotspot", key: "mikrotikProfile" },
      { header: "AP", key: "linkedApHost" },
    ];
    const toContactRow = (contact, index) => ({
      number: index + 1,
      name: contact.name || "-",
      phoneNumber: contact.phoneNumber || "-",
      status: contact.paymentStatus === PAYMENT_STATUS.PAID ? "Lunas" : "Belum Lunas",
      paymentType: PAYMENT_TYPE_LABELS[contact.paymentType] || "-",
      paymentDate: formatReportDate(contact.paymentDate, true, timeZone),
      debtCount: contact.debtCount || 0,
      debtAmount: Math.max(0, Number(contact.debtAmount) || 0),
      debtPeriods: (contact.debtPeriods || []).map((period) => period.label).join(", ") || "-",
      dueDate: formatReportDate(contact.dueDate, false, timeZone),
      dueStatus: {
        PAID: "Lunas",
        OVERDUE: "Jatuh Tempo",
        UPCOMING: "Belum Jatuh Tempo",
        NOT_SCHEDULED: "Perlu Dijadwalkan",
        NOT_APPLICABLE: "Tidak Dijadwalkan",
      }[contact.dueStatus] || contact.dueStatus || "-",
      mikrotikUsername: contact.mikrotikUsername || "-",
      mikrotikProfile: contact.mikrotikProfile || "-",
      linkedApHost: contact.linkedApHost || "-",
    });

    for (const [sheetName, rows] of [
      ["Semua Pelanggan", contacts],
      ["Belum Lunas", unpaidContacts],
      ["Sudah Lunas", paidContacts],
      ["Memiliki Tunggakan", debtContacts],
    ]) {
      const sheet = workbook.addWorksheet(sheetName);
      sheet.columns = contactColumns;
      sheet.addRows(rows.map(toContactRow));
      styleReportSheet(sheet);
    }

    const history = workbook.addWorksheet("Riwayat Pembayaran");
    history.columns = [
      { header: "No", key: "number" },
      { header: "Periode Tagihan", key: "period" },
      { header: "Nama", key: "name" },
      { header: "Nomor WhatsApp", key: "phoneNumber" },
      { header: "Status", key: "status" },
      { header: "Jenis Pembayaran", key: "paymentType" },
      { header: "Nominal Dibayar", key: "paidAmount" },
      { header: "Sisa Tagihan", key: "remainingAmount" },
      { header: "Tanggal Dibayar", key: "paidDate" },
      { header: "Aktif Sampai", key: "activeUntil" },
    ];
    const historyRows = [];
    for (const contact of contacts) {
      for (const [period, payment] of Object.entries(contact.paymentMonths || {})) {
        if (!payment) continue;
        historyRows.push({
          period,
          name: contact.name || "-",
          phoneNumber: contact.phoneNumber || "-",
          status: payment.status === PAYMENT_STATUS.PAID ? "Lunas" : "Belum Lunas",
          paymentType: PAYMENT_TYPE_LABELS[payment.paymentType] || "-",
          paidAmount: this.getPaymentPaidAmount(payment, contact.monthlyPaymentAmount),
          remainingAmount: this.getPaymentRemainingAmount(payment, contact.monthlyPaymentAmount),
          paidDate: formatReportDate(payment.lastPaymentDate || payment.paidDate, true, timeZone),
          activeUntil: "-",
        });
      }
      for (const purchase of contact.activePeriodPurchases || []) {
        const purchasedAt = new Date(purchase.purchasedAt || 0);
        if (Number.isNaN(purchasedAt.getTime())) continue;
        historyRows.push({
          period: getBillingPeriodKey(purchasedAt, timeZone),
          name: contact.name || "-",
          phoneNumber: contact.phoneNumber || "-",
          status: "Lunas",
          paymentType: PAYMENT_TYPE_LABELS[PAYMENT_TYPES.ACTIVE_PERIOD],
          paidAmount: Math.max(0, Number(purchase.amount) || 0),
          remainingAmount: 0,
          paidDate: formatReportDate(purchase.purchasedAt, true, timeZone),
          activeUntil: formatReportDate(purchase.activeUntil, true, timeZone),
        });
      }
    }
    historyRows.sort((a, b) => b.period.localeCompare(a.period) || a.name.localeCompare(b.name, "id-ID"));
    history.addRows(historyRows.map((row, index) => ({ number: index + 1, ...row })));
    styleReportSheet(history);

    return workbook;
  }

  getPaymentMonthStatus(contactId) {
    const contact = this.getContact(contactId);
    return contact?.paymentMonths || {};
  }

  normalizePaymentSelection(status, paymentType = null) {
    const normalizedStatus = sanitizeInput(status).toUpperCase();
    const normalizedType = sanitizeInput(paymentType).toUpperCase() || null;

    if (![PAYMENT_STATUS.PAID, PAYMENT_STATUS.UNPAID].includes(normalizedStatus)) {
      throw new Error("Status pembayaran tidak valid.");
    }
    if (normalizedType && !this.getAllowedPaymentTypes().includes(normalizedType)) {
      throw new Error("Jenis pembayaran tidak valid.");
    }
    if (normalizedType === PAYMENT_TYPES.ACTIVE_PERIOD) {
      throw new Error("Pembelian masa aktif harus menggunakan tindakan khusus pembelian masa aktif.");
    }

    if (normalizedStatus === PAYMENT_STATUS.PAID) {
      if (normalizedType === PAYMENT_TYPES.ARREARS_ONLY) {
        throw new Error("Pembayaran tunggakan saja harus membiarkan bulan berjalan berstatus belum lunas.");
      }
      return {
        status: normalizedStatus,
        paymentType: normalizedType || PAYMENT_TYPES.CURRENT_ONLY,
      };
    }

    if (normalizedType && normalizedType !== PAYMENT_TYPES.ARREARS_ONLY) {
      throw new Error("Status belum lunas hanya dapat digunakan tanpa jenis pembayaran atau untuk tunggakan saja.");
    }

    return { status: normalizedStatus, paymentType: normalizedType };
  }

  async updatePaymentStatus(contactId, status, paymentType = null, paymentAmount = null) {
    return this.withDataMutation(async () => {
      const contact = this.getContact(contactId);
      if (!contact) throw new Error("Kontak tidak ditemukan.");
      if (isPrepaidPackage(contact)) {
        throw new Error("Pelanggan prabayar dibayar melalui tindakan pembelian paket satu bulan.");
      }
      ({ status, paymentType } = this.normalizePaymentSelection(status, paymentType));
      let appliedPaymentAmount = 0;

      const now = new Date();
      const serviceScheduleBeforePayment = contact.hotspotReactivationAt || null;
      const timeZone = this.getTimezone();
      const referencePeriod = getBillingPeriodParts(now, timeZone);
      const { year, month } = getContactBillingPeriod(contact, referencePeriod);
      const currentKey = makeBillingPeriodKey(year, month);
      const previous = getPreviousBillingPeriod(year, month);
      const subscriptionEnded = !this.usesRecurringBilling(contact)
        && isOneTimeSubscriptionEnded(contact, { year, month }, timeZone);
      if (subscriptionEnded && ![PAYMENT_TYPES.FULL_PAID, PAYMENT_TYPES.ARREARS_ONLY].includes(paymentType)) {
        if (status !== PAYMENT_STATUS.UNPAID) {
          throw new Error("Pelanggan sekali berlangganan sudah tidak memiliki tagihan periode berjalan.");
        }
        contact.paymentStatus = PAYMENT_STATUS.PAID;
        contact.paymentDate = null;
        contact.paymentType = null;
        contact.updatedAt = now.toISOString();
        const remindersChanged = this.updateContactReminderMessages(contact);
        await this.savePaymentAndReminderChanges(remindersChanged);
        return this.hydrateContact(contact);
      }
      if (!contact.paymentMonths || typeof contact.paymentMonths !== "object") {
        contact.paymentMonths = {};
      }
      const currentPaymentBeforeUpdate = contact.paymentMonths[currentKey] || null;
      const currentStatusBeforeUpdate = currentPaymentBeforeUpdate?.status
        || String(contact.paymentStatus || PAYMENT_STATUS.UNPAID).toUpperCase();
      const currentPeriodNewlyPaid = status === PAYMENT_STATUS.PAID
        && currentStatusBeforeUpdate !== PAYMENT_STATUS.PAID;
      const hadDebtBeforeUpdate = this.buildDebtInfo(contact, referencePeriod).hasDebt;
      const paymentRecorded = paymentType === PAYMENT_TYPES.ARREARS_ONLY
        || currentPeriodNewlyPaid
        || (paymentType === PAYMENT_TYPES.FULL_PAID && hadDebtBeforeUpdate);
      const arrearsDebtInfo = paymentType === PAYMENT_TYPES.ARREARS_ONLY
        ? this.buildDebtInfo(contact, referencePeriod)
        : null;
      const arrearsDebtPeriod = arrearsDebtInfo?.debtPeriods?.[0] || null;
      if (paymentType === PAYMENT_TYPES.ARREARS_ONLY) {
        if (!arrearsDebtPeriod) {
          throw new Error("Kontak tidak memiliki tunggakan yang belum dibayar.");
        }
        const hasExplicitPaymentAmount = paymentAmount !== null
          && paymentAmount !== undefined
          && paymentAmount !== "";
        const monthlyAmount = Math.max(0, Number(contact.monthlyPaymentAmount) || 0);
        if (hasExplicitPaymentAmount && monthlyAmount <= 0) {
          throw new Error("Nominal bulanan harus diisi sebelum mencatat pembayaran tunggakan.");
        }

        if (monthlyAmount > 0) {
          const requestedAmount = hasExplicitPaymentAmount
            ? Number(paymentAmount)
            : arrearsDebtPeriod.remainingAmount;
          if (!Number.isSafeInteger(requestedAmount) || requestedAmount <= 0) {
            throw new Error("Nominal pembayaran tunggakan harus berupa angka bulat lebih dari 0.");
          }
          if (requestedAmount > arrearsDebtInfo.debtAmount) {
            throw new Error(`Nominal pembayaran melebihi sisa tunggakan ${this.formatPaymentAmount(arrearsDebtInfo.debtAmount)}.`);
          }
          appliedPaymentAmount = requestedAmount;
        }
      }

      const nextCurrentStatus = paymentType === PAYMENT_TYPES.ARREARS_ONLY
        ? currentStatusBeforeUpdate
        : status;
      contact.paymentStatus = nextCurrentStatus;
      contact.paymentDate = nextCurrentStatus === PAYMENT_STATUS.PAID
        ? currentPaymentBeforeUpdate?.paidDate || contact.paymentDate || now.toISOString()
        : null;
      contact.paymentType = paymentType || null;

      if (paymentType === PAYMENT_TYPES.FULL_PAID) {
        const startPeriod = getContactBillingStartPeriod(contact, timeZone);
        const periods = this.usesRecurringBilling(contact)
          ? listBillingPeriods(startPeriod, previous)
          : (compareBillingPeriods(startPeriod, previous) <= 0 ? [startPeriod] : []);
        for (const period of periods) {
          contact.paymentMonths[makeBillingPeriodKey(period.year, period.month)] = {
            status: PAYMENT_STATUS.PAID,
            paidDate: now.toISOString(),
            paymentType,
            paidAmount: Math.max(0, Math.floor(Number(contact.monthlyPaymentAmount) || 0)),
          };
        }
      } else if (paymentType === PAYMENT_TYPES.ARREARS_ONLY) {
        const monthlyAmount = Math.max(0, Math.floor(Number(contact.monthlyPaymentAmount) || 0));
        if (monthlyAmount <= 0) {
          contact.paymentMonths[arrearsDebtPeriod.key] = {
            ...(contact.paymentMonths[arrearsDebtPeriod.key] || {}),
            status: PAYMENT_STATUS.PAID,
            paidDate: now.toISOString(),
            lastPaymentDate: now.toISOString(),
            paymentType,
            paidAmount: 0,
          };
        } else {
          let remainingPayment = appliedPaymentAmount;
          for (const debtPeriod of arrearsDebtInfo.debtPeriods) {
            if (remainingPayment <= 0) break;
            const previousPayment = contact.paymentMonths[debtPeriod.key] || {};
            const recordedAmount = this.getPaymentPaidAmount(previousPayment, monthlyAmount);
            const amountForPeriod = Math.min(debtPeriod.remainingAmount, remainingPayment);
            const nextPaidAmount = recordedAmount + amountForPeriod;
            const isPeriodPaid = nextPaidAmount >= monthlyAmount;
            contact.paymentMonths[debtPeriod.key] = {
              ...previousPayment,
              status: isPeriodPaid ? PAYMENT_STATUS.PAID : PAYMENT_STATUS.UNPAID,
              paidDate: isPeriodPaid ? now.toISOString() : previousPayment.paidDate || null,
              lastPaymentDate: now.toISOString(),
              paymentType,
              paidAmount: nextPaidAmount,
            };
            remainingPayment -= amountForPeriod;
          }
        }
      }

      if (!subscriptionEnded) {
        if (paymentType !== PAYMENT_TYPES.ARREARS_ONLY) {
          const existingCurrentPayment = contact.paymentMonths[currentKey] || {};
          contact.paymentMonths[currentKey] = {
            ...existingCurrentPayment,
            status,
            paidDate: status === PAYMENT_STATUS.PAID
              ? existingCurrentPayment.paidDate || now.toISOString()
              : null,
            paymentType: paymentType || null,
            paidAmount: status === PAYMENT_STATUS.PAID
              ? Math.max(0, Math.floor(Number(contact.monthlyPaymentAmount) || 0))
              : 0,
          };
        } else if (!currentPaymentBeforeUpdate) {
          contact.paymentMonths[currentKey] = {
            status: currentStatusBeforeUpdate,
            paidDate: currentStatusBeforeUpdate === PAYMENT_STATUS.PAID ? contact.paymentDate : null,
            paymentType: null,
            paidAmount: 0,
          };
        }
      } else {
        contact.paymentStatus = PAYMENT_STATUS.PAID;
        contact.paymentDate = null;
        contact.paymentType = null;
      }
      contact.updatedAt = now.toISOString();

      const arrearsPolicy = contact.subscriptionChangedByArrears
        ? this.applyArrearsSubscriptionPolicy(contact)
        : { remindersAdded: 0, remindersRemoved: 0 };
      const automaticRenewalResumed = this.resumeAutomaticRenewalIfArrearsSettled(contact, { at: now });
      const serviceSchedule = currentPeriodNewlyPaid
        && paymentType !== PAYMENT_TYPES.ARREARS_ONLY
        ? this.advanceServiceScheduleAfterPayment(contact, {
            at: now,
            previousSchedule: serviceScheduleBeforePayment,
            paymentPeriodKey: currentKey,
          })
        : { changed: false, activeFrom: null, activeUntil: null };
      const reminderScheduleChanged = automaticRenewalResumed || serviceSchedule.changed
        ? this.syncRecurringReminderSchedule(contact)
        : 0;
      const remindersChanged = arrearsPolicy.remindersAdded + arrearsPolicy.remindersRemoved
        + reminderScheduleChanged
        + this.updateContactReminderMessages(contact);
      await this.savePaymentAndReminderChanges(remindersChanged);
      const hydrated = this.hydrateContact(contact);
      if (appliedPaymentAmount > 0) {
        hydrated.paymentAppliedAmount = appliedPaymentAmount;
      }
      hydrated.paymentRecorded = paymentRecorded;
      if (serviceSchedule.activeUntil) {
        hydrated.serviceActiveFrom = serviceSchedule.activeFrom;
        hydrated.serviceActiveUntil = serviceSchedule.activeUntil;
      }
      return hydrated;
    });
  }

  async setPaymentForMonth(contactId, year, month, status, paymentType = null) {
    return this.withDataMutation(async () => {
      const contact = this.getContact(contactId);
      if (!contact) throw new Error("Kontak tidak ditemukan.");
      if (isPrepaidPackage(contact)) {
        throw new Error("Pelanggan prabayar tidak menggunakan pembayaran per bulan. Gunakan pembelian paket satu bulan.");
      }
      if (!Number.isInteger(year) || year < 2000 || year > 2100 || !Number.isInteger(month) || month < 1 || month > 12) {
        throw new Error("Periode pembayaran tidak valid.");
      }
      ({ status, paymentType } = this.normalizePaymentSelection(status, paymentType));

      if (!contact.paymentMonths) {
        contact.paymentMonths = {};
      }

      const key = `${year}-${String(month).padStart(2, "0")}`;
      const now = new Date();
      const serviceScheduleBeforePayment = contact.hotspotReactivationAt || null;
      const timeZone = this.getTimezone();
      const previous = getPreviousBillingPeriod(year, month);
      const existingPeriodBeforeUpdate = contact.paymentMonths[key] || null;
      const periodWasPaid = existingPeriodBeforeUpdate?.status === PAYMENT_STATUS.PAID;
      const hadDebtBeforeUpdate = this.buildDebtInfo(contact, { year, month, billingPeriod: true }).hasDebt;
      const paymentRecorded = status === PAYMENT_STATUS.PAID && (
        !periodWasPaid
        || paymentType === PAYMENT_TYPES.ARREARS_ONLY
        || (paymentType === PAYMENT_TYPES.FULL_PAID && hadDebtBeforeUpdate)
      );
      if (!this.usesRecurringBilling(contact)) {
        const startPeriod = getContactBillingStartPeriod(contact, timeZone);
        const existingPeriod = contact.paymentMonths[key];
        const isExistingArrears = existingPeriod?.status === PAYMENT_STATUS.UNPAID
          && compareBillingPeriods(startPeriod, { year, month }) < 0;
        if (compareBillingPeriods(startPeriod, { year, month }) !== 0 && !isExistingArrears) {
          throw new Error("Pelanggan sekali berlangganan hanya dapat dicatat pada periode saat berlangganan.");
        }
      }
      const arrearsDebtPeriod = paymentType === PAYMENT_TYPES.ARREARS_ONLY
        ? this.buildDebtInfo(contact, { year, month, billingPeriod: true }).debtPeriods?.[0]
        : null;
      if (paymentType === PAYMENT_TYPES.ARREARS_ONLY && !arrearsDebtPeriod) {
        throw new Error("Kontak tidak memiliki tunggakan yang belum dibayar.");
      }

      if (paymentType === PAYMENT_TYPES.FULL_PAID) {
        const startPeriod = getContactBillingStartPeriod(contact, timeZone);
        const periods = this.usesRecurringBilling(contact)
          ? listBillingPeriods(startPeriod, previous)
          : (compareBillingPeriods(startPeriod, previous) <= 0 ? [startPeriod] : []);
        for (const period of periods) {
          contact.paymentMonths[makeBillingPeriodKey(period.year, period.month)] = {
            status: PAYMENT_STATUS.PAID,
            paidDate: now.toISOString(),
            paymentType,
            paidAmount: Math.max(0, Math.floor(Number(contact.monthlyPaymentAmount) || 0)),
          };
        }
      } else if (paymentType === PAYMENT_TYPES.ARREARS_ONLY) {
        contact.paymentMonths[arrearsDebtPeriod.key] = {
          status: PAYMENT_STATUS.PAID,
          paidDate: now.toISOString(),
          paymentType,
          paidAmount: Math.max(0, Math.floor(Number(contact.monthlyPaymentAmount) || 0)),
        };
      }

      contact.paymentMonths[key] = {
        status,
        paidDate: status === PAYMENT_STATUS.PAID
          ? existingPeriodBeforeUpdate?.paidDate || now.toISOString()
          : null,
        paymentType: paymentType || null,
        paidAmount: status === PAYMENT_STATUS.PAID
          ? Math.max(0, Math.floor(Number(contact.monthlyPaymentAmount) || 0))
          : 0,
      };

      const currentBillingPeriod = getContactBillingPeriod(
        contact,
        getBillingPeriodParts(now, timeZone)
      );
      const { year: currentYear, month: currentMonth } = currentBillingPeriod;
      if (year === currentYear && month === currentMonth) {
        contact.paymentStatus = status;
        contact.paymentDate = status === PAYMENT_STATUS.PAID
          ? contact.paymentMonths[key].paidDate
          : null;
        contact.paymentType = paymentType || null;
      }
      contact.updatedAt = now.toISOString();

      const arrearsPolicy = contact.subscriptionChangedByArrears
        ? this.applyArrearsSubscriptionPolicy(contact)
        : { remindersAdded: 0, remindersRemoved: 0 };
      const automaticRenewalResumed = this.resumeAutomaticRenewalIfArrearsSettled(contact, { at: now });
      const serviceSchedule = year === currentYear
        && month === currentMonth
        && paymentRecorded
        && !periodWasPaid
        && paymentType !== PAYMENT_TYPES.ARREARS_ONLY
        ? this.advanceServiceScheduleAfterPayment(contact, {
            at: now,
            previousSchedule: serviceScheduleBeforePayment,
            paymentPeriodKey: key,
          })
        : { changed: false, activeFrom: null, activeUntil: null };
      const reminderScheduleChanged = automaticRenewalResumed || serviceSchedule.changed
        ? this.syncRecurringReminderSchedule(contact)
        : 0;
      const remindersChanged = arrearsPolicy.remindersAdded + arrearsPolicy.remindersRemoved
        + reminderScheduleChanged
        + this.updateContactReminderMessages(contact);
      await this.savePaymentAndReminderChanges(remindersChanged);
      const hydrated = this.hydrateContact(contact);
      hydrated.paymentRecorded = paymentRecorded;
      if (serviceSchedule.activeUntil) {
        hydrated.serviceActiveFrom = serviceSchedule.activeFrom;
        hydrated.serviceActiveUntil = serviceSchedule.activeUntil;
      }
      return hydrated;
    });
  }

  inferPaymentType(contact, options = {}) {
    const paymentMonths = contact.paymentMonths || {};
    const referencePeriod = getBillingPeriodParts(new Date(), this.getTimezone());
    const selectedReference = {
      year: options.year ?? referencePeriod.year,
      month: options.month ?? referencePeriod.month,
    };
    const { year, month } = getContactBillingPeriod(contact, selectedReference);
    const currentKey = `${year}-${String(month).padStart(2, "0")}`;
    const prevMonth = month === 1 ? 12 : month - 1;
    const prevYear = month === 1 ? year - 1 : year;
    const prevKey = `${prevYear}-${String(prevMonth).padStart(2, "0")}`;
    const savedType = String(contact.paymentType || "").toUpperCase();
    if (Object.values(PAYMENT_TYPES).includes(savedType)) {
      return savedType;
    }

    const currentPaid = paymentMonths[currentKey]?.status === PAYMENT_STATUS.PAID;
    const previousPaid = paymentMonths[prevKey]?.status === PAYMENT_STATUS.PAID;

    if (currentPaid && previousPaid) return PAYMENT_TYPES.FULL_PAID;
    if (currentPaid) return PAYMENT_TYPES.CURRENT_ONLY;
    if (previousPaid) return PAYMENT_TYPES.ARREARS_ONLY;
    return "DEFAULT";
  }

  getAllowedPaymentTypes() {
    return Object.values(PAYMENT_TYPES);
  }

  getOverdueContacts(year, month) {
    return this.getSortedContacts().filter((contact) => (
      this.buildDebtInfo(contact, { year, month }).hasDebt
    ));
  }

  async resetAllPaymentStatus() {
    return this.withDataMutation(async () => this.resetAllPaymentStatusUnlocked());
  }

  async resetAllPaymentStatusUnlocked(options = {}) {
    let resetCount = 0;
    let remindersChanged = 0;
    const referencePeriod = getBillingPeriodParts(new Date(), this.getTimezone());

    for (const contact of this.contacts.values()) {
      const billingPeriod = getContactBillingPeriod(contact, referencePeriod);
      const currentKey = makeBillingPeriodKey(billingPeriod.year, billingPeriod.month);
      const arrearsPolicy = this.applyArrearsSubscriptionPolicy(contact);
      remindersChanged += arrearsPolicy.remindersAdded + arrearsPolicy.remindersRemoved;
      if (isPrepaidPackage(contact)) {
        const packageState = this.buildDebtInfo(contact);
        contact.paymentStatus = packageState.currentPaymentStatus;
        contact.paymentDate = packageState.packageActive ? contact.paymentDate : null;
        contact.paymentType = packageState.packageActive ? PAYMENT_TYPES.ACTIVE_PERIOD : null;
        contact.billingPausedForArrears = false;
        contact.billingPausedAfterPeriod = null;
        contact.updatedAt = new Date().toISOString();
        remindersChanged += this.updateContactReminderMessages(contact);
        resetCount += 1;
        continue;
      }
      if (parseBoolean(contact.billingPausedForArrears, false)) {
        contact.paymentStatus = PAYMENT_STATUS.PAID;
        contact.paymentDate = null;
        contact.paymentType = null;
        contact.updatedAt = new Date().toISOString();
        remindersChanged += this.updateContactReminderMessages(contact);
        resetCount += 1;
        continue;
      }
      if (!isRecurringSubscription(contact)) {
        const startPeriod = getContactBillingStartPeriod(contact, this.getTimezone());
        const currentPeriod = getBillingPeriodParts(new Date(), this.getTimezone());
        if (compareBillingPeriods(startPeriod, currentPeriod) < 0) {
          contact.paymentStatus = PAYMENT_STATUS.PAID;
          contact.paymentDate = null;
          contact.paymentType = null;
          contact.updatedAt = new Date().toISOString();
          remindersChanged += this.updateContactReminderMessages(contact);
          resetCount += 1;
          continue;
        }
      }
      contact.paymentStatus = PAYMENT_STATUS.UNPAID;
      contact.paymentDate = null;
      contact.paymentType = null;
      if (!contact.paymentMonths) {
        contact.paymentMonths = {};
      }
      contact.paymentMonths[currentKey] = {
        status: PAYMENT_STATUS.UNPAID,
        paidDate: null,
        paymentType: null,
        paidAmount: 0,
      };
      contact.updatedAt = new Date().toISOString();
      remindersChanged += this.updateContactReminderMessages(contact);
      resetCount += 1;
    }

    if (resetCount > 0 && options.save !== false) {
      await this.savePaymentAndReminderChanges(remindersChanged);
    }

    return resetCount;
  }

  synchronizeCurrentPaymentStatus() {
    const referencePeriod = getBillingPeriodParts(new Date(), this.getTimezone());
    let changed = 0;

    for (const contact of this.contacts.values()) {
      const billingPeriod = getContactBillingPeriod(contact, referencePeriod);
      const currentKey = makeBillingPeriodKey(billingPeriod.year, billingPeriod.month);
      const currentPayment = contact.paymentMonths?.[currentKey];
      if (isPrepaidPackage(contact)) {
        const packageState = this.buildDebtInfo(contact);
        const nextStatus = packageState.currentPaymentStatus;
        const nextPaymentDate = packageState.packageActive ? contact.paymentDate || null : null;
        const nextPaymentType = packageState.packageActive ? PAYMENT_TYPES.ACTIVE_PERIOD : null;
        if (contact.paymentStatus !== nextStatus
          || contact.paymentDate !== nextPaymentDate
          || contact.paymentType !== nextPaymentType
          || parseBoolean(contact.billingPausedForArrears, false)) {
          contact.paymentStatus = nextStatus;
          contact.paymentDate = nextPaymentDate;
          contact.paymentType = nextPaymentType;
          contact.billingPausedForArrears = false;
          contact.billingPausedAfterPeriod = null;
          contact.updatedAt = new Date().toISOString();
          this.updateContactReminderMessages(contact);
          changed += 1;
        }
        continue;
      }
      const billingPaused = parseBoolean(contact.billingPausedForArrears, false);
      const billingStarted = compareBillingPeriods(
        getContactBillingStartPeriod(contact, this.getTimezone()),
        billingPeriod
      ) <= 0;
      const isPaid = billingPaused
        || currentPayment?.status === PAYMENT_STATUS.PAID;
      const nextStatus = isPaid ? PAYMENT_STATUS.PAID : PAYMENT_STATUS.UNPAID;
      const nextPaymentDate = isPaid && !billingPaused ? currentPayment?.paidDate || null : null;
      const nextPaymentType = isPaid && !billingPaused ? currentPayment?.paymentType || null : null;

      if (contact.paymentStatus !== nextStatus
        || contact.paymentDate !== nextPaymentDate
        || contact.paymentType !== nextPaymentType) {
        contact.paymentStatus = nextStatus;
        contact.paymentDate = nextPaymentDate;
        contact.paymentType = nextPaymentType;
        contact.updatedAt = new Date().toISOString();
        this.updateContactReminderMessages(contact);
        changed += 1;
      }
    }

    return changed;
  }

  async ensureMonthlyPaymentReset() {
    return this.withDataMutation(async () => {
      const currentPeriod = getBillingPeriodKey(new Date(), this.getTimezone());
      const settings = this.getSettings();

      if (!settings.lastPaymentResetPeriod) {
        const synchronized = this.synchronizeCurrentPaymentStatus();
        const arrearsPolicy = this.enforceArrearsSubscriptionPolicy();
        this.settings.lastPaymentResetPeriod = currentPeriod;
        await this.withDatabaseWrite(() => this.sequelize.transaction(async (transaction) => {
          const options = { transaction };
          if (synchronized > 0 || arrearsPolicy.changed > 0) {
            await this.saveContacts(options);
            await this.saveReminders(options);
          }
          await this.saveSettings(options);
        }));
        return {
          reset: false,
          initialized: true,
          period: currentPeriod,
          count: synchronized,
          converted: arrearsPolicy.converted,
          restored: arrearsPolicy.restored,
        };
      }

      if (settings.lastPaymentResetPeriod === currentPeriod) {
        const arrearsPolicy = this.enforceArrearsSubscriptionPolicy();
        if (arrearsPolicy.changed > 0) {
          await this.withDatabaseWrite(() => this.sequelize.transaction(async (transaction) => {
            const options = { transaction };
            await this.saveContacts(options);
            if (arrearsPolicy.remindersAdded > 0 || arrearsPolicy.remindersRemoved > 0) {
              await this.saveReminders(options);
            }
          }));
        }
        return {
          reset: false,
          period: currentPeriod,
          count: 0,
          converted: arrearsPolicy.converted,
          restored: arrearsPolicy.restored,
        };
      }

      const count = await this.resetAllPaymentStatusUnlocked({ save: false });
      this.settings.lastPaymentResetPeriod = currentPeriod;
      await this.withDatabaseWrite(() => this.sequelize.transaction(async (transaction) => {
        const options = { transaction };
        await this.saveContacts(options);
        await this.saveReminders(options);
        await this.saveSettings(options);
      }));
      return { reset: true, period: currentPeriod, count };
    });
  }
}


module.exports = DataManager;
