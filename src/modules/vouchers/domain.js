const crypto = require("crypto");

const { DEFAULT_SETTINGS } = require("../../config");
const {
  parseBoolean,
  sanitizeInput,
  zonedDateTimeToDate,
} = require("../../utils");

const VOUCHER_CHARACTER_SETS = Object.freeze({
  LOWER: "abcdefghjkmnpqrstuvwxyz23456789",
  UPPER: "ABCDEFGHJKMNPQRSTUVWXYZ23456789",
  MIXED: "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789",
  NUMERIC: "23456789",
});

const VOUCHER_EXPIRY_MODES = Object.freeze({
  rem: { label: "Hapus saat kedaluwarsa", action: "remove", recordsUsage: false },
  ntf: { label: "Batasi saat kedaluwarsa", action: "set limit-uptime=1s", recordsUsage: false },
  remc: { label: "Hapus dan catat pemakaian", action: "remove", recordsUsage: true },
  ntfc: { label: "Batasi dan catat pemakaian", action: "set limit-uptime=1s", recordsUsage: true },
});

const ROUTER_MONTH_NUMBERS = Object.freeze({
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
});

function parseVoucherProfileMetadata(onLogin = "") {
  const parts = String(onLogin || "").split(",");
  const expiredMode = String(parts[1] || "").trim().toLowerCase();
  const validity = String(parts[3] || "").trim();
  return {
    expiredMode: VOUCHER_EXPIRY_MODES[expiredMode] ? expiredMode : "0",
    validity,
    costPrice: Math.max(0, Number(parts[2]) || 0),
    sellingPrice: Math.max(0, Number(parts[4]) || 0),
    lockUser: String(parts[6] || "").trim().toLowerCase() === "enable",
    commission: Math.max(0, Number(parts[7]) || 0),
  };
}

function parseRouterVoucherUsageDate(dateValue, timeValue, timeZone = DEFAULT_SETTINGS.timezone) {
  const rawDate = String(dateValue || "").trim().toLowerCase();
  const rawTime = String(timeValue || "").trim();
  let year = 0;
  let month = 0;
  let day = 0;
  let match = rawDate.match(/^([a-z]{3})\/(\d{1,2})\/(\d{4})$/i);
  if (match) {
    month = ROUTER_MONTH_NUMBERS[match[1].toLowerCase()] || 0;
    day = Number(match[2]);
    year = Number(match[3]);
  } else {
    match = rawDate.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (match) {
      year = Number(match[1]);
      month = Number(match[2]);
      day = Number(match[3]);
    }
  }
  const timeMatch = rawTime.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!year || !month || !day || !timeMatch) return null;
  const date = zonedDateTimeToDate({
    year,
    month,
    day,
    hour: Number(timeMatch[1]),
    minute: Number(timeMatch[2]),
    second: Number(timeMatch[3] || 0),
  }, timeZone);
  if (!date || Number.isNaN(date.getTime())) return null;
  return {
    date,
    period: `${year}-${String(month).padStart(2, "0")}`,
  };
}

function parseVoucherBatchComment(value) {
  const comment = sanitizeInput(String(value || ""));
  const match = comment.match(/^(?:voucher-([a-z0-9]+-[a-f0-9]+)(?:\s+(.*))?|vc\|([a-z0-9]+-[a-f0-9]+)\|(.*))$/i);
  if (!match) return null;
  return {
    batchId: match[1] || match[3],
    comment: match[2] || match[4] || "",
  };
}

