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
  PORT: envNumber("PORT", 3025),
  DB_PATH: path.join(ROOT_DIR, "database"),
  DB_STORAGE: resolveFromRoot(
    process.env.DB_STORAGE,
    path.join(ROOT_DIR, "database", "reminder_bot.sqlite")
  ),
  TEMPLATE_PATH: path.join(ROOT_DIR, "templates"),
  PUBLIC_PATH: path.join(ROOT_DIR, "public"),
  AUTO_SAVE_INTERVAL: 24 * 60 * 60 * 1000,
  BACKUP_INTERVAL: 24 * 60 * 60 * 1000,
  SENT_HISTORY_RETENTION_MONTHS: envNumber("SENT_HISTORY_RETENTION_MONTHS", 3),
  SENT_HISTORY_CLEANUP_SCHEDULE: process.env.SENT_HISTORY_CLEANUP_SCHEDULE || "15 0 * * *",
  KEEP_ALIVE_INTERVAL: 5 * 60 * 1000,
  MAX_RECONNECT_ATTEMPTS: 10,
  MIN_RECONNECT_INTERVAL: 30_000,
  RECONNECT_DELAY: 5_000,
  SQLITE_BUSY_TIMEOUT: envNumber("SQLITE_BUSY_TIMEOUT", 10_000),
  CRON_SCHEDULE: "*/1 * * * *",
  RESET_PAYMENT_SCHEDULE: "0 0 1 * *",
  MAX_LOCK_WAIT: 10_000,
  LOCK_POLL_INTERVAL: 50,
  WEB_API_KEY: envString("WEB_API_KEY", "dev-key-change-in-production"),
  AUTH_USERNAME: envString("AUTH_USERNAME", "admin"),
  AUTH_PASSWORD: envString("AUTH_PASSWORD", "admin123"),
  SESSION_COOKIE_NAME: "reminder_bot_session",
  SESSION_TTL: 24 * 60 * 60 * 1000,
  SESSION_SECRET: envString("SESSION_SECRET", "change-this-session-secret"),
  LOG_LIMIT: 250,
  MIKROTIK_PRIMARY: {
    host: envString("IP_MIKROTIK"),
    user: envString("USER_MIKROTIK"),
    password: envString("PASSWORD_MIKROTIK"),
    port: envNumber("PORT_MIKROTIK", 8728),
    ftpPort: envNumber("PORT_MIKROTIK_FTP", 21),
    timeout: 30_000,
    keepalive: true,
  },
  MIKROTIK_BACKUP: {
    host: envString("IP_MIKROTIK_BACKUP"),
    user: envString("USER_MIKROTIK"),
    password: envString("PASSWORD_MIKROTIK"),
    port: envNumber("PORT_MIKROTIK_BACKUP", envNumber("PORT_MIKROTIK", 8728)),
    ftpPort: envNumber("PORT_MIKROTIK_BACKUP_FTP", envNumber("PORT_MIKROTIK_FTP", 21)),
    timeout: 30_000,
    keepalive: true,
  },
  FONNTE_TOKEN: envString("FONNTE_TOKEN"),
  FONNTE_API_URL: envString("FONNTE_API_URL", "https://api.fonnte.com/send"),
  FONNTE_ENABLED: envBoolean("FONNTE_ENABLED"),
  FONNTE_BACKUP_ENABLED: envBoolean("FONNTE_BACKUP_ENABLED"),
  TELEGRAM_BOT_TOKEN: envString("TELEGRAM_BOT_TOKEN"),
  TELEGRAM_API_URL: envString("TELEGRAM_API_URL", "https://api.telegram.org"),
  TELEGRAM_CHAT_IDS: envString("TELEGRAM_CHAT_IDS"),
  WA_MAX_QUEUE_PROCESS: envNumber("WA_MAX_QUEUE_PROCESS", 5),
  WA_MESSAGE_DELAY: envNumber("WA_MESSAGE_DELAY", 2000),
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
  notifyAdminsOnDelivery: true,
  notifyAdminsOnConnectionChange: true,
  notifyAdminsOnPaymentReset: true,
  enableMikrotikBackupToWa: false,
  mikrotikBackupTime: "02:00",
  mikrotikBackupTimezone: "Asia/Jakarta",
  mikrotikBackupLastRunDate: "",
};

module.exports = {
  CONFIG,
  DEFAULT_SETTINGS,
  MONTH_NAMES,
  PAYMENT_STATUS,
  PAYMENT_TYPES,
  ROOT_DIR,
};
