const fs = require("fs/promises");
const path = require("path");
const qrcode = require("qrcode-terminal");
const { Client, LocalAuth } = require("whatsapp-web.js");
const { CONFIG, PAYMENT_TYPES, DEFAULT_SETTINGS } = require("../config");
const { sanitizeInput, sanitizeMultilineText, normalizePhoneNumber, isValidPhoneNumber, resolveChromeExecutablePath } = require("../utils");
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

    const paymentNarrativeMap = {
      [PAYMENT_TYPES.ARREARS_ONLY]: {
        statusText: "TUNGGAKAN TERBAYAR",
        noteText: "Pembayaran tunggakan bulan sebelumnya telah kami terima. Catatan: Bulan ini masih belum lunas.",
      },
      [PAYMENT_TYPES.CURRENT_ONLY]: {
        statusText: "LUNAS (BULAN INI)",
        noteText: "Pembayaran bulan ini telah kami terima dan riwayat bulan sebelumnya sudah lunas.",
      },
      [PAYMENT_TYPES.FULL_PAID]: {
        statusText: "LUNAS",
        noteText: "Semua tagihan (bulan sebelumnya dan bulan ini) telah lunas. Terima kasih atas kelancarannya!",
      },
      DEFAULT: {
        statusText: "LUNAS",
        noteText: "Pembayaran Anda telah berhasil kami terima.",
      },
    };
    const narrative = paymentNarrativeMap[paymentType] || paymentNarrativeMap.DEFAULT;
    const { statusText, noteText } = narrative;

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

module.exports = NotificationBot;
