require("dotenv").config();

const fs = require("fs/promises");
const fsSync = require("fs");
const path = require("path");
const express = require("express");
const cron = require("node-cron");
const crypto = require("crypto");
const qrcode = require("qrcode-terminal");
const QRCode = require("qrcode");
const ftp = require("basic-ftp");
const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");
const { RouterOSClient } = require("routeros-client");
const { Sequelize, DataTypes, Op } = require("sequelize");
const {
  CONFIG,
  DEFAULT_SETTINGS,
  MONTH_NAMES,
  PAYMENT_STATUS,
  PAYMENT_TYPES,
  WA_CRITICAL_STATES,
  WA_DISCONNECT_REASONS,
  WA_STATES,
} = require("./config");
const ActivityLog = require("./activity-log");
const AsyncLock = require("./async-lock");
const AuthManager = require("./auth-manager");
const FonnteManager = require("./fonnte-manager");
const MessageQueue = require("./message-queue");
const {
  ApDownNotifier,
  HotspotReactivationScheduler,
  MikrotikBackupScheduler,
  ReminderScheduler,
} = require("./schedulers");
const TemplateManager = require("./template-manager");
const {
  addMonthsSafely,
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
  makeBillingPeriodKey,
  normalizePhoneNumber,
  parseBoolean,
  parseCookies,
  parseDateTimeInput,
  resolveChromeExecutablePath,
  safeCompareString,
  sanitizeInput,
  sanitizeMultilineText,
  sanitizePositiveInteger,
  sanitizeTimeHHMM,
  serializeCookie,
  sleep,
} = require("./utils");

// ===============================
// WHATSAPP MANAGER
// ===============================

class WhatsAppManager {
  constructor(dataManager, activityLog) {
    this.dataManager = dataManager;
    this.activityLog = activityLog;
    this.client = null;
    this.state = WA_STATES.UNLAUNCHED;
    this.isReady = false;
    this.isReconnecting = false;
    this.reconnectAttempts = 0;
    this.lastReconnectTime = null;
    this.currentQR = null;
    this.reconnectTimer = null;
    this.keepAliveTimer = null;
    this.activeProvider = "whatsapp-web";
    this.providerChangeHandler = null;
    this.queue = new MessageQueue(this, dataManager, activityLog);
    this._reconnectLock = new AsyncLock();
    this._stateLock = new AsyncLock();
  }

  setProviderChangeHandler(handler) {
    this.providerChangeHandler = typeof handler === "function" ? handler : null;
  }

