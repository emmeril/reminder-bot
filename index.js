const fs = require("fs/promises");
const path = require("path");
const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const QRCode = require("qrcode");
const express = require("express");
const cron = require("node-cron");
const crypto = require("crypto");

const CONFIG = {
  PORT: process.env.PORT || 3025,
  DB_PATH: path.join(__dirname, "database"),
  TEMPLATE_PATH: path.join(__dirname, "templates"),
  AUTO_SAVE_INTERVAL: 24 * 60 * 60 * 1000,
  BACKUP_INTERVAL: 24 * 60 * 60 * 1000,
  SESSION_TIMEOUT: 60 * 60 * 1000,
  KEEP_ALIVE_INTERVAL: 5 * 60 * 1000,
  MAX_RECONNECT_ATTEMPTS: 10,
  MIN_RECONNECT_INTERVAL: 30000,
  RECONNECT_DELAY: 5000,
  CRON_SCHEDULE: "*/1 * * * *",
  RESET_PAYMENT_SCHEDULE: "0 0 1 * *",
  MAX_LOCK_WAIT: 10000,
  LOCK_POLL_INTERVAL: 50,
  WEB_API_KEY: process.env.WEB_API_KEY || "dev-key-change-in-production",
};

const COMMANDS = {
  HELP: "!help",
  MENU: "!menu",
  CANCEL: "!cancel",
  ADD_REMINDER: "!addreminder",
  EDIT_REMINDER: "!editreminder",
  DELETE_REMINDER: "!deletereminder",
  LIST_REMINDER: "!listreminder",
  ADD_CONTACT: "!addkontak",
  EDIT_CONTACT: "!editkontak",
  DELETE_CONTACT: "!deletekontak",
  LIST_CONTACT: "!listkontak",
  BAYAR: "!bayar",
  STATUS_BAYAR: "!statusbayar",
  LAPORAN: "!laporan",
  TUNGGAKAN: "!tunggakan",
  RIWAYAT_TAGIHAN: "!riwayattagihan",
  SET_ADMIN: "!setadmin",
};

const ALLOWED_NON_ADMIN_COMMANDS = new Set([COMMANDS.HELP, COMMANDS.MENU]);

function escapeHtml(str) {
  if (typeof str !== "string") return str;
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function sanitizeInput(str) {
  if (typeof str !== "string") return "";
  return str.replace(/[\u0000-\u001F\u007F-\u009F]/g, "").trim();
}

// ==================== UTILITY FUNCTIONS ====================
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const SESSION_STEPS = {
  ADD_REMINDER_CONTACT: "add-1",
  ADD_REMINDER_TEMPLATE: "add-2",
  ADD_REMINDER_CUSTOM: "add-3-custom",
  ADD_REMINDER_DATE: "add-4",
  EDIT_REMINDER_SELECT: "edit-reminder-select",
  EDIT_REMINDER_DATE: "edit-reminder-tanggal",
  EDIT_REMINDER_MESSAGE: "edit-reminder-pesan",
  EDIT_REMINDER_TEMPLATE: "edit-reminder-template",
  EDIT_REMINDER_CUSTOM: "edit-reminder-custom",
  DELETE_REMINDER_SELECT: "delete-reminder-select",
  ADD_CONTACT_NAME: "add-kontak-nama",
  ADD_CONTACT_NUMBER: "add-kontak-nomor",
  EDIT_CONTACT_SELECT: "edit-kontak-select",
  EDIT_CONTACT_NAME: "edit-kontak-nama",
  EDIT_CONTACT_NUMBER: "edit-kontak-nomor",
  DELETE_CONTACT_SELECT: "delete-kontak-select",
  BAYAR_SELECT: "bayar-select",
  BAYAR_CONFIRM_ARREARS: "bayar-confirm-arrears",
};

const generateId = () => `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;

const PAYMENT_STATUS = {
  PAID: "PAID",
  UNPAID: "UNPAID",
};

const getPaymentEmoji = (status) => status === PAYMENT_STATUS.PAID ? "✅" : "⏳";
const getPaymentLabel = (status) => status === PAYMENT_STATUS.PAID ? "Sudah Dibayar" : "Belum Dibayar";

const parseDateTimeInput = (input) => {
  const match = sanitizeInput(input).match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})$/);
  if (!match) return null;

  const [, year, month, day, hour, minute] = match;
  const yearNum = parseInt(year, 10);
  const monthNum = parseInt(month, 10);
  const dayNum = parseInt(day, 10);
  const hourNum = parseInt(hour, 10);
  const minuteNum = parseInt(minute, 10);

  if (monthNum < 1 || monthNum > 12) return null;
  if (dayNum < 1 || dayNum > 31) return null;
  if (hourNum < 0 || hourNum > 23) return null;
  if (minuteNum < 0 || minuteNum > 59) return null;

  const maxDays = new Date(yearNum, monthNum, 0).getDate();
  if (dayNum > maxDays) return null;

  const date = new Date(yearNum, monthNum - 1, dayNum, hourNum, minuteNum);
  if (Number.isNaN(date.getTime())) return null;

  const tanggal = `${yearNum}-${String(monthNum).padStart(2, '0')}-${String(dayNum).padStart(2, '0')}`;
  const jam = `${String(hourNum).padStart(2, '0')}:${String(minuteNum).padStart(2, '0')}`;

  return { tanggal, jam, date };
};

const addMonthsSafely = (date, monthsToAdd) => {
  const source = new Date(date);
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
};

const formatDate = (date) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const formatDateTime = (date) => {
  return date.toLocaleString("id-ID", {
    dateStyle: "long",
    timeStyle: "short",
    timeZone: "Asia/Jakarta",
  });
};

const parseSelectionIndex = (value) => {
  const index = Number.parseInt(value, 10) - 1;
  return Number.isNaN(index) ? null : index;
};

const normalizePhoneNumber = (value) => value.replace(/[^0-9]/g, "");

const isValidPhoneNumber = (value) => /^628\d{7,13}$/.test(value);

// ==================== DATA MANAGER ====================
class DataManager {
  constructor() {
    this.contacts = new Map();
    this.reminders = new Map();
    this.sentReminders = new Map();
    this.roles = new Map();
    this.fileLocks = new Map();
    this.initDirectories();
  }

  async initDirectories() {
    await fs.mkdir(CONFIG.DB_PATH, { recursive: true });
    await fs.mkdir(CONFIG.TEMPLATE_PATH, { recursive: true });
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

  // Atomic write with retry
  async atomicWrite(filePath, data, maxRetries = 3) {
    await this.acquireLock(filePath);
    const tempPath = filePath + '.tmp';
    const backupPath = filePath + '.bak';

    try {
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          // Backup existing file
          await fs.copyFile(filePath, backupPath).catch(() => {});
          
          // Write to temp file
          await fs.writeFile(tempPath, JSON.stringify(data, null, 2));
          
          // Verify
          const verify = await fs.readFile(tempPath, 'utf-8');
          JSON.parse(verify);
          
          // Atomic rename
          await fs.rename(tempPath, filePath);
          return;
        } catch (error) {
          console.error(`❌ Write attempt ${attempt} failed:`, error.message);
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

  // Load data
  async loadAll() {
    console.log('📂 Loading data...');
    this.contacts = await this.loadMapFromFile(this.getPath('contacts.json'), 'id');
    this.reminders = await this.loadMapFromFile(this.getPath('reminders.json'), 'id');
    this.sentReminders = await this.loadMapFromFile(this.getPath('sent_reminders.json'), 'id');
    this.roles = await this.loadRoles();
    console.log(`✅ Data loaded: ${this.contacts.size} contacts, ${this.reminders.size} reminders, ${this.roles.size} roles`);
  }

  getPath(filename) {
    return path.join(CONFIG.DB_PATH, filename);
  }

  async loadMapFromFile(filePath, keyField) {
    try {
      const raw = await fs.readFile(filePath, 'utf-8');
      if (!raw.trim()) return new Map();
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return new Map();
      return new Map(arr.filter(item => item && item[keyField]).map(item => [item[keyField], item]));
    } catch (error) {
      if (error.code === 'ENOENT') return new Map();
      console.error(`❌ Error loading ${filePath}:`, error.message);
      // Attempt recovery from backup
      try {
        const backup = filePath + '.bak';
        await fs.copyFile(backup, filePath);
        return this.loadMapFromFile(filePath, keyField);
      } catch {
        return new Map();
      }
    }
  }

  async loadRoles() {
    try {
      const raw = await fs.readFile(this.getPath('roles.json'), 'utf-8');
      if (!raw.trim()) return new Map();
      const obj = JSON.parse(raw);
      return new Map(Object.entries(obj));
    } catch (error) {
      if (error.code === 'ENOENT') return new Map();
      console.error("❌ Error loading roles:", error.message);
      return new Map();
    }
  }

  // Save data
  async saveContacts() {
    await this.atomicWrite(this.getPath('contacts.json'), Array.from(this.contacts.values()));
  }

  async saveReminders() {
    await this.atomicWrite(this.getPath('reminders.json'), Array.from(this.reminders.values()));
  }

  async saveSentReminders() {
    await this.atomicWrite(this.getPath('sent_reminders.json'), Array.from(this.sentReminders.values()));
  }

  async saveRoles() {
    await this.atomicWrite(this.getPath('roles.json'), Object.fromEntries(this.roles));
  }

  async saveAll() {
    console.log('🔄 Auto-saving data...');
    await Promise.all([
      this.saveContacts(),
      this.saveReminders(),
      this.saveSentReminders(),
      this.saveRoles(),
    ]);
    console.log('✅ Auto-save completed');
  }

  // Backup
  async createBackup() {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupDir = path.join(CONFIG.DB_PATH, 'backups', timestamp);
    await fs.mkdir(backupDir, { recursive: true });
    const files = ['contacts.json', 'reminders.json', 'sent_reminders.json', 'roles.json'];
    await Promise.all(files.map(async file => {
      const src = this.getPath(file);
      const dest = path.join(backupDir, file);
      await fs.copyFile(src, dest).catch(() => {});
    }));
    console.log(`💾 Backup created: ${backupDir}`);
  }

  // CRUD Helpers
  isAdmin(sender) {
    const number = sender.split('@')[0];
    return this.roles.get(number) === 'admin';
  }

  async addAdmin(number) {
    this.roles.set(number, 'admin');
    await this.saveRoles();
  }

  async addContact(contact) {
    this.contacts.set(contact.id, contact);
    await this.saveContacts();
  }

  async updateContact(id, data) {
    const contact = this.contacts.get(id);
    if (!contact) throw new Error('Contact not found');
    Object.assign(contact, data);
    await this.saveContacts();
  }

  async deleteContact(id) {
    this.contacts.delete(id);
    await this.saveContacts();
  }

  async addReminder(reminder) {
    this.reminders.set(reminder.id, reminder);
    await this.saveReminders();
  }

  async updateReminder(id, data) {
    const reminder = this.reminders.get(id);
    if (!reminder) throw new Error('Reminder not found');
    Object.assign(reminder, data);
    await this.saveReminders();
  }

  async deleteReminder(id) {
    this.reminders.delete(id);
    await this.saveReminders();
  }

  async moveToSent(id) {
    const reminder = this.reminders.get(id);
    if (reminder) {
      this.sentReminders.set(id, reminder);
      this.reminders.delete(id);
      await Promise.all([this.saveReminders(), this.saveSentReminders()]);
    }
  }

  getSortedReminders() {
    return Array.from(this.reminders.values()).sort(
      (a, b) => new Date(a.reminderDateTime) - new Date(b.reminderDateTime)
    );
  }

  getSortedContacts() {
    return Array.from(this.contacts.values()).sort((a, b) => a.name.localeCompare(b.name));
  }

  findContactByPhone(phone) {
    return Array.from(this.contacts.values()).find(c => c.phoneNumber === phone);
  }

  hasContactPhone(phoneNumber, excludeId = null) {
    return Array.from(this.contacts.values()).some(
      contact => contact.phoneNumber === phoneNumber && contact.id !== excludeId
    );
  }

  async updatePaymentStatus(id, status) {
    const contact = this.contacts.get(id);
    if (!contact) throw new Error('Contact not found');
    contact.paymentStatus = status;
    contact.paymentDate = status === PAYMENT_STATUS.PAID ? new Date().toISOString() : null;
    await this.saveContacts();
    return contact;
  }

  getContactsByStatus(status) {
    return Array.from(this.contacts.values())
      .filter(c => c.paymentStatus === status)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  getPaymentsByMonth(year, month) {
    return Array.from(this.contacts.values())
      .filter(c => {
        if (!c.paymentDate) return false;
        const paidDate = new Date(c.paymentDate);
        return paidDate.getFullYear() === year && (paidDate.getMonth() + 1) === month;
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  getAllPaymentsHistory() {
    const history = {};
    const paymentMonths = this.getPaymentMonths();
    for (const contact of this.contacts.values()) {
      if (contact.paymentDate) {
        const paidDate = new Date(contact.paymentDate);
        const key = `${paidDate.getFullYear()}-${String(paidDate.getMonth() + 1).padStart(2, "0")}`;
        if (!history[key]) {
          history[key] = { contacts: [], total: 0 };
        }
        history[key].contacts.push(contact);
        history[key].total++;
      }
    }
    return history;
  }

  getPaymentMonths() {
    return this.paymentMonths || {};
  }

  getPaymentMonthStatus(contactId) {
    const contact = this.contacts.get(contactId);
    if (!contact || !contact.paymentMonths) return {};
    return contact.paymentMonths;
  }

  async setPaymentForMonth(contactId, year, month, status) {
    const contact = this.contacts.get(contactId);
    if (!contact) return;
    if (!contact.paymentMonths) contact.paymentMonths = {};
    const key = `${year}-${String(month).padStart(2, "0")}`;
    contact.paymentMonths[key] = {
      status: status,
      paidDate: status === PAYMENT_STATUS.PAID ? new Date().toISOString() : null
    };
    const now = new Date();
    const currentMonth = now.getMonth() + 1;
    const currentYear = now.getFullYear();
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
    
    return Array.from(this.contacts.values()).filter(contact => {
      const pm = contact.paymentMonths || {};
      const prevStatus = pm[prevKey]?.status;
      const currStatus = pm[currentKey]?.status;
      const now = new Date();
      const systemStartMonth = 4; // April 2026 - bulan sistem diimplementasikan
      const systemStartYear = 2026;
      
      // Jika bulan sebelum sistem dimulai, dianggap LUNAS (tidak valid untuk perhitungan)
      const isPrevBeforeSystem = prevYear < systemStartYear || (prevYear === systemStartYear && prevMonth < systemStartMonth);
      if (isPrevBeforeSystem) return false;
      
      // Untuk bulan saat sistem dimulai dan setelahnya
      const isPrevUnpaid = !prevStatus || prevStatus !== PAYMENT_STATUS.PAID;
      const isCurrUnpaid = !currStatus || currStatus !== PAYMENT_STATUS.PAID;
      return isPrevUnpaid || isCurrUnpaid;
    });
  }

  async resetAllPaymentStatus() {
    let resetCount = 0;
    for (const contact of this.contacts.values()) {
      if (contact.paymentStatus === PAYMENT_STATUS.PAID) {
        contact.paymentStatus = PAYMENT_STATUS.UNPAID;
        contact.paymentDate = null;
        resetCount++;
      }
    }
    if (resetCount > 0) {
      await this.saveContacts();
      console.log(`🔄 Reset payment status for ${resetCount} contacts to UNPAID`);
    }
    return resetCount;
  }
}

// ==================== SESSION MANAGER ====================
class SessionManager {
  constructor() {
    this.sessions = new Map();
  }

  createSession(sender, data) {
    this.sessions.set(sender, {
      ...structuredClone(data),
      lastActivity: Date.now(),
    });
  }

  getSession(sender) {
    const session = this.sessions.get(sender);
    if (session) session.lastActivity = Date.now();
    return session;
  }

  deleteSession(sender) {
    this.sessions.delete(sender);
  }

  cleanupStaleSessions() {
    const now = Date.now();
    for (const [sender, session] of this.sessions.entries()) {
      if (now - session.lastActivity > CONFIG.SESSION_TIMEOUT) {
        this.sessions.delete(sender);
        console.log(`🧹 Cleaned up stale session for ${sender}`);
      }
    }
  }
}

// ==================== TEMPLATE MANAGER ====================
class TemplateManager {
  constructor() {
    this.cache = null;
    this.cacheTime = 0;
    this.CACHE_TTL = 60000; // 1 menit
  }

  async loadTemplates() {
    const now = Date.now();
    if (this.cache && now - this.cacheTime < this.CACHE_TTL) {
      return this.cache;
    }

    try {
      const files = await fs.readdir(CONFIG.TEMPLATE_PATH);
      const templates = [];
      for (const file of files) {
        try {
          const content = await fs.readFile(path.join(CONFIG.TEMPLATE_PATH, file), 'utf-8');
          templates.push({
            name: file.replace(/^\d+_/, '').replace('.txt', ''),
            content,
          });
        } catch (error) {
          console.error(`❌ Error loading template ${file}:`, error.message);
        }
      }
      this.cache = templates;
      this.cacheTime = now;
      return templates;
    } catch (error) {
      console.error("❌ Error loading templates:", error.message);
      return [];
    }
  }

  applyTemplate(template, variables) {
    let message = template;
    for (const [key, value] of Object.entries(variables)) {
      const sanitizedValue = typeof value === 'string' ? value.replace(/[*_`~]/g, '\\$&') : value;
      message = message.replace(new RegExp(`{{${key}}}`, 'gi'), sanitizedValue);
    }
    return message;
  }
}

