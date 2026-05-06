require("dotenv").config();

const fs = require("fs/promises");
const fsSync = require("fs");
const path = require("path");
const express = require("express");
const cron = require("node-cron");
const crypto = require("crypto");
const qrcode = require("qrcode-terminal");
const QRCode = require("qrcode");
const { Client, LocalAuth } = require("whatsapp-web.js");
const { RouterOSClient } = require("routeros-client");
const { Sequelize, DataTypes } = require("sequelize");

const CONFIG = {
  PORT: Number(process.env.PORT || 3025),
  DB_PATH: path.join(__dirname, "database"),
  DB_STORAGE: process.env.DB_STORAGE
    ? (path.isAbsolute(process.env.DB_STORAGE) ? process.env.DB_STORAGE : path.join(__dirname, process.env.DB_STORAGE))
    : path.join(__dirname, "database", "reminder_bot.sqlite"),
  TEMPLATE_PATH: path.join(__dirname, "templates"),
  PUBLIC_PATH: path.join(__dirname, "public"),
  AUTO_SAVE_INTERVAL: 24 * 60 * 60 * 1000,
  BACKUP_INTERVAL: 24 * 60 * 60 * 1000,
  KEEP_ALIVE_INTERVAL: 5 * 60 * 1000,
  MAX_RECONNECT_ATTEMPTS: 10,
  MIN_RECONNECT_INTERVAL: 30_000,
  RECONNECT_DELAY: 5_000,
  CRON_SCHEDULE: "*/1 * * * *",
  RESET_PAYMENT_SCHEDULE: "0 0 1 * *",
  MAX_LOCK_WAIT: 10_000,
  LOCK_POLL_INTERVAL: 50,
  WEB_API_KEY: process.env.WEB_API_KEY || "dev-key-change-in-production",
  AUTH_USERNAME: process.env.AUTH_USERNAME || "admin",
  AUTH_PASSWORD: process.env.AUTH_PASSWORD || "admin123",
  SESSION_COOKIE_NAME: "reminder_bot_session",
  SESSION_TTL: 24 * 60 * 60 * 1000,
  SESSION_SECRET: process.env.SESSION_SECRET || "change-this-session-secret",
  LOG_LIMIT: 250,
  MIKROTIK_PRIMARY: {
    host: process.env.IP_MIKROTIK,
    user: process.env.USER_MIKROTIK,
    password: process.env.PASSWORD_MIKROTIK,
    port: Number(process.env.PORT_MIKROTIK || 8728),
    timeout: 30_000,
    keepalive: true,
  },
  MIKROTIK_BACKUP: {
    host: process.env.IP_MIKROTIK_BACKUP,
    user: process.env.USER_MIKROTIK,
    password: process.env.PASSWORD_MIKROTIK,
    port: Number(process.env.PORT_MIKROTIK_BACKUP || process.env.PORT_MIKROTIK || 8728),
    timeout: 30_000,
    keepalive: true,
  },
};

const MONTH_NAMES = [
  "",
  "Januari",
  "Februari",
  "Maret",
  "April",
  "Mei",
  "Juni",
  "Juli",
  "Agustus",
  "September",
  "Oktober",
  "November",
  "Desember",
];

const PAYMENT_STATUS = {
  PAID: "PAID",
  UNPAID: "UNPAID",
};

const PAYMENT_TYPES = {
  ARREARS_ONLY: "ARREARS-ONLY",
  CURRENT_ONLY: "CURRENT-ONLY",
  FULL_PAID: "FULL-PAID",
};

