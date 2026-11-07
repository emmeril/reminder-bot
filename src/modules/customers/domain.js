const {
  BILLING_CYCLES,
  PAYMENT_TYPES,
  SUBSCRIPTION_TYPES,
} = require("../../config");
const {
  getBillingPeriodParts,
  sanitizeInput,
} = require("../../utils");
const { normalizeMacAddresses } = require("../mikrotik/domain");

const BILLING_START_PERIOD = { year: 2026, month: 4 };
const HOTSPOT_PROVISIONING_STATUS = Object.freeze({
  NONE: "NONE",
  PENDING: "PENDING",
  PROVISIONING: "PROVISIONING",
  ACTIVE: "ACTIVE",
  FAILED: "FAILED",
  DEACTIVATED: "DEACTIVATED",
  DISABLED: "DISABLED",
  MISSING: "MISSING",
  CHANGED: "CHANGED",
});
const HOTSPOT_PROVISIONING_OPERATION = Object.freeze({
  NONE: "NONE",
  CREATE: "CREATE",
  UPDATE: "UPDATE",
  REACTIVATE: "REACTIVATE",
  DEACTIVATE: "DEACTIVATE",
  ENABLE: "ENABLE",
  DISABLE: "DISABLE",
});
const HOTSPOT_ACCESS_MODES = Object.freeze({
  HOTSPOT_ONLY: "HOTSPOT_ONLY",
  IP_BINDING_ONLY: "IP_BINDING_ONLY",
  BOTH: "BOTH",
});
function normalizeHotspotProvisioningStatus(value, fallback = HOTSPOT_PROVISIONING_STATUS.NONE) {
  const normalized = String(value || "").trim().toUpperCase();
  return Object.values(HOTSPOT_PROVISIONING_STATUS).includes(normalized) ? normalized : fallback;
}

function isHotspotAccountUnavailable(status, provisioningError = "") {
  const normalizedStatus = normalizeHotspotProvisioningStatus(status);
  return [
    HOTSPOT_PROVISIONING_STATUS.NONE,
    HOTSPOT_PROVISIONING_STATUS.DEACTIVATED,
    HOTSPOT_PROVISIONING_STATUS.DISABLED,
    HOTSPOT_PROVISIONING_STATUS.MISSING,
  ].includes(normalizedStatus)
    || (normalizedStatus === HOTSPOT_PROVISIONING_STATUS.CHANGED
      && /akun dinonaktifkan/i.test(String(provisioningError || "")));
}

function getHotspotUnavailableMessage(status, provisioningError = "") {
  if (normalizeHotspotProvisioningStatus(status) === HOTSPOT_PROVISIONING_STATUS.CHANGED
    && /akun dinonaktifkan/i.test(String(provisioningError || ""))) {
    return "Akun hotspot dinonaktifkan di MikroTik.";
  }
  if (normalizeHotspotProvisioningStatus(status) === HOTSPOT_PROVISIONING_STATUS.DISABLED) {
    return "Akun hotspot sedang dinonaktifkan oleh administrator.";
  }
  return "Akun hotspot tidak ditemukan di MikroTik.";
}

function normalizeHotspotProvisioningOperation(value, fallback = HOTSPOT_PROVISIONING_OPERATION.NONE) {
  const normalized = String(value || "").trim().toUpperCase();
  return Object.values(HOTSPOT_PROVISIONING_OPERATION).includes(normalized) ? normalized : fallback;
}

function normalizeHotspotAccessMode(value, fallback = HOTSPOT_ACCESS_MODES.HOTSPOT_ONLY) {
  const normalized = String(value || "").trim().toUpperCase();
  return Object.values(HOTSPOT_ACCESS_MODES).includes(normalized) ? normalized : fallback;
}

function getContactHotspotAccessMode(contact = {}) {
  const fallback = normalizeMacAddresses(contact.mikrotikMacAddresses).length > 0
    ? HOTSPOT_ACCESS_MODES.BOTH
    : HOTSPOT_ACCESS_MODES.HOTSPOT_ONLY;
  return normalizeHotspotAccessMode(contact.hotspotAccessMode, fallback);
}

function getHotspotAccessRouterState(mode, serviceDisabled = false) {
  const accessMode = normalizeHotspotAccessMode(mode);
  if (serviceDisabled) return { accessMode, userDisabled: true, bindingType: "blocked" };
  return {
    accessMode,
    userDisabled: accessMode === HOTSPOT_ACCESS_MODES.IP_BINDING_ONLY,
    bindingType: accessMode === HOTSPOT_ACCESS_MODES.HOTSPOT_ONLY ? "regular" : "bypassed",
  };
}

function normalizeProfileMonthlyAmounts(value, { strict = false } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    if (strict && value !== undefined && value !== null) {
      throw new Error("Tarif profile MikroTik tidak valid.");
    }
    return {};
  }

  const normalized = new Map();
  for (const [rawProfile, rawAmount] of Object.entries(value).slice(0, 200)) {
    const profile = sanitizeInput(String(rawProfile || ""));
    if (!profile || rawAmount === "" || rawAmount === null || rawAmount === undefined) continue;
    const amount = Number(rawAmount);
    if (!Number.isFinite(amount) || amount < 0 || amount > 1_000_000_000) {
      if (strict) throw new Error(`Nominal profile "${profile}" harus antara 0 sampai 1 miliar.`);
      continue;
    }
    normalized.set(profile.toLowerCase(), [profile, Math.floor(amount)]);
  }
  return Object.fromEntries(normalized.values());
}