// ==================== WHATSAPP CLIENT ====================
class WhatsAppClient {
  constructor(dataManager, sessionManager, templateManager) {
    this.dataManager = dataManager;
    this.sessionManager = sessionManager;
    this.templateManager = templateManager;
    this.client = null;
    this.currentQR = null;
    this.isReady = false;
    this.isReconnecting = false;
    this.reconnectAttempts = 0;
    this.lastReconnectTime = null;
    this.reconnectTimer = null;
    this.keepAliveTimer = null;
  }

  getCommandHandlers() {
    return {
      "!addreminder": this.handleAddReminder,
      "!editreminder": this.handleEditReminder,
      "!deletereminder": this.handleDeleteReminder,
      "!listreminder": this.handleListReminder,
      "!addkontak": this.handleAddContact,
      "!editkontak": this.handleEditContact,
      "!deletekontak": this.handleDeleteContact,
      "!listkontak": this.handleListContact,
      "!bayar": this.handleBayar,
      "!statusbayar": this.handleStatusBayar,
      "!laporan": this.handleLaporan,
      "!tunggakan": this.handleTunggakan,
      "!riwayattagihan": this.handleRiwayatTagihan,
      "!help": this.sendHelp,
      "!menu": this.sendHelp,
    };
  }

  getSessionHandlers() {
    return {
      [SESSION_STEPS.ADD_REMINDER_CONTACT]: this.handleAddReminderStep1,
      [SESSION_STEPS.ADD_REMINDER_TEMPLATE]: this.handleAddReminderStep2,
      [SESSION_STEPS.ADD_REMINDER_CUSTOM]: this.handleAddReminderStep3,
      [SESSION_STEPS.ADD_REMINDER_DATE]: this.handleAddReminderStep4,
      [SESSION_STEPS.EDIT_REMINDER_SELECT]: this.handleEditReminderSelect,
      [SESSION_STEPS.EDIT_REMINDER_DATE]: this.handleEditReminderDate,
      [SESSION_STEPS.EDIT_REMINDER_MESSAGE]: this.handleEditReminderMessageOption,
      [SESSION_STEPS.EDIT_REMINDER_TEMPLATE]: this.handleEditReminderTemplate,
      [SESSION_STEPS.EDIT_REMINDER_CUSTOM]: this.handleEditReminderCustom,
      [SESSION_STEPS.DELETE_REMINDER_SELECT]: this.handleDeleteReminderSelect,
      [SESSION_STEPS.ADD_CONTACT_NAME]: this.handleAddContactName,
      [SESSION_STEPS.ADD_CONTACT_NUMBER]: this.handleAddContactNumber,
      [SESSION_STEPS.EDIT_CONTACT_SELECT]: this.handleEditContactSelect,
      [SESSION_STEPS.EDIT_CONTACT_NAME]: this.handleEditContactName,
      [SESSION_STEPS.EDIT_CONTACT_NUMBER]: this.handleEditContactNumber,
      [SESSION_STEPS.DELETE_CONTACT_SELECT]: this.handleDeleteContactSelect,
      [SESSION_STEPS.BAYAR_SELECT]: this.handleBayarSelect,
      [SESSION_STEPS.BAYAR_CONFIRM_ARREARS]: this.handleBayarConfirmArrears,
    };
  }