function parseVoucherUsageRecord(script, profileFinancials, timeZone = DEFAULT_SETTINGS.timezone) {
  if (String(script?.comment || "").trim().toLowerCase() !== "mikhmon") return null;
  const parts = String(script.name || "").split("-|-");
  if (parts.length < 10) return null;
  const service = String(parts[9] || "hotspot").trim().toLowerCase();
  const profile = sanitizeInput(String(parts[7] || ""));
  const username = sanitizeInput(String(parts[2] || ""));
  const usageDate = parseRouterVoucherUsageDate(parts[0], parts[1], timeZone);
  if (service !== "hotspot" || !profile || !username || !usageDate) return null;
  const financials = profileFinancials.get(profile) || {};
  const recordedPrice = Math.max(0, Number(parts[3]) || 0);
  const readRecordedMoney = (index, fallback) => {
    if (index < parts.length && String(parts[index] ?? "").trim() !== "") {
      const value = Number(parts[index]);
      if (Number.isFinite(value) && value >= 0) return value;
    }
    return Math.max(0, Number(fallback) || 0);
  };
  const amount = recordedPrice || Math.max(0, Number(financials.sellingPrice || financials.costPrice) || 0);
  const costPrice = readRecordedMoney(10, financials.costPrice);
  const commission = readRecordedMoney(11, financials.commission);
  const rawRecord = [
    String(script.name || ""),
    String(script.owner || ""),
    String(script.source || ""),
    String(script.comment || ""),
  ].join("\u001f");
  const batch = parseVoucherBatchComment(parts[8]);
  return {
    id: `voucher-usage-${crypto.createHash("sha256").update(rawRecord).digest("hex")}`,
    routerScriptId: sanitizeInput(String(script[".id"] || script.id || "")),
    username,
    profile,
    amount,
    costPrice,
    commission,
    usedAt: usageDate.date.toISOString(),
    period: usageDate.period,
    validity: sanitizeInput(String(parts[6] || "")),
    address: sanitizeInput(String(parts[4] || "")),
    macAddress: sanitizeInput(String(parts[5] || "")),
    batchId: batch?.batchId || "",
  };
}

