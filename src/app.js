require("dotenv").config({ quiet: true });

const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const express = require("express");
const cron = require("node-cron");
const crypto = require("crypto");
const ftp = require("basic-ftp");
const ExcelJS = require("exceljs");
const QRCode = require("qrcode");
const { RouterOSClient } = require("routeros-client");
const { Sequelize, DataTypes } = require("sequelize");
const {
  CONFIG,
  DEFAULT_SETTINGS,
  MONTH_NAMES,
  PAYMENT_STATUS,
  PAYMENT_TYPES,
} = require("./config");
const ActivityLog = require("./activity-log");
const AsyncLock = require("./async-lock");
const AuthManager = require("./auth-manager");
const { migrateWhatsAppProviderMetadata } = require("./migrations/whatsapp-provider-metadata");
const TelegramManager = require("./telegram-manager");
const WhatsAppProviderManager = require("./whatsapp/provider-manager");
const {
  ApDownNotifier,
  DatabaseBackupScheduler,
  HotspotReactivationScheduler,
  MikrotikBackupScheduler,
  ReminderScheduler,
  WhatsAppProviderStatusNotifier,
} = require("./schedulers");
const TemplateManager = require("./template-manager");
const {
  addMonthsSafely,
  assertSecureConfiguration,
  buildHotspotEmailFromPhone,
  collectSecurityWarnings,
  escapeHtml,
  formatBillingPeriodLabel,
  formatUsernameFromName,
  generateId,
  getBillingPeriodKey,
  getBillingPeriodParts,
  getPreviousBillingPeriod,
  isValidPhoneNumber,
  isValidTimeZone,
  makeBillingPeriodKey,
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
  [PAYMENT_TYPES.CURRENT_ONLY]: "Bulan Ini Saja",
  [PAYMENT_TYPES.FULL_PAID]: "Lunas Semua",
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
// MIKROTIK SERVICE
// ===============================

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
      return { client, connection, label, config };
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
      return await operation(connectionObj.connection, connectionObj);
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

  async getHotspotUsers() {
    return this.withConnection(async (conn) => {
      const [users, activeSessions] = await Promise.all([
        conn.menu("/ip/hotspot/user").print(),
        conn.menu("/ip/hotspot/active").print(),
      ]);

      const byUsername = new Map();
      for (const user of users || []) {
        const username = sanitizeInput(user.name || user.user || "");
        if (!username) continue;
        byUsername.set(username.toLowerCase(), {
          id: user[".id"] || user.id || user.numbers || "",
          username,
          profile: user.profile || "",
          comment: user.comment || "",
          disabled: String(user.disabled || "false").toLowerCase() === "true",
          email: user.email || "",
          active: false,
          source: "user",
        });
      }

      for (const session of activeSessions || []) {
        const username = sanitizeInput(session.user || session.name || "");
        if (!username) continue;
        const key = username.toLowerCase();
        const existing = byUsername.get(key);
        if (existing) {
          existing.active = true;
          existing.address = session.address || session["mac-address"] || "";
          existing.uptime = session.uptime || "";
          existing.server = session.server || "";
          continue;
        }

        byUsername.set(key, {
          id: session[".id"] || session.id || session.numbers || "",
          username,
          profile: "",
          comment: session.comment || "",
          disabled: false,
          email: "",
          active: true,
          address: session.address || session["mac-address"] || "",
          uptime: session.uptime || "",
          server: session.server || "",
          source: "active",
        });
      }

      return Array.from(byUsername.values())
        .sort((a, b) => a.username.localeCompare(b.username, "id-ID"));
    });
  }

  async getNetwatchStatus() {
    return this.withConnection(async (conn) => {
      const rows = await conn.menu("/tool/netwatch").print();
      return (rows || [])
        .map((row) => ({
          id: row[".id"] || row.id || row.numbers || "",
          host: row.host || row["host-address"] || "-",
          status: String(row.status || row.state || "unknown").toUpperCase(),
          since: row.since || "",
          comment: row.comment || "",
          interval: row.interval || "",
          timeout: row.timeout || "",
          type: row.type || "",
          upScript: row["up-script"] || "",
          downScript: row["down-script"] || "",
        }))
        .sort((a, b) => String(a.host || "").localeCompare(String(b.host || ""), "id-ID"));
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

  async removeActiveHotspotSessionsByName(conn, username) {
    const activeSessions = await conn.menu("/ip/hotspot/active").print();
    const matches = (activeSessions || []).filter((session) => {
      const sessionUser = session.user || session.name || "";
      return String(sessionUser).toLowerCase() === String(username).toLowerCase();
    });
    let killed = 0;

    for (const row of matches) {
      const rowId = row[".id"] || row.id || row.numbers || row.number;
      if (rowId) {
        await conn.menu("/ip/hotspot/active").remove(String(rowId));
      } else {
        await conn.menu("/ip/hotspot/active").where("user", row.user || username).remove();
      }
      killed += 1;
    }

    return { killed };
  }

  async deleteHotspotUser(username) {
    const hotspotUsername = sanitizeInput(username);
    if (!hotspotUsername) throw new Error("Username hotspot wajib diisi.");

    return this.withConnection(async (conn) => {
      const activeResult = await this.removeActiveHotspotSessionsByName(conn, hotspotUsername);
      const removeResult = await this.removeHotspotUsersByName(conn, hotspotUsername);
      return {
        username: hotspotUsername,
        activeSessionsKilled: activeResult.killed,
        removedUsers: removeResult.removed,
      };
    });
  }

  async reactivateHotspotUser({ username, password, profile, phoneNumber }) {
    const hotspotUsername = sanitizeInput(username);
    const hotspotPassword = sanitizeInput(password);
    const profileName = sanitizeInput(profile);
    const normalizedPhone = normalizePhoneNumber(phoneNumber);

    if (!hotspotUsername) throw new Error("Username hotspot wajib diisi.");
    if (!hotspotPassword) throw new Error("Password hotspot wajib diisi.");
    if (!profileName) throw new Error("Profile hotspot wajib dipilih.");

    return this.withConnection(async (conn) => {
      const profiles = await conn.menu("/ip/hotspot/user/profile").print();
      if (!(profiles || []).some((item) => item.name === profileName)) {
        throw new Error(`Profile "${profileName}" tidak ditemukan di MikroTik.`);
      }

      const activeResult = await this.removeActiveHotspotSessionsByName(conn, hotspotUsername);
      const removeResult = await this.removeHotspotUsersByName(conn, hotspotUsername);
      const addPayload = {
        name: hotspotUsername,
        password: hotspotPassword,
        profile: profileName,
      };

      if (normalizedPhone) {
        addPayload.email = buildHotspotEmailFromPhone(normalizedPhone);
      }

      const addResult = await conn.menu("/ip/hotspot/user").add(addPayload);
      if (addResult?.["!trap"]) {
        const message = addResult["!trap"]?.[0]?.message || "Error tidak diketahui dari MikroTik.";
        throw new Error(`Gagal membuat ulang user hotspot: ${message}`);
      }

      return {
        username: hotspotUsername,
        password: hotspotPassword,
        profile: profileName,
        activeSessionsKilled: activeResult.killed,
        removedUsers: removeResult.removed,
      };
    });
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

  async generateDailyBackupFile() {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupDir = await fs.mkdtemp(path.join(os.tmpdir(), "reminder-mikrotik-"));
    await fs.chmod(backupDir, 0o700);

    const fileName = `mikrotik-export-${timestamp}.rsc`;
    const filePath = path.join(backupDir, fileName);
    const remoteBaseName = `reminder-bot-${timestamp}`;
    const remoteFileName = `${remoteBaseName}.rsc`;

    try {
      await this.withConnection(async (conn, connectionObj) => {
        if (!connectionObj.config.tls) {
          this.activityLog.push(
            "warn",
            "mikrotik",
            "Backup sensitif MikroTik berjalan melalui API tanpa TLS; data tidak terenkripsi di jaringan."
          );
        }
        try {
          await this.createRouterExportFile(conn, remoteBaseName);
          await this.waitForRouterFile(conn, remoteFileName);
          await this.downloadRouterFile(conn, remoteFileName, filePath, connectionObj.config);
        } finally {
          try {
            await conn.menu("/file").where("name", remoteFileName).remove();
          } catch (error) {
            this.activityLog.push("warn", "mikrotik", `Gagal membersihkan file export ${remoteFileName} dari router`, {
              error: error.message,
            });
          }
        }
      });
      await fs.chmod(filePath, 0o600);
    } catch (error) {
      await fs.rm(backupDir, { recursive: true, force: true });
      throw error;
    }

    this.activityLog.push("info", "mikrotik", "Backup konfigurasi MikroTik berhasil dibuat", {
      filePath,
    });

    return {
      fileName,
      filePath,
      cleanup: () => fs.rm(backupDir, { recursive: true, force: true }),
    };
  }

  async createRouterExportFile(conn, remoteBaseName) {
    const exportAttempts = [
      { file: remoteBaseName, compact: true, "show-sensitive": true },
      { file: remoteBaseName, compact: true },
      { file: remoteBaseName, "show-sensitive": true },
      { file: remoteBaseName },
    ];

    let lastError = null;
    for (const params of exportAttempts) {
      try {
        await conn.menu("/").exec("export", params);
        return;
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError || new Error("Gagal membuat file export di MikroTik.");
  }

  async waitForRouterFile(conn, remoteFileName) {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const files = await conn.menu("/file").print();
      const file = (files || []).find((item) => String(item.name || "") === remoteFileName);
      const rawSize = String(file?.size || file?.fileSize || "0").replace(/[^0-9]/g, "");
      if (file && Number(rawSize || 0) > 0) return file;
      await sleep(1000);
    }

    throw new Error(`File export ${remoteFileName} belum siap di MikroTik.`);
  }

  async resolveFtpPort(conn, config) {
    if (!config) {
      throw new Error("Konfigurasi koneksi MikroTik tidak tersedia untuk fallback FTP.");
    }

    if (config.ftpPort && config.ftpPort !== 21) return config.ftpPort;

    const services = await conn.menu("/ip/service").print().catch(() => []);
    const ftpService = (services || []).find((item) => String(item.name || "").toLowerCase() === "ftp");
    if (String(ftpService?.disabled).toLowerCase() === "true") {
      throw new Error("Service FTP MikroTik sedang disabled.");
    }

    return Number(ftpService?.port || config.ftpPort || 21) || 21;
  }

  async downloadRouterFileViaFtp(config, ftpPort, remoteFileName, destinationPath) {
    const ftpClient = new ftp.Client(CONFIG.MIKROTIK_FTP_TIMEOUT);
    ftpClient.ftp.verbose = false;

    try {
      await ftpClient.access({
        host: config.host,
        user: config.user,
        password: config.password,
        port: ftpPort,
        secure: false,
      });
      await ftpClient.downloadTo(destinationPath, remoteFileName);
    } finally {
      ftpClient.close();
    }
  }

  async downloadRouterFile(conn, remoteFileName, destinationPath, config = null) {
    const files = await conn.menu("/file").print();
    const row = (files || []).find((item) => String(item.name || "") === remoteFileName);
    const rowId = row?.[".id"] || row?.id || row?.numbers || remoteFileName;
    let apiError = null;

    try {
      const response = await conn.menu("/file").exec("get", {
        number: rowId,
        "value-name": "contents",
      });
      const contents = response?.ret
        ?? response?.contents
        ?? response?.[0]?.ret
        ?? response?.[0]?.contents;
      if (contents === undefined || contents === null || String(contents).length === 0) {
        throw new Error("Isi file tidak tersedia melalui properti contents RouterOS.");
      }
      await fs.writeFile(destinationPath, String(contents), { mode: 0o600 });
    } catch (error) {
      apiError = error;
    }

    if (apiError) {
      if (!config) {
        throw new Error(`Isi file backup MikroTik tidak dapat dibaca melalui API: ${apiError.message}`);
      }

      const ftpPort = await this.resolveFtpPort(conn, config);
      this.activityLog.push(
        "warn",
        "mikrotik",
        "Isi backup terlalu besar atau tidak tersedia melalui API; menggunakan fallback FTP RouterOS.",
        { ftpPort }
      );
      try {
        await this.downloadRouterFileViaFtp(config, ftpPort, remoteFileName, destinationPath);
      } catch (ftpError) {
        throw new Error(`Download backup MikroTik gagal melalui API dan FTP: ${ftpError.message}`);
      }
    }

    const stats = await fs.stat(destinationPath);
    if (!stats.size) {
      throw new Error("File backup MikroTik berhasil diunduh tapi kosong.");
    }
  }
}

// ===============================
// DATA MANAGER (Sequelize)
// ===============================

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
    this.dataMutationLock = new AsyncLock();
    this.dbWriteLock = new AsyncLock();
    this.sequelize = null;
    this.models = {};
  }

  async initDirectories() {
    await fs.mkdir(CONFIG.DB_PATH, { recursive: true });
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

  async withDatabaseWrite(operation) {
    return this.dbWriteLock.runExclusive("database_write", operation);
  }

  async withDataMutation(operation) {
    return this.dataMutationLock.runExclusive("data_mutation", async () => {
      const snapshot = {
        contacts: structuredClone(this.contacts),
        pelanggan: structuredClone(this.pelanggan),
        reminders: structuredClone(this.reminders),
        sentReminders: structuredClone(this.sentReminders),
        roles: structuredClone(this.roles),
        settings: structuredClone(this.settings),
      };

      try {
        return await operation();
      } catch (error) {
        this.contacts = snapshot.contacts;
        this.pelanggan = snapshot.pelanggan;
        this.reminders = snapshot.reminders;
        this.sentReminders = snapshot.sentReminders;
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
    if (Object.hasOwn(this.settings, "whatsappProvider")) {
      delete this.settings.whatsappProvider;
      await this.saveSettings();
    }
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
    await this.migrateReminderPaymentAmounts();
    const migration = await migrateWhatsAppProviderMetadata(this);
    if (migration.remindersChanged || migration.sentChanged) {
      this.activityLog.push("info", "storage", "WhatsApp provider metadata migration selesai", migration);
    }
    await this.cleanupSentHistory();
    this.activityLog.push("info", "boot", "Data load complete", {
      contacts: this.contacts.size,
      pelanggan: this.pelanggan.size,
      reminders: this.reminders.size,
      sentReminders: this.sentReminders.size,
      adminRecipients: this.getAdminRecipients().length,
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
      contact.linkedApHost = sanitizeInput(String(contact.linkedApHost || ""));
      contact.mikrotikUsername = sanitizeInput(String(contact.mikrotikUsername || ""));
      contact.mikrotikProfile = sanitizeInput(String(contact.mikrotikProfile || ""));
      contact.mikrotikPassword = sanitizeInput(String(contact.mikrotikPassword || ""));
      contact.hotspotReactivationEnabled = parseBoolean(contact.hotspotReactivationEnabled, false);
      contact.hotspotReactivationAt = this.normalizeOptionalDate(contact.hotspotReactivationAt);
      contact.hotspotLastReactivatedAt = this.normalizeOptionalDate(contact.hotspotLastReactivatedAt);
      contact.hotspotLastDeactivatedAt = this.normalizeOptionalDate(contact.hotspotLastDeactivatedAt);
      const pendingNotification = contact.hotspotNotificationPending;
      if (!pendingNotification
        || typeof pendingNotification !== "object"
        || !sanitizeInput(pendingNotification.message || "")) {
        contact.hotspotNotificationPending = null;
      } else if (Math.max(0, Number(pendingNotification.attempts) || 0) > 0) {
        contact.hotspotNotificationLastStatus = "FAILED";
        contact.hotspotNotificationLastError = sanitizeInput(
          pendingNotification.lastError || "Pengiriman notifikasi sebelumnya gagal"
        );
        contact.hotspotNotificationLastAttemptAt = this.normalizeOptionalDate(
          pendingNotification.lastAttemptAt
        );
        contact.hotspotNotificationPending = null;
      }
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
            };
          }
        }
      }
    }
  }

  normalizeOptionalDate(value) {
    const raw = sanitizeInput(String(value || ""));
    if (!raw) return null;
    const date = parseDateTimeInput(raw, this.getTimezone()) || new Date(raw);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }

  normalizeContactHotspotFields(payload, current = {}) {
    const enabled = payload.hotspotReactivationEnabled !== undefined
      ? parseBoolean(payload.hotspotReactivationEnabled, false)
      : parseBoolean(current.hotspotReactivationEnabled, false);
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
    if (!enabled && reactivationAt && !username) throw new Error("Username hotspot wajib diisi untuk jadwal hapus hotspot.");

    return {
      mikrotikUsername: username,
      mikrotikProfile: profile,
      mikrotikPassword: password,
      hotspotReactivationEnabled: enabled,
      hotspotReactivationAt: reactivationAt,
    };
  }

  async saveAll() {
    await this.withDataMutation(() => (
      this.withDatabaseWrite(() => (
        this.sequelize.transaction(async (transaction) => {
          const options = { transaction };
          await this.saveContacts(options);
          await this.savePelanggan(options);
          await this.saveReminders(options);
          await this.saveSentReminders(options);
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
      paymentAmount: Math.max(0, Number(reminder.paymentAmount ?? contact?.monthlyPaymentAmount) || 0),
    };
  }

  buildDueDateInfo(contact) {
    const timeZone = this.getTimezone();
    const { year, month } = getBillingPeriodParts(new Date(), timeZone);
    const activePeriodKey = makeBillingPeriodKey(year, month);
    const isContactReminder = (reminder) => {
      if (String(reminder.contactId || "") === String(contact.id)) return true;
      return reminder.phoneNumber && reminder.phoneNumber === contact.phoneNumber;
    };

    const reminders = [
      ...Array.from(this.reminders.values()).filter(isContactReminder),
      ...Array.from(this.sentReminders.values()).filter(isContactReminder),
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
    const timeZone = this.getTimezone();
    const { year, month } = options.year && options.month
      ? { year: options.year, month: options.month }
      : getBillingPeriodParts(new Date(), timeZone);
    const currentKey = makeBillingPeriodKey(year, month);
    const paymentMonths = contact.paymentMonths || {};
    const currentPayment = paymentMonths[currentKey] || null;
    const currentType = String(currentPayment?.paymentType || contact.paymentType || "").toUpperCase();
    const previous = getPreviousBillingPeriod(year, month);
    const startPeriod = getContactBillingStartPeriod(contact, timeZone);
    const debtPeriods = currentType === PAYMENT_TYPES.FULL_PAID
      ? []
      : listBillingPeriods(startPeriod, previous)
        .filter((period) => {
          const key = makeBillingPeriodKey(period.year, period.month);
          return paymentMonths[key]?.status !== PAYMENT_STATUS.PAID;
        })
        .map((period) => ({
          key: makeBillingPeriodKey(period.year, period.month),
          label: formatBillingPeriodLabel(period.year, period.month),
          status: paymentMonths[makeBillingPeriodKey(period.year, period.month)]?.status || PAYMENT_STATUS.UNPAID,
        }));
    const hasDebt = debtPeriods.length > 0;
    const firstDebt = debtPeriods[0] || null;

    return {
      hasDebt,
      debtPeriod: firstDebt?.key || makeBillingPeriodKey(previous.year, previous.month),
      debtPeriodLabel: firstDebt?.label || formatBillingPeriodLabel(previous.year, previous.month),
      debtPeriods,
      debtCount: debtPeriods.length,
      debtNote: hasDebt
        ? `Masih ada hutang ${debtPeriods.map((period) => period.label).join(", ")}.`
        : "",
      previousPaymentStatus: paymentMonths[makeBillingPeriodKey(previous.year, previous.month)]?.status || PAYMENT_STATUS.UNPAID,
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

  toPublicContact(contact) {
    const result = this.hydrateContact(contact);
    delete result.mikrotikPassword;
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

  formatPaymentAmount(amount) {
    return new Intl.NumberFormat("id-ID", {
      style: "currency",
      currency: "IDR",
      maximumFractionDigits: 0,
    }).format(Math.max(0, Number(amount) || 0));
  }

  rewriteReminderPaymentMessage(reminder, contact) {
    const monthlyAmount = Math.max(0, Number(reminder.paymentAmount ?? contact.monthlyPaymentAmount) || 0);
    if (monthlyAmount <= 0) return false;
    const debtInfo = this.buildDebtInfo(contact);
    const debtCount = Math.max(0, Number(debtInfo.debtCount) || 0);
    const currentPaid = String(debtInfo.currentPaymentStatus || contact.paymentStatus || "UNPAID").toUpperCase() === PAYMENT_STATUS.PAID;
    const totalAmount = monthlyAmount * ((currentPaid ? 0 : 1) + debtCount);
    if (totalAmount <= 0) return false;

    const totalText = this.formatPaymentAmount(totalAmount);
    const amountPattern = /Rp\s*[0-9][0-9.]*(?:,[0-9]{1,2})?/i;
    const nextMessage = amountPattern.test(String(reminder.message || ""))
      ? String(reminder.message).replace(amountPattern, totalText).replace(/(Rp\s*[0-9][0-9.]*(?:,[0-9]{1,2})?)(?=[A-Za-z])/gi, "$1 ")
      : `${String(reminder.message || "").trim()}\n\n*Total tagihan: ${totalText}*`;
    if (nextMessage === reminder.message) return false;
    reminder.message = nextMessage;
    return true;
  }

  async addContact(payload) {
    return this.withDataMutation(async () => {
      const name = sanitizeInput(payload.name);
      const phoneNumber = normalizePhoneNumber(payload.phoneNumber);
      const linkedApHost = sanitizeInput(String(payload.linkedApHost || ""));
      const hotspotFields = this.normalizeContactHotspotFields(payload);

      if (!name) throw new Error("Nama kontak wajib diisi.");
      if (!isValidPhoneNumber(phoneNumber)) throw new Error("Nomor kontak harus berformat 628xxx.");
      if (this.hasContactPhone(phoneNumber)) throw new Error("Nomor kontak sudah digunakan.");

      const now = new Date().toISOString();
      const contact = {
        id: generateId(),
        name,
        phoneNumber,
        monthlyPaymentAmount: sanitizePositiveInteger(payload.monthlyPaymentAmount, 0, 0, 1_000_000_000),
        paymentStatus: PAYMENT_STATUS.UNPAID,
        paymentDate: null,
        paymentMonths: {},
        linkedApHost,
        ...hotspotFields,
        hotspotLastReactivatedAt: this.normalizeOptionalDate(payload.hotspotLastReactivatedAt),
        hotspotLastDeactivatedAt: this.normalizeOptionalDate(payload.hotspotLastDeactivatedAt),
        createdAt: now,
        updatedAt: now,
      };

      this.contacts.set(contact.id, contact);
      await this.saveContacts();
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

      const now = new Date().toISOString();
      let contact = this.findContactByPhone(phoneNumber);
      const linkedApHost = payload.linkedApHost !== undefined
        ? sanitizeInput(String(payload.linkedApHost || ""))
        : sanitizeInput(String(contact?.linkedApHost || ""));
      const hotspotFields = this.normalizeContactHotspotFields({
        ...payload,
        mikrotikUsername: username,
        mikrotikProfile: profile,
        mikrotikPassword: password,
      }, contact || {});

      if (!contact) {
        contact = {
          id: String(generateId()),
          name,
          phoneNumber,
          monthlyPaymentAmount: sanitizePositiveInteger(payload.monthlyPaymentAmount, 0, 0, 1_000_000_000),
          paymentStatus: PAYMENT_STATUS.UNPAID,
          paymentDate: null,
          paymentMonths: {},
          linkedApHost,
          ...hotspotFields,
          hotspotLastReactivatedAt: null,
          hotspotLastDeactivatedAt: null,
          createdAt: now,
          updatedAt: now,
        };
        this.contacts.set(contact.id, contact);
      } else {
        contact.name = name;
        contact.linkedApHost = linkedApHost;
        if (payload.monthlyPaymentAmount !== undefined) {
          contact.monthlyPaymentAmount = sanitizePositiveInteger(
            payload.monthlyPaymentAmount,
            Number(contact.monthlyPaymentAmount) || 0,
            0,
            1_000_000_000
          );
        }
        Object.assign(contact, hotspotFields);
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
      await this.withDatabaseWrite(() => this.sequelize.transaction(async (transaction) => {
        const options = { transaction };
        await this.saveContacts(options);
        await this.savePelanggan(options);
      }));
      return { contact, pelanggan };
    });
  }

  async updateContact(id, payload) {
    return this.withDataMutation(async () => {
      const contact = this.getContact(id);
      if (!contact) throw new Error("Kontak tidak ditemukan.");
      const previousPhone = contact.phoneNumber;

      const nextName = payload.name !== undefined ? sanitizeInput(payload.name) : contact.name;
      const nextPhone = payload.phoneNumber !== undefined ? normalizePhoneNumber(payload.phoneNumber) : contact.phoneNumber;
      const nextLinkedApHost = payload.linkedApHost !== undefined
        ? sanitizeInput(String(payload.linkedApHost || ""))
        : sanitizeInput(String(contact.linkedApHost || ""));
      const hotspotFields = this.normalizeContactHotspotFields(payload, contact);

      if (!nextName) throw new Error("Nama kontak wajib diisi.");
      if (!isValidPhoneNumber(nextPhone)) throw new Error("Nomor kontak harus berformat 628xxx.");
      if (this.hasContactPhone(nextPhone, id)) throw new Error("Nomor kontak sudah digunakan.");

      contact.name = nextName;
      contact.phoneNumber = nextPhone;
      contact.linkedApHost = nextLinkedApHost;
      if (payload.monthlyPaymentAmount !== undefined) {
        contact.monthlyPaymentAmount = sanitizePositiveInteger(
          payload.monthlyPaymentAmount,
          Number(contact.monthlyPaymentAmount) || 0,
          0,
          1_000_000_000
        );
      }
      Object.assign(contact, hotspotFields);
      contact.updatedAt = new Date().toISOString();

      for (const reminder of this.reminders.values()) {
        if (String(reminder.contactId) === String(id) || reminder.phoneNumber === previousPhone) {
          reminder.contactId = String(contact.id);
          reminder.phoneNumber = contact.phoneNumber;
          reminder.contactName = contact.name;
        }
      }

      await this.withDatabaseWrite(() => this.sequelize.transaction(async (transaction) => {
        const options = { transaction };
        await this.saveContacts(options);
        await this.saveReminders(options);
      }));
      return contact;
    });
  }

  async updateContactPaymentAmount(id, amount) {
    return this.withDataMutation(async () => {
      const contact = this.getContact(id);
      if (!contact) throw new Error("Kontak tidak ditemukan.");
      const parsed = Number(amount);
      if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1_000_000_000) {
        throw new Error("Nominal pembayaran harus antara 0 sampai 1 miliar.");
      }
      contact.monthlyPaymentAmount = Math.floor(parsed);
      contact.updatedAt = new Date().toISOString();
      await this.saveContacts();
      return this.hydrateContact(contact);
    });
  }

  getDueHotspotReactivationContacts(now = new Date()) {
    const nowTime = now.getTime();
    if (Number.isNaN(nowTime)) return [];

    return this.getSortedContacts().filter((contact) => {
      if (!contact.hotspotReactivationAt || !contact.mikrotikUsername) return false;
      if (contact.hotspotReactivationEnabled && !contact.mikrotikProfile) return false;
      const dueTime = new Date(contact.hotspotReactivationAt).getTime();
      return Number.isFinite(dueTime) && dueTime <= nowTime;
    });
  }

  getPendingHotspotNotificationContacts(now = new Date()) {
    const nowTime = now.getTime();
    return this.getSortedContacts().filter((contact) => {
      const pending = contact.hotspotNotificationPending;
      if (!pending?.message || !pending?.phoneNumber) return false;
      if (Math.max(0, Number(pending.attempts) || 0) > 0) return false;
      const nextAttemptTime = pending.nextAttemptAt ? new Date(pending.nextAttemptAt).getTime() : 0;
      return !Number.isFinite(nextAttemptTime) || nextAttemptTime <= nowTime;
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
      contact.updatedAt = now.toISOString();

      await this.saveContacts(options);
      return this.hydrateContact(contact);
    });
  }

  async markHotspotReactivated(contactId, result, options = {}) {
    return this.withDataMutation(async () => {
      const contact = this.getContact(contactId);
      if (!contact) throw new Error("Kontak tidak ditemukan.");

      const now = new Date();
      const previousSchedule = contact.hotspotReactivationAt || now.toISOString();
      let nextSchedule = addMonthsSafely(previousSchedule, 1, this.getTimezone());
      while (nextSchedule.getTime() <= now.getTime()) {
        nextSchedule = addMonthsSafely(nextSchedule, 1, this.getTimezone());
      }
      contact.hotspotLastReactivatedAt = now.toISOString();
      contact.hotspotReactivationAt = nextSchedule.toISOString();
      contact.mikrotikPassword = sanitizeInput(result?.password || contact.mikrotikPassword || "");
      contact.mikrotikProfile = sanitizeInput(result?.profile || contact.mikrotikProfile || "");
      contact.updatedAt = now.toISOString();
      if (typeof options.pendingNotificationBuilder === "function") {
        const pending = options.pendingNotificationBuilder(this.hydrateContact(contact));
        contact.hotspotNotificationPending = {
          id: generateId(),
          phoneNumber: normalizePhoneNumber(pending?.phoneNumber || contact.phoneNumber),
          message: sanitizeMultilineText(pending?.message),
          attempts: 0,
          createdAt: now.toISOString(),
          nextAttemptAt: now.toISOString(),
          lastError: null,
        };
        contact.hotspotNotificationLastStatus = "PENDING";
        contact.hotspotNotificationLastError = null;
      }

      await this.saveContacts(options);
      return this.hydrateContact(contact);
    });
  }

  async claimHotspotNotificationAttempt(contactId, notificationId) {
    return this.withDataMutation(async () => {
      const contact = this.getContact(contactId);
      if (!contact) throw new Error("Kontak tidak ditemukan.");
      const pending = contact.hotspotNotificationPending;
      if (!pending || (notificationId && String(pending.id) !== String(notificationId))) return null;

      const now = new Date().toISOString();
      contact.hotspotNotificationPending = null;
      contact.hotspotNotificationLastStatus = "SENDING";
      contact.hotspotNotificationLastError = null;
      contact.hotspotNotificationLastAttemptAt = now;
      contact.updatedAt = now;
      await this.saveContacts();
      return {
        contact: this.hydrateContact(contact),
        notification: { ...pending },
      };
    });
  }

  async completeHotspotNotificationAttempt(contactId, result = {}) {
    return this.withDataMutation(async () => {
      const contact = this.getContact(contactId);
      if (!contact) throw new Error("Kontak tidak ditemukan.");

      const now = new Date().toISOString();
      contact.hotspotNotificationLastStatus = result.sent ? "SENT" : "FAILED";
      contact.hotspotNotificationLastError = result.sent
        ? null
        : sanitizeInput(result.error || "Pengiriman notifikasi gagal");
      contact.hotspotNotificationLastAttemptAt = now;
      contact.updatedAt = now;
      await this.saveContacts();
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
        const dueAt = new Date(reminder.nextDeliveryAttemptAt || reminder.reminderDateTime).getTime();
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

      const relatedReminderIds = Array.from(this.reminders.values())
        .filter((reminder) => String(reminder.contactId) === String(contact.id) || reminder.phoneNumber === contact.phoneNumber)
        .map((reminder) => String(reminder.id));

      for (const reminderId of relatedReminderIds) {
        this.reminders.delete(reminderId);
      }

      await this.withDatabaseWrite(() => this.sequelize.transaction(async (transaction) => {
        const options = { transaction };
        await this.saveContacts(options);
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
      if (!message) throw new Error("Isi reminder wajib diisi.");
      if (Number.isNaN(reminderDate.getTime())) throw new Error("Tanggal reminder tidak valid.");

      const reminder = {
        id: generateId(),
        contactId: String(contact.id),
        contactName: contact.name,
        phoneNumber: contact.phoneNumber,
        paymentAmount: Math.max(0, Number(contact.monthlyPaymentAmount) || 0),
        reminderDateTime: reminderDate.toISOString(),
        message,
        templateName: payload.templateName ? sanitizeInput(payload.templateName) : null,
        createdAt: new Date().toISOString(),
      };

      this.reminders.set(reminder.id, reminder);
      await this.saveReminders();
      return this.hydrateReminder(reminder);
    });
  }

  async updateReminder(id, payload) {
    return this.withDataMutation(async () => {
      const reminder = this.getReminder(id);
      if (!reminder) throw new Error("Reminder tidak ditemukan.");
      if (reminder.processingAt) throw new Error("Reminder sedang diproses scheduler.");

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

      if (payload.paymentAmount !== undefined) {
        const paymentAmount = Number(payload.paymentAmount);
        if (!Number.isFinite(paymentAmount) || paymentAmount < 0 || paymentAmount > 1_000_000_000) {
          throw new Error("Nominal reminder harus antara 0 sampai 1 miliar.");
        }
        reminder.paymentAmount = Math.floor(paymentAmount);
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
    });
  }

  async deleteReminder(id) {
    return this.withDataMutation(async () => {
      const reminder = this.getReminder(id);
      if (!reminder) throw new Error("Reminder tidak ditemukan.");
      if (reminder.processingAt) throw new Error("Reminder sedang diproses scheduler.");
      this.reminders.delete(String(id));
      await this.saveReminders();
      return reminder;
    });
  }

  async claimDueReminder(id, now = new Date()) {
    return this.withDataMutation(async () => {
      const reminder = this.getReminder(id);
      if (!reminder) return null;

      const reminderTime = new Date(reminder.nextDeliveryAttemptAt || reminder.reminderDateTime).getTime();
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
    delete settings.monthlyPaymentAmount;
    return settings;
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
      this.settings = {
        ...current,
        dashboardTitle: payload.dashboardTitle !== undefined ? sanitizeInput(payload.dashboardTitle) || current.dashboardTitle : current.dashboardTitle,
        companyName: payload.companyName !== undefined ? sanitizeInput(payload.companyName) || current.companyName : current.companyName,
        supportSignature: payload.supportSignature !== undefined ? sanitizeInput(payload.supportSignature) || current.supportSignature : current.supportSignature,
        apDownMessageTemplate: payload.apDownMessageTemplate !== undefined
          ? sanitizeMultilineText(payload.apDownMessageTemplate) || current.apDownMessageTemplate
          : current.apDownMessageTemplate,
        hotspotReactivationMessageTemplate: payload.hotspotReactivationMessageTemplate !== undefined
          ? sanitizeMultilineText(payload.hotspotReactivationMessageTemplate) || current.hotspotReactivationMessageTemplate
          : current.hotspotReactivationMessageTemplate,
        paymentMessageTemplateArrearsOnly: payload.paymentMessageTemplateArrearsOnly !== undefined
          ? sanitizeMultilineText(payload.paymentMessageTemplateArrearsOnly) || current.paymentMessageTemplateArrearsOnly
          : current.paymentMessageTemplateArrearsOnly,
        paymentMessageTemplateCurrentOnly: payload.paymentMessageTemplateCurrentOnly !== undefined
          ? sanitizeMultilineText(payload.paymentMessageTemplateCurrentOnly) || current.paymentMessageTemplateCurrentOnly
          : current.paymentMessageTemplateCurrentOnly,
        paymentMessageTemplateFullPaid: payload.paymentMessageTemplateFullPaid !== undefined
          ? sanitizeMultilineText(payload.paymentMessageTemplateFullPaid) || current.paymentMessageTemplateFullPaid
          : current.paymentMessageTemplateFullPaid,
        apDownMinimumDownMinutes: payload.apDownMinimumDownMinutes !== undefined
          ? sanitizePositiveInteger(
              payload.apDownMinimumDownMinutes,
              current.apDownMinimumDownMinutes || current.apDownConfirmationChecks || DEFAULT_SETTINGS.apDownMinimumDownMinutes,
              1,
              120
            )
          : (current.apDownMinimumDownMinutes || current.apDownConfirmationChecks || DEFAULT_SETTINGS.apDownMinimumDownMinutes),
        timezone: requestedTimezone,
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
        mikrotikBackupLastRunDate: payload.mikrotikBackupLastRunDate !== undefined
          ? sanitizeInput(payload.mikrotikBackupLastRunDate)
          : current.mikrotikBackupLastRunDate,
        databaseBackupLastRunDate: current.databaseBackupLastRunDate,
      };
      await this.saveSettings();
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
      debtPeriods: (contact.debtPeriods || []).map((period) => period.label).join(", ") || "-",
      dueDate: formatReportDate(contact.dueDate, false, timeZone),
      dueStatus: {
        PAID: "Lunas",
        OVERDUE: "Jatuh Tempo",
        UPCOMING: "Belum Jatuh Tempo",
        NOT_SCHEDULED: "Belum Dijadwalkan",
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
      { header: "Tanggal Dibayar", key: "paidDate" },
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
          paidDate: formatReportDate(payment.paidDate, true, timeZone),
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

  async updatePaymentStatus(contactId, status, paymentType = null) {
    return this.withDataMutation(async () => {
      const contact = this.getContact(contactId);
      if (!contact) throw new Error("Kontak tidak ditemukan.");
      ({ status, paymentType } = this.normalizePaymentSelection(status, paymentType));

      const now = new Date();
      const timeZone = this.getTimezone();
      const { year, month } = getBillingPeriodParts(now, timeZone);
      const currentKey = makeBillingPeriodKey(year, month);
      const previous = getPreviousBillingPeriod(year, month);
      if (!contact.paymentMonths || typeof contact.paymentMonths !== "object") {
        contact.paymentMonths = {};
      }
      const arrearsDebtPeriod = paymentType === PAYMENT_TYPES.ARREARS_ONLY
        ? this.buildDebtInfo(contact, { year, month }).debtPeriods?.[0]
        : null;
      if (paymentType === PAYMENT_TYPES.ARREARS_ONLY && !arrearsDebtPeriod) {
        throw new Error("Kontak tidak memiliki tunggakan yang belum dibayar.");
      }

      contact.paymentStatus = status;
      contact.paymentDate = status === PAYMENT_STATUS.PAID ? now.toISOString() : null;
      contact.paymentType = paymentType || null;

      if (paymentType === PAYMENT_TYPES.FULL_PAID) {
        const startPeriod = getContactBillingStartPeriod(contact, timeZone);
        for (const period of listBillingPeriods(startPeriod, previous)) {
          contact.paymentMonths[makeBillingPeriodKey(period.year, period.month)] = {
            status: PAYMENT_STATUS.PAID,
            paidDate: now.toISOString(),
            paymentType,
          };
        }
      } else if (paymentType === PAYMENT_TYPES.ARREARS_ONLY) {
        contact.paymentMonths[arrearsDebtPeriod.key] = {
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
    });
  }

  async setPaymentForMonth(contactId, year, month, status, paymentType = null) {
    return this.withDataMutation(async () => {
      const contact = this.getContact(contactId);
      if (!contact) throw new Error("Kontak tidak ditemukan.");
      if (!Number.isInteger(year) || year < 2000 || year > 2100 || !Number.isInteger(month) || month < 1 || month > 12) {
        throw new Error("Periode pembayaran tidak valid.");
      }
      ({ status, paymentType } = this.normalizePaymentSelection(status, paymentType));

      if (!contact.paymentMonths) {
        contact.paymentMonths = {};
      }

      const key = `${year}-${String(month).padStart(2, "0")}`;
      const now = new Date();
      const timeZone = this.getTimezone();
      const previous = getPreviousBillingPeriod(year, month);
      const arrearsDebtPeriod = paymentType === PAYMENT_TYPES.ARREARS_ONLY
        ? this.buildDebtInfo(contact, { year, month }).debtPeriods?.[0]
        : null;
      if (paymentType === PAYMENT_TYPES.ARREARS_ONLY && !arrearsDebtPeriod) {
        throw new Error("Kontak tidak memiliki tunggakan yang belum dibayar.");
      }

      if (paymentType === PAYMENT_TYPES.FULL_PAID) {
        const startPeriod = getContactBillingStartPeriod(contact, timeZone);
        for (const period of listBillingPeriods(startPeriod, previous)) {
          contact.paymentMonths[makeBillingPeriodKey(period.year, period.month)] = {
            status: PAYMENT_STATUS.PAID,
            paidDate: now.toISOString(),
            paymentType,
          };
        }
      } else if (paymentType === PAYMENT_TYPES.ARREARS_ONLY) {
        contact.paymentMonths[arrearsDebtPeriod.key] = {
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

      const { year: currentYear, month: currentMonth } = getBillingPeriodParts(now, timeZone);
      if (year === currentYear && month === currentMonth) {
        contact.paymentStatus = status;
        contact.paymentDate = status === PAYMENT_STATUS.PAID ? now.toISOString() : null;
        contact.paymentType = paymentType || null;
      }
      contact.updatedAt = now.toISOString();

      await this.saveContacts();
      return this.hydrateContact(contact);
    });
  }

  inferPaymentType(contact, options = {}) {
    const paymentMonths = contact.paymentMonths || {};
    const currentPeriod = getBillingPeriodParts(new Date(), this.getTimezone());
    const year = options.year ?? currentPeriod.year;
    const month = options.month ?? currentPeriod.month;
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
    const currentKey = getBillingPeriodKey(new Date(), this.getTimezone());

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

    if (resetCount > 0 && options.save !== false) {
      await this.saveContacts();
    }

    return resetCount;
  }

  synchronizeCurrentPaymentStatus() {
    const currentKey = getBillingPeriodKey(new Date(), this.getTimezone());
    let changed = 0;

    for (const contact of this.contacts.values()) {
      const currentPayment = contact.paymentMonths?.[currentKey];
      const isPaid = currentPayment?.status === PAYMENT_STATUS.PAID;
      const nextStatus = isPaid ? PAYMENT_STATUS.PAID : PAYMENT_STATUS.UNPAID;
      const nextPaymentDate = isPaid ? currentPayment.paidDate || null : null;
      const nextPaymentType = isPaid ? currentPayment.paymentType || null : null;

      if (contact.paymentStatus !== nextStatus
        || contact.paymentDate !== nextPaymentDate
        || contact.paymentType !== nextPaymentType) {
        contact.paymentStatus = nextStatus;
        contact.paymentDate = nextPaymentDate;
        contact.paymentType = nextPaymentType;
        contact.updatedAt = new Date().toISOString();
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
        this.settings.lastPaymentResetPeriod = currentPeriod;
        await this.withDatabaseWrite(() => this.sequelize.transaction(async (transaction) => {
          const options = { transaction };
          if (synchronized > 0) await this.saveContacts(options);
          await this.saveSettings(options);
        }));
        return { reset: false, initialized: true, period: currentPeriod, count: synchronized };
      }

      if (settings.lastPaymentResetPeriod === currentPeriod) {
        return { reset: false, period: currentPeriod, count: 0 };
      }

      const count = await this.resetAllPaymentStatusUnlocked({ save: false });
      this.settings.lastPaymentResetPeriod = currentPeriod;
      await this.withDatabaseWrite(() => this.sequelize.transaction(async (transaction) => {
        const options = { transaction };
        await this.saveContacts(options);
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
    this.activityLog.push("info", "notification", `Pesan terkirim via ${result.provider} ke ${normalizePhoneNumber(phoneNumber)}`, {
      phoneNumber: normalizePhoneNumber(phoneNumber),
      provider: result.provider,
    });
    return result;
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
        await this.sendMessage(phoneNumber, message, options.messageOptions || {});
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

  async sendPaymentNotification(contact, transactionId, paymentType = "DEFAULT", options = {}) {
    const paymentDate = contact.paymentDate ? new Date(contact.paymentDate) : new Date();
    const formattedDate = paymentDate.toLocaleString("id-ID", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: this.dataManager.getTimezone(),
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

    const settings = this.dataManager.getSettings();
    let messageTemplate = sanitizeMultilineText(settings.paymentMessageTemplateCurrentOnly)
      || DEFAULT_SETTINGS.paymentMessageTemplateCurrentOnly;
    if (paymentType === PAYMENT_TYPES.ARREARS_ONLY) {
      messageTemplate = sanitizeMultilineText(settings.paymentMessageTemplateArrearsOnly)
        || DEFAULT_SETTINGS.paymentMessageTemplateArrearsOnly;
    } else if (paymentType === PAYMENT_TYPES.FULL_PAID) {
      messageTemplate = sanitizeMultilineText(settings.paymentMessageTemplateFullPaid)
        || DEFAULT_SETTINGS.paymentMessageTemplateFullPaid;
    }
    const companyName = sanitizeInput(settings.companyName) || "Emmeril Hotspot";
    const supportSignature = sanitizeInput(settings.supportSignature) || "CS Emmeril Hotspot";

    const message = messageTemplate
      .replace(/{{\s*name\s*}}/gi, contact.name || "-")
      .replace(/{{\s*transactionId\s*}}/gi, transactionId || "-")
      .replace(/{{\s*paymentDate\s*}}/gi, formattedDate)
      .replace(/{{\s*statusText\s*}}/gi, statusText)
      .replace(/{{\s*noteText\s*}}/gi, noteText)
      .replace(/{{\s*companyName\s*}}/gi, companyName)
      .replace(/{{\s*companyNameUpper\s*}}/gi, companyName.toUpperCase())
      .replace(/{{\s*supportSignature\s*}}/gi, supportSignature);

    await this.sendMessage(contact.phoneNumber, message, options);
    this.activityLog.push("info", "payment", `Notifikasi pembayaran terkirim ke ${contact.phoneNumber}`, {
      transactionId,
      contactId: contact.id,
    });
    return { phoneNumber: contact.phoneNumber, transactionId };
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

  async resetPairing() {
    const provider = await this.providerManager.currentProvider({ connect: false });
    if (provider.name !== "baileys" || typeof provider.resetPairing !== "function") {
      throw new Error("Reset pairing hanya tersedia untuk provider Baileys.");
    }
    await provider.resetPairing();
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
  constructor(notificationBot, dataManager, templateManager, activityLog, reminderScheduler, authManager, mikrotikService, hotspotReactivationScheduler) {
    this.app = express();
    this.app.set("trust proxy", CONFIG.TRUST_PROXY);
    this.notificationBot = notificationBot;
    this.dataManager = dataManager;
    this.templateManager = templateManager;
    this.activityLog = activityLog;
    this.reminderScheduler = reminderScheduler;
    this.authManager = authManager;
    this.mikrotikService = mikrotikService;
    this.hotspotReactivationScheduler = hotspotReactivationScheduler;
    this.setupRoutes();
  }

  setupRoutes() {
    this.app.use(express.json({ limit: "1mb" }));
    this.app.use(express.urlencoded({ extended: true, limit: "1mb" }));

    this.app.use((req, res, next) => {
      res.setHeader(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
      );
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("X-Frame-Options", "DENY");
      res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
      next();
    });

    this.app.use("/public", express.static(CONFIG.PUBLIC_PATH));
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
      const secureCookie = req.secure;
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
      const secureCookie = req.secure;
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
    this.app.post("/transport/reset-pairing", requirePageAuth, async (req, res) => {
      try {
        await this.notificationBot.resetPairing();
        this.activityLog.push("info", "notification", "Pairing Baileys direset tanpa restart aplikasi");
        return res.redirect("/transport?pairingReset=1");
      } catch (error) {
        this.activityLog.push("error", "notification", `Gagal mereset pairing Baileys: ${error.message}`);
        return res.redirect(`/transport?error=${encodeURIComponent(error.message)}`);
      }
    });
    this.app.post("/transport/enable-sending", requirePageAuth, async (req, res) => {
      try {
        this.notificationBot.enableOutbound();
        this.activityLog.push("info", "notification", "Pengiriman WhatsApp diaktifkan manual dari halaman transport");
        return res.redirect("/transport?sendingEnabled=1");
      } catch (error) {
        this.activityLog.push("error", "notification", `Gagal mengaktifkan pengiriman WhatsApp: ${error.message}`);
        return res.redirect(`/transport?error=${encodeURIComponent(error.message)}`);
      }
    });
    this.app.post("/transport/disable-sending", requirePageAuth, (req, res) => {
      this.notificationBot.disableOutbound();
      this.activityLog.push("info", "notification", "Pengiriman WhatsApp dijeda manual dari halaman transport");
      return res.redirect("/transport?sendingDisabled=1");
    });
    this.app.post("/transport/reconnect", requirePageAuth, async (_req, res) => {
      try {
        await this.notificationBot.reconnect();
        return res.redirect("/transport");
      } catch (error) {
        return res.redirect(`/transport?error=${encodeURIComponent(error.message)}`);
      }
    });
    this.app.get("/transport", requirePageAuth, async (req, res) => {
      const status = await this.notificationBot.getTransportStatus();
      if (status.deviceReady) {
        const sendingEnabled = req.query.sendingEnabled === "1";
        const sendingDisabled = req.query.sendingDisabled === "1";
        const error = sanitizeInput(req.query.error);
        return res.send(`
          <!doctype html>
          <html><body style="display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#f4f5ef;font-family:Georgia,serif;">
            <main style="width:min(92vw,520px);padding:28px 34px;border-radius:20px;background:white;box-shadow:0 20px 60px rgba(0,0,0,.12);color:#204b57;text-align:center;">
              <h1 style="margin:0 0 12px;font-size:1.5rem;">WhatsApp terhubung${status.account ? ` (${escapeHtml(status.account)})` : ""}</h1>
              ${sendingEnabled ? '<p style="padding:10px;border-radius:12px;background:#e6f4ea;color:#17603a;">Pengiriman WhatsApp sudah diaktifkan.</p>' : ""}
              ${sendingDisabled ? '<p style="padding:10px;border-radius:12px;background:#fff4ce;color:#775b00;">Pengiriman WhatsApp sudah dijeda.</p>' : ""}
              ${error ? `<p style="padding:10px;border-radius:12px;background:#fee2e2;color:#991b1b;">${escapeHtml(error)}</p>` : ""}
              <p style="margin:0 0 18px;line-height:1.6;">Status pengiriman: <strong>${status.outboundEnabled ? "AKTIF" : "DIJEDA"}</strong>.</p>
              ${status.outboundEnabled ? `
                <form method="post" action="/transport/disable-sending">
                  <button type="submit" style="padding:13px 20px;border:0;border-radius:999px;background:#9a3412;color:#fff;font-weight:700;cursor:pointer;">Jeda Pengiriman</button>
                </form>
              ` : `
                <p style="font:14px/1.6 sans-serif;color:#627773;">Pairing saja tidak akan mengirim pesan. Periksa antrean reminder sebelum mengaktifkan pengiriman.</p>
                <form method="post" action="/transport/enable-sending">
                  <button type="submit" style="padding:13px 20px;border:0;border-radius:999px;background:#176b5b;color:#fff;font-weight:700;cursor:pointer;">Aktifkan Pengiriman</button>
                </form>
              `}
            </main>
          </body></html>
        `);
      }

      if (status.whatsappProviderEnabled) {
        const qrDataUrl = status.currentQR
          ? await QRCode.toDataURL(status.currentQR, { width: 320, margin: 2, errorCorrectionLevel: "M" })
          : null;
        const pairingReset = req.query.pairingReset === "1";
        const error = sanitizeInput(req.query.error);
        return res.status(503).send(`
          <!doctype html>
          <html lang="id">
            <head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="5"><title>Hubungkan WhatsApp</title></head>
            <body style="margin:0;min-height:100vh;display:grid;place-items:center;background:radial-gradient(circle at top,#dcecdf,#f4f5ef 55%);font-family:Georgia,serif;color:#183f45;">
              <main style="width:min(92vw,520px);padding:28px;border-radius:24px;background:#fff;box-shadow:0 24px 70px rgba(24,63,69,.18);text-align:center;">
                <h1 style="margin:0 0 8px;font-size:1.8rem;">Pindai QR WhatsApp</h1>
                <p style="margin:0 0 20px;line-height:1.5;">${escapeHtml(status.transportError || "Buka Perangkat tertaut pada WhatsApp.")}</p>
                ${pairingReset ? '<p style="padding:10px;border-radius:12px;background:#e6f4ea;color:#17603a;font:600 14px/1.5 sans-serif;">Pairing direset. QR baru sedang disiapkan.</p>' : ""}
                ${error ? `<p style="padding:10px;border-radius:12px;background:#fee2e2;color:#991b1b;font:600 14px/1.5 sans-serif;">${escapeHtml(error)}</p>` : ""}
                ${qrDataUrl ? `<img src="${qrDataUrl}" alt="QR pairing WhatsApp" width="320" height="320" style="max-width:100%;height:auto;border-radius:16px;">` : ""}
                ${qrDataUrl ? "" : `
                  <div style="margin:18px 0;padding:16px;border-radius:16px;background:#f4f5ef;font:14px/1.6 sans-serif;color:#627773;">
                    QR belum tersedia atau socket sedang macet. Buat QR baru tanpa me-restart aplikasi.
                  </div>
                  <form method="post" action="/transport/reset-pairing" style="margin:0;">
                    <button type="submit" style="padding:13px 20px;border:0;border-radius:999px;background:#176b5b;color:#fff;font:700 14px/1 sans-serif;cursor:pointer;">Buat QR Baru</button>
                  </form>
                `}
                <p style="margin:18px 0 0;font:14px/1.6 sans-serif;color:#627773;">Di WhatsApp buka <strong>Perangkat tertaut</strong>, pilih <strong>Tautkan perangkat</strong>, lalu pindai QR. Koneksi melalui nomor atau pairing code dinonaktifkan.</p>
                <p style="margin:10px 0 0;font:13px/1.5 sans-serif;color:#879895;">Halaman diperbarui otomatis setiap 5 detik.</p>
              </main>
            </body>
          </html>
        `);
      }

      return res.send("Baileys dinonaktifkan. Aktifkan BAILEYS_ENABLED pada environment.");
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
        this.activityLog.push("info", "manual", `WhatsApp test message sent to ${phoneNumber}`, {
          event: "whatsapp.message.sent",
          provider: result.provider,
        });
        return { type: "message", phoneNumber, ...result };
      }
      return { type: "connection", ...(await this.notificationBot.testConnection()) };
    }));

    this.app.get("/api/logs", requireApiAuth, handleApi(async () => this.activityLog.list()));

    this.app.get("/api/contacts", requireApiAuth, handleApi(async () => this.dataManager.getSortedContacts().map((contact) => this.dataManager.toPublicContact(contact))));
    this.app.post("/api/contacts", requireApiAuth, handleApi(async (req) => this.dataManager.toPublicContact(await this.dataManager.addContact(req.body))));
    this.app.put("/api/contacts/:id", requireApiAuth, handleApi(async (req) => this.dataManager.toPublicContact(await this.dataManager.updateContact(req.params.id, req.body))));
    this.app.delete("/api/contacts/:id", requireApiAuth, handleApi(async (req) => this.dataManager.deleteContact(req.params.id)));

    this.app.get("/api/mikrotik/profiles", requireApiAuth, handleApi(async () => this.mikrotikService.getHotspotProfiles()));
    this.app.get("/api/mikrotik/hotspot-users", requireApiAuth, handleApi(async () => this.mikrotikService.getHotspotUsers()));
    this.app.get("/api/mikrotik/netwatch", requireApiAuth, handleApi(async () => this.mikrotikService.getNetwatchStatus()));
    this.app.post("/api/contacts/:id/hotspot/reactivate", requireApiAuth, handleApi(async (req) => {
      const contact = this.dataManager.getContact(req.params.id);
      if (!contact) throw new Error("Kontak tidak ditemukan.");
      const result = await this.hotspotReactivationScheduler.reactivateContact(this.dataManager.hydrateContact(contact));
      return {
        ...result,
        contact: this.dataManager.toPublicContact(result.contact),
        password: undefined,
      };
    }));
    this.app.post("/api/hotspot/reactivations/run", requireApiAuth, handleApi(async () => this.hotspotReactivationScheduler.processDueReactivations()));
    this.app.post("/api/mikrotik/customers", requireApiAuth, handleApi(async (req) => {
      const registered = await this.mikrotikService.createHotspotCustomer({
        name: req.body.name,
        phoneNumber: req.body.phoneNumber,
        profile: req.body.profile,
      });

      let persisted;
      try {
        persisted = await this.dataManager.upsertPelangganFromRegistration({
          ...registered,
          linkedApHost: req.body.linkedApHost,
          hotspotReactivationEnabled: req.body.hotspotReactivationEnabled,
          hotspotReactivationAt: req.body.hotspotReactivationAt,
        });
      } catch (error) {
        await this.mikrotikService.deleteHotspotUser(registered.username).catch((rollbackError) => {
          this.activityLog.push("error", "mikrotik", `Rollback user ${registered.username} gagal: ${rollbackError.message}`);
        });
        throw error;
      }

      let notification = { sent: false };
      if (parseBoolean(req.body.sendCredentials) && this.notificationBot.getStatus().whatsappProviderEnabled) {
        const message = `Yth. Bapak/Ibu *${registered.name}*,\n\nAkun hotspot Anda sudah berhasil dibuat.\n\nDetail Akun Hotspot:\n*Username:* ${registered.username}\n*Password:* ${registered.password}\n*Profile:* ${registered.profile}\n\nSilakan simpan data ini. Terimakasih.`;
        try {
          await this.notificationBot.sendMessage(registered.phoneNumber, message);
          notification = { sent: true };
        } catch (error) {
          notification = { sent: false, error: error.message };
        }
      } else if (parseBoolean(req.body.sendCredentials)) {
        notification = { sent: false, error: "Transport notifikasi belum online." };
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
    this.app.post("/api/mikrotik/backup/send", requireApiAuth, handleApi(async () => {
      if (!TelegramManager.isConfigured()) {
        throw new Error("Transport backup Telegram belum siap. Isi TELEGRAM_BOT_TOKEN dan TELEGRAM_CHAT_IDS.");
      }

      const recipients = TelegramManager.getChatIds();
      if (recipients.length === 0) {
        throw new Error("TELEGRAM_CHAT_IDS masih kosong.");
      }

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
    }));

    this.app.post("/api/contacts/:id/payment", requireApiAuth, handleApi(async (req) => {
      const status = sanitizeInput(req.body.status).toUpperCase();
      const requestedPaymentType = sanitizeInput(req.body.paymentType).toUpperCase();
      const paymentType = requestedPaymentType || null;
      const updatedContact = await this.dataManager.updatePaymentStatus(req.params.id, status, paymentType);
      const effectivePaymentType = updatedContact.paymentType;
      const shouldSendPaymentNotification = status === PAYMENT_STATUS.PAID || effectivePaymentType === PAYMENT_TYPES.ARREARS_ONLY;

      if (!shouldSendPaymentNotification) {
        return {
          contact: this.dataManager.toPublicContact(updatedContact),
          notificationSent: false,
        };
      }

      const transactionId = `TRX-${Date.now()}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
      try {
        await this.notificationBot.sendPaymentNotification(updatedContact, transactionId, effectivePaymentType);
        return {
          contact: this.dataManager.toPublicContact(updatedContact),
          transactionId,
          paymentType: effectivePaymentType,
          notificationSent: true,
        };
      } catch (error) {
        this.activityLog.push("error", "payment", `Status paid tersimpan tapi notifikasi gagal dikirim ke ${updatedContact.phoneNumber}`, {
          error: error.message,
          transactionId,
          contactId: updatedContact.id,
        });

        return {
          contact: this.dataManager.toPublicContact(updatedContact),
          transactionId,
          notificationSent: false,
          notificationError: error.message,
        };
      }
    }));

    this.app.post("/api/contacts/:id/payment-amount", requireApiAuth, handleApi(async (req) => {
      const contact = await this.dataManager.updateContactPaymentAmount(
        req.params.id,
        req.body.monthlyPaymentAmount
      );
      return this.dataManager.toPublicContact(contact);
    }));

    this.app.post("/api/contacts/:id/payment-month", requireApiAuth, handleApi(async (req) => {
      const year = Number(req.body.year);
      const month = Number(req.body.month);
      const status = sanitizeInput(req.body.status).toUpperCase();
      const paymentType = sanitizeInput(req.body.paymentType).toUpperCase();
      const updated = await this.dataManager.setPaymentForMonth(
        req.params.id,
        year,
        month,
        status,
        paymentType || null
      );
      return this.dataManager.toPublicContact(updated);
    }));

    this.app.get("/api/reminders", requireApiAuth, handleApi(async () => this.dataManager.getSortedReminders()));
    this.app.post("/api/reminders", requireApiAuth, handleApi(async (req) => {
      const when = parseDateTimeInput(req.body.reminderDateTime, this.dataManager.getTimezone());
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
        const when = parseDateTimeInput(payload.reminderDateTime, this.dataManager.getTimezone());
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
            date: new Date().toLocaleDateString("id-ID", { timeZone: this.dataManager.getTimezone() }),
          }),
      });
    }));

    this.app.post("/api/scheduler/run", requireApiAuth, handleApi(async () => {
      await this.reminderScheduler.processDueReminders();
      return { queued: true };
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
    this.app.listen(CONFIG.PORT, CONFIG.HOST, () => {
      this.activityLog.push("info", "web", `Dashboard running at http://${CONFIG.HOST}:${CONFIG.PORT}/dashboard`);
      this.activityLog.push("info", "web", `WhatsApp provider status page running at http://${CONFIG.HOST}:${CONFIG.PORT}/transport`);
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
    activityLog,
    notificationBot
  );

  await dataManager.loadAll();

  const reminderScheduler = new ReminderScheduler(notificationBot, dataManager, activityLog);
  const webServer = new WebServer(
    notificationBot,
    dataManager,
    templateManager,
    activityLog,
    reminderScheduler,
    authManager,
    mikrotikService,
    hotspotReactivationScheduler
  );

  await sendMonthlyResetNotification(notificationBot, dataManager, activityLog);

  cron.schedule(CONFIG.CRON_SCHEDULE, () => {
    void runScheduledTasks([
      { name: "reminders", run: () => reminderScheduler.processDueReminders() },
      { name: "ap-monitor", run: () => apDownNotifier.processNetwatchChanges() },
      { name: "whatsapp-provider-status", run: () => whatsappProviderStatusNotifier.processStatusChanges() },
      { name: "mikrotik-backup", run: () => mikrotikBackupScheduler.processDailyBackup() },
      { name: "database-backup", run: () => databaseBackupScheduler.processDailyBackup() },
      { name: "hotspot-reactivation", run: () => hotspotReactivationScheduler.processDueReactivations() },
      { name: "monthly-payment-reset", run: () => sendMonthlyResetNotification(notificationBot, dataManager, activityLog) },
    ], activityLog);
  });

  cron.schedule(CONFIG.SENT_HISTORY_CLEANUP_SCHEDULE, () => {
    dataManager.cleanupSentHistory().catch((error) => {
      activityLog.push("error", "storage", `Sent History auto-clean failed: ${error.message}`);
    });
  });

  setInterval(() => {
    dataManager.saveAll().catch((error) => {
      activityLog.push("error", "storage", `Auto-save failed: ${error.message}`);
    });
  }, CONFIG.AUTO_SAVE_INTERVAL);

  setInterval(() => {
    authManager.cleanupExpiredSessions();
  }, 60 * 60 * 1000);

  process.on("SIGINT", async () => {
    activityLog.push("info", "shutdown", "Saving data before shutdown");
    await notificationBot.shutdown();
    await dataManager.saveAll();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    activityLog.push("info", "shutdown", "Saving data before shutdown");
    await notificationBot.shutdown();
    await dataManager.saveAll();
    process.exit(0);
  });

  process.on("uncaughtException", async (error) => {
    activityLog.push("error", "runtime", `Uncaught exception: ${error.message}`);
    await notificationBot.shutdown();
    await dataManager.saveAll();
    process.exit(1);
  });

  process.on("unhandledRejection", async (reason) => {
    const message = reason instanceof Error ? reason.message : String(reason);
    activityLog.push("error", "runtime", `Unhandled rejection: ${message}`);
    await notificationBot.shutdown();
    await dataManager.saveAll();
    process.exit(1);
  });

  webServer.start();
  notificationBot.initialize()
    .then(() => activityLog.push("info", "notification", "Notification transport initialized"))
    .catch((error) => {
      activityLog.push("error", "notification", `Initial notification startup failed: ${error.message}`);
    });
}

module.exports = {
  DataManager,
  MikrotikService,
  NotificationBot,
  WebServer,
  bootstrap,
  runScheduledTasks,
};
