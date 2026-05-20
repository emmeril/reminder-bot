const fs = require("fs/promises");
const path = require("path");
const express = require("express");
const crypto = require("crypto");
const QRCode = require("qrcode");
const { CONFIG, PAYMENT_STATUS, PAYMENT_TYPES } = require("../config");
const { escapeHtml, sanitizeInput, sanitizeMultilineText, parseBoolean, parseCookies, serializeCookie, safeCompareString, normalizePhoneNumber, isValidPhoneNumber, parseDateTimeInput, getBillingPeriodKey } = require("../utils");
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
    this.app.get("/api/mikrotik/netwatch", requireApiAuth, handleApi(async () => this.mikrotikService.getNetwatchStatus()));
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

module.exports = WebServer;
