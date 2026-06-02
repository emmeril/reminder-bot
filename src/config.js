const path = require("path");

const ROOT_DIR = path.resolve(__dirname, "..");

const CONFIG = {
  PORT: Number(process.env.PORT || 3025),
  DB_PATH: path.join(ROOT_DIR, "database"),
  DB_STORAGE: process.env.DB_STORAGE
    ? (path.isAbsolute(process.env.DB_STORAGE) ? process.env.DB_STORAGE : path.join(ROOT_DIR, process.env.DB_STORAGE))
    : path.join(ROOT_DIR, "database", "reminder_bot.sqlite"),
  TEMPLATE_PATH: path.join(ROOT_DIR, "templates"),
  PUBLIC_PATH: path.join(ROOT_DIR, "public"),
  AUTO_SAVE_INTERVAL: 24 * 60 * 60 * 1000,
  BACKUP_INTERVAL: 24 * 60 * 60 * 1000,
  SENT_HISTORY_RETENTION_MONTHS: Number(process.env.SENT_HISTORY_RETENTION_MONTHS || 3),
  SENT_HISTORY_CLEANUP_SCHEDULE: process.env.SENT_HISTORY_CLEANUP_SCHEDULE || "15 0 * * *",
  KEEP_ALIVE_INTERVAL: 5 * 60 * 1000,
  MAX_RECONNECT_ATTEMPTS: 10,
  MIN_RECONNECT_INTERVAL: 30_000,
  RECONNECT_DELAY: 5_000,
  SQLITE_BUSY_TIMEOUT: Number(process.env.SQLITE_BUSY_TIMEOUT || 10_000),
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
    ftpPort: Number(process.env.PORT_MIKROTIK_FTP || 21),
    timeout: 30_000,
    keepalive: true,
  },
  MIKROTIK_BACKUP: {
    host: process.env.IP_MIKROTIK_BACKUP,
    user: process.env.USER_MIKROTIK,
    password: process.env.PASSWORD_MIKROTIK,
    port: Number(process.env.PORT_MIKROTIK_BACKUP || process.env.PORT_MIKROTIK || 8728),
    ftpPort: Number(process.env.PORT_MIKROTIK_BACKUP_FTP || process.env.PORT_MIKROTIK_FTP || 21),
    timeout: 30_000,
    keepalive: true,
  },
  FONNTE_TOKEN: String(process.env.FONNTE_TOKEN || "").trim(),
  FONNTE_API_URL: String(process.env.FONNTE_API_URL || "https://api.fonnte.com/send").trim(),
  FONNTE_ENABLED: String(process.env.FONNTE_ENABLED || "").trim().toLowerCase() === "true",
  FONNTE_BACKUP_ENABLED: String(process.env.FONNTE_BACKUP_ENABLED || "").trim().toLowerCase() === "true",
  WA_MAX_RECONNECT_ATTEMPTS: Number(process.env.WA_MAX_RECONNECT_ATTEMPTS || 3),
  WA_RECONNECT_DELAY: Number(process.env.WA_RECONNECT_DELAY || 5000),
  WA_MIN_RECONNECT_INTERVAL: Number(process.env.WA_MIN_RECONNECT_INTERVAL || 30000),
  WA_KEEP_ALIVE_INTERVAL: Number(process.env.WA_KEEP_ALIVE_INTERVAL || 60000),
  WA_MAX_QUEUE_PROCESS: Number(process.env.WA_MAX_QUEUE_PROCESS || 5),
  WA_MESSAGE_DELAY: Number(process.env.WA_MESSAGE_DELAY || 2000),
  WA_INITIALIZATION_DELAY: Number(process.env.WA_INITIALIZATION_DELAY || 10000),
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

const WA_STATES = {
  CONNECTED: "CONNECTED",
  OPENING: "OPENING",
  PAIRING: "PAIRING",
  UNPAIRED: "UNPAIRED",
  UNPAIRED_IDLE: "UNPAIRED_IDLE",
  CONFLICT: "CONFLICT",
  TIMEOUT: "TIMEOUT",
  TOS_BLOCK: "TOS_BLOCK",
  SMB_TOS_BLOCK: "SMB_TOS_BLOCK",
  PROXYBLOCK: "PROXYBLOCK",
  DEPRECATED_VERSION: "DEPRECATED_VERSION",
  UNLAUNCHED: "UNLAUNCHED",
};

const WA_DISCONNECT_REASONS = new Set(["UNAUTHORIZED", "CONFLICT"]);
const WA_CRITICAL_STATES = new Set([WA_STATES.TIMEOUT, WA_STATES.UNPAIRED, WA_STATES.CONFLICT]);

module.exports = {
  CONFIG,
  DEFAULT_SETTINGS,
  MONTH_NAMES,
  PAYMENT_STATUS,
  PAYMENT_TYPES,
  ROOT_DIR,
  WA_CRITICAL_STATES,
  WA_DISCONNECT_REASONS,
  WA_STATES,
};
