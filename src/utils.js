const fsSync = require("fs");
const crypto = require("crypto");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const generateId = () => `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;

function escapeHtml(value) {
  if (typeof value !== "string") return value;
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function sanitizeInput(value) {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001F\u007F-\u009F]/g, "").trim();
}

function sanitizeMultilineText(value) {
  if (typeof value !== "string") return "";
  return value
    .replace(/\r\n/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "")
    .trim();
}

function parseBoolean(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value !== "string") return fallback;

  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "off", ""].includes(normalized)) return false;
  return fallback;
}

function collectSecurityWarnings(config) {
  const warnings = [];

  if (config.WEB_API_KEY === "dev-key-change-in-production") {
    warnings.push("WEB_API_KEY masih memakai nilai default.");
  }

  if (config.AUTH_USERNAME === "admin" && config.AUTH_PASSWORD === "admin123") {
    warnings.push("Kredensial login dashboard masih memakai nilai default.");
  }

  if (config.SESSION_SECRET === "change-this-session-secret") {
    warnings.push("SESSION_SECRET masih memakai nilai default.");
  }

  return warnings;
}

function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader) return cookies;

  for (const part of String(cookieHeader).split(";")) {
    const [rawKey, ...rawValue] = part.trim().split("=");
    if (!rawKey) continue;
    try {
      cookies[rawKey] = decodeURIComponent(rawValue.join("=") || "");
    } catch {
      cookies[rawKey] = rawValue.join("=") || "";
    }
  }

  return cookies;
}

function serializeCookie(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (options.maxAge !== undefined) parts.push(`Max-Age=${options.maxAge}`);
  if (options.path) parts.push(`Path=${options.path}`);
  if (options.httpOnly) parts.push("HttpOnly");
  if (options.sameSite) parts.push(`SameSite=${options.sameSite}`);
  if (options.secure) parts.push("Secure");
  return parts.join("; ");
}

function safeCompareString(left, right) {
  const leftBuffer = Buffer.from(String(left || ""));
  const rightBuffer = Buffer.from(String(right || ""));
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function normalizePhoneNumber(value) {
  return sanitizeInput(String(value || "")).replace(/[^0-9]/g, "");
}

function isValidPhoneNumber(value) {
  return /^628\d{7,13}$/.test(value);
}

function formatUsernameFromName(name) {
  return sanitizeInput(name)
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_]/g, "");
}

function buildHotspotEmailFromPhone(phoneNumber) {
  const normalized = normalizePhoneNumber(phoneNumber);
  return normalized ? `${normalized}@localhost.local` : "";
}

function parseDateTimeInput(input) {
  const match = sanitizeInput(input).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/);
  if (!match) return null;

  const [, year, month, day, hour, minute] = match;
  const yearNum = Number(year);
  const monthNum = Number(month);
  const dayNum = Number(day);
  const hourNum = Number(hour);
  const minuteNum = Number(minute);

  if (monthNum < 1 || monthNum > 12) return null;
  if (dayNum < 1 || dayNum > 31) return null;
  if (hourNum < 0 || hourNum > 23) return null;
  if (minuteNum < 0 || minuteNum > 59) return null;

  const maxDays = new Date(yearNum, monthNum, 0).getDate();
  if (dayNum > maxDays) return null;

  const date = new Date(yearNum, monthNum - 1, dayNum, hourNum, minuteNum);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

function formatDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatDateTime(date) {
  return new Date(date).toLocaleString("id-ID", {
    dateStyle: "long",
    timeStyle: "short",
    timeZone: "Asia/Jakarta",
  });
}

function getBillingPeriodKey(date = new Date()) {
  const source = new Date(date);
  return `${source.getFullYear()}-${String(source.getMonth() + 1).padStart(2, "0")}`;
}

function getBillingPeriodParts(date = new Date()) {
  const source = new Date(date);
  return {
    year: source.getFullYear(),
    month: source.getMonth() + 1,
  };
}

function makeBillingPeriodKey(year, month) {
  return `${year}-${String(month).padStart(2, "0")}`;
}

function getPreviousBillingPeriod(year, month) {
  return month === 1
    ? { year: year - 1, month: 12 }
    : { year, month: month - 1 };
}

function formatBillingPeriodLabel(year, month, monthNames) {
  return `${monthNames[month] || month} ${year}`;
}

function addMonthsSafely(dateValue, monthsToAdd) {
  const source = new Date(dateValue);
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
}

function resolveChromeExecutablePath() {
  const envCandidates = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    process.env.CHROME_PATH,
    process.env.CHROMIUM_PATH,
  ].filter(Boolean);

  for (const candidate of envCandidates) {
    if (fsSync.existsSync(candidate)) {
      return candidate;
    }
  }

  if (process.platform !== "linux") {
    return null;
  }

  const linuxCandidates = [
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/snap/bin/chromium",
  ];

  for (const candidate of linuxCandidates) {
    if (fsSync.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

module.exports = {
  sleep,
  generateId,
  escapeHtml,
  sanitizeInput,
  sanitizeMultilineText,
  parseBoolean,
  collectSecurityWarnings,
  parseCookies,
  serializeCookie,
  safeCompareString,
  normalizePhoneNumber,
  isValidPhoneNumber,
  formatUsernameFromName,
  buildHotspotEmailFromPhone,
  parseDateTimeInput,
  formatDate,
  formatDateTime,
  getBillingPeriodKey,
  getBillingPeriodParts,
  makeBillingPeriodKey,
  getPreviousBillingPeriod,
  formatBillingPeriodLabel,
  addMonthsSafely,
  resolveChromeExecutablePath,
};