const DEFAULT_SETTINGS = {
  dashboardTitle: "Reminder Bot Control Center",
  companyName: "Emmeril Hotspot",
  supportSignature: "CS Emmeril Hotspot",
  timezone: "Asia/Jakarta",
  lastPaymentResetPeriod: "",
  autoRescheduleMonthly: true,
  notifyAdminsOnDelivery: true,
  notifyAdminsOnConnectionChange: true,
  notifyAdminsOnPaymentReset: true,
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const generateId = () => `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;

function escapeHtml(value) {
  if (typeof value !== "string") return value;
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function sanitizeInput(value) {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001F\u007F-\u009F]/g, "").trim();
}

function sanitizeMultilineText(value) {
  if (typeof value !== "string") return "";
  return value
    .replace(/\r\n/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "")
    .trim();
}

function parseBoolean(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value !== "string") return fallback;

  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "off", ""].includes(normalized)) return false;
  return fallback;
}

function collectSecurityWarnings() {
  const warnings = [];

  if (CONFIG.WEB_API_KEY === "dev-key-change-in-production") {
    warnings.push("WEB_API_KEY masih memakai nilai default.");
  }

  if (CONFIG.AUTH_USERNAME === "admin" && CONFIG.AUTH_PASSWORD === "admin123") {
    warnings.push("Kredensial login dashboard masih memakai nilai default.");
  }

  if (CONFIG.SESSION_SECRET === "change-this-session-secret") {
    warnings.push("SESSION_SECRET masih memakai nilai default.");
  }

  return warnings;
}

function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader) return cookies;

  for (const part of String(cookieHeader).split(";")) {
    const [rawKey, ...rawValue] = part.trim().split("=");
    if (!rawKey) continue;
    try {
      cookies[rawKey] = decodeURIComponent(rawValue.join("=") || "");
    } catch {
      cookies[rawKey] = rawValue.join("=") || "";
    }
  }

  return cookies;
}

function serializeCookie(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (options.maxAge !== undefined) parts.push(`Max-Age=${options.maxAge}`);
  if (options.path) parts.push(`Path=${options.path}`);
  if (options.httpOnly) parts.push("HttpOnly");
  if (options.sameSite) parts.push(`SameSite=${options.sameSite}`);
  if (options.secure) parts.push("Secure");
  return parts.join("; ");
}

function safeCompareString(left, right) {
  const leftBuffer = Buffer.from(String(left || ""));
  const rightBuffer = Buffer.from(String(right || ""));
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function normalizePhoneNumber(value) {
  return sanitizeInput(String(value || "")).replace(/[^0-9]/g, "");
}

function isValidPhoneNumber(value) {
  return /^628\d{7,13}$/.test(value);
}

function formatUsernameFromName(name) {
  return sanitizeInput(name)
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_]/g, "");
}

function buildHotspotEmailFromPhone(phoneNumber) {
  const normalized = normalizePhoneNumber(phoneNumber);
  return normalized ? `${normalized}@localhost.local` : "";
}

function parseDateTimeInput(input) {
  const match = sanitizeInput(input).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/);
  if (!match) return null;

  const [, year, month, day, hour, minute] = match;
  const yearNum = Number(year);
  const monthNum = Number(month);
  const dayNum = Number(day);
  const hourNum = Number(hour);
  const minuteNum = Number(minute);

  if (monthNum < 1 || monthNum > 12) return null;
  if (dayNum < 1 || dayNum > 31) return null;
  if (hourNum < 0 || hourNum > 23) return null;
  if (minuteNum < 0 || minuteNum > 59) return null;

  const maxDays = new Date(yearNum, monthNum, 0).getDate();
  if (dayNum > maxDays) return null;

  const date = new Date(yearNum, monthNum - 1, dayNum, hourNum, minuteNum);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

function formatDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatDateTime(date) {
  return new Date(date).toLocaleString("id-ID", {
    dateStyle: "long",
    timeStyle: "short",
    timeZone: "Asia/Jakarta",
  });
}

function getBillingPeriodKey(date = new Date()) {
  const source = new Date(date);
  return `${source.getFullYear()}-${String(source.getMonth() + 1).padStart(2, "0")}`;
}

function addMonthsSafely(dateValue, monthsToAdd) {
  const source = new Date(dateValue);
  const targetMonthIndex = source.getMonth() + monthsToAdd;
  const year = source.getFullYear() + Math.floor(targetMonthIndex / 12);
  const month = ((targetMonthIndex % 12) + 12) % 12;
  const lastDayOfTargetMonth = new Date(year, month + 1, 0).getDate();
  const day = Math.min(source.getDate(), lastDayOfTargetMonth);

  return new Date(
    year,
    month,
    day,
    source.getHours(),
    source.getMinutes(),
    source.getSeconds(),
    source.getMilliseconds()
  );
}

function resolveChromeExecutablePath() {
  const envCandidates = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    process.env.CHROME_PATH,
    process.env.CHROMIUM_PATH,
  ].filter(Boolean);

  for (const candidate of envCandidates) {
    if (fsSync.existsSync(candidate)) {
      return candidate;
    }
  }

  if (process.platform !== "linux") {
    return null;
  }

  const linuxCandidates = [
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/snap/bin/chromium",
  ];

  for (const candidate of linuxCandidates) {
    if (fsSync.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

class ActivityLog {
  constructor(limit = CONFIG.LOG_LIMIT) {
    this.limit = limit;
    this.entries = [];
  }

  push(level, source, message, meta = null) {
    const entry = {
      id: generateId(),
      level,
      source,
      message,
      meta,
      timestamp: new Date().toISOString(),
    };

    this.entries.unshift(entry);
    if (this.entries.length > this.limit) {
      this.entries.length = this.limit;
    }

    const line = `[${entry.timestamp}] [${level}] [${source}] ${message}`;
    if (level === "error") {
      console.error(line);
    } else if (level === "warn") {
      console.warn(line);
    } else {
      console.log(line);
    }
    return entry;
  }

  list() {
    return this.entries;
  }
}

class AuthManager {
  constructor(activityLog) {
    this.activityLog = activityLog;
    this.sessions = new Map();
  }

  cleanupExpiredSessions() {
    const now = Date.now();
    for (const [token, session] of this.sessions.entries()) {
      if (session.expiresAt <= now) {
        this.sessions.delete(token);
      }
    }
  }

  validateCredentials(username, password) {
    return safeCompareString(username, CONFIG.AUTH_USERNAME)
      && safeCompareString(password, CONFIG.AUTH_PASSWORD);
  }

  createSession(username) {
    this.cleanupExpiredSessions();
    const token = crypto
      .createHmac("sha256", CONFIG.SESSION_SECRET)
      .update(`${username}:${Date.now()}:${crypto.randomBytes(16).toString("hex")}`)
      .digest("hex");

    const session = {
      username,
      createdAt: Date.now(),
      expiresAt: Date.now() + CONFIG.SESSION_TTL,
    };

    this.sessions.set(token, session);
    return { token, session };
  }

  getSession(token) {
    if (!token) return null;
    this.cleanupExpiredSessions();
    const session = this.sessions.get(token);
    if (!session) return null;
    if (session.expiresAt <= Date.now()) {
      this.sessions.delete(token);
      return null;
    }
    session.expiresAt = Date.now() + CONFIG.SESSION_TTL;
    return session;
  }

  destroySession(token) {
    if (!token) return;
    this.sessions.delete(token);
  }
}

class MikrotikService {
  constructor(activityLog) {
    this.activityLog = activityLog;
  }

  getConnectionConfigs() {
    return [
      { label: "primary", config: CONFIG.MIKROTIK_PRIMARY },
      { label: "backup", config: CONFIG.MIKROTIK_BACKUP },
    ].filter(({ config }) => config.host && config.user && config.password);
  }

  async tryConnect({ label, config }) {
    const client = new RouterOSClient(config);
    try {
      const connection = await client.connect();
      await connection.menu("/system/identity").getOnly();
      this.activityLog.push("info", "mikrotik", `Terhubung ke MikroTik ${label}`);
      return { client, connection, label };
    } catch (error) {
      client.close();
      this.activityLog.push("error", "mikrotik", `Gagal konek MikroTik ${label}: ${error.message}`);
      return null;
    }
  }

  async withConnection(operation) {
    const configs = this.getConnectionConfigs();
    if (configs.length === 0) {
      throw new Error("Konfigurasi MikroTik belum lengkap. Isi IP_MIKROTIK, USER_MIKROTIK, dan PASSWORD_MIKROTIK di .env.");
    }

    let connectionObj = null;
    for (const item of configs) {
      connectionObj = await this.tryConnect(item);
      if (connectionObj) break;
    }

    if (!connectionObj) {
      throw new Error("Gagal terhubung ke MikroTik primary maupun backup.");
    }

    try {
      return await operation(connectionObj.connection);
    } finally {
      connectionObj.client.close();
    }
  }

  async getHotspotProfiles() {
    return this.withConnection(async (conn) => {
      const profiles = await conn.menu("/ip/hotspot/user/profile").print();
      return (profiles || [])
        .map((profile) => ({
          name: profile.name,
          rateLimit: profile["rate-limit"] || "",
        }))
        .filter((profile) => profile.name)
        .sort((a, b) => a.name.localeCompare(b.name, "id-ID"));
    });
  }

  async removeHotspotUsersByName(conn, username) {
    const users = await conn.menu("/ip/hotspot/user").print();
    const matches = (users || []).filter((user) => String(user.name || "").toLowerCase() === String(username).toLowerCase());
    let removed = 0;

    for (const row of matches) {
      const rowId = row[".id"] || row.id || row.numbers || row.number;
      if (rowId) {
        await conn.menu("/ip/hotspot/user").remove(String(rowId));
      } else {
        await conn.menu("/ip/hotspot/user").where("name", row.name || username).remove();
      }
      removed += 1;
    }

    return { removed };
  }

  async deleteHotspotUser(username) {
    return this.withConnection((conn) => this.removeHotspotUsersByName(conn, username));
  }

  async createHotspotCustomer({ name, phoneNumber, profile }) {
    const customerName = sanitizeInput(name);
    const normalizedPhone = normalizePhoneNumber(phoneNumber);
    const profileName = sanitizeInput(profile);
    const username = formatUsernameFromName(customerName);
    const password = normalizedPhone.slice(-5);

    if (!customerName) throw new Error("Nama pelanggan wajib diisi.");
    if (!isValidPhoneNumber(normalizedPhone)) throw new Error("Nomor pelanggan harus berformat 628xxx.");
    if (!profileName) throw new Error("Profile hotspot wajib dipilih.");
    if (!username) throw new Error("Nama pelanggan tidak bisa dijadikan username hotspot.");

    return this.withConnection(async (conn) => {
      const users = await conn.menu("/ip/hotspot/user").print();
      const profiles = await conn.menu("/ip/hotspot/user/profile").print();

      if ((users || []).some((user) => String(user.name || "").toLowerCase() === username.toLowerCase())) {
        throw new Error(`Username "${username}" sudah ada di MikroTik.`);
      }

      if (!(profiles || []).some((item) => item.name === profileName)) {
        throw new Error(`Profile "${profileName}" tidak ditemukan di MikroTik.`);
      }

      const addResult = await conn.menu("/ip/hotspot/user").add({
        name: username,
        password,
        profile: profileName,
        email: buildHotspotEmailFromPhone(normalizedPhone),
      });

      if (addResult?.["!trap"]) {
        const message = addResult["!trap"]?.[0]?.message || "Error tidak diketahui dari MikroTik.";
        throw new Error(`Gagal membuat user hotspot: ${message}`);
      }

      return {
        username,
        password,
        name: customerName,
        phoneNumber: normalizedPhone,
        profile: profileName,
      };
    });
  }
}

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
    return Array.from(this.contacts.values()).sort((a, b) => a.name.localeCompare(b.name, "id-ID"));
  }

  getContacts() {
    return Array.from(this.contacts.values());
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
    return {
      contacts: contacts.length,
      pelanggan: this.pelanggan.size,
      reminders: reminders.length,
      sentReminders: sentReminders.length,
      paidContacts: paid,
      unpaidContacts: unpaid,
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

    if (!nextName) throw new Error("Nama kontak wajib diisi.");
    if (!isValidPhoneNumber(nextPhone)) throw new Error("Nomor kontak harus berformat 628xxx.");
    if (this.hasContactPhone(nextPhone, id)) throw new Error("Nomor kontak sudah digunakan.");

    contact.name = nextName;
    contact.phoneNumber = nextPhone;

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

    const currentKey = getBillingPeriodKey();
    if (!contact.paymentMonths || typeof contact.paymentMonths !== "object") {
      contact.paymentMonths = {};
    }

    contact.paymentStatus = status;
    contact.paymentDate = status === PAYMENT_STATUS.PAID ? new Date().toISOString() : null;
    contact.paymentType = paymentType || null;
    contact.paymentMonths[currentKey] = {
      status,
      paidDate: status === PAYMENT_STATUS.PAID ? new Date().toISOString() : null,
      paymentType: paymentType || null,
    };

    await this.saveContacts();
    return contact;
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
    contact.paymentMonths[key] = {
      status,
      paidDate: status === PAYMENT_STATUS.PAID ? new Date().toISOString() : null,
      paymentType: paymentType || null,
    };

    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth() + 1;
    if (year === currentYear && month === currentMonth) {
      contact.paymentStatus = status;
      contact.paymentDate = status === PAYMENT_STATUS.PAID ? new Date().toISOString() : null;
      contact.paymentType = paymentType || null;
    }

    await this.saveContacts();
    return contact;
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

class TemplateManager {
  constructor(activityLog) {
    this.activityLog = activityLog;
  }

  sanitizeFileName(name) {
    const clean = sanitizeInput(name).replace(/[<>:"/\\|?*\u0000-\u001F]/g, "-");
    if (!clean) {
      throw new Error("Nama template wajib diisi.");
    }
    return clean.endsWith(".txt") ? clean : `${clean}.txt`;
  }

  getTemplatePath(name) {
    return path.join(CONFIG.TEMPLATE_PATH, this.sanitizeFileName(name));
  }

  async listTemplates() {
    const files = await fs.readdir(CONFIG.TEMPLATE_PATH).catch(() => []);
    const templates = [];

    for (const file of files.sort()) {
      const fullPath = path.join(CONFIG.TEMPLATE_PATH, file);
      try {
        const content = await fs.readFile(fullPath, "utf-8");
        templates.push({
          name: file,
          content,
          updatedAt: (await fs.stat(fullPath)).mtime.toISOString(),
        });
      } catch (error) {
        this.activityLog.push("error", "templates", `Failed to load template ${file}`, { error: error.message });
      }
    }

    return templates;
  }

  async createTemplate(name, content) {
    const fileName = this.sanitizeFileName(name);
    const templatePath = path.join(CONFIG.TEMPLATE_PATH, fileName);

    if (fsSync.existsSync(templatePath)) {
      throw new Error("Template dengan nama tersebut sudah ada.");
    }

    const safeContent = sanitizeMultilineText(content);
    await fs.writeFile(templatePath, safeContent);
    return { name: fileName, content: safeContent };
  }

  async updateTemplate(name, content) {
    const templatePath = this.getTemplatePath(name);
    if (!fsSync.existsSync(templatePath)) {
      throw new Error("Template tidak ditemukan.");
    }

    const safeContent = sanitizeMultilineText(content);
    await fs.writeFile(templatePath, safeContent);
    return { name: path.basename(templatePath), content: safeContent };
  }

  async deleteTemplate(name) {
    const templatePath = this.getTemplatePath(name);
    if (!fsSync.existsSync(templatePath)) {
      throw new Error("Template tidak ditemukan.");
    }
    await fs.unlink(templatePath);
    return path.basename(templatePath);
  }

  applyTemplate(template, variables) {
    let message = String(template || "");
    for (const [key, value] of Object.entries(variables)) {
      const safeValue = typeof value === "string" ? value.replace(/[*_`~]/g, "\\$&") : String(value);
      message = message.replace(new RegExp(`{{${key}}}`, "gi"), safeValue);
    }
    return message;
  }
}