  parseListSelection(body, items) {
    const index = parseSelectionIndex(body);
    if (index === null) return null;
    return items[index] || null;
  }

  formatReminderDisplay(reminder, index, withMessage = false) {
    const kontak = this.dataManager.findContactByPhone(reminder.phoneNumber);
    const nama = kontak ? kontak.name : reminder.phoneNumber;
    const waktu = formatDateTime(new Date(reminder.reminderDateTime));

    if (!withMessage) {
return `${index + 1}. ${nama} | ${waktu}`;
    }

    return `${index + 1}. ${nama} - ${waktu} WIB\n   💬 ${reminder.message}`;
  }

  formatContactDisplay(contact, index, multiline = false) {
    const status = contact.paymentStatus || PAYMENT_STATUS.UNPAID;
    const label = getPaymentLabel(status);
    const emoji = getPaymentEmoji(status);
    if (multiline) {
      return `${index + 1}. ${contact.name}\n   📞 ${contact.phoneNumber}\n   ${emoji} ${label}`;
    }

    return `${index + 1}. ${contact.name} | ${contact.phoneNumber} | ${emoji} ${label}`;
  }

  createSession(sender, data) {
    this.sessionManager.createSession(sender, data);
  }

  clearSession(sender) {
    this.sessionManager.deleteSession(sender);
  }

  createClient() {
    const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
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
    }

