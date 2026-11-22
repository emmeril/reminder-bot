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

function getVoucherValiditySeconds(value) {
  const raw = String(value || "").toLowerCase();
  if (!/^(?:\d+[wdhms])+$/.test(raw)) throw new Error("Masa berlaku voucher tidak valid.");
  const units = { w: 604800, d: 86400, h: 3600, m: 60, s: 1 };
  const seconds = [...raw.matchAll(/(\d+)([wdhms])/g)]
    .reduce((total, match) => total + Number(match[1]) * units[match[2]], 0);
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 100 * 366 * 86400) {
    throw new Error("Masa berlaku voucher harus antara 1 detik dan 100 tahun.");
  }
  return seconds;
}

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
  getVoucherValiditySeconds(validity);

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
  const validitySeconds = getVoucherValiditySeconds(profile.validity);
  // Compare full calendar values so stored ROS 6 comments remain valid after a ROS 7 upgrade.
  const dateTimeScript = `:local voucherStamp do={
    :local raw [:tostr $value];
    :local dateSize 0;
    :local yr 0;
    :local mo 0;
    :local dy 0;
    :if ([:len $raw] = 19 and [:pick $raw 4 5] = "-" and [:pick $raw 7 8] = "-") do={
      :set dateSize 10;
      :set yr [:tonum [:pick $raw 0 4]];
      :set mo [:tonum [:pick $raw 5 7]];
      :set dy [:tonum [:pick $raw 8 10]];
    };
    :if ([:len $raw] = 20 and [:pick $raw 3 4] = "/" and [:pick $raw 6 7] = "/") do={
      :local months ("jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec");
      :local monthIndex [:find $months [:pick $raw 0 3]];
      :if ([:typeof $monthIndex] != "num") do={ :return 0; };
      :set dateSize 11;
      :set yr [:tonum [:pick $raw 7 11]];
      :set mo ($monthIndex + 1);
      :set dy [:tonum [:pick $raw 4 6]];
    };
    :if ($dateSize = 0 or [:typeof $yr] != "num" or [:typeof $mo] != "num" or [:typeof $dy] != "num") do={ :return 0; };
    :if ($yr < 1970 or $yr > 9999 or $mo < 1 or $mo > 12 or $dy < 1) do={ :return 0; };
    :local monthDays (31,28,31,30,31,30,31,31,30,31,30,31);
    :local maxDay ($monthDays->($mo - 1));
    :if ($mo = 2 and (($yr % 4 = 0 and $yr % 100 != 0) or $yr % 400 = 0)) do={ :set maxDay 29; };
    :if ($dy > $maxDay) do={ :return 0; };
    :local clockText [:pick $raw ($dateSize + 1) ($dateSize + 9)];
    :if ([:pick $raw $dateSize ($dateSize + 1)] != " " or [:pick $clockText 2 3] != ":" or [:pick $clockText 5 6] != ":") do={ :return 0; };
    :local hh [:tonum [:pick $clockText 0 2]];
    :local mm [:tonum [:pick $clockText 3 5]];
    :local ss [:tonum [:pick $clockText 6 8]];
    :if ([:typeof $hh] != "num" or [:typeof $mm] != "num" or [:typeof $ss] != "num") do={ :return 0; };
    :if ($hh < 0 or $hh > 23 or $mm < 0 or $mm > 59 or $ss < 0 or $ss > 59) do={ :return 0; };
    :return ($yr * 10000000000 + $mo * 100000000 + $dy * 1000000 + $hh * 10000 + $mm * 100 + $ss);
  };`;
  // Calendar arithmetic avoids temporary schedulers and their moving next-run value after reboot.
  const expiryScript = `:local voucherExpiry do={
    :local digits [:tostr $stamp];
    :if ([:len $digits] != 14 or $seconds < 1) do={ :return ""; };
    :local yr [:tonum [:pick $digits 0 4]];
    :local mo [:tonum [:pick $digits 4 6]];
    :local dy [:tonum [:pick $digits 6 8]];
    :local hh [:tonum [:pick $digits 8 10]];
    :local mm [:tonum [:pick $digits 10 12]];
    :local ss [:tonum [:pick $digits 12 14]];
    :local total ($hh * 3600 + $mm * 60 + $ss + $seconds);
    :local clockSeconds ($total % 86400);
    :set dy ($dy + (($total - $clockSeconds) / 86400));
    :local monthDays (31,28,31,30,31,30,31,31,30,31,30,31);
    :local advancing true;
    :while ($advancing) do={
      :if ($yr > 9999) do={ :return ""; };
      :local maxDay ($monthDays->($mo - 1));
      :if ($mo = 2 and (($yr % 4 = 0 and $yr % 100 != 0) or $yr % 400 = 0)) do={ :set maxDay 29; };
      :if ($dy > $maxDay) do={
        :set dy ($dy - $maxDay);
        :set mo ($mo + 1);
        :if ($mo > 12) do={ :set mo 1; :set yr ($yr + 1); };
      } else={ :set advancing false; };
    };
    :set ss ($clockSeconds % 60);
    :set mm ((($clockSeconds % 3600) - $ss) / 60);
    :set hh (($clockSeconds - ($clockSeconds % 3600)) / 3600);
    :local monthText [:tostr $mo];
    :local dayText [:tostr $dy];
    :local hourText [:tostr $hh];
    :local minuteText [:tostr $mm];
    :local secondText [:tostr $ss];
    :if ($mo < 10) do={ :set monthText ("0" . $monthText); };
    :if ($dy < 10) do={ :set dayText ("0" . $dayText); };
    :if ($hh < 10) do={ :set hourText ("0" . $hourText); };
    :if ($mm < 10) do={ :set minuteText ("0" . $minuteText); };
    :if ($ss < 10) do={ :set secondText ("0" . $secondText); };
    :local clockText ("$hourText:$minuteText:$secondText");
    :if ($legacy = true) do={
      :local months ("jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec");
      :local monthText ($months->($mo - 1));
      :return ("$monthText/$dayText/$yr $clockText");
    };
    :return ("$yr-$monthText-$dayText $clockText");
  };`;
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
  const activation = `;
  ${dateTimeScript}
  ${expiryScript}
  :local voucherUserId [/ip hotspot user find where name=$user];
  :if ([:len $voucherUserId] != 1) do={ :error "Voucher user not found"; };
  :local comment [/ip hotspot user get $voucherUserId comment];
  :local ucode [:pick $comment 0 2];
  :if ($ucode = "vc" or $ucode = "up" or [:pick $comment 0 8] = "voucher-" or $comment = "") do={
    :local date [/system clock get date];
    :local time [/system clock get time];
    :local started [$voucherStamp value=("$date $time")];
    :do {
      :if ($started = 0) do={ :error "Invalid router clock"; };
      :if ([/ip hotspot user get $voucherUserId uptime] > [:totime "1m"]) do={
        /ip hotspot user set disabled=yes $voucherUserId;
        :error "Used voucher has no recorded expiration; manual review required";
      };
      :local year [:pick [:tostr $started] 0 4];
      :local months ("jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec");
      :local month ($months->([:tonum [:pick [:tostr $started] 4 6]] - 1));
      :local exp [$voucherExpiry stamp=$started seconds=${validitySeconds} legacy=([:len $date] = 11)];
      :local expires [$voucherStamp value=$exp];
      :if ($expires = 0 or $expires <= $started) do={ :error "Invalid voucher expiration"; };
      :if ([/ip hotspot user get $voucherUserId comment] = $comment) do={
        /ip hotspot user set comment=$exp $voucherUserId;
        :if ([/ip hotspot user get $voucherUserId comment] != $exp) do={ :error "Voucher expiration was not saved"; }${recordScript};
      };
    } on-error={
      :log error ("Voucher expiration initialization failed: " . $user);
      :if ([/ip hotspot user get $voucherUserId comment] = $comment) do={
        /ip hotspot active remove [find where user=$user];
      };
    };
  }${lockScript}`;
  const monitor = `${dateTimeScript}
  :local date [/system clock get date];
  :local time [/system clock get time];
  :local currentStamp [$voucherStamp value=("$date $time")];
  :if ($currentStamp = 0) do={ :error "Invalid router clock; voucher expiry skipped"; };
  :foreach voucherUserId in=[/ip hotspot user find where profile="${profile.name}"] do={
    :do {
      :local comment [/ip hotspot user get $voucherUserId comment];
      :local expires [$voucherStamp value=$comment];
      :local voucherCode [:pick $comment 0 2];
      :if ($expires = 0 and ($voucherCode = "vc" or $voucherCode = "up" or [:pick $comment 0 8] = "voucher-") and [/ip hotspot user get $voucherUserId uptime] > [:totime "1m"]) do={
        :local voucherName [/ip hotspot user get $voucherUserId name];
        :local wasDisabled [/ip hotspot user get $voucherUserId disabled];
        /ip hotspot user set disabled=yes $voucherUserId;
        /ip hotspot active remove [find where user=$voucherName];
        :if ($wasDisabled = false) do={ :log warning ("Used voucher has no recorded expiration; disabled for review: " . $voucherName); };
      };
      :if ($expires > 0 and $expires <= $currentStamp) do={
        :local voucherName [/ip hotspot user get $voucherUserId name];
        /ip hotspot user ${mode.action} $voucherUserId;
        /ip hotspot active remove [find where user=$voucherName];
      };
    } on-error={ :log warning ("Voucher expiry check failed: " . $voucherUserId); };
  };`;
  return { onLogin: `${header}${activation}`, monitor };
}