class NotificationBot {
  constructor(dataManager, activityLog) {
    this.dataManager = dataManager;
    this.activityLog = activityLog;
    this.client = null;
    this.currentQR = null;
    this.isReady = false;
    this.isReconnecting = false;
    this.reconnectAttempts = 0;
    this.lastReconnectTime = null;
    this.reconnectTimer = null;
    this.keepAliveTimer = null;
  }

  createClient() {
    const executablePath = resolveChromeExecutablePath();
    const puppeteerOptions = {
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-accelerated-2d-canvas",
        "--no-first-run",
        "--no-zygote",
        "--disable-gpu",
        "--disable-software-rasterizer",
        "--disable-features=VizDisplayCompositor",
        "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding",
        "--max-old-space-size=512",
      ],
      ignoreHTTPSErrors: true,
    };

    if (executablePath) {
      puppeteerOptions.executablePath = executablePath;
      this.activityLog.push("info", "whatsapp", `Using Chrome executable ${executablePath}`);
    }

    return new Client({
      authStrategy: new LocalAuth({ dataPath: CONFIG.DB_PATH }),
      puppeteer: puppeteerOptions,
      webVersionCache: {
        type: "remote",
        remotePath: "https://raw.githubusercontent.com/wppconnect-team/wa-version/refs/heads/main/html/2.3000.1033090211-alpha.html",
      },
    });
  }

  async initialize() {
    if (this.client) {
      try {
        await this.client.destroy();
      } catch {}
    }

    this.client = this.createClient();
    this.setupEvents();
    await this.client.initialize();
    this.activityLog.push("info", "whatsapp", "WhatsApp client initialization started");
  }

  setupEvents() {
    if (!this.client) return;
    this.client.removeAllListeners();

    this.client.on("qr", (qr) => {
      this.currentQR = qr;
      this.isReady = false;
      this.reconnectAttempts = 0;
      this.isReconnecting = false;
      this.activityLog.push("info", "whatsapp", "QR code generated");
      qrcode.generate(qr, { small: true });
    });

    this.client.on("authenticated", () => {
      this.activityLog.push("info", "whatsapp", "WhatsApp authenticated");
      this.reconnectAttempts = 0;
      this.isReconnecting = false;
    });

    this.client.on("auth_failure", async (message) => {
      this.isReady = false;
      this.activityLog.push("error", "whatsapp", "Authentication failed", { message });
      await this.notifyAdminsIfEnabled("Perubahan status bot", `Autentikasi WhatsApp gagal.\n\nDetail:\n${message}`);
      this.scheduleReconnect();
    });

    this.client.on("ready", async () => {
      this.isReady = true;
      this.currentQR = null;
      this.reconnectAttempts = 0;
      this.isReconnecting = false;
      this.lastReconnectTime = null;
      this.activityLog.push("info", "whatsapp", "WhatsApp ready");
      await this.notifyAdminsIfEnabled(
        "Bot kembali online",
        "Transport WhatsApp siap mengirim notifikasi dari dashboard dan scheduler."
      );
    });

    this.client.on("change_state", async (state) => {
      this.activityLog.push("info", "whatsapp", `WA state changed to ${state}`);
      if (state === "CONNECTED") {
        this.isReady = true;
        this.reconnectAttempts = 0;
        this.isReconnecting = false;
        return;
      }

      if (["DISCONNECTED", "CONFLICT"].includes(state)) {
        this.isReady = false;
        await this.notifyAdminsIfEnabled(
          "Transport WA terganggu",
          `State WhatsApp berubah menjadi ${state}. Bot akan mencoba reconnect otomatis.`
        );
        this.scheduleReconnect();
      }
    });

    this.client.on("disconnected", async (reason) => {
      this.isReady = false;
      this.currentQR = null;
      this.activityLog.push("error", "whatsapp", "WhatsApp disconnected", { reason });
      if (["UNAUTHORIZED", "CONFLICT"].includes(reason)) {
        const sessionPath = path.join(CONFIG.DB_PATH, ".wwebjs_auth");
        await fs.rm(sessionPath, { recursive: true, force: true }).catch(() => {});
      }
      await this.notifyAdminsIfEnabled(
        "WhatsApp terputus",
        `Koneksi terputus dengan alasan: ${reason}. Bot akan mencoba pemulihan otomatis.`
      );
      this.scheduleReconnect();
    });

    this.client.on("error", async (error) => {
      this.activityLog.push("error", "whatsapp", "WhatsApp runtime error", { error: error.message });
      if (!this.isReady && !this.isReconnecting) {
        await this.notifyAdminsIfEnabled(
          "Error transport WA",
          `Terjadi error pada transport WhatsApp:\n${error.message}`
        );
        this.scheduleReconnect();
      }
    });

  }

  scheduleReconnect() {
    if (this.isReconnecting) return;
    if (this.reconnectAttempts >= CONFIG.MAX_RECONNECT_ATTEMPTS) {
      this.activityLog.push("error", "whatsapp", "Maximum reconnect attempts reached");
      return;
    }

    const now = Date.now();
    if (this.lastReconnectTime && now - this.lastReconnectTime < CONFIG.MIN_RECONNECT_INTERVAL) {
      const waitMs = CONFIG.MIN_RECONNECT_INTERVAL - (now - this.lastReconnectTime);
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = setTimeout(() => this.scheduleReconnect(), waitMs);
      return;
    }

    this.isReconnecting = true;
    this.reconnectAttempts += 1;
    this.lastReconnectTime = now;

    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(async () => {
      try {
        this.activityLog.push("info", "whatsapp", `Reconnect attempt ${this.reconnectAttempts}/${CONFIG.MAX_RECONNECT_ATTEMPTS}`);
        await this.initialize();
      } catch (error) {
        this.activityLog.push("error", "whatsapp", "Reconnect failed", { error: error.message });
      } finally {
        this.isReconnecting = false;
      }
    }, CONFIG.RECONNECT_DELAY);
  }

  startKeepAlive() {
    clearInterval(this.keepAliveTimer);
    this.keepAliveTimer = setInterval(async () => {
      if (!this.client) return;
      try {
        await this.client.getState();
      } catch {
        this.isReady = false;
        this.activityLog.push("error", "whatsapp", "Keep-alive failed");
        this.scheduleReconnect();
      }
    }, CONFIG.KEEP_ALIVE_INTERVAL);
  }

  async sendMessage(phoneNumber, message) {
    if (!this.isReady || !this.client) {
      throw new Error("WhatsApp not ready");
    }
    const normalized = normalizePhoneNumber(phoneNumber);
    if (!isValidPhoneNumber(normalized)) {
      throw new Error("Invalid target phone number");
    }
    await this.client.sendMessage(`${normalized}@c.us`, String(message));
  }

  async sendAdminBroadcast(title, body, options = {}) {
    const recipients = this.dataManager.getAdminRecipients();
    if (recipients.length === 0) return [];

    const message = `*${title}*\n\n${body}`;
    const results = [];

    for (const phoneNumber of recipients) {
      try {
        await this.sendMessage(phoneNumber, message);
        results.push({ phoneNumber, status: "sent" });
      } catch (error) {
        results.push({ phoneNumber, status: "failed", error: error.message });
      }
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
        await this.sendMessage(contact.phoneNumber, message);
        results.push({ phoneNumber: contact.phoneNumber, name: contact.name, status: "sent" });
      } catch (error) {
        results.push({ phoneNumber: contact.phoneNumber, name: contact.name, status: "failed", error: error.message });
      }
    }

    const successCount = results.filter(r => r.status === "sent").length;
    const failedCount = results.filter(r => r.status === "failed").length;
    
    if (!options.silentLog) {
      this.activityLog.push("info", "broadcast", `${title} dikirim ke ${successCount} contact(s), ${failedCount} gagal`);
    }
    return results;
  }

  async sendPaymentNotification(contact, transactionId, paymentType = "DEFAULT") {
    const paymentDate = contact.paymentDate ? new Date(contact.paymentDate) : new Date();
    const formattedDate = paymentDate.toLocaleString("id-ID", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });

    let statusText = "LUNAS";
    let noteText = "Pembayaran Anda telah berhasil kami terima.";

    if (paymentType === "ARREARS-ONLY") {
      statusText = "TUNGGAKAN TERBAYAR";
      noteText = "Pembayaran tunggakan bulan sebelumnya telah kami terima. Catatan: Bulan ini masih belum lunas.";
    } else if (paymentType === "CURRENT-ONLY") {
      statusText = "LUNAS (BULAN INI)";
      noteText = "Pembayaran bulan ini telah kami terima dan riwayat bulan sebelumnya sudah lunas.";
    } else if (paymentType === "FULL-PAID") {
      statusText = "LUNAS";
      noteText = "Semua tagihan (bulan sebelumnya dan bulan ini) telah lunas. Terima kasih atas kelancarannya!";
    }

    const message = `*BUKTI PEMBAYARAN EMMERIL HOTSPOT*

Halo ${contact.name}!

Terima kasih telah melakukan pembayaran.
Berikut detail transaksi Anda:

*ID Transaksi*
${transactionId}

*Tanggal Pembayaran*
${formattedDate}

*Status*
${statusText}

${noteText}

Hormat kami,
CS Emmeril Hotspot`;

    await this.sendMessage(contact.phoneNumber, message);
    this.activityLog.push("info", "payment", `Notifikasi pembayaran terkirim ke ${contact.phoneNumber}`, {
      transactionId,
      contactId: contact.id,
    });
    return { phoneNumber: contact.phoneNumber, transactionId };
  }

  async notifyAdminsIfEnabled(title, body) {
    const settings = this.dataManager.getSettings();
    if (!settings.notifyAdminsOnConnectionChange) return [];
    const connectionTitles = new Set([
      "Perubahan status bot",
      "Bot kembali online",
      "Transport WA terganggu",
      "WhatsApp terputus",
      "Error transport WA",
    ]);
    if (!connectionTitles.has(title)) return [];
    return this.sendAdminBroadcast(title, body, { silentLog: true });
  }

  getStatus() {
    return {
      isReady: this.isReady,
      hasQR: Boolean(this.currentQR),
      reconnectAttempts: this.reconnectAttempts,
      isReconnecting: this.isReconnecting,
      adminRecipients: this.dataManager.getAdminRecipients(),
    };
  }
}

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

