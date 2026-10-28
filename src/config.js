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

function envList(name, fallback = []) {
  const values = envString(name).split(",")
    .map((value) => value.trim().toLowerCase())
    .filter((value) => /^[a-z0-9_-]+$/.test(value));
  return [...new Set(values.length > 0 ? values : fallback)];
}

const BAILEYS_INSTANCES = envList("BAILEYS_INSTANCES", ["primary"]);
const DEFAULT_BAILEYS_AUTH_STORAGE = resolveFromRoot(
  process.env.BAILEYS_AUTH_STORAGE,
  path.join(ROOT_DIR, "database", "baileys_auth.sqlite")
);

function getBaileysAuthStorage(instanceId, index) {
  const envName = `BAILEYS_AUTH_STORAGE_${instanceId.replace(/[^a-z0-9]/gi, "_").toUpperCase()}`;
  if (process.env[envName]) return resolveFromRoot(process.env[envName]);
  if (index === 0) return DEFAULT_BAILEYS_AUTH_STORAGE;

  const extension = path.extname(DEFAULT_BAILEYS_AUTH_STORAGE) || ".sqlite";
  const baseName = DEFAULT_BAILEYS_AUTH_STORAGE.slice(0, -extension.length);
  return `${baseName}.${instanceId}${extension}`;
}

const BAILEYS_AUTH_STORAGES = Object.fromEntries(
  BAILEYS_INSTANCES.map((instanceId, index) => [
    instanceId,
    getBaileysAuthStorage(instanceId, index),
  ])
);

