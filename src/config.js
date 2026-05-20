const path = require("path");

const ROOT_DIR = path.join(__dirname, "..");

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
  MIKROTIK_PRIMARY: {
    host: process.env.IP_MIKROTIK,
    user: process.env.USER_MIKROTIK,
    password: process.env.PASSWORD_MIKROTIK,
    port: Number(process.env.PORT_MIKROTIK || 8728),
    timeout: 30_000,
    keepalive: true,
  },
  MIKROTIK_BACKUP: {
    host: process.env.IP_MIKROTIK_BACKUP,
    user: process.env.USER_MIKROTIK,
    password: process.env.PASSWORD_MIKROTIK,
    port: Number(process.env.PORT_MIKROTIK_BACKUP || process.env.PORT_MIKROTIK || 8728),
    timeout: 30_000,
    keepalive: true,
  },
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
  paymentMessageTemplateArrearsOnly: "*BUKTI PEMBAYARAN {{companyNameUpper}}*\n\nHalo {{name}}!\n\nTerima kasih. Pembayaran tunggakan bulan sebelumnya telah kami terima.\n\n*ID Transaksi*\n{{transactionId}}\n\n*Tanggal Pembayaran*\n{{paymentDate}}\n\n*Status*\n{{statusText}}\n\n{{noteText}}\n\nHormat kami,\n{{supportSignature}}",
  paymentMessageTemplateCurrentOnly: "*BUKTI PEMBAYARAN {{companyNameUpper}}*\n\nHalo {{name}}!\n\nTerima kasih. Pembayaran bulan ini telah kami terima.\n\n*ID Transaksi*\n{{transactionId}}\n\n*Tanggal Pembayaran*\n{{paymentDate}}\n\n*Status*\n{{statusText}}\n\n{{noteText}}\n\nHormat kami,\n{{supportSignature}}",
  paymentMessageTemplateFullPaid: "*BUKTI PEMBAYARAN {{companyNameUpper}}*\n\nHalo {{name}}!\n\nTerima kasih. Semua tagihan Anda sudah lunas.\n\n*ID Transaksi*\n{{transactionId}}\n\n*Tanggal Pembayaran*\n{{paymentDate}}\n\n*Status*\n{{statusText}}\n\n{{noteText}}\n\nHormat kami,\n{{supportSignature}}",
  timezone: "Asia/Jakarta",
  lastPaymentResetPeriod: "",
  autoRescheduleMonthly: true,
  notifyAdminsOnDelivery: true,
  notifyAdminsOnConnectionChange: true,
  notifyAdminsOnPaymentReset: true,
};

module.exports = {
  CONFIG,
  MONTH_NAMES,
  PAYMENT_STATUS,
  PAYMENT_TYPES,
  DEFAULT_SETTINGS,
};