function isValidCalendarDate(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

function normalizeVoucherRevenueRange(options = {}) {
  const input = typeof options === "string" ? { period: options } : (options || {});
  const period = sanitizeInput(String(input.period || ""));
  let dateFrom = sanitizeInput(String(input.dateFrom || input.from || ""));
  let dateTo = sanitizeInput(String(input.dateTo || input.to || ""));
  if (period && !dateFrom && !dateTo) {
    if (!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(period)) {
      throw new Error("Periode laporan voucher tidak valid.");
    }
    const [year, month] = period.split("-").map(Number);
    dateFrom = `${period}-01`;
    dateTo = `${period}-${String(new Date(Date.UTC(year, month, 0)).getUTCDate()).padStart(2, "0")}`;
  }
  if (!isValidCalendarDate(dateFrom) || !isValidCalendarDate(dateTo)) {
    throw new Error("Rentang tanggal laporan voucher tidak valid.");
  }
  if (dateFrom > dateTo) {
    throw new Error("Tanggal mulai laporan voucher tidak boleh melewati tanggal akhir.");
  }
  return { dateFrom, dateTo, period };
}

function getZonedDateKey(value, timeZone = DEFAULT_SETTINGS.timezone) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date).reduce((result, part) => {
    if (part.type !== "literal") result[part.type] = part.value;
    return result;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function buildVoucherRevenueReport(entries = [], options = {}) {
  const range = normalizeVoucherRevenueRange(options);
  const timeZone = sanitizeInput(String(
    options && typeof options === "object" ? options.timeZone : DEFAULT_SETTINGS.timezone
  )) || DEFAULT_SETTINGS.timezone;
  const periodEntries = Array.from(entries)
    .filter((entry) => {
      const dateKey = getZonedDateKey(entry?.usedAt, timeZone);
      return dateKey && dateKey >= range.dateFrom && dateKey <= range.dateTo;
    })
    .map((entry) => structuredClone(entry))
    .sort((a, b) => (
      new Date(b.usedAt).getTime() - new Date(a.usedAt).getTime()
      || String(a.username || "").localeCompare(String(b.username || ""), "id-ID")
    ));
  const profileMap = new Map();
  for (const entry of periodEntries) {
    const row = profileMap.get(entry.profile) || {
      profile: entry.profile,
      quantity: 0,
      revenue: 0,
      costPrice: 0,
      commission: 0,
    };
    row.quantity += 1;
    row.revenue += Math.max(0, Number(entry.amount) || 0);
    row.costPrice += Math.max(0, Number(entry.costPrice) || 0);
    row.commission += Math.max(0, Number(entry.commission) || 0);
    profileMap.set(entry.profile, row);
  }
  const profileSummary = Array.from(profileMap.values()).sort((a, b) => (
    b.revenue - a.revenue || a.profile.localeCompare(b.profile, "id-ID")
  ));
  return {
    period: range.period,
    dateFrom: range.dateFrom,
    dateTo: range.dateTo,
    summary: {
      revenue: periodEntries.reduce((total, entry) => total + Math.max(0, Number(entry.amount) || 0), 0),
      costPrice: periodEntries.reduce((total, entry) => total + Math.max(0, Number(entry.costPrice) || 0), 0),
      commission: periodEntries.reduce((total, entry) => total + Math.max(0, Number(entry.commission) || 0), 0),
      quantity: periodEntries.length,
      profiles: profileSummary.length,
    },
    profileSummary,
    entries: periodEntries,
  };
}

function normalizeVoucherProfilePayload(payload = {}) {
  const originalName = sanitizeInput(String(payload.originalName || ""));
  const name = sanitizeInput(String(payload.name || "")).replace(/\s+/g, "-");
  if (!name) throw new Error("Nama profile voucher wajib diisi.");
  if (name.length > 64 || !/^[A-Za-z0-9._-]+$/.test(name)) {
    throw new Error("Nama profile hanya boleh berisi huruf, angka, titik, garis bawah, atau tanda hubung.");
  }
  if (originalName && (originalName.length > 64 || !/^[A-Za-z0-9._-]+$/.test(originalName))) {
    throw new Error("Nama profile lama tidak valid.");
  }

  const expiredMode = String(payload.expiredMode || "").trim().toLowerCase();
  if (!VOUCHER_EXPIRY_MODES[expiredMode]) throw new Error("Aturan kedaluwarsa voucher wajib dipilih.");
  const validity = sanitizeInput(String(payload.validity || "")).toLowerCase();
  if (!validity || validity.length > 32 || !/^(?:\d+[wdhms])+$/i.test(validity)) {
    throw new Error("Masa berlaku harus memakai format seperti 4h, 1d, atau 30d.");
  }

  const sharedUsers = Number(payload.sharedUsers ?? 1);
  if (!Number.isInteger(sharedUsers) || sharedUsers < 1 || sharedUsers > 10_000) {
    throw new Error("Shared users harus berupa angka 1 sampai 10.000.");
  }
  const rateLimit = sanitizeInput(String(payload.rateLimit || ""));
  if (rateLimit.length > 64 || (rateLimit && !/^[A-Za-z0-9./\s-]+$/.test(rateLimit))) {
    throw new Error("Rate limit tidak valid.");
  }
  const addressPool = sanitizeInput(String(payload.addressPool || "none")) || "none";
  const parentQueue = sanitizeInput(String(payload.parentQueue || "none")) || "none";
  if (addressPool.length > 64 || parentQueue.length > 64) {
    throw new Error("Address pool atau parent queue terlalu panjang.");
  }

  const normalizeMoney = (value, label) => {
    const amount = value === "" || value === null || value === undefined ? 0 : Number(value);
    if (!Number.isFinite(amount) || amount < 0 || amount > 1_000_000_000) {
      throw new Error(`${label} harus antara 0 sampai 1 miliar.`);
    }
    return Math.floor(amount);
  };

  const costPrice = normalizeMoney(payload.costPrice, "HPP");
  const sellingPrice = normalizeMoney(payload.sellingPrice, "Harga jual");

  return {
    originalName,
    name,
    sharedUsers,
    rateLimit,
    addressPool,
    parentQueue,
    expiredMode,
    validity,
    costPrice,
    sellingPrice,
    commission: Math.max(0, sellingPrice - costPrice),
    lockUser: parseBoolean(payload.lockUser, false),
  };
}

function buildVoucherProfileScripts(profile) {
  const lockMode = profile.lockUser ? "Enable" : "Disable";
  const lockScript = profile.lockUser
    ? '; :local lockUserId [/ip hotspot user find where name=$user]; :if ([:len $lockUserId] > 0) do={ :local currentLock [/ip hotspot user get $lockUserId mac-address]; :if ([:len $currentLock] = 0 or $currentLock = "00:00:00:00:00:00") do={ /ip hotspot user set mac-address=$"mac-address" $lockUserId; } }'
    : "";
  const mode = VOUCHER_EXPIRY_MODES[profile.expiredMode];
  const reportPrice = profile.sellingPrice || profile.costPrice;
  const recordScript = mode.recordsUsage
    ? `; :local mac $"mac-address"; :local time [/system clock get time ]; /system script add name="$date-|-$time-|-$user-|-${reportPrice}-|-$address-|-$mac-|-${profile.validity}-|-${profile.name}-|-$comment-|-hotspot-|-${profile.costPrice}-|-${profile.commission}" owner="$month$year" source="$date" comment="mikhmon"`
    : "";
  const header = `:put (",${profile.expiredMode},${profile.costPrice},${profile.validity},${profile.sellingPrice},,${lockMode},${profile.commission},")`;
  const activation = `; {:local comment [ /ip hotspot user get [/ip hotspot user find where name="$user"] comment]; :local ucode [:pic $comment 0 2]; :if ($ucode = "vc" or $ucode = "up" or $comment = "") do={ :local date [ /system clock get date ];:local year [ :pick $date 7 11 ];:local month [ :pick $date 0 3 ]; /system scheduler add name="$user" disabled=no start-date=$date interval="${profile.validity}"; :delay 5s; :local exp [ /system scheduler get [ /system scheduler find where name="$user" ] next-run]; :local getxp [len $exp]; :if ($getxp = 15) do={ :local d [:pick $exp 0 6]; :local t [:pick $exp 7 16]; :local s ("/"); :local exp ("$d$s$year $t"); /ip hotspot user set comment="$exp" [find where name="$user"];}; :if ($getxp = 8) do={ /ip hotspot user set comment="$date $exp" [find where name="$user"];}; :if ($getxp > 15) do={ /ip hotspot user set comment="$exp" [find where name="$user"];};:delay 5s; /system scheduler remove [find where name="$user"]${recordScript}}}${lockScript}`;
  const monitor = `:local dateint do={:local montharray ( "jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec" );:local days [ :pick $d 4 6 ];:local month [ :pick $d 0 3 ];:local year [ :pick $d 7 11 ];:local monthint ([ :find $montharray $month]);:local month ($monthint + 1);:if ( [len $month] = 1) do={:local zero ("0");:return [:tonum ("$year$zero$month$days")];} else={:return [:tonum ("$year$month$days")];}}; :local timeint do={ :local hours [ :pick $t 0 2 ]; :local minutes [ :pick $t 3 5 ]; :return ($hours * 60 + $minutes) ; }; :local date [ /system clock get date ]; :local time [ /system clock get time ]; :local today [$dateint d=$date] ; :local curtime [$timeint t=$time] ; :foreach i in [ /ip hotspot user find where profile="${profile.name}" ] do={ :local comment [ /ip hotspot user get $i comment]; :local name [ /ip hotspot user get $i name]; :local gettime [:pick $comment 12 20]; :if ([:pick $comment 3] = "/" and [:pick $comment 6] = "/") do={:local expd [$dateint d=$comment] ; :local expt [$timeint t=$gettime] ; :if (($expd < $today and $expt < $curtime) or ($expd < $today and $expt > $curtime) or ($expd = $today and $expt < $curtime)) do={ [ /ip hotspot user ${mode.action} $i ]; [ /ip hotspot active remove [find where user=$name] ];}}}`;
  return { onLogin: `${header}${activation}`, monitor };
}

function normalizeVoucherCredential(value, label, { required = true, maxLength = 64 } = {}) {
  const normalized = sanitizeInput(String(value ?? ""));
  if (!normalized && required) throw new Error(`${label} wajib diisi.`);
  if (!normalized) return "";
  if (normalized.length > maxLength) throw new Error(`${label} maksimal ${maxLength} karakter.`);
  if (!/^[A-Za-z0-9._-]+$/.test(normalized)) {
    throw new Error(`${label} hanya boleh berisi huruf, angka, titik, garis bawah, atau tanda hubung.`);
  }
  return normalized;
}

function normalizeVoucherGenerationPayload(payload = {}) {
  const generationType = String(payload.generationType || "SINGLE").trim().toUpperCase();
  if (!["SINGLE", "BULK"].includes(generationType)) {
    throw new Error("Jenis pembuatan voucher tidak valid.");
  }

  const profile = sanitizeInput(String(payload.profile || ""));
  const server = sanitizeInput(String(payload.server || "all")) || "all";
  if (!profile) throw new Error("Profile voucher wajib dipilih.");
  if (profile.length > 64 || server.length > 64) throw new Error("Profile atau server hotspot terlalu panjang.");

  const limitUptime = sanitizeInput(String(payload.limitUptime || "")).toLowerCase();
  if (limitUptime && (limitUptime.length > 64 || !/^[0-9wdhms:.]+$/.test(limitUptime))) {
    throw new Error("Batas waktu harus memakai format MikroTik, misalnya 1h, 12h, atau 1d.");
  }

  const dataLimit = payload.dataLimit === "" || payload.dataLimit === null || payload.dataLimit === undefined
    ? 0
    : Number(payload.dataLimit);
  if (!Number.isInteger(dataLimit) || dataLimit < 0 || dataLimit > 9_999) {
    throw new Error("Batas data harus berupa angka 0 sampai 9.999.");
  }
  const dataUnit = String(payload.dataUnit || "MB").trim().toUpperCase();
  if (!["MB", "GB"].includes(dataUnit)) throw new Error("Satuan batas data tidak valid.");

  const comment = sanitizeInput(String(payload.comment || ""));
  if (comment.length > 80) throw new Error("Catatan voucher maksimal 80 karakter.");

  if (generationType === "SINGLE") {
    return {
      generationType,
      quantity: 1,
      username: normalizeVoucherCredential(payload.username, "Username voucher"),
      password: normalizeVoucherCredential(payload.password, "Password voucher"),
      profile,
      server,
      limitUptime,
      dataLimit,
      dataUnit,
      comment,
    };
  }

  const quantity = Number(payload.quantity);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 500) {
    throw new Error("Jumlah voucher harus antara 1 sampai 500.");
  }
  const credentialMode = String(payload.credentialMode || "SEPARATE").trim().toUpperCase();
  if (!["SAME", "SEPARATE"].includes(credentialMode)) {
    throw new Error("Pola username dan password tidak valid.");
  }
  const characterSet = String(payload.characterSet || "LOWER").trim().toUpperCase();
  if (!VOUCHER_CHARACTER_SETS[characterSet]) throw new Error("Jenis karakter voucher tidak valid.");
  const codeLength = Number(payload.codeLength);
  if (!Number.isInteger(codeLength) || codeLength < 4 || codeLength > 12) {
    throw new Error("Panjang kode voucher harus antara 4 sampai 12 karakter.");
  }
  const prefix = normalizeVoucherCredential(payload.prefix, "Prefix voucher", {
    required: false,
    maxLength: 12,
  });
  if (prefix.length + codeLength > 64) throw new Error("Gabungan prefix dan kode voucher terlalu panjang.");

  return {
    generationType,
    quantity,
    credentialMode,
    characterSet,
    codeLength,
    prefix,
    profile,
    server,
    limitUptime,
    dataLimit,
    dataUnit,
    comment,
  };
}

function generateSecureVoucherCode(length, characters) {
  let value = "";
  for (let index = 0; index < length; index += 1) {
    value += characters[crypto.randomInt(0, characters.length)];
  }
  return value;
}

module.exports = {
  VOUCHER_CHARACTER_SETS,
  VOUCHER_EXPIRY_MODES,
  buildVoucherProfileScripts,
  buildVoucherRevenueReport,
  generateSecureVoucherCode,
  normalizeVoucherCredential,
  normalizeVoucherGenerationPayload,
  normalizeVoucherProfilePayload,
  normalizeVoucherRevenueRange,
  parseRouterVoucherUsageDate,
  parseVoucherBatchComment,
  parseVoucherProfileMetadata,
  parseVoucherUsageRecord,
};
