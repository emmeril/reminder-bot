const path = require("path");

const ROOT_DIR = path.resolve(__dirname, "..");

function envString(name, fallback = "") {
  return String(process.env[name] || fallback).trim();
}

function envNumber(name, fallback) {
  const value = envString(name);
  if (!value) return fallback;

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function envBoolean(name, fallback = false) {
  const value = envString(name).toLowerCase();
  if (!value) return fallback;
  return ["true", "1", "yes", "on"].includes(value);
}

function resolveFromRoot(value, fallback) {
  if (!value) return fallback;
  return path.isAbsolute(value) ? value : path.join(ROOT_DIR, value);
}

const CONFIG = {
  HOST: envString("HOST", "127.0.0.1"),
  TRUST_PROXY: envBoolean("TRUST_PROXY", false),
  PORT: envNumber("PORT", 3025),
  DB_PATH: path.join(ROOT_DIR, "database"),
  DB_STORAGE: resolveFromRoot(
    process.env.DB_STORAGE,
    path.join(ROOT_DIR, "database", "reminder_bot.sqlite")
  ),
  TEMPLATE_PATH: path.join(ROOT_DIR, "templates"),
  PUBLIC_PATH: path.join(ROOT_DIR, "public"),
  AUTO_SAVE_INTERVAL: 24 * 60 * 60 * 1000,
  DB_BACKUP_RETENTION_DAYS: envNumber("DB_BACKUP_RETENTION_DAYS", 3),
  SENT_HISTORY_RETENTION_MONTHS: envNumber("SENT_HISTORY_RETENTION_MONTHS", 3),
  SENT_HISTORY_CLEANUP_SCHEDULE: process.env.SENT_HISTORY_CLEANUP_SCHEDULE || "15 0 * * *",
  KEEP_ALIVE_INTERVAL: 5 * 60 * 1000,
  MAX_RECONNECT_ATTEMPTS: 10,
  MIN_RECONNECT_INTERVAL: 30_000,
  RECONNECT_DELAY: 5_000,
  SQLITE_BUSY_TIMEOUT: envNumber("SQLITE_BUSY_TIMEOUT", 10_000),
  CRON_SCHEDULE: "*/1 * * * *",
  MAX_LOCK_WAIT: 10_000,
  LOCK_POLL_INTERVAL: 50,
  WEB_API_KEY: envString("WEB_API_KEY"),
  AUTH_USERNAME: envString("AUTH_USERNAME"),
  AUTH_PASSWORD: envString("AUTH_PASSWORD"),
  AUTH_MAX_LOGIN_ATTEMPTS: envNumber("AUTH_MAX_LOGIN_ATTEMPTS", 5),
  AUTH_LOGIN_WINDOW: envNumber("AUTH_LOGIN_WINDOW", 15 * 60 * 1000),
  AUTH_LOGIN_LOCKOUT: envNumber("AUTH_LOGIN_LOCKOUT", 15 * 60 * 1000),
  SESSION_COOKIE_NAME: "reminder_bot_session",
  SESSION_TTL: 24 * 60 * 60 * 1000,
  SESSION_SECRET: envString("SESSION_SECRET"),
  LOG_LIMIT: 250,
  MIKROTIK_PRIMARY: {
    host: envString("IP_MIKROTIK"),
    user: envString("USER_MIKROTIK"),
    password: envString("PASSWORD_MIKROTIK"),
    port: envNumber("PORT_MIKROTIK", 8728),
    ftpPort: envNumber("PORT_MIKROTIK_FTP", 21),
    timeout: 30_000,
    keepalive: true,
    tls: envBoolean("MIKROTIK_TLS", false)
      ? { rejectUnauthorized: envBoolean("MIKROTIK_TLS_REJECT_UNAUTHORIZED", true) }
      : null,
  },
  MIKROTIK_BACKUP: {
    host: envString("IP_MIKROTIK_BACKUP"),
    user: envString("USER_MIKROTIK"),
    password: envString("PASSWORD_MIKROTIK"),
    port: envNumber("PORT_MIKROTIK_BACKUP", envNumber("PORT_MIKROTIK", 8728)),
    ftpPort: envNumber("PORT_MIKROTIK_BACKUP_FTP", envNumber("PORT_MIKROTIK_FTP", 21)),
    timeout: 30_000,
    keepalive: true,
    tls: envBoolean("MIKROTIK_BACKUP_TLS", envBoolean("MIKROTIK_TLS", false))
      ? {
          rejectUnauthorized: envBoolean(
            "MIKROTIK_BACKUP_TLS_REJECT_UNAUTHORIZED",
            envBoolean("MIKROTIK_TLS_REJECT_UNAUTHORIZED", true)
          ),
        }
      : null,
  },
  MIKROTIK_FTP_TIMEOUT: envNumber("MIKROTIK_FTP_TIMEOUT", 30_000),
  BAILEYS_ENABLED: envString("BAILEYS_ENABLED") ? envBoolean("BAILEYS_ENABLED") : true,
  BAILEYS_AUTH_STORAGE: resolveFromRoot(
    process.env.BAILEYS_AUTH_STORAGE,
    path.join(ROOT_DIR, "database", "baileys_auth.sqlite")
  ),
  BAILEYS_BROWSER_NAME: envString("BAILEYS_BROWSER_NAME", "Reminder Bot"),
  BAILEYS_CONNECT_TIMEOUT: envNumber("BAILEYS_CONNECT_TIMEOUT", 30_000),
  BAILEYS_QUERY_TIMEOUT: envNumber("BAILEYS_QUERY_TIMEOUT", 30_000),
  TELEGRAM_BOT_TOKEN: envString("TELEGRAM_BOT_TOKEN"),
  TELEGRAM_API_URL: envString("TELEGRAM_API_URL", "https://api.telegram.org"),
  TELEGRAM_CHAT_IDS: envString("TELEGRAM_CHAT_IDS"),
  WA_MAX_QUEUE_PROCESS: envNumber("WA_MAX_QUEUE_PROCESS", 5),
  WA_MESSAGE_DELAY: envNumber("WA_MESSAGE_DELAY", 2000),
  WA_MESSAGE_DELAY_MIN: envNumber("WA_MESSAGE_DELAY_MIN", envNumber("WA_MESSAGE_DELAY", 2000)),
  WA_MESSAGE_DELAY_MAX: envNumber("WA_MESSAGE_DELAY_MAX", 5000),
  BAILEYS_RECONNECT_MAX_DELAY: envNumber(
    "BAILEYS_RECONNECT_MAX_DELAY",
    envNumber("WA_RETRY_MAX_DELAY", 30000)
  ),
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
  apDownMessageTemplate: "Halo {{name}},\n\nKami mendeteksi perangkat AP *{{host}}* sedang *DOWN*.\nTim kami sedang melakukan pengecekan.\n\nMohon maaf atas ketidaknyamanannya.\n\n{{supportSignature}}",
  hotspotReactivationMessageTemplate: "Halo {{name}},\n\nAkun hotspot Anda sudah direaktivasi.\n\nDetail Akun Hotspot:\n*Username:* {{username}}\n*Password:* {{password}}\n*Profile:* {{profile}}\n\nSilakan login kembali menggunakan akun di atas.\n\n{{supportSignature}}",
  apDownMinimumDownMinutes: 5,
  paymentMessageTemplateArrearsOnly: "*BUKTI PEMBAYARAN {{companyNameUpper}}*\n\nHalo {{name}}!\n\nTerima kasih. Pembayaran tunggakan bulan sebelumnya telah kami terima.\n\n*ID Transaksi*\n{{transactionId}}\n\n*Tanggal Pembayaran*\n{{paymentDate}}\n\n*Status*\n{{statusText}}\n\n{{noteText}}\n\nHormat kami,\n{{supportSignature}}",
  paymentMessageTemplateCurrentOnly: "*BUKTI PEMBAYARAN {{companyNameUpper}}*\n\nHalo {{name}}!\n\nTerima kasih. Pembayaran bulan ini telah kami terima.\n\n*ID Transaksi*\n{{transactionId}}\n\n*Tanggal Pembayaran*\n{{paymentDate}}\n\n*Status*\n{{statusText}}\n\n{{noteText}}\n\nHormat kami,\n{{supportSignature}}",
  paymentMessageTemplateFullPaid: "*BUKTI PEMBAYARAN {{companyNameUpper}}*\n\nHalo {{name}}!\n\nTerima kasih. Semua tagihan Anda sudah lunas.\n\n*ID Transaksi*\n{{transactionId}}\n\n*Tanggal Pembayaran*\n{{paymentDate}}\n\n*Status*\n{{statusText}}\n\n{{noteText}}\n\nHormat kami,\n{{supportSignature}}",
  timezone: "Asia/Jakarta",
  lastPaymentResetPeriod: "",
  autoRescheduleMonthly: true,
  notifyContactsOnApDown: true,
  notifyAdminsOnDelivery: true,
  notifyAdminsOnConnectionChange: true,
  notifyAdminsOnPaymentReset: true,
  waRandomDelayMinSeconds: Math.max(0, Math.round(CONFIG.WA_MESSAGE_DELAY_MIN / 1000)),
  waRandomDelayMaxSeconds: Math.max(0, Math.round(CONFIG.WA_MESSAGE_DELAY_MAX / 1000)),
  enableMikrotikBackupToWa: false,
  mikrotikBackupTime: "02:00",
  mikrotikBackupTimezone: "Asia/Jakarta",
  mikrotikBackupLastRunDate: "",
  databaseBackupLastRunDate: "",
};

module.exports = {
  CONFIG,
  DEFAULT_SETTINGS,
  MONTH_NAMES,
  PAYMENT_STATUS,
  PAYMENT_TYPES,
  ROOT_DIR,
};