    return new Client({
      authStrategy: new LocalAuth({ dataPath: CONFIG.DB_PATH }),
      puppeteer: puppeteerOptions,
      webVersionCache: {
        type: "remote",
        remotePath:
          "https://raw.githubusercontent.com/wppconnect-team/wa-version/refs/heads/main/html/2.3000.1031490220-alpha.html",
      },
    });
  }

  setupEvents() {
    if (!this.client) return;

    this.client.removeAllListeners();

    this.client.on("qr", (qr) => {
      this.currentQR = qr;
      this.isReady = false;
      this.reconnectAttempts = 0;
      this.isReconnecting = false;
      console.log("📲 QR code generated");
      qrcode.generate(qr, { small: true });
    });

    this.client.on("authenticated", () => {
      console.log("🔐 WhatsApp authenticated");
      this.reconnectAttempts = 0;
      this.isReconnecting = false;
    });

    this.client.on("auth_failure", (msg) => {
      console.error("❌ Auth failure:", msg);
      this.isReady = false;
      this.scheduleReconnect();
    });

    this.client.on("ready", () => {
      console.log("✅ WhatsApp ready");
      this.isReady = true;
      this.currentQR = null;
      this.reconnectAttempts = 0;
      this.isReconnecting = false;
      this.lastReconnectTime = null;
    });

    this.client.on("change_state", (state) => {
      console.log("📡 WA STATE:", state);
      if (state === "CONNECTED") {
        this.isReady = true;
        this.reconnectAttempts = 0;
        this.isReconnecting = false;
      }
      if (["DISCONNECTED", "CONFLICT"].includes(state)) {
        this.isReady = false;
        this.scheduleReconnect();
      }
    });

    this.client.on("disconnected", (reason) => {
      console.log("❌ WhatsApp disconnected:", reason);
      this.isReady = false;
      this.currentQR = null;
      if (["UNAUTHORIZED", "CONFLICT"].includes(reason)) {
        const sessionPath = path.join(CONFIG.DB_PATH, ".wwebjs_auth");
        fs.rm(sessionPath, { recursive: true, force: true }).catch(() => {});
      }
      this.scheduleReconnect();
    });

    this.client.on("error", (error) => {
      console.error("❌ WhatsApp error:", error.message);
      if (!this.isReady && !this.isReconnecting) {
        this.scheduleReconnect();
      }
    });

    this.client.on("message", this.handleMessage.bind(this));
  }

  async handleMessage(msg) {
    if (msg.from === 'status@broadcast') return;

    const sender = msg.from;
    const body = msg.body.trim();
    const session = this.sessionManager.getSession(sender);

    try {
      if (body === "!cancel") {
        if (session) {
          this.clearSession(sender);
          return msg.reply("✅ Sesi saat ini dibatalkan.");
        }
        return msg.reply("❌ Tidak ada sesi yang aktif.");
      }

      if (!this.dataManager.isAdmin(sender) && !ALLOWED_NON_ADMIN_COMMANDS.has(body)) {
        return;
      }

      const commandHandler = this.getCommandHandlers()[body];
      if (commandHandler) {
        return commandHandler.call(this, msg, sender);
      }

      if (body.startsWith("!setadmin ")) return this.handleSetAdmin(msg, sender, body);

      if (session) {
        const sessionHandler = this.getSessionHandlers()[session.step];
        if (sessionHandler) {
          return sessionHandler.call(this, msg, sender, body, session);
        }
      }
    } catch (error) {
      console.error('❌ Error in message handler:', error);
      msg.reply("❌ Terjadi error internal. Silakan coba lagi.");
    }
  }

  // ========== REMINDER HANDLERS ==========
  async handleAddReminder(msg, sender) {
    const contacts = this.dataManager.getSortedContacts();
    if (contacts.length === 0) {
      return msg.reply("📭 Tidak ada kontak. Tambahkan kontak dulu dengan !addkontak.");
    }
    const list = contacts.map((c, i) => `${i + 1}. ${c.name}`).join("\n");
    this.createSession(sender, { step: SESSION_STEPS.ADD_REMINDER_CONTACT, contactList: contacts });
    msg.reply(`📇 Kontak tersedia:\n${list}\n\nKetik nomor kontak:`);
  }

  async handleAddReminderStep1(msg, sender, body, session) {
    const index = parseSelectionIndex(body);
    if (index === null) return msg.reply("❌ Nomor kontak tidak valid.");
    const contact = index === null ? null : session.contactList[index];
    if (!contact) return msg.reply("❌ Nomor kontak tidak valid.");

    const templates = await this.templateManager.loadTemplates();
    const list = templates.map((t, i) => `${i + 1}. ${t.name}`).join("\n");
    this.createSession(sender, {
      step: SESSION_STEPS.ADD_REMINDER_TEMPLATE,
      kontak: contact,
      templateOptions: templates,
    });
    msg.reply(`📄 Pilih Template atau Custom:\n${list}\n${templates.length + 1}. ✏️ Ketik manual (Custom)\n\nKetik angka pilihan:`);
  }

  async handleAddReminderStep2(msg, sender, body, session) {
    const idx = Number.parseInt(body, 10);
    if (Number.isNaN(idx)) return msg.reply("❌ Pilihan tidak valid.");
    const templates = session.templateOptions;
    if (idx >= 1 && idx <= templates.length) {
      session.template = templates[idx - 1].content;
      this.createSession(sender, { ...session, step: SESSION_STEPS.ADD_REMINDER_DATE });
      return msg.reply("📅 Ketik tanggal & jam (format: YYYY-MM-DD HH:mm):");
    }
    if (idx === templates.length + 1) {
      this.createSession(sender, { ...session, step: SESSION_STEPS.ADD_REMINDER_CUSTOM });
      return msg.reply("✏️ Ketik pesan custom Anda:");
    }
    msg.reply("❌ Pilihan tidak valid.");
  }

  async handleAddReminderStep3(msg, sender, body, session) {
    session.template = body;
    this.createSession(sender, { ...session, step: SESSION_STEPS.ADD_REMINDER_DATE });
    msg.reply("📅 Ketik tanggal & jam (format: YYYY-MM-DD HH:mm):");
  }

  async handleAddReminderStep4(msg, sender, body, session) {
    const parsed = parseDateTimeInput(body);
    if (!parsed) return msg.reply("❌ Format waktu salah. Gunakan YYYY-MM-DD HH:mm.");

    const { tanggal, jam, date: dt } = parsed;
    if (dt.getTime() <= Date.now()) {
      return msg.reply("❌ Waktu reminder harus di masa depan.");
    }

    const bulan = dt.toLocaleString("id-ID", { month: "long" });
    const { kontak, template } = session;
    const finalMessage = this.templateManager.applyTemplate(template, {
      nama: kontak.name,
      tanggal,
      bulan,
    });

    const reminder = {
      id: generateId(),
      phoneNumber: kontak.phoneNumber,
      reminderDateTime: dt,
      message: finalMessage,
    };

    await this.dataManager.addReminder(reminder);
    this.clearSession(sender);
    msg.reply(`✅ Reminder disimpan untuk ${kontak.name} pada ${tanggal} ${jam}`);
  }

  async handleEditReminder(msg, sender) {
    const sorted = this.dataManager.getSortedReminders();
    if (sorted.length === 0) return msg.reply("📭 Tidak ada reminder.");

    const list = sorted.map((r, i) => this.formatReminderDisplay(r, i)).join("\n");

    this.createSession(sender, { step: SESSION_STEPS.EDIT_REMINDER_SELECT, list: sorted });
    msg.reply(`✏️ Pilih reminder yang ingin diedit:\n${list}\n\nKetik nomor:`);
  }

  async handleEditReminderSelect(msg, sender, body, session) {
    const index = parseSelectionIndex(body);
    if (index === null) return msg.reply("❌ Nomor tidak valid.");
    const selected = index === null ? null : session.list[index];
    if (!selected) return msg.reply("❌ Nomor tidak valid.");

    this.createSession(sender, {
      ...session,
      selectedReminder: selected,
      step: SESSION_STEPS.EDIT_REMINDER_DATE,
    });
    msg.reply("📅 Masukkan tanggal & jam baru (format: YYYY-MM-DD HH:mm):");
  }

  async handleEditReminderDate(msg, sender, body, session) {
    const parsed = parseDateTimeInput(body);
    if (!parsed) return msg.reply("❌ Format waktu salah. Gunakan YYYY-MM-DD HH:mm.");

    const { date: dt } = parsed;
    if (dt.getTime() <= Date.now()) {
      return msg.reply("❌ Waktu reminder harus di masa depan.");
    }

    session.newDate = dt;
    this.createSession(sender, { ...session, step: SESSION_STEPS.EDIT_REMINDER_MESSAGE });
    msg.reply("📩 Ganti isi pesan?\n1. Pakai template\n2. Ketik manual\n3. Tidak usah ganti\n\nKetik 1 / 2 / 3:");
  }

  async handleEditReminderMessageOption(msg, sender, body, session) {
    const option = body;
    if (option === '1') {
      const templates = await this.templateManager.loadTemplates();
      const list = templates.map((t, i) => `${i + 1}. ${t.name}`).join("\n");
      this.createSession(sender, { ...session, step: SESSION_STEPS.EDIT_REMINDER_TEMPLATE, templateOptions: templates });
      return msg.reply(`📄 Pilih Template:\n${list}\n\nKetik nomor:`);
    }
    if (option === '2') {
      this.createSession(sender, { ...session, step: SESSION_STEPS.EDIT_REMINDER_CUSTOM });
      return msg.reply("✏️ Ketik pesan baru:");
    }
    if (option === '3') {
      await this.updateReminder(msg, session.selectedReminder, session.newDate, null, sender);
    } else {
      msg.reply("❌ Pilih 1 / 2 / 3.");
    }
  }

  async handleEditReminderTemplate(msg, sender, body, session) {
    const idx = parseSelectionIndex(body);
    if (idx === null) return msg.reply("❌ Template tidak valid.");
    const template = session.templateOptions[idx];
    if (!template) return msg.reply("❌ Template tidak valid.");

    const reminder = session.selectedReminder;
    const kontak = this.dataManager.findContactByPhone(reminder.phoneNumber);
    const tanggal = formatDate(session.newDate);
    const bulan = session.newDate.toLocaleString("id-ID", { month: "long" });
    const newMessage = this.templateManager.applyTemplate(template.content, {
      nama: kontak?.name || reminder.phoneNumber,
      tanggal,
      bulan,
    });

    await this.updateReminder(msg, reminder, session.newDate, newMessage, sender);
  }

  async handleEditReminderCustom(msg, sender, body, session) {
    const reminder = session.selectedReminder;
    const kontak = this.dataManager.findContactByPhone(reminder.phoneNumber);
    const tanggal = formatDate(session.newDate);
    const bulan = session.newDate.toLocaleString("id-ID", { month: "long" });
    const newMessage = this.templateManager.applyTemplate(body, {
      nama: kontak?.name || reminder.phoneNumber,
      tanggal,
      bulan,
    });

    await this.updateReminder(msg, reminder, session.newDate, newMessage, sender);
  }

  async updateReminder(msg, reminder, newDate, newMessage, sender) {
    reminder.reminderDateTime = newDate;
    if (newMessage) reminder.message = newMessage;
    await this.dataManager.updateReminder(reminder.id, reminder);
    this.clearSession(sender);
    msg.reply(`✅ Reminder berhasil diperbarui ke ${formatDateTime(newDate)}`);
  }

  async handleDeleteReminder(msg, sender) {
    const sorted = this.dataManager.getSortedReminders();
    if (sorted.length === 0) return msg.reply("📭 Tidak ada reminder.");

    const list = sorted.map((r, i) => this.formatReminderDisplay(r, i)).join("\n");

    this.createSession(sender, { step: SESSION_STEPS.DELETE_REMINDER_SELECT, list: sorted });
    msg.reply(`🗑️ Reminder yang tersedia:\n${list}\n\nKetik nomor reminder yang ingin dihapus:`);
  }

  async handleDeleteReminderSelect(msg, sender, body, session) {
    const index = parseSelectionIndex(body);
    if (index === null) return msg.reply("❌ Nomor tidak valid.");
    const selected = index === null ? null : session.list[index];
    if (!selected) return msg.reply("❌ Nomor tidak valid.");

    await this.dataManager.deleteReminder(selected.id);
    this.clearSession(sender);
    msg.reply(`✅ Reminder berhasil dihapus.`);
  }

  async handleListReminder(msg) {
    const sorted = this.dataManager.getSortedReminders();
    if (sorted.length === 0) return msg.reply("📭 Belum ada reminder.");

    const list = sorted.map((r, i) => {
      const kontak = this.dataManager.findContactByPhone(r.phoneNumber);
      const nama = kontak ? kontak.name : r.phoneNumber;
      const waktu = formatDateTime(new Date(r.reminderDateTime));
      return `${i + 1}. ${nama} - ${waktu} WIB\n   💬 ${r.message}`;
    }).join("\n\n");

    msg.reply(`📌 Reminder Aktif:\n\n${list}`);
  }

  // ========== CONTACT HANDLERS ==========
  async handleAddContact(msg, sender) {
    this.createSession(sender, { step: SESSION_STEPS.ADD_CONTACT_NAME });
    msg.reply("📝 Masukkan nama kontak:");
  }

  async handleAddContactName(msg, sender, body, session) {
    this.createSession(sender, { ...structuredClone(session), nama: body, step: SESSION_STEPS.ADD_CONTACT_NUMBER });
    msg.reply("📞 Masukkan nomor HP (format 628xxx):");
  }

  async handleAddContactNumber(msg, sender, body, session) {
    const nomor = normalizePhoneNumber(body);
    if (!isValidPhoneNumber(nomor)) return msg.reply("❌ Nomor tidak valid!");
    if (this.dataManager.hasContactPhone(nomor)) {
return msg.reply("❌ Nomor ini sudah terdaftar sebagai kontak.");
    }

    const newContact = {
      id: generateId(),
      name: session.nama,
      phoneNumber: nomor,
      paymentStatus: PAYMENT_STATUS.UNPAID,
    };
    await this.dataManager.addContact(newContact);
    this.clearSession(sender);
    msg.reply(`✅ Kontak berhasil ditambahkan:\n${newContact.name} | ${newContact.phoneNumber}\n⏳ Status: Belum Dibayar`);
  }

  async handleEditContact(msg, sender) {
    const contacts = this.dataManager.getSortedContacts();
    if (contacts.length === 0) return msg.reply("📭 Tidak ada kontak.");

    const list = contacts.map((c, i) => this.formatContactDisplay(c, i)).join("\n");
    this.createSession(sender, { step: SESSION_STEPS.EDIT_CONTACT_SELECT, list: contacts });
    msg.reply(`✏️ Kontak tersedia:\n${list}\n\nKetik nomor kontak yang ingin diedit:`);
  }

  async handleEditContactSelect(msg, sender, body, session) {
    const index = parseSelectionIndex(body);
    if (index === null) return msg.reply("❌ Nomor tidak valid.");
    const selected = index === null ? null : session.list[index];
    if (!selected) return msg.reply("❌ Nomor tidak valid.");

    this.createSession(sender, {
      ...session,
      kontak: selected,
      step: SESSION_STEPS.EDIT_CONTACT_NAME,
    });
    msg.reply(`✏️ Nama saat ini: ${selected.name}\nMasukkan nama baru:`);
  }

  async handleEditContactName(msg, sender, body, session) {
    this.createSession(sender, { ...structuredClone(session), newName: body, step: SESSION_STEPS.EDIT_CONTACT_NUMBER });
    msg.reply("📞 Masukkan nomor HP baru (format: 628xxx):");
  }

  async handleEditContactNumber(msg, sender, body, session) {
    const nomor = normalizePhoneNumber(body);
    if (!isValidPhoneNumber(nomor)) return msg.reply("❌ Nomor tidak valid!");
    if (this.dataManager.hasContactPhone(nomor, session.kontak.id)) {
      return msg.reply("❌ Nomor ini sudah dipakai kontak lain.");
    }

    const kontak = session.kontak;
    kontak.name = session.newName;
    kontak.phoneNumber = nomor;
    await this.dataManager.updateContact(kontak.id, kontak);
    this.clearSession(sender);
    msg.reply(`✅ Kontak berhasil diperbarui:\n${kontak.name} | ${kontak.phoneNumber}`);
  }

  async handleDeleteContact(msg, sender) {
    const contacts = this.dataManager.getSortedContacts();
    if (contacts.length === 0) return msg.reply("📭 Tidak ada kontak.");

    const list = contacts.map((c, i) => this.formatContactDisplay(c, i)).join("\n");
    this.createSession(sender, { step: SESSION_STEPS.DELETE_CONTACT_SELECT, list: contacts });
    msg.reply(`🗑️ Kontak tersedia:\n${list}\n\nKetik nomor kontak yang ingin dihapus:`);
  }

  async handleDeleteContactSelect(msg, sender, body, session) {
    const index = parseSelectionIndex(body);
    if (index === null) return msg.reply("❌ Nomor tidak valid.");
    const selected = index === null ? null : session.list[index];
    if (!selected) return msg.reply("❌ Nomor tidak valid.");

    await this.dataManager.deleteContact(selected.id);
    this.clearSession(sender);
    msg.reply(`✅ Kontak '${selected.name}' berhasil dihapus.`);
  }

  async handleListContact(msg) {
    const contacts = this.dataManager.getSortedContacts();
    if (contacts.length === 0) return msg.reply("📭 Belum ada kontak.");

    const list = contacts.map((c, i) => this.formatContactDisplay(c, i, true)).join("\n\n");
    msg.reply(`📇 Daftar Kontak:\n\n${list}`);
  }

  async handleBayar(msg, sender) {
    const contacts = this.dataManager.getSortedContacts();
    if (contacts.length === 0) return msg.reply("📭 Tidak ada kontak.");

    const now = new Date();
    const currentMonth = now.getMonth() + 1;
    const currentYear = now.getFullYear();
    const currKey = `${currentYear}-${String(currentMonth).padStart(2, "0")}`;

    const contactsWithArrears = contacts.filter(c => {
      const pm = c.paymentMonths || {};
      const currPaid = pm[currKey]?.status === PAYMENT_STATUS.PAID;
      return !currPaid;
    });

    if (contactsWithArrears.length === 0) return msg.reply("✅ Semua kontak sudah lunas bulan ini!");

    const list = contactsWithArrears.map((c, i) => {
      const arrears = this.getArrearsForContact(c);
      const badge = arrears.length > 0 ? ` (⚠️${arrears.length} tunggakan)` : '';
      return `${i + 1}. ${c.name}${badge} | ${c.phoneNumber}`;
    }).join("\n");

    this.createSession(sender, { step: SESSION_STEPS.BAYAR_SELECT, contactList: contactsWithArrears });
    msg.reply(`💳 Pilih kontak yang sudah BAYAR:\n${list}\n\nKetik nomor:\n\n💡 Tanda (⚠️n) = memiliki n bulan tunggakan`);
  }

  async handleBayarSelect(msg, sender, body, session) {
    const index = parseSelectionIndex(body);
    if (index === null) return msg.reply("❌ Nomor tidak valid.");
    const contact = session.contactList[index];
    if (!contact) return msg.reply("❌ Nomor tidak valid.");
    if (contact.paymentStatus === PAYMENT_STATUS.PAID) {
      return msg.reply("❌ Kontak ini sudah lunas.");
    }

    const arrears = this.getArrearsForContact(contact);
    const now = new Date();
    const currentMonth = now.getMonth() + 1;
    const currentYear = now.getFullYear();
    const monthNames = ["", "Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"];

    if (arrears.length > 0) {
      const arrearsText = arrears.map(a => 
        `  - ${a.monthName} ${a.year}`
      ).join("\n");

      this.createSession(sender, { 
        step: SESSION_STEPS.BAYAR_CONFIRM_ARREARS,
        contact: contact,
        arrears: arrears
      });

      return msg.reply(
        `⚠️ *KONFIRMASI PEMBAYARAN*\n\n` +
        `${contact.name} memiliki tunggakan:\n${arrearsText}\n\n` +
        `Pembayaran saat ini akan dialokasikan ke tunggakan TERTAUA dulu.\n\n` +
        `Pilih:\n1. Bayar tunggakan saja\n2. Bayar tunggakan + bulan ini\n3. Bayar bulan ini saja (tunggakan tetap ada)\n\nKetik 1/2/3:`
      );
    }

    await this.dataManager.setPaymentForMonth(contact.id, currentYear, currentMonth, PAYMENT_STATUS.PAID);
    this.clearSession(sender);

    const contactUpdated = this.dataManager.contacts.get(contact.id);
    const transactionId = `TRX-${Date.now()}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
    await this.sendPaymentNotification(contactUpdated, transactionId);
    msg.reply(`✅ Status pembayaran ${contact.name} diperbarui menjadi *Sudah Dibayar*.\n\nID Transaksi: ${transactionId}\n\nNotifikasi dikirim ke ${contact.phoneNumber}.`);
  }

  getArrearsForContact(contact) {
    const now = new Date();
    const currentMonth = now.getMonth() + 1;
    const currentYear = now.getFullYear();
    const pm = contact.paymentMonths || {};
    const monthNames = ["", "Januari", "Februari", "Maret", "April", "Mei", "Juni", 
                        "Juli", "Agustus", "September", "Oktober", "November", "Desember"];

    const systemStartMonth = 4; // April 2026
    const systemStartYear = 2026;

    const arrears = [];
    for (let i = systemStartMonth; i < currentMonth; i++) {
      const key = `${currentYear}-${String(i).padStart(2, "0")}`;
      if (pm[key]?.status !== PAYMENT_STATUS.PAID) {
        arrears.push({
          key,
          month: i,
          monthName: monthNames[i],
          year: currentYear
        });
      }
    }
    return arrears.sort((a, b) => a.month - b.month);
  }

  async handleBayarConfirmArrears(msg, sender, body, session) {
    const choice = body.trim();
    const { contact, arrears } = session;
    
    if (!['1', '2', '3'].includes(choice)) {
      return msg.reply("❌ Pilih 1, 2, atau 3.");
    }
    
    const now = new Date();
    const currentMonth = now.getMonth() + 1;
    const currentYear = now.getFullYear();
    const monthNames = ["", "Januari", "Februari", "Maret", "April", "Mei", "Juni", 
                        "Juli", "Agustus", "September", "Oktober", "November", "Desember"];
    const currentMonthName = monthNames[currentMonth];
    const transactionId = `TRX-${Date.now()}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;

    if (choice === '1') {
      for (const monthData of arrears) {
        const [year, month] = monthData.key.split('-');
        await this.dataManager.setPaymentForMonth(
          contact.id, 
          parseInt(year), 
          parseInt(month), 
          PAYMENT_STATUS.PAID
        );
      }
      
      this.clearSession(sender);
      const contactUpdated = this.dataManager.contacts.get(contact.id);
      await this.sendPaymentNotification(contactUpdated, transactionId, 'ARREARS-ONLY');
      
      return msg.reply(
        `✅ Tunggakan ${contact.name} telah dicatat lunas.\n\n` +
        `Tunggakan yang lunas:\n${arrears.map(a => `  ✓ ${a.monthName}`).join('\n')}\n\n` +
        `Catatan: Bulan ${currentMonthName} ${currentYear} BELUM lunas.\n\n` +
        `ID Transaksi: ${transactionId}`
      );
    }
    
    if (choice === '2') {
      for (const monthData of arrears) {
        const [year, month] = monthData.key.split('-');
        await this.dataManager.setPaymentForMonth(
          contact.id, 
          parseInt(year), 
          parseInt(month), 
          PAYMENT_STATUS.PAID
        );
      }
      await this.dataManager.setPaymentForMonth(contact.id, currentYear, currentMonth, PAYMENT_STATUS.PAID);
      
      this.clearSession(sender);
      const contactUpdated = this.dataManager.contacts.get(contact.id);
      await this.sendPaymentNotification(contactUpdated, transactionId, 'FULL-PAID');
      
      return msg.reply(
        `✅ Semua tagihan ${contact.name} LUNAS!\n\n` +
        `Tunggakan yang lunas:\n${arrears.map(a => `  ✓ ${a.monthName}`).join('\n')}\n  ✓ ${currentMonthName} (bulan ini)\n\n` +
        `ID Transaksi: ${transactionId}`
      );
    }
    
    if (choice === '3') {
      await this.dataManager.setPaymentForMonth(contact.id, currentYear, currentMonth, PAYMENT_STATUS.PAID);
      
      this.clearSession(sender);
      const contactUpdated = this.dataManager.contacts.get(contact.id);
      await this.sendPaymentNotification(contactUpdated, transactionId, 'CURRENT-ONLY');
      
      return msg.reply(
        `⚠️ *PEMBAYARAN BULAN INI SAJA*\n\n` +
        `Bulan ${currentMonthName} ${currentYear} sudah lunas.\n` +
        `Tunggakan ${arrears.length} bulan tetap ADA:\n${arrears.map(a => `  • ${a.monthName}`).join('\n')}\n\n` +
        `Silakan bayar tunggakan segera untuk menghindari suspend.\n\n` +
        `ID Transaksi: ${transactionId}`
      );
    }
  }

  async sendPaymentNotification(contact, transactionId, paymentType = 'DEFAULT') {
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

    if (paymentType === 'ARREARS-ONLY') {
      noteText = "Pembayaran tunggakan telah kami terima. Catatan: Bulan ini masih belum lunas.";
    } else if (paymentType === 'CURRENT-ONLY') {
      noteText = "Pembayaran bulan ini telah kami terima. Namun Anda masih memiliki tunggakan bulan sebelumnya. Silakan lunasi agar layanan tidak terputus.";
    } else if (paymentType === 'FULL-PAID') {
      noteText = "Semua tagihan (tunggakan + bulan ini) telah lunas. Terima kasih atas kelancarannya!";
    }

    const message = 
`*BUKTI PEMBAYARAN EMMERIL HOTSPOT*

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

    try {
      await this.sendMessage(contact.phoneNumber, message);
      console.log("📤 Notifikasi pembayaran terkirim:", contact.phoneNumber, "| TRX:", transactionId);
    } catch (err) {
      console.error("❌ Gagal kirim notifikasi:", err.message);
    }
  }

  async handleStatusBayar(msg) {
    const contacts = this.dataManager.getSortedContacts();
    if (contacts.length === 0) return msg.reply("📭 Belum ada kontak.");

    const paid = contacts.filter(c => c.paymentStatus === PAYMENT_STATUS.PAID);
    const unpaid = contacts.filter(c => c.paymentStatus !== PAYMENT_STATUS.PAID);

    let text = "📊 *LAPORAN PEMBAYARAN*\n\n";
    text += `✅ *Sudah Dibayar* (${paid.length}):\n`;
    if (paid.length > 0) {
      text += paid.map(c => `  * ${c.name}`).join("\n") + "\n\n";
    } else {
      text += "  (tidak ada)\n\n";
    }

    text += `⏳ *Belum Dibayar* (${unpaid.length}):\n`;
    if (unpaid.length > 0) {
      text += unpaid.map(c => `  * ${c.name}`).join("\n");
    } else {
      text += "  (tidak ada)";
    }

    msg.reply(text);
  }

  async handleLaporan(msg, sender) {
    const port = CONFIG.PORT;
    const reportUrl = `http://localhost:${port}/report`;
    const text = `📊 *LINK LAPORAN PEMBAYARAN*\n\n` +
      `Klik link berikut untuk membuka dashboard laporan:\n\n` +
      `🔗 ${reportUrl}\n\n` +
      `Fitur:\n` +
      `* Lihat data pembayaran per bulan\n` +
      `* Bandingkan dengan bulan sebelumnya\n` +
      `* Export ke Excel & PDF\n` +
      `* Filter berdasarkan periode\n\n` +
      `Buka di browser (Chrome/Edge/Firefox)`;
    msg.reply(text);
  }

  async handleTunggakan(msg, sender) {
    const contacts = this.dataManager.getSortedContacts();
    if (contacts.length === 0) return msg.reply("📭 Belum ada kontak.");

    const now = new Date();
    const currentMonth = now.getMonth() + 1;
    const currentYear = now.getFullYear();
    const prevMonth = currentMonth === 1 ? 12 : currentMonth - 1;
    const prevYear = currentMonth === 1 ? currentYear - 1 : currentYear;
    const prevKey = `${prevYear}-${String(prevMonth).padStart(2, "0")}`;
    const currKey = `${currentYear}-${String(currentMonth).padStart(2, "0")}`;

    const monthNames = ["", "Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"];
    const systemStartMonth = 4;
    const systemStartYear = 2026;
    const isPrevBeforeSystem = prevYear < systemStartYear || (prevYear === systemStartYear && prevMonth < systemStartMonth);

    const overdue = [];
    for (const contact of contacts) {
      const pm = contact.paymentMonths || {};
      const currPaid = pm[currKey]?.status === PAYMENT_STATUS.PAID;
      const prevPaid = pm[prevKey]?.status === PAYMENT_STATUS.PAID;
      
      const reasons = [];
      if (!currPaid) reasons.push(`${monthNames[currentMonth]}`);
      if (!prevPaid && !isPrevBeforeSystem) reasons.push(`${monthNames[prevMonth]}`);
      
      if (reasons.length > 0) {
        overdue.push({ contact, reasons: reasons.join(", "), currPaid, prevPaid });
      }
    }

    if (overdue.length === 0) {
      return msg.reply(`🎉 *SEMUA TAGIHAN LUNAS!*\n\nSemua kontak sudah membayar untuk bulan ${monthNames[currentMonth]} ${currentYear}.`);
    }

    let text = `⚠️ *LAPORAN TUNGGAKAN*\n`;
    text += `📅 Periode: ${monthNames[currentMonth]} ${currentYear}\n\n`;
    text += `Catatan: Bulan sebelum sistem dimulai (sebelum April 2026) tidak dihitung.\n\n`;
    text += `Terdapat ${overdue.length} kontak dengan tagihan belum lunas:\n\n`;
    text += overdue.map((o, i) => {
      const indicator = o.currPaid ? "🟡" : "🔴";
      const status = o.currPaid ? "(Bulan ini LUNAS) " : "(Bulan ini BELUM) ";
      return `${indicator} ${o.contact.name}\n   ${status}Belum: ${o.reasons}`;
    }).join("\n\n");

    text += `\n\n━━━━━━━━━━━━━━━━━━━━\n`;
    text += `📋 *KETERANGAN:*\n`;
    text += `🔴 = Tunggakan berat (bulan ini + sebelumnya)\n`;
    text += `🟡 = Tunggakan ringan (bulan sebelumnya saja)\n\n`;
    text += `💡 *CARA MENGATASI:*\n`;
    text += `Gunakan !bayar lalu pilih kontak.\n`;
    text += `Sistem akan menawarkan 3 opsi:\n`;
    text += `  1. Bayar tunggakan saja\n`;
    text += `  2. Bayar tunggakan + bulan ini\n`;
    text += `  3. Bayar bulan ini saja\n`;

    msg.reply(text);
  }

  async handleRiwayatTagihan(msg, sender) {
    const contacts = this.dataManager.getSortedContacts();
    if (contacts.length === 0) return msg.reply("📭 Belum ada kontak.");

    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth() + 1;
    const monthNames = ["", "Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"];
    const systemStartMonth = 4;
    const systemStartYear = 2026;

    let text = `📜 *RIWAYAT TAGIHAN PER KONTAK*\n\n`;

    for (const contact of contacts.slice(0, 10)) {
      const pm = contact.paymentMonths || {};
      const paidMonths = [];
      const unpaidMonths = [];

      for (let m = systemStartMonth; m <= currentMonth; m++) {
        const key = `${currentYear}-${String(m).padStart(2, "0")}`;
        if (pm[key]?.status === PAYMENT_STATUS.PAID) {
          paidMonths.push(monthNames[m]);
        } else {
          unpaidMonths.push(monthNames[m]);
        }
      }

      if (paidMonths.length > 0 || unpaidMonths.length > 0) {
        text += `📱 ${contact.name}\n`;
        if (paidMonths.length > 0) {
          text += `   ✅ Lunas: ${paidMonths.map(m => m.slice(0, 3)).join(", ")}\n`;
        }
        if (unpaidMonths.length > 0) {
          text += `   ⏳ Belum: ${unpaidMonths.map(m => m.slice(0, 3)).join(", ")}\n`;
        }
        text += `\n`;
      } else {
        text += `📱 ${contact.name}\n   ⏳ Belum ada pembayaran\n\n`;
      }
    }

    if (contacts.length > 10) {
      text += `\n...dan ${contacts.length - 10} kontak lainnya.\n`;
    }

    text += `\n\nGunakan !laporan untuk melihat detail lengkap di web.`;
    msg.reply(text);
  }

  async handleSetAdmin(msg, sender, body) {
    const rawNumber = body.split(' ')[1];
    if (!rawNumber) return msg.reply("❌ Format salah. Gunakan: !setadmin 628xxx");

    const newAdminNumber = normalizePhoneNumber(rawNumber);
    if (!isValidPhoneNumber(newAdminNumber)) {
      return msg.reply("❌ Nomor admin tidak valid. Gunakan format 628xxx.");
    }

    await this.dataManager.addAdmin(newAdminNumber);
    msg.reply(`✅ ${newAdminNumber} sekarang menjadi admin.`);
  }

  async sendHelp(msg, sender) {
    const umum = [
      "📖 *Menu Bantuan*",
      "",
      "* !help / !menu – tampilkan bantuan",
      "* !cancel – batalkan proses",
    ];
    const admin = [
      "",
      "🛠️ *Perintah Admin:*",
      "* !addreminder – tambah reminder",
      "* !editreminder – ubah reminder",
      "* !deletereminder – hapus reminder",
      "* !listreminder – lihat reminder",
      "* !addkontak – tambah kontak",
      "* !editkontak – ubah kontak",
      "* !deletekontak – hapus kontak",
      "* !listkontak – lihat kontak",
      "* !bayar – tandai sudah lunas",
      "* !statusbayar – laporan pembayaran",
      "* !tunggakan – cek tunggakan",
      "* !riwayattagihan – riwayat tagihan",
      "* !laporan – lihat link laporan",
      "* !setadmin <no> – jadikan admin",
    ];
    const menuText = this.dataManager.isAdmin(sender) ? umum.concat(admin).join("\n") : umum.join("\n");
    msg.reply(menuText);
  }

  // ========== CLIENT LIFECYCLE ==========
  scheduleReconnect() {
    clearTimeout(this.reconnectTimer);

    const now = Date.now();
    if (this.lastReconnectTime && now - this.lastReconnectTime < CONFIG.MIN_RECONNECT_INTERVAL) {
      const waitTime = CONFIG.MIN_RECONNECT_INTERVAL - (now - this.lastReconnectTime);
      console.log(`⏳ Wait ${Math.ceil(waitTime / 1000)}s before reconnect`);
      if (!this.isReconnecting) {
        this.isReconnecting = true;
        this.reconnectTimer = setTimeout(() => {
          this.isReconnecting = false;
          this.scheduleReconnect();
        }, waitTime);
      }
      return false;
    }

    if (this.isReconnecting) return false;

    if (this.reconnectAttempts >= CONFIG.MAX_RECONNECT_ATTEMPTS) {
      console.error("🛑 Max reconnect attempts reached");
      return false;
    }

    this.reconnectAttempts++;
    this.lastReconnectTime = now;
    this.isReconnecting = true;

    const delay = Math.min(30000, CONFIG.RECONNECT_DELAY * Math.pow(2, this.reconnectAttempts));
    console.log(`🔄 Reconnect in ${delay / 1000}s (${this.reconnectAttempts}/${CONFIG.MAX_RECONNECT_ATTEMPTS})`);

    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(async () => {
      try {
        if (this.client) {
          await this.client.destroy().catch(() => {});
          this.client = null;
        }
        this.client = this.createClient();
        this.setupEvents();
        await this.client.initialize();
      } catch (err) {
        console.error("❌ Reconnect failed:", err.message);
        this.isReconnecting = false;
        this.scheduleReconnect();
      } finally {
        setTimeout(() => {
          if (!this.isReady) this.isReconnecting = false;
        }, 15000);
      }
    }, delay);
    return true;
  }

  async initialize() {
    if (!this.client) {
      this.client = this.createClient();
      this.setupEvents();
    }
    try {
      await this.client.initialize();
    } catch (error) {
      console.error("❌ Failed to initialize WhatsApp:", error.message);
      this.scheduleReconnect();
    }
  }

  startKeepAlive() {
    if (this.keepAliveTimer) return;
    this.keepAliveTimer = setInterval(async () => {
      if (!this.client || !this.isReady) return;
      try {
        await this.client.getState();
        this.reconnectAttempts = 0;
        console.log("💓 WA keep-alive OK");
      } catch {
        console.log("💔 WA keep-alive failed");
        this.isReady = false;
        this.scheduleReconnect();
      }
    }, CONFIG.KEEP_ALIVE_INTERVAL);
  }

  async sendMessage(phoneNumber, message) {
    if (!this.isReady) throw new Error("WhatsApp not ready");
    await this.client.sendMessage(`${phoneNumber}@c.us`, message);
  }
}

