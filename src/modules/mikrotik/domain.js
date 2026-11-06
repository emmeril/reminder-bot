const crypto = require("crypto");
const net = require("net");
const { sanitizeInput } = require("../../utils");

const IP_BINDING_BANDWIDTH_STATUS = Object.freeze({
  NONE: "NONE",
  ACTIVE: "ACTIVE",
  PARTIAL: "PARTIAL",
  PENDING_DHCP: "PENDING_DHCP",
  NO_RATE_LIMIT: "NO_RATE_LIMIT",
  FAILED: "FAILED",
});

function normalizeMacAddress(value, { required = false } = {}) {
  const raw = String(value || "").trim();
  if (!raw) {
    if (required) throw new Error("MAC address wajib diisi untuk IP Binding.");
    return "";
  }
  const compact = raw.replace(/[^a-fA-F0-9]/g, "");
  if (!/^[a-fA-F0-9]{12}$/.test(compact)) {
    throw new Error("Format MAC address tidak valid. Gunakan format AA:BB:CC:DD:EE:FF.");
  }
  const normalized = compact.match(/.{2}/g).join(":").toUpperCase();
  if (normalized === "00:00:00:00:00:00" || (parseInt(normalized.slice(0, 2), 16) & 1) === 1) {
    throw new Error("MAC address perangkat harus berupa alamat unicast yang valid.");
  }
  return normalized;
}

function normalizeMacAddresses(values, { max = 10 } = {}) {
  const source = Array.isArray(values) ? values : (values ? [values] : []);
  const normalized = [...new Set(source.map((value) => normalizeMacAddress(value)).filter(Boolean))];
  if (normalized.length > max) throw new Error(`Maksimal ${max} MAC address per pelanggan.`);
  return normalized;
}

function buildIpBindingOwnerComment(contactId) {
  return `reminder-bot:${String(contactId || "").trim()}`;
}

function buildIpBindingBandwidthOwnerComment(contactId) {
  return `reminder-bot-bandwidth:${String(contactId || "").trim()}`;
}

function buildIpBindingBandwidthQueueName(contactId, targetAddress = "") {
  const rawId = String(contactId || "").trim();
  const readable = rawId.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 16) || "customer";
  const address = String(targetAddress || "").trim();
  if (!address) {
    const suffix = crypto.createHash("sha256").update(rawId).digest("hex").slice(0, 8);
    return `RB-${readable}-${suffix}`;
  }
  const readableAddress = address.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 20);
  const suffix = crypto.createHash("sha256").update(`${rawId}\0${address}`).digest("hex").slice(0, 6);
  return `RB-${readable}-${readableAddress}-${suffix}`;
}

function normalizeIpBindingBandwidthStatus(value, fallback = IP_BINDING_BANDWIDTH_STATUS.NONE) {
  const normalized = String(value || "").trim().toUpperCase();
  return Object.values(IP_BINDING_BANDWIDTH_STATUS).includes(normalized) ? normalized : fallback;
}

function normalizeHotspotRatePair(value, fieldName) {
  const parts = String(value || "").trim().split("/");
  if (parts.length > 2 || parts.some((part) => !/^\d+(?:\.\d+)?[kKmMgGtTpP]?$/.test(part))) {
    throw new Error(`${fieldName} profile "${value}" tidak dapat dipakai untuk bandwidth IP Binding.`);
  }
  return parts.length === 1 ? `${parts[0]}/${parts[0]}` : `${parts[0]}/${parts[1]}`;
}

function normalizeHotspotBurstTime(value) {
  const parts = String(value || "").trim().split("/");
  if (parts.length > 2 || parts.some((part) => !/^\d+(?:\.\d+)?s?$/.test(part))) {
    throw new Error(`Burst time profile "${value}" tidak dapat dipakai untuk bandwidth IP Binding.`);
  }
  const normalized = parts.map((part) => (part.endsWith("s") ? part : `${part}s`));
  return normalized.length === 1 ? `${normalized[0]}/${normalized[0]}` : normalized.join("/");
}

function parseHotspotRateLimitForSimpleQueue(value) {
  const source = sanitizeInput(String(value || ""));
  if (!source) return null;
  const parts = source.split(/\s+/);
  if (parts.length > 6) {
    throw new Error(`Rate limit profile "${source}" memiliki parameter yang tidak dikenal.`);
  }
  const maxLimit = normalizeHotspotRatePair(parts[0], "Max limit");
  const burstLimit = parts[1]
    ? normalizeHotspotRatePair(parts[1], "Burst limit")
    : "0/0";
  const burstThreshold = parts[2]
    ? normalizeHotspotRatePair(parts[2], "Burst threshold")
    : (parts[1] ? maxLimit : "0/0");
  const burstTime = parts[3] ? normalizeHotspotBurstTime(parts[3]) : (parts[1] ? "1s/1s" : "0s/0s");
  const priorityValue = parts[4] || "8";
  if (!/^[1-8]$/.test(priorityValue)) {
    throw new Error(`Priority profile "${priorityValue}" harus antara 1 sampai 8.`);
  }
  const limitAt = parts[5]
    ? normalizeHotspotRatePair(parts[5], "Limit at")
    : "0/0";
  return {
    source,
    maxLimit,
    burstLimit,
    burstThreshold,
    burstTime,
    priority: `${priorityValue}/${priorityValue}`,
    limitAt,
  };
}

function normalizeSimpleQueueLimitForComparison(value) {
  const parts = sanitizeInput(String(value || "")).split("/");
  if (parts.length !== 2) return "";
  const multipliers = {
    "": 1,
    k: 1_000,
    m: 1_000_000,
    g: 1_000_000_000,
    t: 1_000_000_000_000,
    p: 1_000_000_000_000_000,
  };
  const normalized = parts.map((part) => {
    const match = String(part).trim().match(/^(\d+(?:\.\d+)?)([kKmMgGtTpP]?)$/);
    if (!match) return null;
    const amount = Number(match[1]) * multipliers[match[2].toLowerCase()];
    return Number.isFinite(amount) ? String(Math.round(amount)) : null;
  });
  return normalized.some((part) => part === null) ? "" : normalized.join("/");
}

function normalizeQueueTarget(value) {
  const values = Array.isArray(value) ? value : String(value || "").split(",");
  return [...new Set(values
    .map((item) => String(item || "").trim().replace(/\/32$/, ""))
    .filter((item) => net.isIP(item) === 4))]
    .sort((left, right) => left.localeCompare(right, "en", { numeric: true }));
}

function readRouterValue(record, apiName, camelName, fallback = "") {
  if (!record || typeof record !== "object") return fallback;
  if (record[apiName] !== undefined && record[apiName] !== null) return record[apiName];
  if (record[camelName] !== undefined && record[camelName] !== null) return record[camelName];
  return fallback;
}

module.exports = {
  IP_BINDING_BANDWIDTH_STATUS,
  buildIpBindingBandwidthOwnerComment,
  buildIpBindingBandwidthQueueName,
  buildIpBindingOwnerComment,
  normalizeHotspotBurstTime,
  normalizeHotspotRatePair,
  normalizeIpBindingBandwidthStatus,
  normalizeMacAddress,
  normalizeMacAddresses,
  normalizeQueueTarget,
  normalizeSimpleQueueLimitForComparison,
  parseHotspotRateLimitForSimpleQueue,
  readRouterValue,
};
