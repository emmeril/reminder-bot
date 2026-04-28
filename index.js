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

const CONFIG = {
  PORT: Number(process.env.PORT || 3025),
  DB_PATH: path.join(__dirname, "database"),
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

const DEFAULT_SETTINGS = {
  dashboardTitle: "Reminder Bot Control Center",
  companyName: "Emmeril Hotspot",
  supportSignature: "CS Emmeril Hotspot",
  timezone: "Asia/Jakarta",
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

function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader) return cookies;

  for (const part of String(cookieHeader).split(";")) {
    const [rawKey, ...rawValue] = part.trim().split("=");
    if (!rawKey) continue;
    cookies[rawKey] = decodeURIComponent(rawValue.join("=") || "");
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

function normalizePhoneNumber(value) {
  return sanitizeInput(String(value || "")).replace(/[^0-9]/g, "");
}

function isValidPhoneNumber(value) {
  return /^628\d{7,13}$/.test(value);
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
    return username === CONFIG.AUTH_USERNAME && password === CONFIG.AUTH_PASSWORD;
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

class DataManager {
  constructor(activityLog) {
    this.activityLog = activityLog;
    this.contacts = new Map();
    this.reminders = new Map();
    this.sentReminders = new Map();
    this.roles = new Map();
    this.settings = { ...DEFAULT_SETTINGS };
    this.fileLocks = new Map();
    this.initDirectories();
  }

  async initDirectories() {
    await fs.mkdir(CONFIG.DB_PATH, { recursive: true });
    await fs.mkdir(CONFIG.TEMPLATE_PATH, { recursive: true });
    await fs.mkdir(CONFIG.PUBLIC_PATH, { recursive: true });
  }

  getPath(filename) {
    return path.join(CONFIG.DB_PATH, filename);
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

  async loadMapFromFile(filePath, keyField) {
    try {
      const raw = await fs.readFile(filePath, "utf-8");
      if (!raw.trim()) return new Map();
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return new Map();
      return new Map(arr.filter((item) => item && item[keyField]).map((item) => [String(item[keyField]), item]));
    } catch (error) {
      if (error.code === "ENOENT") return new Map();
      this.activityLog.push("error", "storage", `Failed to load ${path.basename(filePath)}`, { error: error.message });
      try {
        const backup = `${filePath}.bak`;
        await fs.copyFile(backup, filePath);
        return this.loadMapFromFile(filePath, keyField);
      } catch {
        return new Map();
      }
    }
  }

  async loadRoles() {
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

  async loadSettings() {
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

  async loadAll() {
    this.activityLog.push("info", "boot", "Loading persisted data");
    this.contacts = await this.loadMapFromFile(this.getPath("contacts.json"), "id");
    this.reminders = await this.loadMapFromFile(this.getPath("reminders.json"), "id");
    this.sentReminders = await this.loadMapFromFile(this.getPath("sent_reminders.json"), "id");
    this.roles = await this.loadRoles();
    this.settings = await this.loadSettings();
    await this.normalizeReminderRelations();
    this.activityLog.push("info", "boot", "Data load complete", {
      contacts: this.contacts.size,
      reminders: this.reminders.size,
      sentReminders: this.sentReminders.size,
      adminRecipients: this.getAdminRecipients().length,
    });
  }

  async saveContacts() {
    await this.atomicWrite(this.getPath("contacts.json"), Array.from(this.contacts.values()));
  }

  async saveReminders() {
    await this.atomicWrite(this.getPath("reminders.json"), Array.from(this.reminders.values()));
  }

  async saveSentReminders() {
    await this.atomicWrite(this.getPath("sent_reminders.json"), Array.from(this.sentReminders.values()));
  }

  async saveRoles() {
    await this.atomicWrite(this.getPath("roles.json"), Object.fromEntries(this.roles));
  }

  async saveSettings() {
    await this.atomicWrite(this.getPath("settings.json"), this.settings);
  }

  async saveAll() {
    await Promise.all([
      this.saveContacts(),
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

    const files = [
      "contacts.json",
      "reminders.json",
      "sent_reminders.json",
      "roles.json",
      "settings.json",
    ];

    await Promise.all(
      files.map(async (file) => {
        const src = this.getPath(file);
        const dest = path.join(backupDir, file);
        await fs.copyFile(src, dest).catch(() => {});
      })
    );

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
      autoRescheduleMonthly: payload.autoRescheduleMonthly !== undefined ? Boolean(payload.autoRescheduleMonthly) : current.autoRescheduleMonthly,
      notifyAdminsOnDelivery: payload.notifyAdminsOnDelivery !== undefined ? Boolean(payload.notifyAdminsOnDelivery) : current.notifyAdminsOnDelivery,
      notifyAdminsOnConnectionChange: payload.notifyAdminsOnConnectionChange !== undefined ? Boolean(payload.notifyAdminsOnConnectionChange) : current.notifyAdminsOnConnectionChange,
      notifyAdminsOnPaymentReset: payload.notifyAdminsOnPaymentReset !== undefined ? Boolean(payload.notifyAdminsOnPaymentReset) : current.notifyAdminsOnPaymentReset,
    };
    await this.saveSettings();
    return this.getSettings();
  }

  getContactsByStatus(status) {
    return this.getSortedContacts().filter((contact) => contact.paymentStatus === status);
  }

  getPaymentsByMonth(year, month) {
    return this.getSortedContacts().filter((contact) => {
      if (!contact.paymentDate) return false;
      const paidDate = new Date(contact.paymentDate);
      return paidDate.getFullYear() === year && paidDate.getMonth() + 1 === month;
    });
  }

  getAllPaymentsHistory() {
    const history = {};
    for (const contact of this.contacts.values()) {
      if (!contact.paymentDate) continue;
      const paidDate = new Date(contact.paymentDate);
      const key = `${paidDate.getFullYear()}-${String(paidDate.getMonth() + 1).padStart(2, "0")}`;
      if (!history[key]) {
        history[key] = { contacts: [], total: 0 };
      }
      history[key].contacts.push(contact);
      history[key].total += 1;
    }
    return history;
  }

  getPaymentMonthStatus(contactId) {
    const contact = this.getContact(contactId);
    return contact?.paymentMonths || {};
  }

  async updatePaymentStatus(contactId, status) {
    const contact = this.getContact(contactId);
    if (!contact) throw new Error("Kontak tidak ditemukan.");
    if (![PAYMENT_STATUS.PAID, PAYMENT_STATUS.UNPAID].includes(status)) {
      throw new Error("Status pembayaran tidak valid.");
    }

    contact.paymentStatus = status;
    contact.paymentDate = status === PAYMENT_STATUS.PAID ? new Date().toISOString() : null;
    await this.saveContacts();
    return contact;
  }

  async setPaymentForMonth(contactId, year, month, status) {
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
    };

    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth() + 1;
    if (year === currentYear && month === currentMonth) {
      contact.paymentStatus = status;
      contact.paymentDate = status === PAYMENT_STATUS.PAID ? new Date().toISOString() : null;
    }

    await this.saveContacts();
    return contact;
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
    for (const contact of this.contacts.values()) {
      if (contact.paymentStatus === PAYMENT_STATUS.PAID) {
        contact.paymentStatus = PAYMENT_STATUS.UNPAID;
        contact.paymentDate = null;
        resetCount += 1;
      }
    }

    if (resetCount > 0) {
      await this.saveContacts();
    }

    return resetCount;
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

    const message = `*${title}*\n\n${body}`;
    const results = [];

    for (const contact of contacts) {
      try {
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
      noteText = "Pembayaran tunggakan telah kami terima. Catatan: Bulan ini masih belum lunas.";
    } else if (paymentType === "CURRENT-ONLY") {
      noteText = "Pembayaran bulan ini telah kami terima. Namun Anda masih memiliki tunggakan bulan sebelumnya. Silakan lunasi agar layanan tidak terputus.";
    } else if (paymentType === "FULL-PAID") {
      noteText = "Semua tagihan (tunggakan + bulan ini) telah lunas. Terima kasih atas kelancarannya!";
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
    if (!this.isReady && title !== "Perubahan status bot") return [];
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
  constructor(notificationBot, dataManager, templateManager, activityLog, reminderScheduler, authManager) {
    this.app = express();
    this.notificationBot = notificationBot;
    this.dataManager = dataManager;
    this.templateManager = templateManager;
    this.activityLog = activityLog;
    this.reminderScheduler = reminderScheduler;
    this.authManager = authManager;
    this.setupRoutes();
  }

  setupRoutes() {
    this.app.use(express.json({ limit: "1mb" }));
    this.app.use(express.urlencoded({ extended: true }));
    this.app.use("/public", express.static(CONFIG.PUBLIC_PATH));

    const hasApiKeyAccess = (req) => {
      const apiKey = req.headers["x-api-key"] || req.query.api_key;
      return Boolean(apiKey && apiKey === CONFIG.WEB_API_KEY);
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
          res.status(400).json({ success: false, error: error.message });
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
        res.status(401);
        throw new Error("Username atau password salah.");
      }

      const { token, session } = this.authManager.createSession(username);
      res.setHeader("Set-Cookie", serializeCookie(CONFIG.SESSION_COOKIE_NAME, token, {
        path: "/",
        httpOnly: true,
        sameSite: "Lax",
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
      res.setHeader("Set-Cookie", serializeCookie(CONFIG.SESSION_COOKIE_NAME, "", {
        path: "/",
        httpOnly: true,
        sameSite: "Lax",
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
      scheduler: { isProcessing: this.reminderScheduler.isProcessing },
    })));

    this.app.get("/api/logs", requireApiAuth, handleApi(async () => this.activityLog.list()));

    this.app.get("/api/contacts", requireApiAuth, handleApi(async () => this.dataManager.getSortedContacts()));
    this.app.post("/api/contacts", requireApiAuth, handleApi(async (req) => this.dataManager.addContact(req.body)));
    this.app.put("/api/contacts/:id", requireApiAuth, handleApi(async (req) => this.dataManager.updateContact(req.params.id, req.body)));
    this.app.delete("/api/contacts/:id", requireApiAuth, handleApi(async (req) => this.dataManager.deleteContact(req.params.id)));

    this.app.post("/api/contacts/:id/payment", requireApiAuth, handleApi(async (req) => {
      const status = sanitizeInput(req.body.status).toUpperCase();
      const updatedContact = await this.dataManager.updatePaymentStatus(req.params.id, status);

      if (status !== PAYMENT_STATUS.PAID) {
        return {
          contact: updatedContact,
          notificationSent: false,
        };
      }

      const transactionId = `TRX-${Date.now()}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;

      try {
        await this.notificationBot.sendPaymentNotification(updatedContact, transactionId);
        return {
          contact: updatedContact,
          transactionId,
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
      if (!year || !month) throw new Error("Year dan month wajib diisi.");
      return this.dataManager.setPaymentForMonth(req.params.id, year, month, status);
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
      const phoneNumber = normalizePhoneNumber(req.body.phoneNumber);
      const message = sanitizeMultilineText(req.body.message);
      if (!isValidPhoneNumber(phoneNumber)) throw new Error("Nomor tujuan tidak valid.");
      if (!message) throw new Error("Pesan notifikasi wajib diisi.");
      await this.notificationBot.sendMessage(phoneNumber, message);
      this.activityLog.push("info", "manual", `Manual notification sent to ${phoneNumber}`);
      return { phoneNumber, status: "sent" };
    }));

    this.app.post("/api/notifications/admin-broadcast", requireApiAuth, handleApi(async (req) => {
      const title = sanitizeInput(req.body.title) || "Status Bot";
      const body = sanitizeMultilineText(req.body.message);
      if (!body) throw new Error("Pesan broadcast wajib diisi.");
      return this.notificationBot.sendAdminBroadcast(title, body);
    }));

    this.app.post("/api/notifications/broadcast", requireApiAuth, handleApi(async (req) => {
      const title = sanitizeInput(req.body.title) || "Pengumuman";
      const body = sanitizeMultilineText(req.body.message);
      if (!body) throw new Error("Pesan broadcast wajib diisi.");
      return this.notificationBot.sendContactBroadcast(title, body);
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
  const count = await dataManager.resetAllPaymentStatus();
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
  const authManager = new AuthManager(activityLog);
  const dataManager = new DataManager(activityLog);
  const templateManager = new TemplateManager(activityLog);
  const notificationBot = new NotificationBot(dataManager, activityLog);

  await dataManager.loadAll();

  const reminderScheduler = new ReminderScheduler(notificationBot, dataManager, activityLog);
  const webServer = new WebServer(
    notificationBot,
    dataManager,
    templateManager,
    activityLog,
    reminderScheduler,
    authManager
  );

  await notificationBot.initialize();
  notificationBot.startKeepAlive();

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
})();
