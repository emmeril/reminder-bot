const fs = require("fs/promises");
const path = require("path");
const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const QRCode = require("qrcode");
const express = require("express");
const cron = require("node-cron");

// ==================== KONFIGURASI ====================
const CONFIG = {
  PORT: 3025,
  DB_PATH: path.join(__dirname, "database"),
  TEMPLATE_PATH: path.join(__dirname, "templates"),
  AUTO_SAVE_INTERVAL: 24 * 60 * 60 * 1000, // 24 jam
  BACKUP_INTERVAL: 24 * 60 * 60 * 1000, // 24 jam
  SESSION_TIMEOUT: 60 * 60 * 1000, // 1 jam
  KEEP_ALIVE_INTERVAL: 5 * 60 * 1000, // 5 menit
  MAX_RECONNECT_ATTEMPTS: 10,
  MIN_RECONNECT_INTERVAL: 30000, // 30 detik
  RECONNECT_DELAY: 5000, // 5 detik
  CRON_SCHEDULE: "*/1 * * * *", // setiap menit
};

// ==================== UTILITY FUNCTIONS ====================
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const HELP_COMMANDS = new Set(["!help", "!menu"]);
const ALLOWED_NON_ADMIN_COMMANDS = HELP_COMMANDS;
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
};

const generateId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

const parseDateTimeInput = (input) => {
  const match = input.trim().match(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})$/);
  if (!match) return null;

  const [, tanggal, jam] = match;
  const date = new Date(`${tanggal}T${jam}:00`);
  if (Number.isNaN(date.getTime())) return null;

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

  // Lock mechanism
  async acquireLock(filePath) {
    while (this.fileLocks.has(filePath)) {
      await sleep(10);
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
}

// ==================== SESSION MANAGER ====================
class SessionManager {
  constructor() {
    this.sessions = new Map();
  }

  createSession(sender, data) {
    this.sessions.set(sender, { ...data, lastActivity: Date.now() });
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
      message = message.replace(new RegExp(`{{${key}}}`, 'gi'), value);
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

    return `${index + 1}. ${nama} — ${waktu} WIB\n   💬 ${reminder.message}`;
  }

  formatContactDisplay(contact, index, multiline = false) {
    if (multiline) {
      return `${index + 1}. ${contact.name}\n   📞 ${contact.phoneNumber}`;
    }

    return `${index + 1}. ${contact.name} | ${contact.phoneNumber}`;
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
          "https://raw.githubusercontent.com/wppconnect-team/wa-version/refs/heads/main/html/2.3000.1033090211-alpha.html",
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
      return `${i + 1}. ${nama} — ${waktu} WIB\n   💬 ${r.message}`;
    }).join("\n\n");

    msg.reply(`📌 Reminder Aktif:\n\n${list}`);
  }

  // ========== CONTACT HANDLERS ==========
  async handleAddContact(msg, sender) {
    this.createSession(sender, { step: SESSION_STEPS.ADD_CONTACT_NAME });
    msg.reply("📝 Masukkan nama kontak:");
  }

  async handleAddContactName(msg, sender, body, session) {
    this.createSession(sender, { ...session, nama: body, step: SESSION_STEPS.ADD_CONTACT_NUMBER });
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
    };
    await this.dataManager.addContact(newContact);
    this.clearSession(sender);
    msg.reply(`✅ Kontak berhasil ditambahkan:\n${newContact.name} | ${newContact.phoneNumber}`);
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
    this.createSession(sender, { ...session, newName: body, step: SESSION_STEPS.EDIT_CONTACT_NUMBER });
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

    const list = contacts.map((c, i) => `${i + 1}. ${c.name}\n   📞 ${c.phoneNumber}`).join("\n\n");
    msg.reply(`📇 Daftar Kontak:\n\n${list}`);
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
      "• !help / !menu – tampilkan bantuan",
      "• !cancel – batalkan proses",
    ];
    const admin = [
      "",
      "🛠️ *Perintah Admin:*",
      "• !addreminder – tambah reminder",
      "• !editreminder – ubah reminder",
      "• !deletereminder – hapus reminder",
      "• !listreminder – lihat reminder",
      "• !addkontak – tambah kontak",
      "• !editkontak – ubah kontak",
      "• !deletekontak – hapus kontak",
      "• !listkontak – lihat kontak",
      "• !setadmin <no> – jadikan admin",
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
  constructor(whatsAppClient) {
    this.app = express();
    this.whatsAppClient = whatsAppClient;
    this.setupRoutes();
  }

  setupRoutes() {
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
  }

  start(port) {
    this.app.listen(port, () => {
      console.log(`🌐 Web server running at http://localhost:${port}/qr`);
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
  const webServer = new WebServer(whatsAppClient);

  // Start WhatsApp
  await whatsAppClient.initialize();
  whatsAppClient.startKeepAlive();

  // Start cron job
  cron.schedule(CONFIG.CRON_SCHEDULE, () => {
    reminderScheduler.processDueReminders().catch(error => {
      console.error('❌ Cron job failed:', error.message);
    });
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