// ==================== REMINDER SCHEDULER ====================
class ReminderScheduler {
  constructor(whatsAppClient, dataManager) {
    this.whatsAppClient = whatsAppClient;
    this.dataManager = dataManager;
    this.isProcessing = false;
  }

  async processDueReminders() {
    if (this.isProcessing) {
      console.log('⏳ Skip cron - previous run still processing');
      return;
    }

    if (!this.whatsAppClient.isReady) {
      console.log('⏳ Skip cron - WhatsApp not ready');
      return;
    }

    this.isProcessing = true;
    try {
      const now = Date.now();
      const due = Array.from(this.dataManager.reminders.entries()).filter(
        ([, r]) => new Date(r.reminderDateTime).getTime() <= now
      );

      if (due.length === 0) return;

      console.log(`⏰ Processing ${due.length} due reminders...`);

      for (const [id, reminder] of due) {
        try {
          await this.whatsAppClient.sendMessage(reminder.phoneNumber, reminder.message);
          console.log("📤 Reminder terkirim:", reminder.phoneNumber);

          for (const [nomor, role] of this.dataManager.roles.entries()) {
            if (role === "admin" && nomor !== reminder.phoneNumber) {
              await this.whatsAppClient.sendMessage(
                nomor,
                `📥 Reminder terkirim ke ${reminder.phoneNumber}:\n\n${reminder.message}`
              ).catch(() => {});
            }
          }

          await this.dataManager.moveToSent(id);

          const next = addMonthsSafely(reminder.reminderDateTime, 1);
          const nextDate = formatDate(next);
          const bulan = next.toLocaleString("id-ID", { month: "long" });

          const newMessage = reminder.message
            .replace(/\d{4}-\d{2}-\d{2}/, nextDate)
            .replace(/bulan \w+/gi, `bulan ${bulan}`);

          const newReminder = {
            id: generateId(),
            phoneNumber: reminder.phoneNumber,
            reminderDateTime: next,
            message: newMessage,
          };
          await this.dataManager.addReminder(newReminder);
        } catch (err) {
          console.error("❌ Gagal kirim:", err.message);
          if (err.message.includes('closed') || err.message.includes('disconnected')) {
            console.log('🔁 Connection error, triggering reconnect...');
            this.whatsAppClient.scheduleReconnect();
            break;
          }
        }
      }
    } finally {
      this.isProcessing = false;
    }
  }
}

