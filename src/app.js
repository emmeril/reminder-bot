require("dotenv").config({ quiet: true });

const fs = require("fs/promises");
const net = require("net");
const path = require("path");
const express = require("express");
const cron = require("node-cron");
const crypto = require("crypto");
const ExcelJS = require("exceljs");
const QRCode = require("qrcode");
const { Sequelize, DataTypes } = require("sequelize");
const {
  BILLING_CYCLES,
  BILLING_REMINDER_STOP_DEBT_COUNT,
  CONFIG,
  DETAILED_BILLING_REMINDER_MESSAGE_TEMPLATE,
  DEFAULT_REMINDER_MESSAGE_TEMPLATE,
  DEFAULT_SETTINGS,
  LEGACY_ACTIVE_PERIOD_REMINDER_MESSAGE_TEMPLATE,
  LEGACY_ACTIVE_PERIOD_REMINDER_MESSAGE_TEMPLATE_V3,
  LEGACY_DEFAULT_REMINDER_MESSAGE_TEMPLATE_V3,
  LEGACY_DETAILED_BILLING_REMINDER_MESSAGE_TEMPLATE_V4,
  LEGACY_NOTIFICATION_TEMPLATES_V3,
  LEGACY_PAYMENT_MESSAGE_TEMPLATE_ACTIVE_PERIOD,
  MONTH_NAMES,
  PAYMENT_STATUS,
  PAYMENT_TYPES,
  REMINDER_KINDS,
  SUBSCRIPTION_TYPES,
} = require("./config");
const ActivityLog = require("./activity-log");
const AsyncLock = require("./async-lock");
const AuthManager = require("./auth-manager");
const {
  MidtransService,
  PAYMENT_GATEWAY_STATUS,
  normalizeMidtransPaymentStatus,
} = require("./midtrans-service");
const { migrateWhatsAppProviderMetadata } = require("./migrations/whatsapp-provider-metadata");
const TelegramManager = require("./telegram-manager");
const WhatsAppProviderManager = require("./whatsapp/provider-manager");
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
const registerCustomerRoutes = require("./modules/customers/routes");
const {
  IP_BINDING_BANDWIDTH_STATUS,
  normalizeIpBindingBandwidthStatus,
  normalizeMacAddress,
  normalizeMacAddresses,
  normalizeQueueTarget,
} = require("./modules/mikrotik/domain");
const MikrotikService = require("./modules/mikrotik/service");
const {
  buildVoucherRevenueReport,
  normalizeVoucherGenerationPayload,
} = require("./modules/vouchers/domain");
const registerVoucherRoutes = require("./modules/vouchers/routes");
const {
  addDaysSafely,
  addMonthsSafely,
  assertSecureConfiguration,
  buildBillingDetails,
  buildHotspotEmailFromPhone,
  collectSecurityWarnings,
  escapeHtml,
  formatBillingPeriodLabel,
  formatUsernameFromName,
  generateId,
  getBillingPeriodKey,
  getBillingPeriodParts,
  getPreviousBillingPeriod,
  getReminderDeliveryDate,
  isAutomaticBillingReminder,
  isGracePeriodReminder,
  isValidPhoneNumber,
  isValidTimeZone,
  makeBillingPeriodKey,
  normalizeNetworkHost,
  normalizePhoneNumber,
  parseBoolean,
  parseCookies,
  parseDateTimeInput,
  safeCompareString,
  sanitizeInput,
  sanitizeMultilineText,
  sanitizePositiveInteger,
  sanitizeTimeHHMM,
  serializeCookie,
  sleep,
} = require("./utils");

const BILLING_START_PERIOD = { year: 2026, month: 4 };
const HOTSPOT_PROVISIONING_STATUS = Object.freeze({
  NONE: "NONE",
  PENDING: "PENDING",
  PROVISIONING: "PROVISIONING",
  ACTIVE: "ACTIVE",
  FAILED: "FAILED",
  DEACTIVATED: "DEACTIVATED",
  DISABLED: "DISABLED",
  MISSING: "MISSING",
  CHANGED: "CHANGED",
});
const HOTSPOT_PROVISIONING_OPERATION = Object.freeze({
  NONE: "NONE",
  CREATE: "CREATE",
  UPDATE: "UPDATE",
  REACTIVATE: "REACTIVATE",
  DEACTIVATE: "DEACTIVATE",
  ENABLE: "ENABLE",
  DISABLE: "DISABLE",
});
const HOTSPOT_ACCESS_MODES = Object.freeze({
  HOTSPOT_ONLY: "HOTSPOT_ONLY",
  IP_BINDING_ONLY: "IP_BINDING_ONLY",
  BOTH: "BOTH",
});
function normalizeHotspotProvisioningStatus(value, fallback = HOTSPOT_PROVISIONING_STATUS.NONE) {
  const normalized = String(value || "").trim().toUpperCase();
  return Object.values(HOTSPOT_PROVISIONING_STATUS).includes(normalized) ? normalized : fallback;
}

function isHotspotAccountUnavailable(status, provisioningError = "") {
  const normalizedStatus = normalizeHotspotProvisioningStatus(status);
  return [
    HOTSPOT_PROVISIONING_STATUS.NONE,
    HOTSPOT_PROVISIONING_STATUS.DEACTIVATED,
    HOTSPOT_PROVISIONING_STATUS.DISABLED,
    HOTSPOT_PROVISIONING_STATUS.MISSING,
  ].includes(normalizedStatus)
    || (normalizedStatus === HOTSPOT_PROVISIONING_STATUS.CHANGED
      && /akun dinonaktifkan/i.test(String(provisioningError || "")));
}

function getHotspotUnavailableMessage(status, provisioningError = "") {
  if (normalizeHotspotProvisioningStatus(status) === HOTSPOT_PROVISIONING_STATUS.CHANGED
    && /akun dinonaktifkan/i.test(String(provisioningError || ""))) {
    return "Akun hotspot dinonaktifkan di MikroTik.";
  }
  if (normalizeHotspotProvisioningStatus(status) === HOTSPOT_PROVISIONING_STATUS.DISABLED) {
    return "Akun hotspot sedang dinonaktifkan oleh administrator.";
  }
  return "Akun hotspot tidak ditemukan di MikroTik.";
}

function normalizeHotspotProvisioningOperation(value, fallback = HOTSPOT_PROVISIONING_OPERATION.NONE) {
  const normalized = String(value || "").trim().toUpperCase();
  return Object.values(HOTSPOT_PROVISIONING_OPERATION).includes(normalized) ? normalized : fallback;
}

function normalizeHotspotAccessMode(value, fallback = HOTSPOT_ACCESS_MODES.HOTSPOT_ONLY) {
  const normalized = String(value || "").trim().toUpperCase();
  return Object.values(HOTSPOT_ACCESS_MODES).includes(normalized) ? normalized : fallback;
}

function getContactHotspotAccessMode(contact = {}) {
  const fallback = normalizeMacAddresses(contact.mikrotikMacAddresses).length > 0
    ? HOTSPOT_ACCESS_MODES.BOTH
    : HOTSPOT_ACCESS_MODES.HOTSPOT_ONLY;
  return normalizeHotspotAccessMode(contact.hotspotAccessMode, fallback);
}

function getHotspotAccessRouterState(mode, serviceDisabled = false) {
  const accessMode = normalizeHotspotAccessMode(mode);
  if (serviceDisabled) return { accessMode, userDisabled: true, bindingType: "blocked" };
  return {
    accessMode,
    userDisabled: accessMode === HOTSPOT_ACCESS_MODES.IP_BINDING_ONLY,
    bindingType: accessMode === HOTSPOT_ACCESS_MODES.HOTSPOT_ONLY ? "regular" : "bypassed",
  };
}

function normalizeProfileMonthlyAmounts(value, { strict = false } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    if (strict && value !== undefined && value !== null) {
      throw new Error("Tarif profile MikroTik tidak valid.");
    }
    return {};
  }

  const normalized = new Map();
  for (const [rawProfile, rawAmount] of Object.entries(value).slice(0, 200)) {
    const profile = sanitizeInput(String(rawProfile || ""));
    if (!profile || rawAmount === "" || rawAmount === null || rawAmount === undefined) continue;
    const amount = Number(rawAmount);
    if (!Number.isFinite(amount) || amount < 0 || amount > 1_000_000_000) {
      if (strict) throw new Error(`Nominal profile "${profile}" harus antara 0 sampai 1 miliar.`);
      continue;
    }
    normalized.set(profile.toLowerCase(), [profile, Math.floor(amount)]);
  }
  return Object.fromEntries(normalized.values());
}

function compareBillingPeriods(a, b) {
  if (a.year !== b.year) return a.year - b.year;
  return a.month - b.month;
}

function addBillingMonths(period, monthsToAdd) {
  const index = (period.year * 12) + (period.month - 1) + monthsToAdd;
  return {
    year: Math.floor(index / 12),
    month: (index % 12) + 1,
  };
}

function getContactBillingStartPeriod(contact, timeZone = "Asia/Jakarta") {
  const createdAt = contact.createdAt ? new Date(contact.createdAt) : null;
  if (!createdAt || Number.isNaN(createdAt.getTime())) {
    return BILLING_START_PERIOD;
  }

  const createdPeriod = getBillingPeriodParts(createdAt, timeZone);
  return compareBillingPeriods(createdPeriod, BILLING_START_PERIOD) > 0
    ? createdPeriod
    : BILLING_START_PERIOD;
}

function normalizeSubscriptionType(value, fallback = SUBSCRIPTION_TYPES.RECURRING) {
  const normalized = String(value || "").trim().toUpperCase().replace(/-/g, "_");
  return Object.values(SUBSCRIPTION_TYPES).includes(normalized) ? normalized : fallback;
}

function normalizeBillingCycle(value, fallback = BILLING_CYCLES.PREPAID) {
  const normalized = String(value || "").trim().toUpperCase().replace(/-/g, "_");
  return Object.values(BILLING_CYCLES).includes(normalized) ? normalized : fallback;
}

function isPostpaidBilling(contact) {
  return isRecurringSubscription(contact)
    && normalizeBillingCycle(contact?.billingCycle) === BILLING_CYCLES.POSTPAID;
}

function isPrepaidPackage(contact) {
  return isRecurringSubscription(contact)
    && String(contact?.billingCycle || "").trim().toUpperCase() === BILLING_CYCLES.PREPAID;
}

function getContactBillingPeriod(contact, referencePeriod) {
  return isPostpaidBilling(contact)
    ? getPreviousBillingPeriod(referencePeriod.year, referencePeriod.month)
    : referencePeriod;
}

function isRecurringSubscription(contact) {
  return normalizeSubscriptionType(contact?.subscriptionType) === SUBSCRIPTION_TYPES.RECURRING;
}

function isOneTimeSubscriptionEnded(contact, period, timeZone = "Asia/Jakarta") {
  if (isRecurringSubscription(contact)) return false;
  const startPeriod = getContactBillingStartPeriod(contact, timeZone);
  return compareBillingPeriods(startPeriod, period) < 0;
}

function listBillingPeriods(start, end) {
  const periods = [];
  for (let period = start; compareBillingPeriods(period, end) <= 0; period = addBillingMonths(period, 1)) {
    periods.push(period);
  }
  return periods;
}

function parsePaymentAmountFromMessage(message) {
  const text = String(message || "");
  const match = text.match(/(?:sebesar\s*)?Rp\s*([0-9][0-9.\s]*(?:,[0-9]{1,2})?)/i);
  if (!match) return 0;
  const digits = match[1].replace(/[.\s]/g, "").replace(/,.*$/, "");
  const amount = Number(digits);
  return Number.isFinite(amount) && amount >= 0 && amount <= 1_000_000_000 ? Math.floor(amount) : 0;
}

const PAYMENT_TYPE_LABELS = {
  [PAYMENT_TYPES.ARREARS_ONLY]: "Hanya Tunggakan",
  [PAYMENT_TYPES.CURRENT_ONLY]: "Periode Tagihan",
  [PAYMENT_TYPES.FULL_PAID]: "Lunas Semua",
  [PAYMENT_TYPES.ACTIVE_PERIOD]: "Masa Aktif 1 Bulan",
};

function formatReportDate(value, includeTime = false, timeZone = "Asia/Jakarta") {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return new Intl.DateTimeFormat("id-ID", {
    timeZone,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    ...(includeTime ? { hour: "2-digit", minute: "2-digit" } : {}),
  }).format(date);
}

function styleReportSheet(sheet) {
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  sheet.autoFilter = { from: "A1", to: sheet.getRow(1).getCell(sheet.columnCount).address };
  sheet.getRow(1).eachCell((cell) => {
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF315C45" } };
    cell.alignment = { vertical: "middle", horizontal: "center" };
  });
  sheet.getRow(1).height = 24;
  sheet.columns.forEach((column) => {
    let maxLength = String(column.header || "").length;
    column.eachCell({ includeEmpty: true }, (cell) => {
      maxLength = Math.max(maxLength, String(cell.value ?? "").length);
    });
    column.width = Math.min(Math.max(maxLength + 2, 12), 42);
  });
}

// ===============================
// DATA MANAGER (Sequelize)
// ===============================

class DataManager {
  constructor(activityLog) {
    this.activityLog = activityLog;
    this.contacts = new Map();
    this.pelanggan = new Map();
    this.customerAccounts = new Map();
    this.paymentGatewayTransactions = new Map();
    this.reminders = new Map();
    this.sentReminders = new Map();
    this.voucherBatches = new Map();
    this.voucherRevenueEntries = new Map();
    this.roles = new Map();
    this.settings = { ...DEFAULT_SETTINGS };
    this.fileLocks = new Map();
    this.dataMutationLock = new AsyncLock();
    this.dbWriteLock = new AsyncLock();
    this.sequelize = null;
    this.models = {};
  }

  async initDirectories() {
    await fs.mkdir(CONFIG.DB_PATH, { recursive: true });
    if (!process.env.DATABASE_URL) {
      await fs.mkdir(path.dirname(CONFIG.DB_STORAGE), { recursive: true });
    }
    await fs.mkdir(CONFIG.TEMPLATE_PATH, { recursive: true });
    await fs.mkdir(CONFIG.PUBLIC_PATH, { recursive: true });
  }

  getTimezone() {
    const requested = this.settings?.timezone || DEFAULT_SETTINGS.timezone;
    return isValidTimeZone(requested) ? requested : DEFAULT_SETTINGS.timezone;
  }

  getPath(filename) {
    return path.join(CONFIG.DB_PATH, filename);
  }

  async initDatabase() {
    await this.initDirectories();

    if (this.sequelize) {
      return;
    }

    this.sequelize = process.env.DATABASE_URL
      ? new Sequelize(process.env.DATABASE_URL, {
          logging: false,
        })
      : new Sequelize({
          dialect: "sqlite",
          storage: CONFIG.DB_STORAGE,
          logging: false,
        });

    const jsonPayloadModel = (name, tableName, keyField) => this.sequelize.define(name, {
      [keyField]: {
        type: DataTypes.STRING,
        primaryKey: true,
      },
      data: {
        type: DataTypes.JSON,
        allowNull: false,
      },
    }, {
      tableName,
      timestamps: true,
    });

    this.models.Contact = jsonPayloadModel("Contact", "contacts", "id");
    this.models.Pelanggan = jsonPayloadModel("Pelanggan", "pelanggan", "username");
    this.models.CustomerAccount = jsonPayloadModel("CustomerAccount", "customer_accounts", "contactId");
    this.models.PaymentGatewayTransaction = jsonPayloadModel(
      "PaymentGatewayTransaction",
      "payment_gateway_transactions",
      "orderId"
    );
    this.models.Reminder = jsonPayloadModel("Reminder", "reminders", "id");
    this.models.SentReminder = jsonPayloadModel("SentReminder", "sent_reminders", "id");
    this.models.VoucherBatch = jsonPayloadModel("VoucherBatch", "voucher_batches", "batchId");
    this.models.VoucherRevenueEntry = jsonPayloadModel(
      "VoucherRevenueEntry",
      "voucher_revenue_entries",
      "id"
    );
    this.models.Role = this.sequelize.define("Role", {
      phoneNumber: {
        type: DataTypes.STRING,
        primaryKey: true,
      },
      role: {
        type: DataTypes.STRING,
        allowNull: false,
      },
    }, {
      tableName: "roles",
      timestamps: true,
    });
    this.models.Setting = this.sequelize.define("Setting", {
      key: {
        type: DataTypes.STRING,
        primaryKey: true,
      },
      value: {
        type: DataTypes.JSON,
        allowNull: false,
      },
    }, {
      tableName: "settings",
      timestamps: true,
    });

    await this.sequelize.authenticate();
    await this.configureDatabaseConnection();
    await this.sequelize.sync();
    if (!process.env.DATABASE_URL) {
      await fs.chmod(CONFIG.DB_STORAGE, 0o600);
    }
  }


  async configureDatabaseConnection() {
    if (process.env.DATABASE_URL) {
      return;
    }

    await this.sequelize.query(`PRAGMA busy_timeout = ${CONFIG.SQLITE_BUSY_TIMEOUT}`);
    await this.sequelize.query("PRAGMA journal_mode = WAL");
    await this.sequelize.query("PRAGMA synchronous = NORMAL");
    await this.sequelize.query("PRAGMA foreign_keys = ON");
  }