  async noteProviderUsed(provider, details = {}) {
    const normalizedProvider = provider === "fonnte" ? "fonnte" : "whatsapp-web";
    if (normalizedProvider === this.activeProvider) return;

    const previousProvider = this.activeProvider;
    this.activeProvider = normalizedProvider;

    if (previousProvider === "whatsapp-web" && normalizedProvider === "fonnte" && this.providerChangeHandler) {
      await this.providerChangeHandler(previousProvider, normalizedProvider, details);
    }
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

  setupEvents() {
    if (!this.client) return;
    this.client.removeAllListeners();

    this.client.on("qr", (qr) => {
      this.currentQR = qr;
      this.state = WA_STATES.PAIRING;
      this.activityLog.push("info", "whatsapp", "QR code generated");
      qrcode.generate(qr, { small: true });
    });

    this.client.on("authenticated", () => {
      this.activityLog.push("info", "whatsapp", "WhatsApp authenticated");
      this.reconnectAttempts = 0;
      this.isReconnecting = false;
      this.state = WA_STATES.OPENING;
    });

    this.client.on("auth_failure", (msg) => {
      this.activityLog.push("error", "whatsapp", `Auth failure: ${msg}`);
      this.state = WA_STATES.UNPAIRED;
      this.scheduleReconnect();
    });

    this.client.on("ready", () => {
      this._stateLock.runExclusive("ready", async () => {
        this.state = WA_STATES.CONNECTED;
        this.isReady = true;
        this.currentQR = null;
        this.reconnectAttempts = 0;
        this.isReconnecting = false;
        this.lastReconnectTime = null;
        this.activityLog.push("info", "whatsapp", "WhatsApp ready");

        this.queue.restoreFailed();
        setTimeout(() => this.queue.process(), CONFIG.WA_INITIALIZATION_DELAY);
      }).catch((error) => {
        this.activityLog.push("error", "whatsapp", "Failed to handle ready", { error: error.message });
      });
    });

    this.client.on("change_state", (newState) => {
      this.activityLog.push("info", "whatsapp", `WA State change: ${newState}`);
      this._stateLock.runExclusive("change_state", async () => {
        this.state = newState;

        if ([WA_STATES.CONNECTED, WA_STATES.OPENING, WA_STATES.PAIRING].includes(newState)) {
          // lastActivity not used in index.js, but keep for potential future use
        }

        if (newState === WA_STATES.CONNECTED) {
          this.isReady = true;
          this.reconnectAttempts = 0;
          this.isReconnecting = false;
        }

        if ([WA_STATES.CONFLICT, WA_STATES.TIMEOUT, WA_STATES.UNPAIRED].includes(newState)) {
          this.isReady = false;
          this.scheduleReconnect();
        }
      }).catch((error) => {
        this.activityLog.push("error", "whatsapp", "Failed to update state", { error: error.message });
      });
    });

    this.client.on("disconnected", async (reason) => {
      this.activityLog.push("info", "whatsapp", `WhatsApp disconnected: ${reason}`);
      await this._stateLock.runExclusive("disconnected", async () => {
        this.state = WA_STATES.UNPAIRED;
        this.isReady = false;
        this.currentQR = null;

        if (WA_DISCONNECT_REASONS.has(reason)) {
          const sessionPath = path.join(CONFIG.DB_PATH, ".wwebjs_auth");
          await fs.rm(sessionPath, { recursive: true, force: true }).catch(() => {});
          this.activityLog.push("info", "whatsapp", "Session cleared");
        }

        this.scheduleReconnect();
      }).catch((error) => {
        this.activityLog.push("error", "whatsapp", "Failed to handle disconnect", { error: error.message });
      });
    });

    this.client.on("error", (error) => {
      this.activityLog.push("error", "whatsapp", `WhatsApp error: ${error.message}`);
      if (!this.isReconnecting && [WA_STATES.UNPAIRED, WA_STATES.UNPAIRED_IDLE, WA_STATES.TIMEOUT].includes(this.state)) {
        this.scheduleReconnect();
      }
    });
  }

  async initialize() {
    return this._stateLock.runExclusive("initialize", async () => {
      if (!this.client) {
        this.client = this.createClient();
        this.setupEvents();
      }

      try {
        await this.client.initialize();
      } catch (error) {
        this.activityLog.push("error", "whatsapp", `Failed to initialize WhatsApp: ${error.message}`);
        this.isReconnecting = false;
        this.scheduleReconnect();
      }
    });
  }

  scheduleReconnect() {
    return this._reconnectLock.runExclusive("schedule", async () => {
      if (this.isReconnecting || this.reconnectAttempts >= CONFIG.WA_MAX_RECONNECT_ATTEMPTS) return;

      const now = Date.now();
      if (this.lastReconnectTime && now - this.lastReconnectTime < CONFIG.WA_MIN_RECONNECT_INTERVAL) {
        const wait = Math.ceil((CONFIG.WA_MIN_RECONNECT_INTERVAL - (now - this.lastReconnectTime)) / 1000);
        this.activityLog.push("info", "whatsapp", `Wait ${wait}s before reconnect`);
        return;
      }

      this.reconnectAttempts++;
      this.lastReconnectTime = now;
      this.isReconnecting = true;
      this.state = WA_STATES.TIMEOUT;

      const delay = Math.min(30000, CONFIG.WA_RECONNECT_DELAY * Math.pow(2, this.reconnectAttempts));
      this.activityLog.push("info", "whatsapp", `Reconnect in ${delay / 1000}s (${this.reconnectAttempts}/${CONFIG.WA_MAX_RECONNECT_ATTEMPTS})`);

      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = setTimeout(() => this.performReconnect(), delay);
    });
  }

  async performReconnect() {
    const release = await this._reconnectLock.acquire("perform");
    try {
      try {
        if (this.client) {
          this.activityLog.push("info", "whatsapp", "Destroying old WhatsApp client");
          await this.client.destroy().catch((error) => {
            this.activityLog.push("warn", "whatsapp", "Failed to destroy old WhatsApp client", { error: error.message });
          });
          this.client = null;
        }

        this.activityLog.push("info", "whatsapp", "Creating new WhatsApp client");
        this.client = this.createClient();
        this.setupEvents();
        await this.client.initialize();
      } catch (error) {
        this.activityLog.push("error", "whatsapp", `Reconnect failed: ${error.message}`);
        this.isReconnecting = false;
        this.scheduleReconnect();
      } finally {
        setTimeout(() => {
          if (this.state !== WA_STATES.CONNECTED) this.isReconnecting = false;
        }, 15000);
      }
    } finally {
      release();
    }
  }

  startKeepAlive() {
    if (this.keepAliveTimer) return;

    this.keepAliveTimer = setInterval(async () => {
      if (!this.client || this.isReconnecting) return;

      try {
        const currentState = await this.client.getState();

        if (currentState !== WA_STATES.CONNECTED || !this.client.pupPage || this.client.pupPage.isClosed()) {
          throw new Error("WhatsApp page not healthy");
        }

        this.activityLog.push("info", "whatsapp", `Keep-alive OK (State: ${currentState})`);

        await this._stateLock.runExclusive("keepalive", async () => {
          this.reconnectAttempts = 0;
          this.isReady = true;

          if (this.state !== currentState) {
            this.activityLog.push("info", "whatsapp", `State sync: ${this.state} -> ${currentState}`);
            this.state = currentState;
          }
        });
      } catch (err) {
        this.activityLog.push("error", "whatsapp", `Keep-alive failed: ${err.message}`);
        await this._stateLock.runExclusive("keepalive_error", async () => {
          this.isReady = false;
          this.state = WA_STATES.TIMEOUT;

          if (this.reconnectAttempts >= CONFIG.WA_MAX_RECONNECT_ATTEMPTS) {
            this.activityLog.push("error", "whatsapp", "Max reconnection attempts reached. Manual intervention required.");
          } else {
            this.scheduleReconnect();
          }
        });
      }
    }, CONFIG.WA_KEEP_ALIVE_INTERVAL);
  }

  async sendMessage(number, message) {
    return this._stateLock.runExclusive("send", async () => {
      try {
        if (this.state !== WA_STATES.CONNECTED) {
          throw new Error(`WhatsApp not ready (State: ${this.state})`);
        }

        if (!this.client || !this.client.pupPage || this.client.pupPage.isClosed()) {
          throw new Error("WhatsApp client or page not available");
        }

        await this.client.getState(); // verify connection

        const formattedNumber = normalizePhoneNumber(number);
        const chatId = `${formattedNumber}@c.us`;

        const result = await this.client.sendMessage(chatId, message, {
          sendSeen: false,
          linkPreview: false,
        });

        this.activityLog.push("info", "whatsapp", `Message sent to ${formattedNumber}`);

        return {
          status: "success",
          message: "Message sent",
          messageId: result.id?.id,
          timestamp: new Date().toISOString(),
        };
      } catch (error) {
        this.activityLog.push("error", "whatsapp", "Send message error", { error: error.message, state: this.state });
        if (error.message.includes("not ready") || error.message.includes("connection")) {
          this.state = WA_STATES.TIMEOUT;
        }
        return {
          status: "error",
          message: error.message,
          waState: this.state,
          timestamp: new Date().toISOString(),
        };
      }
    });
  }

  async sendFile(phoneNumber, filePath, caption = "") {
    if (this.state !== WA_STATES.CONNECTED || !this.client || !this.client.pupPage || this.client.pupPage.isClosed()) {
      throw new Error("WhatsApp not ready");
    }

    const normalized = normalizePhoneNumber(phoneNumber);
    if (!isValidPhoneNumber(normalized)) {
      throw new Error("Invalid target phone number");
    }

    if (!filePath || !fsSync.existsSync(filePath)) {
      throw new Error("File backup tidak ditemukan.");
    }

    const media = MessageMedia.fromFilePath(filePath);
    media.mimetype = media.mimetype || "text/plain";
    media.filename = path.basename(filePath);

    await this.client.sendMessage(`${normalized}@c.us`, media, {
      caption: String(caption || ""),
      sendMediaAsDocument: true,
    });
  }

  getStatus() {
    return {
      state: this.state,
      isAvailable:
        this.state === WA_STATES.CONNECTED &&
        this.isReady &&
        !!this.client?.pupPage &&
        !this.client.pupPage.isClosed() &&
        !this.isReconnecting,
      hasClient: !!this.client,
      hasPage: !!this.client?.pupPage && !this.client.pupPage.isClosed(),
      reconnecting: this.isReconnecting,
      reconnectAttempts: this.reconnectAttempts,
      pendingQueue: this.queue.pending.length,
      failedQueue: this.queue.failed.length,
      currentQR: !!this.currentQR,
      fonnteEnabled: FonnteManager.isConfigured(),
    };
  }

  async destroy() {
    await this._stateLock.runExclusive("destroy", async () => {
      if (this.client) {
        await this.client.destroy().catch((error) => {
          this.activityLog.push("error", "whatsapp", "Error destroying client", { error: error.message });
        });
        this.client = null;
      }
      clearInterval(this.keepAliveTimer);
      clearTimeout(this.reconnectTimer);
      this.isReady = false;
      this.isReconnecting = false;
      this.reconnectAttempts = 0;
      this.state = WA_STATES.UNLAUNCHED;
    });
  }
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
      const users = await conn.menu("/ip/hotspot/user").print();
      return (users || [])
        .map((user) => ({
          id: user[".id"] || user.id || user.numbers || "",
          username: user.name || "",
          profile: user.profile || "",
          comment: user.comment || "",
          disabled: String(user.disabled || "false").toLowerCase() === "true",
          email: user.email || "",
        }))
        .filter((user) => user.username)
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
    return this.withConnection((conn) => this.removeHotspotUsersByName(conn, username));
  }