// ==================== EXPRESS SERVER ====================
class WebServer {
  constructor(whatsAppClient, dataManager) {
    this.app = express();
    this.whatsAppClient = whatsAppClient;
    this.dataManager = dataManager;
    this.setupRoutes();
  }

  setupRoutes() {
    this.app.use(express.json());
    this.app.use(express.urlencoded({ extended: true }));

    const requireApiKey = (req, res, next) => {
      const apiKey = req.headers['x-api-key'] || req.query.api_key;
      if (!apiKey || apiKey !== CONFIG.WEB_API_KEY) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
      }
      next();
    };

    this.app.get("/qr", async (req, res) => {
      if (this.whatsAppClient.isReady) {
        return res.send(`
          <html><body style="display:flex;justify-content:center;align-items:center;height:100vh;background:#f2f2f2;font-family:sans-serif;">
            <div style="font-size:1.5rem;color:#28a745;">✅ WhatsApp sudah terhubung.</div>
          </body></html>
        `);
      }
      if (!this.whatsAppClient.currentQR) {
        return res.send("⏳ Menunggu QR code...");
      }
      const qrImage = await QRCode.toDataURL(this.whatsAppClient.currentQR);
      res.send(`
        <html>
          <head><title>Scan QR</title><meta http-equiv="refresh" content="15"></head>
          <body style="text-align:center;font-family:sans-serif;">
            <h1>Scan QR WhatsApp</h1>
            <img src="${qrImage}" style="max-width:300px;border:8px solid #fff;border-radius:10px;">
            <p>Scan dengan WhatsApp.</p>
            <p>Reconnect attempts: ${this.whatsAppClient.reconnectAttempts}/${CONFIG.MAX_RECONNECT_ATTEMPTS}</p>
          </body>
        </html>
      `);
    });

