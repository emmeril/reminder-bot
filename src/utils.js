const crypto = require("crypto");
const { CONFIG, MONTH_NAMES } = require("./config");

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

function sanitizeTimeHHMM(value, fallback = "02:00") {
  const normalized = sanitizeInput(value);
  if (!normalized) return fallback;
  const match = normalized.match(/^(\d{2}):(\d{2})$/);
  if (!match) return fallback;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (Number.isNaN(hours) || Number.isNaN(minutes)) return fallback;
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return fallback;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function sanitizePositiveInteger(value, fallback = 1, min = 1, max = 10) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;

  const normalized = Math.floor(parsed);
  if (normalized < min || normalized > max) return fallback;

  return normalized;
}

function parseNetwatchSinceDate(value) {
  const input = sanitizeInput(value);
  if (!input) return null;

  const directDate = new Date(input);
  if (!Number.isNaN(directDate.getTime())) {
    return directDate;
  }

  const normalized = input.toLowerCase();
  const monthMap = {
    jan: 0,
    feb: 1,
    mar: 2,
    apr: 3,
    may: 4,
    jun: 5,
    jul: 6,
    aug: 7,
    sep: 8,
    oct: 9,
    nov: 10,
    dec: 11,
  };

  let match = normalized.match(/^([a-z]{3})\/(\d{1,2})\/(\d{4})\s+(\d{2}):(\d{2}):(\d{2})$/);
  if (match && monthMap[match[1]] !== undefined) {
    const [, monthName, day, year, hour, minute, second] = match;
    const date = new Date(
      Number(year),
      monthMap[monthName],
      Number(day),
      Number(hour),
      Number(minute),
      Number(second)
    );
    if (!Number.isNaN(date.getTime())) return date;
  }

  match = normalized.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (match) {
    const [, year, month, day, hour, minute, second = "00"] = match;
    const date = new Date(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second)
    );
    if (!Number.isNaN(date.getTime())) return date;
  }

  return null;
}

function getDateTimePartsInTimezone(date = new Date(), timeZone = "Asia/Jakarta") {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  const parts = formatter.formatToParts(date).reduce((acc, item) => {
    if (item.type !== "literal") acc[item.type] = item.value;
    return acc;
  }, {});

  return {
    year: parts.year || "",
    month: parts.month || "",
    day: parts.day || "",
    hour: parts.hour || "00",
    minute: parts.minute || "00",
    dateKey: `${parts.year || "0000"}-${parts.month || "00"}-${parts.day || "00"}`,
    timeKey: `${parts.hour || "00"}:${parts.minute || "00"}`,
  };
}

function collectSecurityWarnings() {
  const warnings = [];

  if (CONFIG.WEB_API_KEY === "dev-key-change-in-production") {
    warnings.push("WEB_API_KEY masih memakai nilai default.");
  }

  if (CONFIG.AUTH_USERNAME === "admin" && CONFIG.AUTH_PASSWORD === "admin123") {
    warnings.push("Kredensial login dashboard masih memakai nilai default.");
  }

  if (CONFIG.SESSION_SECRET === "change-this-session-secret") {
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

function formatBillingPeriodLabel(year, month) {
  return `${MONTH_NAMES[month] || month} ${year}`;
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

module.exports = {
  addMonthsSafely,
  buildHotspotEmailFromPhone,
  collectSecurityWarnings,
  escapeHtml,
  formatBillingPeriodLabel,
  formatDate,
  formatDateTime,
  formatUsernameFromName,
  generateId,
  getBillingPeriodKey,
  getBillingPeriodParts,
  getDateTimePartsInTimezone,
  getPreviousBillingPeriod,
  isValidPhoneNumber,
  makeBillingPeriodKey,
  normalizePhoneNumber,
  parseBoolean,
  parseCookies,
  parseDateTimeInput,
  parseNetwatchSinceDate,
  safeCompareString,
  sanitizeInput,
  sanitizeMultilineText,
  sanitizePositiveInteger,
  sanitizeTimeHHMM,
  serializeCookie,
  sleep,
};