class WebServer {
  constructor(notificationBot, dataManager, templateManager, activityLog, reminderScheduler, authManager, mikrotikService) {
    this.app = express();
    this.notificationBot = notificationBot;
    this.dataManager = dataManager;
    this.templateManager = templateManager;
    this.activityLog = activityLog;
    this.reminderScheduler = reminderScheduler;
    this.authManager = authManager;
    this.mikrotikService = mikrotikService;
    this.setupRoutes();
  }

  setupRoutes() {
    this.app.use(express.json({ limit: "1mb" }));
    this.app.use(express.urlencoded({ extended: true, limit: "1mb" }));
    this.app.use("/public", express.static(CONFIG.PUBLIC_PATH));

    this.app.use((req, res, next) => {
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("X-Frame-Options", "DENY");
      res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
      next();
    });

    const hasApiKeyAccess = (req) => {
      const apiKey = req.headers["x-api-key"] || req.query.api_key;
      const apiKeyIsConfigured = Boolean(CONFIG.WEB_API_KEY && CONFIG.WEB_API_KEY !== "dev-key-change-in-production");
      return Boolean(apiKeyIsConfigured && apiKey && safeCompareString(apiKey, CONFIG.WEB_API_KEY));
    };

    const readSession = (req) => {
      const cookies = parseCookies(req.headers.cookie);
      const token = cookies[CONFIG.SESSION_COOKIE_NAME];
      const session = this.authManager.getSession(token);
      return { token, session };
    };

    const requireApiAuth = (req, res, next) => {
      if (hasApiKeyAccess(req)) return next();

      const { session } = readSession(req);
      if (!session) {
        return res.status(401).json({ success: false, error: "Unauthorized" });
      }

      req.authSession = session;
      return next();
    };

    const requirePageAuth = (req, res, next) => {
      if (hasApiKeyAccess(req)) return next();

      const { session } = readSession(req);
      if (!session) {
        return res.redirect("/login");
      }

      req.authSession = session;
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

    this.app.get("/", (req, res) => res.redirect("/dashboard"));
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

      if (!this.authManager.validateCredentials(username, password)) {
        this.activityLog.push("error", "auth", `Login gagal untuk user ${username || "(kosong)"}`);
        const error = new Error("Username atau password salah.");
        error.statusCode = 401;
        throw error;
      }

      const { token, session } = this.authManager.createSession(username);
      const secureCookie = req.secure || req.headers["x-forwarded-proto"] === "https";
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
      const secureCookie = req.secure || req.headers["x-forwarded-proto"] === "https";
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
      username: req.authSession.username,
      expiresAt: new Date(req.authSession.expiresAt).toISOString(),
      usingApiKey: hasApiKeyAccess(req),
    })));

    this.app.get("/dashboard", requirePageAuth, async (req, res, next) => {
      try {
        res.send(await this.renderDashboard());
      } catch (error) {
        next(error);
      }
    });
    this.app.get("/qr", requirePageAuth, async (req, res) => {
      if (this.notificationBot.isReady) {
        return res.send(`
          <html><body style="display:flex;justify-content:center;align-items:center;height:100vh;background:#f4f5ef;font-family:Georgia,serif;">
            <div style="padding:28px 34px;border-radius:20px;background:white;box-shadow:0 20px 60px rgba(0,0,0,.12);color:#204b57;font-size:1.3rem;">
              WhatsApp sudah terhubung dan siap mengirim notifikasi.
            </div>
          </body></html>
        `);
      }

      if (!this.notificationBot.currentQR) {
        return res.send("Menunggu QR code...");
      }

      const qrImage = await QRCode.toDataURL(this.notificationBot.currentQR);
      return res.send(`
        <html>
          <head><meta http-equiv="refresh" content="15"><title>Scan QR</title></head>
          <body style="margin:0;min-height:100vh;display:grid;place-items:center;background:linear-gradient(135deg,#f4efe4,#dce7e2);font-family:Georgia,serif;">
            <div style="background:white;padding:28px;border-radius:24px;box-shadow:0 20px 60px rgba(0,0,0,.12);text-align:center;max-width:420px;">
              <h1 style="margin-top:0;color:#204b57;">Hubungkan Transport WhatsApp</h1>
              <img src="${qrImage}" style="max-width:320px;width:100%;border-radius:18px;">
              <p>Scan QR ini dari WhatsApp untuk mengaktifkan channel notifikasi.</p>
              <p>Reconnect attempts: ${this.notificationBot.reconnectAttempts}/${CONFIG.MAX_RECONNECT_ATTEMPTS}</p>
            </div>
          </body>
        </html>
      `);
    });

    this.app.get("/api/status", requireApiAuth, handleApi(async () => ({
      bot: this.notificationBot.getStatus(),
      summary: this.dataManager.getDashboardSummary(),
      settings: this.dataManager.getSettings(),
      billingPeriod: getBillingPeriodKey(),
      scheduler: { isProcessing: this.reminderScheduler.isProcessing },
    })));

    this.app.get("/api/logs", requireApiAuth, handleApi(async () => this.activityLog.list()));

    this.app.get("/api/contacts", requireApiAuth, handleApi(async () => this.dataManager.getSortedContacts()));
    this.app.post("/api/contacts", requireApiAuth, handleApi(async (req) => this.dataManager.addContact(req.body)));
    this.app.put("/api/contacts/:id", requireApiAuth, handleApi(async (req) => this.dataManager.updateContact(req.params.id, req.body)));
    this.app.delete("/api/contacts/:id", requireApiAuth, handleApi(async (req) => this.dataManager.deleteContact(req.params.id)));

    this.app.get("/api/mikrotik/profiles", requireApiAuth, handleApi(async () => this.mikrotikService.getHotspotProfiles()));
    this.app.post("/api/mikrotik/customers", requireApiAuth, handleApi(async (req) => {
      const registered = await this.mikrotikService.createHotspotCustomer({
        name: req.body.name,
        phoneNumber: req.body.phoneNumber,
        profile: req.body.profile,
      });

      let persisted;
      try {
        persisted = await this.dataManager.upsertPelangganFromRegistration(registered);
      } catch (error) {
        await this.mikrotikService.deleteHotspotUser(registered.username).catch((rollbackError) => {
          this.activityLog.push("error", "mikrotik", `Rollback user ${registered.username} gagal: ${rollbackError.message}`);
        });
        throw error;
      }

      let notification = { sent: false };
      if (parseBoolean(req.body.sendCredentials) && this.notificationBot.isReady) {
        const message = `Yth. Bapak/Ibu *${registered.name}*,\n\nAkun hotspot Anda sudah berhasil dibuat.\n\nDetail Akun Hotspot:\n*Username:* ${registered.username}\n*Password:* ${registered.password}\n*Profile:* ${registered.profile}\n\nSilakan simpan data ini. Terimakasih.`;
        try {
          await this.notificationBot.sendMessage(registered.phoneNumber, message);
          notification = { sent: true };
        } catch (error) {
          notification = { sent: false, error: error.message };
        }
      } else if (parseBoolean(req.body.sendCredentials)) {
        notification = { sent: false, error: "WhatsApp belum online." };
      }

      this.activityLog.push("info", "mikrotik", `Pelanggan ${registered.name} dibuat sebagai ${registered.username}`, {
        profile: registered.profile,
        phoneNumber: registered.phoneNumber,
        notification,
      });

      return {
        ...registered,
        contact: persisted.contact,
        pelanggan: persisted.pelanggan,
        notification,
      };
    }));

    this.app.post("/api/contacts/:id/payment", requireApiAuth, handleApi(async (req) => {
      const status = sanitizeInput(req.body.status).toUpperCase();
      const requestedPaymentType = sanitizeInput(req.body.paymentType).toUpperCase();
      const allowedPaymentTypes = this.dataManager.getAllowedPaymentTypes();
      const paymentType = allowedPaymentTypes.includes(requestedPaymentType)
        ? requestedPaymentType
        : (status === PAYMENT_STATUS.PAID ? allowedPaymentTypes[0] : null);
      const updatedContact = await this.dataManager.updatePaymentStatus(req.params.id, status, paymentType);
      const shouldSendPaymentNotification = status === PAYMENT_STATUS.PAID || paymentType === PAYMENT_TYPES.ARREARS_ONLY;

      if (!shouldSendPaymentNotification) {
        return {
          contact: updatedContact,
          notificationSent: false,
        };
      }

      const transactionId = `TRX-${Date.now()}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
      try {
        await this.notificationBot.sendPaymentNotification(updatedContact, transactionId, paymentType);
        return {
          contact: updatedContact,
          transactionId,
          paymentType,
          notificationSent: true,
        };
      } catch (error) {
        this.activityLog.push("error", "payment", `Status paid tersimpan tapi notifikasi gagal dikirim ke ${updatedContact.phoneNumber}`, {
          error: error.message,
          transactionId,
          contactId: updatedContact.id,
        });

        return {
          contact: updatedContact,
          transactionId,
          notificationSent: false,
          notificationError: error.message,
        };
      }
    }));

    this.app.post("/api/contacts/:id/payment-month", requireApiAuth, handleApi(async (req) => {
      const year = Number(req.body.year);
      const month = Number(req.body.month);
      const status = sanitizeInput(req.body.status).toUpperCase();
      const paymentType = sanitizeInput(req.body.paymentType).toUpperCase();
      if (!year || !month) throw new Error("Year dan month wajib diisi.");
      return this.dataManager.setPaymentForMonth(
        req.params.id,
        year,
        month,
        status,
        this.dataManager.getAllowedPaymentTypes().includes(paymentType) ? paymentType : null
      );
    }));

    this.app.get("/api/reminders", requireApiAuth, handleApi(async () => this.dataManager.getSortedReminders()));
    this.app.post("/api/reminders", requireApiAuth, handleApi(async (req) => {
      const when = parseDateTimeInput(req.body.reminderDateTime);
      if (!when) throw new Error("Format reminderDateTime harus YYYY-MM-DD HH:mm.");
      if (when.getTime() <= Date.now()) throw new Error("Reminder harus dijadwalkan di masa depan.");
      return this.dataManager.addReminder({
        contactId: req.body.contactId,
        reminderDateTime: when,
        message: req.body.message,
        templateName: req.body.templateName,
      });
    }));
    this.app.put("/api/reminders/:id", requireApiAuth, handleApi(async (req) => {
      const payload = { ...req.body };
      if (payload.reminderDateTime !== undefined) {
        const when = parseDateTimeInput(payload.reminderDateTime);
        if (!when) throw new Error("Format reminderDateTime harus YYYY-MM-DD HH:mm.");
        payload.reminderDateTime = when;
      }
      return this.dataManager.updateReminder(req.params.id, payload);
    }));
    this.app.delete("/api/reminders/:id", requireApiAuth, handleApi(async (req) => this.dataManager.deleteReminder(req.params.id)));
    this.app.get("/api/reminders/sent", requireApiAuth, handleApi(async () => this.dataManager.getSentReminders()));

    this.app.get("/api/templates", requireApiAuth, handleApi(async () => this.templateManager.listTemplates()));
    this.app.post("/api/templates", requireApiAuth, handleApi(async (req) => this.templateManager.createTemplate(req.body.name, req.body.content)));
    this.app.put("/api/templates/:name", requireApiAuth, handleApi(async (req) => this.templateManager.updateTemplate(req.params.name, req.body.content)));
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

      await this.notificationBot.sendMessage(phoneNumber, message);
      this.activityLog.push("info", "manual", `Manual notification sent to ${phoneNumber}`);
      return {
        phoneNumber,
        contactId: selectedContact?.id || null,
        contactName: selectedContact?.name || null,
        status: "sent",
      };
    }));

    this.app.post("/api/notifications/admin-broadcast", requireApiAuth, handleApi(async (req) => {
      const title = sanitizeInput(req.body.title) || "Status Bot";
      const body = sanitizeMultilineText(req.body.message);
      if (!body) throw new Error("Pesan broadcast wajib diisi.");
      return this.notificationBot.sendAdminBroadcast(title, body);
    }));

    this.app.post("/api/notifications/broadcast", requireApiAuth, handleApi(async (req) => {
      const title = sanitizeInput(req.body.title) || "Pengumuman";
      const templateName = sanitizeInput(req.body.templateName || "");
      let body = sanitizeMultilineText(req.body.message);
      if (templateName) {
        const templatePath = this.templateManager.getTemplatePath(templateName);
        body = sanitizeMultilineText(await fs.readFile(templatePath, "utf-8"));
      }
      if (!body) throw new Error("Pesan broadcast wajib diisi.");
      return this.notificationBot.sendContactBroadcast(title, body, {
        renderMessage: (contact, content) =>
          this.templateManager.applyTemplate(content, {
            name: contact?.name || "",
            phoneNumber: contact?.phoneNumber || "",
            date: new Date().toLocaleDateString("id-ID"),
          }),
      });
    }));

    this.app.post("/api/scheduler/run", requireApiAuth, handleApi(async () => {
      await this.reminderScheduler.processDueReminders();
      return { queued: true };
    }));

    this.app.get("/api/payments/history", requireApiAuth, handleApi(async () => this.dataManager.getAllPaymentsHistory()));
    this.app.get("/api/payments/current", requireApiAuth, handleApi(async () => {
      const now = new Date();
      const currentYear = now.getFullYear();
      const currentMonth = now.getMonth() + 1;
      const payments = this.dataManager.getPaymentsByMonth(currentYear, currentMonth);
      const allHistory = this.dataManager.getAllPaymentsHistory();
      const prevMonth = currentMonth === 1 ? 12 : currentMonth - 1;
      const prevYear = currentMonth === 1 ? currentYear - 1 : currentYear;
      const prevPayments = allHistory[`${prevYear}-${String(prevMonth).padStart(2, "0")}`]?.total || 0;
      const growth = prevPayments > 0 ? Number((((payments.length - prevPayments) / prevPayments) * 100).toFixed(1)) : 0;

      return {
        current: { year: currentYear, month: currentMonth, total: payments.length, contacts: payments },
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

      return this.dataManager.getPaymentsByMonth(year, month).map((contact) => ({
        id: contact.id,
        name: contact.name,
        phoneNumber: contact.phoneNumber,
        paymentDate: contact.paymentDate,
        paymentStatus: contact.paymentStatus,
      }));
    }));
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

  start() {
    this.app.listen(CONFIG.PORT, () => {
      this.activityLog.push("info", "web", `Dashboard running at http://localhost:${CONFIG.PORT}/dashboard`);
      this.activityLog.push("info", "web", `QR page running at http://localhost:${CONFIG.PORT}/qr`);
    });
  }
}