function compareBillingPeriods(a, b) {
  if (a.year !== b.year) return a.year - b.year;
  return a.month - b.month;
}

function addBillingMonths(period, monthsToAdd) {
  const index = (period.year * 12) + (period.month - 1) + monthsToAdd;
  return {
    year: Math.floor(index / 12),
    month: (index % 12) + 1,
  };
}

function getContactBillingStartPeriod(contact, timeZone = "Asia/Jakarta") {
  const createdAt = contact.createdAt ? new Date(contact.createdAt) : null;
  if (!createdAt || Number.isNaN(createdAt.getTime())) {
    return BILLING_START_PERIOD;
  }

  const createdPeriod = getBillingPeriodParts(createdAt, timeZone);
  return compareBillingPeriods(createdPeriod, BILLING_START_PERIOD) > 0
    ? createdPeriod
    : BILLING_START_PERIOD;
}

function normalizeSubscriptionType(value, fallback = SUBSCRIPTION_TYPES.RECURRING) {
  const normalized = String(value || "").trim().toUpperCase().replace(/-/g, "_");
  return Object.values(SUBSCRIPTION_TYPES).includes(normalized) ? normalized : fallback;
}

function normalizeBillingCycle() {
  return BILLING_CYCLES.PREPAID;
}

function isPrepaidPackage(contact) {
  return isRecurringSubscription(contact);
}

function getContactBillingPeriod(contact, referencePeriod) {
  return referencePeriod;
}

function isRecurringSubscription(contact) {
  return normalizeSubscriptionType(contact?.subscriptionType) === SUBSCRIPTION_TYPES.RECURRING;
}

function isOneTimeSubscriptionEnded(contact, period, timeZone = "Asia/Jakarta") {
  if (isRecurringSubscription(contact)) return false;
  const startPeriod = getContactBillingStartPeriod(contact, timeZone);
  return compareBillingPeriods(startPeriod, period) < 0;
}

function listBillingPeriods(start, end) {
  const periods = [];
  for (let period = start; compareBillingPeriods(period, end) <= 0; period = addBillingMonths(period, 1)) {
    periods.push(period);
  }
  return periods;
}

function parsePaymentAmountFromMessage(message) {
  const text = String(message || "");
  const match = text.match(/(?:sebesar\s*)?Rp\s*([0-9][0-9.\s]*(?:,[0-9]{1,2})?)/i);
  if (!match) return 0;
  const digits = match[1].replace(/[.\s]/g, "").replace(/,.*$/, "");
  const amount = Number(digits);
  return Number.isFinite(amount) && amount >= 0 && amount <= 1_000_000_000 ? Math.floor(amount) : 0;
}

const PAYMENT_TYPE_LABELS = {
  [PAYMENT_TYPES.ARREARS_ONLY]: "Hanya Tunggakan",
  [PAYMENT_TYPES.CURRENT_ONLY]: "Periode Tagihan",
  [PAYMENT_TYPES.FULL_PAID]: "Lunas Semua",
  [PAYMENT_TYPES.ACTIVE_PERIOD]: "Masa Aktif 1 Bulan",
};

function formatReportDate(value, includeTime = false, timeZone = "Asia/Jakarta") {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return new Intl.DateTimeFormat("id-ID", {
    timeZone,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    ...(includeTime ? { hour: "2-digit", minute: "2-digit" } : {}),
  }).format(date);
}

function styleReportSheet(sheet) {
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  sheet.autoFilter = { from: "A1", to: sheet.getRow(1).getCell(sheet.columnCount).address };
  sheet.getRow(1).eachCell((cell) => {
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF315C45" } };
    cell.alignment = { vertical: "middle", horizontal: "center" };
  });
  sheet.getRow(1).height = 24;
  sheet.columns.forEach((column) => {
    let maxLength = String(column.header || "").length;
    column.eachCell({ includeEmpty: true }, (cell) => {
      maxLength = Math.max(maxLength, String(cell.value ?? "").length);
    });
    column.width = Math.min(Math.max(maxLength + 2, 12), 42);
  });
}

module.exports = {
  BILLING_START_PERIOD,
  HOTSPOT_ACCESS_MODES,
  HOTSPOT_PROVISIONING_OPERATION,
  HOTSPOT_PROVISIONING_STATUS,
  PAYMENT_TYPE_LABELS,
  addBillingMonths,
  compareBillingPeriods,
  formatReportDate,
  getContactBillingPeriod,
  getContactBillingStartPeriod,
  getContactHotspotAccessMode,
  getHotspotAccessRouterState,
  getHotspotUnavailableMessage,
  isHotspotAccountUnavailable,
  isOneTimeSubscriptionEnded,
  isPrepaidPackage,
  isRecurringSubscription,
  listBillingPeriods,
  normalizeBillingCycle,
  normalizeHotspotAccessMode,
  normalizeHotspotProvisioningOperation,
  normalizeHotspotProvisioningStatus,
  normalizeProfileMonthlyAmounts,
  normalizeSubscriptionType,
  parsePaymentAmountFromMessage,
  styleReportSheet,
};