  async healthCheck() {
    if (!this.sequelize) {
      throw new Error("Database belum diinisialisasi.");
    }

    const timeout = Math.max(250, CONFIG.HEALTHCHECK_TIMEOUT);
    let timeoutId;
    try {
      await Promise.race([
        this.sequelize.authenticate(),
        new Promise((_, reject) => {
          timeoutId = setTimeout(() => reject(new Error("Database health check timeout.")), timeout);
          timeoutId.unref?.();
        }),
      ]);
      return true;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async close() {
    if (!this.sequelize) return;
    const sequelize = this.sequelize;
    await sequelize.close();
    this.sequelize = null;
  }

  async withDatabaseWrite(operation) {
    return this.dbWriteLock.runExclusive("database_write", operation);
  }

  async withDataMutation(operation) {
    return this.dataMutationLock.runExclusive("data_mutation", async () => {
      const snapshot = {
        contacts: structuredClone(this.contacts),
        pelanggan: structuredClone(this.pelanggan),
        customerAccounts: structuredClone(this.customerAccounts),
        paymentGatewayTransactions: structuredClone(this.paymentGatewayTransactions),
        reminders: structuredClone(this.reminders),
        sentReminders: structuredClone(this.sentReminders),
        voucherBatches: structuredClone(this.voucherBatches),
        voucherRevenueEntries: structuredClone(this.voucherRevenueEntries),
        roles: structuredClone(this.roles),
        settings: structuredClone(this.settings),
      };

      try {
        return await operation();
      } catch (error) {
        this.contacts = snapshot.contacts;
        this.pelanggan = snapshot.pelanggan;
        this.customerAccounts = snapshot.customerAccounts;
        this.paymentGatewayTransactions = snapshot.paymentGatewayTransactions;
        this.reminders = snapshot.reminders;
        this.sentReminders = snapshot.sentReminders;
        this.voucherBatches = snapshot.voucherBatches;
        this.voucherRevenueEntries = snapshot.voucherRevenueEntries;
        this.roles = snapshot.roles;
        this.settings = snapshot.settings;
        throw error;
      }
    });
  }

  async acquireLock(filePath) {
    const startTime = Date.now();
    while (this.fileLocks.has(filePath)) {
      if (Date.now() - startTime > CONFIG.MAX_LOCK_WAIT) {
        throw new Error(`Lock acquisition timeout for ${filePath}`);
      }
      await sleep(CONFIG.LOCK_POLL_INTERVAL);
    }
    this.fileLocks.set(filePath, true);
  }

  releaseLock(filePath) {
    this.fileLocks.delete(filePath);
  }

  async atomicWrite(filePath, data, maxRetries = 3) {
    await this.acquireLock(filePath);
    const tempPath = `${filePath}.tmp`;
    const backupPath = `${filePath}.bak`;

    try {
      for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
        try {
          await fs.copyFile(filePath, backupPath).catch(() => {});
          await fs.writeFile(tempPath, JSON.stringify(data, null, 2));
          JSON.parse(await fs.readFile(tempPath, "utf-8"));
          await fs.rename(tempPath, filePath);
          return;
        } catch (error) {
          this.activityLog.push("error", "storage", `Write attempt ${attempt} failed for ${path.basename(filePath)}`, { error: error.message });
          await fs.copyFile(backupPath, filePath).catch(() => {});
          if (attempt === maxRetries) throw error;
          await sleep(100 * attempt);
        }
      }
    } finally {
      this.releaseLock(filePath);
      await fs.unlink(tempPath).catch(() => {});
    }
  }

  async loadLegacyMapFromFile(filePath, keyField) {
    const readMap = async (candidatePath) => {
      const raw = await fs.readFile(candidatePath, "utf-8");
      if (!raw.trim()) return new Map();

      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return new Map();

      return new Map(
        arr
          .filter((item) => item && item[keyField])
          .map((item) => [String(item[keyField]), item])
      );
    };

    try {
      return await readMap(filePath);
    } catch (error) {
      if (error.code !== "ENOENT") {
        this.activityLog.push("error", "storage", `Failed to load ${path.basename(filePath)}`, {
          error: error.message,
        });
      }

      const backupPath = `${filePath}.bak`;
      try {
        return await readMap(backupPath);
      } catch {
        return new Map();
      }
    }
  }

  async loadLegacyRoles() {
    try {
      const raw = await fs.readFile(this.getPath("roles.json"), "utf-8");
      if (!raw.trim()) return new Map();
      return new Map(Object.entries(JSON.parse(raw)));
    } catch (error) {
      if (error.code === "ENOENT") return new Map();
      this.activityLog.push("error", "storage", "Failed to load roles.json", { error: error.message });
      return new Map();
    }
  }

  async loadLegacySettings() {
    try {
      const raw = await fs.readFile(this.getPath("settings.json"), "utf-8");
      if (!raw.trim()) return { ...DEFAULT_SETTINGS };
      const settings = { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
      delete settings.whatsappProvider;
      delete settings.hotspotReactivationMessageTemplate;
      return settings;
    } catch (error) {
      if (error.code === "ENOENT") return { ...DEFAULT_SETTINGS };
      this.activityLog.push("error", "storage", "Failed to load settings.json", { error: error.message });
      return { ...DEFAULT_SETTINGS };
    }
  }

  async loadJsonPayloadMap(model, keyField) {
    const rows = await model.findAll({ raw: true });
    return new Map(rows.map((row) => [String(row[keyField]), this.parseStoredJson(row.data, {})]));
  }

  parseStoredJson(value, fallback) {
    if (typeof value !== "string") {
      return value ?? fallback;
    }

    try {
      return JSON.parse(value);
    } catch {
      return fallback;
    }
  }

  async hasDatabaseData() {
    const counts = await Promise.all([
      this.models.Contact.count(),
      this.models.Pelanggan.count(),
      this.models.CustomerAccount.count(),
      this.models.PaymentGatewayTransaction.count(),
      this.models.Reminder.count(),
      this.models.SentReminder.count(),
      this.models.VoucherBatch.count(),
      this.models.VoucherRevenueEntry.count(),
      this.models.Role.count(),
      this.models.Setting.count(),
    ]);
    return counts.some((count) => count > 0);
  }

  async loadFromDatabase() {
    this.contacts = await this.loadJsonPayloadMap(this.models.Contact, "id");
    this.pelanggan = await this.loadJsonPayloadMap(this.models.Pelanggan, "username");
    this.customerAccounts = await this.loadJsonPayloadMap(this.models.CustomerAccount, "contactId");
    this.paymentGatewayTransactions = await this.loadJsonPayloadMap(
      this.models.PaymentGatewayTransaction,
      "orderId"
    );
    this.reminders = await this.loadJsonPayloadMap(this.models.Reminder, "id");
    this.sentReminders = await this.loadJsonPayloadMap(this.models.SentReminder, "id");
    this.voucherBatches = await this.loadJsonPayloadMap(this.models.VoucherBatch, "batchId");
    this.voucherRevenueEntries = await this.loadJsonPayloadMap(this.models.VoucherRevenueEntry, "id");

    const roleRows = await this.models.Role.findAll({ raw: true });
    this.roles = new Map(roleRows.map((row) => [String(row.phoneNumber), row.role]));

    const settingsRow = await this.models.Setting.findByPk("app", { raw: true });
    this.settings = { ...DEFAULT_SETTINGS, ...this.parseStoredJson(settingsRow?.value, {}) };
    if (Object.hasOwn(this.settings, "whatsappProvider")) {
      delete this.settings.whatsappProvider;
      await this.saveSettings();
    }
    if (Object.hasOwn(this.settings, "hotspotReactivationMessageTemplate")) {
      delete this.settings.hotspotReactivationMessageTemplate;
      await this.saveSettings();
    }
  }

  async loadFromLegacyJson() {
    this.contacts = await this.loadLegacyMapFromFile(this.getPath("contacts.json"), "id");
    this.pelanggan = await this.loadLegacyMapFromFile(this.getPath("pelanggan.json"), "username");
    this.customerAccounts = new Map();
    this.paymentGatewayTransactions = new Map();
    this.reminders = await this.loadLegacyMapFromFile(this.getPath("reminders.json"), "id");
    this.sentReminders = await this.loadLegacyMapFromFile(this.getPath("sent_reminders.json"), "id");
    this.voucherBatches = new Map();
    this.voucherRevenueEntries = new Map();
    this.roles = await this.loadLegacyRoles();
    this.settings = await this.loadLegacySettings();
  }

  async loadAll() {
    this.activityLog.push("info", "boot", "Loading persisted data with Sequelize");
    await this.initDatabase();

    if (await this.hasDatabaseData()) {
      await this.loadFromDatabase();
    } else {
      await this.loadFromLegacyJson();
      await this.saveAll();
      this.activityLog.push("info", "storage", "Legacy JSON data migrated into Sequelize database", {
        storage: process.env.DATABASE_URL ? "DATABASE_URL" : CONFIG.DB_STORAGE,
      });
    }

    this.normalizeLoadedContacts();
    await this.migrateOneTimeSubscriptionsToPrepaid();
    await this.migrateServiceSchedulesFromRegistration();
    const portalAccountsCreated = await this.synchronizeCustomerPortalAccounts();
    await this.normalizeReminderRelations();
    await this.removeNonRecurringReminders();
    await this.repairMissingRecurringReminders();
    await this.migrateReminderPaymentAmounts();
    await this.migrateReminderVariableTemplates();
    await this.migrateFormalNotificationTemplates();
    await this.migrateExistingPaidServiceSchedules();
    const migration = await migrateWhatsAppProviderMetadata(this);
    if (migration.remindersChanged || migration.sentChanged) {
      this.activityLog.push("info", "storage", "WhatsApp provider metadata migration selesai", migration);
    }
    await this.cleanupSentHistory();
    this.activityLog.push("info", "boot", "Data load complete", {
      contacts: this.contacts.size,
      pelanggan: this.pelanggan.size,
      customerAccounts: this.customerAccounts.size,
      paymentGatewayTransactions: this.paymentGatewayTransactions.size,
      reminders: this.reminders.size,
      sentReminders: this.sentReminders.size,
      voucherBatches: this.voucherBatches.size,
      voucherRevenueEntries: this.voucherRevenueEntries.size,
      adminRecipients: this.getAdminRecipients().length,
      portalAccountsCreated,
    });
  }

  async replaceJsonPayloadTable(model, keyField, values, options = {}) {
    const rows = Array.from(values).map((item) => ({
      [keyField]: String(item[keyField]),
      data: item,
    }));
    const transaction = options.transaction || null;

    await model.destroy({ where: {}, truncate: true, transaction });
    if (rows.length > 0) {
      await model.bulkCreate(rows, { transaction });
    }
  }

  async runSaveOperation(operation, options = {}) {
    if (options.transaction) {
      return operation(options.transaction);
    }

    return this.withDatabaseWrite(() => (
      this.sequelize.transaction((transaction) => operation(transaction))
    ));
  }

  async saveContacts(options = {}) {
    await this.runSaveOperation(
      (transaction) => this.replaceJsonPayloadTable(this.models.Contact, "id", this.contacts.values(), { transaction }),
      options
    );
  }

  async savePelanggan(options = {}) {
    await this.runSaveOperation(
      (transaction) => this.replaceJsonPayloadTable(this.models.Pelanggan, "username", this.pelanggan.values(), { transaction }),
      options
    );
  }

  async saveCustomerAccounts(options = {}) {
    if (!this.models.CustomerAccount) return;
    await this.runSaveOperation(
      (transaction) => this.replaceJsonPayloadTable(
        this.models.CustomerAccount,
        "contactId",
        this.customerAccounts.values(),
        { transaction }
      ),
      options
    );
  }

  async savePaymentGatewayTransactions(options = {}) {
    if (!this.models.PaymentGatewayTransaction) return;
    await this.runSaveOperation(
      (transaction) => this.replaceJsonPayloadTable(
        this.models.PaymentGatewayTransaction,
        "orderId",
        this.paymentGatewayTransactions.values(),
        { transaction }
      ),
      options
    );
  }

  async saveReminders(options = {}) {
    await this.runSaveOperation(
      (transaction) => this.replaceJsonPayloadTable(this.models.Reminder, "id", this.reminders.values(), { transaction }),
      options
    );
  }

  async saveSentReminders(options = {}) {
    await this.runSaveOperation(
      (transaction) => this.replaceJsonPayloadTable(this.models.SentReminder, "id", this.sentReminders.values(), { transaction }),
      options
    );
  }

  async saveVoucherBatches(options = {}) {
    if (!this.models.VoucherBatch) return;
    await this.runSaveOperation(
      (transaction) => this.replaceJsonPayloadTable(
        this.models.VoucherBatch,
        "batchId",
        this.voucherBatches.values(),
        { transaction }
      ),
      options
    );
  }

  async saveVoucherRevenueEntries(options = {}) {
    if (!this.models.VoucherRevenueEntry) return;
    await this.runSaveOperation(
      (transaction) => this.replaceJsonPayloadTable(
        this.models.VoucherRevenueEntry,
        "id",
        this.voucherRevenueEntries.values(),
        { transaction }
      ),
      options
    );
  }

  async upsertVoucherRevenueEntries(entries = [], options = {}) {
    if (!this.models.VoucherRevenueEntry) return;
    const transaction = options.transaction || null;
    for (const entry of entries) {
      await this.models.VoucherRevenueEntry.upsert({
        id: String(entry.id),
        data: entry,
      }, { transaction });
    }
  }

  getVoucherRevenueEntries() {
    return Array.from(this.voucherRevenueEntries.values()).map((entry) => structuredClone(entry));
  }

  hasVoucherRevenueEntries(ids = []) {
    return (Array.isArray(ids) ? ids : []).every((id) => this.voucherRevenueEntries.has(String(id)));
  }

  getVoucherRevenueReport(period) {
    const safePeriod = sanitizeInput(String(period || ""));
    if (!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(safePeriod)) {
      throw new Error("Periode laporan voucher tidak valid.");
    }
    return buildVoucherRevenueReport(this.voucherRevenueEntries.values(), safePeriod);
  }

  async storeVoucherRevenueEntries(entries = []) {
    const validEntries = (Array.isArray(entries) ? entries : []).filter((entry) => (
      entry?.id
      && entry?.username
      && entry?.profile
      && /^\d{4}-(?:0[1-9]|1[0-2])$/.test(String(entry.period || ""))
      && !Number.isNaN(new Date(entry.usedAt).getTime())
    ));
    if (validEntries.length === 0) {
      return { saved: 0, total: this.voucherRevenueEntries.size, batchesUpdated: 0 };
    }

    return this.withDataMutation(async () => {
      let batchesUpdated = 0;
      const changedEntries = [];
      for (const sourceEntry of validEntries) {
        const id = String(sourceEntry.id);
        const existing = this.voucherRevenueEntries.get(id) || {};
        const entry = {
          ...existing,
          id,
          username: sanitizeInput(String(sourceEntry.username || "")),
          profile: sanitizeInput(String(sourceEntry.profile || "")),
          amount: Math.max(0, Number(sourceEntry.amount) || 0),
          costPrice: Math.max(0, Number(sourceEntry.costPrice) || 0),
          commission: Math.max(0, Number(sourceEntry.commission) || 0),
          usedAt: new Date(sourceEntry.usedAt).toISOString(),
          period: String(sourceEntry.period),
          validity: sanitizeInput(String(sourceEntry.validity || "")),
          address: sanitizeInput(String(sourceEntry.address || "")),
          macAddress: sanitizeInput(String(sourceEntry.macAddress || "")),
          batchId: sanitizeInput(String(sourceEntry.batchId || "")),
          storedAt: existing.storedAt || new Date().toISOString(),
        };
        if (JSON.stringify(existing) !== JSON.stringify(entry)) {
          this.voucherRevenueEntries.set(id, entry);
          changedEntries.push(entry);
        }

        const batch = entry.batchId ? this.voucherBatches.get(entry.batchId) : null;
        if (!batch || !Array.isArray(batch.vouchers)) continue;
        let changed = false;
        const vouchers = batch.vouchers.map((voucher) => {
          if (String(voucher.username || "").toLowerCase() !== entry.username.toLowerCase()) return voucher;
          if (voucher.used === true && voucher.usedAt === entry.usedAt && voucher.usageStatus === "USED") return voucher;
          changed = true;
          return { ...voucher, used: true, usageStatus: "USED", usedAt: entry.usedAt };
        });
        if (changed) {
          batchesUpdated += 1;
          this.voucherBatches.set(entry.batchId, { ...batch, vouchers, updatedAt: new Date().toISOString() });
        }
      }

      if (changedEntries.length > 0 || batchesUpdated > 0) {
        await this.withDatabaseWrite(() => this.sequelize.transaction(async (transaction) => {
          const options = { transaction };
          if (changedEntries.length > 0) await this.upsertVoucherRevenueEntries(changedEntries, options);
          if (batchesUpdated > 0) await this.saveVoucherBatches(options);
        }));
      }
      return {
        saved: changedEntries.length,
        observed: validEntries.length,
        total: this.voucherRevenueEntries.size,
        batchesUpdated,
      };
    });
  }

  getVoucherBatches(limit = 50) {
    const safeLimit = limit === "all"
      ? Number.POSITIVE_INFINITY
      : Math.min(100, Math.max(1, Number(limit) || 50));
    return Array.from(this.voucherBatches.values())
      .sort((a, b) => (
        new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime()
        || String(b.batchId).localeCompare(String(a.batchId), "id-ID")
      ))
      .slice(0, safeLimit)
      .map((batch) => structuredClone(batch));
  }

  getVoucherBatch(batchId) {
    const batch = this.voucherBatches.get(String(batchId || ""));
    return batch ? structuredClone(batch) : null;
  }

  async storeVoucherBatches(batches = []) {
    const validBatches = (Array.isArray(batches) ? batches : [])
      .filter((batch) => batch?.batchId && Array.isArray(batch.vouchers));
    if (!validBatches.length) return { saved: 0, total: this.voucherBatches.size };
    return this.withDataMutation(async () => {
      for (const batch of validBatches) {
        const batchId = String(batch.batchId);
        const existing = this.voucherBatches.get(batchId) || {};
        const incoming = structuredClone(batch);
        const vouchersByUsername = new Map(
          (Array.isArray(existing.vouchers) ? existing.vouchers : [])
            .map((voucher) => [String(voucher.username || "").toLowerCase(), structuredClone(voucher)])
            .filter(([username]) => username)
        );
        for (const voucher of incoming.vouchers) {
          const username = String(voucher.username || "").toLowerCase();
          if (!username) continue;
          const previous = vouchersByUsername.get(username) || {};
          vouchersByUsername.set(username, {
            ...previous,
            ...voucher,
            password: previous.password || voucher.password || "",
          });
        }
        const vouchers = Array.from(vouchersByUsername.values());
        this.voucherBatches.set(batchId, {
          ...existing,
          ...incoming,
          batchId,
          vouchers,
          quantity: vouchers.length,
          generationType: vouchers.length === 1 ? "SINGLE" : "BULK",
          sellingPrice: Math.max(0, Number(existing.sellingPrice || batch.sellingPrice) || 0),
          storedAt: existing.storedAt || new Date().toISOString(),
        });
      }
      await this.saveVoucherBatches();
      return { saved: validBatches.length, total: this.voucherBatches.size };
    });
  }

  async removeVoucherFromBatch(batchId, username) {
    const safeBatchId = String(batchId || "");
    const safeUsername = String(username || "").toLowerCase();
    return this.withDataMutation(async () => {
      const batch = this.voucherBatches.get(safeBatchId);
      if (!batch) throw new Error("Batch voucher tidak ditemukan di riwayat aplikasi.");
      const vouchers = Array.isArray(batch.vouchers) ? batch.vouchers : [];
      const remainingVouchers = vouchers.filter((voucher) => (
        String(voucher.username || "").toLowerCase() !== safeUsername
      ));
      if (remainingVouchers.length === vouchers.length) {
        throw new Error("Voucher tidak ditemukan di batch yang dipilih.");
      }

      if (remainingVouchers.length === 0) {
        this.voucherBatches.delete(safeBatchId);
      } else {
        this.voucherBatches.set(safeBatchId, {
          ...batch,
          vouchers: remainingVouchers,
          quantity: remainingVouchers.length,
          generationType: remainingVouchers.length === 1 ? "SINGLE" : "BULK",
          updatedAt: new Date().toISOString(),
        });
      }
      await this.saveVoucherBatches();
      return {
        batchId: safeBatchId,
        username,
        batchRemoved: remainingVouchers.length === 0,
        remaining: remainingVouchers.length,
      };
    });
  }

  async cleanupSentHistory(options = {}) {
    return this.withDataMutation(async () => this.cleanupSentHistoryUnlocked(options));
  }

  async cleanupSentHistoryUnlocked(options = {}) {
    const retentionMonths = Number(options.retentionMonths || CONFIG.SENT_HISTORY_RETENTION_MONTHS);
    if (!Number.isFinite(retentionMonths) || retentionMonths <= 0) {
      return { deleted: 0, cutoff: null, remaining: this.sentReminders.size };
    }

    const cutoffDate = options.cutoffDate || addMonthsSafely(new Date(), -retentionMonths, this.getTimezone());
    const cutoffTime = cutoffDate.getTime();
    if (Number.isNaN(cutoffTime)) {
      return { deleted: 0, cutoff: null, remaining: this.sentReminders.size };
    }

    const deletedIds = [];
    for (const [id, reminder] of this.sentReminders.entries()) {
      const sentDate = new Date(reminder?.sentAt || reminder?.reminderDateTime);
      if (Number.isNaN(sentDate.getTime())) continue;
      if (sentDate.getTime() < cutoffTime) {
        deletedIds.push(id);
      }
    }

    for (const id of deletedIds) {
      this.sentReminders.delete(id);
    }

    if (deletedIds.length > 0) {
      await this.saveSentReminders();
      this.activityLog.push("info", "storage", `Sent History auto-clean removed ${deletedIds.length} old item(s)`, {
        retentionMonths,
        cutoff: cutoffDate.toISOString(),
      });
    }

    return {
      deleted: deletedIds.length,
      cutoff: cutoffDate.toISOString(),
      remaining: this.sentReminders.size,
    };
  }

  async saveRoles(options = {}) {
    await this.runSaveOperation(async (transaction) => {
      const rows = Array.from(this.roles.entries()).map(([phoneNumber, role]) => ({ phoneNumber, role }));
      await this.models.Role.destroy({ where: {}, truncate: true, transaction });
      if (rows.length > 0) {
        await this.models.Role.bulkCreate(rows, { transaction });
      }
    }, options);
  }

  async saveSettings(options = {}) {
    await this.runSaveOperation((transaction) => (
      this.models.Setting.upsert({
        key: "app",
        value: this.settings,
      }, { transaction })
    ), options);
  }

  normalizeLoadedContacts() {
    for (const contact of this.contacts.values()) {
      contact.paymentStatus = String(contact.paymentStatus || PAYMENT_STATUS.UNPAID).toUpperCase();
      const normalizedType = String(contact.paymentType || "").toUpperCase();
      contact.paymentType = Object.values(PAYMENT_TYPES).includes(normalizedType) ? normalizedType : null;
      contact.monthlyPaymentAmount = sanitizePositiveInteger(
        contact.monthlyPaymentAmount,
        0,
        0,
        1_000_000_000
      );
      // Data lama belum memiliki penanda ini dan tetap mengikuti tarif profile.
      contact.monthlyPaymentAmountCustomized = parseBoolean(
        contact.monthlyPaymentAmountCustomized,
        false
      );
      contact.subscriptionType = normalizeSubscriptionType(contact.subscriptionType);
      contact.billingCycle = normalizeBillingCycle(contact.billingCycle);
      delete contact.recurringBillingStartedAt;
      contact.subscriptionChangedByArrears = parseBoolean(
        contact.subscriptionChangedByArrears,
        false
      );
      contact.arrearsSubscriptionDebtPeriods = Array.from(new Set(
        (Array.isArray(contact.arrearsSubscriptionDebtPeriods)
          ? contact.arrearsSubscriptionDebtPeriods
          : [])
          .map(String)
          .filter((period) => /^\d{4}-\d{2}$/.test(period))
      ));
      contact.billingPausedForArrears = parseBoolean(contact.billingPausedForArrears, false);
      contact.billingPausedAfterPeriod = /^\d{4}-\d{2}$/.test(String(contact.billingPausedAfterPeriod || ""))
        ? String(contact.billingPausedAfterPeriod)
        : null;
      contact.hotspotSuspendedForArrears = parseBoolean(contact.hotspotSuspendedForArrears, false);
      contact.hotspotManualActivationWithArrears = parseBoolean(
        contact.hotspotManualActivationWithArrears,
        false
      );
      if (isPrepaidPackage(contact)) {
        contact.billingPausedForArrears = false;
        contact.billingPausedAfterPeriod = null;
        contact.hotspotSuspendedForArrears = false;
        contact.hotspotManualActivationWithArrears = false;
      }
      contact.activePeriodPurchases = (Array.isArray(contact.activePeriodPurchases)
        ? contact.activePeriodPurchases
        : [])
        .map((purchase) => {
          const id = sanitizeInput(String(purchase?.id || ""));
          const purchasedAt = this.normalizeOptionalDate(purchase?.purchasedAt);
          const activeFrom = this.normalizeOptionalDate(purchase?.activeFrom);
          const activeUntil = this.normalizeOptionalDate(purchase?.activeUntil);
          const amount = sanitizePositiveInteger(purchase?.amount, 0, 0, 1_000_000_000);
          if (!id || !purchasedAt || !activeFrom || !activeUntil || amount <= 0) return null;
          return {
            id,
            paymentType: PAYMENT_TYPES.ACTIVE_PERIOD,
            status: PAYMENT_STATUS.PAID,
            amount,
            purchasedAt,
            activeFrom,
            activeUntil,
            paymentProvider: sanitizeInput(String(purchase?.paymentProvider || "manual")) || "manual",
          };
        })
        .filter(Boolean);
      contact.linkedApHost = sanitizeInput(String(contact.linkedApHost || ""));
      contact.mikrotikMacAddresses = normalizeMacAddresses(
        contact.mikrotikMacAddresses || contact.mikrotikMacAddress
      );
      contact.hotspotAccessMode = getContactHotspotAccessMode(contact);
      contact.ipBindingBandwidthStatus = normalizeIpBindingBandwidthStatus(
        contact.ipBindingBandwidthStatus,
        contact.mikrotikMacAddresses.length > 0
          ? IP_BINDING_BANDWIDTH_STATUS.PENDING_DHCP
          : IP_BINDING_BANDWIDTH_STATUS.NONE
      );
      contact.ipBindingBandwidthRateLimit = sanitizeInput(String(contact.ipBindingBandwidthRateLimit || ""));
      contact.ipBindingBandwidthTargetAddresses = normalizeQueueTarget(contact.ipBindingBandwidthTargetAddresses);
      contact.ipBindingBandwidthPendingMacAddresses = normalizeMacAddresses(
        contact.ipBindingBandwidthPendingMacAddresses
      ).filter((macAddress) => contact.mikrotikMacAddresses.includes(macAddress));
      contact.ipBindingBandwidthDevices = (Array.isArray(contact.ipBindingBandwidthDevices)
        ? contact.ipBindingBandwidthDevices
        : [])
        .map((device) => {
          let macAddress;
          try {
            macAddress = normalizeMacAddress(device?.macAddress);
          } catch (_error) {
            return null;
          }
          if (!macAddress || !contact.mikrotikMacAddresses.includes(macAddress)) return null;
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
      contact.ipBindingBandwidthError = sanitizeInput(String(contact.ipBindingBandwidthError || ""));
      contact.ipBindingBandwidthLastSyncedAt = this.normalizeOptionalDate(contact.ipBindingBandwidthLastSyncedAt);
      contact.ipBindingBandwidthQueueName = sanitizeInput(String(contact.ipBindingBandwidthQueueName || ""));
      delete contact.mikrotikAccessMethod;
      delete contact.mikrotikMacAddress;
      contact.mikrotikUsername = sanitizeInput(String(contact.mikrotikUsername || ""));
      contact.mikrotikProfile = sanitizeInput(String(contact.mikrotikProfile || ""));
      contact.mikrotikPassword = sanitizeInput(String(contact.mikrotikPassword || ""));
      const inferredProvisioningStatus = contact.mikrotikUsername && contact.mikrotikProfile
        ? HOTSPOT_PROVISIONING_STATUS.ACTIVE
        : HOTSPOT_PROVISIONING_STATUS.NONE;
      contact.hotspotProvisioningStatus = normalizeHotspotProvisioningStatus(
        contact.hotspotProvisioningStatus,
        inferredProvisioningStatus
      );
      contact.hotspotProvisioningError = sanitizeInput(String(contact.hotspotProvisioningError || ""));
      contact.hotspotLastCheckedAt = this.normalizeOptionalDate(contact.hotspotLastCheckedAt);
      contact.hotspotLastSyncedAt = this.normalizeOptionalDate(contact.hotspotLastSyncedAt);
      contact.hotspotSendCredentials = parseBoolean(contact.hotspotSendCredentials, false);
      const previousProvisioning = contact.hotspotProvisioningPrevious;
      if (previousProvisioning && typeof previousProvisioning === "object") {
        const previousUsername = sanitizeInput(String(previousProvisioning.username || ""));
        contact.hotspotProvisioningPrevious = previousUsername ? {
          username: previousUsername,
          profile: sanitizeInput(String(previousProvisioning.profile || "")),
          password: sanitizeInput(String(previousProvisioning.password || "")),
          phoneNumber: normalizePhoneNumber(previousProvisioning.phoneNumber),
        } : null;
      } else {
        contact.hotspotProvisioningPrevious = null;
      }
      const inferredOperation = contact.hotspotProvisioningPrevious
        ? HOTSPOT_PROVISIONING_OPERATION.UPDATE
        : ([HOTSPOT_PROVISIONING_STATUS.PENDING, HOTSPOT_PROVISIONING_STATUS.PROVISIONING, HOTSPOT_PROVISIONING_STATUS.FAILED]
          .includes(contact.hotspotProvisioningStatus) && contact.mikrotikUsername
          ? HOTSPOT_PROVISIONING_OPERATION.CREATE
          : HOTSPOT_PROVISIONING_OPERATION.NONE);
      contact.hotspotProvisioningOperation = normalizeHotspotProvisioningOperation(
        contact.hotspotProvisioningOperation,
        inferredOperation
      );
      if (contact.hotspotProvisioningStatus === HOTSPOT_PROVISIONING_STATUS.PROVISIONING) {
        contact.hotspotProvisioningStatus = HOTSPOT_PROVISIONING_STATUS.PENDING;
        contact.hotspotProvisioningError = contact.hotspotProvisioningError
          || "Provisioning terputus saat aplikasi berhenti. Silakan coba lagi.";
      }
      contact.hotspotReactivationEnabled = parseBoolean(contact.hotspotReactivationEnabled, false);
      contact.hotspotReactivationAt = this.normalizeOptionalDate(contact.hotspotReactivationAt);
      if (!isRecurringSubscription(contact)) {
        contact.hotspotReactivationEnabled = false;
        contact.billingPausedForArrears = false;
        contact.billingPausedAfterPeriod = null;
        contact.hotspotSuspendedForArrears = false;
        contact.hotspotManualActivationWithArrears = false;
      }
      contact.hotspotLastReactivatedAt = this.normalizeOptionalDate(contact.hotspotLastReactivatedAt);
      contact.hotspotLastDeactivatedAt = this.normalizeOptionalDate(contact.hotspotLastDeactivatedAt);
      // Notifikasi WhatsApp setelah reaktivasi sudah tidak digunakan.
      contact.hotspotNotificationPending = null;
      if (!contact.paymentMonths || typeof contact.paymentMonths !== "object" || Array.isArray(contact.paymentMonths)) {
        contact.paymentMonths = {};
      }

      if (contact.paymentStatus === PAYMENT_STATUS.PAID && contact.paymentDate) {
        const paidDate = new Date(contact.paymentDate);
        if (!Number.isNaN(paidDate.getTime())) {
          const key = getBillingPeriodKey(paidDate, this.getTimezone());
          if (!contact.paymentMonths[key]) {
            contact.paymentMonths[key] = {
              status: PAYMENT_STATUS.PAID,
              paidDate: paidDate.toISOString(),
              paymentType: contact.paymentType,
              paidAmount: Math.max(0, Math.floor(Number(contact.monthlyPaymentAmount) || 0)),
            };
          }
        }
      }
    }

    for (const pelanggan of this.pelanggan.values()) {
      const contact = pelanggan.contactId ? this.getContact(pelanggan.contactId) : null;
      const inferredStatus = pelanggan.username && pelanggan.profile
        ? HOTSPOT_PROVISIONING_STATUS.ACTIVE
        : HOTSPOT_PROVISIONING_STATUS.NONE;
      pelanggan.hotspotProvisioningStatus = normalizeHotspotProvisioningStatus(
        pelanggan.hotspotProvisioningStatus || contact?.hotspotProvisioningStatus,
        inferredStatus
      );
      if (pelanggan.hotspotProvisioningStatus === HOTSPOT_PROVISIONING_STATUS.PROVISIONING) {
        pelanggan.hotspotProvisioningStatus = HOTSPOT_PROVISIONING_STATUS.PENDING;
      }
      pelanggan.hotspotProvisioningError = sanitizeInput(String(
        pelanggan.hotspotProvisioningError || contact?.hotspotProvisioningError || ""
      ));
      pelanggan.hotspotLastCheckedAt = this.normalizeOptionalDate(
        pelanggan.hotspotLastCheckedAt || contact?.hotspotLastCheckedAt
      );
      pelanggan.hotspotLastSyncedAt = this.normalizeOptionalDate(
        pelanggan.hotspotLastSyncedAt || contact?.hotspotLastSyncedAt
      );
    }
  }

  async migrateOneTimeSubscriptionsToPrepaid(options = {}) {
    const requestedAt = options.now ? new Date(options.now) : new Date();
    const now = Number.isNaN(requestedAt.getTime()) ? new Date() : requestedAt;
    const updatedAt = now.toISOString();
    let migrated = 0;
    let purchasesMigrated = 0;

    for (const contact of this.contacts.values()) {
      if (normalizeSubscriptionType(contact.subscriptionType) !== SUBSCRIPTION_TYPES.ONE_TIME) continue;

      const storedSchedule = this.normalizeOptionalDate(contact.hotspotReactivationAt);
      const scheduleDate = storedSchedule ? new Date(storedSchedule) : null;
      const packageActive = Boolean(
        scheduleDate
        && Number.isFinite(scheduleDate.getTime())
        && scheduleDate.getTime() > now.getTime()
      );
      const paidDates = Object.values(contact.paymentMonths || {})
        .filter((payment) => payment?.status === PAYMENT_STATUS.PAID && payment.paidDate)
        .map((payment) => new Date(payment.paidDate))
        .filter((date) => Number.isFinite(date.getTime()))
        .sort((left, right) => right.getTime() - left.getTime());
      const storedPaymentDate = contact.paymentDate ? new Date(contact.paymentDate) : null;
      const paidAt = paidDates[0]
        || (storedPaymentDate && Number.isFinite(storedPaymentDate.getTime()) ? storedPaymentDate : null);
      const amount = Math.max(0, Math.floor(Number(contact.monthlyPaymentAmount) || 0));
      const migrationId = `MIG-ONE-TIME-${contact.id}`;

      contact.subscriptionType = SUBSCRIPTION_TYPES.RECURRING;
      contact.billingCycle = BILLING_CYCLES.PREPAID;
      contact.subscriptionChangedByArrears = false;
      contact.arrearsSubscriptionDebtPeriods = [];
      contact.billingPausedForArrears = false;
      contact.billingPausedAfterPeriod = null;
      contact.hotspotSuspendedForArrears = false;
      contact.hotspotManualActivationWithArrears = false;
      contact.hotspotReactivationEnabled = packageActive;
      contact.hotspotReactivationAt = packageActive ? storedSchedule : null;
      contact.paymentStatus = packageActive ? PAYMENT_STATUS.PAID : PAYMENT_STATUS.UNPAID;
      contact.paymentDate = packageActive && paidAt ? paidAt.toISOString() : null;
      contact.paymentType = packageActive ? PAYMENT_TYPES.ACTIVE_PERIOD : null;
      contact.subscriptionMigratedFromOneTimeAt = updatedAt;
      contact.updatedAt = updatedAt;

      if (paidAt && amount > 0) {
        if (!Array.isArray(contact.activePeriodPurchases)) contact.activePeriodPurchases = [];
        const existing = contact.activePeriodPurchases.some((purchase) => String(purchase.id) === migrationId);
        if (!existing) {
          const historicalActiveUntil = packageActive
            ? storedSchedule
            : addMonthsSafely(paidAt, 1, this.getTimezone()).toISOString();
          contact.activePeriodPurchases.push({
            id: migrationId,
            paymentType: PAYMENT_TYPES.ACTIVE_PERIOD,
            status: PAYMENT_STATUS.PAID,
            amount,
            purchasedAt: paidAt.toISOString(),
            activeFrom: paidAt.toISOString(),
            activeUntil: historicalActiveUntil,
            paymentProvider: "migration",
          });
          purchasesMigrated += 1;
        }
      }
      migrated += 1;
    }

    if (migrated > 0 && options.save !== false) {
      await this.saveContacts();
      this.activityLog.push("info", "storage", `${migrated} pelanggan lama dikonversi ke bulanan prabayar`, {
        migration: "one-time-to-prepaid-v1",
        migrated,
        purchasesMigrated,
      });
    }

    return { migrated, purchasesMigrated };
  }

  getContactRegistrationAt(contact) {
    const pelanggan = this.pelanggan.get(String(contact.mikrotikUsername || ""))
      || Array.from(this.pelanggan.values()).find(
        (item) => String(item.contactId || "") === String(contact.id)
      )
      || null;
    const candidates = [contact.createdAt, pelanggan?.tanggalDaftar]
      .map((value) => new Date(value || ""))
      .filter((date) => !Number.isNaN(date.getTime()))
      .sort((a, b) => a.getTime() - b.getTime());
    return candidates[0] || null;
  }

  getNextServiceScheduleFromRegistration(contact, options = {}) {
    const registrationAt = options.registrationAt
      ? new Date(options.registrationAt)
      : this.getContactRegistrationAt(contact);
    if (!registrationAt || Number.isNaN(registrationAt.getTime())) return null;

    const now = options.now ? new Date(options.now) : new Date();
    let schedule = addMonthsSafely(registrationAt, 1, this.getTimezone());
    if (Number.isNaN(now.getTime())) return schedule.toISOString();
    while (schedule.getTime() <= now.getTime()) {
      schedule = addMonthsSafely(schedule, 1, this.getTimezone());
    }
    return schedule.toISOString();
  }

  async migrateServiceSchedulesFromRegistration(options = {}) {
    return this.withDataMutation(async () => {
      const settings = this.getSettings();
      if (Number(settings.serviceScheduleAnchorMigrationVersion) >= 1) {
        return { migrated: 0, skipped: 0, version: 1 };
      }

      let migrated = 0;
      let skipped = 0;
      const updatedAt = new Date().toISOString();
      for (const contact of this.contacts.values()) {
        if (contact.subscriptionMigratedFromOneTimeAt) {
          skipped += 1;
          continue;
        }
        const schedule = this.getNextServiceScheduleFromRegistration(contact, options);
        if (!schedule) {
          skipped += 1;
          continue;
        }

        const hadSchedule = Boolean(contact.hotspotReactivationAt);
        contact.hotspotReactivationAt = schedule;
        if (!hadSchedule) {
          contact.hotspotReactivationEnabled = isRecurringSubscription(contact);
        } else if (!isRecurringSubscription(contact)) {
          contact.hotspotReactivationEnabled = false;
        }
        contact.updatedAt = updatedAt;
        migrated += 1;
      }

      this.settings = {
        ...settings,
        serviceScheduleAnchorMigrationVersion: 1,
      };
      await this.withDatabaseWrite(() => this.sequelize.transaction(async (transaction) => {
        const saveOptions = { transaction };
        if (migrated > 0) await this.saveContacts(saveOptions);
        await this.saveSettings(saveOptions);
      }));
      this.activityLog.push("info", "storage", `Jadwal layanan ${migrated} pelanggan diselaraskan dengan waktu registrasi pertama`, {
        migration: "service-schedule-registration-anchor-v1",
        migrated,
        skipped,
      });
      return { migrated, skipped, version: 1 };
    });
  }

  async synchronizeCustomerPortalAccounts(options = {}) {
    let created = 0;
    const now = new Date().toISOString();

    for (const contact of this.contacts.values()) {
      const hotspotRecord = Array.from(this.pelanggan.values()).find(
        (item) => String(item.contactId || "") === String(contact.id)
      );
      const hotspotUsername = sanitizeInput(String(contact.mikrotikUsername || hotspotRecord?.username || ""));
      const hotspotPassword = sanitizeInput(String(contact.mikrotikPassword || hotspotRecord?.password || ""));
      const existing = this.customerAccounts.get(String(contact.id)) || null;
      if (!existing && (!hotspotUsername || !hotspotPassword)) continue;

      const preferredPortalUsername = sanitizeInput(String(existing?.username || hotspotUsername));
      const portalUsername = this.getUniqueCustomerPortalUsername(preferredPortalUsername, contact.id);
      const portalPassword = sanitizeInput(String(existing?.password || hotspotPassword));
      if (!portalUsername || !portalPassword) continue;

      const customerAccount = {
        ...(existing || {}),
        contactId: String(contact.id),
        username: portalUsername,
        password: portalPassword,
        createdAt: existing?.createdAt || contact.createdAt || now,
        updatedAt: existing?.updatedAt || contact.updatedAt || now,
      };
      const changed = !existing || JSON.stringify(existing) !== JSON.stringify(customerAccount);
      this.customerAccounts.set(String(contact.id), customerAccount);
      if (changed) created += 1;
    }

    if (created > 0 && this.sequelize && options.save !== false) {
      await this.saveCustomerAccounts();
      this.activityLog.push("info", "storage", `${created} akun portal pelanggan disinkronkan dari data pelanggan lama`);
    }

    return created;
  }

  getUniqueCustomerPortalUsername(preferred, contactId) {
    const base = sanitizeInput(preferred) || `pelanggan_${String(contactId || "").slice(-6)}`;
    const normalized = base.toLowerCase();
    const owner = Array.from(this.customerAccounts.values()).find(
      (item) => String(item.username || "").toLowerCase() === normalized
        && String(item.contactId || "") !== String(contactId || "")
    );
    if (!owner) return base;

    const contact = this.getContact(contactId);
    const suffix = normalizePhoneNumber(contact?.phoneNumber || "").slice(-4) || "akun";
    let candidate = `${base}_${suffix}`;
    let counter = 2;
    while (Array.from(this.customerAccounts.values()).some(
      (item) => String(item.username || "").toLowerCase() === candidate.toLowerCase()
        && String(item.contactId || "") !== String(contactId || "")
    )) {
      candidate = `${base}_${suffix}_${counter}`;
      counter += 1;
    }
    return candidate;
  }

  findCustomerPortalAccount(username) {
    const normalized = sanitizeInput(String(username || "")).toLowerCase();
    if (!normalized) return null;

    const account = Array.from(this.customerAccounts.values()).find(
      (item) => String(item.username || "").toLowerCase() === normalized
    );
    if (!account?.contactId || !account.password) return null;

    return this.getCustomerPortalAccountByContactId(account.contactId);
  }

  getCustomerPortalAccountByContactId(contactId) {
    const contact = this.getContact(contactId);
    if (!contact) return null;
    const account = this.customerAccounts.get(String(contact.id));
    if (!account?.username || !account.password) return null;
    const pelanggan = Array.from(this.pelanggan.values()).find(
      (item) => String(item.contactId || "") === String(contact.id)
    );
    return { account, pelanggan, contact };
  }

  getCustomerPortalData(contactId) {
    const contact = this.getContact(contactId);
    if (!contact) return null;
    const hydrated = this.hydrateContact(contact);
    const portalAccount = this.customerAccounts.get(String(contact.id));
    if (!portalAccount) return null;
    const hotspotAccount = Array.from(this.pelanggan.values()).find(
      (item) => String(item.contactId || "") === String(contact.id)
    );
    const hotspotStatus = normalizeHotspotProvisioningStatus(
      contact.hotspotProvisioningStatus || hotspotAccount?.hotspotProvisioningStatus,
      contact.mikrotikUsername || hotspotAccount?.username
        ? HOTSPOT_PROVISIONING_STATUS.ACTIVE
        : HOTSPOT_PROVISIONING_STATUS.NONE
    );

    const timeZone = this.getTimezone();
    const { year, month } = getBillingPeriodParts(new Date(), timeZone);
    const currentKey = hydrated.billingPeriodKey || makeBillingPeriodKey(year, month);
    const monthlyAmount = Math.max(0, Number(hydrated.monthlyPaymentAmount) || 0);
    const currentPaymentStatus = hydrated.currentPaymentStatus || hydrated.paymentStatus || PAYMENT_STATUS.UNPAID;
    const prepaidPackage = isPrepaidPackage(contact);
    const currentAmount = prepaidPackage
      ? monthlyAmount
      : (currentPaymentStatus === PAYMENT_STATUS.PAID ? 0 : monthlyAmount);
    const debtAmount = Math.max(0, Number(hydrated.debtAmount) || 0);
    const includeHistoryPeriod = (period) => !isPostpaidBilling(contact) || period <= currentKey;
    const historyByPeriod = new Map(
      Object.entries(hydrated.paymentMonths || {})
        .filter(([period]) => !prepaidPackage
          && /^\d{4}-\d{2}$/.test(period)
          && includeHistoryPeriod(period))
        .map(([period, payment]) => {
          const paidAmount = this.getPaymentPaidAmount(payment, monthlyAmount);
          return [period, {
            period,
            label: formatBillingPeriodLabel(Number(period.slice(0, 4)), Number(period.slice(5, 7))),
            status: payment?.status || PAYMENT_STATUS.UNPAID,
            paidDate: payment?.paidDate || null,
            lastPaymentDate: payment?.lastPaymentDate || payment?.paidDate || null,
            paymentType: payment?.paymentType || null,
            paidAmount,
            remainingAmount: this.getPaymentRemainingAmount(payment, monthlyAmount),
          }];
        })
    );
    for (const debtPeriod of hydrated.debtPeriods || []) {
      if (!historyByPeriod.has(debtPeriod.key)) {
        historyByPeriod.set(debtPeriod.key, {
          period: debtPeriod.key,
          label: debtPeriod.label,
          status: PAYMENT_STATUS.UNPAID,
          paidDate: null,
          lastPaymentDate: null,
          paymentType: null,
          paidAmount: debtPeriod.paidAmount || 0,
          remainingAmount: debtPeriod.remainingAmount ?? monthlyAmount,
        });
      }
    }
    const billingStartPeriod = getContactBillingStartPeriod(contact, timeZone);
    const [currentBillingYear, currentBillingMonth] = currentKey.split("-").map(Number);
    const currentBillingStarted = compareBillingPeriods(
      billingStartPeriod,
      { year: currentBillingYear, month: currentBillingMonth }
    ) <= 0;
    const includeCurrentPeriod = (isRecurringSubscription(contact) && currentBillingStarted)
      || (billingStartPeriod.year === year && billingStartPeriod.month === month)
      || historyByPeriod.has(currentKey);
    if (!prepaidPackage && includeCurrentPeriod && !historyByPeriod.has(currentKey)) {
      historyByPeriod.set(currentKey, {
        period: currentKey,
        label: formatBillingPeriodLabel(currentBillingYear, currentBillingMonth),
        status: currentPaymentStatus,
        paidDate: hydrated.paymentDate || null,
        lastPaymentDate: hydrated.paymentDate || null,
        paymentType: hydrated.paymentType || null,
        paidAmount: currentPaymentStatus === PAYMENT_STATUS.PAID ? monthlyAmount : 0,
        remainingAmount: currentAmount,
      });
    }
    const activePeriodHistory = (hydrated.activePeriodPurchases || []).map((purchase) => ({
      period: `active-${purchase.id}`,
      label: "Masa aktif 1 bulan",
      status: PAYMENT_STATUS.PAID,
      paidDate: purchase.purchasedAt,
      lastPaymentDate: purchase.purchasedAt,
      paymentType: PAYMENT_TYPES.ACTIVE_PERIOD,
      paidAmount: purchase.amount,
      remainingAmount: 0,
      activeUntil: purchase.activeUntil,
    }));
    const paymentHistory = [...historyByPeriod.values(), ...activePeriodHistory]
      .sort((a, b) => {
        const dateDifference = new Date(b.lastPaymentDate || b.paidDate || 0).getTime()
          - new Date(a.lastPaymentDate || a.paidDate || 0).getTime();
        return dateDifference || String(b.period).localeCompare(String(a.period));
      });

    return {
      customer: {
        id: String(contact.id),
        name: contact.name,
        phoneNumber: contact.phoneNumber,
      },
      billing: {
        period: currentKey,
        periodLabel: prepaidPackage
          ? "Paket prabayar 1 bulan"
          : (hydrated.billingPeriodLabel || formatBillingPeriodLabel(year, month)),
        subscriptionType: hydrated.subscriptionType,
        billingCycle: hydrated.billingCycle,
        subscriptionActive: hydrated.subscriptionActive,
        billingPausedForArrears: hydrated.billingPausedForArrears,
        billingPausedAfterPeriod: hydrated.billingPausedAfterPeriod,
        monthlyAmount,
        currentAmount,
        debtAmount,
        totalAmount: currentAmount + debtAmount,
        currentPaymentStatus,
        packageActive: Boolean(hydrated.packageActive),
        activeUntil: contact.hotspotReactivationAt || null,
        debtCount: hydrated.debtCount,
        debtPeriods: hydrated.debtPeriods,
        dueDate: hydrated.dueDate || null,
        dueStatus: hydrated.dueStatus || null,
        history: paymentHistory,
      },
      hotspot: isHotspotAccountUnavailable(
        hotspotStatus,
        contact.hotspotProvisioningError || hotspotAccount?.hotspotProvisioningError
      ) ? null : {
        username: contact.mikrotikUsername || hotspotAccount?.username || "",
        password: contact.mikrotikPassword || hotspotAccount?.password || "",
        profile: contact.mikrotikProfile || hotspotAccount?.profile || "",
        status: hotspotStatus,
        suspendedForArrears: Boolean(contact.hotspotSuspendedForArrears),
        manualActivationWithArrears: Boolean(contact.hotspotManualActivationWithArrears),
        activeUntil: contact.hotspotReactivationAt || null,
        lastSyncedAt: contact.hotspotLastSyncedAt || hotspotAccount?.hotspotLastSyncedAt || null,
      },
      account: {
        username: portalAccount.username,
      },
      paymentGateway: {
        enabled: Boolean(CONFIG.MIDTRANS_ENABLED && CONFIG.MIDTRANS_SERVER_KEY),
        provider: "midtrans",
        environment: CONFIG.MIDTRANS_IS_PRODUCTION ? "production" : "sandbox",
      },
      company: {
        name: this.getSettings().companyName,
        supportSignature: this.getSettings().supportSignature,
      },
    };
  }

  async updateCustomerHotspotPassword(contactId, currentPassword, newPassword) {
    return this.withDataMutation(async () => {
      const account = this.getCustomerPortalAccountByContactId(contactId);
      if (!account) throw new Error("Akun pelanggan tidak ditemukan.");
      const hotspotStatus = normalizeHotspotProvisioningStatus(
        account.contact.hotspotProvisioningStatus || account.pelanggan?.hotspotProvisioningStatus,
        account.contact.mikrotikUsername || account.pelanggan?.username
          ? HOTSPOT_PROVISIONING_STATUS.ACTIVE
          : HOTSPOT_PROVISIONING_STATUS.NONE
      );
      if (isHotspotAccountUnavailable(
        hotspotStatus,
        account.contact.hotspotProvisioningError || account.pelanggan?.hotspotProvisioningError
      )) {
        const error = new Error(getHotspotUnavailableMessage(
          hotspotStatus,
          account.contact.hotspotProvisioningError || account.pelanggan?.hotspotProvisioningError
        ));
        error.statusCode = 404;
        throw error;
      }
      const currentHotspotPassword = String(
        account.contact.mikrotikPassword || account.pelanggan?.password || ""
      );
      if (!safeCompareString(currentPassword, currentHotspotPassword)) {
        const error = new Error("Password hotspot saat ini tidak sesuai.");
        error.statusCode = 403;
        throw error;
      }

      const now = new Date().toISOString();
      account.contact.mikrotikPassword = newPassword;
      account.contact.hotspotProvisioningStatus = HOTSPOT_PROVISIONING_STATUS.ACTIVE;
      account.contact.hotspotProvisioningOperation = HOTSPOT_PROVISIONING_OPERATION.NONE;
      account.contact.hotspotProvisioningPrevious = null;
      account.contact.hotspotProvisioningError = "";
      account.contact.hotspotLastCheckedAt = now;
      account.contact.hotspotLastSyncedAt = now;
      account.contact.updatedAt = now;

      if (account.pelanggan) {
        account.pelanggan.password = newPassword;
        account.pelanggan.status = "verified";
        account.pelanggan.hotspotProvisioningStatus = HOTSPOT_PROVISIONING_STATUS.ACTIVE;
        account.pelanggan.hotspotProvisioningError = "";
        account.pelanggan.hotspotLastCheckedAt = now;
        account.pelanggan.hotspotLastSyncedAt = now;
        account.pelanggan.tanggalUpdate = now;
      }

      await this.withDatabaseWrite(() => this.sequelize.transaction(async (transaction) => {
        const options = { transaction };
        await this.saveContacts(options);
        await this.savePelanggan(options);
      }));
      return this.getCustomerPortalData(contactId);
    });
  }

  async updateCustomerPortalPassword(contactId, currentPassword, requestedPassword) {
    return this.withDataMutation(async () => {
      const account = this.getCustomerPortalAccountByContactId(contactId);
      if (!account) throw new Error("Akun pelanggan tidak ditemukan.");
      if (!safeCompareString(currentPassword, account.account.password)) {
        const error = new Error("Password akun pelanggan saat ini tidak sesuai.");
        error.statusCode = 403;
        throw error;
      }

      const rawNewPassword = String(requestedPassword || "");
      const newPassword = sanitizeInput(rawNewPassword);
      if (newPassword.length < 5 || newPassword.length > 64) {
        throw new Error("Password baru harus terdiri dari 5 sampai 64 karakter.");
      }
      if (newPassword !== rawNewPassword || !/^[\x21-\x7E]+$/.test(newPassword)) {
        throw new Error("Password baru tidak boleh mengandung spasi atau karakter khusus non-ASCII.");
      }
      if (safeCompareString(newPassword, account.account.password)) {
        throw new Error("Password baru harus berbeda dari password saat ini.");
      }

      account.account.password = newPassword;
      account.account.updatedAt = new Date().toISOString();
      await this.saveCustomerAccounts();
      return this.getCustomerPortalData(contactId);
    });
  }

  getPaymentGatewayTransaction(orderId) {
    return this.paymentGatewayTransactions.get(String(orderId || "")) || null;
  }

  getPendingPaymentGatewayTransactions(contactId = null) {
    const now = Date.now();
    return Array.from(this.paymentGatewayTransactions.values()).filter((transaction) => (
      transaction.provider === "midtrans"
      && (
        transaction.status === PAYMENT_GATEWAY_STATUS.PENDING
        // Respons 404/"Transaction doesn't exist" dapat terjadi beberapa
        // detik setelah transaksi dibuat. Transaksi seperti ini harus tetap
        // dicoba ulang oleh scheduler, bukan berhenti di status FAILED.
        || (
          transaction.status === PAYMENT_GATEWAY_STATUS.FAILED
          && transaction.gatewayStatus === "not_found"
          && now - new Date(transaction.createdAt || 0).getTime()
            <= Math.max(60_000, Number(CONFIG.MIDTRANS_NOT_FOUND_RETRY_WINDOW) || 0)
        )
      )
      && (contactId === null || String(transaction.contactId) === String(contactId))
    ));
  }

  findReusablePaymentGatewayTransaction({ contactId, amount, periods, paymentType = PAYMENT_TYPES.FULL_PAID }) {
    const normalizedContactId = String(contactId || "");
    const normalizedAmount = Math.floor(Number(amount) || 0);
    const normalizedPeriods = Array.from(new Set((periods || []).map(String))).sort();
    const maximumAge = Math.max(
      60_000,
      Number(CONFIG.MIDTRANS_PENDING_TRANSACTION_TTL) || 24 * 60 * 60 * 1000
    );
    const cutoff = Date.now() - maximumAge;

    return Array.from(this.paymentGatewayTransactions.values())
      .filter((transaction) => {
        const createdAt = new Date(transaction.createdAt || 0).getTime();
        const transactionPeriods = Array.from(new Set((transaction.periods || []).map(String))).sort();
        return transaction.provider === "midtrans"
          && transaction.status === PAYMENT_GATEWAY_STATUS.PENDING
          && String(transaction.contactId) === normalizedContactId
          && Number(transaction.amount) === normalizedAmount
          && String(transaction.paymentType || PAYMENT_TYPES.FULL_PAID) === String(paymentType)
          && Boolean(transaction.redirectUrl)
          && Number.isFinite(createdAt)
          && createdAt >= cutoff
          && JSON.stringify(transactionPeriods) === JSON.stringify(normalizedPeriods);
      })
      .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))[0] || null;
  }

  async createPaymentGatewayTransaction(payload) {
    return this.withDataMutation(async () => {
      const orderId = sanitizeInput(String(payload.orderId || ""));
      const contactId = String(payload.contactId || "");
      const amount = Math.floor(Number(payload.amount) || 0);
      const paymentType = payload.paymentType === PAYMENT_TYPES.ACTIVE_PERIOD
        ? PAYMENT_TYPES.ACTIVE_PERIOD
        : PAYMENT_TYPES.FULL_PAID;
      const periods = Array.from(new Set((payload.periods || []).map((period) => String(period))))
        .filter((period) => /^\d{4}-\d{2}$/.test(period));
      if (!orderId || orderId.length > 50) throw new Error("ID transaksi pembayaran tidak valid.");
      if (this.paymentGatewayTransactions.has(orderId)) throw new Error("ID transaksi pembayaran sudah digunakan.");
      if (!this.getContact(contactId)) throw new Error("Kontak tidak ditemukan.");
      if (amount <= 0 || (paymentType !== PAYMENT_TYPES.ACTIVE_PERIOD && periods.length === 0)) {
        throw new Error("Tagihan pelanggan sudah lunas atau belum memiliki nominal.");
      }

      const now = new Date().toISOString();
      const transaction = {
        orderId,
        contactId,
        provider: "midtrans",
        amount,
        periods,
        paymentType,
        status: PAYMENT_GATEWAY_STATUS.PENDING,
        gatewayStatus: "created",
        token: null,
        redirectUrl: null,
        transactionId: null,
        paymentMethod: null,
        paidAt: null,
        createdAt: now,
        updatedAt: now,
      };
      this.paymentGatewayTransactions.set(orderId, transaction);
      await this.savePaymentGatewayTransactions();
      return transaction;
    });
  }

  async updatePaymentGatewayTransaction(orderId, changes = {}) {
    return this.withDataMutation(async () => {
      const transaction = this.getPaymentGatewayTransaction(orderId);
      if (!transaction) throw new Error("Transaksi pembayaran tidak ditemukan.");
      Object.assign(transaction, changes, { updatedAt: new Date().toISOString() });
      await this.savePaymentGatewayTransactions();
      return transaction;
    });
  }

  async completeMidtransPayment(orderId, gatewayData = {}) {
    return this.withDataMutation(async () => {
      const transaction = this.getPaymentGatewayTransaction(orderId);
      if (!transaction) throw new Error("Transaksi pembayaran tidak ditemukan.");
      const receivedAmount = Number(gatewayData.gross_amount);
      if (!Number.isFinite(receivedAmount) || Math.round(receivedAmount) !== transaction.amount) {
        const error = new Error("Nominal notifikasi Midtrans tidak sesuai dengan transaksi.");
        error.statusCode = 400;
        throw error;
      }
      const contact = this.getContact(transaction.contactId);
      if (!contact) throw new Error("Kontak transaksi pembayaran tidak ditemukan.");
      if (transaction.status === PAYMENT_GATEWAY_STATUS.PAID) {
        return { transaction, contact: this.hydrateContact(contact), alreadyProcessed: true };
      }

      const now = new Date().toISOString();
      const serviceScheduleBeforePayment = contact.hotspotReactivationAt || null;
      const serviceScheduleEnabledBeforePayment = parseBoolean(contact.hotspotReactivationEnabled, false);
      const paymentDateBeforePayment = contact.paymentDate || null;
      const paymentTypeBeforePayment = contact.paymentType || null;
      if (transaction.paymentType === PAYMENT_TYPES.ACTIVE_PERIOD) {
        if (!isPrepaidPackage(contact)) {
          throw new Error("Transaksi paket prabayar hanya berlaku untuk pelanggan prabayar.");
        }
        const paidAt = new Date(now);
        const currentSchedule = new Date(contact.hotspotReactivationAt || 0);
        const activeFrom = Number.isFinite(currentSchedule.getTime())
          && currentSchedule.getTime() > paidAt.getTime()
          ? currentSchedule
          : paidAt;
        const activeUntil = addMonthsSafely(activeFrom, 1, this.getTimezone());
        const purchase = {
          id: transaction.orderId,
          purchasedAt: now,
          activeFrom: activeFrom.toISOString(),
          activeUntil: activeUntil.toISOString(),
          paymentProvider: "midtrans",
        };
        const recorded = this.applyActivePeriodPurchase(contact, purchase);
        transaction.status = PAYMENT_GATEWAY_STATUS.PAID;
        transaction.gatewayStatus = String(gatewayData.transaction_status || "settlement");
        transaction.transactionId = sanitizeInput(String(gatewayData.transaction_id || "")) || null;
        transaction.paymentMethod = sanitizeInput(String(gatewayData.payment_type || "")) || null;
        transaction.paidAt = gatewayData.settlement_time || gatewayData.transaction_time || now;
        transaction.error = null;
        transaction.serviceScheduleBeforePayment = serviceScheduleBeforePayment;
        transaction.serviceScheduleEnabledBeforePayment = serviceScheduleEnabledBeforePayment;
        transaction.serviceScheduleAfterPayment = activeUntil.toISOString();
        transaction.paymentDateBeforePayment = paymentDateBeforePayment;
        transaction.paymentTypeBeforePayment = paymentTypeBeforePayment;
        transaction.updatedAt = now;
        const remindersChanged = recorded.added
          ? this.syncActivePeriodExpiryReminder(contact, recorded.purchase).changed
          : 0;
        await this.withDatabaseWrite(() => this.sequelize.transaction(async (databaseTransaction) => {
          const options = { transaction: databaseTransaction };
          await this.saveContacts(options);
          await this.savePaymentGatewayTransactions(options);
          if (remindersChanged) await this.saveReminders(options);
        }));
        return { transaction, contact: this.hydrateContact(contact), alreadyProcessed: false };
      }
      if (!contact.paymentMonths || typeof contact.paymentMonths !== "object") contact.paymentMonths = {};
      for (const period of transaction.periods) {
        const previousPayment = contact.paymentMonths[period] || {};
        contact.paymentMonths[period] = {
          ...previousPayment,
          status: PAYMENT_STATUS.PAID,
          paidDate: now,
          paymentType: PAYMENT_TYPES.FULL_PAID,
          paidAmount: Math.max(0, Math.floor(Number(contact.monthlyPaymentAmount) || 0)),
          previousPaidAmount: this.getPaymentPaidAmount(previousPayment, contact.monthlyPaymentAmount),
          transactionId: transaction.orderId,
          paymentProvider: "midtrans",
        };
      }

      const referencePeriod = getBillingPeriodParts(new Date(), this.getTimezone());
      const currentPeriod = getContactBillingPeriod(contact, referencePeriod);
      const currentKey = makeBillingPeriodKey(currentPeriod.year, currentPeriod.month);
      if (contact.paymentMonths[currentKey]?.status === PAYMENT_STATUS.PAID) {
        contact.paymentStatus = PAYMENT_STATUS.PAID;
        contact.paymentDate = now;
        contact.paymentType = PAYMENT_TYPES.FULL_PAID;
      }
      contact.updatedAt = now;

      transaction.status = PAYMENT_GATEWAY_STATUS.PAID;
      transaction.gatewayStatus = String(gatewayData.transaction_status || "settlement");
      transaction.transactionId = sanitizeInput(String(gatewayData.transaction_id || "")) || null;
      transaction.paymentMethod = sanitizeInput(String(gatewayData.payment_type || "")) || null;
      transaction.paidAt = gatewayData.settlement_time || gatewayData.transaction_time || now;
      transaction.error = null;
      transaction.updatedAt = now;

      const arrearsPolicy = contact.subscriptionChangedByArrears
        ? this.applyArrearsSubscriptionPolicy(contact)
        : { remindersAdded: 0, remindersRemoved: 0 };
      const automaticRenewalResumed = this.resumeAutomaticRenewalIfArrearsSettled(contact, { at: now });
      const serviceSchedule = transaction.periods.includes(currentKey)
        ? this.advanceServiceScheduleAfterPayment(contact, {
            at: now,
            previousSchedule: serviceScheduleBeforePayment,
            paymentPeriodKey: currentKey,
          })
        : { changed: false, activeFrom: null, activeUntil: null };
      if (serviceSchedule.activeUntil) {
        transaction.serviceScheduleBeforePayment = serviceScheduleBeforePayment;
        transaction.serviceScheduleEnabledBeforePayment = serviceScheduleEnabledBeforePayment;
        transaction.serviceScheduleAfterPayment = serviceSchedule.activeUntil;
      }
      const reminderScheduleChanged = automaticRenewalResumed || serviceSchedule.changed
        ? this.syncRecurringReminderSchedule(contact)
        : 0;
      const remindersChanged = arrearsPolicy.remindersAdded + arrearsPolicy.remindersRemoved
        + reminderScheduleChanged
        + this.updateContactReminderMessages(contact);
      await this.withDatabaseWrite(() => this.sequelize.transaction(async (databaseTransaction) => {
        const options = { transaction: databaseTransaction };
        await this.saveContacts(options);
        await this.savePaymentGatewayTransactions(options);
        if (remindersChanged) await this.saveReminders(options);
      }));
      return { transaction, contact: this.hydrateContact(contact), alreadyProcessed: false };
    });
  }

  async refundMidtransPayment(orderId, gatewayData = {}, options = {}) {
    return this.withDataMutation(async () => {
      const transaction = this.getPaymentGatewayTransaction(orderId);
      if (!transaction) throw new Error("Transaksi pembayaran tidak ditemukan.");
      const receivedAmount = Number(gatewayData.gross_amount);
      if (!Number.isFinite(receivedAmount) || Math.round(receivedAmount) !== transaction.amount) {
        const error = new Error("Nominal refund Midtrans tidak sesuai dengan transaksi.");
        error.statusCode = 400;
        throw error;
      }
      const contact = this.getContact(transaction.contactId);
      if (!contact) throw new Error("Kontak transaksi pembayaran tidak ditemukan.");
      const partial = Boolean(options.partial);
      const refundStatus = partial
        ? PAYMENT_GATEWAY_STATUS.PARTIALLY_REFUNDED
        : PAYMENT_GATEWAY_STATUS.REFUNDED;
      const refundAmount = Math.max(
        0,
        Number(gatewayData.refund_amount) || (partial ? 0 : transaction.amount)
      );
      const sameRefundAlreadyProcessed = transaction.status === refundStatus
        && (!partial || Number(transaction.refundAmount || 0) === refundAmount);
      if (sameRefundAlreadyProcessed) {
        return { transaction, contact: this.hydrateContact(contact), alreadyProcessed: true, reversedPeriods: [] };
      }

      const now = new Date().toISOString();
      const reversedPeriods = [];
      if (transaction.paymentType === PAYMENT_TYPES.ACTIVE_PERIOD) {
        if (!partial) {
          const previousLength = Array.isArray(contact.activePeriodPurchases)
            ? contact.activePeriodPurchases.length
            : 0;
          contact.activePeriodPurchases = (contact.activePeriodPurchases || [])
            .filter((purchase) => String(purchase.id) !== String(orderId));
          if (contact.activePeriodPurchases.length < previousLength) reversedPeriods.push("Paket prabayar");
          if (contact.hotspotReactivationAt === transaction.serviceScheduleAfterPayment) {
            contact.hotspotReactivationAt = transaction.serviceScheduleBeforePayment || null;
            contact.hotspotReactivationEnabled = parseBoolean(
              transaction.serviceScheduleEnabledBeforePayment,
              false
            );
          }
          const packageState = this.buildDebtInfo(contact);
          contact.paymentStatus = packageState.currentPaymentStatus;
          contact.paymentDate = packageState.packageActive
            ? transaction.paymentDateBeforePayment || null
            : null;
          contact.paymentType = packageState.packageActive
            ? transaction.paymentTypeBeforePayment || PAYMENT_TYPES.ACTIVE_PERIOD
            : null;
        }
        contact.updatedAt = now;
        transaction.status = refundStatus;
        transaction.gatewayStatus = sanitizeInput(String(
          gatewayData.transaction_status || (partial ? "partial_refund" : "refund")
        ));
        transaction.transactionId = sanitizeInput(String(gatewayData.transaction_id || transaction.transactionId || "")) || null;
        transaction.paymentMethod = sanitizeInput(String(gatewayData.payment_type || transaction.paymentMethod || "")) || null;
        transaction.refundedAt = gatewayData.refund_time || now;
        transaction.refundAmount = refundAmount;
        transaction.manualReviewRequired = partial;
        transaction.error = null;
        transaction.updatedAt = now;
        const remindersChanged = partial
          ? 0
          : (contact.hotspotReactivationAt
            ? this.syncRecurringReminderSchedule(contact)
            : this.removeRemindersForContact(contact.id));
        await this.withDatabaseWrite(() => this.sequelize.transaction(async (databaseTransaction) => {
          const options = { transaction: databaseTransaction };
          await this.saveContacts(options);
          await this.savePaymentGatewayTransactions(options);
          if (remindersChanged) await this.saveReminders(options);
        }));
        return {
          transaction,
          contact: this.hydrateContact(contact),
          alreadyProcessed: false,
          reversedPeriods,
        };
      }
      if (!contact.paymentMonths || typeof contact.paymentMonths !== "object") contact.paymentMonths = {};
      for (const period of partial ? [] : transaction.periods || []) {
        const payment = contact.paymentMonths[period];
        if (payment?.paymentProvider !== "midtrans" || String(payment.transactionId) !== String(orderId)) {
          continue;
        }
        const restoredPaidAmount = Math.max(0, Math.floor(Number(payment.previousPaidAmount) || 0));
        contact.paymentMonths[period] = {
          ...payment,
          status: PAYMENT_STATUS.UNPAID,
          paidDate: null,
          paymentType: restoredPaidAmount > 0 ? PAYMENT_TYPES.ARREARS_ONLY : null,
          paidAmount: restoredPaidAmount,
          refundedAt: gatewayData.refund_time || now,
          refundedTransactionId: transaction.transactionId || null,
        };
        reversedPeriods.push(period);
      }

      const referencePeriod = getBillingPeriodParts(new Date(), this.getTimezone());
      const currentPeriod = getContactBillingPeriod(contact, referencePeriod);
      const currentKey = makeBillingPeriodKey(currentPeriod.year, currentPeriod.month);
      const currentPayment = contact.paymentMonths[currentKey];
      contact.paymentStatus = currentPayment?.status === PAYMENT_STATUS.PAID
        ? PAYMENT_STATUS.PAID
        : PAYMENT_STATUS.UNPAID;
      contact.paymentDate = contact.paymentStatus === PAYMENT_STATUS.PAID
        ? currentPayment?.paidDate || null
        : null;
      contact.paymentType = contact.paymentStatus === PAYMENT_STATUS.PAID
        ? currentPayment?.paymentType || null
        : null;
      const serviceScheduleReverted = !partial
        && reversedPeriods.includes(currentKey)
        && Boolean(transaction.serviceScheduleAfterPayment)
        && contact.hotspotReactivationAt === transaction.serviceScheduleAfterPayment;
      if (serviceScheduleReverted) {
        contact.hotspotReactivationAt = transaction.serviceScheduleBeforePayment || null;
        contact.hotspotReactivationEnabled = parseBoolean(
          transaction.serviceScheduleEnabledBeforePayment,
          false
        );
      }
      contact.updatedAt = now;

      transaction.status = refundStatus;
      transaction.gatewayStatus = sanitizeInput(String(
        gatewayData.transaction_status || (partial ? "partial_refund" : "refund")
      ));
      transaction.transactionId = sanitizeInput(String(gatewayData.transaction_id || transaction.transactionId || "")) || null;
      transaction.paymentMethod = sanitizeInput(String(gatewayData.payment_type || transaction.paymentMethod || "")) || null;
      transaction.refundedAt = gatewayData.refund_time || now;
      transaction.refundAmount = refundAmount;
      transaction.manualReviewRequired = partial;
      transaction.error = null;
      transaction.updatedAt = now;

      const arrearsPolicy = contact.subscriptionChangedByArrears
        ? this.applyArrearsSubscriptionPolicy(contact)
        : { remindersAdded: 0, remindersRemoved: 0 };
      const remindersChanged = arrearsPolicy.remindersAdded + arrearsPolicy.remindersRemoved
        + (serviceScheduleReverted ? this.syncRecurringReminderSchedule(contact) : 0)
        + this.updateContactReminderMessages(contact);
      await this.withDatabaseWrite(() => this.sequelize.transaction(async (databaseTransaction) => {
        const options = { transaction: databaseTransaction };
        await this.saveContacts(options);
        await this.savePaymentGatewayTransactions(options);
        if (remindersChanged) await this.saveReminders(options);
      }));
      return {
        transaction,
        contact: this.hydrateContact(contact),
        alreadyProcessed: false,
        reversedPeriods,
      };
    });
  }

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

  getDashboardSummary() {
    const contacts = this.getSortedContacts();
    const reminders = this.getSortedReminders();
    const sentReminders = this.getSentReminders();
    const paid = contacts.filter((contact) => contact.paymentStatus === PAYMENT_STATUS.PAID).length;
    const unpaid = contacts.length - paid;
    const debt = contacts.filter((contact) => contact.hasDebt).length;
    return {
      contacts: contacts.length,
      pelanggan: this.pelanggan.size,
      reminders: reminders.length,
      sentReminders: sentReminders.length,
      paidContacts: paid,
      unpaidContacts: unpaid,
      debtContacts: debt,
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
      contact.ipBindingBandwidthQueueName = sanitizeInput(String(result.queueName || ""));
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
      || (isPostpaidBilling(contact) && !billingStarted)
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
    const prepaidPackage = isPrepaidPackage(contact);
    contact.billingPausedForArrears = prepaidPackage ? false : true;
    contact.billingPausedAfterPeriod = prepaidPackage ? null : contact.billingPausedAfterPeriod;
    contact.hotspotSuspendedForArrears = false;
    contact.hotspotManualActivationWithArrears = prepaidPackage ? false : true;
    contact.hotspotReactivationEnabled = prepaidPackage;
    contact.hotspotReactivationAt = purchase.activeUntil;
    contact.paymentStatus = PAYMENT_STATUS.PAID;
    contact.paymentDate = prepaidPackage ? purchase.purchasedAt : null;
    contact.paymentType = prepaidPackage ? PAYMENT_TYPES.ACTIVE_PERIOD : null;
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
    return {
      ...contact,
      ...debtInfo,
      ...dueDateInfo,
    };
  }

  toPublicContact(contact) {
    const result = this.hydrateContact(contact);
    delete result.mikrotikPassword;
    delete result.hotspotProvisioningPrevious;
    delete result.subscriptionChangedByArrears;
    delete result.arrearsSubscriptionDebtPeriods;
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
      if (currentVersion >= 5) {
        return { migrated: false, remindersUpdated: 0, version: 5 };
      }

      const templateKeys = [
        "apDownMessageTemplate",
        "customerAccountMessageTemplate",
        "billingReminderMessageTemplate",
        "paymentMessageTemplateArrearsOnly",
        "paymentMessageTemplateCurrentOnly",
        "paymentMessageTemplateFullPaid",
        "paymentMessageTemplateActivePeriod",
        "prepaidPackagePaymentMessageTemplate",
        "paymentHotspotAccountMessageTemplate",
        "activePeriodReminderMessageTemplate",
        "prepaidPackageReminderMessageTemplate",
      ];
      this.settings = { ...settings };
      if (currentVersion < 2) {
        for (const key of templateKeys) {
          this.settings[key] = DEFAULT_SETTINGS[key];
        }
      } else {
        if (settings.paymentMessageTemplateActivePeriod
          === LEGACY_PAYMENT_MESSAGE_TEMPLATE_ACTIVE_PERIOD) {
          this.settings.paymentMessageTemplateActivePeriod =
            DEFAULT_SETTINGS.paymentMessageTemplateActivePeriod;
        }
        if (settings.activePeriodReminderMessageTemplate
          === LEGACY_ACTIVE_PERIOD_REMINDER_MESSAGE_TEMPLATE) {
          this.settings.activePeriodReminderMessageTemplate =
            DEFAULT_SETTINGS.activePeriodReminderMessageTemplate;
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
      this.settings.notificationTemplateCopyMigrationVersion = 5;

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
          const contact = this.getResolvedReminderContact(reminder);
          const prepaidPackage = isPrepaidPackage(contact);
          const usesLegacyTemporaryCopy = reminder.messageSource
            === LEGACY_ACTIVE_PERIOD_REMINDER_MESSAGE_TEMPLATE
            || reminder.message === LEGACY_ACTIVE_PERIOD_REMINDER_MESSAGE_TEMPLATE
            || reminder.messageSource === LEGACY_ACTIVE_PERIOD_REMINDER_MESSAGE_TEMPLATE_V3
            || reminder.message === LEGACY_ACTIVE_PERIOD_REMINDER_MESSAGE_TEMPLATE_V3;
          const usesLegacyPrepaidCopy = reminder.messageSource
            === LEGACY_NOTIFICATION_TEMPLATES_V3.prepaidPackageReminderMessageTemplate
            || reminder.message
              === LEGACY_NOTIFICATION_TEMPLATES_V3.prepaidPackageReminderMessageTemplate;
          if (currentVersion < 2
            || (!prepaidPackage && usesLegacyTemporaryCopy)
            || (prepaidPackage && usesLegacyPrepaidCopy)) {
            messageTemplate = prepaidPackage
              ? this.settings.prepaidPackageReminderMessageTemplate
              : this.settings.activePeriodReminderMessageTemplate;
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
        migration: "billing-cycle-notification-copy-v5",
        remindersUpdated,
      });
      return { migrated: true, remindersUpdated, version: 5 };
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
    const savedSchedule = new Date(options.previousSchedule || 0);
    const graceDays = sanitizePositiveInteger(
      this.getSettings().hotspotIsolationGraceDays,
      DEFAULT_SETTINGS.hotspotIsolationGraceDays,
      0,
      30
    );
    const savedScheduleGraceEnd = Number.isFinite(savedSchedule.getTime())
      ? addDaysSafely(savedSchedule, graceDays, this.getTimezone())
      : null;
    const scheduleAnchor = isPostpaidBilling(contact)
      && Number.isFinite(savedSchedule.getTime())
      && savedScheduleGraceEnd.getTime() >= paidAt.getTime()
      ? savedSchedule
      : activeFrom;
    const activeUntil = addMonthsSafely(scheduleAnchor, 1, this.getTimezone());
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

    const graceDays = sanitizePositiveInteger(
      this.getSettings().hotspotIsolationGraceDays,
      DEFAULT_SETTINGS.hotspotIsolationGraceDays,
      0,
      30
    );
    const warningAt = addDaysSafely(activeUntil, -graceDays, this.getTimezone());
    const reminderDate = warningAt.getTime() < purchasedAt.getTime() ? purchasedAt : warningAt;
    const existing = Array.from(this.reminders.values()).find((reminder) => {
      const resolvedContact = this.getResolvedReminderContact(reminder);
      return String(resolvedContact?.id || reminder.contactId || "") === String(contact.id)
        && !reminder.processingAt;
    });
    const created = !existing;
    const previousState = existing ? JSON.stringify(existing) : null;
    const reminder = existing || {
      id: generateId(),
      contactId: String(contact.id),
      contactName: contact.name,
      phoneNumber: contact.phoneNumber,
      createdAt: new Date().toISOString(),
    };
    const messageTemplate = isPrepaidPackage(contact)
      ? (sanitizeMultilineText(this.getSettings().prepaidPackageReminderMessageTemplate)
        || DEFAULT_SETTINGS.prepaidPackageReminderMessageTemplate)
      : (sanitizeMultilineText(this.getSettings().activePeriodReminderMessageTemplate)
        || DEFAULT_SETTINGS.activePeriodReminderMessageTemplate);

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
      templateName: isPrepaidPackage(contact) ? "PaketPrabayar" : "MasaAktifSementara",
    });
    delete reminder.nextDeliveryAttemptAt;
    delete reminder.deliveryAttemptedAt;
    delete reminder.lastDeliveryAttemptAt;
    delete reminder.lastDeliveryError;
    delete reminder.deliveryAttempts;
    delete reminder.gracePeriodCreatedAt;
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
      const billingCycle = normalizeBillingCycle(payload.billingCycle);
      const hotspotFields = this.normalizeContactHotspotFields({ ...payload, subscriptionType });

      if (!name) throw new Error("Nama kontak wajib diisi.");
      if (!isValidPhoneNumber(phoneNumber)) throw new Error("Nomor kontak harus berformat 628xxx.");
      if (this.hasContactPhone(phoneNumber)) throw new Error("Nomor kontak sudah digunakan.");

      const now = new Date().toISOString();
      const initialServiceSchedule = addMonthsSafely(now, 1, this.getTimezone()).toISOString();
      const { year: initialYear, month: initialMonth } = getBillingPeriodParts(new Date(now), this.getTimezone());
      const initialPeriod = makeBillingPeriodKey(initialYear, initialMonth);
      const prepaidPackage = billingCycle === BILLING_CYCLES.PREPAID;
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
        // Prabayar melunasi periode awal; pascabayar menagihnya pada jatuh tempo berikutnya.
        paymentStatus: PAYMENT_STATUS.PAID,
        paymentDate: billingCycle === BILLING_CYCLES.POSTPAID ? null : now,
        paymentType: billingCycle === BILLING_CYCLES.POSTPAID
          ? null
          : (prepaidPackage ? PAYMENT_TYPES.ACTIVE_PERIOD : PAYMENT_TYPES.CURRENT_ONLY),
        paymentMonths: {
          [initialPeriod]: billingCycle === BILLING_CYCLES.POSTPAID
            ? { status: PAYMENT_STATUS.UNPAID, paidDate: null, paymentType: null, paidAmount: 0 }
            : { status: PAYMENT_STATUS.PAID, paidDate: now, paymentType: prepaidPackage ? PAYMENT_TYPES.ACTIVE_PERIOD : PAYMENT_TYPES.CURRENT_ONLY },
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
        const billingCycle = normalizeBillingCycle(payload.billingCycle);
        const prepaidPackage = billingCycle === BILLING_CYCLES.PREPAID;
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
          paymentDate: billingCycle === BILLING_CYCLES.POSTPAID ? null : now,
          paymentType: billingCycle === BILLING_CYCLES.POSTPAID
            ? null
            : (prepaidPackage ? PAYMENT_TYPES.ACTIVE_PERIOD : PAYMENT_TYPES.CURRENT_ONLY),
          paymentMonths: {
            [initialPeriod]: billingCycle === BILLING_CYCLES.POSTPAID
              ? { status: PAYMENT_STATUS.UNPAID, paidDate: null, paymentType: null, paidAmount: 0 }
              : { status: PAYMENT_STATUS.PAID, paidDate: now, paymentType: prepaidPackage ? PAYMENT_TYPES.ACTIVE_PERIOD : PAYMENT_TYPES.CURRENT_ONLY },
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
        contact.billingCycle = normalizeBillingCycle(payload.billingCycle, contact.billingCycle);
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
      const nextBillingCycle = normalizeBillingCycle(payload.billingCycle, contact.billingCycle);
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
          const paid = (isPostpaidBilling(contact) && !billingStarted)
            || payment?.status === PAYMENT_STATUS.PAID;
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
      const dueDate = blockedByArrears
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
      if (!reminder) return null;

      const now = new Date().toISOString();
      reminder.deliveryAttempts = Math.max(0, Number(reminder.deliveryAttempts) || 0) + 1;
      reminder.deliveryAttemptedAt = reminder.deliveryAttemptedAt || now;
      reminder.lastDeliveryAttemptAt = now;
      reminder.whatsappProvider = provider || reminder.whatsappProvider || null;
      reminder.providerStatus = "processing";
      reminder.providerError = null;
      await this.saveReminders();
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

  async deleteContact(id) {
    return this.withDataMutation(async () => {
      const contact = this.getContact(id);
      if (!contact) throw new Error("Kontak tidak ditemukan.");

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

      this.sentReminders.set(String(id), sentReminder);
      this.reminders.delete(String(id));
      await this.withDatabaseWrite(() => this.sequelize.transaction(async (transaction) => {
        const options = { transaction };
        await this.saveReminders(options);
        await this.saveSentReminders(options);
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

      reminder.reminderKind = REMINDER_KINDS.GRACE_PERIOD;
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

      this.sentReminders.set(historyId, sentReminder);
      await this.withDatabaseWrite(() => this.sequelize.transaction(async (transaction) => {
        const options = { transaction };
        await this.saveReminders(options);
        await this.saveSentReminders(options);
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
        paymentMessageTemplateActivePeriod: payload.paymentMessageTemplateActivePeriod !== undefined
          ? sanitizeMultilineText(payload.paymentMessageTemplateActivePeriod) || current.paymentMessageTemplateActivePeriod
          : current.paymentMessageTemplateActivePeriod,
        prepaidPackagePaymentMessageTemplate: payload.prepaidPackagePaymentMessageTemplate !== undefined
          ? sanitizeMultilineText(payload.prepaidPackagePaymentMessageTemplate) || current.prepaidPackagePaymentMessageTemplate
          : current.prepaidPackagePaymentMessageTemplate,
        paymentHotspotAccountMessageTemplate: payload.paymentHotspotAccountMessageTemplate !== undefined
          ? sanitizeMultilineText(payload.paymentHotspotAccountMessageTemplate) || current.paymentHotspotAccountMessageTemplate
          : current.paymentHotspotAccountMessageTemplate,
        activePeriodReminderMessageTemplate: payload.activePeriodReminderMessageTemplate !== undefined
          ? sanitizeMultilineText(payload.activePeriodReminderMessageTemplate) || current.activePeriodReminderMessageTemplate
          : current.activePeriodReminderMessageTemplate,
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
        profileMonthlyAmounts: requestedProfileMonthlyAmounts,
        mikrotikBackupLastRunDate: payload.mikrotikBackupLastRunDate !== undefined
          ? sanitizeInput(payload.mikrotikBackupLastRunDate)
          : current.mikrotikBackupLastRunDate,
        databaseBackupLastRunDate: current.databaseBackupLastRunDate,
      };
      let contactsChanged = false;
      let remindersChanged = 0;
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

  async markDatabaseBackupRun(dateKey) {
    return this.withDataMutation(async () => {
      this.settings = {
        ...this.getSettings(),
        databaseBackupLastRunDate: sanitizeInput(dateKey),
      };
      await this.saveSettings();
      return this.settings.databaseBackupLastRunDate;
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
        || (isPostpaidBilling(contact) && !billingStarted)
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

// ===============================
// NOTIFICATION BOT
// ===============================

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

  buildPaymentHotspotAccountDetails(contact, options = {}, settings = {}) {
    const storedContact = contact?.id && typeof this.dataManager.getContact === "function"
      ? this.dataManager.getContact(contact.id)
      : null;
    const account = { ...(contact || {}), ...(storedContact || {}) };
    const portalHotspot = contact?.id && typeof this.dataManager.getCustomerPortalData === "function"
      ? this.dataManager.getCustomerPortalData(contact.id)?.hotspot
      : null;
    const username = sanitizeInput(String(account.mikrotikUsername || portalHotspot?.username || ""));
    const password = sanitizeInput(String(account.mikrotikPassword || portalHotspot?.password || ""));
    if (!username || !password) return "";

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

    return template
      .replace(/{{\s*hotspotUsername\s*}}/gi, () => username)
      .replace(/{{\s*hotspotPassword\s*}}/gi, () => password)
      .replace(/{{\s*hotspotProfile\s*}}/gi, () => profile)
      .replace(/{{\s*hotspotStatus\s*}}/gi, () => status)
      .replace(/{{\s*activeUntil\s*}}/gi, () => activeUntil)
      .replace(/\n{3,}/g, "\n\n")
      .trim();
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
      if (isPrepaidPackage(contact)) {
        statusText = "Paket aktif";
        noteText = `Paket WiFi aktif sampai ${formattedActiveUntil}.`;
      } else {
        statusText = "Masa aktif ditambahkan";
        noteText = `WiFi aktif sampai ${formattedActiveUntil}. Tunggakan tetap tercatat dan perpanjangan otomatis masih dijeda.`;
      }
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
      messageTemplate = isPrepaidPackage(contact)
        ? (sanitizeMultilineText(settings.prepaidPackagePaymentMessageTemplate)
          || DEFAULT_SETTINGS.prepaidPackagePaymentMessageTemplate)
        : (sanitizeMultilineText(settings.paymentMessageTemplateActivePeriod)
          || DEFAULT_SETTINGS.paymentMessageTemplateActivePeriod);
    }
    if (paymentType === PAYMENT_TYPES.CURRENT_ONLY
      && normalizeBillingCycle(contact.billingCycle) === BILLING_CYCLES.POSTPAID) {
      messageTemplate = messageTemplate.replace(/bulan ini/gi, billingPeriodLabel);
    }
    const companyName = sanitizeInput(settings.companyName) || "Emmeril Hotspot";
    const supportSignature = sanitizeInput(settings.supportSignature) || "CS Emmeril Hotspot";
    const hotspotAccountDetails = this.buildPaymentHotspotAccountDetails(contact, options, settings);
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

// ===============================
// WEB SERVER
// ===============================

class WebServer {
  constructor(notificationBot, dataManager, templateManager, activityLog, reminderScheduler, authManager, mikrotikService, hotspotReactivationScheduler, midtransService = null, voucherRevenueSyncScheduler = null) {
    this.app = express();
    this.app.disable("x-powered-by");
    this.app.set("trust proxy", CONFIG.TRUST_PROXY);
    this.notificationBot = notificationBot;
    this.dataManager = dataManager;
    this.templateManager = templateManager;
    this.activityLog = activityLog;
    this.reminderScheduler = reminderScheduler;
    this.authManager = authManager;
    this.mikrotikService = mikrotikService;
    this.hotspotReactivationScheduler = hotspotReactivationScheduler;
    this.midtransService = midtransService || new MidtransService();
    this.voucherRevenueSyncScheduler = voucherRevenueSyncScheduler;
    this.hotspotProvisioningLock = new AsyncLock();
    this.voucherGenerationLock = new AsyncLock();
    this.voucherProfileLock = new AsyncLock();
    this.backgroundJobs = new Map();
    this.backgroundOperationLock = new AsyncLock();
    this.activePeriodPurchaseLock = new AsyncLock();
    this.paymentGatewayLock = new AsyncLock();
    this.server = null;
    this.ready = true;
    this.setupRoutes();
  }

  pruneBackgroundJobs() {
    const expiresBefore = Date.now() - (6 * 60 * 60 * 1000);
    for (const [jobId, job] of this.backgroundJobs.entries()) {
      if (job.finishedAt && new Date(job.finishedAt).getTime() < expiresBefore) {
        this.backgroundJobs.delete(jobId);
      }
    }
  }

  toPublicBackgroundJob(job) {
    return {
      id: job.id,
      type: job.type,
      status: job.status,
      phase: job.phase,
      progress: job.progress,
      total: job.total,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      finishedAt: job.finishedAt,
      result: job.status === "COMPLETED" ? structuredClone(job.result ?? null) : null,
      error: job.status === "FAILED" ? job.error : "",
    };
  }

  createBackgroundJob({ type, total = 1, run }) {
    this.pruneBackgroundJobs();
    if (this.backgroundJobs.size >= 100) {
      const completedJobs = Array.from(this.backgroundJobs.values())
        .filter((job) => job.finishedAt)
        .sort((a, b) => new Date(a.finishedAt).getTime() - new Date(b.finishedAt).getTime());
      for (const completedJob of completedJobs) {
        this.backgroundJobs.delete(completedJob.id);
        if (this.backgroundJobs.size < 100) break;
      }
    }
    if (this.backgroundJobs.size >= 100) {
      const error = new Error("Antrean pekerjaan sedang penuh. Coba lagi setelah pekerjaan sebelumnya selesai.");
      error.statusCode = 429;
      throw error;
    }
    if (typeof run !== "function") throw new Error("Pelaksana pekerjaan latar belakang tidak tersedia.");

    const now = new Date().toISOString();
    const job = {
      id: crypto.randomUUID(),
      type: String(type || "BACKGROUND_OPERATION"),
      status: "QUEUED",
      phase: "QUEUED",
      progress: 0,
      total: Math.max(1, Number(total) || 1),
      createdAt: now,
      updatedAt: now,
      finishedAt: null,
      result: null,
      error: "",
    };
    this.backgroundJobs.set(job.id, job);

    setImmediate(() => {
      void (async () => {
        job.status = "PROCESSING";
        job.phase = "STARTING";
        job.updatedAt = new Date().toISOString();
        try {
          job.result = await run(({ phase, completed, total: progressTotal }) => {
            if (phase) job.phase = phase;
            if (completed !== undefined) job.progress = Math.max(0, Number(completed) || 0);
            if (progressTotal !== undefined) job.total = Math.max(1, Number(progressTotal) || job.total);
            job.updatedAt = new Date().toISOString();
          });
          job.status = "COMPLETED";
          job.phase = "COMPLETED";
          job.progress = job.total;
        } catch (error) {
          job.status = "FAILED";
          job.phase = "FAILED";
          job.error = error.message || "Pekerjaan gagal diselesaikan.";
          this.activityLog.push("error", "background-job", `Pekerjaan ${job.type} gagal: ${job.error}`, {
            jobId: job.id,
            progress: job.progress,
            total: job.total,
          });
        } finally {
          job.updatedAt = new Date().toISOString();
          job.finishedAt = job.updatedAt;
        }
      })();
    });

    return this.toPublicBackgroundJob(job);
  }

  getBackgroundJob(jobId, expectedType = "") {
    this.pruneBackgroundJobs();
    const job = this.backgroundJobs.get(String(jobId || ""));
    if (!job || (expectedType && job.type !== expectedType)) {
      const error = new Error("Pekerjaan tidak ditemukan atau sudah kedaluwarsa.");
      error.statusCode = 404;
      throw error;
    }
    return this.toPublicBackgroundJob(job);
  }

  createVoucherGenerationJob(payload) {
    const request = normalizeVoucherGenerationPayload(payload);
    return this.createBackgroundJob({
      type: "VOUCHER_GENERATION",
      total: request.quantity,
      run: (update) => this.voucherGenerationLock.runExclusive("mikrotik-vouchers", async () => {
        update({ phase: "CONNECTING", completed: 0, total: request.quantity });
        const batch = await this.mikrotikService.createHotspotVouchers(request, { onProgress: update });
        if (typeof this.dataManager.storeVoucherBatches === "function") {
          await this.dataManager.storeVoucherBatches([batch]);
        }
        return batch;
      }),
    });
  }

  buildNetworkMonitorView(monitors) {
    const contactsByHost = new Map();
    for (const contact of this.dataManager.getContacts()) {
      const hostKey = normalizeNetworkHost(contact.linkedApHost);
      if (!hostKey) continue;
      if (!contactsByHost.has(hostKey)) contactsByHost.set(hostKey, []);
      contactsByHost.get(hostKey).push({
        id: String(contact.id),
        name: contact.name || "-",
        phoneNumber: contact.phoneNumber || "",
        linkedApHost: contact.linkedApHost || "",
      });
    }

    const monitoredHosts = new Set();
    const rows = (Array.isArray(monitors) ? monitors : []).map((monitor) => {
      const hostKey = normalizeNetworkHost(monitor.host);
      if (hostKey) monitoredHosts.add(hostKey);
      const linkedContacts = [...(contactsByHost.get(hostKey) || [])]
        .sort((a, b) => a.name.localeCompare(b.name, "id-ID"));
      return {
        ...monitor,
        availableInNetwatch: true,
        linkedContacts,
        customerCount: linkedContacts.length,
        linkStatus: linkedContacts.length > 0 ? "LINKED" : "UNLINKED",
      };
    });

    for (const [hostKey, linkedContacts] of contactsByHost.entries()) {
      if (monitoredHosts.has(hostKey)) continue;
      rows.push({
        id: `missing:${hostKey}`,
        host: linkedContacts[0]?.linkedApHost || hostKey,
        status: "MISSING",
        since: "",
        comment: "AP tersimpan pada pelanggan tetapi tidak ditemukan di Netwatch.",
        interval: "",
        timeout: "",
        type: "",
        upScript: "",
        downScript: "",
        availableInNetwatch: false,
        linkedContacts: [...linkedContacts].sort((a, b) => a.name.localeCompare(b.name, "id-ID")),
        customerCount: linkedContacts.length,
        linkStatus: "MISSING",
      });
    }

    return rows.sort((a, b) => String(a.host || "").localeCompare(String(b.host || ""), "id-ID"));
  }

  async resolveContactNetworkLink(payload, currentContact = null) {
    if (!payload || payload.linkedApHost === undefined) return payload;

    const requestedHost = sanitizeInput(String(payload.linkedApHost || ""));
    if (!requestedHost) return { ...payload, linkedApHost: "" };
    if (currentContact
      && normalizeNetworkHost(requestedHost) === normalizeNetworkHost(currentContact.linkedApHost)) {
      return { ...payload, linkedApHost: currentContact.linkedApHost || requestedHost };
    }

    const monitors = await this.mikrotikService.getNetwatchStatus();
    const matchedMonitor = (Array.isArray(monitors) ? monitors : []).find(
      (monitor) => normalizeNetworkHost(monitor.host) === normalizeNetworkHost(requestedHost)
    );
    if (!matchedMonitor) {
      const error = new Error(`AP "${requestedHost}" tidak ditemukan di Netwatch. Muat ulang daftar AP lalu pilih kembali.`);
      error.statusCode = 409;
      throw error;
    }

    return {
      ...payload,
      linkedApHost: sanitizeInput(String(matchedMonitor.host || requestedHost)),
    };
  }

  async syncContactIpBindings(contact, requestedMacAddresses) {
    const desired = normalizeMacAddresses(requestedMacAddresses);
    const current = normalizeMacAddresses(contact.mikrotikMacAddresses);
    const duplicate = desired.find((macAddress) => this.dataManager.hasContactMikrotikMac(macAddress, contact.id));
    if (duplicate) throw new Error(`MAC ${duplicate} sudah terhubung ke pelanggan lain.`);

    const added = desired.filter((macAddress) => !current.includes(macAddress));
    const removed = current.filter((macAddress) => !desired.includes(macAddress));
    if (added.length === 0 && removed.length === 0) {
      return this.syncContactIpBindingBandwidth(contact);
    }

    const serviceDisabled = normalizeHotspotProvisioningStatus(contact.hotspotProvisioningStatus) === HOTSPOT_PROVISIONING_STATUS.DISABLED;
    const accessMode = getContactHotspotAccessMode(contact);
    const accessState = getHotspotAccessRouterState(accessMode, serviceDisabled);
    const completedAdds = [];
    const completedRemovals = [];
    try {
      for (const macAddress of added) {
        await this.mikrotikService.upsertIpBinding({
          macAddress,
          contactId: contact.id,
          type: accessState.bindingType,
        });
        completedAdds.push(macAddress);
      }
      for (const macAddress of removed) {
        await this.mikrotikService.deleteIpBinding({ macAddress, contactId: contact.id });
        completedRemovals.push(macAddress);
      }
      const updated = await this.dataManager.setContactMikrotikMacAddresses(contact.id, desired);
      return this.syncContactIpBindingBandwidth(updated);
    } catch (error) {
      for (const macAddress of completedAdds.reverse()) {
        await this.mikrotikService.deleteIpBinding({ macAddress, contactId: contact.id }).catch(() => {});
      }
      for (const macAddress of completedRemovals.reverse()) {
        await this.mikrotikService.upsertIpBinding({
          macAddress,
          contactId: contact.id,
          type: accessState.bindingType,
        }).catch(() => {});
      }
      throw error;
    }
  }

  async syncContactIpBindingBandwidth(contact) {
    const current = this.dataManager.getContact(contact?.id) || contact;
    if (!current) throw new Error("Kontak tidak ditemukan.");
    if (typeof this.mikrotikService.syncIpBindingBandwidthForCustomer !== "function"
      || typeof this.dataManager.updateContactIpBindingBandwidthStatus !== "function") {
      return this.dataManager.toPublicContact(current);
    }

    let result;
    try {
      result = await this.mikrotikService.syncIpBindingBandwidthForCustomer({
        contactId: current.id,
        profile: current.mikrotikProfile,
        macAddresses: current.mikrotikMacAddresses,
        disabled: normalizeHotspotProvisioningStatus(current.hotspotProvisioningStatus)
          === HOTSPOT_PROVISIONING_STATUS.DISABLED
          || getContactHotspotAccessMode(current) === HOTSPOT_ACCESS_MODES.HOTSPOT_ONLY,
      });
    } catch (error) {
      result = {
        contactId: String(current.id),
        status: IP_BINDING_BANDWIDTH_STATUS.FAILED,
        rateLimit: "",
        targetAddresses: [],
        pendingMacAddresses: normalizeMacAddresses(current.mikrotikMacAddresses),
        devices: [],
        error: error.message,
        syncedAt: new Date().toISOString(),
      };
      this.activityLog.push("warn", "mikrotik", `Bandwidth IP Binding ${current.name || current.id} belum tersinkron: ${error.message}`, {
        contactId: current.id,
      });
    }

    const persisted = await this.dataManager.updateContactIpBindingBandwidthStatus(current.id, result);
    if ([IP_BINDING_BANDWIDTH_STATUS.ACTIVE, IP_BINDING_BANDWIDTH_STATUS.PARTIAL].includes(result.status)
      && result.changed) {
      this.activityLog.push("info", "mikrotik", `Bandwidth bersama IP Binding ${current.name || current.id} disinkronkan`, {
        contactId: current.id,
        rateLimit: result.rateLimit,
        targets: result.targetAddresses,
        pendingMacAddresses: result.pendingMacAddresses,
      });
    }
    return this.dataManager.toPublicContact(persisted);
  }

  async provisionHotspotContact(contact, options = {}) {
    return this.hotspotProvisioningLock.runExclusive(String(contact.id), async () => {
      const current = this.dataManager.getContact(contact.id);
      if (!current) throw new Error("Kontak tidak ditemukan.");
      if (!current.mikrotikUsername || !current.mikrotikProfile || !current.mikrotikPassword) {
        throw new Error("Data akun hotspot pelanggan belum lengkap.");
      }
      const provisioningStatus = normalizeHotspotProvisioningStatus(current.hotspotProvisioningStatus);
      const provisioningOperation = normalizeHotspotProvisioningOperation(
        current.hotspotProvisioningOperation,
        HOTSPOT_PROVISIONING_OPERATION.CREATE
      );
      // A failed CREATE may have reached MikroTik before the response or local
      // status was saved. Retry by reconciling that account, while ownership
      // checks in MikrotikService still protect genuinely foreign usernames.
      const adoptExisting = provisioningOperation === HOTSPOT_PROVISIONING_OPERATION.CREATE
        && provisioningStatus === HOTSPOT_PROVISIONING_STATUS.FAILED;
      const adoptExistingOwnerMismatch = Boolean(
        current.hotspotLastReactivatedAt
        || current.hotspotLastDeactivatedAt
        || current.hotspotLastSyncedAt
      );

      await this.dataManager.updateHotspotProvisioningStatus(
        current.id,
        HOTSPOT_PROVISIONING_STATUS.PROVISIONING,
        { error: "" }
      );

      let registered;
      let verified;
      let persisted;
      try {
        if (provisioningOperation === HOTSPOT_PROVISIONING_OPERATION.UPDATE) {
          const previous = current.hotspotProvisioningPrevious;
          if (!previous?.username) throw new Error("Data akun hotspot lama tidak tersedia untuk proses edit.");
          registered = await this.mikrotikService.updateHotspotCustomer({
            previousUsername: previous.username,
            previousPhoneNumber: previous.phoneNumber,
            name: current.name,
            phoneNumber: current.phoneNumber,
            profile: current.mikrotikProfile,
            username: current.mikrotikUsername,
            password: current.mikrotikPassword,
          });
        } else {
          registered = await this.mikrotikService.createHotspotCustomer({
            name: current.name,
            phoneNumber: current.phoneNumber,
            profile: current.mikrotikProfile,
            username: current.mikrotikUsername,
            password: current.mikrotikPassword,
            adoptExisting,
            adoptExistingOwnerMismatch,
          });
        }
        verified = await this.mikrotikService.verifyHotspotCustomer(registered);
        persisted = await this.dataManager.updateHotspotProvisioningStatus(
          current.id,
          HOTSPOT_PROVISIONING_STATUS.ACTIVE,
          { checkedAt: new Date().toISOString(), syncedAt: new Date().toISOString() }
        );
      } catch (error) {
        await this.dataManager.updateHotspotProvisioningStatus(
          current.id,
          HOTSPOT_PROVISIONING_STATUS.FAILED,
          { error: error.message, checkedAt: new Date().toISOString() }
        ).catch((statusError) => {
          this.activityLog.push("error", "storage", `Gagal menyimpan status provisioning ${current.mikrotikUsername}: ${statusError.message}`);
        });
        this.activityLog.push("error", "mikrotik", `Provisioning ${current.mikrotikUsername} gagal: ${error.message}`, {
          contactId: current.id,
          phoneNumber: current.phoneNumber,
        });

        const wrapped = new Error(`Data pelanggan tersimpan, tetapi akun hotspot gagal disinkronkan: ${error.message}`);
        wrapped.statusCode = 502;
        wrapped.cause = error;
        throw wrapped;
      }

      let notification = { sent: false };
      const sendCredentials = options.sendCredentials !== undefined
        ? parseBoolean(options.sendCredentials, false)
        : parseBoolean(current.hotspotSendCredentials, false);
      if (sendCredentials) {
        try {
          if (this.notificationBot.getStatus()?.whatsappProviderEnabled) {
            const message = `Yth. Bapak/Ibu *${registered.name}*,\n\nAkun hotspot Anda sudah berhasil dibuat.\n\nDetail Akun Hotspot:\n*Username:* ${registered.username}\n*Password:* ${registered.password}\n*Profile:* ${registered.profile}\n\nSilakan simpan data ini. Terimakasih.`;
            await this.notificationBot.sendMessage(registered.phoneNumber, message);
            notification = { sent: true };
          } else {
            notification = { sent: false, error: "Transport notifikasi belum online." };
          }
        } catch (error) {
          notification = { sent: false, error: error.message };
        }
      }

      this.activityLog.push("info", "mikrotik", `Pelanggan ${registered.name} aktif sebagai ${registered.username}`, {
        profile: registered.profile,
        phoneNumber: registered.phoneNumber,
        created: registered.created,
        operation: provisioningOperation,
        notification,
      });

      return {
        ...registered,
        operation: provisioningOperation,
        verified,
        contact: this.dataManager.toPublicContact(persisted.contact),
        pelanggan: persisted.pelanggan,
        notification,
      };
    });
  }

  async setHotspotContactDisabled(contact, disabled, options = {}) {
    return this.hotspotProvisioningLock.runExclusive(String(contact.id), async () => {
      const current = this.dataManager.getContact(contact.id);
      if (!current) throw new Error("Kontak tidak ditemukan.");
      if (!current.mikrotikUsername || !current.mikrotikProfile) {
        throw new Error("Data akun hotspot pelanggan belum lengkap.");
      }
      const accessMode = getContactHotspotAccessMode(current);
      const previousServiceDisabled = normalizeHotspotProvisioningStatus(current.hotspotProvisioningStatus)
        === HOTSPOT_PROVISIONING_STATUS.DISABLED;
      const previousAccessState = getHotspotAccessRouterState(accessMode, previousServiceDisabled);
      const targetAccessState = getHotspotAccessRouterState(accessMode, disabled);
      if (!disabled && !options.activePeriodPurchase) {
        const currentState = typeof this.dataManager.hydrateContact === "function"
          ? this.dataManager.hydrateContact(current)
          : current;
        if (isPrepaidPackage(current) && !currentState.packageActive) {
          const error = new Error("Beli paket satu bulan sebelum mengaktifkan akun prabayar.");
          error.statusCode = 409;
          throw error;
        }
        if (currentState.hasDebt) {
          const error = new Error("Gunakan Beli masa aktif 1 bulan untuk mengaktifkan akun yang masih memiliki tunggakan.");
          error.statusCode = 409;
          throw error;
        }
      }
      const operation = disabled
        ? HOTSPOT_PROVISIONING_OPERATION.DISABLE
        : HOTSPOT_PROVISIONING_OPERATION.ENABLE;
      await this.dataManager.prepareHotspotLifecycleOperation(current.id, operation);
      await this.dataManager.updateHotspotProvisioningStatus(current.id, HOTSPOT_PROVISIONING_STATUS.PROVISIONING, { error: "" });
      let result;
      let bindingsUpdated = 0;
      try {
        result = await this.mikrotikService.setHotspotUserDisabled(
          current.mikrotikUsername,
          current.phoneNumber,
          targetAccessState.userDisabled
        );
        const updatedBindings = [];
        try {
          for (const macAddress of normalizeMacAddresses(current.mikrotikMacAddresses)) {
            await this.mikrotikService.upsertIpBinding({
              macAddress,
              contactId: current.id,
              type: targetAccessState.bindingType,
            });
            updatedBindings.push(macAddress);
          }
          bindingsUpdated = updatedBindings.length;
        } catch (bindingError) {
          for (const macAddress of updatedBindings.reverse()) {
            await this.mikrotikService.upsertIpBinding({
              macAddress,
              contactId: current.id,
              type: previousAccessState.bindingType,
            }).catch(() => {});
          }
          await this.mikrotikService.setHotspotUserDisabled(
            current.mikrotikUsername,
            current.phoneNumber,
            previousAccessState.userDisabled
          ).catch(() => {});
          throw bindingError;
        }
      } catch (error) {
        await this.dataManager.updateHotspotProvisioningStatus(current.id, HOTSPOT_PROVISIONING_STATUS.FAILED, {
          error: error.message,
          checkedAt: new Date().toISOString(),
        }).catch((statusError) => {
          this.activityLog.push("error", "storage", `Gagal menyimpan status ${disabled ? "deaktivasi" : "aktivasi"} ${current.mikrotikUsername}: ${statusError.message}`);
        });
        const wrapped = new Error(`Akun hotspot gagal ${disabled ? "dinonaktifkan" : "diaktifkan"}: ${error.message}`);
        wrapped.statusCode = 502;
        wrapped.cause = error;
        throw wrapped;
      }

      let persisted;
      try {
        persisted = disabled
          ? await this.dataManager.markHotspotDisabled(current.id, result)
          : await this.dataManager.markHotspotEnabled(current.id, result, {
              at: options.at,
              activePeriodPurchase: options.activePeriodPurchase,
            });
      } catch (error) {
        try {
          await this.mikrotikService.setHotspotUserDisabled(
            current.mikrotikUsername,
            current.phoneNumber,
            previousAccessState.userDisabled
          );
          for (const macAddress of normalizeMacAddresses(current.mikrotikMacAddresses)) {
            await this.mikrotikService.upsertIpBinding({
              macAddress,
              contactId: current.id,
              type: previousAccessState.bindingType,
            });
          }
        } catch (rollbackError) {
          this.activityLog.push("error", "mikrotik", `Rollback status akun hotspot ${current.mikrotikUsername} gagal: ${rollbackError.message}`, {
            contactId: current.id,
          });
          const wrapped = new Error("Status akun berubah di MikroTik tetapi database gagal diperbarui. Periksa akun secara manual.");
          wrapped.statusCode = 502;
          wrapped.cause = error;
          throw wrapped;
        }
        await this.dataManager.updateHotspotProvisioningStatus(current.id, HOTSPOT_PROVISIONING_STATUS.FAILED, {
          error: error.message,
          checkedAt: new Date().toISOString(),
        }).catch(() => {});
        const wrapped = new Error(`Status akun gagal disimpan dan perubahan MikroTik sudah dibatalkan: ${error.message}`);
        wrapped.statusCode = 500;
        wrapped.cause = error;
        throw wrapped;
      }

      if (typeof this.mikrotikService.syncIpBindingBandwidthForCustomer === "function"
        && typeof this.dataManager.updateContactIpBindingBandwidthStatus === "function") {
        await this.syncContactIpBindingBandwidth(this.dataManager.getContact(current.id));
        persisted = this.dataManager.getContact(current.id) || persisted;
      }

      this.activityLog.push("info", "mikrotik", `Akses ${current.mikrotikUsername} ${disabled ? "dinonaktifkan" : `dipulihkan ke mode ${accessMode}`}`, {
        contactId: current.id,
        username: current.mikrotikUsername,
        activeSessionsKilled: result.activeSessionsKilled || 0,
      });
      return {
        operation: disabled ? "DISABLE" : "ENABLE",
        contact: persisted,
        username: result.username,
        bindingsUpdated,
        disabled: Boolean(disabled),
        accessMode,
        activeSessionsKilled: result.activeSessionsKilled || 0,
      };
    });
  }

  async setHotspotContactAccessMode(contact, requestedMode) {
    return this.hotspotProvisioningLock.runExclusive(String(contact.id), async () => {
      const current = this.dataManager.getContact(contact.id);
      if (!current) throw new Error("Kontak tidak ditemukan.");
      if (!current.mikrotikUsername || !current.mikrotikProfile) {
        throw new Error("Data akun hotspot pelanggan belum lengkap.");
      }
      const accessMode = normalizeHotspotAccessMode(requestedMode, "");
      if (!accessMode) throw new Error("Mode akses hotspot tidak valid.");
      const macAddresses = normalizeMacAddresses(current.mikrotikMacAddresses);
      if (accessMode !== HOTSPOT_ACCESS_MODES.HOTSPOT_ONLY && macAddresses.length === 0) {
        const error = new Error("Tambahkan minimal satu MAC IP Binding sebelum memilih mode ini.");
        error.statusCode = 409;
        throw error;
      }

      const serviceDisabled = normalizeHotspotProvisioningStatus(current.hotspotProvisioningStatus)
        === HOTSPOT_PROVISIONING_STATUS.DISABLED;
      if (serviceDisabled) {
        const currentState = typeof this.dataManager.hydrateContact === "function"
          ? this.dataManager.hydrateContact(current)
          : current;
        if (isPrepaidPackage(current) && !currentState.packageActive) {
          const error = new Error("Beli paket satu bulan sebelum mengaktifkan akses prabayar.");
          error.statusCode = 409;
          throw error;
        }
        if (currentState.hasDebt) {
          const error = new Error("Akses tidak dapat diaktifkan karena pelanggan masih memiliki tunggakan.");
          error.statusCode = 409;
          throw error;
        }
      }

      const previousMode = getContactHotspotAccessMode(current);
      const previousState = getHotspotAccessRouterState(previousMode, serviceDisabled);
      const targetState = getHotspotAccessRouterState(accessMode, false);
      let userUpdated = false;
      const bindingsUpdated = [];
      let result;
      try {
        result = await this.mikrotikService.setHotspotUserDisabled(
          current.mikrotikUsername,
          current.phoneNumber,
          targetState.userDisabled
        );
        userUpdated = true;
        for (const macAddress of macAddresses) {
          await this.mikrotikService.upsertIpBinding({
            macAddress,
            contactId: current.id,
            type: targetState.bindingType,
          });
          bindingsUpdated.push(macAddress);
        }
      } catch (error) {
        for (const macAddress of bindingsUpdated.reverse()) {
          await this.mikrotikService.upsertIpBinding({
            macAddress,
            contactId: current.id,
            type: previousState.bindingType,
          }).catch(() => {});
        }
        if (userUpdated) {
          await this.mikrotikService.setHotspotUserDisabled(
            current.mikrotikUsername,
            current.phoneNumber,
            previousState.userDisabled
          ).catch(() => {});
        }
        const wrapped = new Error(`Mode akses gagal diterapkan di MikroTik: ${error.message}`);
        wrapped.statusCode = 502;
        wrapped.cause = error;
        throw wrapped;
      }

      let persisted;
      try {
        persisted = await this.dataManager.setContactHotspotAccessMode(current.id, accessMode);
      } catch (error) {
        try {
          await this.mikrotikService.setHotspotUserDisabled(
            current.mikrotikUsername,
            current.phoneNumber,
            previousState.userDisabled
          );
          for (const macAddress of macAddresses) {
            await this.mikrotikService.upsertIpBinding({
              macAddress,
              contactId: current.id,
              type: previousState.bindingType,
            });
          }
        } catch (rollbackError) {
          const wrapped = new Error(`Mode akses berubah di MikroTik tetapi gagal disimpan dan rollback tidak lengkap: ${rollbackError.message}`);
          wrapped.statusCode = 502;
          wrapped.cause = error;
          throw wrapped;
        }
        throw error;
      }

      if (typeof this.mikrotikService.syncIpBindingBandwidthForCustomer === "function"
        && typeof this.dataManager.updateContactIpBindingBandwidthStatus === "function") {
        await this.syncContactIpBindingBandwidth(this.dataManager.getContact(current.id));
        persisted = this.dataManager.getContact(current.id) || persisted;
      }

      this.activityLog.push("info", "mikrotik", `Mode akses ${current.mikrotikUsername} diubah menjadi ${accessMode}`, {
        contactId: current.id,
        previousMode,
        accessMode,
        userDisabled: targetState.userDisabled,
        bindingType: targetState.bindingType,
        bindingsUpdated: bindingsUpdated.length,
      });
      return {
        operation: "ACCESS_MODE",
        contact: persisted,
        username: result?.username || current.mikrotikUsername,
        accessMode,
        userDisabled: targetState.userDisabled,
        bindingType: targetState.bindingType,
        bindingsUpdated: bindingsUpdated.length,
        activeSessionsKilled: result?.activeSessionsKilled || 0,
      };
    });
  }

  async purchaseActivePeriod(contactId) {
    return this.activePeriodPurchaseLock.runExclusive(String(contactId), async () => {
      const contact = this.dataManager.getContact(contactId);
      if (!contact) throw new Error("Kontak tidak ditemukan.");
      const hydrated = this.dataManager.hydrateContact(contact);
      if (!isRecurringSubscription(contact)) {
        throw new Error("Pembelian masa aktif hanya tersedia untuk pelanggan bulanan.");
      }
      const prepaidPackage = isPrepaidPackage(contact);
      if (!prepaidPackage && !hydrated.hasDebt) {
        throw new Error("Pembelian masa aktif hanya tersedia untuk pelanggan yang memiliki tunggakan.");
      }
      if (!contact.mikrotikUsername || !contact.mikrotikProfile) {
        throw new Error("Data akun hotspot pelanggan belum lengkap.");
      }

      const now = new Date();
      const currentStatus = normalizeHotspotProvisioningStatus(
        contact.hotspotProvisioningStatus,
        HOTSPOT_PROVISIONING_STATUS.NONE
      );
      const currentEnd = new Date(contact.hotspotReactivationAt || 0);
      const canExtend = currentStatus === HOTSPOT_PROVISIONING_STATUS.ACTIVE
        && (prepaidPackage || parseBoolean(contact.hotspotManualActivationWithArrears, false));
      const canActivate = currentStatus === HOTSPOT_PROVISIONING_STATUS.DISABLED;
      if (!canExtend && !canActivate) {
        const error = new Error(prepaidPackage
          ? "Akun hotspot harus sudah tersedia atau dalam keadaan nonaktif."
          : "Akun hotspot harus nonaktif karena tunggakan atau sedang memakai masa aktif sementara.");
        error.statusCode = 409;
        throw error;
      }

      const activeFrom = canExtend && Number.isFinite(currentEnd.getTime()) && currentEnd.getTime() > now.getTime()
        ? currentEnd
        : now;
      const activeUntil = addMonthsSafely(activeFrom, 1, this.dataManager.getTimezone());
      const purchase = {
        id: `ACT-${Date.now()}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`,
        purchasedAt: now.toISOString(),
        activeFrom: activeFrom.toISOString(),
        activeUntil: activeUntil.toISOString(),
        paymentProvider: "manual",
      };

      let persisted;
      let operation;
      if (canExtend) {
        const recorded = await this.dataManager.recordActivePeriodPurchase(contact.id, purchase);
        persisted = recorded.contact;
        operation = "EXTEND";
      } else {
        const enabled = await this.setHotspotContactDisabled(contact, false, {
          at: now,
          activePeriodPurchase: purchase,
        });
        persisted = enabled.contact;
        operation = "ACTIVATE";
      }

      const storedPurchase = (persisted.activePeriodPurchases || [])
        .find((item) => String(item.id) === purchase.id);
      this.activityLog.push("info", "payment", `Masa aktif satu bulan ${operation === "EXTEND" ? "ditambahkan" : "dibeli"} untuk ${contact.mikrotikUsername}`, {
        contactId: contact.id,
        transactionId: purchase.id,
        amount: storedPurchase?.amount || contact.monthlyPaymentAmount,
        activeUntil: purchase.activeUntil,
        operation,
      });
      return {
        operation,
        purchase: storedPurchase || purchase,
        contact: persisted,
      };
    });
  }

  async deleteContactWithHotspot(contactId) {
    return this.hotspotProvisioningLock.runExclusive(String(contactId), async () => {
      const contact = this.dataManager.getContact(contactId);
      if (!contact) throw new Error("Kontak tidak ditemukan.");

      const username = sanitizeInput(contact.mikrotikUsername || "");
      const macAddresses = normalizeMacAddresses(contact.mikrotikMacAddresses);
      const password = sanitizeInput(contact.mikrotikPassword || "")
        || String(contact.phoneNumber || "").slice(-5);
      const accessMode = getContactHotspotAccessMode(contact);
      const serviceDisabled = normalizeHotspotProvisioningStatus(contact.hotspotProvisioningStatus)
        === HOTSPOT_PROVISIONING_STATUS.DISABLED;
      const restoreState = getHotspotAccessRouterState(accessMode, serviceDisabled);
      const bindingType = restoreState.bindingType;
      const removedMacAddresses = [];
      let bandwidthQueueRemoved = false;
      let hotspotDeletion = {
        username: username || null,
        macAddresses,
        removedUsers: 0,
        removedBindings: 0,
        removedQueues: 0,
        activeSessionsKilled: 0,
        skipped: !username && macAddresses.length === 0,
      };
      const restoreMikrotikAccess = async ({
        restoreUser = false,
        restoreBindings = [],
        restoreBandwidth = false,
      } = {}) => {
        if (restoreUser) {
          if (!password || !contact.mikrotikProfile) throw new Error("Data profile atau password hotspot tidak lengkap.");
          await this.mikrotikService.reactivateHotspotUser({
            username,
            password,
            profile: contact.mikrotikProfile,
            phoneNumber: contact.phoneNumber,
          });
          if (restoreState.userDisabled) {
            await this.mikrotikService.setHotspotUserDisabled(username, contact.phoneNumber, true);
          }
        }
        for (const macAddress of restoreBindings) {
          await this.mikrotikService.upsertIpBinding({
            macAddress,
            contactId: contact.id,
            type: bindingType,
          });
        }
        if (restoreBandwidth && typeof this.mikrotikService.syncIpBindingBandwidthForCustomer === "function") {
          await this.mikrotikService.syncIpBindingBandwidthForCustomer({
            contactId: contact.id,
            profile: contact.mikrotikProfile,
            macAddresses,
            disabled: serviceDisabled || accessMode === HOTSPOT_ACCESS_MODES.HOTSPOT_ONLY,
          });
        }
      };

      if (username || macAddresses.length > 0) {
        try {
          if (username) {
            Object.assign(hotspotDeletion, await this.mikrotikService.deleteHotspotUser(username, contact.phoneNumber));
          }
          for (const macAddress of macAddresses) {
            const bindingResult = await this.mikrotikService.deleteIpBinding({ macAddress, contactId: contact.id });
            hotspotDeletion.removedBindings += bindingResult.removedBindings || 0;
            if (bindingResult.removedBindings > 0) removedMacAddresses.push(macAddress);
          }
          if (typeof this.mikrotikService.deleteIpBindingBandwidthQueue === "function") {
            const queueResult = await this.mikrotikService.deleteIpBindingBandwidthQueue(contact.id);
            hotspotDeletion.removedQueues = queueResult.removedQueues || 0;
            bandwidthQueueRemoved = hotspotDeletion.removedQueues > 0;
          }
          hotspotDeletion.skipped = false;
        } catch (error) {
          try {
            await restoreMikrotikAccess({
              restoreUser: hotspotDeletion.removedUsers > 0,
              restoreBindings: removedMacAddresses,
              restoreBandwidth: bandwidthQueueRemoved,
            });
          } catch (rollbackError) {
            const wrapped = new Error(`Penghapusan akses MikroTik gagal dan rollback tidak lengkap: ${rollbackError.message}`);
            wrapped.statusCode = 502;
            wrapped.cause = error;
            throw wrapped;
          }
          const wrapped = new Error(`Data pelanggan belum dihapus karena akses MikroTik gagal dihapus: ${error.message}`);
          wrapped.statusCode = 502;
          wrapped.cause = error;
          throw wrapped;
        }
      }

      let deleted;
      try {
        deleted = await this.dataManager.deleteContact(contact.id);
      } catch (error) {
        if ((!username || hotspotDeletion.removedUsers < 1) && hotspotDeletion.removedBindings < 1) throw error;

        try {
          await restoreMikrotikAccess({
            restoreUser: username && hotspotDeletion.removedUsers > 0,
            restoreBindings: removedMacAddresses,
            restoreBandwidth: bandwidthQueueRemoved,
          });
        } catch (rollbackError) {
          this.activityLog.push("error", "mikrotik", `Rollback penghapusan akun hotspot ${username} gagal: ${rollbackError.message}`, {
            contactId: contact.id,
          });
          const wrapped = new Error("Akun hotspot sudah terhapus, tetapi data pelanggan gagal dihapus dan akun tidak dapat dipulihkan. Periksa MikroTik secara manual.");
          wrapped.statusCode = 502;
          wrapped.cause = error;
          throw wrapped;
        }

        const wrapped = new Error(`Data pelanggan gagal dihapus. Akun hotspot ${username} sudah dipulihkan.`);
        wrapped.statusCode = 500;
        wrapped.cause = error;
        throw wrapped;
      }

      this.activityLog.push("info", "mikrotik", username || macAddresses.length > 0
        ? `Pelanggan, akun hotspot, dan ${macAddresses.length} IP Binding dihapus`
        : `Pelanggan ${contact.name || contact.id} dihapus tanpa akun hotspot`, {
        contactId: contact.id,
        username: username || null,
        macAddresses,
        removedUsers: hotspotDeletion.removedUsers,
        removedBindings: hotspotDeletion.removedBindings,
        activeSessionsKilled: hotspotDeletion.activeSessionsKilled,
      });
      return {
        ...deleted,
        deletedContact: typeof this.dataManager.toPublicContact === "function"
          ? this.dataManager.toPublicContact(deleted.deletedContact)
          : {
              id: deleted.deletedContact.id,
              name: deleted.deletedContact.name,
              phoneNumber: deleted.deletedContact.phoneNumber,
              mikrotikUsername: deleted.deletedContact.mikrotikUsername || "",
            },
        hotspot: hotspotDeletion,
      };
    });
  }

  async recoverHotspotAfterPayment(contact) {
    const currentState = this.dataManager.getContact(contact?.id) || contact;
    const hydratedState = currentState && typeof this.dataManager.hydrateContact === "function"
      ? this.dataManager.hydrateContact(currentState)
      : currentState;
    if (hydratedState?.hasDebt
      || String(hydratedState?.currentPaymentStatus || hydratedState?.paymentStatus || "UNPAID").toUpperCase() !== PAYMENT_STATUS.PAID) {
      return { attempted: false, reason: "outstanding_balance" };
    }
    const prepaidPackage = isPrepaidPackage(currentState);
    if (!prepaidPackage && !parseBoolean(currentState?.hotspotSuspendedForArrears, false)) {
      return { attempted: false, reason: "not_arrears_suspension" };
    }
    if (prepaidPackage
      && normalizeHotspotProvisioningStatus(currentState?.hotspotProvisioningStatus) === HOTSPOT_PROVISIONING_STATUS.DISABLED
      && /oleh administrator/i.test(String(currentState?.hotspotProvisioningError || ""))) {
      return { attempted: false, reason: "manual_suspension" };
    }
    const password = sanitizeInput(contact?.mikrotikPassword || "")
      || String(contact?.phoneNumber || "").slice(-5);
    if (!contact?.id || !contact.mikrotikUsername || !contact.mikrotikProfile || !password) {
      return { attempted: false, reason: "incomplete_account" };
    }
    if (typeof this.mikrotikService.getHotspotUsers !== "function") {
      return { attempted: false, reason: "unsupported" };
    }

    const users = await this.mikrotikService.getHotspotUsers();
    const username = String(contact.mikrotikUsername).toLowerCase();
    const matchedUser = (users || []).find((user) => String(user.username || "").toLowerCase() === username) || null;
    const routerUser = matchedUser?.source === "active" ? null : matchedUser;
    if (routerUser && routerUser.disabled) {
      const result = await this.setHotspotContactDisabled(contact, false);
      return { attempted: true, action: "enabled", contact: result.contact, result };
    }
    if (routerUser) {
      const current = this.dataManager.getContact(contact.id) || contact;
      if (normalizeHotspotProvisioningStatus(current.hotspotProvisioningStatus) === HOTSPOT_PROVISIONING_STATUS.ACTIVE) {
        return { attempted: true, action: "already_active", contact: current };
      }
      const persisted = await this.dataManager.markHotspotEnabled(current.id, {
        password: current.mikrotikPassword,
        profile: current.mikrotikProfile,
      });
      return { attempted: true, action: "already_active", contact: persisted };
    }

    return this.hotspotProvisioningLock.runExclusive(String(contact.id), async () => {
      const current = this.dataManager.getContact(contact.id) || contact;
      await this.dataManager.prepareHotspotLifecycleOperation(current.id, HOTSPOT_PROVISIONING_OPERATION.ENABLE);
      await this.dataManager.updateHotspotProvisioningStatus(
        current.id,
        HOTSPOT_PROVISIONING_STATUS.PROVISIONING,
        { error: "" }
      );
      try {
        const registered = await this.mikrotikService.reactivateHotspotUser({
          username: current.mikrotikUsername,
          password,
          profile: current.mikrotikProfile,
          phoneNumber: current.phoneNumber,
        });
        await this.mikrotikService.verifyHotspotCustomer(registered);
        const persisted = await this.dataManager.markHotspotEnabled(current.id, registered);
        return { attempted: true, action: "created", contact: persisted, result: registered };
      } catch (error) {
        await this.dataManager.updateHotspotProvisioningStatus(current.id, HOTSPOT_PROVISIONING_STATUS.FAILED, {
          error: error.message,
          checkedAt: new Date().toISOString(),
        }).catch(() => {});
        throw error;
      }
    });
  }

  async changeCustomerHotspotPassword(contactId, currentPassword, requestedPassword) {
    return this.hotspotProvisioningLock.runExclusive(String(contactId), async () => {
      const account = this.dataManager.getCustomerPortalAccountByContactId(contactId);
      if (!account) throw new Error("Akun pelanggan tidak ditemukan.");
      const hotspotStatus = normalizeHotspotProvisioningStatus(
        account.contact.hotspotProvisioningStatus || account.pelanggan?.hotspotProvisioningStatus,
        account.contact.mikrotikUsername || account.pelanggan?.username
          ? HOTSPOT_PROVISIONING_STATUS.ACTIVE
          : HOTSPOT_PROVISIONING_STATUS.NONE
      );
      if (isHotspotAccountUnavailable(
        hotspotStatus,
        account.contact.hotspotProvisioningError || account.pelanggan?.hotspotProvisioningError
      )) {
        const error = new Error(getHotspotUnavailableMessage(
          hotspotStatus,
          account.contact.hotspotProvisioningError || account.pelanggan?.hotspotProvisioningError
        ));
        error.statusCode = 404;
        throw error;
      }

      const oldPassword = String(currentPassword || "");
      const originalPassword = String(
        account.contact.mikrotikPassword || account.pelanggan?.password || ""
      );
      const rawNewPassword = String(requestedPassword || "");
      const newPassword = sanitizeInput(rawNewPassword);
      if (!safeCompareString(oldPassword, originalPassword)) {
        const error = new Error("Password hotspot saat ini tidak sesuai.");
        error.statusCode = 403;
        throw error;
      }
      if (newPassword.length < 5 || newPassword.length > 64) {
        throw new Error("Password baru harus terdiri dari 5 sampai 64 karakter.");
      }
      if (newPassword !== rawNewPassword || !/^[\x21-\x7E]+$/.test(newPassword)) {
        throw new Error("Password baru tidak boleh mengandung spasi atau karakter khusus non-ASCII.");
      }
      if (safeCompareString(newPassword, originalPassword)) {
        throw new Error("Password baru harus berbeda dari password saat ini.");
      }
      if (!account.contact.mikrotikUsername || !account.contact.mikrotikProfile) {
        throw new Error("Data akun hotspot belum lengkap.");
      }

      const updateRouterPassword = (password) => this.mikrotikService.updateHotspotCustomer({
        previousUsername: account.contact.mikrotikUsername,
        previousPhoneNumber: account.contact.phoneNumber,
        name: account.contact.name,
        phoneNumber: account.contact.phoneNumber,
        profile: account.contact.mikrotikProfile,
        username: account.contact.mikrotikUsername,
        password,
      });

      try {
        await updateRouterPassword(newPassword);
      } catch (error) {
        const wrapped = new Error(`Password belum diubah karena sinkronisasi MikroTik gagal: ${error.message}`);
        wrapped.statusCode = 502;
        wrapped.cause = error;
        throw wrapped;
      }

      try {
        const portalData = await this.dataManager.updateCustomerHotspotPassword(
          contactId,
          oldPassword,
          newPassword
        );
        this.activityLog.push("info", "customer-hotspot", `Password hotspot diubah oleh pelanggan ${account.contact.mikrotikUsername}`, {
          contactId: account.contact.id,
        });
        return portalData;
      } catch (error) {
        try {
          await updateRouterPassword(originalPassword);
        } catch (rollbackError) {
          this.activityLog.push("error", "customer-hotspot", `Rollback password hotspot gagal untuk ${account.contact.mikrotikUsername}: ${rollbackError.message}`, {
            contactId: account.contact.id,
          });
          const wrapped = new Error("Password berubah di MikroTik tetapi database gagal diperbarui. Hubungi administrator segera.");
          wrapped.statusCode = 502;
          wrapped.cause = error;
          throw wrapped;
        }

        const wrapped = new Error(`Password gagal disimpan dan perubahan MikroTik sudah dibatalkan: ${error.message}`);
        wrapped.statusCode = 500;
        wrapped.cause = error;
        throw wrapped;
      }
    });
  }

  async reconcileMidtransTransaction(orderId) {
    if (!this.midtransService.isConfigured()) return { status: "DISABLED" };
    const localTransaction = this.dataManager.getPaymentGatewayTransaction(orderId);
    if (!localTransaction) return { status: "UNKNOWN_ORDER", orderId };

    const gatewayData = await this.midtransService.getTransactionStatus(orderId);
    if (!gatewayData.transaction_status) {
      const notFound = String(gatewayData.status_code || "") === "404"
        || /doesn't exist|not found/i.test(String(gatewayData.status_message || ""));
      if (notFound) {
        const createdAt = new Date(localTransaction.createdAt || 0).getTime();
        const withinRetryWindow = Number.isFinite(createdAt)
          && Date.now() - createdAt <= Math.max(60_000, Number(CONFIG.MIDTRANS_NOT_FOUND_RETRY_WINDOW) || 0);
        const transaction = await this.dataManager.updatePaymentGatewayTransaction(orderId, {
          // Keep it pending while Midtrans is still propagating the order.
          // This allows the minute scheduler and the next portal refresh to
          // verify it again automatically.
          status: withinRetryWindow ? PAYMENT_GATEWAY_STATUS.PENDING : PAYMENT_GATEWAY_STATUS.FAILED,
          gatewayStatus: "not_found",
          error: sanitizeInput(String(gatewayData.status_message || "Transaction not found")),
        });
        return { status: transaction.status, alreadyProcessed: false, transaction };
      }
      throw new Error(`Status transaksi Midtrans tidak tersedia: ${gatewayData.status_message || "unknown"}`);
    }
    if (String(gatewayData.order_id || "") !== String(orderId)) {
      throw new Error("Order ID hasil verifikasi Midtrans tidak sesuai.");
    }
    const status = normalizeMidtransPaymentStatus(
      gatewayData.transaction_status,
      gatewayData.fraud_status
    );

    if ([PAYMENT_GATEWAY_STATUS.REFUNDED, PAYMENT_GATEWAY_STATUS.PARTIALLY_REFUNDED].includes(status)) {
      const partial = status === PAYMENT_GATEWAY_STATUS.PARTIALLY_REFUNDED;
      const result = await this.paymentGatewayLock.runExclusive(String(orderId), () => (
        this.dataManager.refundMidtransPayment(orderId, gatewayData, { partial })
      ));
      if (!result.alreadyProcessed) {
        this.activityLog.push("warn", "payment", `Pembayaran Midtrans ${orderId} ${partial ? "direfund sebagian" : "direfund"}`, {
          contactId: result.contact.id,
          amount: localTransaction.amount,
          reversedPeriods: result.reversedPeriods,
        });
        if (typeof this.notificationBot.sendAdminBroadcast === "function") {
          await this.notificationBot.sendAdminBroadcast(
            partial ? "Refund sebagian Midtrans perlu ditinjau" : "Refund pembayaran Midtrans",
            `Order: ${orderId}\nPelanggan: ${result.contact.name || result.contact.id}\nNominal transaksi: ${localTransaction.amount}\nNominal refund: ${gatewayData.refund_amount || localTransaction.amount}\nPeriode dibatalkan: ${result.reversedPeriods.join(", ") || (partial ? "tidak dibatalkan otomatis" : "tidak ada (sudah ditimpa pembayaran lain)")}`
          ).catch((error) => {
            this.activityLog.push("error", "payment", `Notifikasi admin untuk refund ${orderId} gagal: ${error.message}`);
          });
        }
      }
      return {
        status,
        alreadyProcessed: result.alreadyProcessed,
        transaction: result.transaction,
        reversedPeriods: result.reversedPeriods,
      };
    }

    if (status === PAYMENT_GATEWAY_STATUS.PAID) {
      const result = await this.paymentGatewayLock.runExclusive(String(orderId), () => (
        this.dataManager.completeMidtransPayment(orderId, gatewayData)
      ));
      let hotspotRecovery = { attempted: false, reason: "incomplete_account" };
      try {
        hotspotRecovery = await this.recoverHotspotAfterPayment(result.contact);
        if (hotspotRecovery.attempted && hotspotRecovery.action !== "already_active") {
          this.activityLog.push("info", "payment", `Hotspot pelanggan dipulihkan setelah pembayaran ${orderId}`, {
            contactId: result.contact.id,
            action: hotspotRecovery.action,
          });
        }
      } catch (error) {
        hotspotRecovery = { attempted: true, action: "failed", error: error.message };
        this.activityLog.push("error", "payment", `Pembayaran ${orderId} lunas tetapi pemulihan hotspot gagal`, {
          contactId: result.contact.id,
          error: error.message,
        });
      }
      const notificationContact = hotspotRecovery.contact
        || (typeof this.dataManager.getContact === "function" ? this.dataManager.getContact(result.contact.id) : null)
        || result.contact;
      if (!result.alreadyProcessed && typeof this.notificationBot.sendPaymentNotification === "function") {
        await this.notificationBot.sendPaymentNotification(
          notificationContact,
          orderId,
          result.transaction?.paymentType || localTransaction.paymentType || PAYMENT_TYPES.FULL_PAID,
          {
            paymentAmount: Math.max(0, Number(result.transaction?.amount || localTransaction.amount) || 0),
            paymentDate: result.transaction?.paidAt || new Date().toISOString(),
            remainingDebtAmount: Math.max(0, Number(notificationContact?.debtAmount) || 0),
            activeUntil: notificationContact?.serviceActiveUntil
              || notificationContact?.hotspotReactivationAt
              || null,
          }
        ).catch((error) => {
          this.activityLog.push("error", "payment", `Pembayaran ${orderId} lunas tetapi notifikasi WhatsApp gagal`, {
            error: error.message,
            contactId: result.contact.id,
          });
        });
      }
      this.activityLog.push("info", "payment", `Pembayaran Midtrans ${orderId} terverifikasi lunas`, {
        contactId: result.contact.id,
        amount: localTransaction.amount,
        alreadyProcessed: result.alreadyProcessed,
      });
      return { status, alreadyProcessed: result.alreadyProcessed, transaction: result.transaction, hotspotRecovery };
    }

    const updated = await this.dataManager.updatePaymentGatewayTransaction(orderId, {
      status,
      gatewayStatus: sanitizeInput(String(gatewayData.transaction_status || "pending")),
      transactionId: sanitizeInput(String(gatewayData.transaction_id || "")) || null,
      paymentMethod: sanitizeInput(String(gatewayData.payment_type || "")) || null,
    });
    return { status, alreadyProcessed: false, transaction: updated };
  }

  async reconcilePendingMidtransPayments(contactId = null) {
    if (!this.midtransService.isConfigured()) return { checked: 0, updated: 0, skipped: "disabled" };
    if (typeof this.dataManager.getPendingPaymentGatewayTransactions !== "function") {
      return { checked: 0, updated: 0, skipped: "unsupported" };
    }
    const pending = this.dataManager.getPendingPaymentGatewayTransactions(contactId);
    let updated = 0;
    const errors = [];
    for (const transaction of pending) {
      try {
        const result = await this.reconcileMidtransTransaction(transaction.orderId);
        if (result.status !== PAYMENT_GATEWAY_STATUS.PENDING) updated += 1;
      } catch (error) {
        errors.push({ orderId: transaction.orderId, error: error.message });
        this.activityLog.push("warn", "payment", `Rekonsiliasi Midtrans ${transaction.orderId} gagal: ${error.message}`);
      }
    }
    return { checked: pending.length, updated, errors };
  }

  setupRoutes() {
    this.app.use((req, res, next) => {
      const incomingRequestId = String(req.headers["x-request-id"] || "");
      req.requestId = /^[a-zA-Z0-9._:-]{1,128}$/.test(incomingRequestId)
        ? incomingRequestId
        : crypto.randomUUID();
      res.setHeader("X-Request-Id", req.requestId);
      res.setHeader(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
      );
      res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
      res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
      res.setHeader("X-DNS-Prefetch-Control", "off");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("X-Frame-Options", "DENY");
      res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
      if (CONFIG.NODE_ENV === "production" && req.secure) {
        res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
      }
      if (req.path.startsWith("/api/") || ["/login", "/dashboard", "/transport", "/pelanggan", "/pelanggan/login"].includes(req.path)) {
        res.setHeader("Cache-Control", "no-store");
      }
      next();
    });

    this.app.use((req, res, next) => {
      const startedAt = process.hrtime.bigint();
      res.on("finish", () => {
        if (res.statusCode < 400) return;
        const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
        this.activityLog.push(res.statusCode >= 500 ? "error" : "warn", "http", `${req.method} ${req.originalUrl} -> ${res.statusCode}`, {
          requestId: req.requestId,
          durationMs: Number(durationMs.toFixed(1)),
        });
      });
      next();
    });

    this.app.use(express.json({ limit: "1mb" }));
    this.app.use(express.urlencoded({ extended: true, limit: "1mb" }));

    this.app.use((req, res, next) => {
      if (!["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) return next();
      const transportFormPaths = new Set([
        "/transport/reset-pairing",
        "/transport/enable-sending",
        "/transport/disable-sending",
        "/transport/reconnect",
      ]);
      // Transport forms use a session-bound CSRF token because some reverse
      // proxies rewrite Origin on regular HTML form submissions.
      if (transportFormPaths.has(req.path)) return next();
      const origin = req.headers.origin;
      if (!origin) return next();

      try {
        const parsedOrigin = new URL(origin);
        const requestOrigin = new URL(`${req.protocol}://${req.get("host")}`).origin;
        const publicOrigin = CONFIG.PUBLIC_ORIGIN ? new URL(CONFIG.PUBLIC_ORIGIN).origin : "";
        if (parsedOrigin.origin === requestOrigin || (publicOrigin && parsedOrigin.origin === publicOrigin)) {
          return next();
        }
      } catch {
        // Invalid browser origins are rejected below.
      }

      return res.status(403).json({ success: false, error: "Cross-origin request ditolak." });
    });

    this.app.get("/healthz", (_req, res) => {
      res.setHeader("Cache-Control", "no-store");
      res.json({ status: "ok", uptimeSeconds: Math.floor(process.uptime()) });
    });

    this.app.get("/readyz", async (_req, res) => {
      res.setHeader("Cache-Control", "no-store");
      if (!this.ready) {
        return res.status(503).json({ status: "not_ready" });
      }

      try {
        if (typeof this.dataManager.healthCheck === "function") {
          await this.dataManager.healthCheck();
        }
        return res.json({ status: "ready" });
      } catch (error) {
        this.activityLog.push("error", "health", `Readiness check gagal: ${error.message}`);
        return res.status(503).json({ status: "not_ready" });
      }
    });

    this.app.get("/favicon.ico", (_req, res) => res.status(204).end());

    this.app.use("/public", (req, res, next) => {
      if (["/app.js", "/styles.css", "/interface.css", "/customer.js", "/customer.css", "/customer-login.js"].includes(req.path)) {
        res.setHeader("Cache-Control", "no-store, max-age=0");
      }
      next();
    }, express.static(CONFIG.PUBLIC_PATH, { etag: true, maxAge: "1h" }));
    this.app.get("/vendor/alpine.min.js", (_req, res) => {
      res.sendFile(require.resolve("alpinejs/dist/cdn.min.js"));
    });
    const fontAwesomePath = path.dirname(require.resolve("@fortawesome/fontawesome-free/package.json"));
    this.app.use("/vendor/fontawesome/css", express.static(path.join(fontAwesomePath, "css")));
    this.app.use("/vendor/fontawesome/webfonts", express.static(path.join(fontAwesomePath, "webfonts")));

    const hasApiKeyAccess = (req) => {
      const apiKey = req.headers["x-api-key"];
      const apiKeyIsConfigured = Boolean(CONFIG.WEB_API_KEY);
      return Boolean(apiKeyIsConfigured && apiKey && safeCompareString(apiKey, CONFIG.WEB_API_KEY));
    };

    const readSession = (req) => {
      const cookies = parseCookies(req.headers.cookie);
      const token = cookies[CONFIG.SESSION_COOKIE_NAME];
      const session = this.authManager.getSession(token);
      return { token, session };
    };

    const readCustomerSession = (req) => {
      const cookies = parseCookies(req.headers.cookie);
      const token = cookies[CONFIG.CUSTOMER_SESSION_COOKIE_NAME];
      const session = this.authManager.getCustomerSession(token);
      return { token, session };
    };

    const requireApiAuth = (req, res, next) => {
      if (hasApiKeyAccess(req)) {
        req.authUsingApiKey = true;
        return next();
      }

      const { session } = readSession(req);
      if (!session) {
        return res.status(401).json({ success: false, error: "Unauthorized" });
      }

      req.authSession = session;
      return next();
    };

    const requirePageAuth = (req, res, next) => {
      const { token, session } = readSession(req);
      if (!session) {
        return res.redirect("/login");
      }

      req.authSessionToken = token;
      req.authSession = session;
      return next();
    };

    const getTransportCsrfToken = (sessionToken) => crypto
      .createHmac("sha256", CONFIG.SESSION_SECRET)
      .update(`transport:${sessionToken}`)
      .digest("hex");

    const requireTransportFormAuth = (req, res, next) => {
      const { token, session } = readSession(req);
      if (!session) return res.redirect("/login");
      const submittedToken = sanitizeInput(String(req.body.csrfToken || ""));
      const expectedToken = getTransportCsrfToken(token);
      if (!submittedToken || !safeCompareString(submittedToken, expectedToken)) {
        return res.redirect(`/transport?error=${encodeURIComponent("Form sudah kedaluwarsa. Muat ulang halaman transport lalu coba lagi.")}`);
      }
      req.authSessionToken = token;
      req.authSession = session;
      return next();
    };

    const requireCustomerApiAuth = (req, res, next) => {
      const { token, session } = readCustomerSession(req);
      const portalData = session ? this.dataManager.getCustomerPortalData?.(session.contactId) : null;
      if (!session || !portalData || portalData.account.username !== session.username) {
        return res.status(401).json({ success: false, error: "Sesi pelanggan tidak valid. Silakan masuk kembali." });
      }
      req.customerSessionToken = token;
      req.customerSession = session;
      req.customerPortalData = portalData;
      return next();
    };

    const requireCustomerPageAuth = (req, res, next) => {
      const { session } = readCustomerSession(req);
      const portalData = session ? this.dataManager.getCustomerPortalData?.(session.contactId) : null;
      if (!session || !portalData || portalData.account.username !== session.username) {
        return res.redirect("/pelanggan/login");
      }
      req.customerSession = session;
      return next();
    };

    const handleApi = (handler) => async (req, res) => {
      try {
        const data = await handler(req, res);
        if (!res.headersSent) {
          res.json({ success: true, data });
        }
      } catch (error) {
        this.activityLog.push("error", "api", error.message);
        if (!res.headersSent) {
          const statusCode = error.statusCode || res.statusCode;
          res.status(statusCode >= 400 ? statusCode : 400).json({ success: false, error: error.message });
        }
      }
    };

    const requireRegisteredWhatsAppNumber = async (value) => {
      const phoneNumber = normalizePhoneNumber(value);
      if (!isValidPhoneNumber(phoneNumber)) {
        const error = new Error("Nomor WhatsApp harus berformat 628xxx.");
        error.statusCode = 400;
        throw error;
      }

      const result = await this.notificationBot.checkPhoneNumber(phoneNumber);
      if (!result.registered) {
        const error = new Error(`Nomor ${phoneNumber} tidak terdaftar di WhatsApp.`);
        error.code = "WHATSAPP_NUMBER_NOT_REGISTERED";
        error.statusCode = 422;
        throw error;
      }
      return result;
    };

    this.app.get("/", (req, res) => res.redirect("/dashboard"));
    this.app.get("/pelanggan/login", async (req, res, next) => {
      try {
        const { session } = readCustomerSession(req);
        const portalData = session ? this.dataManager.getCustomerPortalData?.(session.contactId) : null;
        if (session && portalData && portalData.account.username === session.username) {
          return res.redirect("/pelanggan");
        }
        res.send(await this.renderCustomerLoginPage());
      } catch (error) {
        next(error);
      }
    });

    this.app.post("/api/pelanggan/auth/login", handleApi(async (req, res) => {
      const username = sanitizeInput(req.body.username);
      const password = String(req.body.password || "");
      const sourceAddress = req.ip || req.socket?.remoteAddress || "unknown";
      const attemptKeys = [
        `customer-ip:${sourceAddress}`,
        `customer-account:${username.toLowerCase()}`,
      ];

      if (attemptKeys.some((key) => this.authManager.isLoginBlocked(key))) {
        const error = new Error("Terlalu banyak percobaan login. Coba lagi beberapa saat.");
        error.statusCode = 429;
        throw error;
      }

      const account = this.dataManager.findCustomerPortalAccount?.(username) || null;
      const passwordMatches = safeCompareString(password, account?.account?.password || "invalid-customer-password");
      if (!account || !passwordMatches) {
        attemptKeys.forEach((key) => this.authManager.recordLoginFailure(key));
        this.activityLog.push("warn", "customer-auth", `Login portal pelanggan gagal untuk ${username || "(kosong)"}`);
        const error = new Error("Username atau password salah.");
        error.statusCode = 401;
        throw error;
      }

      attemptKeys.forEach((key) => this.authManager.clearLoginFailures(key));
      const { token, session } = this.authManager.createCustomerSession({
        username: account.account.username,
        contactId: account.contact.id,
      });
      const secureCookie = CONFIG.SESSION_COOKIE_SECURE || req.secure;
      res.setHeader("Set-Cookie", serializeCookie(CONFIG.CUSTOMER_SESSION_COOKIE_NAME, token, {
        path: "/",
        httpOnly: true,
        sameSite: "Lax",
        secure: secureCookie,
        maxAge: Math.floor(CONFIG.SESSION_TTL / 1000),
      }));
      this.activityLog.push("info", "customer-auth", `Login portal sukses untuk ${account.account.username}`, {
        contactId: account.contact.id,
      });
      return {
        username: session.username,
        name: account.contact.name,
        expiresAt: new Date(session.expiresAt).toISOString(),
      };
    }));

    this.app.post("/api/pelanggan/auth/logout", handleApi(async (req, res) => {
      const { token, session } = readCustomerSession(req);
      this.authManager.destroyCustomerSession(token);
      const secureCookie = CONFIG.SESSION_COOKIE_SECURE || req.secure;
      res.setHeader("Set-Cookie", serializeCookie(CONFIG.CUSTOMER_SESSION_COOKIE_NAME, "", {
        path: "/",
        httpOnly: true,
        sameSite: "Lax",
        secure: secureCookie,
        maxAge: 0,
      }));
      if (session) {
        this.activityLog.push("info", "customer-auth", `Logout portal untuk ${session.username}`);
      }
      return { loggedOut: true };
    }));

    this.app.get("/api/pelanggan/account", requireCustomerApiAuth, handleApi(async (req) => {
      await this.reconcilePendingMidtransPayments(req.customerSession.contactId);
      const contact = typeof this.dataManager.getContact === "function"
        ? this.dataManager.getContact(req.customerSession.contactId)
        : null;
      if (contact) {
        const hydrated = typeof this.dataManager.hydrateContact === "function"
          ? this.dataManager.hydrateContact(contact)
          : contact;
        const hotspotStatus = normalizeHotspotProvisioningStatus(contact.hotspotProvisioningStatus);
        const recoveryFailed = hotspotStatus === HOTSPOT_PROVISIONING_STATUS.FAILED
          && contact.hotspotProvisioningOperation === HOTSPOT_PROVISIONING_OPERATION.ENABLE;
        if (hydrated.currentPaymentStatus === PAYMENT_STATUS.PAID
          && !hydrated.hasDebt
          && (isHotspotAccountUnavailable(hotspotStatus, contact.hotspotProvisioningError) || recoveryFailed)) {
          await this.recoverHotspotAfterPayment(contact).catch((error) => {
            this.activityLog.push("error", "payment", `Retry pemulihan hotspot pelanggan ${contact.id} gagal`, {
              contactId: contact.id,
              error: error.message,
            });
          });
        }
      }
      return this.dataManager.getCustomerPortalData(req.customerSession.contactId);
    }));
    this.app.post("/api/pelanggan/payments/midtrans", requireCustomerApiAuth, handleApi(async (req) => {
      if (!this.midtransService.isConfigured()) {
        const error = new Error("Pembayaran Midtrans belum diaktifkan oleh administrator.");
        error.statusCode = 503;
        throw error;
      }

      const prepaidPackage = req.customerPortalData.billing?.billingCycle === BILLING_CYCLES.PREPAID
        && req.customerPortalData.billing?.subscriptionType === SUBSCRIPTION_TYPES.RECURRING;
      const amount = Math.floor(Number(prepaidPackage
        ? req.customerPortalData.billing?.monthlyAmount
        : req.customerPortalData.billing?.totalAmount) || 0);
      const periods = prepaidPackage
        ? []
        : (req.customerPortalData.billing?.history || [])
          .filter((payment) => payment.status !== PAYMENT_STATUS.PAID)
          .map((payment) => payment.period);
      const paymentType = prepaidPackage ? PAYMENT_TYPES.ACTIVE_PERIOD : PAYMENT_TYPES.FULL_PAID;
      if (amount <= 0 || (!prepaidPackage && periods.length === 0)) {
        throw new Error(prepaidPackage
          ? "Harga paket prabayar belum diatur."
          : "Tidak ada tagihan yang perlu dibayar.");
      }

      return this.paymentGatewayLock.runExclusive(
        `create:${req.customerSession.contactId}`,
        async () => {
          const reusable = await this.dataManager.findReusablePaymentGatewayTransaction?.({
            contactId: req.customerSession.contactId,
            amount,
            periods,
            paymentType,
          });
          if (reusable) {
            return {
              orderId: reusable.orderId,
              redirectUrl: reusable.redirectUrl,
              amount: reusable.amount,
              reused: true,
            };
          }

          const orderId = `RB-${Date.now()}-${crypto.randomBytes(5).toString("hex").toUpperCase()}`;
          const transaction = await this.dataManager.createPaymentGatewayTransaction({
            orderId,
            contactId: req.customerSession.contactId,
            amount,
            periods,
            paymentType,
          });
          const fallbackFinishUrl = `${req.protocol}://${req.get("host")}/pelanggan?payment=finish`;
          const finishUrl = CONFIG.MIDTRANS_FINISH_URL || fallbackFinishUrl;

          try {
            const snap = await this.midtransService.createSnapTransaction({
              orderId,
              amount,
              customer: req.customerPortalData.customer,
              itemName: prepaidPackage
                ? "Paket internet prabayar 1 bulan"
                : `Tagihan internet ${req.customerPortalData.billing.periodLabel}`,
              finishUrl,
            });
            await this.dataManager.updatePaymentGatewayTransaction(orderId, {
              token: sanitizeInput(String(snap.token || "")) || null,
              redirectUrl: String(snap.redirect_url || ""),
              gatewayStatus: "pending",
            });
            if (!snap.redirect_url) throw new Error("Midtrans tidak mengembalikan URL pembayaran.");
            this.activityLog.push("info", "payment", `Transaksi Midtrans ${orderId} dibuat`, {
              contactId: transaction.contactId,
              amount,
              environment: CONFIG.MIDTRANS_IS_PRODUCTION ? "production" : "sandbox",
            });
            return { orderId, redirectUrl: snap.redirect_url, amount, reused: false };
          } catch (error) {
            await this.dataManager.updatePaymentGatewayTransaction(orderId, {
              status: PAYMENT_GATEWAY_STATUS.FAILED,
              gatewayStatus: "create_failed",
              error: sanitizeInput(error.message),
            }).catch(() => {});
            throw error;
          }
        }
      );
    }));

    this.app.post("/api/payments/midtrans/notification", handleApi(async (req) => {
      if (!this.midtransService.verifyNotificationSignature(req.body || {})) {
        const error = new Error("Signature notifikasi Midtrans tidak valid.");
        error.statusCode = 403;
        throw error;
      }

      const orderId = sanitizeInput(String(req.body.order_id || ""));
      if (!this.dataManager.getPaymentGatewayTransaction(orderId)) {
        this.activityLog.push("warn", "payment", `Notifikasi Midtrans untuk transaksi tidak dikenal ${orderId}`);
        return { received: true, ignored: "unknown_order" };
      }
      const result = await this.reconcileMidtransTransaction(orderId);
      return { received: true, status: result.status, alreadyProcessed: result.alreadyProcessed };
    }));

    this.app.put("/api/pelanggan/account/password", requireCustomerApiAuth, handleApi(async (req) => {
      const currentPassword = String(req.body.currentPassword || "");
      const newPassword = String(req.body.newPassword || "");
      const confirmation = String(req.body.confirmPassword || "");
      if (!currentPassword || !newPassword || !confirmation) {
        throw new Error("Password saat ini, password baru, dan konfirmasi wajib diisi.");
      }
      if (!safeCompareString(newPassword, confirmation)) {
        throw new Error("Konfirmasi password baru tidak sama.");
      }

      const portalData = await this.dataManager.updateCustomerPortalPassword(
        req.customerSession.contactId,
        currentPassword,
        newPassword
      );
      this.authManager.destroyCustomerSessionsForContact(
        req.customerSession.contactId,
        req.customerSessionToken
      );
      this.activityLog.push("info", "customer-auth", `Password akun pelanggan diubah untuk ${req.customerSession.username}`, {
        contactId: req.customerSession.contactId,
      });
      return portalData;
    }));
    this.app.put("/api/pelanggan/hotspot/password", requireCustomerApiAuth, handleApi(async (req) => {
      const currentPassword = String(req.body.currentPassword || "");
      const newPassword = String(req.body.newPassword || "");
      const confirmation = String(req.body.confirmPassword || "");
      if (!currentPassword || !newPassword || !confirmation) {
        throw new Error("Password saat ini, password baru, dan konfirmasi wajib diisi.");
      }
      if (!safeCompareString(newPassword, confirmation)) {
        throw new Error("Konfirmasi password baru tidak sama.");
      }

      const portalData = await this.changeCustomerHotspotPassword(
        req.customerSession.contactId,
        currentPassword,
        newPassword
      );
      this.authManager.destroyCustomerSessionsForContact(
        req.customerSession.contactId,
        req.customerSessionToken
      );
      return portalData;
    }));
    this.app.get("/pelanggan", requireCustomerPageAuth, async (_req, res, next) => {
      try {
        res.send(await this.renderCustomerPortal());
      } catch (error) {
        next(error);
      }
    });

    this.app.get("/login", async (req, res, next) => {
      try {
        const { session } = readSession(req);
        if (session) {
          return res.redirect("/dashboard");
        }
        res.send(await this.renderLoginPage());
      } catch (error) {
        next(error);
      }
    });

    this.app.post("/api/auth/login", handleApi(async (req, res) => {
      const username = sanitizeInput(req.body.username);
      const password = String(req.body.password || "");
      const attemptKey = req.ip || req.socket?.remoteAddress || "unknown";

      if (this.authManager.isLoginBlocked(attemptKey)) {
        const error = new Error("Terlalu banyak percobaan login. Coba lagi beberapa saat.");
        error.statusCode = 429;
        throw error;
      }

      if (!this.authManager.validateCredentials(username, password)) {
        this.authManager.recordLoginFailure(attemptKey);
        this.activityLog.push("error", "auth", `Login gagal untuk user ${username || "(kosong)"}`);
        const error = new Error("Username atau password salah.");
        error.statusCode = 401;
        throw error;
      }

      this.authManager.clearLoginFailures(attemptKey);
      const { token, session } = this.authManager.createSession(username);
      const secureCookie = CONFIG.SESSION_COOKIE_SECURE || req.secure;
      res.setHeader("Set-Cookie", serializeCookie(CONFIG.SESSION_COOKIE_NAME, token, {
        path: "/",
        httpOnly: true,
        sameSite: "Lax",
        secure: secureCookie,
        maxAge: Math.floor(CONFIG.SESSION_TTL / 1000),
      }));

      this.activityLog.push("info", "auth", `Login sukses untuk user ${username}`);
      return {
        username: session.username,
        expiresAt: new Date(session.expiresAt).toISOString(),
      };
    }));

    this.app.post("/api/auth/logout", handleApi(async (req, res) => {
      const { token, session } = readSession(req);
      this.authManager.destroySession(token);
      const secureCookie = CONFIG.SESSION_COOKIE_SECURE || req.secure;
      res.setHeader("Set-Cookie", serializeCookie(CONFIG.SESSION_COOKIE_NAME, "", {
        path: "/",
        httpOnly: true,
        sameSite: "Lax",
        secure: secureCookie,
        maxAge: 0,
      }));

      if (session) {
        this.activityLog.push("info", "auth", `Logout untuk user ${session.username}`);
      }

      return { loggedOut: true };
    }));

    this.app.get("/api/auth/me", requireApiAuth, handleApi(async (req) => ({
      username: req.authSession?.username || null,
      expiresAt: req.authSession ? new Date(req.authSession.expiresAt).toISOString() : null,
      usingApiKey: Boolean(req.authUsingApiKey),
    })));

    this.app.get("/dashboard", requirePageAuth, async (req, res, next) => {
      try {
        res.send(await this.renderDashboard());
      } catch (error) {
        next(error);
      }
    });
    this.app.post("/transport/reset-pairing", requireTransportFormAuth, async (req, res) => {
      try {
        const instanceId = sanitizeInput(req.body.instanceId) || null;
        if (sanitizeInput(req.body.confirmReset).toLowerCase() !== "yes") {
          throw new Error("Centang konfirmasi sebelum menghapus sesi dan membuat QR baru.");
        }
        await this.notificationBot.resetPairing(instanceId);
        this.activityLog.push("info", "notification", `Pairing Baileys ${instanceId || "primary"} direset tanpa restart aplikasi`);
        return res.redirect(`/transport?pairingReset=1${instanceId ? `&instance=${encodeURIComponent(instanceId)}` : ""}`);
      } catch (error) {
        this.activityLog.push("error", "notification", `Gagal mereset pairing Baileys: ${error.message}`);
        return res.redirect(`/transport?error=${encodeURIComponent(error.message)}`);
      }
    });
    this.app.post("/transport/enable-sending", requireTransportFormAuth, async (req, res) => {
      try {
        this.notificationBot.enableOutbound();
        this.activityLog.push("info", "notification", "Pengiriman WhatsApp diaktifkan manual dari halaman transport");
        return res.redirect("/transport?sendingEnabled=1");
      } catch (error) {
        this.activityLog.push("error", "notification", `Gagal mengaktifkan pengiriman WhatsApp: ${error.message}`);
        return res.redirect(`/transport?error=${encodeURIComponent(error.message)}`);
      }
    });
    this.app.post("/transport/disable-sending", requireTransportFormAuth, (req, res) => {
      this.notificationBot.disableOutbound();
      this.activityLog.push("info", "notification", "Pengiriman WhatsApp dijeda manual dari halaman transport");
      return res.redirect("/transport?sendingDisabled=1");
    });
    this.app.post("/transport/reconnect", requireTransportFormAuth, async (_req, res) => {
      try {
        await this.notificationBot.reconnect();
        return res.redirect("/transport");
      } catch (error) {
        return res.redirect(`/transport?error=${encodeURIComponent(error.message)}`);
      }
    });
    this.app.get("/transport", requirePageAuth, async (req, res) => {
      const csrfToken = getTransportCsrfToken(req.authSessionToken);
      const status = await this.notificationBot.getTransportStatus();
      if (status.whatsappProviderEnabled) {
        const instances = Array.isArray(status.instances) && status.instances.length > 0
          ? status.instances
          : [{
              id: "primary",
              role: "primary",
              connected: status.deviceReady,
              canSend: status.outboundEnabled,
              account: status.account,
              currentQR: status.currentQR,
              detail: status.transportError,
            }];
        const instanceCards = await Promise.all(instances.map(async (instance) => {
          const qrDataUrl = instance.currentQR
            ? await QRCode.toDataURL(instance.currentQR, { width: 280, margin: 2, errorCorrectionLevel: "M" })
            : null;
          const stateClass = instance.connected ? "connected" : (qrDataUrl ? "pairing" : "disconnected");
          return `
            <section class="connection-card">
              <div class="connection-heading">
                <div><strong>${escapeHtml(instance.id)}</strong><small>${escapeHtml(instance.role || "backup")}</small></div>
                <span class="status-badge ${stateClass}">${instance.connected ? (instance.id === status.activeInstanceId ? "Aktif" : "Siaga") : (qrDataUrl ? "Perlu QR" : "Terputus")}</span>
              </div>
              ${instance.account ? `<p class="account"><span>Akun terhubung</span><strong>${escapeHtml(instance.account)}</strong></p>` : ""}
              ${instance.detail ? `<p class="connection-detail">${escapeHtml(instance.detail)}</p>` : ""}
              ${qrDataUrl ? `<div class="qr-panel"><img src="${qrDataUrl}" alt="Kode QR untuk menghubungkan ${escapeHtml(instance.id)}" width="280" height="280"><p>Pindai melalui menu Perangkat tertaut di WhatsApp.</p></div>` : ""}
              <form method="post" action="/transport/reset-pairing" class="reset-form">
                <input type="hidden" name="csrfToken" value="${csrfToken}">
                <input type="hidden" name="instanceId" value="${escapeHtml(instance.id)}">
                <label>
                  <input type="checkbox" name="confirmReset" value="yes" required>
                  <span>Saya paham sesi ${escapeHtml(instance.id)} akan dihapus dan harus memindai QR lagi.</span>
                </label>
                <button type="submit" class="button danger-secondary">Hapus sesi dan buat QR baru</button>
              </form>
            </section>
          `;
        }));
        const sendingEnabled = req.query.sendingEnabled === "1";
        const sendingDisabled = req.query.sendingDisabled === "1";
        const pairingReset = req.query.pairingReset === "1";
        const error = sanitizeInput(req.query.error);
        const connectedCount = instances.filter((item) => item.connected).length;
        return res.status(status.deviceReady ? 200 : 503).send(`
          <!doctype html>
          <html lang="id">
          <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width,initial-scale=1">
            <title>Status WhatsApp</title>
            <style>
              :root{--primary:#2563eb;--primary-dark:#1d4ed8;--ink:#182230;--muted:#667085;--border:#e4e7ec;--canvas:#f6f7f9;--success:#15803d;--warning:#9a6700;--danger:#b42318}*{box-sizing:border-box}body{min-height:100vh;margin:0;color:var(--ink);background:var(--canvas);font:14px/1.5 Inter,"Segoe UI",Roboto,Arial,sans-serif;-webkit-font-smoothing:antialiased}.transport-page{width:min(960px,calc(100% - 40px));margin:0 auto;padding:28px 0 44px}.topbar{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:28px}.brand{display:flex;align-items:center;gap:11px;color:inherit;text-decoration:none}.brand-mark{display:inline-flex;width:38px;height:38px;align-items:center;justify-content:center;color:#fff;border-radius:9px;background:var(--primary);font-size:18px;font-weight:800}.brand-copy{display:flex;flex-direction:column}.brand-copy strong{font-size:14px}.brand-copy small{margin-top:1px;color:var(--muted);font-size:11px}.top-actions{display:flex;gap:8px}.button{display:inline-flex;min-height:44px;align-items:center;justify-content:center;gap:7px;padding:9px 13px;color:#344054;border:1px solid var(--border);border-radius:8px;background:#fff;font-family:inherit;font-size:13px;font-weight:700;line-height:1.2;text-decoration:none;cursor:pointer}.button:hover{border-color:#bfdbfe;background:#eff6ff}.button.primary{color:#fff;border-color:var(--primary);background:var(--primary)}.button.primary:hover{background:var(--primary-dark)}.button.danger{color:#fff;border-color:var(--danger);background:var(--danger)}.button.danger-secondary{color:var(--danger);border-color:#f0c7c3;background:#fff}.button.danger-secondary:hover{background:#fff7f6}.page-heading{margin-bottom:20px}.eyebrow{margin:0 0 6px;color:var(--primary-dark);font-size:11px;font-weight:800;text-transform:uppercase}.page-heading h1{margin:0;font-size:clamp(25px,4vw,32px);line-height:1.2}.page-heading p{max-width:680px;margin:8px 0 0;color:var(--muted)}.notice{margin:0 0 12px;padding:11px 13px;border:1px solid;border-radius:8px;font-weight:650}.notice.success{color:var(--success);border-color:#bbdec7;background:#f2fbf5}.notice.warning{color:#805600;border-color:#f2d28d;background:#fffaf0}.notice.error{color:var(--danger);border-color:#f0c7c3;background:#fff7f6}.summary-bar{display:flex;align-items:center;justify-content:space-between;gap:18px;margin:18px 0;padding:15px 16px;border:1px solid var(--border);border-radius:10px;background:#fff}.summary-bar strong{display:block;font-size:15px}.summary-bar p{margin:3px 0 0;color:var(--muted);font-size:12px}.summary-status{display:flex;align-items:center;gap:8px;white-space:nowrap}.summary-status::before{width:8px;height:8px;border-radius:50%;background:${status.outboundEnabled ? "#16a34a" : "#d97706"};content:""}.connection-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px}.connection-card{min-width:0;padding:18px;border:1px solid var(--border);border-radius:10px;background:#fff}.connection-heading{display:flex;align-items:center;justify-content:space-between;gap:12px}.connection-heading strong{font-size:16px}.connection-heading small{display:block;margin-top:2px;color:var(--muted);font-size:10px;font-weight:750;text-transform:uppercase}.status-badge{padding:5px 8px;border-radius:6px;font-size:11px;font-weight:750}.status-badge.connected{color:var(--success);background:#edf8f1}.status-badge.pairing{color:var(--warning);background:#fff7e6}.status-badge.disconnected{color:var(--danger);background:#fff0ef}.account{display:flex;justify-content:space-between;gap:12px;margin:16px 0 0;padding:10px 11px;border-radius:8px;background:#f8fafc}.account span{color:var(--muted);font-size:12px}.account strong{overflow-wrap:anywhere;font-size:12px;text-align:right}.connection-detail{margin:12px 0 0;color:var(--muted);font-size:12px}.qr-panel{margin-top:16px;text-align:center}.qr-panel img{display:block;width:min(100%,280px);height:auto;margin:auto;border:1px solid var(--border);border-radius:8px}.qr-panel p{margin:9px 0 0;color:var(--muted);font-size:12px}.reset-form{margin-top:18px;padding-top:16px;border-top:1px solid var(--border)}.reset-form label{display:flex;align-items:flex-start;gap:9px;margin-bottom:12px;color:#7a342d;font-size:12px}.reset-form input{width:17px;height:17px;flex:0 0 17px;margin:1px 0 0;accent-color:var(--danger)}.sending-panel{display:flex;align-items:center;justify-content:space-between;gap:20px;margin-top:12px;padding:18px;border:1px solid var(--border);border-radius:10px;background:#fff}.sending-panel h2{margin:0;font-size:16px}.sending-panel p{max-width:600px;margin:5px 0 0;color:var(--muted);font-size:12px}.sending-actions{display:flex;flex:0 0 auto;gap:8px}.helper{margin:18px 0 0;padding:13px 15px;color:var(--muted);border-left:3px solid #bfdbfe;background:#f8fbff;font-size:12px}.disabled-card{max-width:560px;margin:15vh auto 0;padding:24px;border:1px solid var(--border);border-radius:10px;background:#fff}.disabled-card h1{margin:0 0 8px;font-size:22px}.disabled-card p{margin:0 0 18px;color:var(--muted)}:focus-visible{outline:3px solid #2563eb;outline-offset:2px}@media(max-width:640px){.transport-page{width:min(100% - 20px,960px);padding-top:14px}.topbar{align-items:flex-start;margin-bottom:22px}.brand-copy small{display:none}.top-actions{flex-direction:column}.page-heading{margin-bottom:16px}.summary-bar,.sending-panel{align-items:flex-start;flex-direction:column}.sending-actions{width:100%;flex-direction:column}.sending-actions form,.sending-actions .button{width:100%}.connection-card{padding:15px}.reset-form .button{width:100%}}@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important;transition:none!important}}
            </style>
            <style>
              :root{--primary:#0f6b57;--primary-dark:#0a5142;--ink:#17251f;--muted:#5f6f67;--border:#d8ddd8;--canvas:#f4f2ec;--success:#176b45;--warning:#9a5d00;--danger:#a5312b}
              .skip-link{position:fixed;top:10px;left:10px;z-index:20;padding:10px 14px;color:#fff;border-radius:7px;background:var(--ink);font-weight:700;text-decoration:none;transform:translateY(-160%)}
              .skip-link:focus{transform:translateY(0)}
              .button{border-color:#77877f}.button:hover{border-color:#0f6b57;background:#e6f2ee}
              .button.danger-secondary{border-color:#d9aaa5}
              .page-heading .eyebrow,.connection-heading small{text-transform:none}
              .summary-bar,.connection-card,.sending-panel,.disabled-card{box-shadow:none}
              .helper{border:1px solid #c9ddd6;border-radius:8px;background:#f9fbfa}
              :focus-visible{outline-color:#c9572a}
            </style>
          </head>
          <body>
            <a class="skip-link" href="#transport-content">Langsung ke konten</a>
            <main id="transport-content" class="transport-page" tabindex="-1">
              <header class="topbar">
                <a class="brand" href="/dashboard"><span class="brand-mark">R</span><span class="brand-copy"><strong>Reminder Bot</strong><small>Pengaturan koneksi</small></span></a>
                <nav class="top-actions" aria-label="Aksi halaman"><a class="button" href="/dashboard">Kembali</a><a class="button" href="/transport">Muat ulang</a></nav>
              </header>
              <section class="page-heading">
                <p class="eyebrow">Kanal pengiriman</p>
                <h1>Status WhatsApp</h1>
                <p>Pantau koneksi, atur pengiriman, atau pindai ulang QR bila perangkat terputus.</p>
              </section>
              ${sendingEnabled ? '<p class="notice success" role="status">Pengiriman WhatsApp sudah diaktifkan.</p>' : ""}
              ${sendingDisabled ? '<p class="notice warning" role="status">Pengiriman WhatsApp sudah dijeda.</p>' : ""}
              ${pairingReset ? '<p class="notice success" role="status">Sesi dihapus. QR baru sedang disiapkan; muat ulang halaman beberapa saat lagi.</p>' : ""}
              ${error ? `<p class="notice error" role="alert">${escapeHtml(error)}</p>` : ""}
              <section class="summary-bar" aria-label="Ringkasan koneksi">
                <div><strong>${connectedCount} dari ${instances.length} koneksi terhubung</strong><p>Satu koneksi aktif digunakan dan sistem dapat berpindah ke koneksi cadangan.</p></div>
                <span class="summary-status">Pengiriman ${status.outboundEnabled ? "aktif" : "dijeda"}</span>
              </section>
              <div class="connection-grid">${instanceCards.join("")}</div>
              <section class="sending-panel">
                <div><h2>Kontrol pengiriman</h2><p>${status.outboundEnabled ? "Pesan dapat dikirim melalui koneksi aktif." : "Periksa antrean pengingat sebelum mengaktifkan kembali pengiriman."}</p></div>
                <div class="sending-actions">
                  <form method="post" action="/transport/reconnect"><input type="hidden" name="csrfToken" value="${csrfToken}"><button type="submit" class="button">Hubungkan ulang</button></form>
                  ${status.outboundEnabled ? `
                    <form method="post" action="/transport/disable-sending"><input type="hidden" name="csrfToken" value="${csrfToken}"><button type="submit" class="button danger">Jeda pengiriman</button></form>
                  ` : `
                    <form method="post" action="/transport/enable-sending"><input type="hidden" name="csrfToken" value="${csrfToken}"><button type="submit" class="button primary">Aktifkan pengiriman</button></form>
                  `}
                </div>
              </section>
              <p class="helper">Untuk menghubungkan QR, buka WhatsApp → Perangkat tertaut → Tautkan perangkat. Gunakan sesi berbeda untuk setiap koneksi.</p>
            </main>
          </body>
          </html>
        `);
      }

      return res.send(`<!doctype html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Status WhatsApp</title><style>*{box-sizing:border-box}body{margin:0;padding:20px;color:#17251f;background:#f4f2ec;font:14px/1.5 "Segoe UI",Roboto,Arial,sans-serif}.disabled-card{max-width:560px;margin:15vh auto 0;padding:24px;border:1px solid #d8ddd8;border-radius:10px;background:#fff}.disabled-card h1{margin:0 0 8px;font-size:22px}.disabled-card p{margin:0 0 18px;color:#5f6f67}.disabled-card a{display:inline-flex;min-height:44px;align-items:center;padding:9px 13px;color:#fff;border-radius:8px;background:#0f6b57;font-weight:700;text-decoration:none}.disabled-card a:hover{background:#0a5142}.disabled-card a:focus-visible{outline:3px solid #c9572a;outline-offset:2px}</style></head><body><main class="disabled-card"><h1>WhatsApp belum aktif</h1><p>Aktifkan BAILEYS_ENABLED pada environment untuk menggunakan kanal WhatsApp.</p><a href="/dashboard">Kembali ke dashboard</a></main></body></html>`);
    });

    this.app.get("/api/status", requireApiAuth, handleApi(async () => {
      const bot = await this.notificationBot.getTransportStatus();
      return {
        bot,
        summary: this.dataManager.getDashboardSummary(),
        settings: this.dataManager.getSettings(),
        billingPeriod: getBillingPeriodKey(new Date(), this.dataManager.getTimezone()),
        scheduler: {
          isProcessing: this.reminderScheduler.isProcessing,
          hotspotReactivationProcessing: this.hotspotReactivationScheduler?.isProcessing || false,
        },
      };
    }));

    this.app.get("/api/whatsapp/status", requireApiAuth, handleApi(async () => this.notificationBot.getTransportStatus()));
    this.app.post("/api/whatsapp/reconnect", requireApiAuth, handleApi(async () => this.notificationBot.reconnect()));
    this.app.post("/api/whatsapp/validate-number", requireApiAuth, handleApi(async (req) => {
      const result = await requireRegisteredWhatsAppNumber(req.body.phoneNumber || req.body.phone || "");
      return { phoneNumber: result.phoneNumber, registered: true };
    }));
    this.app.post("/api/whatsapp/test", requireApiAuth, handleApi(async (req) => {
      const phoneNumber = normalizePhoneNumber(req.body.phoneNumber || req.body.phone || "");
      const message = sanitizeMultilineText(req.body.message || "");
      if (phoneNumber || message) {
        if (!isValidPhoneNumber(phoneNumber)) throw new Error("Nomor tujuan tidak valid.");
        if (!message) throw new Error("Pesan test wajib diisi.");
        const result = await this.notificationBot.sendMessage(phoneNumber, message, {
          maxAttempts: 1,
          context: { type: "test" },
        });
        const deliveryConfirmed = result.deliveryStatus === "delivered" || result.deliveryStatus === "read";
        this.activityLog.push(deliveryConfirmed ? "info" : "warn", "manual", deliveryConfirmed
          ? `WhatsApp test message delivered to ${phoneNumber}`
          : `WhatsApp test message accepted; delivery pending for ${phoneNumber}`, {
          event: "whatsapp.message.sent",
          provider: result.provider,
          deliveryStatus: result.deliveryStatus || "accepted",
        });
        return { type: "message", phoneNumber, ...result };
      }
      return { type: "connection", ...(await this.notificationBot.testConnection()) };
    }));

    this.app.get("/api/logs", requireApiAuth, handleApi(async () => this.activityLog.list()));

    registerCustomerRoutes({
      app: this.app,
      requireApiAuth,
      handleApi,
      dataManager: this.dataManager,
      notificationBot: this.notificationBot,
      activityLog: this.activityLog,
      hotspotReactivationScheduler: this.hotspotReactivationScheduler,
      backgroundOperationLock: this.backgroundOperationLock,
      hotspotProvisioningStatus: HOTSPOT_PROVISIONING_STATUS,
      hotspotProvisioningOperation: HOTSPOT_PROVISIONING_OPERATION,
      hotspotAccessModes: HOTSPOT_ACCESS_MODES,
      normalizeMacAddresses,
      normalizeHotspotProvisioningStatus,
      getContactHotspotAccessMode,
      isPrepaidPackage,
      requireRegisteredWhatsAppNumber,
      resolveContactNetworkLink: (payload, current) => this.resolveContactNetworkLink(payload, current),
      provisionHotspotContact: (contact, options) => this.provisionHotspotContact(contact, options),
      setHotspotContactAccessMode: (contact, mode) => this.setHotspotContactAccessMode(contact, mode),
      syncContactIpBindings: (contact, macAddresses) => this.syncContactIpBindings(contact, macAddresses),
      deleteContactWithHotspot: (contactId) => this.deleteContactWithHotspot(contactId),
      setHotspotContactDisabled: (contact, disabled) => this.setHotspotContactDisabled(contact, disabled),
      purchaseActivePeriod: (contactId) => this.purchaseActivePeriod(contactId),
      createBackgroundJob: (options) => this.createBackgroundJob(options),
      recoverHotspotAfterPayment: (contact) => this.recoverHotspotAfterPayment(contact),
    });

    this.app.get("/api/mikrotik/profiles", requireApiAuth, handleApi(async () => this.mikrotikService.getHotspotProfiles()));
    this.app.get("/api/mikrotik/hotspot-servers", requireApiAuth, handleApi(async () => this.mikrotikService.getHotspotServers()));
    this.app.get("/api/mikrotik/hotspot-users", requireApiAuth, handleApi(async () => this.mikrotikService.getHotspotUsers()));
    registerVoucherRoutes({
      app: this.app,
      requireApiAuth,
      handleApi,
      dataManager: this.dataManager,
      mikrotikService: this.mikrotikService,
      voucherRevenueSyncScheduler: this.voucherRevenueSyncScheduler,
      voucherProfileLock: this.voucherProfileLock,
      voucherGenerationLock: this.voucherGenerationLock,
      createVoucherGenerationJob: (payload) => this.createVoucherGenerationJob(payload),
      getBackgroundJob: (jobId, expectedType) => this.getBackgroundJob(jobId, expectedType),
      activityLog: this.activityLog,
    });
    this.app.get("/api/jobs/:jobId", requireApiAuth, handleApi(async (req) => (
      this.getBackgroundJob(req.params.jobId)
    )));
    this.app.get("/api/mikrotik/netwatch", requireApiAuth, handleApi(async () => (
      this.buildNetworkMonitorView(await this.mikrotikService.getNetwatchStatus())
    )));
    this.app.post("/api/mikrotik/backup/send", requireApiAuth, handleApi(async (_req, res) => {
      if (!TelegramManager.isConfigured()) {
        throw new Error("Transport backup Telegram belum siap. Isi TELEGRAM_BOT_TOKEN dan TELEGRAM_CHAT_IDS.");
      }

      const recipients = TelegramManager.getChatIds();
      if (recipients.length === 0) {
        throw new Error("TELEGRAM_CHAT_IDS masih kosong.");
      }

      const job = this.createBackgroundJob({
        type: "MIKROTIK_BACKUP",
        total: recipients.length,
        run: (update) => this.backgroundOperationLock.runExclusive("mikrotik-backup", async () => {
          update({ phase: "CREATING_BACKUP", completed: 0, total: recipients.length });
          const backup = await this.mikrotikService.generateDailyBackupFile();
          try {
            const caption = `Backup MikroTik manual\nWaktu: ${new Date().toLocaleString("id-ID", { timeZone: this.dataManager.getTimezone() })}`;
            const results = [];

            for (const chatId of recipients) {
              try {
                await this.notificationBot.sendTelegramFile(chatId, backup.filePath, caption);
                results.push({ chatId, status: "sent", provider: "telegram" });
              } catch (error) {
                results.push({ chatId, status: "failed", error: error.message, provider: "telegram" });
              }
              update({ phase: "SENDING", completed: results.length, total: recipients.length });
            }

            this.activityLog.push("info", "mikrotik-backup", "Pengiriman backup MikroTik manual dieksekusi", {
              fileName: backup.fileName,
              results,
            });

            return {
              fileName: backup.fileName,
              results,
            };
          } finally {
            await backup.cleanup().catch((error) => {
              this.activityLog.push("warn", "mikrotik-backup", `Gagal membersihkan file backup sementara: ${error.message}`);
            });
          }
        }),
      });
      res.status(202);
      return job;
    }));

    this.app.get("/api/reminders", requireApiAuth, handleApi(async () => this.dataManager.getSortedReminders()));
    this.app.get("/api/reminders/sent", requireApiAuth, handleApi(async () => this.dataManager.getSentReminders()));

    this.app.get("/api/templates", requireApiAuth, handleApi(async () => this.templateManager.listTemplates()));
    this.app.post("/api/templates", requireApiAuth, handleApi(async (req) => this.templateManager.createTemplate(req.body.name, req.body.content)));
    this.app.put("/api/templates/:name", requireApiAuth, handleApi(async (req) => {
      const template = await this.templateManager.updateTemplate(req.params.name, req.body.content);
      const sync = await this.dataManager.syncActiveRemindersWithTemplates([template]);
      return { ...template, remindersMatched: sync.matched, remindersUpdated: sync.updated };
    }));
    this.app.delete("/api/templates/:name", requireApiAuth, handleApi(async (req) => this.templateManager.deleteTemplate(req.params.name)));

    this.app.get("/api/settings", requireApiAuth, handleApi(async () => this.dataManager.getSettings()));
    this.app.put("/api/settings", requireApiAuth, handleApi(async (req) => this.dataManager.updateSettings(req.body)));

    this.app.get("/api/admin-recipients", requireApiAuth, handleApi(async () => this.dataManager.getAdminRecipients()));
    this.app.put("/api/admin-recipients", requireApiAuth, handleApi(async (req) => {
      const recipients = Array.isArray(req.body.recipients)
        ? req.body.recipients.map(normalizePhoneNumber).filter(Boolean)
        : String(req.body.recipients || "")
            .split(/\r?\n|,/)
            .map(normalizePhoneNumber)
            .filter(Boolean);

      const invalid = recipients.filter((phoneNumber) => !isValidPhoneNumber(phoneNumber));
      if (invalid.length > 0) {
        throw new Error(`Nomor admin tidak valid: ${invalid.join(", ")}`);
      }

      return this.dataManager.setAdminRecipients([...new Set(recipients)]);
    }));

    this.app.post("/api/notifications/test", requireApiAuth, handleApi(async (req) => {
      const message = sanitizeMultilineText(req.body.message);
      const requestedPhone = normalizePhoneNumber(req.body.phoneNumber);
      const contactId = sanitizeInput(req.body.contactId);
      const selectedContact = contactId ? this.dataManager.getContact(contactId) : null;
      const phoneNumber = selectedContact?.phoneNumber || requestedPhone;

      if (contactId && !selectedContact) throw new Error("Contact tidak ditemukan.");
      if (!isValidPhoneNumber(phoneNumber)) throw new Error("Nomor tujuan tidak valid.");
      if (!message) throw new Error("Pesan notifikasi wajib diisi.");

      const delivery = await this.notificationBot.sendMessage(phoneNumber, message);
      const deliveryStatus = delivery.deliveryStatus || "accepted";
      const deliveryConfirmed = deliveryStatus === "delivered" || deliveryStatus === "read";
      this.activityLog.push(deliveryConfirmed ? "info" : "warn", "manual", deliveryConfirmed
        ? `Manual notification delivered to ${phoneNumber}`
        : `Manual notification accepted by WhatsApp; delivery pending for ${phoneNumber}`, { deliveryStatus });
      return {
        phoneNumber,
        contactId: selectedContact?.id || null,
        contactName: selectedContact?.name || null,
        status: deliveryStatus,
        deliveryStatus,
        messageId: delivery.messageId || null,
      };
    }));

    this.app.post("/api/notifications/admin-broadcast", requireApiAuth, handleApi(async (req, res) => {
      const title = sanitizeInput(req.body.title) || "Status Bot";
      const body = sanitizeMultilineText(req.body.message);
      if (!body) throw new Error("Pesan broadcast wajib diisi.");
      const total = Math.max(1, Number(this.dataManager.getAdminRecipients().length) || 0);
      const job = this.createBackgroundJob({
        type: "ADMIN_BROADCAST",
        total,
        run: (update) => this.backgroundOperationLock.runExclusive("admin-broadcast", () => (
          this.notificationBot.sendAdminBroadcast(title, body, { onProgress: update })
        )),
      });
      res.status(202);
      return job;
    }));

    this.app.post("/api/notifications/broadcast", requireApiAuth, handleApi(async (req, res) => {
      const title = sanitizeInput(req.body.title) || "Pengumuman";
      const templateName = sanitizeInput(req.body.templateName || "");
      let body = sanitizeMultilineText(req.body.message);
      if (templateName) {
        const templatePath = this.templateManager.getTemplatePath(templateName);
        body = sanitizeMultilineText(await fs.readFile(templatePath, "utf-8"));
      }
      if (!body) throw new Error("Pesan broadcast wajib diisi.");
      const settings = this.dataManager.getSettings();
      const companyName = sanitizeInput(settings.companyName) || DEFAULT_SETTINGS.companyName;
      const supportSignature = sanitizeInput(settings.supportSignature)
        || DEFAULT_SETTINGS.supportSignature;
      const total = Math.max(1, Number(this.dataManager.getContacts().length) || 0);
      const job = this.createBackgroundJob({
        type: "CONTACT_BROADCAST",
        total,
        run: (update) => this.backgroundOperationLock.runExclusive("contact-broadcast", async () => (
          this.notificationBot.sendContactBroadcast(title, body, {
            onProgress: update,
            renderMessage: (contact, content) =>
              this.templateManager.applyTemplate(content, {
                name: contact?.name || "",
                phoneNumber: contact?.phoneNumber || "",
                date: new Date().toLocaleDateString("id-ID", { timeZone: this.dataManager.getTimezone() }),
                companyName,
                companyNameUpper: companyName.toUpperCase(),
                supportSignature,
              }),
          })
        )),
      });
      res.status(202);
      return job;
    }));

    this.app.post("/api/scheduler/run", requireApiAuth, handleApi(async (_req, res) => {
      const job = this.createBackgroundJob({
        type: "REMINDER_SCHEDULER",
        total: 1,
        run: (update) => this.backgroundOperationLock.runExclusive("reminder-scheduler", async () => {
          update({ phase: "PROCESSING", completed: 0, total: 1 });
          await this.reminderScheduler.processDueReminders();
          update({ phase: "COMPLETED", completed: 1, total: 1 });
          return { completed: true };
        }),
      });
      res.status(202);
      return job;
    }));

    this.app.get("/api/payments/history", requireApiAuth, handleApi(async () => {
      const history = this.dataManager.getAllPaymentsHistory();
      return Object.fromEntries(Object.entries(history).map(([period, item]) => [period, {
        ...item,
        contacts: item.contacts.map((contact) => this.dataManager.toPublicContact(contact)),
      }]));
    }));
    this.app.get("/api/payments/export.xlsx", requireApiAuth, handleApi(async (req, res) => {
      const workbook = await this.dataManager.createPaymentRecapWorkbook();
      const period = getBillingPeriodKey(new Date(), this.dataManager.getTimezone());
      const buffer = await workbook.xlsx.writeBuffer();
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", `attachment; filename="rekap-pembayaran-${period}.xlsx"`);
      res.setHeader("Content-Length", buffer.length);
      res.send(Buffer.from(buffer));
    }));
    this.app.get("/api/payments/current", requireApiAuth, handleApi(async () => {
      const now = new Date();
      const { year: currentYear, month: currentMonth } = getBillingPeriodParts(
        now,
        this.dataManager.getTimezone()
      );
      const payments = this.dataManager.getPaymentsByMonth(currentYear, currentMonth);
      const allHistory = this.dataManager.getAllPaymentsHistory();
      const prevMonth = currentMonth === 1 ? 12 : currentMonth - 1;
      const prevYear = currentMonth === 1 ? currentYear - 1 : currentYear;
      const prevPayments = allHistory[`${prevYear}-${String(prevMonth).padStart(2, "0")}`]?.total || 0;
      const growth = prevPayments > 0 ? Number((((payments.length - prevPayments) / prevPayments) * 100).toFixed(1)) : 0;

      return {
        current: {
          year: currentYear,
          month: currentMonth,
          total: payments.length,
          contacts: payments.map((contact) => this.dataManager.toPublicContact(contact)),
        },
        previous: { year: prevYear, month: prevMonth, total: prevPayments },
        growth,
      };
    }));

    this.app.get("/api/payments/:year/:month", requireApiAuth, handleApi(async (req) => {
      const year = Number(req.params.year);
      const month = Number(req.params.month);
      if (!year || !month || year < 2000 || year > 2100 || month < 1 || month > 12) {
        throw new Error("Invalid year or month");
      }

      const periodKey = makeBillingPeriodKey(year, month);
      return this.dataManager.getPaymentsByMonth(year, month).map((contact) => {
        const payment = contact.paymentMonths?.[periodKey] || {};
        return {
          id: contact.id,
          name: contact.name,
          phoneNumber: contact.phoneNumber,
          paymentDate: payment.paidDate || null,
          paymentStatus: payment.status || PAYMENT_STATUS.UNPAID,
          paymentType: payment.paymentType || null,
        };
      });
    }));

    this.app.use((req, res) => {
      if (req.path.startsWith("/api/")) {
        return res.status(404).json({ success: false, error: "Endpoint tidak ditemukan." });
      }
      return res.status(404).type("text/plain").send("Halaman tidak ditemukan.");
    });

    this.app.use((error, req, res, _next) => {
      const requestedStatus = Number(error.statusCode || error.status);
      const statusCode = requestedStatus >= 400 && requestedStatus <= 599 ? requestedStatus : 500;
      const publicMessage = statusCode < 500 ? error.message : "Terjadi kesalahan internal.";
      this.activityLog.push("error", "http", `Request ${req.requestId || "unknown"} gagal: ${error.message}`, {
        requestId: req.requestId || null,
        method: req.method,
        path: req.originalUrl,
        statusCode,
      });

      if (res.headersSent) return _next(error);
      if (req.path.startsWith("/api/")) {
        res.status(statusCode).json({ success: false, error: publicMessage, requestId: req.requestId });
        return;
      }
      res.status(statusCode).type("text/plain").send(`${publicMessage}\nRequest ID: ${req.requestId}`);
    });
  }

  async renderDashboard() {
    const title = escapeHtml(this.dataManager.getSettings().dashboardTitle);
    const templatePath = path.join(CONFIG.PUBLIC_PATH, "index.html");
    const html = await fs.readFile(templatePath, "utf-8");

    return html.replace(/__DASHBOARD_TITLE__/g, title);
  }

  async renderLoginPage() {
    const title = escapeHtml(this.dataManager.getSettings().dashboardTitle);
    const templatePath = path.join(CONFIG.PUBLIC_PATH, "login.html");
    const html = await fs.readFile(templatePath, "utf-8");
    return html.replace(/__DASHBOARD_TITLE__/g, title);
  }

  async renderCustomerLoginPage() {
    const settings = this.dataManager.getSettings();
    const title = escapeHtml(settings.companyName || settings.dashboardTitle);
    const templatePath = path.join(CONFIG.PUBLIC_PATH, "customer-login.html");
    const html = await fs.readFile(templatePath, "utf-8");
    return html.replace(/__CUSTOMER_PORTAL_TITLE__/g, title);
  }

  async renderCustomerPortal() {
    const settings = this.dataManager.getSettings();
    const title = escapeHtml(settings.companyName || settings.dashboardTitle);
    const templatePath = path.join(CONFIG.PUBLIC_PATH, "customer.html");
    const html = await fs.readFile(templatePath, "utf-8");
    return html.replace(/__CUSTOMER_PORTAL_TITLE__/g, title);
  }

  async start() {
    if (this.server) return this.server;
    this.ready = true;

    return new Promise((resolve, reject) => {
      const server = this.app.listen(CONFIG.PORT, CONFIG.HOST);
      this.server = server;
      const handleError = (error) => {
        this.server = null;
        reject(error);
      };
      server.once("error", handleError);
      server.once("listening", () => {
        server.off("error", handleError);
        this.activityLog.push("info", "web", `Dashboard running at http://${CONFIG.HOST}:${CONFIG.PORT}/dashboard`);
        this.activityLog.push("info", "web", `WhatsApp provider status page running at http://${CONFIG.HOST}:${CONFIG.PORT}/transport`);
        resolve(server);
      });
    });
  }

  async stop(timeoutMs = Math.min(CONFIG.SHUTDOWN_TIMEOUT, 10_000)) {
    this.ready = false;
    const server = this.server;
    if (!server) return;

    await new Promise((resolve) => {
      let completed = false;
      const finish = () => {
        if (completed) return;
        completed = true;
        clearTimeout(forceCloseTimer);
        this.server = null;
        resolve();
      };
      const forceCloseTimer = setTimeout(() => {
        this.activityLog.push("warn", "shutdown", "HTTP connection dipaksa tutup setelah melewati batas waktu");
        server.closeAllConnections?.();
        finish();
      }, Math.max(250, timeoutMs));
      forceCloseTimer.unref?.();
      server.closeIdleConnections?.();
      server.close(finish);
    });
  }
}

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