  async reactivateHotspotUser({ username, password, profile, phoneNumber, comment }) {
    const hotspotUsername = sanitizeInput(username);
    const hotspotPassword = sanitizeInput(password);
    const profileName = sanitizeInput(profile);
    const normalizedPhone = normalizePhoneNumber(phoneNumber);
    const hotspotComment = sanitizeInput(comment);

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

      if (hotspotComment) {
        addPayload.comment = hotspotComment;
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
    const backupDir = path.join(CONFIG.DB_PATH, "backups", "mikrotik");
    await fs.mkdir(backupDir, { recursive: true });

    const fileName = `mikrotik-export-${timestamp}.rsc`;
    const filePath = path.join(backupDir, fileName);
    const remoteBaseName = `reminder-bot-${timestamp}`;
    const remoteFileName = `${remoteBaseName}.rsc`;

    await this.withConnection(async (conn, connectionObj) => {
      await this.createRouterExportFile(conn, remoteBaseName);
      await this.waitForRouterFile(conn, remoteFileName);
      const ftpPort = await this.resolveFtpPort(conn, connectionObj.config);
      await this.downloadRouterFile({ ...connectionObj.config, ftpPort }, remoteFileName, filePath);
      await conn.menu("/file").where("name", remoteFileName).remove().catch(() => {});
    });

    this.activityLog.push("info", "mikrotik", "Backup konfigurasi MikroTik berhasil dibuat", {
      filePath,
    });

    return { fileName, filePath };
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
      throw new Error("Konfigurasi koneksi MikroTik tidak tersedia untuk download backup.");
    }

    if (config.ftpPort && config.ftpPort !== 21) return config.ftpPort;

    const services = await conn.menu("/ip/service").print().catch(() => []);
    const ftpService = (services || []).find((item) => String(item.name || "").toLowerCase() === "ftp");
    const port = Number(ftpService?.port || config.ftpPort || 21);
    if (String(ftpService?.disabled).toLowerCase() === "true") {
      throw new Error("Service FTP MikroTik sedang disabled. Aktifkan FTP atau isi port FTP yang benar.");
    }
    return port || 21;
  }