const CONFIG = {
  NODE_ENV: envString("NODE_ENV", "development"),
  HOST: envString("HOST", "127.0.0.1"),
  TRUST_PROXY: envBoolean("TRUST_PROXY", false),
  PUBLIC_ORIGIN: envString("PUBLIC_ORIGIN"),
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
  SQLITE_BUSY_TIMEOUT: envNumber("SQLITE_BUSY_TIMEOUT", 10_000),
  CRON_SCHEDULE: "*/1 * * * *",
  HOTSPOT_STATUS_SYNC_SCHEDULE: process.env.HOTSPOT_STATUS_SYNC_SCHEDULE || "15 */5 * * * *",
  MAX_LOCK_WAIT: 10_000,
  LOCK_POLL_INTERVAL: 50,
  WEB_API_KEY: envString("WEB_API_KEY"),
  AUTH_USERNAME: envString("AUTH_USERNAME"),
  AUTH_PASSWORD: envString("AUTH_PASSWORD"),
  AUTH_MAX_LOGIN_ATTEMPTS: envNumber("AUTH_MAX_LOGIN_ATTEMPTS", 5),
  AUTH_MAX_TRACKED_LOGIN_ATTEMPTS: envNumber("AUTH_MAX_TRACKED_LOGIN_ATTEMPTS", 5_000),
  AUTH_LOGIN_WINDOW: envNumber("AUTH_LOGIN_WINDOW", 15 * 60 * 1000),
  AUTH_LOGIN_LOCKOUT: envNumber("AUTH_LOGIN_LOCKOUT", 15 * 60 * 1000),
  SESSION_COOKIE_NAME: "reminder_bot_session",
  CUSTOMER_SESSION_COOKIE_NAME: "reminder_bot_customer_session",
  SESSION_TTL: 24 * 60 * 60 * 1000,
  SESSION_SECRET: envString("SESSION_SECRET"),
  SESSION_COOKIE_SECURE: envBoolean("SESSION_COOKIE_SECURE", false),
  HEALTHCHECK_TIMEOUT: envNumber("HEALTHCHECK_TIMEOUT", 2_000),
  SHUTDOWN_TIMEOUT: envNumber("SHUTDOWN_TIMEOUT", 25_000),
  MIDTRANS_ENABLED: envBoolean("MIDTRANS_ENABLED", false),
  MIDTRANS_IS_PRODUCTION: envBoolean("MIDTRANS_IS_PRODUCTION", false),
  MIDTRANS_SERVER_KEY: envString("MIDTRANS_SERVER_KEY"),
  MIDTRANS_FINISH_URL: envString("MIDTRANS_FINISH_URL"),
  MIDTRANS_HTTP_TIMEOUT: envNumber("MIDTRANS_HTTP_TIMEOUT", 15_000),
  MIDTRANS_PENDING_TRANSACTION_TTL: envNumber(
    "MIDTRANS_PENDING_TRANSACTION_TTL",
    24 * 60 * 60 * 1000
  ),
  // Status API Midtrans kadang belum mengenali transaksi tepat setelah Snap
  // dibuat. Beri waktu untuk rekonsiliasi ulang sebelum menganggapnya gagal.
  MIDTRANS_NOT_FOUND_RETRY_WINDOW: envNumber("MIDTRANS_NOT_FOUND_RETRY_WINDOW", 30 * 60 * 1000),
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
  BAILEYS_INSTANCES,
  BAILEYS_AUTH_STORAGE: DEFAULT_BAILEYS_AUTH_STORAGE,
  BAILEYS_AUTH_STORAGES,
  BAILEYS_BROWSER_NAME: envString("BAILEYS_BROWSER_NAME", "Reminder Bot"),
  BAILEYS_CONNECT_TIMEOUT: envNumber("BAILEYS_CONNECT_TIMEOUT", 30_000),
  BAILEYS_QUERY_TIMEOUT: envNumber("BAILEYS_QUERY_TIMEOUT", 30_000),
  BAILEYS_RECONNECT_BASE_DELAY: envNumber("BAILEYS_RECONNECT_BASE_DELAY", 5_000),
  WHATSAPP_QUEUE_CONCURRENCY: envNumber("WHATSAPP_QUEUE_CONCURRENCY", 1),
  WHATSAPP_RETRY_LIMIT: envNumber("WHATSAPP_RETRY_LIMIT", 3),
  WHATSAPP_RETRY_DELAY: envNumber("WHATSAPP_RETRY_DELAY", 30),
  TELEGRAM_BOT_TOKEN: envString("TELEGRAM_BOT_TOKEN"),
  TELEGRAM_API_URL: envString("TELEGRAM_API_URL", "https://api.telegram.org"),
  TELEGRAM_CHAT_IDS: envString("TELEGRAM_CHAT_IDS"),
  TELEGRAM_HTTP_TIMEOUT: envNumber("TELEGRAM_HTTP_TIMEOUT", 30_000),
  WA_MAX_QUEUE_PROCESS: envNumber("WA_MAX_QUEUE_PROCESS", 5),
  WA_MESSAGE_DELAY: envNumber("WA_MESSAGE_DELAY", 2000),
  WA_MESSAGE_DELAY_MIN: envNumber("WA_MESSAGE_DELAY_MIN", envNumber("WA_MESSAGE_DELAY", 2000)),
  WA_MESSAGE_DELAY_MAX: envNumber("WA_MESSAGE_DELAY_MAX", 5000),
  BAILEYS_RECONNECT_MAX_DELAY: envNumber(
    "BAILEYS_RECONNECT_MAX_DELAY",
    envNumber("WA_RETRY_MAX_DELAY", 30000)
  ),
  BAILEYS_RECONNECT_SERVICE_MAX_DELAY: envNumber(
    "BAILEYS_RECONNECT_SERVICE_MAX_DELAY",
    5 * 60 * 1000
  ),
  BAILEYS_RECONNECT_FORBIDDEN_MAX_DELAY: envNumber(
    "BAILEYS_RECONNECT_FORBIDDEN_MAX_DELAY",
    15 * 60 * 1000
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
  ACTIVE_PERIOD: "ACTIVE-PERIOD",
};

const REMINDER_KINDS = {
  BILLING: "BILLING",
  ACTIVE_PERIOD_EXPIRY: "ACTIVE_PERIOD_EXPIRY",
};

const SUBSCRIPTION_TYPES = {
  RECURRING: "RECURRING",
  ONE_TIME: "ONE_TIME",
};

const DEFAULT_REMINDER_MESSAGE_TEMPLATE = "*PENGINGAT TAGIHAN {{companyNameUpper}}*\n\nYth. Bapak/Ibu {{name}},\n\nBerdasarkan catatan kami, tagihan layanan WiFi Anda sebesar {{totalAmount}} belum lunas.\n\n*Rincian tagihan*\nJatuh tempo: {{date}}\nMasa tenggang: {{graceDays}} hari\nBatas layanan aktif: {{isolationDate}}{{renewalStatusInfo}}\n\nMohon selesaikan pembayaran sebelum batas layanan aktif agar layanan tidak dinonaktifkan.\n\n*Metode pembayaran*\nBCA 134-266-9497 a.n. Hafriyanto\nDANA 087728972090\n\nJika pembayaran sudah dilakukan, pesan ini dapat diabaikan.\n\nHormat kami,\n{{supportSignature}}";

const DEFAULT_SETTINGS = {
  dashboardTitle: "Reminder Bot Control Center",
  companyName: "Emmeril Hotspot",
  supportSignature: "CS Emmeril Hotspot",
  apDownMessageTemplate: "*PEMBERITAHUAN PERANGKAT {{companyNameUpper}}*\n\nYth. Bapak/Ibu {{name}},\n\nSistem kami mendeteksi bahwa perangkat WiFi/AP Anda sedang tidak aktif.\n\nPerangkat terpantau: {{host}}\n\nMohon periksa daya listrik perangkat. Jika diperlukan, cabut kabel daya, tunggu beberapa saat, lalu sambungkan kembali.\n\nJika layanan tetap normal, pesan ini dapat diabaikan.\n\nMohon maaf atas ketidaknyamanannya.\n\nHormat kami,\n{{supportSignature}}",
  customerAccountMessageTemplate: "*INFORMASI AKUN {{companyNameUpper}}*\n\nYth. Bapak/Ibu {{name}},\n\nBerikut informasi akun layanan Anda.\n\n{{portalAccountDetails}}\n\n{{hotspotAccountDetails}}\n\n{{portalAccessGuide}}\n\nMohon simpan informasi ini dan jangan membagikan kata sandi kepada pihak lain.\n\nHormat kami,\n{{supportSignature}}",
  apDownMinimumDownMinutes: 5,
  paymentMessageTemplateArrearsOnly: "*BUKTI PEMBAYARAN TUNGGAKAN {{companyNameUpper}}*\n\nYth. Bapak/Ibu {{name}},\n\nPembayaran tunggakan Anda telah kami terima.\n\n*Rincian pembayaran*\nID transaksi: {{transactionId}}\nTanggal: {{paymentDate}}\nNominal: {{paymentAmount}}\nSisa tunggakan: {{remainingDebtAmount}}\nStatus: {{statusText}}\n\n{{noteText}}\n\nHormat kami,\n{{supportSignature}}",
  paymentMessageTemplateCurrentOnly: "*BUKTI PEMBAYARAN BULAN BERJALAN {{companyNameUpper}}*\n\nYth. Bapak/Ibu {{name}},\n\nPembayaran tagihan bulan berjalan telah kami terima.\n\n*Rincian pembayaran*\nID transaksi: {{transactionId}}\nTanggal: {{paymentDate}}\nStatus: {{statusText}}\n\n{{noteText}}\n\nHormat kami,\n{{supportSignature}}",
  paymentMessageTemplateFullPaid: "*BUKTI PELUNASAN TAGIHAN {{companyNameUpper}}*\n\nYth. Bapak/Ibu {{name}},\n\nSeluruh tagihan yang tercatat telah lunas.\n\n*Rincian pembayaran*\nID transaksi: {{transactionId}}\nTanggal: {{paymentDate}}\nStatus: {{statusText}}\n\n{{noteText}}\n\nHormat kami,\n{{supportSignature}}",
  paymentMessageTemplateActivePeriod: "*BUKTI PEMBELIAN MASA AKTIF {{companyNameUpper}}*\n\nYth. Bapak/Ibu {{name}},\n\nPembelian masa aktif selama satu bulan telah tercatat.\n\n*Rincian pembelian*\nID transaksi: {{transactionId}}\nTanggal: {{paymentDate}}\nNominal: {{paymentAmount}}\nAktif sampai: {{activeUntil}}\nStatus: {{statusText}}\n\n{{noteText}}\n\nHormat kami,\n{{supportSignature}}",
  activePeriodReminderMessageTemplate: "*PENGINGAT MASA AKTIF {{companyNameUpper}}*\n\nYth. Bapak/Ibu {{name}},\n\nMasa aktif sementara akun hotspot Anda akan berakhir pada {{activeUntil}}.\n\n*Rincian tunggakan*\nJumlah: {{debtCount}} bulan\nPeriode: {{debtPeriods}}\nTotal: {{debtAmount}}\n\nPerpanjangan otomatis masih dijeda. Mohon lunasi seluruh tunggakan atau beli masa aktif kembali agar layanan tetap dapat digunakan.\n\nHormat kami,\n{{supportSignature}}",
  billingReminderMessageTemplate: "*PENGINGAT TAGIHAN {{companyNameUpper}}*\n\nYth. Bapak/Ibu {{name}},\n\nBerdasarkan catatan kami, tagihan layanan WiFi Anda belum lunas.\n\n*Rincian tagihan*\nPeriode berjalan: {{billingPeriod}}\nTagihan bulan berjalan: {{currentAmount}}\nPeriode tunggakan: {{debtPeriods}}\nTunggakan: {{debtCount}} bulan ({{debtAmount}})\nTotal tagihan: {{totalAmount}}\nJatuh tempo: {{dueDate}}\n\nMohon lakukan pembayaran sesuai total tagihan. Jika pembayaran sudah dilakukan, pesan ini dapat diabaikan.\n\nHormat kami,\n{{supportSignature}}",
  timezone: "Asia/Jakarta",
  hotspotIsolationGraceDays: 0,
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
  profileMonthlyAmounts: {},
  mikrotikBackupLastRunDate: "",
  databaseBackupLastRunDate: "",
  reminderVariableTemplateMigrationVersion: 0,
  notificationTemplateCopyMigrationVersion: 0,
  serviceScheduleAnchorMigrationVersion: 0,
};

module.exports = {
  CONFIG,
  DEFAULT_REMINDER_MESSAGE_TEMPLATE,
  DEFAULT_SETTINGS,
  MONTH_NAMES,
  PAYMENT_STATUS,
  PAYMENT_TYPES,
  REMINDER_KINDS,
  SUBSCRIPTION_TYPES,
  ROOT_DIR,
};