    this.app.get("/api/payments/history", requireApiKey, (req, res) => {
      const history = this.dataManager.getAllPaymentsHistory();
      res.json({ success: true, data: history });
    });

    this.app.get("/api/payments/:year/:month", requireApiKey, (req, res) => {
      const { year, month } = req.params;
      const yearNum = parseInt(year, 10);
      const monthNum = parseInt(month, 10);
      if (isNaN(yearNum) || isNaN(monthNum) || yearNum < 2000 || yearNum > 2100 || monthNum < 1 || monthNum > 12) {
        return res.status(400).json({ success: false, error: 'Invalid year or month' });
      }
      const payments = this.dataManager.getPaymentsByMonth(yearNum, monthNum);
      res.json({
        success: true,
        data: payments.map(c => ({
          id: c.id,
          name: c.name,
          phoneNumber: c.phoneNumber,
          paymentDate: c.paymentDate,
          paymentStatus: c.paymentStatus,
        })),
      });
    });

    this.app.get("/api/payments/current", requireApiKey, (req, res) => {
      const now = new Date();
      const currentYear = now.getFullYear();
      const currentMonth = now.getMonth() + 1;
      const payments = this.dataManager.getPaymentsByMonth(currentYear, currentMonth);
      const allHistory = this.dataManager.getAllPaymentsHistory();

      const prevMonth = currentMonth === 1 ? 12 : currentMonth - 1;
      const prevYear = currentMonth === 1 ? currentYear - 1 : currentYear;
      const prevPayments = allHistory[`${prevYear}-${String(prevMonth).padStart(2, "0")}`]?.total || 0;

      const currentTotal = payments.length;
      const growth = prevPayments > 0 ? ((currentTotal - prevPayments) / prevPayments * 100).toFixed(1) : 0;

      res.json({
        success: true,
        data: {
          current: { year: currentYear, month: currentMonth, total: currentTotal, contacts: payments },
          previous: { year: prevYear, month: prevMonth, total: prevPayments },
          growth: parseFloat(growth),
        },
      });
    });