  async downloadRouterFile(config, remoteFileName, destinationPath) {
    const ftpClient = new ftp.Client(CONFIG.MIKROTIK_FTP_TIMEOUT || 30_000);
    ftpClient.ftp.verbose = false;

    try {
      await ftpClient.access({
        host: config.host,
        user: config.user,
        password: config.password,
        port: config.ftpPort || 21,
        secure: false,
      });
      await ftpClient.downloadTo(destinationPath, remoteFileName);
    } finally {
      ftpClient.close();
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
    this.dbWriteLock = new AsyncLock();
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

    this.models.WhatsappQueueItem = this.sequelize.define("WhatsappQueueItem", {
      id: { type: DataTypes.STRING, primaryKey: true },
      number: DataTypes.STRING,
      message: DataTypes.TEXT,
      metadata: DataTypes.JSON,
      attempts: DataTypes.INTEGER,
      maxAttempts: DataTypes.INTEGER,
      status: DataTypes.STRING,
      errorMsg: DataTypes.TEXT,
    }, { tableName: "whatsapp_queue", timestamps: true });

    await this.sequelize.authenticate();
    await this.configureDatabaseConnection();
    await this.sequelize.sync();
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
    const retentionMonths = Number(options.retentionMonths || CONFIG.SENT_HISTORY_RETENTION_MONTHS);
    if (!Number.isFinite(retentionMonths) || retentionMonths <= 0) {
      return { deleted: 0, cutoff: null, remaining: this.sentReminders.size };
    }

    const cutoffDate = options.cutoffDate || addMonthsSafely(new Date(), -retentionMonths);
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
      contact.linkedApHost = sanitizeInput(String(contact.linkedApHost || ""));
      contact.mikrotikUsername = sanitizeInput(String(contact.mikrotikUsername || ""));
      contact.mikrotikProfile = sanitizeInput(String(contact.mikrotikProfile || ""));
      contact.mikrotikPassword = sanitizeInput(String(contact.mikrotikPassword || ""));
      contact.hotspotReactivationEnabled = parseBoolean(contact.hotspotReactivationEnabled, false);
      contact.hotspotReactivationAt = this.normalizeOptionalDate(contact.hotspotReactivationAt);
      contact.hotspotLastReactivatedAt = this.normalizeOptionalDate(contact.hotspotLastReactivatedAt);
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

  normalizeOptionalDate(value) {
    const raw = sanitizeInput(String(value || ""));
    if (!raw) return null;
    const date = parseDateTimeInput(raw) || new Date(raw);
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

    return {
      mikrotikUsername: username,
      mikrotikProfile: profile,
      mikrotikPassword: password,
      hotspotReactivationEnabled: enabled,
      hotspotReactivationAt: reactivationAt,
    };
  }

  async saveAll() {
    await this.withDatabaseWrite(() => (
      this.sequelize.transaction(async (transaction) => {
        const options = { transaction };
        await this.saveContacts(options);
        await this.savePelanggan(options);
        await this.saveReminders(options);
        await this.saveSentReminders(options);
        await this.saveRoles(options);
        await this.saveSettings(options);
      })
    ));
  }

  async createBackup() {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupDir = path.join(CONFIG.DB_PATH, "backups", timestamp);
    await fs.mkdir(backupDir, { recursive: true });

    if (!process.env.DATABASE_URL) {
      await this.withDatabaseWrite(async () => {
        const backupFile = path.join(backupDir, path.basename(CONFIG.DB_STORAGE));
        const escapedBackupFile = backupFile.replace(/'/g, "''");
        await this.sequelize.query(`VACUUM INTO '${escapedBackupFile}'`);
      });
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
    const hotspotFields = this.normalizeContactHotspotFields(payload);

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
      ...hotspotFields,
      hotspotLastReactivatedAt: this.normalizeOptionalDate(payload.hotspotLastReactivatedAt),
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
        mikrotikPassword: password,
        hotspotReactivationEnabled: false,
        hotspotReactivationAt: null,
        hotspotLastReactivatedAt: null,
        createdAt: now,
        updatedAt: now,
      };
      this.contacts.set(contact.id, contact);
    } else {
      contact.name = name;
      contact.mikrotikUsername = username;
      contact.mikrotikProfile = profile;
      contact.mikrotikPassword = password;
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
    const hotspotFields = this.normalizeContactHotspotFields(payload, contact);

    if (!nextName) throw new Error("Nama kontak wajib diisi.");
    if (!isValidPhoneNumber(nextPhone)) throw new Error("Nomor kontak harus berformat 628xxx.");
    if (this.hasContactPhone(nextPhone, id)) throw new Error("Nomor kontak sudah digunakan.");

    contact.name = nextName;
    contact.phoneNumber = nextPhone;
    contact.linkedApHost = nextLinkedApHost;
    Object.assign(contact, hotspotFields);
    contact.updatedAt = new Date().toISOString();

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

  getDueHotspotReactivationContacts(now = new Date()) {
    const nowTime = now.getTime();
    if (Number.isNaN(nowTime)) return [];

    return this.getSortedContacts().filter((contact) => {
      if (!contact.hotspotReactivationEnabled) return false;
      if (!contact.mikrotikUsername || !contact.mikrotikProfile || !contact.hotspotReactivationAt) return false;
      const dueTime = new Date(contact.hotspotReactivationAt).getTime();
      return Number.isFinite(dueTime) && dueTime <= nowTime;
    });
  }

  async markHotspotReactivated(contactId, result, options = {}) {
    const contact = this.getContact(contactId);
    if (!contact) throw new Error("Kontak tidak ditemukan.");

    const now = new Date();
    const previousSchedule = contact.hotspotReactivationAt || now.toISOString();
    contact.hotspotLastReactivatedAt = now.toISOString();
    contact.hotspotReactivationAt = addMonthsSafely(previousSchedule, 1).toISOString();
    contact.mikrotikPassword = sanitizeInput(result?.password || contact.mikrotikPassword || "");
    contact.mikrotikProfile = sanitizeInput(result?.profile || contact.mikrotikProfile || "");
    contact.updatedAt = now.toISOString();

    await this.saveContacts(options);
    return this.hydrateContact(contact);
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
      apDownMinimumDownMinutes: payload.apDownMinimumDownMinutes !== undefined
        ? sanitizePositiveInteger(
            payload.apDownMinimumDownMinutes,
            current.apDownMinimumDownMinutes || current.apDownConfirmationChecks || DEFAULT_SETTINGS.apDownMinimumDownMinutes,
            1,
            120
          )
        : (current.apDownMinimumDownMinutes || current.apDownConfirmationChecks || DEFAULT_SETTINGS.apDownMinimumDownMinutes),
      timezone: payload.timezone !== undefined ? sanitizeInput(payload.timezone) || current.timezone : current.timezone,
      autoRescheduleMonthly: payload.autoRescheduleMonthly !== undefined ? parseBoolean(payload.autoRescheduleMonthly, current.autoRescheduleMonthly) : current.autoRescheduleMonthly,
      notifyAdminsOnDelivery: payload.notifyAdminsOnDelivery !== undefined ? parseBoolean(payload.notifyAdminsOnDelivery, current.notifyAdminsOnDelivery) : current.notifyAdminsOnDelivery,
      notifyAdminsOnConnectionChange: payload.notifyAdminsOnConnectionChange !== undefined ? parseBoolean(payload.notifyAdminsOnConnectionChange, current.notifyAdminsOnConnectionChange) : current.notifyAdminsOnConnectionChange,
      notifyAdminsOnPaymentReset: payload.notifyAdminsOnPaymentReset !== undefined ? parseBoolean(payload.notifyAdminsOnPaymentReset, current.notifyAdminsOnPaymentReset) : current.notifyAdminsOnPaymentReset,
      enableMikrotikBackupToWa: payload.enableMikrotikBackupToWa !== undefined
        ? parseBoolean(payload.enableMikrotikBackupToWa, current.enableMikrotikBackupToWa)
        : current.enableMikrotikBackupToWa,
      mikrotikBackupTime: payload.mikrotikBackupTime !== undefined
        ? sanitizeTimeHHMM(payload.mikrotikBackupTime, current.mikrotikBackupTime || DEFAULT_SETTINGS.mikrotikBackupTime)
        : current.mikrotikBackupTime,
      mikrotikBackupTimezone: payload.mikrotikBackupTimezone !== undefined
        ? sanitizeInput(payload.mikrotikBackupTimezone) || current.mikrotikBackupTimezone || current.timezone
        : current.mikrotikBackupTimezone,
      mikrotikBackupLastRunDate: payload.mikrotikBackupLastRunDate !== undefined
        ? sanitizeInput(payload.mikrotikBackupLastRunDate)
        : current.mikrotikBackupLastRunDate,
    };
    await this.saveSettings();
    return this.getSettings();
  }

  async markMikrotikBackupRun(dateKey) {
    this.settings = {
      ...this.getSettings(),
      mikrotikBackupLastRunDate: sanitizeInput(dateKey),
    };
    await this.saveSettings();
    return this.settings.mikrotikBackupLastRunDate;
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

// ===============================
// NOTIFICATION BOT (Wrapper around WhatsAppManager)
// ===============================

class NotificationBot {
  constructor(dataManager, activityLog) {
    this.dataManager = dataManager;
    this.activityLog = activityLog;
    this.waManager = new WhatsAppManager(dataManager, activityLog);
    this.waManager.setProviderChangeHandler((previousProvider, provider, details) =>
      this.notifyAdminsOnProviderFallback(previousProvider, provider, details)
    );
  }

  async initialize() {
    await this.waManager.initialize();
    this.waManager.startKeepAlive();
  }

  async sendMessage(phoneNumber, message) {
    const result = await this.waManager.sendMessage(phoneNumber, message);
    if (result.status === "success") {
      await this.waManager.noteProviderUsed("whatsapp-web", {
        source: "direct",
        phoneNumber: normalizePhoneNumber(phoneNumber),
      });
      return { ...result, provider: "whatsapp-web" };
    }

    if (!FonnteManager.isConfigured()) {
      throw new Error(result.message);
    }

    this.activityLog.push("warn", "notification", "WhatsApp Web gagal, mencoba fallback Fonnte", {
      phoneNumber: normalizePhoneNumber(phoneNumber),
      error: result.message,
      waState: result.waState || this.waManager.state,
    });

    try {
      const backupResult = await FonnteManager.sendMessage(phoneNumber, message);
      this.activityLog.push("info", "notification", `Fallback Fonnte berhasil untuk ${normalizePhoneNumber(phoneNumber)}`);
      if (backupResult.status === "success") {
        await this.waManager.noteProviderUsed("fonnte", {
          source: "direct",
          phoneNumber: normalizePhoneNumber(phoneNumber),
          reason: result.message,
          waState: result.waState || this.waManager.state,
        });
      }
      return backupResult;
    } catch (backupError) {
      throw new Error(`WhatsApp Web gagal: ${result.message}; Fonnte gagal: ${backupError.message}`);
    }
  }

  async sendFile(phoneNumber, filePath, caption = "") {
    await this.waManager.sendFile(phoneNumber, filePath, caption);
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
    if (title !== "Fallback Fonnte aktif") return [];
    return this.sendAdminBroadcast(title, body, { silentLog: true });
  }

  async notifyAdminsOnProviderFallback(previousProvider, provider, details = {}) {
    const settings = this.dataManager.getSettings();
    if (!settings.notifyAdminsOnConnectionChange || provider !== "fonnte") return [];
    if (!FonnteManager.isConfigured()) return [];

    const recipients = this.dataManager.getAdminRecipients();
    if (recipients.length === 0) return [];

    const target = details.phoneNumber ? `\nTarget pesan: ${details.phoneNumber}` : "";
    const item = details.itemId ? `\nQueue ID: ${details.itemId}` : "";
    const reason = details.reason ? `\nAlasan: ${details.reason}` : "";
    const waState = details.waState || this.waManager.state;
    const message =
      "*Fallback Fonnte aktif*\n\n" +
      `Transport WA berubah dari ${previousProvider} ke ${provider}.` +
      `\nStatus WA: ${waState}` +
      `${target}${item}${reason}`;

    const results = [];
    for (const phoneNumber of recipients) {
      try {
        await FonnteManager.sendMessage(phoneNumber, message);
        results.push({ phoneNumber, status: "sent", provider: "fonnte" });
      } catch (error) {
        results.push({ phoneNumber, status: "failed", error: error.message, provider: "fonnte" });
      }
    }

    this.activityLog.push("info", "broadcast", `Alert fallback Fonnte dikirim ke ${recipients.length} admin recipient(s)`);
    return results;
  }

  getStatus() {
    return this.waManager.getStatus();
  }
}

// ===============================
// WEB SERVER
// ===============================

class WebServer {
  constructor(notificationBot, dataManager, templateManager, activityLog, reminderScheduler, authManager, mikrotikService, hotspotReactivationScheduler) {
    this.app = express();
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
      const status = this.notificationBot.getStatus();
      if (status.isAvailable) {
        return res.send(`
          <html><body style="display:flex;justify-content:center;align-items:center;height:100vh;background:#f4f5ef;font-family:Georgia,serif;">
            <div style="padding:28px 34px;border-radius:20px;background:white;box-shadow:0 20px 60px rgba(0,0,0,.12);color:#204b57;font-size:1.3rem;">
              WhatsApp sudah terhubung dan siap mengirim notifikasi.
            </div>
          </body></html>
        `);
      }

      if (!status.currentQR) {
        return res.send("Menunggu QR code...");
      }

      const qrImage = await QRCode.toDataURL(this.notificationBot.waManager.currentQR);
      return res.send(`
        <html>
          <head><meta http-equiv="refresh" content="15"><title>Scan QR</title></head>
          <body style="margin:0;min-height:100vh;display:grid;place-items:center;background:linear-gradient(135deg,#f4efe4,#dce7e2);font-family:Georgia,serif;">
            <div style="background:white;padding:28px;border-radius:24px;box-shadow:0 20px 60px rgba(0,0,0,.12);text-align:center;max-width:420px;">
              <h1 style="margin-top:0;color:#204b57;">Hubungkan Transport WhatsApp</h1>
              <img src="${qrImage}" style="max-width:320px;width:100%;border-radius:18px;">
              <p>Scan QR ini dari WhatsApp untuk mengaktifkan channel notifikasi.</p>
              <p>Reconnect attempts: ${status.reconnectAttempts}/${CONFIG.WA_MAX_RECONNECT_ATTEMPTS}</p>
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
      scheduler: {
        isProcessing: this.reminderScheduler.isProcessing,
        hotspotReactivationProcessing: this.hotspotReactivationScheduler?.isProcessing || false,
      },
    })));

    this.app.get("/api/logs", requireApiAuth, handleApi(async () => this.activityLog.list()));

    this.app.get("/api/contacts", requireApiAuth, handleApi(async () => this.dataManager.getSortedContacts()));
    this.app.post("/api/contacts", requireApiAuth, handleApi(async (req) => this.dataManager.addContact(req.body)));
    this.app.put("/api/contacts/:id", requireApiAuth, handleApi(async (req) => this.dataManager.updateContact(req.params.id, req.body)));
    this.app.delete("/api/contacts/:id", requireApiAuth, handleApi(async (req) => this.dataManager.deleteContact(req.params.id)));

    this.app.get("/api/mikrotik/profiles", requireApiAuth, handleApi(async () => this.mikrotikService.getHotspotProfiles()));
    this.app.get("/api/mikrotik/hotspot-users", requireApiAuth, handleApi(async () => this.mikrotikService.getHotspotUsers()));
    this.app.get("/api/mikrotik/netwatch", requireApiAuth, handleApi(async () => this.mikrotikService.getNetwatchStatus()));
    this.app.post("/api/contacts/:id/hotspot/reactivate", requireApiAuth, handleApi(async (req) => {
      const contact = this.dataManager.getContact(req.params.id);
      if (!contact) throw new Error("Kontak tidak ditemukan.");
      const result = await this.hotspotReactivationScheduler.reactivateContact(this.dataManager.hydrateContact(contact));
      return result;
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
        persisted = await this.dataManager.upsertPelangganFromRegistration(registered);
      } catch (error) {
        await this.mikrotikService.deleteHotspotUser(registered.username).catch((rollbackError) => {
          this.activityLog.push("error", "mikrotik", `Rollback user ${registered.username} gagal: ${rollbackError.message}`);
        });
        throw error;
      }

      let notification = { sent: false };
      if (parseBoolean(req.body.sendCredentials) && this.notificationBot.getStatus().isAvailable) {
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
      const status = this.notificationBot.getStatus();
      if (!status.isAvailable) {
        throw new Error("Transport backup belum siap. Hubungkan WhatsApp Web terlebih dahulu.");
      }

      const recipients = this.dataManager.getAdminRecipients();
      if (recipients.length === 0) {
        throw new Error("Admin recipients masih kosong.");
      }

      const backup = await this.mikrotikService.generateDailyBackupFile();
      const caption = `Backup MikroTik manual\nWaktu: ${new Date().toLocaleString("id-ID")}`;
      const results = [];

      for (const phoneNumber of recipients) {
        try {
          await this.notificationBot.sendFile(phoneNumber, backup.filePath, caption);
          results.push({ phoneNumber, status: "sent" });
        } catch (error) {
          results.push({ phoneNumber, status: "failed", error: error.message });
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
  const currentMonth = now.getMonth() + 1;
  const currentYear = now.getFullYear();
  const prevMonth = currentMonth === 1 ? 12 : currentMonth - 1;
  const prevYear = currentMonth === 1 ? currentYear - 1 : currentYear;
  const overdue = dataManager.getOverdueContacts(prevYear, prevMonth);

  activityLog.push("info", "billing", `Monthly payment status reset completed for ${count} contact(s)`);

  if (!settings.notifyAdminsOnPaymentReset || !notificationBot.getStatus().isAvailable) {
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

// ===============================
// APPLICATION BOOTSTRAP
// ===============================

async function bootstrap() {
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
  const mikrotikBackupScheduler = new MikrotikBackupScheduler(
    mikrotikService,
    notificationBot,
    dataManager,
    activityLog
  );
  const hotspotReactivationScheduler = new HotspotReactivationScheduler(
    mikrotikService,
    dataManager,
    activityLog
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

  await dataManager.ensureMonthlyPaymentReset();

  cron.schedule(CONFIG.CRON_SCHEDULE, () => {
    Promise.all([
      reminderScheduler.processDueReminders(),
      apDownNotifier.processNetwatchChanges(),
      mikrotikBackupScheduler.processDailyBackup(),
      hotspotReactivationScheduler.processDueReactivations(),
    ]).catch((error) => {
      activityLog.push("error", "scheduler", `Cron execution failed: ${error.message}`);
    });
  });

  cron.schedule(CONFIG.RESET_PAYMENT_SCHEDULE, () => {
    sendMonthlyResetNotification(notificationBot, dataManager, activityLog).catch((error) => {
      activityLog.push("error", "billing", `Monthly reset failed: ${error.message}`);
    });
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
    .then(() => activityLog.push("info", "whatsapp", "WhatsApp manager initialized"))
    .catch((error) => {
      activityLog.push("error", "whatsapp", `Initial WhatsApp startup failed: ${error.message}`);
    });
}

module.exports = {
  bootstrap,
};
