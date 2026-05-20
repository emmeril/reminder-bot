const fs = require("fs/promises");
const path = require("path");
const { Sequelize, DataTypes } = require("sequelize");
const { CONFIG, PAYMENT_STATUS, PAYMENT_TYPES, DEFAULT_SETTINGS } = require("../config");
const { sleep, generateId, sanitizeInput, sanitizeMultilineText, parseBoolean, normalizePhoneNumber, isValidPhoneNumber, getBillingPeriodKey, getBillingPeriodParts, makeBillingPeriodKey, getPreviousBillingPeriod, formatBillingPeriodLabel } = require("../utils");
class DataManager {
  constructor(activityLog) {
    this.activityLog = activityLog;
    this.contacts = new Map();
    this.pelanggan = new Map();
    this.reminders = new Map();
    this.sentReminders = new Map();
    this.roles = new Map();
    this.settings = { ...DEFAULT_SETTINGS };
    this.fileLocks = new Map();
    this.sequelize = null;
    this.models = {};
  }

  async initDirectories() {
    await fs.mkdir(CONFIG.DB_PATH, { recursive: true });
    await fs.mkdir(CONFIG.TEMPLATE_PATH, { recursive: true });
    await fs.mkdir(CONFIG.PUBLIC_PATH, { recursive: true });
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
    this.models.Reminder = jsonPayloadModel("Reminder", "reminders", "id");
    this.models.SentReminder = jsonPayloadModel("SentReminder", "sent_reminders", "id");
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
    await this.sequelize.sync();
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
      return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
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
      this.models.Reminder.count(),
      this.models.SentReminder.count(),
      this.models.Role.count(),
      this.models.Setting.count(),
    ]);
    return counts.some((count) => count > 0);
  }

  async loadFromDatabase() {
    this.contacts = await this.loadJsonPayloadMap(this.models.Contact, "id");
    this.pelanggan = await this.loadJsonPayloadMap(this.models.Pelanggan, "username");
    this.reminders = await this.loadJsonPayloadMap(this.models.Reminder, "id");
    this.sentReminders = await this.loadJsonPayloadMap(this.models.SentReminder, "id");

    const roleRows = await this.models.Role.findAll({ raw: true });
    this.roles = new Map(roleRows.map((row) => [String(row.phoneNumber), row.role]));

    const settingsRow = await this.models.Setting.findByPk("app", { raw: true });
    this.settings = { ...DEFAULT_SETTINGS, ...this.parseStoredJson(settingsRow?.value, {}) };
  }

  async loadFromLegacyJson() {
    this.contacts = await this.loadLegacyMapFromFile(this.getPath("contacts.json"), "id");
    this.pelanggan = await this.loadLegacyMapFromFile(this.getPath("pelanggan.json"), "username");
    this.reminders = await this.loadLegacyMapFromFile(this.getPath("reminders.json"), "id");
    this.sentReminders = await this.loadLegacyMapFromFile(this.getPath("sent_reminders.json"), "id");
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
    await this.normalizeReminderRelations();
    this.activityLog.push("info", "boot", "Data load complete", {
      contacts: this.contacts.size,
      pelanggan: this.pelanggan.size,
      reminders: this.reminders.size,
      sentReminders: this.sentReminders.size,
      adminRecipients: this.getAdminRecipients().length,
    });
  }

  async replaceJsonPayloadTable(model, keyField, values) {
    const rows = Array.from(values).map((item) => ({
      [keyField]: String(item[keyField]),
      data: item,
    }));

    await model.destroy({ where: {}, truncate: true });
    if (rows.length > 0) {
      await model.bulkCreate(rows);
    }
  }

  async saveContacts() {
    await this.replaceJsonPayloadTable(this.models.Contact, "id", this.contacts.values());
  }

  async savePelanggan() {
    await this.replaceJsonPayloadTable(this.models.Pelanggan, "username", this.pelanggan.values());
  }

  async saveReminders() {
    await this.replaceJsonPayloadTable(this.models.Reminder, "id", this.reminders.values());
  }

  async saveSentReminders() {
    await this.replaceJsonPayloadTable(this.models.SentReminder, "id", this.sentReminders.values());
  }

  async saveRoles() {
    const rows = Array.from(this.roles.entries()).map(([phoneNumber, role]) => ({ phoneNumber, role }));
    await this.models.Role.destroy({ where: {}, truncate: true });
    if (rows.length > 0) {
      await this.models.Role.bulkCreate(rows);
    }
  }

  async saveSettings() {
    await this.models.Setting.upsert({
      key: "app",
      value: this.settings,
    });
  }

  normalizeLoadedContacts() {
    for (const contact of this.contacts.values()) {
      contact.paymentStatus = String(contact.paymentStatus || PAYMENT_STATUS.UNPAID).toUpperCase();
      const normalizedType = String(contact.paymentType || "").toUpperCase();
      contact.paymentType = Object.values(PAYMENT_TYPES).includes(normalizedType) ? normalizedType : null;
      contact.linkedApHost = sanitizeInput(String(contact.linkedApHost || ""));
      if (!contact.paymentMonths || typeof contact.paymentMonths !== "object" || Array.isArray(contact.paymentMonths)) {
        contact.paymentMonths = {};
      }

      if (contact.paymentStatus === PAYMENT_STATUS.PAID && contact.paymentDate) {
        const paidDate = new Date(contact.paymentDate);
        if (!Number.isNaN(paidDate.getTime())) {
          const key = getBillingPeriodKey(paidDate);
          if (!contact.paymentMonths[key]) {
            contact.paymentMonths[key] = {
              status: PAYMENT_STATUS.PAID,
              paidDate: paidDate.toISOString(),
              paymentType: contact.paymentType,
            };
          }
        }
      }
    }
  }

  async saveAll() {
    await Promise.all([
      this.saveContacts(),
      this.savePelanggan(),
      this.saveReminders(),
      this.saveSentReminders(),
      this.saveRoles(),
      this.saveSettings(),
    ]);
  }

  async createBackup() {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupDir = path.join(CONFIG.DB_PATH, "backups", timestamp);
    await fs.mkdir(backupDir, { recursive: true });

    if (!process.env.DATABASE_URL) {
      const sqliteFiles = [
        CONFIG.DB_STORAGE,
        `${CONFIG.DB_STORAGE}-wal`,
        `${CONFIG.DB_STORAGE}-shm`,
      ];

      await Promise.all(
        sqliteFiles.map(async (src) => {
          const dest = path.join(backupDir, path.basename(src));
          await fs.copyFile(src, dest).catch(() => {});
        })
      );
    }

    this.activityLog.push("info", "storage", "Backup created", { backupDir });
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
      .sort((a, b) => new Date(a.reminderDateTime) - new Date(b.reminderDateTime));
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
      nextReminderAt: reminders[0]?.reminderDateTime || null,
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
    return {
      ...reminder,
      contactId: reminder.contactId || contact?.id || null,
      contactName: contact?.name || reminder.contactName || null,
      phoneNumber: contact?.phoneNumber || reminder.phoneNumber || null,
    };
  }

  buildDueDateInfo(contact) {
    const { year, month } = getBillingPeriodParts();
    const activePeriodKey = makeBillingPeriodKey(year, month);
    const reminders = Array.from(this.reminders.values()).filter((reminder) => {
      if (String(reminder.contactId || "") === String(contact.id)) return true;
      return reminder.phoneNumber && reminder.phoneNumber === contact.phoneNumber;
    });

    const parsedReminders = reminders
      .map((reminder) => ({
        ...reminder,
        reminderDate: new Date(reminder.reminderDateTime),
      }))
      .filter((reminder) => !Number.isNaN(reminder.reminderDate.getTime()))
      .map((reminder) => ({
        ...reminder,
        timestamp: reminder.reminderDate.getTime(),
        periodKey: makeBillingPeriodKey(
          reminder.reminderDate.getFullYear(),
          reminder.reminderDate.getMonth() + 1
        ),
      }))
      .sort((a, b) => a.timestamp - b.timestamp);

    const nowTs = Date.now();
    const activePeriodReminders = parsedReminders.filter((reminder) => reminder.periodKey === activePeriodKey);
    const nextInActivePeriod = activePeriodReminders.find((reminder) => reminder.timestamp >= nowTs) || null;
    const latestInActivePeriod = activePeriodReminders.length > 0
      ? activePeriodReminders[activePeriodReminders.length - 1]
      : null;
    const dueReminder = nextInActivePeriod || latestInActivePeriod || null;
    const dueDate = dueReminder ? new Date(dueReminder.timestamp).toISOString() : null;

    let dueStatus = "NOT_SCHEDULED";
    if (dueDate) {
      if (String(contact.paymentStatus || PAYMENT_STATUS.UNPAID).toUpperCase() === PAYMENT_STATUS.PAID) {
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

  buildDebtInfo(contact, options = {}) {
    const { year, month } = options.year && options.month
      ? { year: options.year, month: options.month }
      : getBillingPeriodParts();
    const previous = getPreviousBillingPeriod(year, month);
    const previousKey = makeBillingPeriodKey(previous.year, previous.month);
    const currentKey = makeBillingPeriodKey(year, month);
    const systemStartYear = 2026;
    const systemStartMonth = 4;
    const previousBeforeSystem = previous.year < systemStartYear
      || (previous.year === systemStartYear && previous.month < systemStartMonth);
    const paymentMonths = contact.paymentMonths || {};
    const previousPayment = paymentMonths[previousKey] || null;
    const currentPayment = paymentMonths[currentKey] || null;
    const currentType = String(currentPayment?.paymentType || contact.paymentType || "").toUpperCase();
    const createdAt = contact.createdAt ? new Date(contact.createdAt) : null;
    const previousPeriodEnd = new Date(previous.year, previous.month, 0, 23, 59, 59, 999);
    const createdAfterPreviousPeriod = createdAt && !Number.isNaN(createdAt.getTime()) && createdAt > previousPeriodEnd;
    const previousPaid = previousPayment?.status === PAYMENT_STATUS.PAID
      || currentType === PAYMENT_TYPES.FULL_PAID
      || currentType === PAYMENT_TYPES.ARREARS_ONLY;
    const hasDebt = !previousBeforeSystem && !createdAfterPreviousPeriod && !previousPaid;
    const periodLabel = formatBillingPeriodLabel(previous.year, previous.month);

    return {
      hasDebt,
      debtPeriod: previousKey,
      debtPeriodLabel: periodLabel,
      debtNote: hasDebt ? `Masih ada hutang ${periodLabel}.` : "",
      previousPaymentStatus: previousPayment?.status || PAYMENT_STATUS.UNPAID,
      currentPaymentStatus: currentPayment?.status || String(contact.paymentStatus || PAYMENT_STATUS.UNPAID).toUpperCase(),
    };
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

  async addContact(payload) {
    const name = sanitizeInput(payload.name);
    const phoneNumber = normalizePhoneNumber(payload.phoneNumber);
    const linkedApHost = sanitizeInput(String(payload.linkedApHost || ""));

    if (!name) throw new Error("Nama kontak wajib diisi.");
    if (!isValidPhoneNumber(phoneNumber)) throw new Error("Nomor kontak harus berformat 628xxx.");
    if (this.hasContactPhone(phoneNumber)) throw new Error("Nomor kontak sudah digunakan.");

    const contact = {
      id: String(payload.id || generateId()),
      name,
      phoneNumber,
      paymentStatus: payload.paymentStatus || PAYMENT_STATUS.UNPAID,
      paymentDate: payload.paymentStatus === PAYMENT_STATUS.PAID ? new Date().toISOString() : null,
      paymentMonths: payload.paymentMonths || {},
      linkedApHost,
      createdAt: payload.createdAt || new Date().toISOString(),
      updatedAt: payload.updatedAt || new Date().toISOString(),
    };

    this.contacts.set(contact.id, contact);
    await this.saveContacts();
    return contact;
  }

  async upsertPelangganFromRegistration(payload) {
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

    const now = new Date().toISOString();
    let contact = this.findContactByPhone(phoneNumber);

    if (!contact) {
      contact = {
        id: String(generateId()),
        name,
        phoneNumber,
        paymentStatus: PAYMENT_STATUS.UNPAID,
        paymentDate: null,
        paymentMonths: {},
        mikrotikUsername: username,
        mikrotikProfile: profile,
        createdAt: now,
        updatedAt: now,
      };
      this.contacts.set(contact.id, contact);
    } else {
      contact.name = name;
      contact.mikrotikUsername = username;
      contact.mikrotikProfile = profile;
      contact.updatedAt = now;
    }

    const previous = this.pelanggan.get(username) || {};
    const pelanggan = {
      ...previous,
      username,
      nama: name,
      nomer: phoneNumber,
      profile,
      password,
      contactId: contact.id,
      status: "verified",
      tanggalDaftar: previous.tanggalDaftar || now,
      tanggalUpdate: now,
    };

    this.pelanggan.set(username, pelanggan);
    await Promise.all([this.saveContacts(), this.savePelanggan()]);
    return { contact, pelanggan };
  }

  async updateContact(id, payload) {
    const contact = this.getContact(id);
    if (!contact) throw new Error("Kontak tidak ditemukan.");
    const previousPhone = contact.phoneNumber;

    const nextName = payload.name !== undefined ? sanitizeInput(payload.name) : contact.name;
    const nextPhone = payload.phoneNumber !== undefined ? normalizePhoneNumber(payload.phoneNumber) : contact.phoneNumber;
    const nextLinkedApHost = payload.linkedApHost !== undefined
      ? sanitizeInput(String(payload.linkedApHost || ""))
      : sanitizeInput(String(contact.linkedApHost || ""));

    if (!nextName) throw new Error("Nama kontak wajib diisi.");
    if (!isValidPhoneNumber(nextPhone)) throw new Error("Nomor kontak harus berformat 628xxx.");
    if (this.hasContactPhone(nextPhone, id)) throw new Error("Nomor kontak sudah digunakan.");

    contact.name = nextName;
    contact.phoneNumber = nextPhone;
    contact.linkedApHost = nextLinkedApHost;

    for (const reminder of this.reminders.values()) {
      if (String(reminder.contactId) === String(id) || reminder.phoneNumber === previousPhone) {
        reminder.contactId = String(contact.id);
        reminder.phoneNumber = contact.phoneNumber;
        reminder.contactName = contact.name;
      }
    }

    await Promise.all([this.saveContacts(), this.saveReminders()]);
    return contact;
  }

  async deleteContact(id) {
    const contact = this.getContact(id);
    if (!contact) throw new Error("Kontak tidak ditemukan.");

    this.contacts.delete(String(id));

    const relatedReminderIds = Array.from(this.reminders.values())
      .filter((reminder) => String(reminder.contactId) === String(contact.id) || reminder.phoneNumber === contact.phoneNumber)
      .map((reminder) => String(reminder.id));

    for (const reminderId of relatedReminderIds) {
      this.reminders.delete(reminderId);
    }

    await Promise.all([this.saveContacts(), this.saveReminders()]);
    return { deletedContact: contact, deletedReminders: relatedReminderIds.length };
  }

  async addReminder(payload) {
    const contact = this.getContact(payload.contactId);
    const message = sanitizeMultilineText(payload.message);
    const reminderDate = payload.reminderDateTime instanceof Date
      ? payload.reminderDateTime
      : new Date(payload.reminderDateTime);

    if (!contact) throw new Error("Contact reminder tidak ditemukan.");
    if (!message) throw new Error("Isi reminder wajib diisi.");
    if (Number.isNaN(reminderDate.getTime())) throw new Error("Tanggal reminder tidak valid.");

    const reminder = {
      id: String(payload.id || generateId()),
      contactId: String(contact.id),
      contactName: contact.name,
      phoneNumber: contact.phoneNumber,
      reminderDateTime: reminderDate.toISOString(),
      message,
      templateName: payload.templateName ? sanitizeInput(payload.templateName) : null,
      createdAt: payload.createdAt || new Date().toISOString(),
    };

    this.reminders.set(reminder.id, reminder);
    await this.saveReminders();
    return this.hydrateReminder(reminder);
  }

  async updateReminder(id, payload) {
    const reminder = this.getReminder(id);
    if (!reminder) throw new Error("Reminder tidak ditemukan.");

    if (payload.contactId !== undefined) {
      const contact = this.getContact(payload.contactId);
      if (!contact) throw new Error("Contact reminder tidak ditemukan.");
      reminder.contactId = String(contact.id);
      reminder.contactName = contact.name;
      reminder.phoneNumber = contact.phoneNumber;
    }

    if (payload.message !== undefined) {
      const message = sanitizeMultilineText(payload.message);
      if (!message) throw new Error("Isi reminder wajib diisi.");
      reminder.message = message;
    }

    if (payload.reminderDateTime !== undefined) {
      const reminderDate = payload.reminderDateTime instanceof Date
        ? payload.reminderDateTime
        : new Date(payload.reminderDateTime);
      if (Number.isNaN(reminderDate.getTime())) throw new Error("Tanggal reminder tidak valid.");
      reminder.reminderDateTime = reminderDate.toISOString();
    }

    if (payload.templateName !== undefined) {
      reminder.templateName = payload.templateName ? sanitizeInput(payload.templateName) : null;
    }

    await this.saveReminders();
    return this.hydrateReminder(reminder);
  }

  async deleteReminder(id) {
    const reminder = this.getReminder(id);
    if (!reminder) throw new Error("Reminder tidak ditemukan.");
    this.reminders.delete(String(id));
    await this.saveReminders();
    return reminder;
  }

  async moveToSent(id, extras = {}) {
    const reminder = this.getReminder(id);
    if (!reminder) return null;

    const sentReminder = {
      ...this.hydrateReminder(reminder),
      sentAt: extras.sentAt || new Date().toISOString(),
      deliveryStatus: extras.deliveryStatus || "SENT",
    };

    this.sentReminders.set(String(id), sentReminder);
    this.reminders.delete(String(id));
    await Promise.all([this.saveReminders(), this.saveSentReminders()]);
    return sentReminder;
  }

  getAdminRecipients() {
    return Array.from(this.roles.entries())
      .filter(([, role]) => role === "admin")
      .map(([phoneNumber]) => phoneNumber)
      .sort();
  }

  async setAdminRecipients(numbers) {
    this.roles = new Map();
    for (const number of numbers) {
      this.roles.set(number, "admin");
    }
    await this.saveRoles();
    return this.getAdminRecipients();
  }

  getSettings() {
    return { ...DEFAULT_SETTINGS, ...this.settings };
  }

  async updateSettings(payload) {
    const current = this.getSettings();
    this.settings = {
      ...current,
      dashboardTitle: payload.dashboardTitle !== undefined ? sanitizeInput(payload.dashboardTitle) || current.dashboardTitle : current.dashboardTitle,
      companyName: payload.companyName !== undefined ? sanitizeInput(payload.companyName) || current.companyName : current.companyName,
      supportSignature: payload.supportSignature !== undefined ? sanitizeInput(payload.supportSignature) || current.supportSignature : current.supportSignature,
      apDownMessageTemplate: payload.apDownMessageTemplate !== undefined
        ? sanitizeMultilineText(payload.apDownMessageTemplate) || current.apDownMessageTemplate
        : current.apDownMessageTemplate,
      paymentMessageTemplateArrearsOnly: payload.paymentMessageTemplateArrearsOnly !== undefined
        ? sanitizeMultilineText(payload.paymentMessageTemplateArrearsOnly) || current.paymentMessageTemplateArrearsOnly
        : current.paymentMessageTemplateArrearsOnly,
      paymentMessageTemplateCurrentOnly: payload.paymentMessageTemplateCurrentOnly !== undefined
        ? sanitizeMultilineText(payload.paymentMessageTemplateCurrentOnly) || current.paymentMessageTemplateCurrentOnly
        : current.paymentMessageTemplateCurrentOnly,
      paymentMessageTemplateFullPaid: payload.paymentMessageTemplateFullPaid !== undefined
        ? sanitizeMultilineText(payload.paymentMessageTemplateFullPaid) || current.paymentMessageTemplateFullPaid
        : current.paymentMessageTemplateFullPaid,
      timezone: payload.timezone !== undefined ? sanitizeInput(payload.timezone) || current.timezone : current.timezone,
      autoRescheduleMonthly: payload.autoRescheduleMonthly !== undefined ? parseBoolean(payload.autoRescheduleMonthly, current.autoRescheduleMonthly) : current.autoRescheduleMonthly,
      notifyAdminsOnDelivery: payload.notifyAdminsOnDelivery !== undefined ? parseBoolean(payload.notifyAdminsOnDelivery, current.notifyAdminsOnDelivery) : current.notifyAdminsOnDelivery,
      notifyAdminsOnConnectionChange: payload.notifyAdminsOnConnectionChange !== undefined ? parseBoolean(payload.notifyAdminsOnConnectionChange, current.notifyAdminsOnConnectionChange) : current.notifyAdminsOnConnectionChange,
      notifyAdminsOnPaymentReset: payload.notifyAdminsOnPaymentReset !== undefined ? parseBoolean(payload.notifyAdminsOnPaymentReset, current.notifyAdminsOnPaymentReset) : current.notifyAdminsOnPaymentReset,
    };
    await this.saveSettings();
    return this.getSettings();
  }

  getContactsByStatus(status) {
    return this.getSortedContacts().filter((contact) => contact.paymentStatus === status);
  }

  getPaymentsByMonth(year, month) {
    const key = `${year}-${String(month).padStart(2, "0")}`;
    return this.getSortedContacts().filter((contact) => {
      return contact.paymentMonths?.[key]?.status === PAYMENT_STATUS.PAID;
    });
  }

  getAllPaymentsHistory() {
    const history = {};
    for (const contact of this.contacts.values()) {
      for (const [key, payment] of Object.entries(contact.paymentMonths || {})) {
        if (!payment || payment.status !== PAYMENT_STATUS.PAID) continue;
        if (!history[key]) {
          history[key] = { contacts: [], total: 0 };
        }
        history[key].contacts.push(contact);
        history[key].total += 1;
      }
    }
    return history;
  }

  getPaymentMonthStatus(contactId) {
    const contact = this.getContact(contactId);
    return contact?.paymentMonths || {};
  }

  async updatePaymentStatus(contactId, status, paymentType = null) {
    const contact = this.getContact(contactId);
    if (!contact) throw new Error("Kontak tidak ditemukan.");
    if (![PAYMENT_STATUS.PAID, PAYMENT_STATUS.UNPAID].includes(status)) {
      throw new Error("Status pembayaran tidak valid.");
    }

    const now = new Date();
    const { year, month } = getBillingPeriodParts(now);
    const currentKey = makeBillingPeriodKey(year, month);
    const previous = getPreviousBillingPeriod(year, month);
    const previousKey = makeBillingPeriodKey(previous.year, previous.month);
    if (!contact.paymentMonths || typeof contact.paymentMonths !== "object") {
      contact.paymentMonths = {};
    }

    contact.paymentStatus = status;
    contact.paymentDate = status === PAYMENT_STATUS.PAID ? now.toISOString() : null;
    contact.paymentType = paymentType || null;

    if (paymentType === PAYMENT_TYPES.ARREARS_ONLY || paymentType === PAYMENT_TYPES.FULL_PAID) {
      contact.paymentMonths[previousKey] = {
        status: PAYMENT_STATUS.PAID,
        paidDate: now.toISOString(),
        paymentType,
      };
    }

    contact.paymentMonths[currentKey] = {
      status,
      paidDate: status === PAYMENT_STATUS.PAID ? now.toISOString() : null,
      paymentType: paymentType || null,
    };
    contact.updatedAt = now.toISOString();

    await this.saveContacts();
    return this.hydrateContact(contact);
  }

  async setPaymentForMonth(contactId, year, month, status, paymentType = null) {
    const contact = this.getContact(contactId);
    if (!contact) throw new Error("Kontak tidak ditemukan.");
    if (![PAYMENT_STATUS.PAID, PAYMENT_STATUS.UNPAID].includes(status)) {
      throw new Error("Status pembayaran tidak valid.");
    }

    if (!contact.paymentMonths) {
      contact.paymentMonths = {};
    }

    const key = `${year}-${String(month).padStart(2, "0")}`;
    const now = new Date();
    const previous = getPreviousBillingPeriod(year, month);
    const previousKey = makeBillingPeriodKey(previous.year, previous.month);

    if (paymentType === PAYMENT_TYPES.ARREARS_ONLY || paymentType === PAYMENT_TYPES.FULL_PAID) {
      contact.paymentMonths[previousKey] = {
        status: PAYMENT_STATUS.PAID,
        paidDate: now.toISOString(),
        paymentType,
      };
    }

    contact.paymentMonths[key] = {
      status,
      paidDate: status === PAYMENT_STATUS.PAID ? now.toISOString() : null,
      paymentType: paymentType || null,
    };

    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth() + 1;
    if (year === currentYear && month === currentMonth) {
      contact.paymentStatus = status;
      contact.paymentDate = status === PAYMENT_STATUS.PAID ? now.toISOString() : null;
      contact.paymentType = paymentType || null;
    }
    contact.updatedAt = now.toISOString();

    await this.saveContacts();
    return this.hydrateContact(contact);
  }

  inferPaymentType(contact, options = {}) {
    const paymentMonths = contact.paymentMonths || {};
    const year = options.year ?? new Date().getFullYear();
    const month = options.month ?? new Date().getMonth() + 1;
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
    const prevMonth = month === 1 ? 12 : month - 1;
    const prevYear = month === 1 ? year - 1 : year;
    const prevKey = `${prevYear}-${String(prevMonth).padStart(2, "0")}`;
    const currentKey = `${year}-${String(month).padStart(2, "0")}`;
    const systemStartYear = 2026;
    const systemStartMonth = 4;

    return this.getSortedContacts().filter((contact) => {
      const paymentMonths = contact.paymentMonths || {};
      const prevStatus = paymentMonths[prevKey]?.status;
      const currStatus = paymentMonths[currentKey]?.status;
      const prevBeforeSystem = prevYear < systemStartYear
        || (prevYear === systemStartYear && prevMonth < systemStartMonth);

      if (prevBeforeSystem) {
        return currStatus !== PAYMENT_STATUS.PAID;
      }

      return prevStatus !== PAYMENT_STATUS.PAID || currStatus !== PAYMENT_STATUS.PAID;
    });
  }

  async resetAllPaymentStatus() {
    let resetCount = 0;
    const currentKey = getBillingPeriodKey();

    for (const contact of this.contacts.values()) {
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
      };
      resetCount += 1;
    }

    if (resetCount > 0) {
      await this.saveContacts();
    }

    return resetCount;
  }

  async ensureMonthlyPaymentReset() {
    const currentPeriod = getBillingPeriodKey();
    const settings = this.getSettings();

    if (!settings.lastPaymentResetPeriod) {
      this.settings.lastPaymentResetPeriod = currentPeriod;
      await this.saveSettings();
      return { reset: false, initialized: true, period: currentPeriod, count: 0 };
    }

    if (settings.lastPaymentResetPeriod === currentPeriod) {
      return { reset: false, period: currentPeriod, count: 0 };
    }

    const count = await this.resetAllPaymentStatus();
    this.settings.lastPaymentResetPeriod = currentPeriod;
    await this.saveSettings();
    return { reset: true, period: currentPeriod, count };
  }
}

module.exports = DataManager;