    this.app.get("/report", (req, res) => {
      const history = this.dataManager.getAllPaymentsHistory();
      const now = new Date();
      const currentYear = now.getFullYear();
      const currentMonth = now.getMonth() + 1;

      const currentPayments = this.dataManager.getPaymentsByMonth(currentYear, currentMonth);
      const totalContacts = this.dataManager.contacts.size;
      const paidContacts = Array.from(this.dataManager.contacts.values()).filter(c => c.paymentStatus === PAYMENT_STATUS.PAID).length;
      const unpaidContacts = totalContacts - paidContacts;

      const prevMonth = currentMonth === 1 ? 12 : currentMonth - 1;
      const prevYear = currentMonth === 1 ? currentYear - 1 : currentYear;
      const prevPayments = history[`${prevYear}-${String(prevMonth).padStart(2, "0")}`]?.total || 0;
      const currentTotal = currentPayments.length;

      const growth = prevPayments > 0 ? ((currentTotal - prevPayments) / prevPayments * 100).toFixed(1) : "0";

      const monthNames = ["", "Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"];

      const safeHistory = JSON.stringify(history).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
      const tableRows = currentPayments.map((c, i) => {
        const name = escapeHtml(c.name);
        const phone = escapeHtml(c.phoneNumber);
        const paymentDate = c.paymentDate ? new Date(c.paymentDate).toLocaleString('id-ID') : '-';
        return `<tr><td>${i + 1}</td><td>${name}</td><td>${phone}</td><td>${paymentDate}</td><td class="status-paid">✅ Lunas</td></tr>`;
      }).join('');

      res.send(`
<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Laporan Pembayaran</title>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js"></script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js"></script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.1/jspdf.plugin.autotable.min.js"></script>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: #f5f7fa; padding: 20px; }
    .container { max-width: 1200px; margin: 0 auto; }
    h1 { color: #2c3e50; margin-bottom: 20px; }
    .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 30px; flex-wrap: wrap; gap: 15px; }
    .controls { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
    select, input { padding: 10px 15px; border: 1px solid #ddd; border-radius: 8px; font-size: 14px; }
    button { padding: 10px 20px; border: none; border-radius: 8px; cursor: pointer; font-size: 14px; transition: all 0.3s; }
    .btn-primary { background: #3498db; color: white; }
    .btn-primary:hover { background: #2980b9; }
    .btn-success { background: #27ae60; color: white; }
    .btn-success:hover { background: #219a52; }
    .btn-danger { background: #e74c3c; color: white; }
    .btn-danger:hover { background: #c0392b; }
    .metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 20px; margin-bottom: 30px; }
    .metric-card { background: white; padding: 25px; border-radius: 12px; box-shadow: 0 2px 10px rgba(0,0,0,0.08); }
    .metric-card h3 { color: #7f8c8d; font-size: 14px; font-weight: 500; margin-bottom: 10px; }
    .metric-card .value { font-size: 32px; font-weight: 700; color: #2c3e50; }
    .metric-card .value.positive { color: #27ae60; }
    .metric-card .value.negative { color: #e74c3c; }
    .metric-card .value.neutral { color: #f39c12; }
    .comparison { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 20px; margin-bottom: 30px; }
    .comparison-card { background: white; padding: 25px; border-radius: 12px; box-shadow: 0 2px 10px rgba(0,0,0,0.08); }
    .comparison-card h3 { color: #2c3e50; margin-bottom: 20px; padding-bottom: 10px; border-bottom: 2px solid #ecf0f1; }
    .comparison-row { display: flex; justify-content: space-between; padding: 12px 0; border-bottom: 1px solid #f5f7fa; }
    .comparison-row:last-child { border-bottom: none; }
    .comparison-row .label { color: #7f8c8d; }
    .comparison-row .value { font-weight: 600; color: #2c3e50; }
    .table-container { background: white; border-radius: 12px; box-shadow: 0 2px 10px rgba(0,0,0,0.08); overflow: hidden; }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 15px; text-align: left; }
    th { background: #34495e; color: white; font-weight: 500; }
    tr:nth-child(even) { background: #f8f9fa; }
    tr:hover { background: #ecf0f1; }
    .status-paid { color: #27ae60; font-weight: 600; }
    .status-unpaid { color: #e74c3c; font-weight: 600; }
    .month-selector { display: flex; gap: 15px; align-items: center; margin-bottom: 20px; }
    .history-list { display: flex; gap: 5px; flex-wrap: wrap; margin-top: 20px; }
    .history-month { padding: 8px 15px; background: #ecf0f1; border-radius: 20px; font-size: 12px; cursor: pointer; }
    .history-month.active { background: #3498db; color: white; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>📊 Laporan Pembayaran</h1>
      <div class="controls">
        <button class="btn-success" onclick="exportExcel()">📊 Export Excel</button>
        <button class="btn-danger" onclick="exportPDF()">📄 Export PDF</button>
      </div>
    </div>

    <div class="month-selector">
      <label>Bulan:</label>
      <select id="monthSelect">
        ${monthNames.map((m, i) => `<option value="${i}" ${i === currentMonth ? 'selected' : ''}>${escapeHtml(m)}</option>`).join('')}
      </select>
      <label>Tahun:</label>
      <select id="yearSelect">
        ${Array.from({length: 5}, (_, i) => currentYear - i).map(y => `<option value="${y}" ${y === currentYear ? 'selected' : ''}>${y}</option>`).join('')}
      </select>
      <button class="btn-primary" onclick="loadReport()">Tampilkan</button>
    </div>

    <div class="metrics">
      <div class="metric-card">
        <h3>💰 Total Pembayaran Bulan Ini</h3>
        <div class="value positive">${currentTotal}</div>
      </div>
      <div class="metric-card">
        <h3>📈 Pertumbuhan (vs Bulan Lalu)</h3>
        <div class="value ${parseFloat(growth) >= 0 ? 'positive' : 'negative'}">${growth}%</div>
      </div>
      <div class="metric-card">
        <h3>✅ Sudah Dibayar</h3>
        <div class="value">${paidContacts}</div>
      </div>
      <div class="metric-card">
        <h3>⏳ Belum Dibayar</h3>
        <div class="value negative">${unpaidContacts}</div>
      </div>
    </div>

    <div class="comparison">
      <div class="comparison-card">
        <h3>📅 Periode Saat Ini (${monthNames[currentMonth]} ${currentYear})</h3>
        <div class="comparison-row">
          <span class="label">Total Pembayaran</span>
          <span class="value">${currentTotal}</span>
        </div>
        <div class="comparison-row">
          <span class="label">Kontak Aktif</span>
          <span class="value">${totalContacts}</span>
        </div>
      </div>
      <div class="comparison-card">
        <h3>📆 Periode Sebelumnya (${monthNames[prevMonth]} ${prevYear})</h3>
        <div class="comparison-row">
          <span class="label">Total Pembayaran</span>
          <span class="value">${prevPayments}</span>
        </div>
        <div class="comparison-row">
          <span class="label">Perubahan</span>
          <span class="value ${parseFloat(growth) >= 0 ? 'positive' : 'negative'}">${parseFloat(growth) >= 0 ? '+' : ''}${growth}%</span>
        </div>
      </div>
    </div>

    <div class="table-container">
      <table>
        <thead>
          <tr>
            <th>No</th>
            <th>Nama</th>
            <th>No. HP</th>
            <th>Tanggal Bayar</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody id="paymentTable">
          ${tableRows}
        </tbody>
      </table>
    </div>
  </div>

  <script>
    let currentData = ${safeHistory};
    let selectedMonth = ${currentMonth};
    let selectedYear = ${currentYear};

    function escapeHtml(str) {
      if (typeof str !== "string") return str;
      return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
    }

    function formatDate(dateStr) {
      if (!dateStr) return '-';
      return new Date(dateStr).toLocaleString('id-ID');
    }

    function loadReport() {
      const month = document.getElementById('monthSelect').value;
      const year = document.getElementById('yearSelect').value;
      selectedMonth = parseInt(month);
      selectedYear = parseInt(year);
      
      fetch('/api/payments/' + year + '/' + month)
        .then(r => r.json())
        .then(res => {
          const tbody = document.getElementById('paymentTable');
          if (res.data.length === 0) {
            tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#7f8c8d;">Tidak ada data</td></tr>';
          } else {
            tbody.innerHTML = res.data.map((c, i) => '<tr><td>' + (i+1) + '</td><td>' + escapeHtml(c.name) + '</td><td>' + escapeHtml(c.phoneNumber) + '</td><td>' + formatDate(c.paymentDate) + '</td><td class="status-paid">✅ Lunas</td></tr>').join('');
          }
        });
    }

    function exportExcel() {
      fetch('/api/payments/' + selectedYear + '/' + selectedMonth)
        .then(r => r.json())
        .then(res => {
          const data = res.data.map((c, i) => [i+1, c.name, c.phoneNumber, c.paymentDate ? new Date(c.paymentDate).toLocaleString('id-ID') : '-', 'Lunas']);
          data.unshift(['No', 'Nama', 'No. HP', 'Tanggal Bayar', 'Status']);
          
          const ws = XLSX.utils.aoa_to_sheet(data);
          const wb = XLSX.utils.book_new();
          XLSX.utils.book_append_sheet(wb, ws, 'Pembayaran');
          XLSX.writeFile(wb, 'Laporan_Pembayaran_' + selectedYear + '_' + selectedMonth + '.xlsx');
        });
    }

    function exportPDF() {
      const { jsPDF } = window.jspdf;
      const doc = new jsPDF();
      
      doc.setFontSize(18);
      doc.text('Laporan Pembayaran', 14, 20);
      doc.setFontSize(12);
      doc.text('Bulan: ' + selectedMonth + '/' + selectedYear, 14, 30);
      
      fetch('/api/payments/' + selectedYear + '/' + selectedMonth)
        .then(r => r.json())
        .then(res => {
          const rows = res.data.map((c, i) => [i+1, c.name, c.phoneNumber, c.paymentDate ? new Date(c.paymentDate).toLocaleString('id-ID') : '-', 'Lunas']);
          doc.autoTable({
            head: [['No', 'Nama', 'No. HP', 'Tanggal Bayar', 'Status']],
            body: rows,
            startY: 40,
          });
          doc.save('Laporan_Pembayaran_' + selectedYear + '_' + selectedMonth + '.pdf');
        });
    }
  </script>
</body>
</html>
      `);
    });
  }

  start(port) {
    this.app.listen(port, () => {
      console.log(`🌐 Web server running at http://localhost:${port}/qr`);
      console.log(`📊 Report dashboard: http://localhost:${port}/report`);
    });
  }
}

// ==================== MAIN ====================
(async () => {
  const dataManager = new DataManager();
  await dataManager.loadAll();

  const sessionManager = new SessionManager();
  const templateManager = new TemplateManager();
  const whatsAppClient = new WhatsAppClient(dataManager, sessionManager, templateManager);
  const reminderScheduler = new ReminderScheduler(whatsAppClient, dataManager);
  const webServer = new WebServer(whatsAppClient, dataManager);

  // Start WhatsApp
  await whatsAppClient.initialize();
  whatsAppClient.startKeepAlive();

  // Start cron job
  cron.schedule(CONFIG.CRON_SCHEDULE, () => {
    reminderScheduler.processDueReminders().catch(error => {
      console.error('❌ Cron job failed:', error.message);
    });
  });

  cron.schedule(CONFIG.RESET_PAYMENT_SCHEDULE, async () => {
    console.log('🔄 Resetting payment status for new month...');
    const count = await dataManager.resetAllPaymentStatus();
    const now = new Date();
    const currentMonth = now.getMonth() + 1;
    const currentYear = now.getFullYear();
    const prevMonth = currentMonth === 1 ? 12 : currentMonth - 1;
    const prevYear = currentMonth === 1 ? currentYear - 1 : currentYear;
    const overdue = dataManager.getOverdueContacts(prevYear, prevMonth);
    const monthNames = ["", "Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"];

    for (const [nomor, role] of dataManager.roles.entries()) {
      if (role === "admin") {
        let notif = `📢 *RESET PEMBAYARAN*\n\nStatus pembayaran telah direset untuk bulan baru.\n\n`;
        if (overdue.length > 0) {
          notif += `⚠️ *${overdue.length} TAGIHAN BELUM LUNAS* dari bulan ${monthNames[prevMonth]}:\n\n`;
          notif += overdue.slice(0, 5).map((o, i) => `${i + 1}. ${o.name}`).join("\n");
          if (overdue.length > 5) notif += `\n...dan ${overdue.length - 5} lainnya`;
        } else {
          notif += `✅ Semua tagihan bulan lalu sudah lunas!`;
        }
        try {
          await whatsAppClient.sendMessage(nomor, notif);
        } catch (e) { /* ignore */ }
      }
    }
  });

  // Auto-save dan backup berkala
  setInterval(() => {
    dataManager.saveAll().catch(error => {
      console.error('❌ Auto-save failed:', error.message);
    });
  }, CONFIG.AUTO_SAVE_INTERVAL);
  setInterval(() => {
    dataManager.createBackup().catch(error => {
      console.error('❌ Backup failed:', error.message);
    });
  }, CONFIG.BACKUP_INTERVAL);

  // Cleanup session setiap jam
  setInterval(() => sessionManager.cleanupStaleSessions(), 60 * 60 * 1000);

  // Graceful shutdown
  process.on('SIGINT', async () => {
    console.log('\n🔄 Menyimpan data sebelum shutdown...');
    await dataManager.saveAll();
    process.exit(0);
  });

  process.on('uncaughtException', async (err) => {
    console.error('❌ Uncaught Exception:', err);
    await dataManager.saveAll();
    process.exit(1);
  });

  process.on('unhandledRejection', async (reason) => {
    console.error('❌ Unhandled Rejection:', reason);
    await dataManager.saveAll();
    process.exit(1);
  });

  webServer.start(CONFIG.PORT);
})();
