const fs = require("fs/promises");
const net = require("net");
const path = require("path");
const { Sequelize, DataTypes } = require("sequelize");
const {
  BILLING_CYCLES,
  CONFIG,
  DEFAULT_SETTINGS,
  PAYMENT_STATUS,
  PAYMENT_TYPES,
  SUBSCRIPTION_TYPES,
} = require("../../config");
const AsyncLock = require("../../async-lock");
const {
  generatePortalPassword,
  hashPortalPassword,
  isPortalPasswordHash,
  verifyPortalPassword,
} = require("../../portal-password");
const { PAYMENT_GATEWAY_STATUS } = require("../../midtrans-service");
const { migrateWhatsAppProviderMetadata } = require("../../migrations/whatsapp-provider-metadata");
const { buildVoucherRevenueReport } = require("../vouchers/domain");
const {
  HOTSPOT_PROVISIONING_OPERATION,
  HOTSPOT_PROVISIONING_STATUS,
  compareBillingPeriods,
  getContactBillingPeriod,
  getContactBillingStartPeriod,
  getContactHotspotAccessMode,
  getHotspotUnavailableMessage,
  isHotspotAccountUnavailable,
  isPrepaidPackage,
  isRecurringSubscription,
  normalizeBillingCycle,
  normalizeHotspotProvisioningOperation,
  normalizeHotspotProvisioningStatus,
  normalizeSubscriptionType,
} = require("../customers/domain");
const {
  IP_BINDING_BANDWIDTH_STATUS,
  normalizeIpBindingBandwidthStatus,
  normalizeMacAddress,
  normalizeMacAddresses,
  normalizeQueueTarget,
} = require("../mikrotik/domain");
const {
  addMonthsSafely,
  formatBillingPeriodLabel,
  getBillingPeriodKey,
  getBillingPeriodParts,
  isValidTimeZone,
  makeBillingPeriodKey,
  normalizePhoneNumber,
  parseBoolean,
  safeCompareString,
  sanitizeInput,
  sanitizePositiveInteger,
  sleep,
} = require("../../utils");

class DataManagerCore {
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

    const migratedBillingCycles = this.normalizeLoadedContacts();
    if (migratedBillingCycles > 0) await this.saveContacts();
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

  getVoucherRevenueReport(options = {}) {
    return buildVoucherRevenueReport(this.voucherRevenueEntries.values(), {
      ...(typeof options === "string" ? { period: options } : options),
      timeZone: this.getTimezone(),
    });
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
    let migratedBillingCycles = 0;
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
      if (String(contact.billingCycle || "PREPAID").trim().toUpperCase() !== BILLING_CYCLES.PREPAID) {
        migratedBillingCycles += 1;
      }
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
      contact.ipBindingBandwidthQueueNames = [...new Set((Array.isArray(contact.ipBindingBandwidthQueueNames)
        ? contact.ipBindingBandwidthQueueNames
        : [contact.ipBindingBandwidthQueueName])
        .map((name) => sanitizeInput(String(name || "")))
        .filter(Boolean))];
      contact.ipBindingBandwidthQueueName = contact.ipBindingBandwidthQueueNames[0] || "";
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
    return migratedBillingCycles;
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
    let updated = 0;
    const now = new Date().toISOString();

    for (const contact of this.contacts.values()) {
      const hotspotRecord = Array.from(this.pelanggan.values()).find(
        (item) => String(item.contactId || "") === String(contact.id)
      );
      const hotspotUsername = sanitizeInput(String(contact.mikrotikUsername || hotspotRecord?.username || ""));
      const existing = this.customerAccounts.get(String(contact.id)) || null;
      if (!existing && !hotspotUsername) continue;

      const preferredPortalUsername = sanitizeInput(String(existing?.username || hotspotUsername));
      const portalUsername = this.getUniqueCustomerPortalUsername(preferredPortalUsername, contact.id);
      const originalPassword = String(existing?.password || "") || generatePortalPassword();
      const passwordHash = isPortalPasswordHash(originalPassword)
        ? originalPassword
        : await hashPortalPassword(originalPassword);
      if (!portalUsername) continue;

      const customerAccount = {
        ...(existing || {}),
        contactId: String(contact.id),
        username: portalUsername,
        password: passwordHash,
        createdAt: existing?.createdAt || contact.createdAt || now,
        updatedAt: existing?.updatedAt || contact.updatedAt || now,
      };
      const changed = !existing || JSON.stringify(existing) !== JSON.stringify(customerAccount);
      if (changed) customerAccount.updatedAt = now;
      this.customerAccounts.set(String(contact.id), customerAccount);
      if (changed) updated += 1;
    }

    if (updated > 0 && this.sequelize && options.save !== false) {
      await this.saveCustomerAccounts();
      this.activityLog.push("info", "storage", `${updated} akun portal pelanggan dibuat atau dimigrasikan ke hash scrypt`);
    }

    return updated;
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
    const historyByPeriod = new Map(
      Object.entries(hydrated.paymentMonths || {})
        .filter(([period]) => !prepaidPackage
          && /^\d{4}-\d{2}$/.test(period)
          && period <= currentKey)
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
      if (!(await verifyPortalPassword(currentPassword, account.account.password))) {
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
      if (await verifyPortalPassword(newPassword, account.account.password)) {
        throw new Error("Password baru harus berbeda dari password saat ini.");
      }

      account.account.password = await hashPortalPassword(newPassword);
      account.account.updatedAt = new Date().toISOString();
      await this.saveCustomerAccounts();
      return this.getCustomerPortalData(contactId);
    });
  }

  async resetCustomerPortalPassword(contactId, newPassword) {
    return this.withDataMutation(async () => {
      const account = this.getCustomerPortalAccountByContactId(contactId);
      if (!account) throw new Error("Akun pelanggan tidak ditemukan.");
      if (!/^[\x21-\x7E]{16,64}$/.test(String(newPassword || ""))) {
        throw new Error("Password portal sementara harus memiliki 16 sampai 64 karakter ASCII.");
      }
      const previousHash = account.account.password;
      const currentHash = await hashPortalPassword(newPassword);
      account.account.password = currentHash;
      account.account.updatedAt = new Date().toISOString();
      await this.saveCustomerAccounts();
      return { previousHash, currentHash };
    });
  }

  async restoreCustomerPortalPassword(contactId, previousHash, expectedHash) {
    return this.withDataMutation(async () => {
      const account = this.getCustomerPortalAccountByContactId(contactId);
      if (!account || account.account.password !== expectedHash) return false;
      account.account.password = previousHash;
      account.account.updatedAt = new Date().toISOString();
      await this.saveCustomerAccounts();
      return true;
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

}

module.exports = DataManagerCore;