function buildVoucherScriptUpdatePlan(profiles, schedulers) {
  if (!Array.isArray(profiles) || !Array.isArray(schedulers)) {
    throw new Error("Daftar profile atau scheduler MikroTik tidak valid.");
  }
  const changes = [];
  const skipped = [];
  for (const profile of profiles) {
    const onLogin = String(profile["on-login"] || profile.onLogin || "");
    const metadata = parseVoucherProfileMetadata(onLogin);
    if (!VOUCHER_EXPIRY_MODES[metadata.expiredMode]) continue;
    const name = String(profile.name || "");
    const matches = schedulers.filter((scheduler) => String(scheduler.name || "") === name);
    const scheduler = matches[0];
    if (matches.length !== 1 || String(scheduler.comment || "") !== `Monitor Profile ${name}`) {
      skipped.push({ name, reason: "Monitor profile tidak ditemukan atau dipakai fungsi lain." });
      continue;
    }
    const profileId = String(profile[".id"] || profile.id || "");
    const schedulerId = String(scheduler[".id"] || scheduler.id || "");
    if (!profileId || !schedulerId) throw new Error(`ID profile atau scheduler ${name} tidak valid.`);
    let request;
    try {
      request = normalizeVoucherProfilePayload({ name, ...metadata });
    } catch (error) {
      skipped.push({ name, reason: error.message });
      continue;
    }
    const scripts = buildVoucherProfileScripts({ ...request, commission: metadata.commission });
    const onEvent = String(scheduler["on-event"] || scheduler.onEvent || "");
    if (scripts.onLogin === onLogin && scripts.monitor === onEvent) continue;
    changes.push({
      name,
      profileId,
      schedulerId,
      schedulerDisabled: String(scheduler.disabled || "false"),
      before: { onLogin, onEvent },
      after: { onLogin: scripts.onLogin, onEvent: scripts.monitor },
    });
  }
  return { changes, skipped };
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
  buildVoucherScriptUpdatePlan,
  buildVoucherRevenueReport,
  generateSecureVoucherCode,
  getVoucherValiditySeconds,
  normalizeVoucherCredential,
  normalizeVoucherGenerationPayload,
  normalizeVoucherProfilePayload,
  normalizeVoucherRevenueRange,
  parseRouterVoucherUsageDate,
  parseVoucherBatchComment,
  parseVoucherProfileMetadata,
  parseVoucherUsageRecord,
};