async function sendMonthlyResetNotification(notificationBot, dataManager, activityLog) {
  const resetResult = await dataManager.ensureMonthlyPaymentReset();
  if (!resetResult.reset) {
    return;
  }

  const count = resetResult.count;
  const settings = dataManager.getSettings();
  const now = new Date();
  const currentMonth = now.getMonth() + 1;
  const currentYear = now.getFullYear();
  const prevMonth = currentMonth === 1 ? 12 : currentMonth - 1;
  const prevYear = currentMonth === 1 ? currentYear - 1 : currentYear;
  const overdue = dataManager.getOverdueContacts(prevYear, prevMonth);

  activityLog.push("info", "billing", `Monthly payment status reset completed for ${count} contact(s)`);

  if (!settings.notifyAdminsOnPaymentReset || !notificationBot.isReady) {
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

(async () => {
  const activityLog = new ActivityLog();
  for (const warning of collectSecurityWarnings()) {
    activityLog.push("warn", "config", warning);
  }

  const authManager = new AuthManager(activityLog);
  const dataManager = new DataManager(activityLog);
  const templateManager = new TemplateManager(activityLog);
  const notificationBot = new NotificationBot(dataManager, activityLog);
  const mikrotikService = new MikrotikService(activityLog);

  await dataManager.loadAll();

  const reminderScheduler = new ReminderScheduler(notificationBot, dataManager, activityLog);
  const webServer = new WebServer(
    notificationBot,
    dataManager,
    templateManager,
    activityLog,
    reminderScheduler,
    authManager,
    mikrotikService
  );

  await dataManager.ensureMonthlyPaymentReset();

  cron.schedule(CONFIG.CRON_SCHEDULE, () => {
    reminderScheduler.processDueReminders().catch((error) => {
      activityLog.push("error", "scheduler", `Cron execution failed: ${error.message}`);
    });
  });

  cron.schedule(CONFIG.RESET_PAYMENT_SCHEDULE, () => {
    sendMonthlyResetNotification(notificationBot, dataManager, activityLog).catch((error) => {
      activityLog.push("error", "billing", `Monthly reset failed: ${error.message}`);
    });
  });

  setInterval(() => {
    dataManager.saveAll().catch((error) => {
      activityLog.push("error", "storage", `Auto-save failed: ${error.message}`);
    });
  }, CONFIG.AUTO_SAVE_INTERVAL);

  setInterval(() => {
    dataManager.createBackup().catch((error) => {
      activityLog.push("error", "storage", `Backup failed: ${error.message}`);
    });
  }, CONFIG.BACKUP_INTERVAL);

  setInterval(() => {
    authManager.cleanupExpiredSessions();
  }, 60 * 60 * 1000);

  process.on("SIGINT", async () => {
    activityLog.push("info", "shutdown", "Saving data before shutdown");
    await dataManager.saveAll();
    process.exit(0);
  });

  process.on("uncaughtException", async (error) => {
    activityLog.push("error", "runtime", `Uncaught exception: ${error.message}`);
    await dataManager.saveAll();
    process.exit(1);
  });

  process.on("unhandledRejection", async (reason) => {
    const message = reason instanceof Error ? reason.message : String(reason);
    activityLog.push("error", "runtime", `Unhandled rejection: ${message}`);
    await dataManager.saveAll();
    process.exit(1);
  });

  webServer.start();
  notificationBot.initialize()
    .then(() => notificationBot.startKeepAlive())
    .catch((error) => {
      activityLog.push("error", "whatsapp", `Initial WhatsApp startup failed: ${error.message}`);
      notificationBot.scheduleReconnect();
    });
})();
