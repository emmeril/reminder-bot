require("dotenv").config({ quiet: true });

const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const express = require("express");
const cron = require("node-cron");
const crypto = require("crypto");
const ftp = require("basic-ftp");
const ExcelJS = require("exceljs");
const QRCode = require("qrcode");
const { RouterOSClient } = require("routeros-client");
const { Sequelize, DataTypes } = require("sequelize");
const {
  CONFIG,
  DEFAULT_REMINDER_MESSAGE_TEMPLATE,
  DEFAULT_SETTINGS,
  MONTH_NAMES,
  PAYMENT_STATUS,
  PAYMENT_TYPES,
  REMINDER_KINDS,
  SUBSCRIPTION_TYPES,
} = require("./config");
const ActivityLog = require("./activity-log");
const AsyncLock = require("./async-lock");
const AuthManager = require("./auth-manager");
const {
  MidtransService,
  PAYMENT_GATEWAY_STATUS,
  normalizeMidtransPaymentStatus,
} = require("./midtrans-service");
const { migrateWhatsAppProviderMetadata } = require("./migrations/whatsapp-provider-metadata");
const TelegramManager = require("./telegram-manager");
const WhatsAppProviderManager = require("./whatsapp/provider-manager");
const {
  ApDownNotifier,
  DatabaseBackupScheduler,
  HotspotReactivationScheduler,
  HotspotStatusSyncScheduler,
  MikrotikBackupScheduler,
  ReminderScheduler,
  WhatsAppProviderStatusNotifier,
} = require("./schedulers");
const TemplateManager = require("./template-manager");
const {
  addDaysSafely,
  addMonthsSafely,
  assertSecureConfiguration,
  buildHotspotEmailFromPhone,
  collectSecurityWarnings,
  escapeHtml,
  formatBillingPeriodLabel,
  formatUsernameFromName,
  generateId,
  getBillingPeriodKey,
  getBillingPeriodParts,
  getPreviousBillingPeriod,
  isValidPhoneNumber,
  isValidTimeZone,
  makeBillingPeriodKey,
  normalizeNetworkHost,
  normalizePhoneNumber,
  parseBoolean,
  parseCookies,
  parseDateTimeInput,
  safeCompareString,
  sanitizeInput,
  sanitizeMultilineText,
  sanitizePositiveInteger,
  sanitizeTimeHHMM,
  serializeCookie,
  sleep,
} = require("./utils");

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
  [PAYMENT_TYPES.CURRENT_ONLY]: "Bulan Ini Saja",
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

// ===============================
// MIKROTIK SERVICE
// ===============================

class MikrotikService {
  constructor(activityLog) {
    this.activityLog = activityLog;
  }

  getConnectionConfigs() {
    return [
      { label: "primary", config: CONFIG.MIKROTIK_PRIMARY },
      { label: "backup", config: CONFIG.MIKROTIK_BACKUP },
    ].filter(({ config }) => config.host && config.user && config.password);
  }

  async tryConnect({ label, config }) {
    const client = new RouterOSClient(config);
    try {
      const connection = await client.connect();
      await connection.menu("/system/identity").getOnly();
      this.activityLog.push("info", "mikrotik", `Terhubung ke MikroTik ${label}`);
      return { client, connection, label, config };
    } catch (error) {
      client.close();
      this.activityLog.push("error", "mikrotik", `Gagal konek MikroTik ${label}: ${error.message}`);
      return null;
    }
  }

  async withConnection(operation) {
    const configs = this.getConnectionConfigs();
    if (configs.length === 0) {
      throw new Error("Konfigurasi MikroTik belum lengkap. Isi IP_MIKROTIK, USER_MIKROTIK, dan PASSWORD_MIKROTIK di .env.");
    }

    let connectionObj = null;
    for (const item of configs) {
      connectionObj = await this.tryConnect(item);
      if (connectionObj) break;
    }

    if (!connectionObj) {
      throw new Error("Gagal terhubung ke MikroTik primary maupun backup.");
    }

    try {
      return await operation(connectionObj.connection, connectionObj);
    } finally {
      connectionObj.client.close();
    }
  }

  async getHotspotProfiles() {
    return this.withConnection(async (conn) => {
      const profiles = await conn.menu("/ip/hotspot/user/profile").print();
      return (profiles || [])
        .map((profile) => ({
          name: profile.name,
          rateLimit: profile["rate-limit"] || "",
        }))
        .filter((profile) => profile.name)
        .sort((a, b) => a.name.localeCompare(b.name, "id-ID"));
    });
  }

  async getHotspotUsers() {
    return this.withConnection(async (conn) => {
      const userMenu = conn.menu("/ip/hotspot/user")
        .select(["id", "name", "profile", "comment", "disabled", "email"]);
      const activeMenu = conn.menu("/ip/hotspot/active")
        .select(["id", "user", "address", "mac-address", "uptime", "server"]);
      const [users, activeSessions] = await Promise.all([
        userMenu.print(),
        activeMenu.print(),
      ]);

      const byUsername = new Map();
      for (const user of users || []) {
        const username = sanitizeInput(user.name || user.user || "");
        if (!username) continue;
        byUsername.set(username.toLowerCase(), {
          id: user[".id"] || user.id || user.numbers || "",
          username,
          profile: user.profile || "",
          comment: user.comment || "",
          disabled: String(user.disabled || "false").toLowerCase() === "true",
          email: user.email || "",
          active: false,
          source: "user",
        });
      }

      for (const session of activeSessions || []) {
        const username = sanitizeInput(session.user || session.name || "");
        if (!username) continue;
        const key = username.toLowerCase();
        const existing = byUsername.get(key);
        if (existing) {
          existing.active = true;
          existing.address = session.address || session["mac-address"] || "";
          existing.uptime = session.uptime || "";
          existing.server = session.server || "";
          continue;
        }

        byUsername.set(key, {
          id: session[".id"] || session.id || session.numbers || "",
          username,
          profile: "",
          comment: session.comment || "",
          disabled: false,
          email: "",
          active: true,
          address: session.address || session["mac-address"] || "",
          uptime: session.uptime || "",
          server: session.server || "",
          source: "active",
        });
      }

      return Array.from(byUsername.values())
        .sort((a, b) => a.username.localeCompare(b.username, "id-ID"));
    });
  }

  async getHotspotUsersForStatusSync(usernames = []) {
    return this.withConnection(async (conn) => {
      const managedUsernames = [...new Set(
        usernames.map((username) => sanitizeInput(username)).filter(Boolean)
      )];
      const userMenu = conn.menu("/ip/hotspot/user")
        .select(["name", "profile", "disabled", "email"]);
      if (managedUsernames.length > 0) {
        userMenu.where("name", managedUsernames[0]);
        for (const username of managedUsernames.slice(1)) {
          userMenu.orWhere("name", username);
        }
      }
      const users = await userMenu.print();

      return (users || []).map((user) => ({
        username: sanitizeInput(user.name || user.user || ""),
        profile: user.profile || "",
        disabled: user.disabled === true || String(user.disabled || "").toLowerCase() === "true",
        email: user.email || "",
        source: "user",
      })).filter((user) => user.username);
    });
  }

  async getNetwatchStatus() {
    return this.withConnection(async (conn) => {
      const rows = await conn.menu("/tool/netwatch").print();
      return (rows || [])
        .map((row) => ({
          id: row[".id"] || row.id || row.numbers || "",
          host: row.host || row["host-address"] || "-",
          status: String(row.status || row.state || "unknown").toUpperCase(),
          since: row.since || "",
          comment: row.comment || "",
          interval: row.interval || "",
          timeout: row.timeout || "",
          type: row.type || "",
          upScript: row["up-script"] || "",
          downScript: row["down-script"] || "",
        }))
        .sort((a, b) => String(a.host || "").localeCompare(String(b.host || ""), "id-ID"));
    });
  }

  async removeHotspotUsersByName(conn, username) {
    const users = await conn.menu("/ip/hotspot/user").print();
    const matches = (users || []).filter((user) => String(user.name || "").toLowerCase() === String(username).toLowerCase());
    let removed = 0;

    for (const row of matches) {
      const rowId = row[".id"] || row.id || row.numbers || row.number;
      if (rowId) {
        await conn.menu("/ip/hotspot/user").remove(String(rowId));
      } else {
        await conn.menu("/ip/hotspot/user").where("name", row.name || username).remove();
      }
      removed += 1;
    }

    return { removed };
  }

  async removeActiveHotspotSessionsByName(conn, username) {
    const activeSessions = await conn.menu("/ip/hotspot/active").print();
    const matches = (activeSessions || []).filter((session) => {
      const sessionUser = session.user || session.name || "";
      return String(sessionUser).toLowerCase() === String(username).toLowerCase();
    });
    let killed = 0;

    for (const row of matches) {
      const rowId = row[".id"] || row.id || row.numbers || row.number;
      if (rowId) {
        await conn.menu("/ip/hotspot/active").remove(String(rowId));
      } else {
        await conn.menu("/ip/hotspot/active").where("user", row.user || username).remove();
      }
      killed += 1;
    }

    return { killed };
  }

  async deleteHotspotUser(username, phoneNumber = "") {
    const hotspotUsername = sanitizeInput(username);
    const normalizedPhone = normalizePhoneNumber(phoneNumber);
    if (!hotspotUsername) throw new Error("Username hotspot wajib diisi.");

    return this.withConnection(async (conn) => {
      const users = await conn.menu("/ip/hotspot/user").print();
      const expectedEmail = buildHotspotEmailFromPhone(normalizedPhone);
      const matches = (users || []).filter(
        (user) => String(user.name || "").toLowerCase() === hotspotUsername.toLowerCase()
      );
      if (expectedEmail && matches.some(
        (user) => user.email && String(user.email).toLowerCase() !== expectedEmail.toLowerCase()
      )) {
        throw new Error(`Akun "${hotspotUsername}" terhubung ke pelanggan yang berbeda.`);
      }
      const activeResult = await this.removeActiveHotspotSessionsByName(conn, hotspotUsername);
      const removeResult = await this.removeHotspotUsersByName(conn, hotspotUsername);
      const remainingUsers = await conn.menu("/ip/hotspot/user").print();
      const stillExists = (remainingUsers || []).some(
        (user) => String(user.name || "").toLowerCase() === hotspotUsername.toLowerCase()
      );
      if (stillExists) {
        throw new Error(`User hotspot "${hotspotUsername}" masih ditemukan setelah penghapusan.`);
      }
      return {
        username: hotspotUsername,
        activeSessionsKilled: activeResult.killed,
        removedUsers: removeResult.removed,
      };
    });
  }

  async setHotspotUserDisabled(username, phoneNumber = "", disabled = true) {
    const hotspotUsername = sanitizeInput(username);
    const normalizedPhone = normalizePhoneNumber(phoneNumber);
    if (!hotspotUsername) throw new Error("Username hotspot wajib diisi.");

    return this.withConnection(async (conn) => {
      const userMenu = conn.menu("/ip/hotspot/user");
      const users = await userMenu.print();
      const expectedEmail = buildHotspotEmailFromPhone(normalizedPhone);
      const matches = (users || []).filter(
        (user) => String(user.name || "").toLowerCase() === hotspotUsername.toLowerCase()
      );
      if (expectedEmail && matches.some(
        (user) => user.email && String(user.email).toLowerCase() !== expectedEmail.toLowerCase()
      )) {
        throw new Error(`Akun "${hotspotUsername}" terhubung ke pelanggan yang berbeda.`);
      }
      const existing = matches[0];
      if (!existing) throw new Error(`Akun "${hotspotUsername}" tidak ditemukan di MikroTik.`);
      const existingId = existing[".id"] || existing.id || existing.numbers || existing.number;
      if (!existingId) throw new Error(`ID akun "${hotspotUsername}" tidak ditemukan di MikroTik.`);

      let activeSessionsKilled = 0;
      if (disabled) {
        const activeResult = await this.removeActiveHotspotSessionsByName(conn, hotspotUsername);
        activeSessionsKilled = activeResult.killed;
      }
      const updateResult = await userMenu.update({ disabled: disabled ? "yes" : "no" }, String(existingId));
      if (updateResult?.["!trap"]) {
        const message = updateResult["!trap"]?.[0]?.message || "Error tidak diketahui dari MikroTik.";
        throw new Error(`Gagal ${disabled ? "menonaktifkan" : "mengaktifkan"} user hotspot: ${message}`);
      }
      const verifiedUsers = await userMenu.print();
      const verified = (verifiedUsers || []).find(
        (user) => String(user.name || "").toLowerCase() === hotspotUsername.toLowerCase()
      );
      const actualDisabled = String(verified?.disabled || "false").toLowerCase() === "true"
        || ["yes", "on"].includes(String(verified?.disabled || "").toLowerCase());
      if (!verified || actualDisabled !== Boolean(disabled)) {
        throw new Error(`Akun "${hotspotUsername}" gagal diverifikasi setelah ${disabled ? "dinonaktifkan" : "diaktifkan"}.`);
      }
      return {
        username: hotspotUsername,
        password: sanitizeInput(verified.password || existing.password || ""),
        profile: sanitizeInput(verified.profile || existing.profile || ""),
        id: verified[".id"] || verified.id || verified.numbers || "",
        disabled: Boolean(disabled),
        activeSessionsKilled,
      };
    });
  }

  async reactivateHotspotUser({ username, password, profile, phoneNumber }) {
    const hotspotUsername = sanitizeInput(username);
    const hotspotPassword = sanitizeInput(password);
    const profileName = sanitizeInput(profile);
    const normalizedPhone = normalizePhoneNumber(phoneNumber);

    if (!hotspotUsername) throw new Error("Username hotspot wajib diisi.");
    if (!hotspotPassword) throw new Error("Password hotspot wajib diisi.");
    if (!profileName) throw new Error("Profile hotspot wajib dipilih.");

    return this.withConnection(async (conn) => {
      const userMenu = conn.menu("/ip/hotspot/user");
      const profileMenu = conn.menu("/ip/hotspot/user/profile");
      const [users, profiles] = await Promise.all([userMenu.print(), profileMenu.print()]);
      if (!(profiles || []).some((item) => item.name === profileName)) {
        throw new Error(`Profile "${profileName}" tidak ditemukan di MikroTik.`);
      }

      const expectedEmail = buildHotspotEmailFromPhone(normalizedPhone);
      const existing = (users || []).find(
        (user) => String(user.name || "").toLowerCase() === hotspotUsername.toLowerCase()
      );
      if (existing?.email
        && expectedEmail
        && String(existing.email).toLowerCase() !== expectedEmail.toLowerCase()) {
        throw new Error(`Akun "${hotspotUsername}" terhubung ke pelanggan yang berbeda.`);
      }
      const activeResult = await this.removeActiveHotspotSessionsByName(conn, hotspotUsername);

      const accountPayload = {
        name: hotspotUsername,
        password: hotspotPassword,
        profile: profileName,
        disabled: "no",
      };
      if (expectedEmail) {
        accountPayload.email = expectedEmail;
      }

      let created = false;
      let updated = false;
      if (existing) {
        const existingId = existing[".id"] || existing.id || existing.numbers || existing.number;
        if (!existingId) throw new Error(`ID akun "${hotspotUsername}" tidak ditemukan di MikroTik.`);
        const updateResult = await userMenu.update(accountPayload, String(existingId));
        if (updateResult?.["!trap"]) {
          const message = updateResult["!trap"]?.[0]?.message || "Error tidak diketahui dari MikroTik.";
          throw new Error(`Gagal memperbarui user hotspot: ${message}`);
        }
        updated = true;
      } else {
        const addResult = await userMenu.add(accountPayload);
        if (addResult?.["!trap"]) {
          const message = addResult["!trap"]?.[0]?.message || "Error tidak diketahui dari MikroTik.";
          throw new Error(`Gagal membuat ulang user hotspot: ${message}`);
        }
        created = true;
      }

      const verifiedUsers = await userMenu.print();
      const verified = (verifiedUsers || []).find(
        (user) => String(user.name || "").toLowerCase() === hotspotUsername.toLowerCase()
      );
      if (!verified
        || String(verified.profile || "") !== profileName
        || String(verified.disabled || "false").toLowerCase() === "true"
        || (expectedEmail && String(verified.email || "").toLowerCase() !== expectedEmail.toLowerCase())) {
        throw new Error(`Akun "${hotspotUsername}" gagal diverifikasi setelah reaktivasi.`);
      }

      return {
        username: hotspotUsername,
        password: hotspotPassword,
        profile: profileName,
        id: verified[".id"] || verified.id || verified.numbers || "",
        created,
        updated,
        activeSessionsKilled: activeResult.killed,
        removedUsers: 0,
      };
    });
  }

  async createHotspotCustomer({
    name,
    phoneNumber,
    profile,
    username,
    password,
    adoptExisting = false,
    adoptExistingOwnerMismatch = false,
  }) {
    const registration = this.buildHotspotCustomerRegistration({
      name,
      phoneNumber,
      profile,
      username,
      password,
    });
    const expectedEmail = buildHotspotEmailFromPhone(registration.phoneNumber);

    return this.withConnection(async (conn) => {
      const userMenu = conn.menu("/ip/hotspot/user");
      const profileMenu = conn.menu("/ip/hotspot/user/profile");
      const [users, profiles] = await Promise.all([userMenu.print(), profileMenu.print()]);

      if (!(profiles || []).some((item) => item.name === registration.profile)) {
        throw new Error(`Profile "${registration.profile}" tidak ditemukan di MikroTik.`);
      }

      const existing = (users || []).find(
        (user) => String(user.name || "").toLowerCase() === registration.username.toLowerCase()
      );
      if (existing) {
        const sameOwner = String(existing.email || "").toLowerCase() === expectedEmail.toLowerCase();
        const ownerUnknown = !sanitizeInput(existing.email || "");
        const canAdopt = Boolean(adoptExisting)
          && (ownerUnknown || Boolean(adoptExistingOwnerMismatch));
        if (!sameOwner && !canAdopt) {
          throw new Error(`Username "${registration.username}" sudah dipakai akun MikroTik lain.`);
        }

        const existingId = existing[".id"] || existing.id || existing.numbers || "";
        if (!existingId) throw new Error(`ID akun "${registration.username}" tidak ditemukan di MikroTik.`);
        const updateResult = await userMenu.update({
          name: registration.username,
          password: registration.password,
          profile: registration.profile,
          email: expectedEmail,
          disabled: "no",
        }, String(existingId));
        if (updateResult?.["!trap"]) {
          const message = updateResult["!trap"]?.[0]?.message || "Error tidak diketahui dari MikroTik.";
          throw new Error(`Gagal memperbarui user hotspot: ${message}`);
        }
        return {
          ...registration,
          id: existingId,
          created: false,
          updated: true,
          adopted: !sameOwner && canAdopt,
        };
      }

      const addResult = await userMenu.add({
        name: registration.username,
        password: registration.password,
        profile: registration.profile,
        email: expectedEmail,
      });

      if (addResult?.["!trap"]) {
        const message = addResult["!trap"]?.[0]?.message || "Error tidak diketahui dari MikroTik.";
        throw new Error(`Gagal membuat user hotspot: ${message}`);
      }

      const verifiedUsers = await userMenu.print();
      const verified = (verifiedUsers || []).find(
        (user) => String(user.name || "").toLowerCase() === registration.username.toLowerCase()
      );
      if (!verified || String(verified.profile || "") !== registration.profile) {
        throw new Error(`Akun "${registration.username}" dibuat tetapi gagal diverifikasi di MikroTik.`);
      }

      return {
        ...registration,
        id: verified[".id"] || verified.id || verified.numbers || "",
        created: true,
      };
    });
  }

  buildHotspotCustomerRegistration({ name, phoneNumber, profile, username, password }) {
    const customerName = sanitizeInput(name);
    const normalizedPhone = normalizePhoneNumber(phoneNumber);
    const profileName = sanitizeInput(profile);
    const hotspotUsername = sanitizeInput(username) || formatUsernameFromName(customerName);
    const hotspotPassword = sanitizeInput(password) || normalizedPhone.slice(-5);

    if (!customerName) throw new Error("Nama pelanggan wajib diisi.");
    if (!isValidPhoneNumber(normalizedPhone)) throw new Error("Nomor pelanggan harus berformat 628xxx.");
    if (!profileName) throw new Error("Profile hotspot wajib dipilih.");
    if (!hotspotUsername) throw new Error("Nama pelanggan tidak bisa dijadikan username hotspot.");
    if (!hotspotPassword) throw new Error("Password hotspot wajib diisi.");

    return {
      username: hotspotUsername,
      password: hotspotPassword,
      name: customerName,
      phoneNumber: normalizedPhone,
      profile: profileName,
    };
  }

  async verifyHotspotCustomer({ username, phoneNumber, profile, password }) {
    const hotspotUsername = sanitizeInput(username);
    const normalizedPhone = normalizePhoneNumber(phoneNumber);
    const profileName = sanitizeInput(profile);
    const expectedPassword = sanitizeInput(password);
    const expectedEmail = buildHotspotEmailFromPhone(normalizedPhone);
    const user = await this.withConnection(async (conn) => {
      const users = await conn.menu("/ip/hotspot/user").print();
      const match = (users || []).find(
        (item) => String(item.name || "").toLowerCase() === hotspotUsername.toLowerCase()
      );
      if (!match) return null;
      return {
        id: match[".id"] || match.id || match.numbers || "",
        username: sanitizeInput(match.name || ""),
        profile: match.profile || "",
        password: sanitizeInput(match.password || ""),
        email: match.email || "",
        disabled: String(match.disabled || "false").toLowerCase() === "true",
      };
    });

    if (!user) throw new Error(`Akun "${hotspotUsername}" tidak ditemukan setelah provisioning.`);
    if (String(user.profile || "") !== profileName) {
      throw new Error(`Profile akun "${hotspotUsername}" berbeda dengan konfigurasi aplikasi.`);
    }
    if (String(user.email || "").toLowerCase() !== expectedEmail.toLowerCase()) {
      throw new Error(`Akun "${hotspotUsername}" terhubung ke pelanggan yang berbeda.`);
    }
    // RouterOS may hide passwords from read results depending on permissions;
    // verify it whenever the API returns the value.
    if (expectedPassword && user.password && user.password !== expectedPassword) {
      throw new Error(`Password akun "${hotspotUsername}" berbeda setelah sinkronisasi.`);
    }
    if (user.disabled) throw new Error(`Akun "${hotspotUsername}" ditemukan tetapi dinonaktifkan.`);

    return user;
  }

  async updateHotspotCustomer({
    previousUsername,
    username,
    phoneNumber,
    password,
    profile,
    name,
  }) {
    const registration = this.buildHotspotCustomerRegistration({
      name,
      phoneNumber,
      profile,
      username,
      password,
    });
    const oldUsername = sanitizeInput(previousUsername) || registration.username;
    const expectedEmail = buildHotspotEmailFromPhone(registration.phoneNumber);

    return this.withConnection(async (conn) => {
      const userMenu = conn.menu("/ip/hotspot/user");
      const profileMenu = conn.menu("/ip/hotspot/user/profile");
      const [users, profiles] = await Promise.all([userMenu.print(), profileMenu.print()]);

      if (!(profiles || []).some((item) => item.name === registration.profile)) {
        throw new Error(`Profile "${registration.profile}" tidak ditemukan di MikroTik.`);
      }

      const findByUsername = (value) => (users || []).find(
        (item) => String(item.name || "").toLowerCase() === String(value || "").toLowerCase()
      );
      const previous = findByUsername(oldUsername);
      const target = findByUsername(registration.username);

      if (!previous) {
        const targetPassword = sanitizeInput(target?.password || "");
        const targetDisabled = String(target?.disabled || "false").toLowerCase() === "true"
          || ["yes", "on"].includes(String(target?.disabled || "").toLowerCase());
        const targetOwnerMatches = target
          && String(target.email || "").toLowerCase() === expectedEmail.toLowerCase();
        const targetMatches = target
          && targetOwnerMatches
          && String(target.profile || "") === registration.profile
          && (!targetPassword || targetPassword === registration.password)
          && !targetDisabled;
        if (targetMatches) {
          return {
            ...registration,
            previousUsername: oldUsername,
            id: target[".id"] || target.id || target.numbers || "",
            updated: false,
          };
        }
        if (target && targetOwnerMatches) {
          const targetId = target[".id"] || target.id || target.numbers || target.number;
          if (!targetId) throw new Error(`ID akun "${registration.username}" tidak ditemukan di MikroTik.`);
          await this.removeActiveHotspotSessionsByName(conn, registration.username);
          const updateResult = await userMenu.update({
            name: registration.username,
            password: registration.password,
            profile: registration.profile,
            email: expectedEmail,
            disabled: "no",
          }, String(targetId));
          if (updateResult?.["!trap"]) {
            const message = updateResult["!trap"]?.[0]?.message || "Error tidak diketahui dari MikroTik.";
            throw new Error(`Gagal menyelesaikan sinkronisasi user hotspot: ${message}`);
          }
          return {
            ...registration,
            previousUsername: oldUsername,
            id: targetId,
            updated: true,
            recovered: true,
          };
        }
        throw new Error(`Akun lama "${oldUsername}" tidak ditemukan di MikroTik.`);
      }

      const previousId = previous[".id"] || previous.id || previous.numbers || previous.number;
      const targetId = target?.[".id"] || target?.id || target?.numbers || target?.number;
      if (target && String(targetId || "") !== String(previousId || "")) {
        throw new Error(`Username baru "${registration.username}" sudah dipakai akun MikroTik lain.`);
      }
      // The username snapshot is the application's ownership link for an edit.
      // MikroTik email metadata may be stale/empty after a manual change or a
      // partially completed retry, so do not block updating the linked user on
      // the old email value. The target-username collision check above still
      // prevents overwriting a different MikroTik account.
      if (!previousId) {
        throw new Error(`ID akun lama "${oldUsername}" tidak ditemukan di MikroTik.`);
      }

      await this.removeActiveHotspotSessionsByName(conn, oldUsername);
      const updateResult = await userMenu.update({
        name: registration.username,
        password: registration.password,
        profile: registration.profile,
        email: expectedEmail,
        disabled: "no",
      }, String(previousId));
      if (updateResult?.["!trap"]) {
        const message = updateResult["!trap"]?.[0]?.message || "Error tidak diketahui dari MikroTik.";
        throw new Error(`Gagal memperbarui user hotspot: ${message}`);
      }

      const verifiedUsers = await userMenu.print();
      const verified = (verifiedUsers || []).find(
        (item) => String(item.name || "").toLowerCase() === registration.username.toLowerCase()
      );
      if (!verified || String(verified.profile || "") !== registration.profile) {
        throw new Error(`Akun "${registration.username}" diperbarui tetapi gagal diverifikasi di MikroTik.`);
      }

      return {
        ...registration,
        previousUsername: oldUsername,
        id: verified[".id"] || verified.id || verified.numbers || previousId,
        updated: true,
      };
    });
  }

  async generateDailyBackupFile() {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupDir = await fs.mkdtemp(path.join(os.tmpdir(), "reminder-mikrotik-"));
    await fs.chmod(backupDir, 0o700);

    const fileName = `mikrotik-export-${timestamp}.rsc`;
    const filePath = path.join(backupDir, fileName);
    const remoteBaseName = `reminder-bot-${timestamp}`;
    const remoteFileName = `${remoteBaseName}.rsc`;

    try {
      await this.withConnection(async (conn, connectionObj) => {
        if (!connectionObj.config.tls) {
          this.activityLog.push(
            "warn",
            "mikrotik",
            "Backup sensitif MikroTik berjalan melalui API tanpa TLS; data tidak terenkripsi di jaringan."
          );
        }
        try {
          await this.createRouterExportFile(conn, remoteBaseName);
          await this.waitForRouterFile(conn, remoteFileName);
          await this.downloadRouterFile(conn, remoteFileName, filePath, connectionObj.config);
        } finally {
          try {
            await conn.menu("/file").where("name", remoteFileName).remove();
          } catch (error) {
            this.activityLog.push("warn", "mikrotik", `Gagal membersihkan file export ${remoteFileName} dari router`, {
              error: error.message,
            });
          }
        }
      });
      await fs.chmod(filePath, 0o600);
    } catch (error) {
      await fs.rm(backupDir, { recursive: true, force: true });
      throw error;
    }

    this.activityLog.push("info", "mikrotik", "Backup konfigurasi MikroTik berhasil dibuat", {
      filePath,
    });

    return {
      fileName,
      filePath,
      cleanup: () => fs.rm(backupDir, { recursive: true, force: true }),
    };
  }

  async createRouterExportFile(conn, remoteBaseName) {
    const exportAttempts = [
      { file: remoteBaseName, compact: true, "show-sensitive": true },
      { file: remoteBaseName, compact: true },
      { file: remoteBaseName, "show-sensitive": true },
      { file: remoteBaseName },
    ];

    let lastError = null;
    for (const params of exportAttempts) {
      try {
        await conn.menu("/").exec("export", params);
        return;
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError || new Error("Gagal membuat file export di MikroTik.");
  }

  async waitForRouterFile(conn, remoteFileName) {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const files = await conn.menu("/file").print();
      const file = (files || []).find((item) => String(item.name || "") === remoteFileName);
      const rawSize = String(file?.size || file?.fileSize || "0").replace(/[^0-9]/g, "");
      if (file && Number(rawSize || 0) > 0) return file;
      await sleep(1000);
    }

    throw new Error(`File export ${remoteFileName} belum siap di MikroTik.`);
  }

  async resolveFtpPort(conn, config) {
    if (!config) {
      throw new Error("Konfigurasi koneksi MikroTik tidak tersedia untuk fallback FTP.");
    }

    if (config.ftpPort && config.ftpPort !== 21) return config.ftpPort;

    const services = await conn.menu("/ip/service").print().catch(() => []);
    const ftpService = (services || []).find((item) => String(item.name || "").toLowerCase() === "ftp");
    if (String(ftpService?.disabled).toLowerCase() === "true") {
      throw new Error("Service FTP MikroTik sedang disabled.");
    }

    return Number(ftpService?.port || config.ftpPort || 21) || 21;
  }

  async downloadRouterFileViaFtp(config, ftpPort, remoteFileName, destinationPath) {
    const ftpClient = new ftp.Client(CONFIG.MIKROTIK_FTP_TIMEOUT);
    ftpClient.ftp.verbose = false;

    try {
      await ftpClient.access({
        host: config.host,
        user: config.user,
        password: config.password,
        port: ftpPort,
        secure: false,
      });
      await ftpClient.downloadTo(destinationPath, remoteFileName);
    } finally {
      ftpClient.close();
    }
  }

  async downloadRouterFile(conn, remoteFileName, destinationPath, config = null) {
    const ftpPort = await this.resolveFtpPort(conn, config);
    try {
      await this.downloadRouterFileViaFtp(config, ftpPort, remoteFileName, destinationPath);
    } catch (ftpError) {
      throw new Error(`Download backup MikroTik gagal melalui FTP: ${ftpError.message}`);
    }

    const stats = await fs.stat(destinationPath);
    if (!stats.size) {
      throw new Error("File backup MikroTik berhasil diunduh tapi kosong.");
    }
  }
}

// ===============================
// DATA MANAGER (Sequelize)
// ===============================

class DataManager {
  constructor(activityLog) {
    this.activityLog = activityLog;
    this.contacts = new Map();
    this.pelanggan = new Map();
    this.customerAccounts = new Map();
    this.paymentGatewayTransactions = new Map();
    this.reminders = new Map();
    this.sentReminders = new Map();
    this.roles = new Map();
    this.settings = { ...DEFAULT_SETTINGS };
    this.fileLocks = new Map();
    this.dataMutationLock = new AsyncLock();
    this.dbWriteLock = new AsyncLock();
    this.sequelize = null;
    this.models = {};
  }

  async initDirectories() {
    await fs.mkdir(CONFIG.DB_PATH, { recursive: true });
    if (!process.env.DATABASE_URL) {
      await fs.mkdir(path.dirname(CONFIG.DB_STORAGE), { recursive: true });
    }
    await fs.mkdir(CONFIG.TEMPLATE_PATH, { recursive: true });
    await fs.mkdir(CONFIG.PUBLIC_PATH, { recursive: true });
  }

  getTimezone() {
    const requested = this.settings?.timezone || DEFAULT_SETTINGS.timezone;
    return isValidTimeZone(requested) ? requested : DEFAULT_SETTINGS.timezone;
  }

  getPath(filename) {
    return path.join(CONFIG.DB_PATH, filename);
  }

  async initDatabase() {
    await this.initDirectories();

    if (this.sequelize) {
      return;
    }

    this.sequelize = process.env.DATABASE_URL
      ? new Sequelize(process.env.DATABASE_URL, {
          logging: false,
        })
      : new Sequelize({
          dialect: "sqlite",
          storage: CONFIG.DB_STORAGE,
          logging: false,
        });

    const jsonPayloadModel = (name, tableName, keyField) => this.sequelize.define(name, {
      [keyField]: {
        type: DataTypes.STRING,
        primaryKey: true,
      },
      data: {
        type: DataTypes.JSON,
        allowNull: false,
      },
    }, {
      tableName,
      timestamps: true,
    });

    this.models.Contact = jsonPayloadModel("Contact", "contacts", "id");
    this.models.Pelanggan = jsonPayloadModel("Pelanggan", "pelanggan", "username");
    this.models.CustomerAccount = jsonPayloadModel("CustomerAccount", "customer_accounts", "contactId");
    this.models.PaymentGatewayTransaction = jsonPayloadModel(
      "PaymentGatewayTransaction",
      "payment_gateway_transactions",
      "orderId"
    );
    this.models.Reminder = jsonPayloadModel("Reminder", "reminders", "id");
    this.models.SentReminder = jsonPayloadModel("SentReminder", "sent_reminders", "id");
    this.models.Role = this.sequelize.define("Role", {
      phoneNumber: {
        type: DataTypes.STRING,
        primaryKey: true,
      },
      role: {
        type: DataTypes.STRING,
        allowNull: false,
      },
    }, {
      tableName: "roles",
      timestamps: true,
    });
    this.models.Setting = this.sequelize.define("Setting", {
      key: {
        type: DataTypes.STRING,
        primaryKey: true,
      },
      value: {
        type: DataTypes.JSON,
        allowNull: false,
      },
    }, {
      tableName: "settings",
      timestamps: true,
    });

    await this.sequelize.authenticate();
    await this.configureDatabaseConnection();
    await this.sequelize.sync();
    if (!process.env.DATABASE_URL) {
      await fs.chmod(CONFIG.DB_STORAGE, 0o600);
    }
  }


  async configureDatabaseConnection() {
    if (process.env.DATABASE_URL) {
      return;
    }

    await this.sequelize.query(`PRAGMA busy_timeout = ${CONFIG.SQLITE_BUSY_TIMEOUT}`);
    await this.sequelize.query("PRAGMA journal_mode = WAL");
    await this.sequelize.query("PRAGMA synchronous = NORMAL");
    await this.sequelize.query("PRAGMA foreign_keys = ON");
  }

  async healthCheck() {
    if (!this.sequelize) {
      throw new Error("Database belum diinisialisasi.");
    }

    const timeout = Math.max(250, CONFIG.HEALTHCHECK_TIMEOUT);
    let timeoutId;
    try {
      await Promise.race([
        this.sequelize.authenticate(),
        new Promise((_, reject) => {
          timeoutId = setTimeout(() => reject(new Error("Database health check timeout.")), timeout);
          timeoutId.unref?.();
        }),
      ]);
      return true;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async close() {
    if (!this.sequelize) return;
    const sequelize = this.sequelize;
    await sequelize.close();
    this.sequelize = null;
  }

  async withDatabaseWrite(operation) {
    return this.dbWriteLock.runExclusive("database_write", operation);
  }

  async withDataMutation(operation) {
    return this.dataMutationLock.runExclusive("data_mutation", async () => {
      const snapshot = {
        contacts: structuredClone(this.contacts),
        pelanggan: structuredClone(this.pelanggan),
        customerAccounts: structuredClone(this.customerAccounts),
        paymentGatewayTransactions: structuredClone(this.paymentGatewayTransactions),
        reminders: structuredClone(this.reminders),
        sentReminders: structuredClone(this.sentReminders),
        roles: structuredClone(this.roles),
        settings: structuredClone(this.settings),
      };

      try {
        return await operation();
      } catch (error) {
        this.contacts = snapshot.contacts;
        this.pelanggan = snapshot.pelanggan;
        this.customerAccounts = snapshot.customerAccounts;
        this.paymentGatewayTransactions = snapshot.paymentGatewayTransactions;
        this.reminders = snapshot.reminders;
        this.sentReminders = snapshot.sentReminders;
        this.roles = snapshot.roles;
        this.settings = snapshot.settings;
        throw error;
      }
    });
  }

  async acquireLock(filePath) {
    const startTime = Date.now();
    while (this.fileLocks.has(filePath)) {
      if (Date.now() - startTime > CONFIG.MAX_LOCK_WAIT) {
        throw new Error(`Lock acquisition timeout for ${filePath}`);
      }
      await sleep(CONFIG.LOCK_POLL_INTERVAL);
    }
    this.fileLocks.set(filePath, true);
  }

  releaseLock(filePath) {
    this.fileLocks.delete(filePath);
  }

  async atomicWrite(filePath, data, maxRetries = 3) {
    await this.acquireLock(filePath);
    const tempPath = `${filePath}.tmp`;
    const backupPath = `${filePath}.bak`;

    try {
      for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
        try {
          await fs.copyFile(filePath, backupPath).catch(() => {});
          await fs.writeFile(tempPath, JSON.stringify(data, null, 2));
          JSON.parse(await fs.readFile(tempPath, "utf-8"));
          await fs.rename(tempPath, filePath);
          return;
        } catch (error) {
          this.activityLog.push("error", "storage", `Write attempt ${attempt} failed for ${path.basename(filePath)}`, { error: error.message });
          await fs.copyFile(backupPath, filePath).catch(() => {});
          if (attempt === maxRetries) throw error;
          await sleep(100 * attempt);
        }
      }
    } finally {
      this.releaseLock(filePath);
      await fs.unlink(tempPath).catch(() => {});
    }
  }

  async loadLegacyMapFromFile(filePath, keyField) {
    const readMap = async (candidatePath) => {
      const raw = await fs.readFile(candidatePath, "utf-8");
      if (!raw.trim()) return new Map();

      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return new Map();

      return new Map(
        arr
          .filter((item) => item && item[keyField])
          .map((item) => [String(item[keyField]), item])
      );
    };

    try {
      return await readMap(filePath);
    } catch (error) {
      if (error.code !== "ENOENT") {
        this.activityLog.push("error", "storage", `Failed to load ${path.basename(filePath)}`, {
          error: error.message,
        });
      }

      const backupPath = `${filePath}.bak`;
      try {
        return await readMap(backupPath);
      } catch {
        return new Map();
      }
    }
  }

  async loadLegacyRoles() {
    try {
      const raw = await fs.readFile(this.getPath("roles.json"), "utf-8");
      if (!raw.trim()) return new Map();
      return new Map(Object.entries(JSON.parse(raw)));
    } catch (error) {
      if (error.code === "ENOENT") return new Map();
      this.activityLog.push("error", "storage", "Failed to load roles.json", { error: error.message });
      return new Map();
    }
  }

  async loadLegacySettings() {
    try {
      const raw = await fs.readFile(this.getPath("settings.json"), "utf-8");
      if (!raw.trim()) return { ...DEFAULT_SETTINGS };
      const settings = { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
      delete settings.whatsappProvider;
      delete settings.hotspotReactivationMessageTemplate;
      return settings;
    } catch (error) {
      if (error.code === "ENOENT") return { ...DEFAULT_SETTINGS };
      this.activityLog.push("error", "storage", "Failed to load settings.json", { error: error.message });
      return { ...DEFAULT_SETTINGS };
    }
  }

  async loadJsonPayloadMap(model, keyField) {
    const rows = await model.findAll({ raw: true });
    return new Map(rows.map((row) => [String(row[keyField]), this.parseStoredJson(row.data, {})]));
  }

  parseStoredJson(value, fallback) {
    if (typeof value !== "string") {
      return value ?? fallback;
    }

    try {
      return JSON.parse(value);
    } catch {
      return fallback;
    }
  }

  async hasDatabaseData() {
    const counts = await Promise.all([
      this.models.Contact.count(),
      this.models.Pelanggan.count(),
      this.models.CustomerAccount.count(),
      this.models.PaymentGatewayTransaction.count(),
      this.models.Reminder.count(),
      this.models.SentReminder.count(),
      this.models.Role.count(),
      this.models.Setting.count(),
    ]);
    return counts.some((count) => count > 0);
  }

  async loadFromDatabase() {
    this.contacts = await this.loadJsonPayloadMap(this.models.Contact, "id");
    this.pelanggan = await this.loadJsonPayloadMap(this.models.Pelanggan, "username");
    this.customerAccounts = await this.loadJsonPayloadMap(this.models.CustomerAccount, "contactId");
    this.paymentGatewayTransactions = await this.loadJsonPayloadMap(
      this.models.PaymentGatewayTransaction,
      "orderId"
    );
    this.reminders = await this.loadJsonPayloadMap(this.models.Reminder, "id");
    this.sentReminders = await this.loadJsonPayloadMap(this.models.SentReminder, "id");

    const roleRows = await this.models.Role.findAll({ raw: true });
    this.roles = new Map(roleRows.map((row) => [String(row.phoneNumber), row.role]));

    const settingsRow = await this.models.Setting.findByPk("app", { raw: true });
    this.settings = { ...DEFAULT_SETTINGS, ...this.parseStoredJson(settingsRow?.value, {}) };
    if (Object.hasOwn(this.settings, "whatsappProvider")) {
      delete this.settings.whatsappProvider;
      await this.saveSettings();
    }
    if (Object.hasOwn(this.settings, "hotspotReactivationMessageTemplate")) {
      delete this.settings.hotspotReactivationMessageTemplate;
      await this.saveSettings();
    }
  }

  async loadFromLegacyJson() {
    this.contacts = await this.loadLegacyMapFromFile(this.getPath("contacts.json"), "id");
    this.pelanggan = await this.loadLegacyMapFromFile(this.getPath("pelanggan.json"), "username");
    this.customerAccounts = new Map();
    this.paymentGatewayTransactions = new Map();
    this.reminders = await this.loadLegacyMapFromFile(this.getPath("reminders.json"), "id");
    this.sentReminders = await this.loadLegacyMapFromFile(this.getPath("sent_reminders.json"), "id");
    this.roles = await this.loadLegacyRoles();
    this.settings = await this.loadLegacySettings();
  }

  async loadAll() {
    this.activityLog.push("info", "boot", "Loading persisted data with Sequelize");
    await this.initDatabase();

    if (await this.hasDatabaseData()) {
      await this.loadFromDatabase();
    } else {
      await this.loadFromLegacyJson();
      await this.saveAll();
      this.activityLog.push("info", "storage", "Legacy JSON data migrated into Sequelize database", {
        storage: process.env.DATABASE_URL ? "DATABASE_URL" : CONFIG.DB_STORAGE,
      });
    }

    this.normalizeLoadedContacts();
    await this.migrateServiceSchedulesFromRegistration();
    const portalAccountsCreated = await this.synchronizeCustomerPortalAccounts();
    await this.normalizeReminderRelations();
    await this.removeNonRecurringReminders();
    await this.repairMissingRecurringReminders();
    await this.migrateReminderPaymentAmounts();
    await this.migrateReminderVariableTemplates();
    await this.migrateFormalNotificationTemplates();
    await this.migrateExistingPaidServiceSchedules();
    const migration = await migrateWhatsAppProviderMetadata(this);
    if (migration.remindersChanged || migration.sentChanged) {
      this.activityLog.push("info", "storage", "WhatsApp provider metadata migration selesai", migration);
    }
    await this.cleanupSentHistory();
    this.activityLog.push("info", "boot", "Data load complete", {
      contacts: this.contacts.size,
      pelanggan: this.pelanggan.size,
      customerAccounts: this.customerAccounts.size,
      paymentGatewayTransactions: this.paymentGatewayTransactions.size,
      reminders: this.reminders.size,
      sentReminders: this.sentReminders.size,
      adminRecipients: this.getAdminRecipients().length,
      portalAccountsCreated,
    });
  }

  async replaceJsonPayloadTable(model, keyField, values, options = {}) {
    const rows = Array.from(values).map((item) => ({
      [keyField]: String(item[keyField]),
      data: item,
    }));
    const transaction = options.transaction || null;

    await model.destroy({ where: {}, truncate: true, transaction });
    if (rows.length > 0) {
      await model.bulkCreate(rows, { transaction });
    }
  }

  async runSaveOperation(operation, options = {}) {
    if (options.transaction) {
      return operation(options.transaction);
    }

    return this.withDatabaseWrite(() => (
      this.sequelize.transaction((transaction) => operation(transaction))
    ));
  }

  async saveContacts(options = {}) {
    await this.runSaveOperation(
      (transaction) => this.replaceJsonPayloadTable(this.models.Contact, "id", this.contacts.values(), { transaction }),
      options
    );
  }

  async savePelanggan(options = {}) {
    await this.runSaveOperation(
      (transaction) => this.replaceJsonPayloadTable(this.models.Pelanggan, "username", this.pelanggan.values(), { transaction }),
      options
    );
  }

  async saveCustomerAccounts(options = {}) {
    if (!this.models.CustomerAccount) return;
    await this.runSaveOperation(
      (transaction) => this.replaceJsonPayloadTable(
        this.models.CustomerAccount,
        "contactId",
        this.customerAccounts.values(),
        { transaction }
      ),
      options
    );
  }

  async savePaymentGatewayTransactions(options = {}) {
    if (!this.models.PaymentGatewayTransaction) return;
    await this.runSaveOperation(
      (transaction) => this.replaceJsonPayloadTable(
        this.models.PaymentGatewayTransaction,
        "orderId",
        this.paymentGatewayTransactions.values(),
        { transaction }
      ),
      options
    );
  }

  async saveReminders(options = {}) {
    await this.runSaveOperation(
      (transaction) => this.replaceJsonPayloadTable(this.models.Reminder, "id", this.reminders.values(), { transaction }),
      options
    );
  }

  async saveSentReminders(options = {}) {
    await this.runSaveOperation(
      (transaction) => this.replaceJsonPayloadTable(this.models.SentReminder, "id", this.sentReminders.values(), { transaction }),
      options
    );
  }

  async cleanupSentHistory(options = {}) {
    return this.withDataMutation(async () => this.cleanupSentHistoryUnlocked(options));
  }

  async cleanupSentHistoryUnlocked(options = {}) {
    const retentionMonths = Number(options.retentionMonths || CONFIG.SENT_HISTORY_RETENTION_MONTHS);
    if (!Number.isFinite(retentionMonths) || retentionMonths <= 0) {
      return { deleted: 0, cutoff: null, remaining: this.sentReminders.size };
    }

    const cutoffDate = options.cutoffDate || addMonthsSafely(new Date(), -retentionMonths, this.getTimezone());
    const cutoffTime = cutoffDate.getTime();
    if (Number.isNaN(cutoffTime)) {
      return { deleted: 0, cutoff: null, remaining: this.sentReminders.size };
    }

    const deletedIds = [];
    for (const [id, reminder] of this.sentReminders.entries()) {
      const sentDate = new Date(reminder?.sentAt || reminder?.reminderDateTime);
      if (Number.isNaN(sentDate.getTime())) continue;
      if (sentDate.getTime() < cutoffTime) {
        deletedIds.push(id);
      }
    }

    for (const id of deletedIds) {
      this.sentReminders.delete(id);
    }

    if (deletedIds.length > 0) {
      await this.saveSentReminders();
      this.activityLog.push("info", "storage", `Sent History auto-clean removed ${deletedIds.length} old item(s)`, {
        retentionMonths,
        cutoff: cutoffDate.toISOString(),
      });
    }

    return {
      deleted: deletedIds.length,
      cutoff: cutoffDate.toISOString(),
      remaining: this.sentReminders.size,
    };
  }

  async saveRoles(options = {}) {
    await this.runSaveOperation(async (transaction) => {
      const rows = Array.from(this.roles.entries()).map(([phoneNumber, role]) => ({ phoneNumber, role }));
      await this.models.Role.destroy({ where: {}, truncate: true, transaction });
      if (rows.length > 0) {
        await this.models.Role.bulkCreate(rows, { transaction });
      }
    }, options);
  }

  async saveSettings(options = {}) {
    await this.runSaveOperation((transaction) => (
      this.models.Setting.upsert({
        key: "app",
        value: this.settings,
      }, { transaction })
    ), options);
  }

  normalizeLoadedContacts() {
    for (const contact of this.contacts.values()) {
      contact.paymentStatus = String(contact.paymentStatus || PAYMENT_STATUS.UNPAID).toUpperCase();
      const normalizedType = String(contact.paymentType || "").toUpperCase();
      contact.paymentType = Object.values(PAYMENT_TYPES).includes(normalizedType) ? normalizedType : null;
      contact.monthlyPaymentAmount = sanitizePositiveInteger(
        contact.monthlyPaymentAmount,
        0,
        0,
        1_000_000_000
      );
      // Data lama belum memiliki penanda ini dan tetap mengikuti tarif profile.
      contact.monthlyPaymentAmountCustomized = parseBoolean(
        contact.monthlyPaymentAmountCustomized,
        false
      );
      contact.subscriptionType = normalizeSubscriptionType(contact.subscriptionType);
      contact.subscriptionChangedByArrears = parseBoolean(
        contact.subscriptionChangedByArrears,
        false
      );
      contact.arrearsSubscriptionDebtPeriods = Array.from(new Set(
        (Array.isArray(contact.arrearsSubscriptionDebtPeriods)
          ? contact.arrearsSubscriptionDebtPeriods
          : [])
          .map(String)
          .filter((period) => /^\d{4}-\d{2}$/.test(period))
      ));
      contact.billingPausedForArrears = parseBoolean(contact.billingPausedForArrears, false);
      contact.billingPausedAfterPeriod = /^\d{4}-\d{2}$/.test(String(contact.billingPausedAfterPeriod || ""))
        ? String(contact.billingPausedAfterPeriod)
        : null;
      contact.hotspotSuspendedForArrears = parseBoolean(contact.hotspotSuspendedForArrears, false);
      contact.hotspotManualActivationWithArrears = parseBoolean(
        contact.hotspotManualActivationWithArrears,
        false
      );
      contact.activePeriodPurchases = (Array.isArray(contact.activePeriodPurchases)
        ? contact.activePeriodPurchases
        : [])
        .map((purchase) => {
          const id = sanitizeInput(String(purchase?.id || ""));
          const purchasedAt = this.normalizeOptionalDate(purchase?.purchasedAt);
          const activeFrom = this.normalizeOptionalDate(purchase?.activeFrom);
          const activeUntil = this.normalizeOptionalDate(purchase?.activeUntil);
          const amount = sanitizePositiveInteger(purchase?.amount, 0, 0, 1_000_000_000);
          if (!id || !purchasedAt || !activeFrom || !activeUntil || amount <= 0) return null;
          return {
            id,
            paymentType: PAYMENT_TYPES.ACTIVE_PERIOD,
            status: PAYMENT_STATUS.PAID,
            amount,
            purchasedAt,
            activeFrom,
            activeUntil,
            paymentProvider: sanitizeInput(String(purchase?.paymentProvider || "manual")) || "manual",
          };
        })
        .filter(Boolean);
      contact.linkedApHost = sanitizeInput(String(contact.linkedApHost || ""));
      contact.mikrotikUsername = sanitizeInput(String(contact.mikrotikUsername || ""));
      contact.mikrotikProfile = sanitizeInput(String(contact.mikrotikProfile || ""));
      contact.mikrotikPassword = sanitizeInput(String(contact.mikrotikPassword || ""));
      const inferredProvisioningStatus = contact.mikrotikUsername && contact.mikrotikProfile
        ? HOTSPOT_PROVISIONING_STATUS.ACTIVE
        : HOTSPOT_PROVISIONING_STATUS.NONE;
      contact.hotspotProvisioningStatus = normalizeHotspotProvisioningStatus(
        contact.hotspotProvisioningStatus,
        inferredProvisioningStatus
      );
      contact.hotspotProvisioningError = sanitizeInput(String(contact.hotspotProvisioningError || ""));
      contact.hotspotLastCheckedAt = this.normalizeOptionalDate(contact.hotspotLastCheckedAt);
      contact.hotspotLastSyncedAt = this.normalizeOptionalDate(contact.hotspotLastSyncedAt);
      contact.hotspotSendCredentials = parseBoolean(contact.hotspotSendCredentials, false);
      const previousProvisioning = contact.hotspotProvisioningPrevious;
      if (previousProvisioning && typeof previousProvisioning === "object") {
        const previousUsername = sanitizeInput(String(previousProvisioning.username || ""));
        contact.hotspotProvisioningPrevious = previousUsername ? {
          username: previousUsername,
          profile: sanitizeInput(String(previousProvisioning.profile || "")),
          password: sanitizeInput(String(previousProvisioning.password || "")),
          phoneNumber: normalizePhoneNumber(previousProvisioning.phoneNumber),
        } : null;
      } else {
        contact.hotspotProvisioningPrevious = null;
      }
      const inferredOperation = contact.hotspotProvisioningPrevious
        ? HOTSPOT_PROVISIONING_OPERATION.UPDATE
        : ([HOTSPOT_PROVISIONING_STATUS.PENDING, HOTSPOT_PROVISIONING_STATUS.PROVISIONING, HOTSPOT_PROVISIONING_STATUS.FAILED]
          .includes(contact.hotspotProvisioningStatus) && contact.mikrotikUsername
          ? HOTSPOT_PROVISIONING_OPERATION.CREATE
          : HOTSPOT_PROVISIONING_OPERATION.NONE);
      contact.hotspotProvisioningOperation = normalizeHotspotProvisioningOperation(
        contact.hotspotProvisioningOperation,
        inferredOperation
      );
      if (contact.hotspotProvisioningStatus === HOTSPOT_PROVISIONING_STATUS.PROVISIONING) {
        contact.hotspotProvisioningStatus = HOTSPOT_PROVISIONING_STATUS.PENDING;
        contact.hotspotProvisioningError = contact.hotspotProvisioningError
          || "Provisioning terputus saat aplikasi berhenti. Silakan coba lagi.";
      }
      contact.hotspotReactivationEnabled = parseBoolean(contact.hotspotReactivationEnabled, false);
      contact.hotspotReactivationAt = this.normalizeOptionalDate(contact.hotspotReactivationAt);
      if (!isRecurringSubscription(contact)) {
        contact.hotspotReactivationEnabled = false;
        contact.billingPausedForArrears = false;
        contact.billingPausedAfterPeriod = null;
        contact.hotspotSuspendedForArrears = false;
        contact.hotspotManualActivationWithArrears = false;
      }
      contact.hotspotLastReactivatedAt = this.normalizeOptionalDate(contact.hotspotLastReactivatedAt);
      contact.hotspotLastDeactivatedAt = this.normalizeOptionalDate(contact.hotspotLastDeactivatedAt);
      // Notifikasi WhatsApp setelah reaktivasi sudah tidak digunakan.
      contact.hotspotNotificationPending = null;
      if (!contact.paymentMonths || typeof contact.paymentMonths !== "object" || Array.isArray(contact.paymentMonths)) {
        contact.paymentMonths = {};
      }

      if (contact.paymentStatus === PAYMENT_STATUS.PAID && contact.paymentDate) {
        const paidDate = new Date(contact.paymentDate);
        if (!Number.isNaN(paidDate.getTime())) {
          const key = getBillingPeriodKey(paidDate, this.getTimezone());
          if (!contact.paymentMonths[key]) {
            contact.paymentMonths[key] = {
              status: PAYMENT_STATUS.PAID,
              paidDate: paidDate.toISOString(),
              paymentType: contact.paymentType,
              paidAmount: Math.max(0, Math.floor(Number(contact.monthlyPaymentAmount) || 0)),
            };
          }
        }
      }
    }

    for (const pelanggan of this.pelanggan.values()) {
      const contact = pelanggan.contactId ? this.getContact(pelanggan.contactId) : null;
      const inferredStatus = pelanggan.username && pelanggan.profile
        ? HOTSPOT_PROVISIONING_STATUS.ACTIVE
        : HOTSPOT_PROVISIONING_STATUS.NONE;
      pelanggan.hotspotProvisioningStatus = normalizeHotspotProvisioningStatus(
        pelanggan.hotspotProvisioningStatus || contact?.hotspotProvisioningStatus,
        inferredStatus
      );
      if (pelanggan.hotspotProvisioningStatus === HOTSPOT_PROVISIONING_STATUS.PROVISIONING) {
        pelanggan.hotspotProvisioningStatus = HOTSPOT_PROVISIONING_STATUS.PENDING;
      }
      pelanggan.hotspotProvisioningError = sanitizeInput(String(
        pelanggan.hotspotProvisioningError || contact?.hotspotProvisioningError || ""
      ));
      pelanggan.hotspotLastCheckedAt = this.normalizeOptionalDate(
        pelanggan.hotspotLastCheckedAt || contact?.hotspotLastCheckedAt
      );
      pelanggan.hotspotLastSyncedAt = this.normalizeOptionalDate(
        pelanggan.hotspotLastSyncedAt || contact?.hotspotLastSyncedAt
      );
    }
  }

  getContactRegistrationAt(contact) {
    const pelanggan = this.pelanggan.get(String(contact.mikrotikUsername || ""))
      || Array.from(this.pelanggan.values()).find(
        (item) => String(item.contactId || "") === String(contact.id)
      )
      || null;
    const candidates = [contact.createdAt, pelanggan?.tanggalDaftar]
      .map((value) => new Date(value || ""))
      .filter((date) => !Number.isNaN(date.getTime()))
      .sort((a, b) => a.getTime() - b.getTime());
    return candidates[0] || null;
  }

  getNextServiceScheduleFromRegistration(contact, options = {}) {
    const registrationAt = options.registrationAt
      ? new Date(options.registrationAt)
      : this.getContactRegistrationAt(contact);
    if (!registrationAt || Number.isNaN(registrationAt.getTime())) return null;

    const now = options.now ? new Date(options.now) : new Date();
    let schedule = addMonthsSafely(registrationAt, 1, this.getTimezone());
    if (Number.isNaN(now.getTime())) return schedule.toISOString();
    while (schedule.getTime() <= now.getTime()) {
      schedule = addMonthsSafely(schedule, 1, this.getTimezone());
    }
    return schedule.toISOString();
  }

  async migrateServiceSchedulesFromRegistration(options = {}) {
    return this.withDataMutation(async () => {
      const settings = this.getSettings();
      if (Number(settings.serviceScheduleAnchorMigrationVersion) >= 1) {
        return { migrated: 0, skipped: 0, version: 1 };
      }

      let migrated = 0;
      let skipped = 0;
      const updatedAt = new Date().toISOString();
      for (const contact of this.contacts.values()) {
        const schedule = this.getNextServiceScheduleFromRegistration(contact, options);
        if (!schedule) {
          skipped += 1;
          continue;
        }

        const hadSchedule = Boolean(contact.hotspotReactivationAt);
        contact.hotspotReactivationAt = schedule;
        if (!hadSchedule) {
          contact.hotspotReactivationEnabled = isRecurringSubscription(contact);
        } else if (!isRecurringSubscription(contact)) {
          contact.hotspotReactivationEnabled = false;
        }
        contact.updatedAt = updatedAt;
        migrated += 1;
      }

      this.settings = {
        ...settings,
        serviceScheduleAnchorMigrationVersion: 1,
      };
      await this.withDatabaseWrite(() => this.sequelize.transaction(async (transaction) => {
        const saveOptions = { transaction };
        if (migrated > 0) await this.saveContacts(saveOptions);
        await this.saveSettings(saveOptions);
      }));
      this.activityLog.push("info", "storage", `Jadwal layanan ${migrated} pelanggan diselaraskan dengan waktu registrasi pertama`, {
        migration: "service-schedule-registration-anchor-v1",
        migrated,
        skipped,
      });
      return { migrated, skipped, version: 1 };
    });
  }

  async synchronizeCustomerPortalAccounts(options = {}) {
    let created = 0;
    const now = new Date().toISOString();

    for (const contact of this.contacts.values()) {
      const hotspotRecord = Array.from(this.pelanggan.values()).find(
        (item) => String(item.contactId || "") === String(contact.id)
      );
      const hotspotUsername = sanitizeInput(String(contact.mikrotikUsername || hotspotRecord?.username || ""));
      const hotspotPassword = sanitizeInput(String(contact.mikrotikPassword || hotspotRecord?.password || ""));
      const existing = this.customerAccounts.get(String(contact.id)) || null;
      if (!existing && (!hotspotUsername || !hotspotPassword)) continue;

      const preferredPortalUsername = sanitizeInput(String(existing?.username || hotspotUsername));
      const portalUsername = this.getUniqueCustomerPortalUsername(preferredPortalUsername, contact.id);
      const portalPassword = sanitizeInput(String(existing?.password || hotspotPassword));
      if (!portalUsername || !portalPassword) continue;

      const customerAccount = {
        ...(existing || {}),
        contactId: String(contact.id),
        username: portalUsername,
        password: portalPassword,
        createdAt: existing?.createdAt || contact.createdAt || now,
        updatedAt: existing?.updatedAt || contact.updatedAt || now,
      };
      const changed = !existing || JSON.stringify(existing) !== JSON.stringify(customerAccount);
      this.customerAccounts.set(String(contact.id), customerAccount);
      if (changed) created += 1;
    }

    if (created > 0 && this.sequelize && options.save !== false) {
      await this.saveCustomerAccounts();
      this.activityLog.push("info", "storage", `${created} akun portal pelanggan disinkronkan dari data pelanggan lama`);
    }

    return created;
  }

  getUniqueCustomerPortalUsername(preferred, contactId) {
    const base = sanitizeInput(preferred) || `pelanggan_${String(contactId || "").slice(-6)}`;
    const normalized = base.toLowerCase();
    const owner = Array.from(this.customerAccounts.values()).find(
      (item) => String(item.username || "").toLowerCase() === normalized
        && String(item.contactId || "") !== String(contactId || "")
    );
    if (!owner) return base;

    const contact = this.getContact(contactId);
    const suffix = normalizePhoneNumber(contact?.phoneNumber || "").slice(-4) || "akun";
    let candidate = `${base}_${suffix}`;
    let counter = 2;
    while (Array.from(this.customerAccounts.values()).some(
      (item) => String(item.username || "").toLowerCase() === candidate.toLowerCase()
        && String(item.contactId || "") !== String(contactId || "")
    )) {
      candidate = `${base}_${suffix}_${counter}`;
      counter += 1;
    }
    return candidate;
  }

  findCustomerPortalAccount(username) {
    const normalized = sanitizeInput(String(username || "")).toLowerCase();
    if (!normalized) return null;

    const account = Array.from(this.customerAccounts.values()).find(
      (item) => String(item.username || "").toLowerCase() === normalized
    );
    if (!account?.contactId || !account.password) return null;

    return this.getCustomerPortalAccountByContactId(account.contactId);
  }

  getCustomerPortalAccountByContactId(contactId) {
    const contact = this.getContact(contactId);
    if (!contact) return null;
    const account = this.customerAccounts.get(String(contact.id));
    if (!account?.username || !account.password) return null;
    const pelanggan = Array.from(this.pelanggan.values()).find(
      (item) => String(item.contactId || "") === String(contact.id)
    );
    return { account, pelanggan, contact };
  }

  getCustomerPortalData(contactId) {
    const contact = this.getContact(contactId);
    if (!contact) return null;
    const hydrated = this.hydrateContact(contact);
    const portalAccount = this.customerAccounts.get(String(contact.id));
    if (!portalAccount) return null;
    const hotspotAccount = Array.from(this.pelanggan.values()).find(
      (item) => String(item.contactId || "") === String(contact.id)
    );
    const hotspotStatus = normalizeHotspotProvisioningStatus(
      contact.hotspotProvisioningStatus || hotspotAccount?.hotspotProvisioningStatus,
      contact.mikrotikUsername || hotspotAccount?.username
        ? HOTSPOT_PROVISIONING_STATUS.ACTIVE
        : HOTSPOT_PROVISIONING_STATUS.NONE
    );

    const timeZone = this.getTimezone();
    const { year, month } = getBillingPeriodParts(new Date(), timeZone);
    const currentKey = makeBillingPeriodKey(year, month);
    const monthlyAmount = Math.max(0, Number(hydrated.monthlyPaymentAmount) || 0);
    const currentPaymentStatus = hydrated.currentPaymentStatus || hydrated.paymentStatus || PAYMENT_STATUS.UNPAID;
    const currentAmount = currentPaymentStatus === PAYMENT_STATUS.PAID ? 0 : monthlyAmount;
    const debtAmount = Math.max(0, Number(hydrated.debtAmount) || 0);
    const historyByPeriod = new Map(
      Object.entries(hydrated.paymentMonths || {})
        .filter(([period]) => /^\d{4}-\d{2}$/.test(period))
        .map(([period, payment]) => {
          const paidAmount = this.getPaymentPaidAmount(payment, monthlyAmount);
          return [period, {
            period,
            label: formatBillingPeriodLabel(Number(period.slice(0, 4)), Number(period.slice(5, 7))),
            status: payment?.status || PAYMENT_STATUS.UNPAID,
            paidDate: payment?.paidDate || null,
            lastPaymentDate: payment?.lastPaymentDate || payment?.paidDate || null,
            paymentType: payment?.paymentType || null,
            paidAmount,
            remainingAmount: this.getPaymentRemainingAmount(payment, monthlyAmount),
          }];
        })
    );
    for (const debtPeriod of hydrated.debtPeriods || []) {
      if (!historyByPeriod.has(debtPeriod.key)) {
        historyByPeriod.set(debtPeriod.key, {
          period: debtPeriod.key,
          label: debtPeriod.label,
          status: PAYMENT_STATUS.UNPAID,
          paidDate: null,
          lastPaymentDate: null,
          paymentType: null,
          paidAmount: debtPeriod.paidAmount || 0,
          remainingAmount: debtPeriod.remainingAmount ?? monthlyAmount,
        });
      }
    }
    const billingStartPeriod = getContactBillingStartPeriod(contact, timeZone);
    const includeCurrentPeriod = isRecurringSubscription(contact)
      || (billingStartPeriod.year === year && billingStartPeriod.month === month)
      || historyByPeriod.has(currentKey);
    if (includeCurrentPeriod && !historyByPeriod.has(currentKey)) {
      historyByPeriod.set(currentKey, {
        period: currentKey,
        label: formatBillingPeriodLabel(year, month),
        status: currentPaymentStatus,
        paidDate: hydrated.paymentDate || null,
        lastPaymentDate: hydrated.paymentDate || null,
        paymentType: hydrated.paymentType || null,
        paidAmount: currentPaymentStatus === PAYMENT_STATUS.PAID ? monthlyAmount : 0,
        remainingAmount: currentAmount,
      });
    }
    const activePeriodHistory = (hydrated.activePeriodPurchases || []).map((purchase) => ({
      period: `active-${purchase.id}`,
      label: "Masa aktif 1 bulan",
      status: PAYMENT_STATUS.PAID,
      paidDate: purchase.purchasedAt,
      lastPaymentDate: purchase.purchasedAt,
      paymentType: PAYMENT_TYPES.ACTIVE_PERIOD,
      paidAmount: purchase.amount,
      remainingAmount: 0,
      activeUntil: purchase.activeUntil,
    }));
    const paymentHistory = [...historyByPeriod.values(), ...activePeriodHistory]
      .sort((a, b) => {
        const dateDifference = new Date(b.lastPaymentDate || b.paidDate || 0).getTime()
          - new Date(a.lastPaymentDate || a.paidDate || 0).getTime();
        return dateDifference || String(b.period).localeCompare(String(a.period));
      });

    return {
      customer: {
        id: String(contact.id),
        name: contact.name,
        phoneNumber: contact.phoneNumber,
      },
      billing: {
        period: currentKey,
        periodLabel: formatBillingPeriodLabel(year, month),
        subscriptionType: hydrated.subscriptionType,
        subscriptionActive: hydrated.subscriptionActive,
        billingPausedForArrears: hydrated.billingPausedForArrears,
        billingPausedAfterPeriod: hydrated.billingPausedAfterPeriod,
        monthlyAmount,
        currentAmount,
        debtAmount,
        totalAmount: currentAmount + debtAmount,
        currentPaymentStatus,
        debtCount: hydrated.debtCount,
        debtPeriods: hydrated.debtPeriods,
        dueDate: hydrated.dueDate || null,
        dueStatus: hydrated.dueStatus || null,
        history: paymentHistory,
      },
      hotspot: isHotspotAccountUnavailable(
        hotspotStatus,
        contact.hotspotProvisioningError || hotspotAccount?.hotspotProvisioningError
      ) ? null : {
        username: contact.mikrotikUsername || hotspotAccount?.username || "",
        password: contact.mikrotikPassword || hotspotAccount?.password || "",
        profile: contact.mikrotikProfile || hotspotAccount?.profile || "",
        status: hotspotStatus,
        suspendedForArrears: Boolean(contact.hotspotSuspendedForArrears),
        manualActivationWithArrears: Boolean(contact.hotspotManualActivationWithArrears),
        activeUntil: contact.hotspotReactivationAt || null,
        lastSyncedAt: contact.hotspotLastSyncedAt || hotspotAccount?.hotspotLastSyncedAt || null,
      },
      account: {
        username: portalAccount.username,
      },
      paymentGateway: {
        enabled: Boolean(CONFIG.MIDTRANS_ENABLED && CONFIG.MIDTRANS_SERVER_KEY),
        provider: "midtrans",
        environment: CONFIG.MIDTRANS_IS_PRODUCTION ? "production" : "sandbox",
      },
      company: {
        name: this.getSettings().companyName,
        supportSignature: this.getSettings().supportSignature,
      },
    };
  }

  async updateCustomerHotspotPassword(contactId, currentPassword, newPassword) {
    return this.withDataMutation(async () => {
      const account = this.getCustomerPortalAccountByContactId(contactId);
      if (!account) throw new Error("Akun pelanggan tidak ditemukan.");
      const hotspotStatus = normalizeHotspotProvisioningStatus(
        account.contact.hotspotProvisioningStatus || account.pelanggan?.hotspotProvisioningStatus,
        account.contact.mikrotikUsername || account.pelanggan?.username
          ? HOTSPOT_PROVISIONING_STATUS.ACTIVE
          : HOTSPOT_PROVISIONING_STATUS.NONE
      );
      if (isHotspotAccountUnavailable(
        hotspotStatus,
        account.contact.hotspotProvisioningError || account.pelanggan?.hotspotProvisioningError
      )) {
        const error = new Error(getHotspotUnavailableMessage(
          hotspotStatus,
          account.contact.hotspotProvisioningError || account.pelanggan?.hotspotProvisioningError
        ));
        error.statusCode = 404;
        throw error;
      }
      const currentHotspotPassword = String(
        account.contact.mikrotikPassword || account.pelanggan?.password || ""
      );
      if (!safeCompareString(currentPassword, currentHotspotPassword)) {
        const error = new Error("Password hotspot saat ini tidak sesuai.");
        error.statusCode = 403;
        throw error;
      }

      const now = new Date().toISOString();
      account.contact.mikrotikPassword = newPassword;
      account.contact.hotspotProvisioningStatus = HOTSPOT_PROVISIONING_STATUS.ACTIVE;
      account.contact.hotspotProvisioningOperation = HOTSPOT_PROVISIONING_OPERATION.NONE;
      account.contact.hotspotProvisioningPrevious = null;
      account.contact.hotspotProvisioningError = "";
      account.contact.hotspotLastCheckedAt = now;
      account.contact.hotspotLastSyncedAt = now;
      account.contact.updatedAt = now;

      if (account.pelanggan) {
        account.pelanggan.password = newPassword;
        account.pelanggan.status = "verified";
        account.pelanggan.hotspotProvisioningStatus = HOTSPOT_PROVISIONING_STATUS.ACTIVE;
        account.pelanggan.hotspotProvisioningError = "";
        account.pelanggan.hotspotLastCheckedAt = now;
        account.pelanggan.hotspotLastSyncedAt = now;
        account.pelanggan.tanggalUpdate = now;
      }

      await this.withDatabaseWrite(() => this.sequelize.transaction(async (transaction) => {
        const options = { transaction };
        await this.saveContacts(options);
        await this.savePelanggan(options);
      }));
      return this.getCustomerPortalData(contactId);
    });
  }

  async updateCustomerPortalPassword(contactId, currentPassword, requestedPassword) {
    return this.withDataMutation(async () => {
      const account = this.getCustomerPortalAccountByContactId(contactId);
      if (!account) throw new Error("Akun pelanggan tidak ditemukan.");
      if (!safeCompareString(currentPassword, account.account.password)) {
        const error = new Error("Password akun pelanggan saat ini tidak sesuai.");
        error.statusCode = 403;
        throw error;
      }

      const rawNewPassword = String(requestedPassword || "");
      const newPassword = sanitizeInput(rawNewPassword);
      if (newPassword.length < 5 || newPassword.length > 64) {
        throw new Error("Password baru harus terdiri dari 5 sampai 64 karakter.");
      }
      if (newPassword !== rawNewPassword || !/^[\x21-\x7E]+$/.test(newPassword)) {
        throw new Error("Password baru tidak boleh mengandung spasi atau karakter khusus non-ASCII.");
      }
      if (safeCompareString(newPassword, account.account.password)) {
        throw new Error("Password baru harus berbeda dari password saat ini.");
      }

      account.account.password = newPassword;
      account.account.updatedAt = new Date().toISOString();
      await this.saveCustomerAccounts();
      return this.getCustomerPortalData(contactId);
    });
  }

  getPaymentGatewayTransaction(orderId) {
    return this.paymentGatewayTransactions.get(String(orderId || "")) || null;
  }

  getPendingPaymentGatewayTransactions(contactId = null) {
    const now = Date.now();
    return Array.from(this.paymentGatewayTransactions.values()).filter((transaction) => (
      transaction.provider === "midtrans"
      && (
        transaction.status === PAYMENT_GATEWAY_STATUS.PENDING
        // Respons 404/"Transaction doesn't exist" dapat terjadi beberapa
        // detik setelah transaksi dibuat. Transaksi seperti ini harus tetap
        // dicoba ulang oleh scheduler, bukan berhenti di status FAILED.
        || (
          transaction.status === PAYMENT_GATEWAY_STATUS.FAILED
          && transaction.gatewayStatus === "not_found"
          && now - new Date(transaction.createdAt || 0).getTime()
            <= Math.max(60_000, Number(CONFIG.MIDTRANS_NOT_FOUND_RETRY_WINDOW) || 0)
        )
      )
      && (contactId === null || String(transaction.contactId) === String(contactId))
    ));
  }

  findReusablePaymentGatewayTransaction({ contactId, amount, periods }) {
    const normalizedContactId = String(contactId || "");
    const normalizedAmount = Math.floor(Number(amount) || 0);
    const normalizedPeriods = Array.from(new Set((periods || []).map(String))).sort();
    const maximumAge = Math.max(
      60_000,
      Number(CONFIG.MIDTRANS_PENDING_TRANSACTION_TTL) || 24 * 60 * 60 * 1000
    );
    const cutoff = Date.now() - maximumAge;

    return Array.from(this.paymentGatewayTransactions.values())
      .filter((transaction) => {
        const createdAt = new Date(transaction.createdAt || 0).getTime();
        const transactionPeriods = Array.from(new Set((transaction.periods || []).map(String))).sort();
        return transaction.provider === "midtrans"
          && transaction.status === PAYMENT_GATEWAY_STATUS.PENDING
          && String(transaction.contactId) === normalizedContactId
          && Number(transaction.amount) === normalizedAmount
          && Boolean(transaction.redirectUrl)
          && Number.isFinite(createdAt)
          && createdAt >= cutoff
          && JSON.stringify(transactionPeriods) === JSON.stringify(normalizedPeriods);
      })
      .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))[0] || null;
  }

  async createPaymentGatewayTransaction(payload) {
    return this.withDataMutation(async () => {
      const orderId = sanitizeInput(String(payload.orderId || ""));
      const contactId = String(payload.contactId || "");
      const amount = Math.floor(Number(payload.amount) || 0);
      const periods = Array.from(new Set((payload.periods || []).map((period) => String(period))))
        .filter((period) => /^\d{4}-\d{2}$/.test(period));
      if (!orderId || orderId.length > 50) throw new Error("ID transaksi pembayaran tidak valid.");
      if (this.paymentGatewayTransactions.has(orderId)) throw new Error("ID transaksi pembayaran sudah digunakan.");
      if (!this.getContact(contactId)) throw new Error("Kontak tidak ditemukan.");
      if (amount <= 0 || periods.length === 0) throw new Error("Tagihan pelanggan sudah lunas atau belum memiliki nominal.");

      const now = new Date().toISOString();
      const transaction = {
        orderId,
        contactId,
        provider: "midtrans",
        amount,
        periods,
        paymentType: PAYMENT_TYPES.FULL_PAID,
        status: PAYMENT_GATEWAY_STATUS.PENDING,
        gatewayStatus: "created",
        token: null,
        redirectUrl: null,
        transactionId: null,
        paymentMethod: null,
        paidAt: null,
        createdAt: now,
        updatedAt: now,
      };
      this.paymentGatewayTransactions.set(orderId, transaction);
      await this.savePaymentGatewayTransactions();
      return transaction;
    });
  }

  async updatePaymentGatewayTransaction(orderId, changes = {}) {
    return this.withDataMutation(async () => {
      const transaction = this.getPaymentGatewayTransaction(orderId);
      if (!transaction) throw new Error("Transaksi pembayaran tidak ditemukan.");
      Object.assign(transaction, changes, { updatedAt: new Date().toISOString() });
      await this.savePaymentGatewayTransactions();
      return transaction;
    });
  }

  async completeMidtransPayment(orderId, gatewayData = {}) {
    return this.withDataMutation(async () => {
      const transaction = this.getPaymentGatewayTransaction(orderId);
      if (!transaction) throw new Error("Transaksi pembayaran tidak ditemukan.");
      const receivedAmount = Number(gatewayData.gross_amount);
      if (!Number.isFinite(receivedAmount) || Math.round(receivedAmount) !== transaction.amount) {
        const error = new Error("Nominal notifikasi Midtrans tidak sesuai dengan transaksi.");
        error.statusCode = 400;
        throw error;
      }
      const contact = this.getContact(transaction.contactId);
      if (!contact) throw new Error("Kontak transaksi pembayaran tidak ditemukan.");
      if (transaction.status === PAYMENT_GATEWAY_STATUS.PAID) {
        return { transaction, contact: this.hydrateContact(contact), alreadyProcessed: true };
      }

      const now = new Date().toISOString();
      const serviceScheduleBeforePayment = contact.hotspotReactivationAt || null;
      const serviceScheduleEnabledBeforePayment = parseBoolean(contact.hotspotReactivationEnabled, false);
      if (!contact.paymentMonths || typeof contact.paymentMonths !== "object") contact.paymentMonths = {};
      for (const period of transaction.periods) {
        const previousPayment = contact.paymentMonths[period] || {};
        contact.paymentMonths[period] = {
          ...previousPayment,
          status: PAYMENT_STATUS.PAID,
          paidDate: now,
          paymentType: PAYMENT_TYPES.FULL_PAID,
          paidAmount: Math.max(0, Math.floor(Number(contact.monthlyPaymentAmount) || 0)),
          previousPaidAmount: this.getPaymentPaidAmount(previousPayment, contact.monthlyPaymentAmount),
          transactionId: transaction.orderId,
          paymentProvider: "midtrans",
        };
      }

      const { year, month } = getBillingPeriodParts(new Date(), this.getTimezone());
      const currentKey = makeBillingPeriodKey(year, month);
      if (contact.paymentMonths[currentKey]?.status === PAYMENT_STATUS.PAID) {
        contact.paymentStatus = PAYMENT_STATUS.PAID;
        contact.paymentDate = now;
        contact.paymentType = PAYMENT_TYPES.FULL_PAID;
      }
      contact.updatedAt = now;

      transaction.status = PAYMENT_GATEWAY_STATUS.PAID;
      transaction.gatewayStatus = String(gatewayData.transaction_status || "settlement");
      transaction.transactionId = sanitizeInput(String(gatewayData.transaction_id || "")) || null;
      transaction.paymentMethod = sanitizeInput(String(gatewayData.payment_type || "")) || null;
      transaction.paidAt = gatewayData.settlement_time || gatewayData.transaction_time || now;
      transaction.error = null;
      transaction.updatedAt = now;

      const arrearsPolicy = contact.subscriptionChangedByArrears
        ? this.applyArrearsSubscriptionPolicy(contact)
        : { remindersAdded: 0, remindersRemoved: 0 };
      const automaticRenewalResumed = this.resumeAutomaticRenewalIfArrearsSettled(contact, { at: now });
      const serviceSchedule = transaction.periods.includes(currentKey)
        ? this.advanceServiceScheduleAfterPayment(contact, {
            at: now,
            previousSchedule: serviceScheduleBeforePayment,
          })
        : { changed: false, activeFrom: null, activeUntil: null };
      if (serviceSchedule.activeUntil) {
        transaction.serviceScheduleBeforePayment = serviceScheduleBeforePayment;
        transaction.serviceScheduleEnabledBeforePayment = serviceScheduleEnabledBeforePayment;
        transaction.serviceScheduleAfterPayment = serviceSchedule.activeUntil;
      }
      const remindersChanged = arrearsPolicy.remindersAdded + arrearsPolicy.remindersRemoved
        + (automaticRenewalResumed ? this.restoreBillingReminderAfterActivePeriod(contact) : 0)
        + (serviceSchedule.changed ? this.syncRecurringReminderSchedule(contact) : 0)
        + this.updateContactReminderMessages(contact);
      await this.withDatabaseWrite(() => this.sequelize.transaction(async (databaseTransaction) => {
        const options = { transaction: databaseTransaction };
        await this.saveContacts(options);
        await this.savePaymentGatewayTransactions(options);
        if (remindersChanged) await this.saveReminders(options);
      }));
      return { transaction, contact: this.hydrateContact(contact), alreadyProcessed: false };
    });
  }

  async refundMidtransPayment(orderId, gatewayData = {}, options = {}) {
    return this.withDataMutation(async () => {
      const transaction = this.getPaymentGatewayTransaction(orderId);
      if (!transaction) throw new Error("Transaksi pembayaran tidak ditemukan.");
      const receivedAmount = Number(gatewayData.gross_amount);
      if (!Number.isFinite(receivedAmount) || Math.round(receivedAmount) !== transaction.amount) {
        const error = new Error("Nominal refund Midtrans tidak sesuai dengan transaksi.");
        error.statusCode = 400;
        throw error;
      }
      const contact = this.getContact(transaction.contactId);
      if (!contact) throw new Error("Kontak transaksi pembayaran tidak ditemukan.");
      const partial = Boolean(options.partial);
      const refundStatus = partial
        ? PAYMENT_GATEWAY_STATUS.PARTIALLY_REFUNDED
        : PAYMENT_GATEWAY_STATUS.REFUNDED;
      const refundAmount = Math.max(
        0,
        Number(gatewayData.refund_amount) || (partial ? 0 : transaction.amount)
      );
      const sameRefundAlreadyProcessed = transaction.status === refundStatus
        && (!partial || Number(transaction.refundAmount || 0) === refundAmount);
      if (sameRefundAlreadyProcessed) {
        return { transaction, contact: this.hydrateContact(contact), alreadyProcessed: true, reversedPeriods: [] };
      }

      const now = new Date().toISOString();
      const reversedPeriods = [];
      if (!contact.paymentMonths || typeof contact.paymentMonths !== "object") contact.paymentMonths = {};
      for (const period of partial ? [] : transaction.periods || []) {
        const payment = contact.paymentMonths[period];
        if (payment?.paymentProvider !== "midtrans" || String(payment.transactionId) !== String(orderId)) {
          continue;
        }
        const restoredPaidAmount = Math.max(0, Math.floor(Number(payment.previousPaidAmount) || 0));
        contact.paymentMonths[period] = {
          ...payment,
          status: PAYMENT_STATUS.UNPAID,
          paidDate: null,
          paymentType: restoredPaidAmount > 0 ? PAYMENT_TYPES.ARREARS_ONLY : null,
          paidAmount: restoredPaidAmount,
          refundedAt: gatewayData.refund_time || now,
          refundedTransactionId: transaction.transactionId || null,
        };
        reversedPeriods.push(period);
      }

      const currentKey = getBillingPeriodKey(new Date(), this.getTimezone());
      const currentPayment = contact.paymentMonths[currentKey];
      contact.paymentStatus = currentPayment?.status === PAYMENT_STATUS.PAID
        ? PAYMENT_STATUS.PAID
        : PAYMENT_STATUS.UNPAID;
      contact.paymentDate = contact.paymentStatus === PAYMENT_STATUS.PAID
        ? currentPayment?.paidDate || null
        : null;
      contact.paymentType = contact.paymentStatus === PAYMENT_STATUS.PAID
        ? currentPayment?.paymentType || null
        : null;
      const serviceScheduleReverted = !partial
        && reversedPeriods.includes(currentKey)
        && Boolean(transaction.serviceScheduleAfterPayment)
        && contact.hotspotReactivationAt === transaction.serviceScheduleAfterPayment;
      if (serviceScheduleReverted) {
        contact.hotspotReactivationAt = transaction.serviceScheduleBeforePayment || null;
        contact.hotspotReactivationEnabled = parseBoolean(
          transaction.serviceScheduleEnabledBeforePayment,
          false
        );
      }
      contact.updatedAt = now;

      transaction.status = refundStatus;
      transaction.gatewayStatus = sanitizeInput(String(
        gatewayData.transaction_status || (partial ? "partial_refund" : "refund")
      ));
      transaction.transactionId = sanitizeInput(String(gatewayData.transaction_id || transaction.transactionId || "")) || null;
      transaction.paymentMethod = sanitizeInput(String(gatewayData.payment_type || transaction.paymentMethod || "")) || null;
      transaction.refundedAt = gatewayData.refund_time || now;
      transaction.refundAmount = refundAmount;
      transaction.manualReviewRequired = partial;
      transaction.error = null;
      transaction.updatedAt = now;

      const arrearsPolicy = contact.subscriptionChangedByArrears
        ? this.applyArrearsSubscriptionPolicy(contact)
        : { remindersAdded: 0, remindersRemoved: 0 };
      const remindersChanged = arrearsPolicy.remindersAdded + arrearsPolicy.remindersRemoved
        + (serviceScheduleReverted ? this.syncRecurringReminderSchedule(contact) : 0)
        + this.updateContactReminderMessages(contact);
      await this.withDatabaseWrite(() => this.sequelize.transaction(async (databaseTransaction) => {
        const options = { transaction: databaseTransaction };
        await this.saveContacts(options);
        await this.savePaymentGatewayTransactions(options);
        if (remindersChanged) await this.saveReminders(options);
      }));
      return {
        transaction,
        contact: this.hydrateContact(contact),
        alreadyProcessed: false,
        reversedPeriods,
      };
    });
  }

  normalizeOptionalDate(value) {
    const raw = sanitizeInput(String(value || ""));
    if (!raw) return null;
    const date = parseDateTimeInput(raw, this.getTimezone()) || new Date(raw);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }

  normalizeContactHotspotFields(payload, current = {}) {
    const subscriptionType = normalizeSubscriptionType(
      payload.subscriptionType !== undefined ? payload.subscriptionType : current.subscriptionType
    );
    let enabled = payload.hotspotReactivationEnabled !== undefined
      ? parseBoolean(payload.hotspotReactivationEnabled, false)
      : parseBoolean(current.hotspotReactivationEnabled, false);
    if (subscriptionType === SUBSCRIPTION_TYPES.ONE_TIME) enabled = false;
    const username = payload.mikrotikUsername !== undefined
      ? sanitizeInput(String(payload.mikrotikUsername || ""))
      : sanitizeInput(String(current.mikrotikUsername || ""));
    const profile = payload.mikrotikProfile !== undefined
      ? sanitizeInput(String(payload.mikrotikProfile || ""))
      : sanitizeInput(String(current.mikrotikProfile || ""));
    const password = payload.mikrotikPassword !== undefined
      ? sanitizeInput(String(payload.mikrotikPassword || ""))
      : sanitizeInput(String(current.mikrotikPassword || ""));
    const reactivationAt = payload.hotspotReactivationAt !== undefined
      ? this.normalizeOptionalDate(payload.hotspotReactivationAt)
      : this.normalizeOptionalDate(current.hotspotReactivationAt);

    if (enabled && !username) throw new Error("Username hotspot wajib diisi untuk reaktivasi.");
    if (enabled && !profile) throw new Error("Profile hotspot wajib diisi untuk reaktivasi.");
    if (enabled && !reactivationAt) throw new Error("Jadwal reaktivasi wajib diisi.");
    if (!enabled && reactivationAt && !username) throw new Error("Username hotspot wajib diisi untuk jadwal nonaktif hotspot.");

    return {
      mikrotikUsername: username,
      mikrotikProfile: profile,
      mikrotikPassword: password,
      hotspotReactivationEnabled: enabled,
      hotspotReactivationAt: reactivationAt,
    };
  }

  async saveAll() {
    await this.withDataMutation(() => (
      this.withDatabaseWrite(() => (
        this.sequelize.transaction(async (transaction) => {
          const options = { transaction };
          await this.saveContacts(options);
          await this.savePelanggan(options);
          await this.saveCustomerAccounts(options);
          await this.savePaymentGatewayTransactions(options);
          await this.saveReminders(options);
          await this.saveSentReminders(options);
          await this.saveRoles(options);
          await this.saveSettings(options);
        })
      ))
    ));
  }

  async createBackup(now = new Date()) {
    if (process.env.DATABASE_URL) {
      throw new Error("Backup database otomatis hanya tersedia untuk database SQLite lokal.");
    }

    const timestamp = now.toISOString().replace(/[:.]/g, "-");
    const backupDir = path.join(CONFIG.DB_PATH, "backups", timestamp);
    await fs.mkdir(backupDir, { recursive: true });

    try {
      await this.withDatabaseWrite(async () => {
        const backupFile = path.join(backupDir, path.basename(CONFIG.DB_STORAGE));
        const escapedBackupFile = backupFile.replace(/'/g, "''");
        await this.sequelize.query(`VACUUM INTO '${escapedBackupFile}'`);
        await fs.chmod(backupFile, 0o600);
      });
    } catch (error) {
      await fs.rm(backupDir, { recursive: true, force: true });
      throw error;
    }

    const deletedCount = await this.cleanupDatabaseBackups(now);

    this.activityLog.push("info", "storage", "Backup database dibuat", { backupDir, deletedCount });
    return { backupDir, deletedCount };
  }

  async cleanupDatabaseBackups(now = new Date()) {
    const backupRoot = path.join(CONFIG.DB_PATH, "backups");
    const retentionDays = Math.max(1, CONFIG.DB_BACKUP_RETENTION_DAYS);
    const cutoffTime = now.getTime() - (retentionDays * 24 * 60 * 60 * 1000);
    const entries = await fs.readdir(backupRoot, { withFileTypes: true }).catch((error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    let deletedCount = 0;

    for (const entry of entries) {
      if (!entry.isDirectory() || !/^\d{4}-\d{2}-\d{2}T/.test(entry.name)) continue;

      const backupDir = path.join(backupRoot, entry.name);
      const stats = await fs.stat(backupDir);
      if (stats.mtimeMs > cutoffTime) continue;

      await fs.rm(backupDir, { recursive: true, force: true });
      deletedCount += 1;
    }

    return deletedCount;
  }

  getSortedContacts() {
    return Array.from(this.contacts.values())
      .map((contact) => this.hydrateContact(contact))
      .sort((a, b) => a.name.localeCompare(b.name, "id-ID"));
  }

  getContacts() {
    return Array.from(this.contacts.values()).map((contact) => this.hydrateContact(contact));
  }

  getSortedReminders() {
    return Array.from(this.reminders.values())
      .map((reminder) => this.hydrateReminder(reminder))
      .sort((a, b) => new Date(a.reminderDateTime) - new Date(b.reminderDateTime));
  }

  getSentReminders() {
    return Array.from(this.sentReminders.values())
      .map((reminder) => this.hydrateReminder(reminder))
      .sort((a, b) => new Date(b.sentAt || b.reminderDateTime) - new Date(a.sentAt || a.reminderDateTime));
  }

  getDashboardSummary() {
    const contacts = this.getSortedContacts();
    const reminders = this.getSortedReminders();
    const sentReminders = this.getSentReminders();
    const paid = contacts.filter((contact) => contact.paymentStatus === PAYMENT_STATUS.PAID).length;
    const unpaid = contacts.length - paid;
    const debt = contacts.filter((contact) => contact.hasDebt).length;
    return {
      contacts: contacts.length,
      pelanggan: this.pelanggan.size,
      reminders: reminders.length,
      sentReminders: sentReminders.length,
      paidContacts: paid,
      unpaidContacts: unpaid,
      debtContacts: debt,
      adminRecipients: this.getAdminRecipients().length,
      nextReminderAt: reminders[0]?.reminderDateTime || null,
    };
  }

  findContactByPhone(phoneNumber) {
    return Array.from(this.contacts.values()).find((contact) => contact.phoneNumber === phoneNumber);
  }

  hasContactPhone(phoneNumber, excludeId = null) {
    return Array.from(this.contacts.values()).some(
      (contact) => contact.phoneNumber === phoneNumber && String(contact.id) !== String(excludeId)
    );
  }

  hasContactHotspotUsername(username, excludeId = null) {
    const normalized = sanitizeInput(String(username || "")).toLowerCase();
    if (!normalized) return false;
    return Array.from(this.contacts.values()).some((contact) => (
      sanitizeInput(String(contact.mikrotikUsername || "")).toLowerCase() === normalized
      && String(contact.id) !== String(excludeId)
    ));
  }

  getContact(id) {
    return this.contacts.get(String(id)) || null;
  }

  getReminder(id) {
    return this.reminders.get(String(id)) || null;
  }

  getResolvedReminderContact(reminder) {
    if (reminder?.contactId) {
      const contact = this.getContact(reminder.contactId);
      if (contact) return contact;
    }

    if (reminder?.phoneNumber) {
      return this.findContactByPhone(reminder.phoneNumber) || null;
    }

    return null;
  }

  hydrateReminder(reminder) {
    const contact = this.getResolvedReminderContact(reminder);
    return {
      ...reminder,
      contactId: reminder.contactId || contact?.id || null,
      contactName: contact?.name || reminder.contactName || null,
      phoneNumber: contact?.phoneNumber || reminder.phoneNumber || null,
      subscriptionType: normalizeSubscriptionType(contact?.subscriptionType || reminder.subscriptionType),
      paymentAmount: Math.max(0, Number(reminder.paymentAmount ?? contact?.monthlyPaymentAmount) || 0),
    };
  }

  buildDueDateInfo(contact) {
    if (!isRecurringSubscription(contact)) {
      return {
        dueDate: null,
        dueStatus: "NOT_APPLICABLE",
      };
    }

    const timeZone = this.getTimezone();
    const { year, month } = getBillingPeriodParts(new Date(), timeZone);
    const activePeriodKey = makeBillingPeriodKey(year, month);
    const isContactReminder = (reminder) => {
      if (String(reminder.contactId || "") === String(contact.id)) return true;
      return reminder.phoneNumber && reminder.phoneNumber === contact.phoneNumber;
    };

    const activeReminders = Array.from(this.reminders.values())
      .filter(isContactReminder)
      .map((reminder) => ({ ...reminder, active: true }));
    const reminders = [
      ...activeReminders,
      ...Array.from(this.sentReminders.values())
        .filter(isContactReminder)
        .map((reminder) => ({ ...reminder, active: false })),
    ];

    const parsedReminders = reminders
      .map((reminder) => ({
        ...reminder,
        reminderDate: new Date(reminder.reminderDateTime),
      }))
      .filter((reminder) => !Number.isNaN(reminder.reminderDate.getTime()))
      .map((reminder) => ({
        ...reminder,
        timestamp: reminder.reminderDate.getTime(),
        periodKey: getBillingPeriodKey(reminder.reminderDate, timeZone),
      }))
      .sort((a, b) => a.timestamp - b.timestamp);

    const nowTs = Date.now();
    const activePeriodReminders = parsedReminders.filter((reminder) => reminder.periodKey === activePeriodKey);
    const nextInActivePeriod = activePeriodReminders.find((reminder) => reminder.timestamp >= nowTs) || null;
    const latestInActivePeriod = activePeriodReminders.length > 0
      ? activePeriodReminders[activePeriodReminders.length - 1]
      : null;
    const nextActiveReminder = parsedReminders.find(
      (reminder) => reminder.active && reminder.timestamp >= nowTs
    ) || null;
    const dueReminder = nextInActivePeriod || latestInActivePeriod || nextActiveReminder;
    const dueDate = dueReminder ? new Date(dueReminder.timestamp).toISOString() : null;

    let dueStatus = "NOT_SCHEDULED";
    if (dueDate) {
      const periodPaymentStatus = String(
        contact.paymentMonths?.[dueReminder.periodKey]?.status
          || (dueReminder.periodKey === activePeriodKey ? contact.paymentStatus : PAYMENT_STATUS.UNPAID)
      ).toUpperCase();
      if (periodPaymentStatus === PAYMENT_STATUS.PAID) {
        dueStatus = "PAID";
      } else if (dueReminder.timestamp < nowTs) {
        dueStatus = "OVERDUE";
      } else {
        dueStatus = "UPCOMING";
      }
    }

    return {
      dueDate,
      dueStatus,
    };
  }

  getPaymentPaidAmount(payment, monthlyAmount) {
    const normalizedMonthlyAmount = Math.max(0, Math.floor(Number(monthlyAmount) || 0));
    if (!payment || normalizedMonthlyAmount <= 0) return 0;
    if (String(payment.status || "").toUpperCase() === PAYMENT_STATUS.PAID) {
      return normalizedMonthlyAmount;
    }
    return Math.min(
      normalizedMonthlyAmount,
      Math.max(0, Math.floor(Number(payment.paidAmount) || 0))
    );
  }

  getPaymentRemainingAmount(payment, monthlyAmount) {
    const normalizedMonthlyAmount = Math.max(0, Math.floor(Number(monthlyAmount) || 0));
    return Math.max(0, normalizedMonthlyAmount - this.getPaymentPaidAmount(payment, normalizedMonthlyAmount));
  }

  buildDebtInfo(contact, options = {}) {
    const timeZone = this.getTimezone();
    const activePeriod = getBillingPeriodParts(new Date(), timeZone);
    const { year, month } = options.year && options.month
      ? { year: options.year, month: options.month }
      : activePeriod;
    const currentKey = makeBillingPeriodKey(year, month);
    const paymentMonths = contact.paymentMonths || {};
    const monthlyAmount = Math.max(0, Math.floor(Number(contact.monthlyPaymentAmount) || 0));
    const currentPayment = paymentMonths[currentKey] || null;
    const currentType = String(currentPayment?.paymentType || contact.paymentType || "").toUpperCase();
    const previous = getPreviousBillingPeriod(year, month);
    const startPeriod = getContactBillingStartPeriod(contact, timeZone);
    const billingPausedForArrears = isRecurringSubscription(contact)
      && parseBoolean(contact.billingPausedForArrears, false);
    const pausedAfterPeriod = /^\d{4}-\d{2}$/.test(String(contact.billingPausedAfterPeriod || ""))
      ? {
          year: Number(String(contact.billingPausedAfterPeriod).slice(0, 4)),
          month: Number(String(contact.billingPausedAfterPeriod).slice(5, 7)),
        }
      : previous;
    const debtEndPeriod = billingPausedForArrears
      ? (compareBillingPeriods(pausedAfterPeriod, { year, month }) <= 0
        ? pausedAfterPeriod
        : { year, month })
      : previous;
    const billingPeriods = isRecurringSubscription(contact)
      ? listBillingPeriods(startPeriod, debtEndPeriod)
      : (compareBillingPeriods(startPeriod, previous) <= 0 ? [startPeriod] : []);
    const legacyOneTimePeriods = !isRecurringSubscription(contact)
      ? Object.entries(paymentMonths)
        .filter(([key, payment]) => /^\d{4}-\d{2}$/.test(key)
          && payment?.status !== PAYMENT_STATUS.PAID
          && key !== currentKey)
        .map(([key, payment]) => ({
          year: Number(key.slice(0, 4)),
          month: Number(key.slice(5, 7)),
          status: payment?.status || PAYMENT_STATUS.UNPAID,
        }))
      : [];
    const debtPeriods = currentType === PAYMENT_TYPES.FULL_PAID
      ? []
      : [...billingPeriods, ...legacyOneTimePeriods]
        .filter((period, index, all) => all.findIndex((candidate) => candidate.year === period.year && candidate.month === period.month) === index)
        .filter((period) => {
          const key = makeBillingPeriodKey(period.year, period.month);
          return paymentMonths[key]?.status !== PAYMENT_STATUS.PAID;
        })
        .map((period) => {
          const key = makeBillingPeriodKey(period.year, period.month);
          const payment = paymentMonths[key] || null;
          const paidAmount = this.getPaymentPaidAmount(payment, monthlyAmount);
          return {
            key,
            label: formatBillingPeriodLabel(period.year, period.month),
            status: payment?.status || PAYMENT_STATUS.UNPAID,
            paidAmount,
            remainingAmount: this.getPaymentRemainingAmount(payment, monthlyAmount),
          };
        });
    const hasDebt = debtPeriods.length > 0;
    const firstDebt = debtPeriods[0] || null;
    const debtAmount = debtPeriods.reduce((total, period) => total + period.remainingAmount, 0);
    const subscriptionEnded = isOneTimeSubscriptionEnded(contact, { year, month }, timeZone);
    const isActivePeriod = year === activePeriod.year && month === activePeriod.month;
    const effectivePaymentStatus = subscriptionEnded || billingPausedForArrears
      ? PAYMENT_STATUS.PAID
      : (currentPayment?.status || (isActivePeriod
        ? String(contact.paymentStatus || PAYMENT_STATUS.UNPAID).toUpperCase()
        : PAYMENT_STATUS.UNPAID));

    return {
      hasDebt,
      debtPeriod: firstDebt?.key || makeBillingPeriodKey(previous.year, previous.month),
      debtPeriodLabel: firstDebt?.label || formatBillingPeriodLabel(previous.year, previous.month),
      debtPeriods,
      debtCount: debtPeriods.length,
      debtAmount,
      debtNote: hasDebt
        ? `Sisa tunggakan ${this.formatPaymentAmount(debtAmount)} untuk ${debtPeriods.map((period) => period.label).join(", ")}.`
        : "",
      previousPaymentStatus: paymentMonths[makeBillingPeriodKey(previous.year, previous.month)]?.status || PAYMENT_STATUS.UNPAID,
      paymentStatus: effectivePaymentStatus,
      currentPaymentStatus: effectivePaymentStatus,
      subscriptionType: normalizeSubscriptionType(contact.subscriptionType),
      subscriptionActive: !subscriptionEnded && !billingPausedForArrears,
      billingPausedForArrears,
      billingPausedAfterPeriod: billingPausedForArrears
        ? makeBillingPeriodKey(debtEndPeriod.year, debtEndPeriod.month)
        : null,
    };
  }

  pauseBillingForArrears(contact, options = {}) {
    if (!contact || !isRecurringSubscription(contact)) return false;
    const alreadyPaused = parseBoolean(contact.billingPausedForArrears, false)
      && /^\d{4}-\d{2}$/.test(String(contact.billingPausedAfterPeriod || ""));
    const requestedAt = options.at ? new Date(options.at) : new Date();
    const now = Number.isNaN(requestedAt.getTime()) ? new Date() : requestedAt;
    const { year, month } = getBillingPeriodParts(now, this.getTimezone());
    const currentKey = makeBillingPeriodKey(year, month);
    if (!contact.paymentMonths || typeof contact.paymentMonths !== "object") {
      contact.paymentMonths = {};
    }
    const currentPayment = contact.paymentMonths[currentKey] || {};
    if (!alreadyPaused && currentPayment.status !== PAYMENT_STATUS.PAID) {
      contact.paymentMonths[currentKey] = {
        ...currentPayment,
        status: PAYMENT_STATUS.UNPAID,
        paidDate: null,
        paymentType: currentPayment.paymentType || null,
        paidAmount: this.getPaymentPaidAmount(currentPayment, contact.monthlyPaymentAmount),
      };
    }
    contact.billingPausedForArrears = true;
    if (!alreadyPaused) contact.billingPausedAfterPeriod = currentKey;
    contact.hotspotSuspendedForArrears = options.suspended !== false;
    contact.hotspotManualActivationWithArrears = false;
    contact.paymentStatus = PAYMENT_STATUS.PAID;
    contact.paymentDate = null;
    contact.paymentType = null;
    return true;
  }

  buildActivePeriodPurchase(contact, payload = {}) {
    if (!contact || !isRecurringSubscription(contact)) {
      throw new Error("Pembelian masa aktif hanya tersedia untuk pelanggan bulanan.");
    }
    if (!parseBoolean(contact.billingPausedForArrears, false) || !this.buildDebtInfo(contact).hasDebt) {
      throw new Error("Pembelian masa aktif hanya tersedia saat perpanjangan dijeda karena tunggakan.");
    }

    const amount = Math.max(0, Math.floor(Number(contact.monthlyPaymentAmount) || 0));
    if (amount <= 0) {
      throw new Error("Nominal bulanan harus diisi sebelum membeli masa aktif.");
    }

    const purchasedAt = new Date(payload.purchasedAt || new Date());
    const activeFrom = new Date(payload.activeFrom || purchasedAt);
    const activeUntil = new Date(payload.activeUntil || addMonthsSafely(activeFrom, 1, this.getTimezone()));
    if ([purchasedAt, activeFrom, activeUntil].some((value) => Number.isNaN(value.getTime()))) {
      throw new Error("Waktu pembelian masa aktif tidak valid.");
    }
    if (activeUntil.getTime() <= activeFrom.getTime()) {
      throw new Error("Batas masa aktif harus setelah waktu mulai.");
    }

    const id = sanitizeInput(String(payload.id || ""));
    if (!id) throw new Error("ID transaksi pembelian masa aktif tidak valid.");

    return {
      id,
      paymentType: PAYMENT_TYPES.ACTIVE_PERIOD,
      status: PAYMENT_STATUS.PAID,
      amount,
      purchasedAt: purchasedAt.toISOString(),
      activeFrom: activeFrom.toISOString(),
      activeUntil: activeUntil.toISOString(),
      paymentProvider: sanitizeInput(String(payload.paymentProvider || "manual")) || "manual",
    };
  }

  applyActivePeriodPurchase(contact, payload = {}) {
    const purchase = this.buildActivePeriodPurchase(contact, payload);
    if (!Array.isArray(contact.activePeriodPurchases)) contact.activePeriodPurchases = [];
    const existing = contact.activePeriodPurchases.find((item) => String(item.id) === purchase.id);
    if (existing) return { purchase: existing, added: false };

    contact.activePeriodPurchases.push(purchase);
    contact.billingPausedForArrears = true;
    contact.hotspotSuspendedForArrears = false;
    contact.hotspotManualActivationWithArrears = true;
    contact.hotspotReactivationEnabled = false;
    contact.hotspotReactivationAt = purchase.activeUntil;
    contact.paymentStatus = PAYMENT_STATUS.PAID;
    contact.paymentDate = null;
    contact.paymentType = null;
    contact.updatedAt = purchase.purchasedAt;
    return { purchase, added: true };
  }

  async recordActivePeriodPurchase(contactId, payload = {}) {
    return this.withDataMutation(async () => {
      const contact = this.getContact(contactId);
      if (!contact) throw new Error("Kontak tidak ditemukan.");
      const result = this.applyActivePeriodPurchase(contact, payload);
      if (result.added) {
        const reminderResult = this.syncActivePeriodExpiryReminder(contact, result.purchase);
        await this.savePaymentAndReminderChanges(reminderResult.changed);
      }
      return {
        ...result,
        contact: this.hydrateContact(contact),
      };
    });
  }

  resumeAutomaticRenewalIfArrearsSettled(contact, options = {}) {
    if (!contact || !parseBoolean(contact.billingPausedForArrears, false)) return false;
    if (this.buildDebtInfo(contact).hasDebt) return false;

    const requestedAt = options.at ? new Date(options.at) : new Date();
    const now = Number.isNaN(requestedAt.getTime()) ? new Date() : requestedAt;
    const currentSchedule = new Date(contact.hotspotReactivationAt || 0);
    const hasFutureSchedule = Number.isFinite(currentSchedule.getTime())
      && currentSchedule.getTime() > now.getTime();
    const pausedAfterKey = String(contact.billingPausedAfterPeriod || "");
    if (/^\d{4}-\d{2}$/.test(pausedAfterKey)) {
      const pausedAfter = {
        year: Number(pausedAfterKey.slice(0, 4)),
        month: Number(pausedAfterKey.slice(5, 7)),
      };
      const firstPausedPeriod = addBillingMonths(pausedAfter, 1);
      const currentPeriod = getBillingPeriodParts(now, this.getTimezone());
      const monthlyAmount = Math.max(0, Math.floor(Number(contact.monthlyPaymentAmount) || 0));
      if (!contact.paymentMonths || typeof contact.paymentMonths !== "object") {
        contact.paymentMonths = {};
      }
      for (const period of listBillingPeriods(firstPausedPeriod, currentPeriod)) {
        const key = makeBillingPeriodKey(period.year, period.month);
        contact.paymentMonths[key] = {
          ...(contact.paymentMonths[key] || {}),
          status: PAYMENT_STATUS.PAID,
          paidDate: null,
          paymentType: null,
          paidAmount: monthlyAmount,
          billingPaused: true,
        };
      }
    }

    contact.billingPausedForArrears = false;
    contact.billingPausedAfterPeriod = null;
    contact.hotspotManualActivationWithArrears = false;
    contact.hotspotReactivationEnabled = isRecurringSubscription(contact);
    if (isRecurringSubscription(contact) && !hasFutureSchedule) {
      contact.hotspotReactivationAt = addMonthsSafely(now, 1, this.getTimezone()).toISOString();
    }
    contact.paymentStatus = PAYMENT_STATUS.PAID;
    contact.paymentDate = contact.paymentDate || now.toISOString();
    contact.paymentType = contact.paymentType || PAYMENT_TYPES.FULL_PAID;
    return true;
  }

  applyArrearsSubscriptionPolicy(contact, options = {}) {
    const updatedAt = options.updatedAt || new Date().toISOString();
    if (!parseBoolean(contact.subscriptionChangedByArrears, false)) {
      return { changed: false, converted: false, restored: false, remindersAdded: 0, remindersRemoved: 0 };
    }

    contact.subscriptionType = SUBSCRIPTION_TYPES.RECURRING;
    contact.subscriptionChangedByArrears = false;
    contact.arrearsSubscriptionDebtPeriods = [];
    contact.hotspotReactivationEnabled = true;
    if (!contact.hotspotReactivationAt) {
      contact.hotspotReactivationAt = this.getNextServiceScheduleFromRegistration(contact);
    } else {
      let nextSchedule = new Date(contact.hotspotReactivationAt);
      const now = new Date();
      while (!Number.isNaN(nextSchedule.getTime()) && nextSchedule.getTime() <= now.getTime()) {
        nextSchedule = addMonthsSafely(nextSchedule, 1, this.getTimezone());
      }
      contact.hotspotReactivationAt = Number.isNaN(nextSchedule.getTime())
        ? this.getNextServiceScheduleFromRegistration(contact)
        : nextSchedule.toISOString();
    }

    const currentKey = getBillingPeriodKey(new Date(), this.getTimezone());
    const currentPayment = contact.paymentMonths?.[currentKey];
    contact.paymentStatus = currentPayment?.status === PAYMENT_STATUS.PAID
      ? PAYMENT_STATUS.PAID
      : PAYMENT_STATUS.UNPAID;
    contact.paymentDate = contact.paymentStatus === PAYMENT_STATUS.PAID
      ? currentPayment?.paidDate || null
      : null;
    contact.paymentType = contact.paymentStatus === PAYMENT_STATUS.PAID
      ? currentPayment?.paymentType || null
      : null;
    contact.updatedAt = updatedAt;
    const reminderResult = this.ensureRecurringReminder(contact);

    this.activityLog.push("info", "billing", `Pelanggan ${contact.name || contact.id} dipulihkan sebagai pelanggan bulanan; tunggakan tetap tercatat`, {
      contactId: contact.id,
      hotspotSchedule: contact.hotspotReactivationAt || null,
    });

    return {
      changed: true,
      converted: false,
      restored: true,
      remindersAdded: reminderResult.created ? 1 : 0,
      remindersRemoved: 0,
    };
  }

  usesRecurringBilling(contact) {
    return isRecurringSubscription(contact) || parseBoolean(contact.subscriptionChangedByArrears, false);
  }

  enforceArrearsSubscriptionPolicy(options = {}) {
    let converted = 0;
    let restored = 0;
    let remindersAdded = 0;
    let remindersRemoved = 0;

    for (const contact of this.contacts.values()) {
      const result = this.applyArrearsSubscriptionPolicy(contact, options);
      if (!result.changed) continue;
      if (result.converted) converted += 1;
      if (result.restored) restored += 1;
      remindersAdded += result.remindersAdded;
      remindersRemoved += result.remindersRemoved;
    }

    return { changed: converted + restored, converted, restored, remindersAdded, remindersRemoved };
  }

  hydrateContact(contact) {
    const debtInfo = this.buildDebtInfo(contact);
    const dueDateInfo = this.buildDueDateInfo(contact);
    return {
      ...contact,
      ...debtInfo,
      ...dueDateInfo,
    };
  }

  toPublicContact(contact) {
    const result = this.hydrateContact(contact);
    delete result.mikrotikPassword;
    delete result.hotspotProvisioningPrevious;
    delete result.subscriptionChangedByArrears;
    delete result.arrearsSubscriptionDebtPeriods;
    if (result.hotspotNotificationPending) {
      result.hotspotNotificationPending = {
        attempts: result.hotspotNotificationPending.attempts || 0,
        nextAttemptAt: result.hotspotNotificationPending.nextAttemptAt || null,
        lastError: result.hotspotNotificationPending.lastError || null,
      };
    }
    return result;
  }

  async normalizeReminderRelations() {
    let hasChanges = false;

    for (const reminder of this.reminders.values()) {
      const contact = this.getResolvedReminderContact(reminder);
      if (contact) {
        if (String(reminder.contactId || "") !== String(contact.id)) {
          reminder.contactId = String(contact.id);
          hasChanges = true;
        }
        if (reminder.phoneNumber !== contact.phoneNumber) {
          reminder.phoneNumber = contact.phoneNumber;
          hasChanges = true;
        }
        if (reminder.contactName !== contact.name) {
          reminder.contactName = contact.name;
          hasChanges = true;
        }
      }
    }

    if (hasChanges) {
      await this.saveReminders();
    }
  }

  async removeNonRecurringReminders() {
    const removed = [];
    for (const [id, reminder] of this.reminders.entries()) {
      const contact = this.getResolvedReminderContact(reminder);
      if (contact && !isRecurringSubscription(contact)) {
        this.reminders.delete(id);
        removed.push({ id, contactId: contact.id });
      }
    }
    if (removed.length > 0) {
      await this.saveReminders();
      this.activityLog.push("info", "storage", `${removed.length} reminder pelanggan sekali berlangganan dihapus dari jadwal aktif`, {
        removed,
      });
    }
    return removed.length;
  }

  async repairMissingRecurringReminders() {
    let created = 0;
    for (const contact of this.contacts.values()) {
      if (this.ensureRecurringReminder(contact).created) created += 1;
    }
    if (created > 0) {
      await this.saveReminders();
      this.activityLog.push("info", "storage", `${created} reminder pelanggan bulanan dibuat ulang dari jadwal layanan`);
    }
    return created;
  }

  removeRemindersForContact(contactId) {
    let removed = 0;
    for (const [id, reminder] of this.reminders.entries()) {
      const contact = this.getResolvedReminderContact(reminder);
      if (String(contact?.id || reminder.contactId || "") === String(contactId)) {
        this.reminders.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  async migrateReminderPaymentAmounts() {
    let contactsChanged = false;
    let remindersChanged = false;
    for (const reminder of this.reminders.values()) {
      const amount = Number(reminder.paymentAmount) || parsePaymentAmountFromMessage(reminder.message);
      const contact = this.getResolvedReminderContact(reminder);
      if (amount > 0 && !Number(reminder.paymentAmount)) {
        reminder.paymentAmount = amount;
        remindersChanged = true;
      }
      if (contact && amount > 0 && !Number(contact.monthlyPaymentAmount)) {
        contact.monthlyPaymentAmount = amount;
        contactsChanged = true;
      }
      if (contact && this.rewriteReminderPaymentMessage(reminder, contact)) {
        remindersChanged = true;
      }
    }
    for (const reminder of this.sentReminders.values()) {
      const amount = Number(reminder.paymentAmount) || parsePaymentAmountFromMessage(reminder.message);
      const contact = this.getResolvedReminderContact(reminder);
      if (amount > 0 && !Number(reminder.paymentAmount)) {
        reminder.paymentAmount = amount;
        remindersChanged = true;
      }
      if (contact && amount > 0 && !Number(contact.monthlyPaymentAmount)) {
        contact.monthlyPaymentAmount = amount;
        contactsChanged = true;
      }
    }
    if (contactsChanged) await this.saveContacts();
    if (remindersChanged) await this.saveReminders();
    if (remindersChanged) await this.saveSentReminders();
  }

  async migrateReminderVariableTemplates() {
    return this.withDataMutation(async () => {
      const settings = this.getSettings();
      if (Number(settings.reminderVariableTemplateMigrationVersion) >= 2) {
        return { migrated: 0, version: 2 };
      }

      let migrated = 0;
      for (const reminder of this.reminders.values()) {
        if (String(reminder.templateName || "").toLowerCase() !== "penagihan.txt") continue;
        reminder.messageSource = DEFAULT_REMINDER_MESSAGE_TEMPLATE;
        reminder.message = DEFAULT_REMINDER_MESSAGE_TEMPLATE;
        const contact = this.getResolvedReminderContact(reminder);
        if (contact) this.rewriteReminderPaymentMessage(reminder, contact);
        migrated += 1;
      }

      this.settings = {
        ...settings,
        reminderVariableTemplateMigrationVersion: 2,
      };
      await this.withDatabaseWrite(() => this.sequelize.transaction(async (transaction) => {
        const options = { transaction };
        if (migrated > 0) await this.saveReminders(options);
        await this.saveSettings(options);
      }));
      this.activityLog.push("info", "storage", `Template variabel diterapkan ke ${migrated} reminder aktif`, {
        migration: "reminder-variable-template-v2",
        migrated,
      });
      return { migrated, version: 2 };
    });
  }

  async migrateFormalNotificationTemplates() {
    return this.withDataMutation(async () => {
      const settings = this.getSettings();
      if (Number(settings.notificationTemplateCopyMigrationVersion) >= 1) {
        return { migrated: false, remindersUpdated: 0, version: 1 };
      }

      const templateKeys = [
        "apDownMessageTemplate",
        "customerAccountMessageTemplate",
        "billingReminderMessageTemplate",
        "paymentMessageTemplateArrearsOnly",
        "paymentMessageTemplateCurrentOnly",
        "paymentMessageTemplateFullPaid",
        "paymentMessageTemplateActivePeriod",
        "activePeriodReminderMessageTemplate",
      ];
      this.settings = { ...settings };
      for (const key of templateKeys) {
        this.settings[key] = DEFAULT_SETTINGS[key];
      }
      this.settings.notificationTemplateCopyMigrationVersion = 1;

      let remindersUpdated = 0;
      for (const reminder of this.reminders.values()) {
        const templateName = String(reminder.templateName || "").toLowerCase();
        let messageTemplate = null;
        if (templateName === "penagihan.txt") {
          messageTemplate = DEFAULT_REMINDER_MESSAGE_TEMPLATE;
        } else if (reminder.reminderKind === REMINDER_KINDS.ACTIVE_PERIOD_EXPIRY) {
          messageTemplate = DEFAULT_SETTINGS.activePeriodReminderMessageTemplate;
        }
        if (!messageTemplate) continue;

        reminder.message = messageTemplate;
        reminder.messageSource = messageTemplate;
        const contact = this.getResolvedReminderContact(reminder);
        if (contact) this.rewriteReminderPaymentMessage(reminder, contact);
        remindersUpdated += 1;
      }

      await this.withDatabaseWrite(() => this.sequelize.transaction(async (transaction) => {
        const options = { transaction };
        await this.saveSettings(options);
        if (remindersUpdated > 0) await this.saveReminders(options);
      }));
      this.activityLog.push("info", "storage", "Template notifikasi diperbarui dengan bahasa formal", {
        migration: "formal-notification-copy-v1",
        remindersUpdated,
      });
      return { migrated: true, remindersUpdated, version: 1 };
    });
  }

  async migrateExistingPaidServiceSchedules(options = {}) {
    return this.withDataMutation(async () => {
      const settings = this.getSettings();
      if (Number(settings.prepaidScheduleMigrationVersion) >= 1) {
        return {
          migrated: false,
          contactsUpdated: 0,
          remindersUpdated: 0,
          alreadyAligned: 0,
          skipped: 0,
          version: 1,
        };
      }

      let contactsUpdated = 0;
      let remindersUpdated = 0;
      let alreadyAligned = 0;
      let skipped = 0;
      const migrationTime = options.now ? new Date(options.now) : new Date();
      const updatedAt = Number.isNaN(migrationTime.getTime())
        ? new Date().toISOString()
        : migrationTime.toISOString();

      for (const contact of this.contacts.values()) {
        if (!isRecurringSubscription(contact)
          || parseBoolean(contact.billingPausedForArrears, false)) {
          skipped += 1;
          continue;
        }

        const latestPaidEntry = Object.entries(contact.paymentMonths || {})
          .filter(([period, payment]) => (
            /^\d{4}-\d{2}$/.test(period)
            && payment?.status === PAYMENT_STATUS.PAID
            && payment?.paidDate
            && !parseBoolean(payment?.billingPaused, false)
            && !Number.isNaN(new Date(payment.paidDate).getTime())
          ))
          .sort((left, right) => {
            const paidDateDifference = new Date(right[1].paidDate).getTime()
              - new Date(left[1].paidDate).getTime();
            return paidDateDifference || right[0].localeCompare(left[0]);
          })[0] || null;
        if (!latestPaidEntry || this.buildDebtInfo(contact).hasDebt) {
          skipped += 1;
          continue;
        }

        const [paymentPeriodKey, payment] = latestPaidEntry;
        const paymentPeriod = {
          year: Number(paymentPeriodKey.slice(0, 4)),
          month: Number(paymentPeriodKey.slice(5, 7)),
        };
        const currentSchedule = new Date(contact.hotspotReactivationAt || 0);
        const scheduleIsValid = Number.isFinite(currentSchedule.getTime());
        const schedulePeriod = scheduleIsValid
          ? getBillingPeriodParts(currentSchedule, this.getTimezone())
          : null;
        const scheduleAlreadyAdvanced = schedulePeriod
          && compareBillingPeriods(schedulePeriod, paymentPeriod) > 0;

        if (scheduleAlreadyAdvanced) {
          alreadyAligned += 1;
        } else {
          const serviceSchedule = this.advanceServiceScheduleAfterPayment(contact, {
            at: payment.paidDate,
            previousSchedule: scheduleIsValid ? currentSchedule : null,
            paymentPeriodKey,
          });
          if (serviceSchedule.changed) {
            contact.updatedAt = updatedAt;
            contactsUpdated += 1;
          }
        }
        remindersUpdated += this.syncRecurringReminderSchedule(contact);
      }

      this.settings = {
        ...settings,
        prepaidScheduleMigrationVersion: 1,
      };
      await this.withDatabaseWrite(() => this.sequelize.transaction(async (transaction) => {
        const saveOptions = { transaction };
        if (contactsUpdated > 0) await this.saveContacts(saveOptions);
        if (remindersUpdated > 0) await this.saveReminders(saveOptions);
        await this.saveSettings(saveOptions);
      }));
      this.activityLog.push("info", "storage", "Jadwal pembayaran lama diselaraskan dengan sistem masa aktif", {
        migration: "prepaid-schedule-v1",
        contactsUpdated,
        remindersUpdated,
        alreadyAligned,
        skipped,
      });
      return {
        migrated: true,
        contactsUpdated,
        remindersUpdated,
        alreadyAligned,
        skipped,
        version: 1,
      };
    });
  }

  formatPaymentAmount(amount) {
    return new Intl.NumberFormat("id-ID", {
      style: "currency",
      currency: "IDR",
      maximumFractionDigits: 0,
    }).format(Math.max(0, Number(amount) || 0));
  }

  rewriteReminderPaymentMessage(reminder, contact) {
    const monthlyAmount = Math.max(0, Number(contact.monthlyPaymentAmount ?? reminder.paymentAmount) || 0);
    const sourceMessage = sanitizeMultilineText(reminder.messageSource || reminder.message);
    if (!sourceMessage) return false;
    let changed = false;
    if (!reminder.messageSource) {
      reminder.messageSource = sourceMessage;
      changed = true;
    }
    if (Number(reminder.paymentAmount) !== monthlyAmount) {
      reminder.paymentAmount = monthlyAmount;
      changed = true;
    }

    const scheduledAt = new Date(reminder.reminderDateTime || Date.now());
    const periodDate = Number.isNaN(scheduledAt.getTime()) ? new Date() : scheduledAt;
    const debtInfo = this.buildDebtInfo(
      contact,
      getBillingPeriodParts(periodDate, this.getTimezone())
    );
    const debtCount = Math.max(0, Number(debtInfo.debtCount) || 0);
    const currentPaid = String(debtInfo.currentPaymentStatus || contact.paymentStatus || "UNPAID").toUpperCase() === PAYMENT_STATUS.PAID;
    const totalPeriods = (currentPaid ? 0 : 1) + debtCount;
    const currentAmount = currentPaid ? 0 : monthlyAmount;
    const totalAmount = currentAmount + Math.max(0, Number(debtInfo.debtAmount) || 0);
    const hasBillingVariables = /{{\s*(?:monthlyAmount|currentAmount|debtAmount|totalAmount|debtCount|debtPeriods|totalPeriods)\s*}}/i.test(sourceMessage);

    let nextMessage;
    if (totalPeriods <= 0) {
      nextMessage = `*Status pembayaran: LUNAS*\n\nSeluruh tagihan ${contact.name || "pelanggan"} sudah lunas. Reminder ini akan dilewati otomatis selama status pembayaran tetap lunas.`;
    } else if (monthlyAmount <= 0) {
      nextMessage = sourceMessage;
    } else if (hasBillingVariables) {
      nextMessage = sourceMessage;
    } else {
      const totalText = this.formatPaymentAmount(totalAmount);
      const amountPattern = /Rp\s*[0-9][0-9.]*(?:,[0-9]{1,2})?/i;
      nextMessage = amountPattern.test(sourceMessage)
        ? sourceMessage.replace(amountPattern, totalText).replace(/(Rp\s*[0-9][0-9.]*(?:,[0-9]{1,2})?)(?=[A-Za-z])/gi, "$1 ")
        : `${sourceMessage.trim()}\n\n*Total tagihan: ${totalText}*`;
    }

    if (nextMessage === reminder.message) return changed;
    reminder.message = nextMessage;
    return true;
  }

  updateContactReminderMessages(contact) {
    let changed = 0;
    for (const reminder of this.reminders.values()) {
      const resolvedContact = this.getResolvedReminderContact(reminder);
      if (!resolvedContact || String(resolvedContact.id) !== String(contact.id)) continue;
      if (this.rewriteReminderPaymentMessage(reminder, contact)) {
        changed += 1;
      }
    }
    return changed;
  }

  advanceServiceScheduleAfterPayment(contact, options = {}) {
    if (!contact || !isRecurringSubscription(contact)) {
      return { changed: false, activeFrom: null, activeUntil: null };
    }

    const requestedAt = options.at ? new Date(options.at) : new Date();
    const paidAt = Number.isNaN(requestedAt.getTime()) ? new Date() : requestedAt;
    const currentPeriod = options.paymentPeriodKey
      || getBillingPeriodKey(paidAt, this.getTimezone());
    const currentPayment = contact.paymentMonths?.[currentPeriod];
    if (currentPayment?.status !== PAYMENT_STATUS.PAID || this.buildDebtInfo(contact).hasDebt) {
      return { changed: false, activeFrom: null, activeUntil: null };
    }

    const previousValue = options.previousSchedule !== undefined
      ? options.previousSchedule
      : contact.hotspotReactivationAt;
    const previousSchedule = new Date(previousValue || 0);
    const activeFrom = Number.isFinite(previousSchedule.getTime())
      && previousSchedule.getTime() > paidAt.getTime()
      ? previousSchedule
      : paidAt;
    const activeUntil = addMonthsSafely(activeFrom, 1, this.getTimezone());
    const nextSchedule = activeUntil.toISOString();
    const changed = contact.hotspotReactivationAt !== nextSchedule
      || !parseBoolean(contact.hotspotReactivationEnabled, false);

    contact.hotspotReactivationAt = nextSchedule;
    contact.hotspotReactivationEnabled = true;
    contact.hotspotManualActivationWithArrears = false;
    return {
      changed,
      activeFrom: activeFrom.toISOString(),
      activeUntil: nextSchedule,
    };
  }

  syncRecurringReminderSchedule(contact) {
    if (!contact || !isRecurringSubscription(contact)) return 0;
    const reminderDateTime = this.normalizeOptionalDate(contact.hotspotReactivationAt);
    if (!reminderDateTime) return 0;

    const ensured = this.ensureRecurringReminder(contact);
    const reminder = ensured.reminder;
    if (!reminder || reminder.processingAt) return ensured.created ? 1 : 0;

    let changed = ensured.created ? 1 : 0;
    if (reminder.reminderDateTime !== reminderDateTime) {
      reminder.reminderDateTime = reminderDateTime;
      changed += 1;
    }
    if (reminder.reminderKind === REMINDER_KINDS.ACTIVE_PERIOD_EXPIRY) {
      reminder.reminderKind = REMINDER_KINDS.BILLING;
      reminder.message = DEFAULT_REMINDER_MESSAGE_TEMPLATE;
      reminder.messageSource = DEFAULT_REMINDER_MESSAGE_TEMPLATE;
      reminder.templateName = "Penagihan.txt";
      delete reminder.activePeriodUntil;
      changed += 1;
    }
    for (const field of [
      "nextDeliveryAttemptAt",
      "deliveryAttemptedAt",
      "lastDeliveryAttemptAt",
      "lastDeliveryError",
      "deliveryAttempts",
    ]) {
      if (!Object.hasOwn(reminder, field)) continue;
      delete reminder[field];
      changed += 1;
    }
    if (this.rewriteReminderPaymentMessage(reminder, contact)) changed += 1;
    return changed;
  }

  async syncActiveRemindersWithTemplates(templates) {
    const latestTemplates = new Map(
      (Array.isArray(templates) ? templates : [])
        .map((template) => [
          sanitizeInput(String(template?.name || "")).toLowerCase(),
          sanitizeMultilineText(template?.content),
        ])
        .filter(([name, content]) => name && content)
    );

    if (latestTemplates.size === 0) {
      return { matched: 0, updated: 0 };
    }

    return this.withDataMutation(async () => {
      let matched = 0;
      let updated = 0;

      for (const reminder of this.reminders.values()) {
        const templateName = sanitizeInput(String(reminder.templateName || "")).toLowerCase();
        const latestContent = latestTemplates.get(templateName);
        if (!latestContent) continue;
        matched += 1;

        if (sanitizeMultilineText(reminder.messageSource || reminder.message) === latestContent) continue;

        reminder.messageSource = latestContent;
        reminder.message = latestContent;
        const contact = this.getResolvedReminderContact(reminder);
        if (contact) this.rewriteReminderPaymentMessage(reminder, contact);
        updated += 1;
      }

      if (updated > 0) {
        await this.saveReminders();
        this.activityLog.push("info", "templates", `${updated} jadwal reminder disinkronkan dengan template terbaru`, {
          templates: Array.from(latestTemplates.keys()),
          matched,
          updated,
        });
      }

      return { matched, updated };
    });
  }

  ensureRecurringReminder(contact) {
    if (!contact || !isRecurringSubscription(contact)) {
      return { created: false, reminder: null };
    }

    const existing = Array.from(this.reminders.values()).find((reminder) => {
      const resolvedContact = this.getResolvedReminderContact(reminder);
      return String(resolvedContact?.id || reminder.contactId || "") === String(contact.id);
    });
    if (existing) return { created: false, reminder: existing };

    const reminderDateTime = this.normalizeOptionalDate(
      contact.hotspotReactivationAt || this.getNextServiceScheduleFromRegistration(contact)
    );
    if (!reminderDateTime) return { created: false, reminder: null };

    const reminder = {
      id: generateId(),
      contactId: String(contact.id),
      contactName: contact.name,
      phoneNumber: contact.phoneNumber,
      paymentAmount: Math.max(0, Number(contact.monthlyPaymentAmount) || 0),
      reminderDateTime,
      reminderKind: REMINDER_KINDS.BILLING,
      message: DEFAULT_REMINDER_MESSAGE_TEMPLATE,
      messageSource: DEFAULT_REMINDER_MESSAGE_TEMPLATE,
      templateName: "Penagihan.txt",
      createdAt: new Date().toISOString(),
    };
    this.rewriteReminderPaymentMessage(reminder, contact);
    this.reminders.set(String(reminder.id), reminder);
    this.activityLog.push("info", "billing", `Jadwal reminder otomatis dibuat untuk ${contact.name || contact.id}`, {
      contactId: contact.id,
      reminderId: reminder.id,
      reminderDateTime,
    });
    return { created: true, reminder };
  }

  syncActivePeriodExpiryReminder(contact, purchase) {
    if (!contact || !purchase?.activeUntil) return { changed: 0, created: false, reminder: null };

    const activeUntil = new Date(purchase.activeUntil);
    const purchasedAt = new Date(purchase.purchasedAt || Date.now());
    if (Number.isNaN(activeUntil.getTime()) || Number.isNaN(purchasedAt.getTime())) {
      throw new Error("Jadwal reminder masa aktif tidak valid.");
    }

    const graceDays = sanitizePositiveInteger(
      this.getSettings().hotspotIsolationGraceDays,
      DEFAULT_SETTINGS.hotspotIsolationGraceDays,
      0,
      30
    );
    const warningAt = addDaysSafely(activeUntil, -graceDays, this.getTimezone());
    const reminderDate = warningAt.getTime() < purchasedAt.getTime() ? purchasedAt : warningAt;
    const existing = Array.from(this.reminders.values()).find((reminder) => {
      const resolvedContact = this.getResolvedReminderContact(reminder);
      return String(resolvedContact?.id || reminder.contactId || "") === String(contact.id)
        && !reminder.processingAt;
    });
    const created = !existing;
    const reminder = existing || {
      id: generateId(),
      contactId: String(contact.id),
      contactName: contact.name,
      phoneNumber: contact.phoneNumber,
      createdAt: new Date().toISOString(),
    };
    const messageTemplate = sanitizeMultilineText(this.getSettings().activePeriodReminderMessageTemplate)
      || DEFAULT_SETTINGS.activePeriodReminderMessageTemplate;

    Object.assign(reminder, {
      contactId: String(contact.id),
      contactName: contact.name,
      phoneNumber: contact.phoneNumber,
      paymentAmount: Math.max(0, Number(contact.monthlyPaymentAmount) || 0),
      reminderDateTime: reminderDate.toISOString(),
      reminderKind: REMINDER_KINDS.ACTIVE_PERIOD_EXPIRY,
      activePeriodUntil: activeUntil.toISOString(),
      message: messageTemplate,
      messageSource: messageTemplate,
      templateName: "MasaAktifSementara",
    });
    delete reminder.nextDeliveryAttemptAt;
    delete reminder.deliveryAttemptedAt;
    delete reminder.lastDeliveryAttemptAt;
    delete reminder.lastDeliveryError;
    delete reminder.deliveryAttempts;
    this.rewriteReminderPaymentMessage(reminder, contact);
    this.reminders.set(String(reminder.id), reminder);
    this.activityLog.push("info", "billing", `Reminder masa aktif diselaraskan untuk ${contact.name || contact.id}`, {
      contactId: contact.id,
      reminderId: reminder.id,
      reminderDateTime: reminder.reminderDateTime,
      activeUntil: reminder.activePeriodUntil,
      created,
    });
    return { changed: 1, created, reminder };
  }

  restoreBillingReminderAfterActivePeriod(contact) {
    if (!contact) return 0;
    const reminderDateTime = this.normalizeOptionalDate(
      contact.hotspotReactivationAt || this.getNextServiceScheduleFromRegistration(contact)
    );
    if (!reminderDateTime) return 0;

    let changed = 0;
    for (const reminder of this.reminders.values()) {
      const resolvedContact = this.getResolvedReminderContact(reminder);
      if (String(resolvedContact?.id || reminder.contactId || "") !== String(contact.id)) continue;
      if (reminder.reminderKind !== REMINDER_KINDS.ACTIVE_PERIOD_EXPIRY) continue;

      reminder.reminderDateTime = reminderDateTime;
      reminder.reminderKind = REMINDER_KINDS.BILLING;
      reminder.message = DEFAULT_REMINDER_MESSAGE_TEMPLATE;
      reminder.messageSource = DEFAULT_REMINDER_MESSAGE_TEMPLATE;
      reminder.templateName = "Penagihan.txt";
      delete reminder.activePeriodUntil;
      delete reminder.nextDeliveryAttemptAt;
      delete reminder.deliveryAttemptedAt;
      delete reminder.lastDeliveryAttemptAt;
      delete reminder.lastDeliveryError;
      delete reminder.deliveryAttempts;
      this.rewriteReminderPaymentMessage(reminder, contact);
      changed += 1;
    }
    return changed;
  }

  async savePaymentAndReminderChanges(remindersChanged) {
    if (!remindersChanged) {
      await this.saveContacts();
      return;
    }

    await this.withDatabaseWrite(() => this.sequelize.transaction(async (transaction) => {
      const options = { transaction };
      await this.saveContacts(options);
      await this.saveReminders(options);
    }));
  }

  async addContact(payload) {
    return this.withDataMutation(async () => {
      const name = sanitizeInput(payload.name);
      const phoneNumber = normalizePhoneNumber(payload.phoneNumber);
      const linkedApHost = sanitizeInput(String(payload.linkedApHost || ""));
      const subscriptionType = normalizeSubscriptionType(payload.subscriptionType);
      const hotspotFields = this.normalizeContactHotspotFields({ ...payload, subscriptionType });

      if (!name) throw new Error("Nama kontak wajib diisi.");
      if (!isValidPhoneNumber(phoneNumber)) throw new Error("Nomor kontak harus berformat 628xxx.");
      if (this.hasContactPhone(phoneNumber)) throw new Error("Nomor kontak sudah digunakan.");

      const now = new Date().toISOString();
      const initialServiceSchedule = addMonthsSafely(now, 1, this.getTimezone()).toISOString();
      const { year: initialYear, month: initialMonth } = getBillingPeriodParts(new Date(now), this.getTimezone());
      const initialPeriod = makeBillingPeriodKey(initialYear, initialMonth);
      const contact = {
        id: generateId(),
        name,
        phoneNumber,
        monthlyPaymentAmount: sanitizePositiveInteger(payload.monthlyPaymentAmount, 0, 0, 1_000_000_000),
        monthlyPaymentAmountCustomized: payload.monthlyPaymentAmount !== undefined,
        subscriptionType,
        subscriptionChangedByArrears: false,
        arrearsSubscriptionDebtPeriods: [],
        billingPausedForArrears: false,
        billingPausedAfterPeriod: null,
        hotspotSuspendedForArrears: false,
        hotspotManualActivationWithArrears: false,
        activePeriodPurchases: [],
        // Akun baru diasumsikan sudah melunasi biaya awal pada periode pendaftaran.
        paymentStatus: PAYMENT_STATUS.PAID,
        paymentDate: now,
        paymentType: PAYMENT_TYPES.CURRENT_ONLY,
        paymentMonths: {
          [initialPeriod]: { status: PAYMENT_STATUS.PAID, paidDate: now, paymentType: PAYMENT_TYPES.CURRENT_ONLY },
        },
        linkedApHost,
        ...hotspotFields,
        hotspotReactivationEnabled: subscriptionType === SUBSCRIPTION_TYPES.RECURRING,
        hotspotReactivationAt: initialServiceSchedule,
        hotspotLastReactivatedAt: this.normalizeOptionalDate(payload.hotspotLastReactivatedAt),
        hotspotLastDeactivatedAt: this.normalizeOptionalDate(payload.hotspotLastDeactivatedAt),
        createdAt: now,
        updatedAt: now,
      };
      this.applyProfileMonthlyAmount(contact);

      this.contacts.set(contact.id, contact);
      const reminderCreated = this.ensureRecurringReminder(contact).created;
      await this.synchronizeCustomerPortalAccounts({ save: false });
      if (this.sequelize) {
        await this.withDatabaseWrite(() => this.sequelize.transaction(async (transaction) => {
          const options = { transaction };
          await this.saveContacts(options);
          await this.savePelanggan(options);
          await this.saveCustomerAccounts(options);
          if (reminderCreated) await this.saveReminders(options);
        }));
      } else {
        await this.saveContacts();
        if (reminderCreated) await this.saveReminders();
      }
      return contact;
    });
  }

  async upsertPelangganFromRegistration(payload) {
    return this.withDataMutation(async () => {
      const name = sanitizeInput(payload.name);
      const phoneNumber = normalizePhoneNumber(payload.phoneNumber);
      const username = sanitizeInput(payload.username);
      const profile = sanitizeInput(payload.profile);
      const password = sanitizeInput(payload.password);

      if (!name) throw new Error("Nama pelanggan wajib diisi.");
      if (!username) throw new Error("Username hotspot wajib diisi.");
      if (!isValidPhoneNumber(phoneNumber)) throw new Error("Nomor pelanggan harus berformat 628xxx.");
      if (!profile) throw new Error("Profile hotspot wajib diisi.");
      if (!password) throw new Error("Password hotspot wajib diisi.");

      const provisioningStatus = normalizeHotspotProvisioningStatus(
        payload.hotspotProvisioningStatus,
        HOTSPOT_PROVISIONING_STATUS.ACTIVE
      );
      const provisioningError = provisioningStatus === HOTSPOT_PROVISIONING_STATUS.ACTIVE
        ? ""
        : sanitizeInput(String(payload.hotspotProvisioningError || ""));
      const hotspotLastCheckedAt = this.normalizeOptionalDate(payload.hotspotLastCheckedAt);
      const hotspotLastSyncedAt = this.normalizeOptionalDate(payload.hotspotLastSyncedAt);
      const provisioningOperation = normalizeHotspotProvisioningOperation(
        payload.hotspotProvisioningOperation,
        provisioningStatus === HOTSPOT_PROVISIONING_STATUS.ACTIVE
          ? HOTSPOT_PROVISIONING_OPERATION.NONE
          : HOTSPOT_PROVISIONING_OPERATION.CREATE
      );

      const now = new Date().toISOString();
      const initialServiceSchedule = addMonthsSafely(now, 1, this.getTimezone()).toISOString();
      const { year: initialYear, month: initialMonth } = getBillingPeriodParts(new Date(now), this.getTimezone());
      const initialPeriod = makeBillingPeriodKey(initialYear, initialMonth);
      let contact = this.findContactByPhone(phoneNumber);
      let remindersRemoved = 0;
      let reminderMessagesChanged = 0;
      const usernameOwner = this.pelanggan.get(username);
      if (usernameOwner
        && String(usernameOwner.contactId || "") !== String(contact?.id || "")
        && normalizePhoneNumber(usernameOwner.nomer) !== phoneNumber) {
        throw new Error(`Username hotspot "${username}" sudah terhubung ke pelanggan lain.`);
      }
      const linkedApHost = payload.linkedApHost !== undefined
        ? sanitizeInput(String(payload.linkedApHost || ""))
        : sanitizeInput(String(contact?.linkedApHost || ""));
      const hotspotFields = this.normalizeContactHotspotFields({
        ...payload,
        subscriptionType: normalizeSubscriptionType(payload.subscriptionType, contact?.subscriptionType),
        mikrotikUsername: username,
        mikrotikProfile: profile,
        mikrotikPassword: password,
      }, contact || {});

      if (!contact) {
        contact = {
          id: String(generateId()),
          name,
          phoneNumber,
          monthlyPaymentAmount: sanitizePositiveInteger(payload.monthlyPaymentAmount, 0, 0, 1_000_000_000),
          monthlyPaymentAmountCustomized: payload.monthlyPaymentAmount !== undefined,
          subscriptionType: normalizeSubscriptionType(payload.subscriptionType),
          subscriptionChangedByArrears: false,
          arrearsSubscriptionDebtPeriods: [],
          billingPausedForArrears: false,
          billingPausedAfterPeriod: null,
          hotspotSuspendedForArrears: false,
          hotspotManualActivationWithArrears: false,
          activePeriodPurchases: [],
          paymentStatus: PAYMENT_STATUS.PAID,
          paymentDate: now,
          paymentType: PAYMENT_TYPES.CURRENT_ONLY,
          paymentMonths: {
            [initialPeriod]: { status: PAYMENT_STATUS.PAID, paidDate: now, paymentType: PAYMENT_TYPES.CURRENT_ONLY },
          },
          linkedApHost,
          ...hotspotFields,
          hotspotReactivationEnabled: normalizeSubscriptionType(payload.subscriptionType) === SUBSCRIPTION_TYPES.RECURRING,
          hotspotReactivationAt: initialServiceSchedule,
          hotspotProvisioningStatus: provisioningStatus,
          hotspotProvisioningError: provisioningError,
          hotspotLastCheckedAt,
          hotspotLastSyncedAt,
          hotspotSendCredentials: parseBoolean(payload.sendCredentials, false),
          hotspotProvisioningOperation: provisioningOperation,
          hotspotProvisioningPrevious: null,
          hotspotLastReactivatedAt: null,
          hotspotLastDeactivatedAt: null,
          createdAt: now,
          updatedAt: now,
        };
        this.applyProfileMonthlyAmount(contact);
        this.contacts.set(contact.id, contact);
      } else {
        contact.name = name;
        const previousSubscriptionType = contact.subscriptionType;
        contact.subscriptionType = normalizeSubscriptionType(payload.subscriptionType, previousSubscriptionType);
        if (payload.subscriptionType !== undefined && contact.subscriptionType !== previousSubscriptionType) {
          contact.subscriptionChangedByArrears = false;
          contact.arrearsSubscriptionDebtPeriods = [];
          contact.billingPausedForArrears = false;
          contact.billingPausedAfterPeriod = null;
          contact.hotspotSuspendedForArrears = false;
          contact.hotspotManualActivationWithArrears = false;
        }
        if (!isRecurringSubscription(contact)) {
          remindersRemoved = this.removeRemindersForContact(contact.id);
        }
        contact.linkedApHost = linkedApHost;
        if (payload.monthlyPaymentAmount !== undefined) {
          contact.monthlyPaymentAmount = sanitizePositiveInteger(
            payload.monthlyPaymentAmount,
            Number(contact.monthlyPaymentAmount) || 0,
            0,
            1_000_000_000
          );
          contact.monthlyPaymentAmountCustomized = true;
        }
        Object.assign(contact, hotspotFields);
        if (!contact.hotspotReactivationAt) {
          contact.hotspotReactivationAt = this.getNextServiceScheduleFromRegistration(contact);
          contact.hotspotReactivationEnabled = isRecurringSubscription(contact);
        }
        if (this.applyProfileMonthlyAmount(contact)) {
          reminderMessagesChanged = this.updateContactReminderMessages(contact);
        }
        contact.hotspotProvisioningStatus = provisioningStatus;
        contact.hotspotProvisioningError = provisioningError;
        contact.hotspotLastCheckedAt = hotspotLastCheckedAt;
        contact.hotspotLastSyncedAt = hotspotLastSyncedAt;
        contact.hotspotProvisioningOperation = provisioningOperation;
        contact.hotspotProvisioningPrevious = null;
        if (payload.sendCredentials !== undefined) {
          contact.hotspotSendCredentials = parseBoolean(payload.sendCredentials, false);
        }
        contact.updatedAt = now;
      }

      const previous = this.pelanggan.get(username) || {};
      for (const [storedUsername, storedPelanggan] of this.pelanggan.entries()) {
        if (storedUsername !== username
          && String(storedPelanggan.contactId || "") === String(contact.id)) {
          this.pelanggan.delete(storedUsername);
        }
      }
      const pelanggan = {
        ...previous,
        username,
        nama: name,
        nomer: phoneNumber,
        profile,
        password,
        contactId: contact.id,
        status: provisioningStatus === HOTSPOT_PROVISIONING_STATUS.ACTIVE
          ? "verified"
          : provisioningStatus.toLowerCase(),
        hotspotProvisioningStatus: provisioningStatus,
        hotspotProvisioningError: provisioningError,
        hotspotLastCheckedAt,
        hotspotLastSyncedAt,
        hotspotSendCredentials: parseBoolean(
          payload.sendCredentials,
          contact.hotspotSendCredentials
        ),
        tanggalDaftar: previous.tanggalDaftar || now,
        tanggalUpdate: now,
      };

      this.pelanggan.set(username, pelanggan);
      const reminderCreated = this.ensureRecurringReminder(contact).created;
      await this.synchronizeCustomerPortalAccounts({ save: false });
      await this.withDatabaseWrite(() => this.sequelize.transaction(async (transaction) => {
        const options = { transaction };
        await this.saveContacts(options);
        await this.savePelanggan(options);
        await this.saveCustomerAccounts(options);
        if (reminderCreated || remindersRemoved > 0 || reminderMessagesChanged > 0) {
          await this.saveReminders(options);
        }
      }));
      return { contact, pelanggan };
    });
  }

  async prepareHotspotRegistration(payload) {
    const name = sanitizeInput(payload.name);
    const phoneNumber = normalizePhoneNumber(payload.phoneNumber);
    const profile = sanitizeInput(payload.profile);
    const username = formatUsernameFromName(name);
    const password = phoneNumber.slice(-5);

    if (!name) throw new Error("Nama pelanggan wajib diisi.");
    if (!isValidPhoneNumber(phoneNumber)) throw new Error("Nomor pelanggan harus berformat 628xxx.");
    if (!profile) throw new Error("Profile hotspot wajib dipilih.");
    if (!username) throw new Error("Nama pelanggan tidak bisa dijadikan username hotspot.");

    return this.upsertPelangganFromRegistration({
      ...payload,
      name,
      phoneNumber,
      username,
      password,
      profile,
      hotspotProvisioningStatus: HOTSPOT_PROVISIONING_STATUS.PENDING,
      hotspotProvisioningOperation: HOTSPOT_PROVISIONING_OPERATION.CREATE,
      hotspotProvisioningError: "",
      hotspotLastCheckedAt: null,
      hotspotLastSyncedAt: null,
    });
  }

  async updateHotspotProvisioningStatus(contactId, status, options = {}) {
    return this.withDataMutation(async () => {
      const contact = this.getContact(contactId);
      if (!contact) throw new Error("Kontak tidak ditemukan.");

      const normalizedStatus = normalizeHotspotProvisioningStatus(status, "");
      if (!normalizedStatus) throw new Error("Status provisioning hotspot tidak valid.");

      const now = new Date().toISOString();
      const errorMessage = normalizedStatus === HOTSPOT_PROVISIONING_STATUS.ACTIVE
        ? ""
        : sanitizeInput(String(Object.hasOwn(options, "error")
          ? options.error
          : contact.hotspotProvisioningError || ""));
      const checkedAt = options.checkedAt !== undefined
        ? this.normalizeOptionalDate(options.checkedAt)
        : (normalizedStatus === HOTSPOT_PROVISIONING_STATUS.ACTIVE ? now : contact.hotspotLastCheckedAt || null);
      const syncedAt = options.syncedAt !== undefined
        ? this.normalizeOptionalDate(options.syncedAt)
        : (normalizedStatus === HOTSPOT_PROVISIONING_STATUS.ACTIVE ? now : contact.hotspotLastSyncedAt || null);

      contact.hotspotProvisioningStatus = normalizedStatus;
      contact.hotspotProvisioningError = errorMessage;
      contact.hotspotLastCheckedAt = checkedAt;
      contact.hotspotLastSyncedAt = syncedAt;
      if ([HOTSPOT_PROVISIONING_STATUS.ACTIVE, HOTSPOT_PROVISIONING_STATUS.DEACTIVATED, HOTSPOT_PROVISIONING_STATUS.DISABLED]
        .includes(normalizedStatus)) {
        contact.hotspotProvisioningOperation = HOTSPOT_PROVISIONING_OPERATION.NONE;
        contact.hotspotProvisioningPrevious = null;
      }
      contact.updatedAt = now;

      let pelanggan = this.pelanggan.get(contact.mikrotikUsername) || null;
      if (!pelanggan) {
        pelanggan = Array.from(this.pelanggan.values()).find(
          (item) => String(item.contactId || "") === String(contact.id)
        ) || null;
      }
      if (pelanggan) {
        pelanggan.status = normalizedStatus === HOTSPOT_PROVISIONING_STATUS.ACTIVE
          ? "verified"
          : normalizedStatus.toLowerCase();
        pelanggan.hotspotProvisioningStatus = normalizedStatus;
        pelanggan.hotspotProvisioningError = errorMessage;
        pelanggan.hotspotLastCheckedAt = checkedAt;
        pelanggan.hotspotLastSyncedAt = syncedAt;
        pelanggan.tanggalUpdate = now;
      }

      await this.withDatabaseWrite(() => this.sequelize.transaction(async (transaction) => {
        const saveOptions = { transaction };
        await this.saveContacts(saveOptions);
        await this.savePelanggan(saveOptions);
      }));
      return { contact, pelanggan };
    });
  }

  async prepareContactUpdate(id, payload) {
    return this.withDataMutation(async () => {
      const contact = this.getContact(id);
      if (!contact) throw new Error("Kontak tidak ditemukan.");
      const previousPhone = contact.phoneNumber;
      const previousHotspot = {
        username: sanitizeInput(String(contact.mikrotikUsername || "")),
        profile: sanitizeInput(String(contact.mikrotikProfile || "")),
        password: sanitizeInput(String(contact.mikrotikPassword || "")),
        phoneNumber: previousPhone,
      };

      const nextName = payload.name !== undefined ? sanitizeInput(payload.name) : contact.name;
      const nextPhone = payload.phoneNumber !== undefined ? normalizePhoneNumber(payload.phoneNumber) : contact.phoneNumber;
      const nextLinkedApHost = payload.linkedApHost !== undefined
        ? sanitizeInput(String(payload.linkedApHost || ""))
        : sanitizeInput(String(contact.linkedApHost || ""));
      const nextSubscriptionType = normalizeSubscriptionType(payload.subscriptionType, contact.subscriptionType);
      const nextUsername = payload.mikrotikUsername !== undefined
        ? sanitizeInput(String(payload.mikrotikUsername || ""))
        : previousHotspot.username;
      const nextProfile = payload.mikrotikProfile !== undefined
        ? sanitizeInput(String(payload.mikrotikProfile || ""))
        : previousHotspot.profile;
      const requestedPassword = payload.mikrotikPassword !== undefined
        ? sanitizeInput(String(payload.mikrotikPassword || ""))
        : previousHotspot.password;
      const nextPassword = requestedPassword || ((nextUsername && nextProfile) ? nextPhone.slice(-5) : "");

      if (!nextName) throw new Error("Nama kontak wajib diisi.");
      if (!isValidPhoneNumber(nextPhone)) throw new Error("Nomor kontak harus berformat 628xxx.");
      if (this.hasContactPhone(nextPhone, id)) throw new Error("Nomor kontak sudah digunakan.");
      if (nextUsername && this.hasContactHotspotUsername(nextUsername, id)) {
        throw new Error(`Username hotspot "${nextUsername}" sudah terhubung ke pelanggan lain.`);
      }
      if (Boolean(nextUsername) !== Boolean(nextProfile)) {
        throw new Error("Username dan profile hotspot harus diisi bersamaan.");
      }

      const hotspotFields = this.normalizeContactHotspotFields({
        ...payload,
        subscriptionType: nextSubscriptionType,
        mikrotikUsername: nextUsername,
        mikrotikProfile: nextProfile,
        mikrotikPassword: nextPassword,
      }, contact);
      const phoneChanged = nextPhone !== previousPhone;
      const hotspotChanged = previousHotspot.username !== nextUsername
        || previousHotspot.profile !== nextProfile
        || previousHotspot.password !== nextPassword
        || (phoneChanged && Boolean(previousHotspot.username || nextUsername));
      const unlinked = !nextUsername && !nextProfile;
      const subscriptionTypeChanged = nextSubscriptionType !== contact.subscriptionType;
      let hotspotSyncRequired = false;

      contact.name = nextName;
      contact.phoneNumber = nextPhone;
      contact.linkedApHost = nextLinkedApHost;
      contact.subscriptionType = nextSubscriptionType;
      if (payload.subscriptionType !== undefined && subscriptionTypeChanged) {
        contact.subscriptionChangedByArrears = false;
        contact.arrearsSubscriptionDebtPeriods = [];
        contact.billingPausedForArrears = false;
        contact.billingPausedAfterPeriod = null;
        contact.hotspotSuspendedForArrears = false;
        contact.hotspotManualActivationWithArrears = false;
      }
      if (!isRecurringSubscription(contact)) this.removeRemindersForContact(contact.id);
      if (payload.monthlyPaymentAmount !== undefined) {
        contact.monthlyPaymentAmount = sanitizePositiveInteger(
          payload.monthlyPaymentAmount,
          Number(contact.monthlyPaymentAmount) || 0,
          0,
          1_000_000_000
        );
        contact.monthlyPaymentAmountCustomized = true;
      }
      Object.assign(contact, hotspotFields);
      if (this.applyProfileMonthlyAmount(contact)) this.updateContactReminderMessages(contact);
      const now = new Date().toISOString();

      if (unlinked) {
        contact.mikrotikPassword = "";
        contact.hotspotProvisioningStatus = HOTSPOT_PROVISIONING_STATUS.NONE;
        contact.hotspotProvisioningError = "";
        contact.hotspotProvisioningOperation = HOTSPOT_PROVISIONING_OPERATION.NONE;
        contact.hotspotProvisioningPrevious = null;
        contact.hotspotLastCheckedAt = null;
        contact.hotspotLastSyncedAt = null;
        contact.hotspotSuspendedForArrears = false;
        contact.hotspotManualActivationWithArrears = false;
      } else if (hotspotChanged) {
        const currentOperation = normalizeHotspotProvisioningOperation(
          contact.hotspotProvisioningOperation,
          HOTSPOT_PROVISIONING_OPERATION.NONE
        );
        let provisioningPrevious = null;
        if (currentOperation === HOTSPOT_PROVISIONING_OPERATION.UPDATE
          && contact.hotspotProvisioningPrevious?.username) {
          provisioningPrevious = { ...contact.hotspotProvisioningPrevious };
        } else if (currentOperation !== HOTSPOT_PROVISIONING_OPERATION.CREATE
          && normalizeHotspotProvisioningStatus(contact.hotspotProvisioningStatus) === HOTSPOT_PROVISIONING_STATUS.ACTIVE
          && previousHotspot.username) {
          provisioningPrevious = previousHotspot;
        }

        contact.hotspotProvisioningStatus = HOTSPOT_PROVISIONING_STATUS.PENDING;
        contact.hotspotProvisioningError = "";
        contact.hotspotProvisioningOperation = provisioningPrevious
          ? HOTSPOT_PROVISIONING_OPERATION.UPDATE
          : HOTSPOT_PROVISIONING_OPERATION.CREATE;
        contact.hotspotProvisioningPrevious = provisioningPrevious;
        hotspotSyncRequired = true;
      }
      contact.updatedAt = now;

      this.ensureRecurringReminder(contact);

      for (const reminder of this.reminders.values()) {
        if (String(reminder.contactId) === String(id) || reminder.phoneNumber === previousPhone) {
          reminder.contactId = String(contact.id);
          reminder.phoneNumber = contact.phoneNumber;
          reminder.contactName = contact.name;
        }
      }

      let pelanggan = this.pelanggan.get(previousHotspot.username) || Array.from(this.pelanggan.values()).find(
        (item) => String(item.contactId || "") === String(contact.id)
      ) || null;
      for (const [storedUsername, storedPelanggan] of this.pelanggan.entries()) {
        if (String(storedPelanggan.contactId || "") === String(contact.id)) {
          this.pelanggan.delete(storedUsername);
        }
      }
      if (!unlinked) {
        pelanggan = {
          ...(pelanggan || {}),
          username: nextUsername,
          nama: nextName,
          nomer: nextPhone,
          profile: nextProfile,
          password: nextPassword,
          contactId: contact.id,
          status: contact.hotspotProvisioningStatus === HOTSPOT_PROVISIONING_STATUS.ACTIVE
            ? "verified"
            : String(contact.hotspotProvisioningStatus || HOTSPOT_PROVISIONING_STATUS.PENDING).toLowerCase(),
          hotspotProvisioningStatus: contact.hotspotProvisioningStatus,
          hotspotProvisioningError: contact.hotspotProvisioningError || "",
          hotspotLastCheckedAt: contact.hotspotLastCheckedAt || null,
          hotspotLastSyncedAt: contact.hotspotLastSyncedAt || null,
          tanggalDaftar: pelanggan?.tanggalDaftar || contact.createdAt || now,
          tanggalUpdate: now,
        };
        this.pelanggan.set(nextUsername, pelanggan);
      } else {
        pelanggan = null;
      }

      await this.synchronizeCustomerPortalAccounts({ save: false });
      await this.withDatabaseWrite(() => this.sequelize.transaction(async (transaction) => {
        const options = { transaction };
        await this.saveContacts(options);
        await this.savePelanggan(options);
        await this.saveCustomerAccounts(options);
        await this.saveReminders(options);
      }));
      return { contact, pelanggan, hotspotSyncRequired };
    });
  }

  async updateContact(id, payload) {
    const result = await this.prepareContactUpdate(id, payload);
    return result.contact;
  }

  async updateContactPaymentAmount(id, amount, options = {}) {
    return this.withDataMutation(async () => {
      const contact = this.getContact(id);
      if (!contact) throw new Error("Kontak tidak ditemukan.");
      if (options.useProfileDefault) {
        const profileAmount = this.getProfileMonthlyAmount(contact.mikrotikProfile);
        if (profileAmount === null) {
          throw new Error(`Tarif profile "${contact.mikrotikProfile || "MikroTik"}" belum diatur.`);
        }
        contact.monthlyPaymentAmount = profileAmount;
        contact.monthlyPaymentAmountCustomized = false;
      } else {
        const parsed = Number(amount);
        if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1_000_000_000) {
          throw new Error("Nominal pembayaran harus antara 0 sampai 1 miliar.");
        }
        contact.monthlyPaymentAmount = Math.floor(parsed);
        contact.monthlyPaymentAmountCustomized = true;
      }
      contact.updatedAt = new Date().toISOString();
      const remindersChanged = this.updateContactReminderMessages(contact);
      await this.savePaymentAndReminderChanges(remindersChanged);
      return this.hydrateContact(contact);
    });
  }

  getDueHotspotReactivationContacts(now = new Date()) {
    const nowTime = now.getTime();
    if (Number.isNaN(nowTime)) return [];

    const settings = this.getSettings();
    const isolationGraceDays = sanitizePositiveInteger(
      settings.hotspotIsolationGraceDays,
      DEFAULT_SETTINGS.hotspotIsolationGraceDays,
      0,
      30
    );

    return this.getSortedContacts().filter((contact) => {
      if (!contact.hotspotReactivationAt || !contact.mikrotikUsername) return false;
      if (contact.hotspotReactivationEnabled && !contact.mikrotikProfile) return false;
      const recurring = isRecurringSubscription(contact);
      const blockedByArrears = recurring
        && Boolean(contact.hotspotReactivationEnabled)
        && (Boolean(contact.hasDebt)
          || String(contact.currentPaymentStatus || contact.paymentStatus || PAYMENT_STATUS.UNPAID).toUpperCase() !== PAYMENT_STATUS.PAID);
      const dueDate = blockedByArrears
        ? addDaysSafely(contact.hotspotReactivationAt, isolationGraceDays, this.getTimezone())
        : new Date(contact.hotspotReactivationAt);
      const dueTime = dueDate.getTime();
      return Number.isFinite(dueTime) && dueTime <= nowTime;
    });
  }

  async reconcileHotspotStatuses(routerUsers, options = {}) {
    return this.withDataMutation(async () => {
      const observedAt = this.normalizeOptionalDate(options.observedAt) || new Date().toISOString();
      const checkedAt = this.normalizeOptionalDate(options.checkedAt) || new Date().toISOString();
      const observedTime = new Date(observedAt).getTime();
      const usersByUsername = new Map();

      for (const routerUser of Array.isArray(routerUsers) ? routerUsers : []) {
        const username = sanitizeInput(routerUser?.username || routerUser?.name || "");
        if (username) usersByUsername.set(username.toLowerCase(), routerUser);
      }

      const summary = {
        checked: 0,
        active: 0,
        missing: 0,
      changed: 0,
      deactivated: 0,
      disabled: 0,
        skipped: 0,
        updated: 0,
      };

      for (const contact of this.contacts.values()) {
        const username = sanitizeInput(contact.mikrotikUsername || "");
        const expectedProfile = sanitizeInput(contact.mikrotikProfile || "");
        if (!username) continue;
        if (!expectedProfile) {
          summary.skipped += 1;
          continue;
        }

        const currentStatus = normalizeHotspotProvisioningStatus(
          contact.hotspotProvisioningStatus,
          HOTSPOT_PROVISIONING_STATUS.ACTIVE
        );
        if ([
          HOTSPOT_PROVISIONING_STATUS.PENDING,
          HOTSPOT_PROVISIONING_STATUS.PROVISIONING,
          HOTSPOT_PROVISIONING_STATUS.FAILED,
        ].includes(currentStatus)) {
          summary.skipped += 1;
          continue;
        }

        const lastSyncedTime = new Date(contact.hotspotLastSyncedAt || 0).getTime();
        if (Number.isFinite(lastSyncedTime) && lastSyncedTime > observedTime) {
          summary.skipped += 1;
          continue;
        }

        const matchedRouterUser = usersByUsername.get(username.toLowerCase()) || null;
        const routerUser = matchedRouterUser?.source === "active" ? null : matchedRouterUser;
        let nextStatus;
        let nextError = "";

        if (!routerUser) {
          if (currentStatus === HOTSPOT_PROVISIONING_STATUS.DEACTIVATED) {
            nextStatus = HOTSPOT_PROVISIONING_STATUS.DEACTIVATED;
          } else {
            nextStatus = HOTSPOT_PROVISIONING_STATUS.MISSING;
            nextError = `Akun "${username}" tidak ditemukan di MikroTik saat sinkronisasi otomatis.`;
          }
        } else {
          const differences = [];
          const actualProfile = sanitizeInput(routerUser.profile || "");
          const expectedEmail = buildHotspotEmailFromPhone(contact.phoneNumber);
          const actualEmail = sanitizeInput(routerUser.email || "").toLowerCase();
          const disabled = routerUser.disabled === true
            || String(routerUser.disabled || "").toLowerCase() === "true";

          if (expectedProfile && actualProfile !== expectedProfile) differences.push("profile berbeda");
          if (expectedEmail && actualEmail !== expectedEmail.toLowerCase()) {
            differences.push("email pemilik berbeda");
          }
          if (disabled) differences.push("akun dinonaktifkan");

          if (differences.length > 0) {
            nextStatus = disabled && differences.length === 1
              ? HOTSPOT_PROVISIONING_STATUS.DISABLED
              : HOTSPOT_PROVISIONING_STATUS.CHANGED;
            nextError = nextStatus === HOTSPOT_PROVISIONING_STATUS.DISABLED
              ? "Akun hotspot dinonaktifkan di MikroTik."
              : `Data akun "${username}" di MikroTik berubah: ${differences.join(", ")}.`;
          } else {
            nextStatus = HOTSPOT_PROVISIONING_STATUS.ACTIVE;
          }
        }

        const previousError = sanitizeInput(contact.hotspotProvisioningError || "");
        const currentOperation = normalizeHotspotProvisioningOperation(
          contact.hotspotProvisioningOperation,
          HOTSPOT_PROVISIONING_OPERATION.NONE
        );
        let stateChanged = currentStatus !== nextStatus || previousError !== nextError;
        if (nextStatus === HOTSPOT_PROVISIONING_STATUS.ACTIVE
          && (currentOperation !== HOTSPOT_PROVISIONING_OPERATION.NONE
            || contact.hotspotProvisioningPrevious)) {
          stateChanged = true;
        }
        contact.hotspotProvisioningStatus = nextStatus;
        contact.hotspotProvisioningError = nextError;
        contact.hotspotLastCheckedAt = checkedAt;
        if (nextStatus === HOTSPOT_PROVISIONING_STATUS.ACTIVE) {
          contact.hotspotLastSyncedAt = checkedAt;
          contact.hotspotProvisioningOperation = HOTSPOT_PROVISIONING_OPERATION.NONE;
          contact.hotspotProvisioningPrevious = null;
        }

        const pelanggan = this.pelanggan.get(username) || Array.from(this.pelanggan.values()).find(
          (item) => String(item.contactId || "") === String(contact.id)
        ) || null;
        if (pelanggan) {
          const nextPelangganStatus = nextStatus === HOTSPOT_PROVISIONING_STATUS.ACTIVE
            ? "verified"
            : nextStatus.toLowerCase();
          if (pelanggan.status !== nextPelangganStatus
            || pelanggan.hotspotProvisioningStatus !== nextStatus
            || sanitizeInput(pelanggan.hotspotProvisioningError || "") !== nextError) {
            stateChanged = true;
          }
          pelanggan.status = nextPelangganStatus;
          pelanggan.hotspotProvisioningStatus = nextStatus;
          pelanggan.hotspotProvisioningError = nextError;
          pelanggan.hotspotLastCheckedAt = checkedAt;
          if (nextStatus === HOTSPOT_PROVISIONING_STATUS.ACTIVE) {
            pelanggan.hotspotLastSyncedAt = checkedAt;
          }
          if (stateChanged) pelanggan.tanggalUpdate = checkedAt;
        }
        if (stateChanged) contact.updatedAt = checkedAt;

        summary.checked += 1;
        summary.updated += stateChanged ? 1 : 0;
        if (nextStatus === HOTSPOT_PROVISIONING_STATUS.ACTIVE) summary.active += 1;
        if (nextStatus === HOTSPOT_PROVISIONING_STATUS.MISSING) summary.missing += 1;
        if (nextStatus === HOTSPOT_PROVISIONING_STATUS.CHANGED) summary.changed += 1;
        if (nextStatus === HOTSPOT_PROVISIONING_STATUS.DEACTIVATED) summary.deactivated += 1;
        if (nextStatus === HOTSPOT_PROVISIONING_STATUS.DISABLED) summary.disabled += 1;
      }

      if (summary.updated > 0) {
        await this.withDatabaseWrite(() => this.sequelize.transaction(async (transaction) => {
          const saveOptions = { transaction };
          await this.saveContacts(saveOptions);
          await this.savePelanggan(saveOptions);
        }));
      }

      return summary;
    });
  }

  async prepareHotspotLifecycleOperation(contactId, operation) {
    return this.withDataMutation(async () => {
      const contact = this.getContact(contactId);
      if (!contact) throw new Error("Kontak tidak ditemukan.");
      const normalizedOperation = normalizeHotspotProvisioningOperation(operation, "");
      if (![HOTSPOT_PROVISIONING_OPERATION.REACTIVATE, HOTSPOT_PROVISIONING_OPERATION.DEACTIVATE, HOTSPOT_PROVISIONING_OPERATION.ENABLE, HOTSPOT_PROVISIONING_OPERATION.DISABLE]
        .includes(normalizedOperation)) {
        throw new Error("Operasi lifecycle hotspot tidak valid.");
      }
      if (!contact.mikrotikUsername) throw new Error("Username hotspot wajib diisi.");
      if ([HOTSPOT_PROVISIONING_OPERATION.REACTIVATE, HOTSPOT_PROVISIONING_OPERATION.ENABLE].includes(normalizedOperation)
        && !contact.mikrotikProfile) {
        throw new Error("Profile hotspot wajib diisi untuk reaktivasi.");
      }

      const now = new Date().toISOString();
      contact.hotspotProvisioningStatus = HOTSPOT_PROVISIONING_STATUS.PENDING;
      contact.hotspotProvisioningOperation = normalizedOperation;
      contact.hotspotProvisioningError = "";
      contact.hotspotNotificationPending = null;
      contact.updatedAt = now;

      const pelanggan = this.pelanggan.get(contact.mikrotikUsername) || Array.from(this.pelanggan.values()).find(
        (item) => String(item.contactId || "") === String(contact.id)
      ) || null;
      if (pelanggan) {
        pelanggan.status = "pending";
        pelanggan.hotspotProvisioningStatus = HOTSPOT_PROVISIONING_STATUS.PENDING;
        pelanggan.hotspotProvisioningError = "";
        pelanggan.tanggalUpdate = now;
      }

      await this.withDatabaseWrite(() => this.sequelize.transaction(async (transaction) => {
        const saveOptions = { transaction };
        await this.saveContacts(saveOptions);
        await this.savePelanggan(saveOptions);
      }));
      return this.hydrateContact(contact);
    });
  }

  async markHotspotDeactivated(contactId, result, options = {}) {
    return this.withDataMutation(async () => {
      const contact = this.getContact(contactId);
      if (!contact) throw new Error("Kontak tidak ditemukan.");

      const now = new Date();
      contact.hotspotLastDeactivatedAt = now.toISOString();
      contact.hotspotReactivationEnabled = false;
      contact.hotspotReactivationAt = null;
      contact.hotspotNotificationPending = null;
      contact.hotspotProvisioningStatus = HOTSPOT_PROVISIONING_STATUS.DEACTIVATED;
      contact.hotspotProvisioningOperation = HOTSPOT_PROVISIONING_OPERATION.NONE;
      contact.hotspotProvisioningPrevious = null;
      contact.hotspotProvisioningError = "";
      contact.hotspotLastCheckedAt = now.toISOString();
      contact.hotspotLastSyncedAt = now.toISOString();
      contact.updatedAt = now.toISOString();

      const pelanggan = this.pelanggan.get(contact.mikrotikUsername) || Array.from(this.pelanggan.values()).find(
        (item) => String(item.contactId || "") === String(contact.id)
      ) || null;
      if (pelanggan) {
        pelanggan.status = "deactivated";
        pelanggan.hotspotProvisioningStatus = HOTSPOT_PROVISIONING_STATUS.DEACTIVATED;
        pelanggan.hotspotProvisioningError = "";
        pelanggan.hotspotLastCheckedAt = contact.hotspotLastCheckedAt;
        pelanggan.hotspotLastSyncedAt = contact.hotspotLastSyncedAt;
        pelanggan.tanggalUpdate = contact.updatedAt;
      }

      if (options.transaction) {
        await this.saveContacts(options);
        await this.savePelanggan(options);
      } else {
        await this.withDatabaseWrite(() => this.sequelize.transaction(async (transaction) => {
          const saveOptions = { transaction };
          await this.saveContacts(saveOptions);
          await this.savePelanggan(saveOptions);
        }));
      }
      return this.hydrateContact(contact);
    });
  }

  async markHotspotDisabled(contactId, result, options = {}) {
    return this.withDataMutation(async () => {
      const contact = this.getContact(contactId);
      if (!contact) throw new Error("Kontak tidak ditemukan.");
      const now = new Date().toISOString();
      contact.hotspotProvisioningStatus = HOTSPOT_PROVISIONING_STATUS.DISABLED;
      contact.hotspotProvisioningOperation = HOTSPOT_PROVISIONING_OPERATION.NONE;
      contact.hotspotProvisioningPrevious = null;
      contact.hotspotProvisioningError = options.scheduled
        ? "Akun hotspot dinonaktifkan di MikroTik sesuai jadwal."
        : "Akun hotspot dinonaktifkan di MikroTik oleh administrator.";
      contact.hotspotLastCheckedAt = now;
      contact.hotspotLastSyncedAt = now;
      if (options.arrears) {
        this.pauseBillingForArrears(contact, { at: now, suspended: true });
        contact.hotspotProvisioningError = "Akun hotspot dinonaktifkan karena masih memiliki tunggakan.";
      } else {
        contact.hotspotSuspendedForArrears = false;
        contact.hotspotManualActivationWithArrears = false;
      }
      if (options.clearSchedule) {
        contact.hotspotReactivationEnabled = false;
        contact.hotspotReactivationAt = null;
      }
      contact.updatedAt = now;
      const pelanggan = this.pelanggan.get(contact.mikrotikUsername) || Array.from(this.pelanggan.values()).find(
        (item) => String(item.contactId || "") === String(contact.id)
      ) || null;
      if (pelanggan) {
        pelanggan.status = "disabled";
        pelanggan.hotspotProvisioningStatus = HOTSPOT_PROVISIONING_STATUS.DISABLED;
        pelanggan.hotspotProvisioningError = contact.hotspotProvisioningError;
        pelanggan.hotspotLastCheckedAt = now;
        pelanggan.hotspotLastSyncedAt = now;
        pelanggan.tanggalUpdate = now;
      }
      if (options.transaction) {
        await this.saveContacts(options);
        await this.savePelanggan(options);
      } else {
        await this.withDatabaseWrite(() => this.sequelize.transaction(async (transaction) => {
          const saveOptions = { transaction };
          await this.saveContacts(saveOptions);
          await this.savePelanggan(saveOptions);
        }));
      }
      return this.hydrateContact(contact);
    });
  }

  async markHotspotEnabled(contactId, result, options = {}) {
    return this.withDataMutation(async () => {
      const contact = this.getContact(contactId);
      if (!contact) throw new Error("Kontak tidak ditemukan.");
      const requestedAt = options.at ? new Date(options.at) : new Date();
      const activatedAt = Number.isNaN(requestedAt.getTime()) ? new Date() : requestedAt;
      const now = activatedAt.toISOString();
      const manualArrearsActivation = parseBoolean(contact.billingPausedForArrears, false)
        && this.buildDebtInfo(contact).hasDebt;
      contact.hotspotProvisioningStatus = HOTSPOT_PROVISIONING_STATUS.ACTIVE;
      contact.hotspotProvisioningOperation = HOTSPOT_PROVISIONING_OPERATION.NONE;
      contact.hotspotProvisioningPrevious = null;
      contact.hotspotProvisioningError = "";
      contact.hotspotLastCheckedAt = now;
      contact.hotspotLastSyncedAt = now;
      contact.mikrotikPassword = sanitizeInput(result?.password || contact.mikrotikPassword || "");
      contact.mikrotikProfile = sanitizeInput(result?.profile || contact.mikrotikProfile || "");
      contact.hotspotSuspendedForArrears = false;
      if (manualArrearsActivation) {
        contact.hotspotManualActivationWithArrears = true;
        contact.hotspotReactivationEnabled = false;
        contact.hotspotReactivationAt = addMonthsSafely(activatedAt, 1, this.getTimezone()).toISOString();
      } else {
        contact.hotspotManualActivationWithArrears = false;
      }
      const activePeriodResult = options.activePeriodPurchase
        ? this.applyActivePeriodPurchase(contact, options.activePeriodPurchase)
        : null;
      const remindersChanged = activePeriodResult?.added
        ? this.syncActivePeriodExpiryReminder(contact, activePeriodResult.purchase).changed
        : 0;
      contact.updatedAt = now;
      const pelanggan = this.pelanggan.get(contact.mikrotikUsername) || Array.from(this.pelanggan.values()).find(
        (item) => String(item.contactId || "") === String(contact.id)
      ) || null;
      if (pelanggan) {
        pelanggan.status = "verified";
        pelanggan.hotspotProvisioningStatus = HOTSPOT_PROVISIONING_STATUS.ACTIVE;
        pelanggan.hotspotProvisioningError = "";
        pelanggan.hotspotLastCheckedAt = now;
        pelanggan.hotspotLastSyncedAt = now;
        pelanggan.password = contact.mikrotikPassword || pelanggan.password;
        pelanggan.profile = contact.mikrotikProfile || pelanggan.profile;
        pelanggan.tanggalUpdate = now;
      }
      if (options.transaction) {
        await this.saveContacts(options);
        await this.savePelanggan(options);
        if (remindersChanged) await this.saveReminders(options);
      } else {
        await this.withDatabaseWrite(() => this.sequelize.transaction(async (transaction) => {
          const saveOptions = { transaction };
          await this.saveContacts(saveOptions);
          await this.savePelanggan(saveOptions);
          if (remindersChanged) await this.saveReminders(saveOptions);
        }));
      }
      return this.hydrateContact(contact);
    });
  }

  async markHotspotReactivated(contactId, result, options = {}) {
    return this.withDataMutation(async () => {
      const contact = this.getContact(contactId);
      if (!contact) throw new Error("Kontak tidak ditemukan.");

      const requestedAt = options.at ? new Date(options.at) : new Date();
      const now = Number.isNaN(requestedAt.getTime()) ? new Date() : requestedAt;
      const manualArrearsActivation = parseBoolean(contact.billingPausedForArrears, false)
        && this.buildDebtInfo(contact).hasDebt;
      const previousSchedule = contact.hotspotReactivationAt || now.toISOString();
      let nextSchedule = null;
      if (isRecurringSubscription(contact)) {
        if (manualArrearsActivation) {
          nextSchedule = addMonthsSafely(now, 1, this.getTimezone());
        } else {
          nextSchedule = addMonthsSafely(previousSchedule, 1, this.getTimezone());
          while (nextSchedule.getTime() <= now.getTime()) {
            nextSchedule = addMonthsSafely(nextSchedule, 1, this.getTimezone());
          }
        }
      }
      contact.hotspotLastReactivatedAt = now.toISOString();
      contact.hotspotReactivationEnabled = isRecurringSubscription(contact) && !manualArrearsActivation;
      contact.hotspotReactivationAt = nextSchedule ? nextSchedule.toISOString() : null;
      contact.hotspotSuspendedForArrears = false;
      contact.hotspotManualActivationWithArrears = manualArrearsActivation;
      contact.mikrotikPassword = sanitizeInput(result?.password || contact.mikrotikPassword || "");
      contact.mikrotikProfile = sanitizeInput(result?.profile || contact.mikrotikProfile || "");
      contact.hotspotProvisioningStatus = HOTSPOT_PROVISIONING_STATUS.ACTIVE;
      contact.hotspotProvisioningOperation = HOTSPOT_PROVISIONING_OPERATION.NONE;
      contact.hotspotProvisioningPrevious = null;
      contact.hotspotProvisioningError = "";
      contact.hotspotLastCheckedAt = now.toISOString();
      contact.hotspotLastSyncedAt = now.toISOString();
      contact.updatedAt = now.toISOString();
      contact.hotspotNotificationPending = null;

      const pelanggan = this.pelanggan.get(contact.mikrotikUsername) || Array.from(this.pelanggan.values()).find(
        (item) => String(item.contactId || "") === String(contact.id)
      ) || null;
      if (pelanggan) {
        pelanggan.status = "verified";
        pelanggan.profile = contact.mikrotikProfile;
        pelanggan.password = contact.mikrotikPassword;
        pelanggan.hotspotProvisioningStatus = HOTSPOT_PROVISIONING_STATUS.ACTIVE;
        pelanggan.hotspotProvisioningError = "";
        pelanggan.hotspotLastCheckedAt = contact.hotspotLastCheckedAt;
        pelanggan.hotspotLastSyncedAt = contact.hotspotLastSyncedAt;
        pelanggan.tanggalUpdate = contact.updatedAt;
      }

      if (options.transaction) {
        await this.saveContacts(options);
        await this.savePelanggan(options);
      } else {
        await this.withDatabaseWrite(() => this.sequelize.transaction(async (transaction) => {
          const saveOptions = { transaction };
          await this.saveContacts(saveOptions);
          await this.savePelanggan(saveOptions);
        }));
      }
      return this.hydrateContact(contact);
    });
  }

  async markReminderDeliveryAttempt(id, provider = null) {
    return this.withDataMutation(async () => {
      const reminder = this.getReminder(id);
      if (!reminder) return null;

      const now = new Date().toISOString();
      reminder.deliveryAttempts = Math.max(0, Number(reminder.deliveryAttempts) || 0) + 1;
      reminder.deliveryAttemptedAt = reminder.deliveryAttemptedAt || now;
      reminder.lastDeliveryAttemptAt = now;
      reminder.whatsappProvider = provider || reminder.whatsappProvider || null;
      reminder.providerStatus = "processing";
      reminder.providerError = null;
      await this.saveReminders();
      return this.hydrateReminder(reminder);
    });
  }

  async markDueRemindersPending(now = new Date(), provider = null) {
    return this.withDataMutation(async () => {
      let changed = 0;
      for (const reminder of this.reminders.values()) {
        const dueAt = new Date(reminder.nextDeliveryAttemptAt || reminder.reminderDateTime).getTime();
        if (!Number.isFinite(dueAt) || dueAt > now.getTime() || reminder.processingAt) continue;
        if (reminder.providerStatus !== "pending" || reminder.whatsappProvider !== provider) {
          reminder.providerStatus = "pending";
          reminder.whatsappProvider = provider;
          changed += 1;
        }
      }
      if (changed > 0) await this.saveReminders();
      return changed;
    });
  }

  async scheduleReminderRetry(id, error, options = {}) {
    return this.withDataMutation(async () => {
      const reminder = this.getReminder(id);
      if (!reminder) return null;
      const delaySeconds = Math.max(1, Number(options.delaySeconds) || CONFIG.WHATSAPP_RETRY_DELAY);
      reminder.nextDeliveryAttemptAt = new Date(Date.now() + delaySeconds * 1000).toISOString();
      reminder.providerStatus = "retry";
      reminder.providerError = sanitizeInput(error?.message || error || "Pengiriman WhatsApp gagal");
      reminder.lastDeliveryError = reminder.providerError;
      reminder.whatsappProvider = options.provider || reminder.whatsappProvider || null;
      delete reminder.processingAt;
      await this.saveReminders();
      return this.hydrateReminder(reminder);
    });
  }

  async deleteContact(id) {
    return this.withDataMutation(async () => {
      const contact = this.getContact(id);
      if (!contact) throw new Error("Kontak tidak ditemukan.");

      this.contacts.delete(String(id));
      this.customerAccounts.delete(String(id));
      for (const [username, pelanggan] of this.pelanggan.entries()) {
        if (String(pelanggan.contactId || "") === String(id)) {
          this.pelanggan.delete(username);
        }
      }

      const relatedReminderIds = Array.from(this.reminders.values())
        .filter((reminder) => String(reminder.contactId) === String(contact.id) || reminder.phoneNumber === contact.phoneNumber)
        .map((reminder) => String(reminder.id));

      for (const reminderId of relatedReminderIds) {
        this.reminders.delete(reminderId);
      }

      await this.withDatabaseWrite(() => this.sequelize.transaction(async (transaction) => {
        const options = { transaction };
        await this.saveContacts(options);
        await this.savePelanggan(options);
        await this.saveCustomerAccounts(options);
        await this.saveReminders(options);
      }));
      return { deletedContact: contact, deletedReminders: relatedReminderIds.length };
    });
  }

  async addReminder(payload) {
    return this.withDataMutation(async () => {
      const contact = this.getContact(payload.contactId);
      const message = sanitizeMultilineText(payload.message);
      const reminderDate = payload.reminderDateTime instanceof Date
        ? payload.reminderDateTime
        : new Date(payload.reminderDateTime);

      if (!contact) throw new Error("Contact reminder tidak ditemukan.");
      if (!isRecurringSubscription(contact)) {
        throw new Error("Reminder tidak diperlukan untuk pelanggan sekali berlangganan.");
      }
      if (!message) throw new Error("Isi reminder wajib diisi.");
      if (Number.isNaN(reminderDate.getTime())) throw new Error("Tanggal reminder tidak valid.");

      const reminder = {
        id: generateId(),
        contactId: String(contact.id),
        contactName: contact.name,
        phoneNumber: contact.phoneNumber,
        paymentAmount: Math.max(0, Number(contact.monthlyPaymentAmount) || 0),
        reminderDateTime: reminderDate.toISOString(),
        message,
        messageSource: sanitizeMultilineText(payload.messageSource || message),
        templateName: payload.templateName ? sanitizeInput(payload.templateName) : null,
        createdAt: new Date().toISOString(),
      };

      this.rewriteReminderPaymentMessage(reminder, contact);

      this.reminders.set(reminder.id, reminder);
      await this.saveReminders();
      return this.hydrateReminder(reminder);
    });
  }

  async updateReminder(id, payload) {
    return this.withDataMutation(async () => {
      const reminder = this.getReminder(id);
      if (!reminder) throw new Error("Reminder tidak ditemukan.");
      if (reminder.processingAt) throw new Error("Reminder sedang diproses scheduler.");

      if (payload.contactId !== undefined) {
        const contact = this.getContact(payload.contactId);
        if (!contact) throw new Error("Contact reminder tidak ditemukan.");
        reminder.contactId = String(contact.id);
        reminder.contactName = contact.name;
        reminder.phoneNumber = contact.phoneNumber;
      }

      if (payload.message !== undefined) {
        const message = sanitizeMultilineText(payload.message);
        if (!message) throw new Error("Isi reminder wajib diisi.");
        reminder.message = message;
        reminder.messageSource = message;
      }

      if (payload.paymentAmount !== undefined) {
        const paymentAmount = Number(payload.paymentAmount);
        if (!Number.isFinite(paymentAmount) || paymentAmount < 0 || paymentAmount > 1_000_000_000) {
          throw new Error("Nominal reminder harus antara 0 sampai 1 miliar.");
        }
        reminder.paymentAmount = Math.floor(paymentAmount);
      }

      if (payload.reminderDateTime !== undefined) {
        const reminderDate = payload.reminderDateTime instanceof Date
          ? payload.reminderDateTime
          : new Date(payload.reminderDateTime);
        if (Number.isNaN(reminderDate.getTime())) throw new Error("Tanggal reminder tidak valid.");
        reminder.reminderDateTime = reminderDate.toISOString();
      }

      if (payload.templateName !== undefined) {
        reminder.templateName = payload.templateName ? sanitizeInput(payload.templateName) : null;
      }

      const contact = this.getResolvedReminderContact(reminder);
      if (contact) {
        this.rewriteReminderPaymentMessage(reminder, contact);
      }

      await this.saveReminders();
      return this.hydrateReminder(reminder);
    });
  }

  async deleteReminder(id) {
    return this.withDataMutation(async () => {
      const reminder = this.getReminder(id);
      if (!reminder) throw new Error("Reminder tidak ditemukan.");
      if (reminder.processingAt) throw new Error("Reminder sedang diproses scheduler.");
      this.reminders.delete(String(id));
      await this.saveReminders();
      return reminder;
    });
  }

  async claimDueReminder(id, now = new Date()) {
    return this.withDataMutation(async () => {
      const reminder = this.getReminder(id);
      if (!reminder) return null;

      const reminderTime = new Date(reminder.nextDeliveryAttemptAt || reminder.reminderDateTime).getTime();
      if (!Number.isFinite(reminderTime) || reminderTime > now.getTime()) {
        return null;
      }

      const processingStartedAt = reminder.processingAt ? new Date(reminder.processingAt).getTime() : null;
      if (Number.isFinite(processingStartedAt) && (Date.now() - processingStartedAt) < 15 * 60 * 1000) {
        return null;
      }

      reminder.processingAt = new Date().toISOString();
      await this.saveReminders();
      return this.hydrateReminder(reminder);
    });
  }

  async releaseReminderClaim(id) {
    return this.withDataMutation(async () => {
      const reminder = this.getReminder(id);
      if (!reminder || !reminder.processingAt) return null;
      delete reminder.processingAt;
      await this.saveReminders();
      return this.hydrateReminder(reminder);
    });
  }

  async moveToSent(id, extras = {}) {
    return this.withDataMutation(async () => {
      const reminder = this.getReminder(id);
      if (!reminder) return null;

      const sentReminder = {
        ...this.hydrateReminder(reminder),
        message: extras.message || reminder.message,
        sentAt: extras.sentAt || new Date().toISOString(),
        deliveryStatus: extras.deliveryStatus || "SENT",
        whatsappProvider: extras.whatsappProvider || reminder.whatsappProvider || null,
        providerMessageId: extras.providerMessageId || reminder.providerMessageId || null,
        providerStatus: extras.providerStatus || (extras.deliveryStatus === "FAILED" ? "failed" : "sent"),
        providerError: extras.providerError || extras.deliveryError || reminder.providerError || null,
      };
      if (extras.deliveryError) {
        sentReminder.deliveryError = sanitizeInput(extras.deliveryError);
      }
      delete sentReminder.processingAt;
      delete sentReminder.nextDeliveryAttemptAt;

      this.sentReminders.set(String(id), sentReminder);
      this.reminders.delete(String(id));
      await this.withDatabaseWrite(() => this.sequelize.transaction(async (transaction) => {
        const options = { transaction };
        await this.saveReminders(options);
        await this.saveSentReminders(options);
      }));
      return sentReminder;
    });
  }

  getAdminRecipients() {
    return Array.from(this.roles.entries())
      .filter(([, role]) => role === "admin")
      .map(([phoneNumber]) => phoneNumber)
      .sort();
  }

  async setAdminRecipients(numbers) {
    return this.withDataMutation(async () => {
      this.roles = new Map();
      for (const number of numbers) {
        this.roles.set(number, "admin");
      }
      await this.saveRoles();
      return this.getAdminRecipients();
    });
  }

  getSettings() {
    const settings = { ...DEFAULT_SETTINGS, ...this.settings };
    settings.profileMonthlyAmounts = normalizeProfileMonthlyAmounts(settings.profileMonthlyAmounts);
    delete settings.monthlyPaymentAmount;
    delete settings.hotspotReactivationMessageTemplate;
    return settings;
  }

  getProfileMonthlyAmount(profileName) {
    const profile = sanitizeInput(String(profileName || "")).toLowerCase();
    if (!profile) return null;
    const entries = Object.entries(this.getSettings().profileMonthlyAmounts || {});
    const match = entries.find(([name]) => name.toLowerCase() === profile);
    return match ? Number(match[1]) : null;
  }

  applyProfileMonthlyAmount(contact, profileName = contact?.mikrotikProfile) {
    const amount = this.getProfileMonthlyAmount(profileName);
    if (!contact || contact.monthlyPaymentAmountCustomized || amount === null
      || Number(contact.monthlyPaymentAmount) === amount) return false;
    contact.monthlyPaymentAmount = amount;
    return true;
  }

  async updateSettings(payload) {
    return this.withDataMutation(async () => {
      const current = this.getSettings();
      const requestedTimezone = payload.timezone !== undefined
        ? sanitizeInput(payload.timezone)
        : current.timezone;
      const requestedBackupTimezone = payload.mikrotikBackupTimezone !== undefined
        ? sanitizeInput(payload.mikrotikBackupTimezone)
        : current.mikrotikBackupTimezone;
      if (!isValidTimeZone(requestedTimezone)) {
        throw new Error("Timezone aplikasi tidak valid.");
      }
      if (!isValidTimeZone(requestedBackupTimezone || requestedTimezone)) {
        throw new Error("Timezone backup MikroTik tidak valid.");
      }
      const requestedDelayMin = payload.waRandomDelayMinSeconds !== undefined
        ? sanitizePositiveInteger(payload.waRandomDelayMinSeconds, current.waRandomDelayMinSeconds, 0, 300)
        : current.waRandomDelayMinSeconds;
      const requestedDelayMax = payload.waRandomDelayMaxSeconds !== undefined
        ? sanitizePositiveInteger(payload.waRandomDelayMaxSeconds, current.waRandomDelayMaxSeconds, 0, 300)
        : current.waRandomDelayMaxSeconds;
      const requestedProfileMonthlyAmounts = payload.profileMonthlyAmounts !== undefined
        ? normalizeProfileMonthlyAmounts(payload.profileMonthlyAmounts, { strict: true })
        : current.profileMonthlyAmounts;
      this.settings = {
        ...current,
        dashboardTitle: payload.dashboardTitle !== undefined ? sanitizeInput(payload.dashboardTitle) || current.dashboardTitle : current.dashboardTitle,
        companyName: payload.companyName !== undefined ? sanitizeInput(payload.companyName) || current.companyName : current.companyName,
        supportSignature: payload.supportSignature !== undefined ? sanitizeInput(payload.supportSignature) || current.supportSignature : current.supportSignature,
        apDownMessageTemplate: payload.apDownMessageTemplate !== undefined
          ? sanitizeMultilineText(payload.apDownMessageTemplate) || current.apDownMessageTemplate
          : current.apDownMessageTemplate,
        customerAccountMessageTemplate: payload.customerAccountMessageTemplate !== undefined
          ? sanitizeMultilineText(payload.customerAccountMessageTemplate) || current.customerAccountMessageTemplate
          : current.customerAccountMessageTemplate,
        paymentMessageTemplateArrearsOnly: payload.paymentMessageTemplateArrearsOnly !== undefined
          ? sanitizeMultilineText(payload.paymentMessageTemplateArrearsOnly) || current.paymentMessageTemplateArrearsOnly
          : current.paymentMessageTemplateArrearsOnly,
        paymentMessageTemplateCurrentOnly: payload.paymentMessageTemplateCurrentOnly !== undefined
          ? sanitizeMultilineText(payload.paymentMessageTemplateCurrentOnly) || current.paymentMessageTemplateCurrentOnly
          : current.paymentMessageTemplateCurrentOnly,
        paymentMessageTemplateFullPaid: payload.paymentMessageTemplateFullPaid !== undefined
          ? sanitizeMultilineText(payload.paymentMessageTemplateFullPaid) || current.paymentMessageTemplateFullPaid
          : current.paymentMessageTemplateFullPaid,
        paymentMessageTemplateActivePeriod: payload.paymentMessageTemplateActivePeriod !== undefined
          ? sanitizeMultilineText(payload.paymentMessageTemplateActivePeriod) || current.paymentMessageTemplateActivePeriod
          : current.paymentMessageTemplateActivePeriod,
        paymentHotspotAccountMessageTemplate: payload.paymentHotspotAccountMessageTemplate !== undefined
          ? sanitizeMultilineText(payload.paymentHotspotAccountMessageTemplate) || current.paymentHotspotAccountMessageTemplate
          : current.paymentHotspotAccountMessageTemplate,
        activePeriodReminderMessageTemplate: payload.activePeriodReminderMessageTemplate !== undefined
          ? sanitizeMultilineText(payload.activePeriodReminderMessageTemplate) || current.activePeriodReminderMessageTemplate
          : current.activePeriodReminderMessageTemplate,
        billingReminderMessageTemplate: payload.billingReminderMessageTemplate !== undefined
          ? sanitizeMultilineText(payload.billingReminderMessageTemplate) || current.billingReminderMessageTemplate
          : current.billingReminderMessageTemplate,
        apDownMinimumDownMinutes: payload.apDownMinimumDownMinutes !== undefined
          ? sanitizePositiveInteger(
              payload.apDownMinimumDownMinutes,
              current.apDownMinimumDownMinutes || current.apDownConfirmationChecks || DEFAULT_SETTINGS.apDownMinimumDownMinutes,
              1,
              120
            )
          : (current.apDownMinimumDownMinutes || current.apDownConfirmationChecks || DEFAULT_SETTINGS.apDownMinimumDownMinutes),
        timezone: requestedTimezone,
        hotspotIsolationGraceDays: payload.hotspotIsolationGraceDays !== undefined
          ? sanitizePositiveInteger(
              payload.hotspotIsolationGraceDays,
              current.hotspotIsolationGraceDays,
              0,
              30
            )
          : current.hotspotIsolationGraceDays,
        autoRescheduleMonthly: payload.autoRescheduleMonthly !== undefined ? parseBoolean(payload.autoRescheduleMonthly, current.autoRescheduleMonthly) : current.autoRescheduleMonthly,
        notifyContactsOnApDown: payload.notifyContactsOnApDown !== undefined ? parseBoolean(payload.notifyContactsOnApDown, current.notifyContactsOnApDown) : current.notifyContactsOnApDown,
        notifyAdminsOnDelivery: payload.notifyAdminsOnDelivery !== undefined ? parseBoolean(payload.notifyAdminsOnDelivery, current.notifyAdminsOnDelivery) : current.notifyAdminsOnDelivery,
        notifyAdminsOnConnectionChange: payload.notifyAdminsOnConnectionChange !== undefined ? parseBoolean(payload.notifyAdminsOnConnectionChange, current.notifyAdminsOnConnectionChange) : current.notifyAdminsOnConnectionChange,
        notifyAdminsOnPaymentReset: payload.notifyAdminsOnPaymentReset !== undefined ? parseBoolean(payload.notifyAdminsOnPaymentReset, current.notifyAdminsOnPaymentReset) : current.notifyAdminsOnPaymentReset,
        waRandomDelayMinSeconds: Math.min(requestedDelayMin, requestedDelayMax),
        waRandomDelayMaxSeconds: Math.max(requestedDelayMin, requestedDelayMax),
        enableMikrotikBackupToWa: payload.enableMikrotikBackupToWa !== undefined
          ? parseBoolean(payload.enableMikrotikBackupToWa, current.enableMikrotikBackupToWa)
          : current.enableMikrotikBackupToWa,
        mikrotikBackupTime: payload.mikrotikBackupTime !== undefined
          ? sanitizeTimeHHMM(payload.mikrotikBackupTime, current.mikrotikBackupTime || DEFAULT_SETTINGS.mikrotikBackupTime)
          : current.mikrotikBackupTime,
        mikrotikBackupTimezone: requestedBackupTimezone || requestedTimezone,
        profileMonthlyAmounts: requestedProfileMonthlyAmounts,
        mikrotikBackupLastRunDate: payload.mikrotikBackupLastRunDate !== undefined
          ? sanitizeInput(payload.mikrotikBackupLastRunDate)
          : current.mikrotikBackupLastRunDate,
        databaseBackupLastRunDate: current.databaseBackupLastRunDate,
      };
      let contactsChanged = false;
      let remindersChanged = 0;
      const updatedAt = new Date().toISOString();
      for (const contact of this.contacts.values()) {
        if (!this.applyProfileMonthlyAmount(contact)) continue;
        contact.updatedAt = updatedAt;
        contactsChanged = true;
        remindersChanged += this.updateContactReminderMessages(contact);
      }

      if (this.sequelize && (contactsChanged || remindersChanged > 0)) {
        await this.withDatabaseWrite(() => this.sequelize.transaction(async (transaction) => {
          const options = { transaction };
          await this.saveSettings(options);
          if (contactsChanged) await this.saveContacts(options);
          if (remindersChanged > 0) await this.saveReminders(options);
        }));
      } else {
        await this.saveSettings();
        if (contactsChanged) await this.saveContacts();
        if (remindersChanged > 0) await this.saveReminders();
      }
      return this.getSettings();
    });
  }

  async markMikrotikBackupRun(dateKey) {
    return this.withDataMutation(async () => {
      this.settings = {
        ...this.getSettings(),
        mikrotikBackupLastRunDate: sanitizeInput(dateKey),
      };
      await this.saveSettings();
      return this.settings.mikrotikBackupLastRunDate;
    });
  }

  async markDatabaseBackupRun(dateKey) {
    return this.withDataMutation(async () => {
      this.settings = {
        ...this.getSettings(),
        databaseBackupLastRunDate: sanitizeInput(dateKey),
      };
      await this.saveSettings();
      return this.settings.databaseBackupLastRunDate;
    });
  }

  getContactsByStatus(status) {
    return this.getSortedContacts().filter((contact) => contact.paymentStatus === status);
  }

  getPaymentsByMonth(year, month) {
    const key = `${year}-${String(month).padStart(2, "0")}`;
    return this.getSortedContacts().filter((contact) => {
      return contact.paymentMonths?.[key]?.status === PAYMENT_STATUS.PAID;
    });
  }

  getAllPaymentsHistory() {
    const history = {};
    for (const contact of this.contacts.values()) {
      for (const [key, payment] of Object.entries(contact.paymentMonths || {})) {
        if (!payment || payment.status !== PAYMENT_STATUS.PAID) continue;
        if (!history[key]) {
          history[key] = { contacts: [], total: 0 };
        }
        history[key].contacts.push(contact);
        history[key].total += 1;
      }
    }
    return history;
  }

  async createPaymentRecapWorkbook() {
    const workbook = new ExcelJS.Workbook();
    const contacts = this.getSortedContacts();
    const paidContacts = contacts.filter((contact) => contact.paymentStatus === PAYMENT_STATUS.PAID);
    const unpaidContacts = contacts.filter((contact) => contact.paymentStatus !== PAYMENT_STATUS.PAID);
    const debtContacts = contacts.filter((contact) => contact.hasDebt);
    const now = new Date();
    const timeZone = this.getTimezone();
    const { year, month } = getBillingPeriodParts(now, timeZone);

    workbook.creator = "Reminder Bot";
    workbook.created = now;
    workbook.modified = now;

    const summary = workbook.addWorksheet("Ringkasan");
    summary.columns = [
      { header: "Keterangan", key: "label" },
      { header: "Jumlah / Nilai", key: "value" },
    ];
    summary.addRows([
      { label: "Periode Rekap", value: formatBillingPeriodLabel(year, month) },
      { label: "Dibuat Pada", value: formatReportDate(now, true, timeZone) },
      { label: "Total Pelanggan", value: contacts.length },
      { label: "Sudah Lunas Bulan Ini", value: paidContacts.length },
      { label: "Belum Lunas Bulan Ini", value: unpaidContacts.length },
      { label: "Pelanggan Memiliki Tunggakan", value: debtContacts.length },
    ]);
    styleReportSheet(summary);

    const contactColumns = [
      { header: "No", key: "number" },
      { header: "Nama", key: "name" },
      { header: "Nomor WhatsApp", key: "phoneNumber" },
      { header: "Status Bulan Ini", key: "status" },
      { header: "Jenis Pembayaran", key: "paymentType" },
      { header: "Tanggal Pembayaran", key: "paymentDate" },
      { header: "Jumlah Tunggakan (Bulan)", key: "debtCount" },
      { header: "Sisa Tunggakan", key: "debtAmount" },
      { header: "Periode Tunggakan", key: "debtPeriods" },
      { header: "Jatuh Tempo", key: "dueDate" },
      { header: "Status Jatuh Tempo", key: "dueStatus" },
      { header: "Username Hotspot", key: "mikrotikUsername" },
      { header: "Profile Hotspot", key: "mikrotikProfile" },
      { header: "AP", key: "linkedApHost" },
    ];
    const toContactRow = (contact, index) => ({
      number: index + 1,
      name: contact.name || "-",
      phoneNumber: contact.phoneNumber || "-",
      status: contact.paymentStatus === PAYMENT_STATUS.PAID ? "Lunas" : "Belum Lunas",
      paymentType: PAYMENT_TYPE_LABELS[contact.paymentType] || "-",
      paymentDate: formatReportDate(contact.paymentDate, true, timeZone),
      debtCount: contact.debtCount || 0,
      debtAmount: Math.max(0, Number(contact.debtAmount) || 0),
      debtPeriods: (contact.debtPeriods || []).map((period) => period.label).join(", ") || "-",
      dueDate: formatReportDate(contact.dueDate, false, timeZone),
      dueStatus: {
        PAID: "Lunas",
        OVERDUE: "Jatuh Tempo",
        UPCOMING: "Belum Jatuh Tempo",
        NOT_SCHEDULED: "Perlu Dijadwalkan",
        NOT_APPLICABLE: "Tidak Dijadwalkan",
      }[contact.dueStatus] || contact.dueStatus || "-",
      mikrotikUsername: contact.mikrotikUsername || "-",
      mikrotikProfile: contact.mikrotikProfile || "-",
      linkedApHost: contact.linkedApHost || "-",
    });

    for (const [sheetName, rows] of [
      ["Semua Pelanggan", contacts],
      ["Belum Lunas", unpaidContacts],
      ["Sudah Lunas", paidContacts],
      ["Memiliki Tunggakan", debtContacts],
    ]) {
      const sheet = workbook.addWorksheet(sheetName);
      sheet.columns = contactColumns;
      sheet.addRows(rows.map(toContactRow));
      styleReportSheet(sheet);
    }

    const history = workbook.addWorksheet("Riwayat Pembayaran");
    history.columns = [
      { header: "No", key: "number" },
      { header: "Periode Tagihan", key: "period" },
      { header: "Nama", key: "name" },
      { header: "Nomor WhatsApp", key: "phoneNumber" },
      { header: "Status", key: "status" },
      { header: "Jenis Pembayaran", key: "paymentType" },
      { header: "Nominal Dibayar", key: "paidAmount" },
      { header: "Sisa Tagihan", key: "remainingAmount" },
      { header: "Tanggal Dibayar", key: "paidDate" },
      { header: "Aktif Sampai", key: "activeUntil" },
    ];
    const historyRows = [];
    for (const contact of contacts) {
      for (const [period, payment] of Object.entries(contact.paymentMonths || {})) {
        if (!payment) continue;
        historyRows.push({
          period,
          name: contact.name || "-",
          phoneNumber: contact.phoneNumber || "-",
          status: payment.status === PAYMENT_STATUS.PAID ? "Lunas" : "Belum Lunas",
          paymentType: PAYMENT_TYPE_LABELS[payment.paymentType] || "-",
          paidAmount: this.getPaymentPaidAmount(payment, contact.monthlyPaymentAmount),
          remainingAmount: this.getPaymentRemainingAmount(payment, contact.monthlyPaymentAmount),
          paidDate: formatReportDate(payment.lastPaymentDate || payment.paidDate, true, timeZone),
          activeUntil: "-",
        });
      }
      for (const purchase of contact.activePeriodPurchases || []) {
        const purchasedAt = new Date(purchase.purchasedAt || 0);
        if (Number.isNaN(purchasedAt.getTime())) continue;
        historyRows.push({
          period: getBillingPeriodKey(purchasedAt, timeZone),
          name: contact.name || "-",
          phoneNumber: contact.phoneNumber || "-",
          status: "Lunas",
          paymentType: PAYMENT_TYPE_LABELS[PAYMENT_TYPES.ACTIVE_PERIOD],
          paidAmount: Math.max(0, Number(purchase.amount) || 0),
          remainingAmount: 0,
          paidDate: formatReportDate(purchase.purchasedAt, true, timeZone),
          activeUntil: formatReportDate(purchase.activeUntil, true, timeZone),
        });
      }
    }
    historyRows.sort((a, b) => b.period.localeCompare(a.period) || a.name.localeCompare(b.name, "id-ID"));
    history.addRows(historyRows.map((row, index) => ({ number: index + 1, ...row })));
    styleReportSheet(history);

    return workbook;
  }

  getPaymentMonthStatus(contactId) {
    const contact = this.getContact(contactId);
    return contact?.paymentMonths || {};
  }

  normalizePaymentSelection(status, paymentType = null) {
    const normalizedStatus = sanitizeInput(status).toUpperCase();
    const normalizedType = sanitizeInput(paymentType).toUpperCase() || null;

    if (![PAYMENT_STATUS.PAID, PAYMENT_STATUS.UNPAID].includes(normalizedStatus)) {
      throw new Error("Status pembayaran tidak valid.");
    }
    if (normalizedType && !this.getAllowedPaymentTypes().includes(normalizedType)) {
      throw new Error("Jenis pembayaran tidak valid.");
    }
    if (normalizedType === PAYMENT_TYPES.ACTIVE_PERIOD) {
      throw new Error("Pembelian masa aktif harus menggunakan tindakan khusus pembelian masa aktif.");
    }

    if (normalizedStatus === PAYMENT_STATUS.PAID) {
      if (normalizedType === PAYMENT_TYPES.ARREARS_ONLY) {
        throw new Error("Pembayaran tunggakan saja harus membiarkan bulan berjalan berstatus belum lunas.");
      }
      return {
        status: normalizedStatus,
        paymentType: normalizedType || PAYMENT_TYPES.CURRENT_ONLY,
      };
    }

    if (normalizedType && normalizedType !== PAYMENT_TYPES.ARREARS_ONLY) {
      throw new Error("Status belum lunas hanya dapat digunakan tanpa jenis pembayaran atau untuk tunggakan saja.");
    }

    return { status: normalizedStatus, paymentType: normalizedType };
  }

  async updatePaymentStatus(contactId, status, paymentType = null, paymentAmount = null) {
    return this.withDataMutation(async () => {
      const contact = this.getContact(contactId);
      if (!contact) throw new Error("Kontak tidak ditemukan.");
      ({ status, paymentType } = this.normalizePaymentSelection(status, paymentType));
      let appliedPaymentAmount = 0;

      const now = new Date();
      const serviceScheduleBeforePayment = contact.hotspotReactivationAt || null;
      const timeZone = this.getTimezone();
      const { year, month } = getBillingPeriodParts(now, timeZone);
      const currentKey = makeBillingPeriodKey(year, month);
      const previous = getPreviousBillingPeriod(year, month);
      const subscriptionEnded = !this.usesRecurringBilling(contact)
        && isOneTimeSubscriptionEnded(contact, { year, month }, timeZone);
      if (subscriptionEnded && ![PAYMENT_TYPES.FULL_PAID, PAYMENT_TYPES.ARREARS_ONLY].includes(paymentType)) {
        if (status !== PAYMENT_STATUS.UNPAID) {
          throw new Error("Pelanggan sekali berlangganan sudah tidak memiliki tagihan periode berjalan.");
        }
        contact.paymentStatus = PAYMENT_STATUS.PAID;
        contact.paymentDate = null;
        contact.paymentType = null;
        contact.updatedAt = now.toISOString();
        const remindersChanged = this.updateContactReminderMessages(contact);
        await this.savePaymentAndReminderChanges(remindersChanged);
        return this.hydrateContact(contact);
      }
      if (!contact.paymentMonths || typeof contact.paymentMonths !== "object") {
        contact.paymentMonths = {};
      }
      const currentPaymentBeforeUpdate = contact.paymentMonths[currentKey] || null;
      const currentStatusBeforeUpdate = currentPaymentBeforeUpdate?.status
        || String(contact.paymentStatus || PAYMENT_STATUS.UNPAID).toUpperCase();
      const arrearsDebtInfo = paymentType === PAYMENT_TYPES.ARREARS_ONLY
        ? this.buildDebtInfo(contact, { year, month })
        : null;
      const arrearsDebtPeriod = arrearsDebtInfo?.debtPeriods?.[0] || null;
      if (paymentType === PAYMENT_TYPES.ARREARS_ONLY) {
        if (!arrearsDebtPeriod) {
          throw new Error("Kontak tidak memiliki tunggakan yang belum dibayar.");
        }
        const hasExplicitPaymentAmount = paymentAmount !== null
          && paymentAmount !== undefined
          && paymentAmount !== "";
        const monthlyAmount = Math.max(0, Number(contact.monthlyPaymentAmount) || 0);
        if (hasExplicitPaymentAmount && monthlyAmount <= 0) {
          throw new Error("Nominal bulanan harus diisi sebelum mencatat pembayaran tunggakan.");
        }

        if (monthlyAmount > 0) {
          const requestedAmount = hasExplicitPaymentAmount
            ? Number(paymentAmount)
            : arrearsDebtPeriod.remainingAmount;
          if (!Number.isSafeInteger(requestedAmount) || requestedAmount <= 0) {
            throw new Error("Nominal pembayaran tunggakan harus berupa angka bulat lebih dari 0.");
          }
          if (requestedAmount > arrearsDebtInfo.debtAmount) {
            throw new Error(`Nominal pembayaran melebihi sisa tunggakan ${this.formatPaymentAmount(arrearsDebtInfo.debtAmount)}.`);
          }
          appliedPaymentAmount = requestedAmount;
        }
      }

      const nextCurrentStatus = paymentType === PAYMENT_TYPES.ARREARS_ONLY
        ? currentStatusBeforeUpdate
        : status;
      contact.paymentStatus = nextCurrentStatus;
      contact.paymentDate = nextCurrentStatus === PAYMENT_STATUS.PAID
        ? currentPaymentBeforeUpdate?.paidDate || contact.paymentDate || now.toISOString()
        : null;
      contact.paymentType = paymentType || null;

      if (paymentType === PAYMENT_TYPES.FULL_PAID) {
        const startPeriod = getContactBillingStartPeriod(contact, timeZone);
        const periods = this.usesRecurringBilling(contact)
          ? listBillingPeriods(startPeriod, previous)
          : (compareBillingPeriods(startPeriod, previous) <= 0 ? [startPeriod] : []);
        for (const period of periods) {
          contact.paymentMonths[makeBillingPeriodKey(period.year, period.month)] = {
            status: PAYMENT_STATUS.PAID,
            paidDate: now.toISOString(),
            paymentType,
            paidAmount: Math.max(0, Math.floor(Number(contact.monthlyPaymentAmount) || 0)),
          };
        }
      } else if (paymentType === PAYMENT_TYPES.ARREARS_ONLY) {
        const monthlyAmount = Math.max(0, Math.floor(Number(contact.monthlyPaymentAmount) || 0));
        if (monthlyAmount <= 0) {
          contact.paymentMonths[arrearsDebtPeriod.key] = {
            ...(contact.paymentMonths[arrearsDebtPeriod.key] || {}),
            status: PAYMENT_STATUS.PAID,
            paidDate: now.toISOString(),
            lastPaymentDate: now.toISOString(),
            paymentType,
            paidAmount: 0,
          };
        } else {
          let remainingPayment = appliedPaymentAmount;
          for (const debtPeriod of arrearsDebtInfo.debtPeriods) {
            if (remainingPayment <= 0) break;
            const previousPayment = contact.paymentMonths[debtPeriod.key] || {};
            const recordedAmount = this.getPaymentPaidAmount(previousPayment, monthlyAmount);
            const amountForPeriod = Math.min(debtPeriod.remainingAmount, remainingPayment);
            const nextPaidAmount = recordedAmount + amountForPeriod;
            const isPeriodPaid = nextPaidAmount >= monthlyAmount;
            contact.paymentMonths[debtPeriod.key] = {
              ...previousPayment,
              status: isPeriodPaid ? PAYMENT_STATUS.PAID : PAYMENT_STATUS.UNPAID,
              paidDate: isPeriodPaid ? now.toISOString() : previousPayment.paidDate || null,
              lastPaymentDate: now.toISOString(),
              paymentType,
              paidAmount: nextPaidAmount,
            };
            remainingPayment -= amountForPeriod;
          }
        }
      }

      if (!subscriptionEnded) {
        if (paymentType !== PAYMENT_TYPES.ARREARS_ONLY) {
          const existingCurrentPayment = contact.paymentMonths[currentKey] || {};
          contact.paymentMonths[currentKey] = {
            ...existingCurrentPayment,
            status,
            paidDate: status === PAYMENT_STATUS.PAID ? now.toISOString() : null,
            paymentType: paymentType || null,
            paidAmount: status === PAYMENT_STATUS.PAID
              ? Math.max(0, Math.floor(Number(contact.monthlyPaymentAmount) || 0))
              : this.getPaymentPaidAmount(existingCurrentPayment, contact.monthlyPaymentAmount),
          };
        } else if (!currentPaymentBeforeUpdate) {
          contact.paymentMonths[currentKey] = {
            status: currentStatusBeforeUpdate,
            paidDate: currentStatusBeforeUpdate === PAYMENT_STATUS.PAID ? contact.paymentDate : null,
            paymentType: null,
            paidAmount: 0,
          };
        }
      } else {
        contact.paymentStatus = PAYMENT_STATUS.PAID;
        contact.paymentDate = null;
        contact.paymentType = null;
      }
      contact.updatedAt = now.toISOString();

      const arrearsPolicy = contact.subscriptionChangedByArrears
        ? this.applyArrearsSubscriptionPolicy(contact)
        : { remindersAdded: 0, remindersRemoved: 0 };
      const automaticRenewalResumed = this.resumeAutomaticRenewalIfArrearsSettled(contact, { at: now });
      const serviceSchedule = status === PAYMENT_STATUS.PAID
        && paymentType !== PAYMENT_TYPES.ARREARS_ONLY
        ? this.advanceServiceScheduleAfterPayment(contact, {
            at: now,
            previousSchedule: serviceScheduleBeforePayment,
          })
        : { changed: false, activeFrom: null, activeUntil: null };
      const remindersChanged = arrearsPolicy.remindersAdded + arrearsPolicy.remindersRemoved
        + (automaticRenewalResumed ? this.restoreBillingReminderAfterActivePeriod(contact) : 0)
        + (serviceSchedule.changed ? this.syncRecurringReminderSchedule(contact) : 0)
        + this.updateContactReminderMessages(contact);
      await this.savePaymentAndReminderChanges(remindersChanged);
      const hydrated = this.hydrateContact(contact);
      if (appliedPaymentAmount > 0) {
        hydrated.paymentAppliedAmount = appliedPaymentAmount;
      }
      if (serviceSchedule.activeUntil) {
        hydrated.serviceActiveFrom = serviceSchedule.activeFrom;
        hydrated.serviceActiveUntil = serviceSchedule.activeUntil;
      }
      return hydrated;
    });
  }

  async setPaymentForMonth(contactId, year, month, status, paymentType = null) {
    return this.withDataMutation(async () => {
      const contact = this.getContact(contactId);
      if (!contact) throw new Error("Kontak tidak ditemukan.");
      if (!Number.isInteger(year) || year < 2000 || year > 2100 || !Number.isInteger(month) || month < 1 || month > 12) {
        throw new Error("Periode pembayaran tidak valid.");
      }
      ({ status, paymentType } = this.normalizePaymentSelection(status, paymentType));

      if (!contact.paymentMonths) {
        contact.paymentMonths = {};
      }

      const key = `${year}-${String(month).padStart(2, "0")}`;
      const now = new Date();
      const serviceScheduleBeforePayment = contact.hotspotReactivationAt || null;
      const timeZone = this.getTimezone();
      const previous = getPreviousBillingPeriod(year, month);
      if (!this.usesRecurringBilling(contact)) {
        const startPeriod = getContactBillingStartPeriod(contact, timeZone);
        const existingPeriod = contact.paymentMonths[key];
        const isExistingArrears = existingPeriod?.status === PAYMENT_STATUS.UNPAID
          && compareBillingPeriods(startPeriod, { year, month }) < 0;
        if (compareBillingPeriods(startPeriod, { year, month }) !== 0 && !isExistingArrears) {
          throw new Error("Pelanggan sekali berlangganan hanya dapat dicatat pada periode saat berlangganan.");
        }
      }
      const arrearsDebtPeriod = paymentType === PAYMENT_TYPES.ARREARS_ONLY
        ? this.buildDebtInfo(contact, { year, month }).debtPeriods?.[0]
        : null;
      if (paymentType === PAYMENT_TYPES.ARREARS_ONLY && !arrearsDebtPeriod) {
        throw new Error("Kontak tidak memiliki tunggakan yang belum dibayar.");
      }

      if (paymentType === PAYMENT_TYPES.FULL_PAID) {
        const startPeriod = getContactBillingStartPeriod(contact, timeZone);
        const periods = this.usesRecurringBilling(contact)
          ? listBillingPeriods(startPeriod, previous)
          : (compareBillingPeriods(startPeriod, previous) <= 0 ? [startPeriod] : []);
        for (const period of periods) {
          contact.paymentMonths[makeBillingPeriodKey(period.year, period.month)] = {
            status: PAYMENT_STATUS.PAID,
            paidDate: now.toISOString(),
            paymentType,
            paidAmount: Math.max(0, Math.floor(Number(contact.monthlyPaymentAmount) || 0)),
          };
        }
      } else if (paymentType === PAYMENT_TYPES.ARREARS_ONLY) {
        contact.paymentMonths[arrearsDebtPeriod.key] = {
          status: PAYMENT_STATUS.PAID,
          paidDate: now.toISOString(),
          paymentType,
          paidAmount: Math.max(0, Math.floor(Number(contact.monthlyPaymentAmount) || 0)),
        };
      }

      contact.paymentMonths[key] = {
        status,
        paidDate: status === PAYMENT_STATUS.PAID ? now.toISOString() : null,
        paymentType: paymentType || null,
        paidAmount: status === PAYMENT_STATUS.PAID
          ? Math.max(0, Math.floor(Number(contact.monthlyPaymentAmount) || 0))
          : 0,
      };

      const { year: currentYear, month: currentMonth } = getBillingPeriodParts(now, timeZone);
      if (year === currentYear && month === currentMonth) {
        contact.paymentStatus = status;
        contact.paymentDate = status === PAYMENT_STATUS.PAID ? now.toISOString() : null;
        contact.paymentType = paymentType || null;
      }
      contact.updatedAt = now.toISOString();

      const arrearsPolicy = contact.subscriptionChangedByArrears
        ? this.applyArrearsSubscriptionPolicy(contact)
        : { remindersAdded: 0, remindersRemoved: 0 };
      const automaticRenewalResumed = this.resumeAutomaticRenewalIfArrearsSettled(contact, { at: now });
      const serviceSchedule = year === currentYear
        && month === currentMonth
        && status === PAYMENT_STATUS.PAID
        && paymentType !== PAYMENT_TYPES.ARREARS_ONLY
        ? this.advanceServiceScheduleAfterPayment(contact, {
            at: now,
            previousSchedule: serviceScheduleBeforePayment,
          })
        : { changed: false, activeFrom: null, activeUntil: null };
      const remindersChanged = arrearsPolicy.remindersAdded + arrearsPolicy.remindersRemoved
        + (automaticRenewalResumed ? this.restoreBillingReminderAfterActivePeriod(contact) : 0)
        + (serviceSchedule.changed ? this.syncRecurringReminderSchedule(contact) : 0)
        + this.updateContactReminderMessages(contact);
      await this.savePaymentAndReminderChanges(remindersChanged);
      const hydrated = this.hydrateContact(contact);
      if (serviceSchedule.activeUntil) {
        hydrated.serviceActiveFrom = serviceSchedule.activeFrom;
        hydrated.serviceActiveUntil = serviceSchedule.activeUntil;
      }
      return hydrated;
    });
  }

  inferPaymentType(contact, options = {}) {
    const paymentMonths = contact.paymentMonths || {};
    const currentPeriod = getBillingPeriodParts(new Date(), this.getTimezone());
    const year = options.year ?? currentPeriod.year;
    const month = options.month ?? currentPeriod.month;
    const currentKey = `${year}-${String(month).padStart(2, "0")}`;
    const prevMonth = month === 1 ? 12 : month - 1;
    const prevYear = month === 1 ? year - 1 : year;
    const prevKey = `${prevYear}-${String(prevMonth).padStart(2, "0")}`;
    const savedType = String(contact.paymentType || "").toUpperCase();
    if (Object.values(PAYMENT_TYPES).includes(savedType)) {
      return savedType;
    }

    const currentPaid = paymentMonths[currentKey]?.status === PAYMENT_STATUS.PAID;
    const previousPaid = paymentMonths[prevKey]?.status === PAYMENT_STATUS.PAID;

    if (currentPaid && previousPaid) return PAYMENT_TYPES.FULL_PAID;
    if (currentPaid) return PAYMENT_TYPES.CURRENT_ONLY;
    if (previousPaid) return PAYMENT_TYPES.ARREARS_ONLY;
    return "DEFAULT";
  }

  getAllowedPaymentTypes() {
    return Object.values(PAYMENT_TYPES);
  }

  getOverdueContacts(year, month) {
    return this.getSortedContacts().filter((contact) => (
      this.buildDebtInfo(contact, { year, month }).hasDebt
    ));
  }

  async resetAllPaymentStatus() {
    return this.withDataMutation(async () => this.resetAllPaymentStatusUnlocked());
  }

  async resetAllPaymentStatusUnlocked(options = {}) {
    let resetCount = 0;
    let remindersChanged = 0;
    const currentKey = getBillingPeriodKey(new Date(), this.getTimezone());

    for (const contact of this.contacts.values()) {
      const arrearsPolicy = this.applyArrearsSubscriptionPolicy(contact);
      remindersChanged += arrearsPolicy.remindersAdded + arrearsPolicy.remindersRemoved;
      if (parseBoolean(contact.billingPausedForArrears, false)) {
        contact.paymentStatus = PAYMENT_STATUS.PAID;
        contact.paymentDate = null;
        contact.paymentType = null;
        contact.updatedAt = new Date().toISOString();
        remindersChanged += this.updateContactReminderMessages(contact);
        resetCount += 1;
        continue;
      }
      if (!isRecurringSubscription(contact)) {
        const startPeriod = getContactBillingStartPeriod(contact, this.getTimezone());
        const currentPeriod = getBillingPeriodParts(new Date(), this.getTimezone());
        if (compareBillingPeriods(startPeriod, currentPeriod) < 0) {
          contact.paymentStatus = PAYMENT_STATUS.PAID;
          contact.paymentDate = null;
          contact.paymentType = null;
          contact.updatedAt = new Date().toISOString();
          remindersChanged += this.updateContactReminderMessages(contact);
          resetCount += 1;
          continue;
        }
      }
      contact.paymentStatus = PAYMENT_STATUS.UNPAID;
      contact.paymentDate = null;
      contact.paymentType = null;
      if (!contact.paymentMonths) {
        contact.paymentMonths = {};
      }
      contact.paymentMonths[currentKey] = {
        status: PAYMENT_STATUS.UNPAID,
        paidDate: null,
        paymentType: null,
        paidAmount: 0,
      };
      contact.updatedAt = new Date().toISOString();
      remindersChanged += this.updateContactReminderMessages(contact);
      resetCount += 1;
    }

    if (resetCount > 0 && options.save !== false) {
      await this.savePaymentAndReminderChanges(remindersChanged);
    }

    return resetCount;
  }

  synchronizeCurrentPaymentStatus() {
    const currentKey = getBillingPeriodKey(new Date(), this.getTimezone());
    let changed = 0;

    for (const contact of this.contacts.values()) {
      const currentPayment = contact.paymentMonths?.[currentKey];
      const billingPaused = parseBoolean(contact.billingPausedForArrears, false);
      const isPaid = billingPaused || currentPayment?.status === PAYMENT_STATUS.PAID;
      const nextStatus = isPaid ? PAYMENT_STATUS.PAID : PAYMENT_STATUS.UNPAID;
      const nextPaymentDate = isPaid && !billingPaused ? currentPayment?.paidDate || null : null;
      const nextPaymentType = isPaid && !billingPaused ? currentPayment?.paymentType || null : null;

      if (contact.paymentStatus !== nextStatus
        || contact.paymentDate !== nextPaymentDate
        || contact.paymentType !== nextPaymentType) {
        contact.paymentStatus = nextStatus;
        contact.paymentDate = nextPaymentDate;
        contact.paymentType = nextPaymentType;
        contact.updatedAt = new Date().toISOString();
        this.updateContactReminderMessages(contact);
        changed += 1;
      }
    }

    return changed;
  }

  async ensureMonthlyPaymentReset() {
    return this.withDataMutation(async () => {
      const currentPeriod = getBillingPeriodKey(new Date(), this.getTimezone());
      const settings = this.getSettings();

      if (!settings.lastPaymentResetPeriod) {
        const synchronized = this.synchronizeCurrentPaymentStatus();
        const arrearsPolicy = this.enforceArrearsSubscriptionPolicy();
        this.settings.lastPaymentResetPeriod = currentPeriod;
        await this.withDatabaseWrite(() => this.sequelize.transaction(async (transaction) => {
          const options = { transaction };
          if (synchronized > 0 || arrearsPolicy.changed > 0) {
            await this.saveContacts(options);
            await this.saveReminders(options);
          }
          await this.saveSettings(options);
        }));
        return {
          reset: false,
          initialized: true,
          period: currentPeriod,
          count: synchronized,
          converted: arrearsPolicy.converted,
          restored: arrearsPolicy.restored,
        };
      }

      if (settings.lastPaymentResetPeriod === currentPeriod) {
        const arrearsPolicy = this.enforceArrearsSubscriptionPolicy();
        if (arrearsPolicy.changed > 0) {
          await this.withDatabaseWrite(() => this.sequelize.transaction(async (transaction) => {
            const options = { transaction };
            await this.saveContacts(options);
            if (arrearsPolicy.remindersAdded > 0 || arrearsPolicy.remindersRemoved > 0) {
              await this.saveReminders(options);
            }
          }));
        }
        return {
          reset: false,
          period: currentPeriod,
          count: 0,
          converted: arrearsPolicy.converted,
          restored: arrearsPolicy.restored,
        };
      }

      const count = await this.resetAllPaymentStatusUnlocked({ save: false });
      this.settings.lastPaymentResetPeriod = currentPeriod;
      await this.withDatabaseWrite(() => this.sequelize.transaction(async (transaction) => {
        const options = { transaction };
        await this.saveContacts(options);
        await this.saveReminders(options);
        await this.saveSettings(options);
      }));
      return { reset: true, period: currentPeriod, count };
    });
  }
}

// ===============================
// NOTIFICATION BOT
// ===============================

class NotificationBot {
  constructor(dataManager, activityLog, providerManager = null) {
    this.dataManager = dataManager;
    this.activityLog = activityLog;
    this.providerManager = providerManager || new WhatsAppProviderManager({ activityLog });
    this.statusCache = {
      selectedProvider: "baileys",
      whatsappProviderEnabled: true,
      isAvailable: false,
      deviceReady: false,
      outboundEnabled: false,
      transportError: "WhatsApp provider belum diinisialisasi",
      providers: {},
      transport: { configuredProviders: [], connectedProviders: [] },
    };
  }

  async initialize() {
    await this.providerManager.initialize();
    const status = await this.getTransportStatus();
    const level = status.deviceReady ? "info" : "warn";
    this.activityLog.push(
      level,
      "notification",
      status.deviceReady
        ? `WhatsApp siap melalui ${status.selectedProvider}`
        : `${status.selectedProvider} belum siap: ${status.transportError || "status tidak diketahui"}`
    );
    return status;
  }

  async sendMessage(phoneNumber, message, options = {}) {
    const settings = this.dataManager.getSettings();
    const result = await this.providerManager.sendMessage(phoneNumber, message, {
      minDelayMs: Math.max(0, Number(settings.waRandomDelayMinSeconds) || 0) * 1000,
      maxDelayMs: Math.max(0, Number(settings.waRandomDelayMaxSeconds) || 0) * 1000,
      ...options,
    });
    const deliveryConfirmed = result.deliveryStatus === "delivered" || result.deliveryStatus === "read";
    this.activityLog.push(deliveryConfirmed ? "info" : "warn", deliveryConfirmed ? "notification" : "notification.pending", deliveryConfirmed
      ? `Pesan terkirim via ${result.provider} ke ${normalizePhoneNumber(phoneNumber)}`
      : `Pesan diterima WhatsApp tetapi belum masuk ke perangkat tujuan ke ${normalizePhoneNumber(phoneNumber)}`, {
      phoneNumber: normalizePhoneNumber(phoneNumber),
      provider: result.provider,
      deliveryStatus: result.deliveryStatus || "accepted",
      messageId: result.messageId || null,
    });
    return result;
  }

  async checkPhoneNumber(phoneNumber) {
    return this.providerManager.checkPhoneNumber(phoneNumber);
  }

  async sendFile(phoneNumber, filePath, caption = "") {
    throw new Error("Pengiriman file WhatsApp tidak tersedia. Gunakan Telegram untuk backup file.");
  }

  async sendTelegramFile(chatId, filePath, caption = "") {
    return TelegramManager.sendDocument(chatId, filePath, caption);
  }

  async sendAdminBroadcast(title, body, options = {}) {
    const recipients = Array.isArray(options.recipients)
      ? [...new Set(options.recipients)]
      : this.dataManager.getAdminRecipients();
    if (recipients.length === 0) return [];

    const message = `*${title}*\n\n${body}`;
    const results = [];

    for (const phoneNumber of recipients) {
      try {
        const delivery = await this.sendMessage(phoneNumber, message, options.messageOptions || {});
        results.push({ phoneNumber, status: delivery.deliveryStatus || "accepted", deliveryStatus: delivery.deliveryStatus || "accepted" });
      } catch (error) {
        results.push({ phoneNumber, status: "failed", error: error.message });
      }
    }

    if (!options.silentLog) {
      this.activityLog.push("info", "broadcast", `${title} dikirim ke ${recipients.length} admin recipient(s)`);
    }
    return results;
  }

  async sendContactBroadcast(title, body, options = {}) {
    const contacts = this.dataManager.getContacts();
    if (contacts.length === 0) return [];

    const results = [];

    for (const contact of contacts) {
      try {
        const renderedBody =
          typeof options.renderMessage === "function"
            ? options.renderMessage(contact, body)
            : body;
        const message = `*${title}*\n\n${renderedBody}`;
        const delivery = await this.sendMessage(contact.phoneNumber, message);
        results.push({ phoneNumber: contact.phoneNumber, name: contact.name, status: delivery.deliveryStatus || "accepted", deliveryStatus: delivery.deliveryStatus || "accepted" });
      } catch (error) {
        results.push({ phoneNumber: contact.phoneNumber, name: contact.name, status: "failed", error: error.message });
      }
    }

    const successCount = results.filter((result) => ["sent", "delivered", "read"].includes(result.status)).length;
    const failedCount = results.filter((result) => result.status === "failed").length;

    if (!options.silentLog) {
      this.activityLog.push("info", "broadcast", `${title} dikirim ke ${successCount} contact(s), ${failedCount} gagal`);
    }
    return results;
  }

  getPaymentHotspotStatusText(contact) {
    const status = normalizeHotspotProvisioningStatus(
      contact?.hotspotProvisioningStatus,
      contact?.mikrotikUsername
        ? HOTSPOT_PROVISIONING_STATUS.ACTIVE
        : HOTSPOT_PROVISIONING_STATUS.NONE
    );
    const labels = {
      [HOTSPOT_PROVISIONING_STATUS.NONE]: "Belum tersedia",
      [HOTSPOT_PROVISIONING_STATUS.PENDING]: "Menunggu aktivasi",
      [HOTSPOT_PROVISIONING_STATUS.PROVISIONING]: "Sedang diaktifkan",
      [HOTSPOT_PROVISIONING_STATUS.ACTIVE]: "Aktif",
      [HOTSPOT_PROVISIONING_STATUS.FAILED]: "Aktivasi perlu diperiksa",
      [HOTSPOT_PROVISIONING_STATUS.DEACTIVATED]: "Nonaktif",
      [HOTSPOT_PROVISIONING_STATUS.DISABLED]: "Nonaktif",
      [HOTSPOT_PROVISIONING_STATUS.MISSING]: "Tidak tersedia di MikroTik",
      [HOTSPOT_PROVISIONING_STATUS.CHANGED]: "Perlu sinkronisasi",
    };
    return labels[status] || "Belum tersedia";
  }

  buildPaymentHotspotAccountDetails(contact, options = {}, settings = {}) {
    const storedContact = contact?.id && typeof this.dataManager.getContact === "function"
      ? this.dataManager.getContact(contact.id)
      : null;
    const account = { ...(contact || {}), ...(storedContact || {}) };
    const portalHotspot = contact?.id && typeof this.dataManager.getCustomerPortalData === "function"
      ? this.dataManager.getCustomerPortalData(contact.id)?.hotspot
      : null;
    const username = sanitizeInput(String(account.mikrotikUsername || portalHotspot?.username || ""));
    const password = sanitizeInput(String(account.mikrotikPassword || portalHotspot?.password || ""));
    if (!username || !password) return "";

    const profile = sanitizeInput(String(account.mikrotikProfile || portalHotspot?.profile || "")) || "-";
    const status = this.getPaymentHotspotStatusText({
      ...account,
      mikrotikUsername: username,
      hotspotProvisioningStatus: account.hotspotProvisioningStatus || portalHotspot?.status,
    });
    const activeUntilValue = (
      options.activeUntil
      || contact?.serviceActiveUntil
      || account.hotspotReactivationAt
      || portalHotspot?.activeUntil
    );
    const activeUntilDate = activeUntilValue ? new Date(activeUntilValue) : null;
    const activeUntil = !activeUntilDate || Number.isNaN(activeUntilDate.getTime())
      ? "-"
      : activeUntilDate.toLocaleString("id-ID", {
          day: "2-digit",
          month: "2-digit",
          year: "numeric",
          hour: "2-digit",
          minute: "2-digit",
          timeZone: this.dataManager.getTimezone(),
        });
    const template = sanitizeMultilineText(settings.paymentHotspotAccountMessageTemplate)
      || DEFAULT_SETTINGS.paymentHotspotAccountMessageTemplate;

    return template
      .replace(/{{\s*hotspotUsername\s*}}/gi, () => username)
      .replace(/{{\s*hotspotPassword\s*}}/gi, () => password)
      .replace(/{{\s*hotspotProfile\s*}}/gi, () => profile)
      .replace(/{{\s*hotspotStatus\s*}}/gi, () => status)
      .replace(/{{\s*activeUntil\s*}}/gi, () => activeUntil)
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  async sendPaymentNotification(contact, transactionId, paymentType = "DEFAULT", options = {}) {
    const paymentDate = options.paymentDate
      ? new Date(options.paymentDate)
      : (contact.paymentDate ? new Date(contact.paymentDate) : new Date());
    const formattedDate = paymentDate.toLocaleString("id-ID", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: this.dataManager.getTimezone(),
    });

    let statusText = "LUNAS";
    let noteText = "Pembayaran telah kami terima dan dicatat pada sistem.";
    const paymentAmount = Math.max(0, Math.floor(Number(options.paymentAmount) || 0));
    const remainingDebtAmount = Math.max(0, Math.floor(Number(options.remainingDebtAmount) || 0));
    const activeUntilDate = options.activeUntil ? new Date(options.activeUntil) : null;
    const formattedActiveUntil = activeUntilDate && !Number.isNaN(activeUntilDate.getTime())
      ? activeUntilDate.toLocaleString("id-ID", {
          day: "2-digit",
          month: "2-digit",
          year: "numeric",
          hour: "2-digit",
          minute: "2-digit",
          timeZone: this.dataManager.getTimezone(),
        })
      : "-";

    if (paymentType === "ARREARS-ONLY") {
      statusText = remainingDebtAmount > 0 ? "TUNGGAKAN DIBAYAR SEBAGIAN" : "TUNGGAKAN TERBAYAR";
      noteText = paymentAmount > 0
        ? `Pembayaran sebesar ${this.dataManager.formatPaymentAmount(paymentAmount)} telah dialokasikan ke tunggakan paling lama. Sisa tunggakan Anda adalah ${this.dataManager.formatPaymentAmount(remainingDebtAmount)}. Tagihan bulan berjalan tidak termasuk dalam pembayaran ini.`
        : "Pembayaran tunggakan telah kami terima. Tagihan bulan berjalan tidak termasuk dalam pembayaran ini.";
    } else if (paymentType === "CURRENT-ONLY") {
      statusText = "LUNAS (BULAN INI)";
      noteText = "Tagihan bulan berjalan telah lunas. Tidak ada tunggakan dari periode sebelumnya.";
    } else if (paymentType === "FULL-PAID") {
      statusText = "LUNAS";
      noteText = "Seluruh tagihan periode sebelumnya dan bulan berjalan telah lunas.";
    } else if (paymentType === PAYMENT_TYPES.ACTIVE_PERIOD) {
      statusText = "MASA AKTIF DIBELI";
      noteText = `Akun hotspot aktif sampai ${formattedActiveUntil}. Tunggakan lama tetap tersimpan dan perpanjangan otomatis masih dijeda.`;
    }

    const settings = this.dataManager.getSettings();
    let messageTemplate = sanitizeMultilineText(settings.paymentMessageTemplateCurrentOnly)
      || DEFAULT_SETTINGS.paymentMessageTemplateCurrentOnly;
    if (paymentType === PAYMENT_TYPES.ARREARS_ONLY) {
      messageTemplate = sanitizeMultilineText(settings.paymentMessageTemplateArrearsOnly)
        || DEFAULT_SETTINGS.paymentMessageTemplateArrearsOnly;
    } else if (paymentType === PAYMENT_TYPES.FULL_PAID) {
      messageTemplate = sanitizeMultilineText(settings.paymentMessageTemplateFullPaid)
        || DEFAULT_SETTINGS.paymentMessageTemplateFullPaid;
    } else if (paymentType === PAYMENT_TYPES.ACTIVE_PERIOD) {
      messageTemplate = sanitizeMultilineText(settings.paymentMessageTemplateActivePeriod)
        || DEFAULT_SETTINGS.paymentMessageTemplateActivePeriod;
    }
    const companyName = sanitizeInput(settings.companyName) || "Emmeril Hotspot";
    const supportSignature = sanitizeInput(settings.supportSignature) || "CS Emmeril Hotspot";
    const hotspotAccountDetails = this.buildPaymentHotspotAccountDetails(contact, options, settings);
    const placesHotspotAccount = /{{\s*hotspotAccountDetails\s*}}/i.test(messageTemplate);

    let message = messageTemplate
      .replace(/{{\s*name\s*}}/gi, () => contact.name || "-")
      .replace(/{{\s*transactionId\s*}}/gi, () => transactionId || "-")
      .replace(/{{\s*paymentDate\s*}}/gi, () => formattedDate)
      .replace(/{{\s*paymentAmount\s*}}/gi, () => this.dataManager.formatPaymentAmount(paymentAmount))
      .replace(/{{\s*remainingDebtAmount\s*}}/gi, () => this.dataManager.formatPaymentAmount(remainingDebtAmount))
      .replace(/{{\s*activeUntil\s*}}/gi, () => formattedActiveUntil)
      .replace(/{{\s*statusText\s*}}/gi, () => statusText)
      .replace(/{{\s*noteText\s*}}/gi, () => noteText)
      .replace(/{{\s*companyName\s*}}/gi, () => companyName)
      .replace(/{{\s*companyNameUpper\s*}}/gi, () => companyName.toUpperCase())
      .replace(/{{\s*supportSignature\s*}}/gi, () => supportSignature)
      .replace(/{{\s*hotspotAccountDetails\s*}}/gi, () => hotspotAccountDetails);
    if (hotspotAccountDetails && !placesHotspotAccount) {
      message = `${message}\n\n${hotspotAccountDetails}`;
    }
    message = message.replace(/\n{3,}/g, "\n\n").trim();

    await this.sendMessage(contact.phoneNumber, message, options);
    this.activityLog.push("info", "payment", `Notifikasi pembayaran terkirim ke ${contact.phoneNumber}`, {
      transactionId,
      contactId: contact.id,
    });
    return { phoneNumber: contact.phoneNumber, transactionId };
  }

  async sendBillingDebtReminder(contact, options = {}) {
    const contactState = typeof this.dataManager.hydrateContact === "function"
      ? this.dataManager.hydrateContact(contact)
      : contact;
    const currentStatus = String(
      contactState.currentPaymentStatus || contactState.paymentStatus || PAYMENT_STATUS.UNPAID
    ).toUpperCase();
    const debtCount = Math.max(0, Number(
      contactState.debtCount ?? contactState.debtPeriods?.length ?? 0
    ) || 0);
    const hasDebt = Boolean(contactState.hasDebt && debtCount > 0);

    const isOverdue = String(contactState.dueStatus || "").toUpperCase() === "OVERDUE";
    if (!hasDebt && (currentStatus !== PAYMENT_STATUS.UNPAID || !isOverdue)) {
      throw new Error("Pengingat hanya dapat dikirim untuk tagihan yang jatuh tempo atau memiliki tunggakan.");
    }

    const monthlyAmount = Math.max(0, Number(contactState.monthlyPaymentAmount) || 0);
    const currentAmount = currentStatus === PAYMENT_STATUS.UNPAID ? monthlyAmount : 0;
    const debtAmount = contactState.debtAmount === undefined
      ? monthlyAmount * debtCount
      : Math.max(0, Number(contactState.debtAmount) || 0);
    const totalAmount = currentAmount + debtAmount;
    const settings = this.dataManager.getSettings();
    const messageTemplate = sanitizeMultilineText(settings.billingReminderMessageTemplate)
      || DEFAULT_SETTINGS.billingReminderMessageTemplate;
    const companyName = sanitizeInput(settings.companyName) || "Emmeril Hotspot";
    const supportSignature = sanitizeInput(settings.supportSignature) || "CS Emmeril Hotspot";
    const { year, month } = getBillingPeriodParts(new Date(), this.dataManager.getTimezone());
    const debtPeriods = (contactState.debtPeriods || [])
      .map((period) => sanitizeInput(period.label || period.key || ""))
      .filter(Boolean)
      .join(", ") || contactState.debtPeriodLabel || "-";
    const dueDateValue = contactState.dueDate ? new Date(contactState.dueDate) : null;
    const dueDate = dueDateValue && !Number.isNaN(dueDateValue.getTime())
      ? dueDateValue.toLocaleString("id-ID", {
          day: "2-digit",
          month: "long",
          year: "numeric",
          hour: "2-digit",
          minute: "2-digit",
          timeZone: this.dataManager.getTimezone(),
        })
      : "Belum dijadwalkan";
    const formatAmount = (value) => this.dataManager.formatPaymentAmount(value);
    const variables = {
      name: contactState.name || "-",
      phoneNumber: contactState.phoneNumber || "-",
      monthlyAmount: formatAmount(monthlyAmount),
      currentAmount: formatAmount(currentAmount),
      debtAmount: formatAmount(debtAmount),
      totalAmount: formatAmount(totalAmount),
      debtCount: String(debtCount),
      debtPeriods,
      billingPeriod: formatBillingPeriodLabel(year, month),
      dueDate,
      companyName,
      companyNameUpper: companyName.toUpperCase(),
      supportSignature,
    };
    let message = messageTemplate;
    for (const [key, value] of Object.entries(variables)) {
      message = message.replace(new RegExp(`{{\\s*${key}\\s*}}`, "gi"), () => value);
    }

    const delivery = await this.sendMessage(contactState.phoneNumber, message, options);
    this.activityLog.push("info", "billing-reminder", `Pengingat tagihan terkirim ke ${contactState.phoneNumber}`, {
      contactId: contactState.id,
      debtCount,
      totalAmount,
      provider: delivery.provider,
    });
    return {
      phoneNumber: contactState.phoneNumber,
      debtCount,
      debtPeriods,
      monthlyAmount,
      currentAmount,
      debtAmount,
      totalAmount,
      provider: delivery.provider,
      messageId: delivery.messageId || null,
    };
  }

  async notifyAdminsIfEnabled(title, body) {
    const settings = this.dataManager.getSettings();
    if (!settings.notifyAdminsOnConnectionChange) return [];
    return this.sendAdminBroadcast(title, body, { silentLog: true });
  }

  getStatus() {
    const status = this.statusCache;
    const settings = this.dataManager.getSettings();
    return {
      ...status,
      transport: {
        ...status.transport,
        randomDelayMinMs: Math.max(0, Number(settings.waRandomDelayMinSeconds) || 0) * 1000,
        randomDelayMaxMs: Math.max(0, Number(settings.waRandomDelayMaxSeconds) || 0) * 1000,
      },
      telegramEnabled: TelegramManager.isConfigured(),
      telegramRecipients: TelegramManager.getChatIds().length,
    };
  }

  async getTransportStatus() {
    try {
      this.statusCache = await this.providerManager.getStatus();
      return this.getStatus();
    } catch (error) {
      return {
        ...this.getStatus(),
        state: "UNREACHABLE",
        isAvailable: false,
        deviceReady: false,
        transportError: error.message,
      };
    }
  }

  async resetPairing(instanceId = null) {
    const provider = await this.providerManager.currentProvider({ connect: false });
    if (provider.name !== "baileys" || typeof provider.resetPairing !== "function") {
      throw new Error("Reset pairing hanya tersedia untuk provider Baileys.");
    }
    await provider.resetPairing(instanceId);
    return this.getTransportStatus();
  }

  enableOutbound() {
    const provider = this.providerManager.providers.baileys;
    if (provider?.name === "baileys" && typeof provider.enableOutbound === "function") {
      return provider.enableOutbound();
    }
    return this.getStatus();
  }

  disableOutbound() {
    const provider = this.providerManager.providers.baileys;
    if (provider?.name === "baileys" && typeof provider.disableOutbound === "function") {
      return provider.disableOutbound();
    }
    return this.getStatus();
  }

  async reconnect() {
    this.statusCache = await this.providerManager.reconnect();
    return this.getStatus();
  }

  async testConnection() {
    this.statusCache = await this.providerManager.testConnection();
    return this.getStatus();
  }

  async shutdown() {
    return this.providerManager.shutdown();
  }
}

// ===============================
// WEB SERVER
// ===============================

class WebServer {
  constructor(notificationBot, dataManager, templateManager, activityLog, reminderScheduler, authManager, mikrotikService, hotspotReactivationScheduler, midtransService = null) {
    this.app = express();
    this.app.disable("x-powered-by");
    this.app.set("trust proxy", CONFIG.TRUST_PROXY);
    this.notificationBot = notificationBot;
    this.dataManager = dataManager;
    this.templateManager = templateManager;
    this.activityLog = activityLog;
    this.reminderScheduler = reminderScheduler;
    this.authManager = authManager;
    this.mikrotikService = mikrotikService;
    this.hotspotReactivationScheduler = hotspotReactivationScheduler;
    this.midtransService = midtransService || new MidtransService();
    this.hotspotProvisioningLock = new AsyncLock();
    this.activePeriodPurchaseLock = new AsyncLock();
    this.paymentGatewayLock = new AsyncLock();
    this.server = null;
    this.ready = true;
    this.setupRoutes();
  }

  buildNetworkMonitorView(monitors) {
    const contactsByHost = new Map();
    for (const contact of this.dataManager.getContacts()) {
      const hostKey = normalizeNetworkHost(contact.linkedApHost);
      if (!hostKey) continue;
      if (!contactsByHost.has(hostKey)) contactsByHost.set(hostKey, []);
      contactsByHost.get(hostKey).push({
        id: String(contact.id),
        name: contact.name || "-",
        phoneNumber: contact.phoneNumber || "",
        linkedApHost: contact.linkedApHost || "",
      });
    }

    const monitoredHosts = new Set();
    const rows = (Array.isArray(monitors) ? monitors : []).map((monitor) => {
      const hostKey = normalizeNetworkHost(monitor.host);
      if (hostKey) monitoredHosts.add(hostKey);
      const linkedContacts = [...(contactsByHost.get(hostKey) || [])]
        .sort((a, b) => a.name.localeCompare(b.name, "id-ID"));
      return {
        ...monitor,
        availableInNetwatch: true,
        linkedContacts,
        customerCount: linkedContacts.length,
        linkStatus: linkedContacts.length > 0 ? "LINKED" : "UNLINKED",
      };
    });

    for (const [hostKey, linkedContacts] of contactsByHost.entries()) {
      if (monitoredHosts.has(hostKey)) continue;
      rows.push({
        id: `missing:${hostKey}`,
        host: linkedContacts[0]?.linkedApHost || hostKey,
        status: "MISSING",
        since: "",
        comment: "AP tersimpan pada pelanggan tetapi tidak ditemukan di Netwatch.",
        interval: "",
        timeout: "",
        type: "",
        upScript: "",
        downScript: "",
        availableInNetwatch: false,
        linkedContacts: [...linkedContacts].sort((a, b) => a.name.localeCompare(b.name, "id-ID")),
        customerCount: linkedContacts.length,
        linkStatus: "MISSING",
      });
    }

    return rows.sort((a, b) => String(a.host || "").localeCompare(String(b.host || ""), "id-ID"));
  }

  async resolveContactNetworkLink(payload, currentContact = null) {
    if (!payload || payload.linkedApHost === undefined) return payload;

    const requestedHost = sanitizeInput(String(payload.linkedApHost || ""));
    if (!requestedHost) return { ...payload, linkedApHost: "" };
    if (currentContact
      && normalizeNetworkHost(requestedHost) === normalizeNetworkHost(currentContact.linkedApHost)) {
      return { ...payload, linkedApHost: currentContact.linkedApHost || requestedHost };
    }

    const monitors = await this.mikrotikService.getNetwatchStatus();
    const matchedMonitor = (Array.isArray(monitors) ? monitors : []).find(
      (monitor) => normalizeNetworkHost(monitor.host) === normalizeNetworkHost(requestedHost)
    );
    if (!matchedMonitor) {
      const error = new Error(`AP "${requestedHost}" tidak ditemukan di Netwatch. Muat ulang daftar AP lalu pilih kembali.`);
      error.statusCode = 409;
      throw error;
    }

    return {
      ...payload,
      linkedApHost: sanitizeInput(String(matchedMonitor.host || requestedHost)),
    };
  }

  async provisionHotspotContact(contact, options = {}) {
    return this.hotspotProvisioningLock.runExclusive(String(contact.id), async () => {
      const current = this.dataManager.getContact(contact.id);
      if (!current) throw new Error("Kontak tidak ditemukan.");
      if (!current.mikrotikUsername || !current.mikrotikProfile || !current.mikrotikPassword) {
        throw new Error("Data akun hotspot pelanggan belum lengkap.");
      }
      const provisioningStatus = normalizeHotspotProvisioningStatus(current.hotspotProvisioningStatus);
      const provisioningOperation = normalizeHotspotProvisioningOperation(
        current.hotspotProvisioningOperation,
        HOTSPOT_PROVISIONING_OPERATION.CREATE
      );
      // A failed CREATE may have reached MikroTik before the response or local
      // status was saved. Retry by reconciling that account, while ownership
      // checks in MikrotikService still protect genuinely foreign usernames.
      const adoptExisting = provisioningOperation === HOTSPOT_PROVISIONING_OPERATION.CREATE
        && provisioningStatus === HOTSPOT_PROVISIONING_STATUS.FAILED;
      const adoptExistingOwnerMismatch = Boolean(
        current.hotspotLastReactivatedAt
        || current.hotspotLastDeactivatedAt
        || current.hotspotLastSyncedAt
      );

      await this.dataManager.updateHotspotProvisioningStatus(
        current.id,
        HOTSPOT_PROVISIONING_STATUS.PROVISIONING,
        { error: "" }
      );

      let registered;
      let verified;
      let persisted;
      try {
        if (provisioningOperation === HOTSPOT_PROVISIONING_OPERATION.UPDATE) {
          const previous = current.hotspotProvisioningPrevious;
          if (!previous?.username) throw new Error("Data akun hotspot lama tidak tersedia untuk proses edit.");
          registered = await this.mikrotikService.updateHotspotCustomer({
            previousUsername: previous.username,
            previousPhoneNumber: previous.phoneNumber,
            name: current.name,
            phoneNumber: current.phoneNumber,
            profile: current.mikrotikProfile,
            username: current.mikrotikUsername,
            password: current.mikrotikPassword,
          });
        } else {
          registered = await this.mikrotikService.createHotspotCustomer({
            name: current.name,
            phoneNumber: current.phoneNumber,
            profile: current.mikrotikProfile,
            username: current.mikrotikUsername,
            password: current.mikrotikPassword,
            adoptExisting,
            adoptExistingOwnerMismatch,
          });
        }
        verified = await this.mikrotikService.verifyHotspotCustomer(registered);
        persisted = await this.dataManager.updateHotspotProvisioningStatus(
          current.id,
          HOTSPOT_PROVISIONING_STATUS.ACTIVE,
          { checkedAt: new Date().toISOString(), syncedAt: new Date().toISOString() }
        );
      } catch (error) {
        await this.dataManager.updateHotspotProvisioningStatus(
          current.id,
          HOTSPOT_PROVISIONING_STATUS.FAILED,
          { error: error.message, checkedAt: new Date().toISOString() }
        ).catch((statusError) => {
          this.activityLog.push("error", "storage", `Gagal menyimpan status provisioning ${current.mikrotikUsername}: ${statusError.message}`);
        });
        this.activityLog.push("error", "mikrotik", `Provisioning ${current.mikrotikUsername} gagal: ${error.message}`, {
          contactId: current.id,
          phoneNumber: current.phoneNumber,
        });

        const wrapped = new Error(`Data pelanggan tersimpan, tetapi akun hotspot gagal disinkronkan: ${error.message}`);
        wrapped.statusCode = 502;
        wrapped.cause = error;
        throw wrapped;
      }

      let notification = { sent: false };
      const sendCredentials = options.sendCredentials !== undefined
        ? parseBoolean(options.sendCredentials, false)
        : parseBoolean(current.hotspotSendCredentials, false);
      if (sendCredentials) {
        try {
          if (this.notificationBot.getStatus()?.whatsappProviderEnabled) {
            const message = `Yth. Bapak/Ibu *${registered.name}*,\n\nAkun hotspot Anda sudah berhasil dibuat.\n\nDetail Akun Hotspot:\n*Username:* ${registered.username}\n*Password:* ${registered.password}\n*Profile:* ${registered.profile}\n\nSilakan simpan data ini. Terimakasih.`;
            await this.notificationBot.sendMessage(registered.phoneNumber, message);
            notification = { sent: true };
          } else {
            notification = { sent: false, error: "Transport notifikasi belum online." };
          }
        } catch (error) {
          notification = { sent: false, error: error.message };
        }
      }

      this.activityLog.push("info", "mikrotik", `Pelanggan ${registered.name} aktif sebagai ${registered.username}`, {
        profile: registered.profile,
        phoneNumber: registered.phoneNumber,
        created: registered.created,
        operation: provisioningOperation,
        notification,
      });

      return {
        ...registered,
        operation: provisioningOperation,
        verified,
        contact: this.dataManager.toPublicContact(persisted.contact),
        pelanggan: persisted.pelanggan,
        notification,
      };
    });
  }

  async setHotspotContactDisabled(contact, disabled, options = {}) {
    return this.hotspotProvisioningLock.runExclusive(String(contact.id), async () => {
      const current = this.dataManager.getContact(contact.id);
      if (!current) throw new Error("Kontak tidak ditemukan.");
      if (!current.mikrotikUsername || !current.mikrotikProfile) {
        throw new Error("Data akun hotspot pelanggan belum lengkap.");
      }
      if (!disabled && !options.activePeriodPurchase) {
        const currentState = typeof this.dataManager.hydrateContact === "function"
          ? this.dataManager.hydrateContact(current)
          : current;
        if (currentState.billingPausedForArrears && currentState.hasDebt) {
          const error = new Error("Gunakan Beli masa aktif 1 bulan untuk mengaktifkan akun yang masih memiliki tunggakan.");
          error.statusCode = 409;
          throw error;
        }
      }
      const operation = disabled
        ? HOTSPOT_PROVISIONING_OPERATION.DISABLE
        : HOTSPOT_PROVISIONING_OPERATION.ENABLE;
      await this.dataManager.prepareHotspotLifecycleOperation(current.id, operation);
      await this.dataManager.updateHotspotProvisioningStatus(current.id, HOTSPOT_PROVISIONING_STATUS.PROVISIONING, { error: "" });
      let result;
      try {
        result = await this.mikrotikService.setHotspotUserDisabled(
          current.mikrotikUsername,
          current.phoneNumber,
          disabled
        );
      } catch (error) {
        await this.dataManager.updateHotspotProvisioningStatus(current.id, HOTSPOT_PROVISIONING_STATUS.FAILED, {
          error: error.message,
          checkedAt: new Date().toISOString(),
        }).catch((statusError) => {
          this.activityLog.push("error", "storage", `Gagal menyimpan status ${disabled ? "deaktivasi" : "aktivasi"} ${current.mikrotikUsername}: ${statusError.message}`);
        });
        const wrapped = new Error(`Akun hotspot gagal ${disabled ? "dinonaktifkan" : "diaktifkan"}: ${error.message}`);
        wrapped.statusCode = 502;
        wrapped.cause = error;
        throw wrapped;
      }

      let persisted;
      try {
        persisted = disabled
          ? await this.dataManager.markHotspotDisabled(current.id, result)
          : await this.dataManager.markHotspotEnabled(current.id, result, {
              at: options.at,
              activePeriodPurchase: options.activePeriodPurchase,
            });
      } catch (error) {
        try {
          await this.mikrotikService.setHotspotUserDisabled(
            current.mikrotikUsername,
            current.phoneNumber,
            !disabled
          );
        } catch (rollbackError) {
          this.activityLog.push("error", "mikrotik", `Rollback status akun hotspot ${current.mikrotikUsername} gagal: ${rollbackError.message}`, {
            contactId: current.id,
          });
          const wrapped = new Error("Status akun berubah di MikroTik tetapi database gagal diperbarui. Periksa akun secara manual.");
          wrapped.statusCode = 502;
          wrapped.cause = error;
          throw wrapped;
        }
        await this.dataManager.updateHotspotProvisioningStatus(current.id, HOTSPOT_PROVISIONING_STATUS.FAILED, {
          error: error.message,
          checkedAt: new Date().toISOString(),
        }).catch(() => {});
        const wrapped = new Error(`Status akun gagal disimpan dan perubahan MikroTik sudah dibatalkan: ${error.message}`);
        wrapped.statusCode = 500;
        wrapped.cause = error;
        throw wrapped;
      }

      this.activityLog.push("info", "mikrotik", `User hotspot ${current.mikrotikUsername} ${disabled ? "dinonaktifkan" : "diaktifkan"} oleh administrator`, {
        contactId: current.id,
        username: current.mikrotikUsername,
        activeSessionsKilled: result.activeSessionsKilled || 0,
      });
      return {
        operation: disabled ? "DISABLE" : "ENABLE",
        contact: persisted,
        username: result.username,
        disabled: Boolean(disabled),
        activeSessionsKilled: result.activeSessionsKilled || 0,
      };
    });
  }

  async purchaseActivePeriod(contactId) {
    return this.activePeriodPurchaseLock.runExclusive(String(contactId), async () => {
      const contact = this.dataManager.getContact(contactId);
      if (!contact) throw new Error("Kontak tidak ditemukan.");
      const hydrated = this.dataManager.hydrateContact(contact);
      if (!isRecurringSubscription(contact)) {
        throw new Error("Pembelian masa aktif hanya tersedia untuk pelanggan bulanan.");
      }
      if (!hydrated.billingPausedForArrears || !hydrated.hasDebt) {
        throw new Error("Pembelian masa aktif hanya tersedia saat perpanjangan dijeda karena tunggakan.");
      }
      if (!contact.mikrotikUsername || !contact.mikrotikProfile) {
        throw new Error("Data akun hotspot pelanggan belum lengkap.");
      }

      const now = new Date();
      const currentStatus = normalizeHotspotProvisioningStatus(
        contact.hotspotProvisioningStatus,
        HOTSPOT_PROVISIONING_STATUS.NONE
      );
      const currentEnd = new Date(contact.hotspotReactivationAt || 0);
      const canExtend = currentStatus === HOTSPOT_PROVISIONING_STATUS.ACTIVE
        && parseBoolean(contact.hotspotManualActivationWithArrears, false);
      const canActivate = currentStatus === HOTSPOT_PROVISIONING_STATUS.DISABLED;
      if (!canExtend && !canActivate) {
        const error = new Error("Akun hotspot harus nonaktif karena tunggakan atau sedang memakai masa aktif sementara.");
        error.statusCode = 409;
        throw error;
      }

      const activeFrom = canExtend && Number.isFinite(currentEnd.getTime()) && currentEnd.getTime() > now.getTime()
        ? currentEnd
        : now;
      const activeUntil = addMonthsSafely(activeFrom, 1, this.dataManager.getTimezone());
      const purchase = {
        id: `ACT-${Date.now()}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`,
        purchasedAt: now.toISOString(),
        activeFrom: activeFrom.toISOString(),
        activeUntil: activeUntil.toISOString(),
        paymentProvider: "manual",
      };

      let persisted;
      let operation;
      if (canExtend) {
        const recorded = await this.dataManager.recordActivePeriodPurchase(contact.id, purchase);
        persisted = recorded.contact;
        operation = "EXTEND";
      } else {
        const enabled = await this.setHotspotContactDisabled(contact, false, {
          at: now,
          activePeriodPurchase: purchase,
        });
        persisted = enabled.contact;
        operation = "ACTIVATE";
      }

      const storedPurchase = (persisted.activePeriodPurchases || [])
        .find((item) => String(item.id) === purchase.id);
      this.activityLog.push("info", "payment", `Masa aktif satu bulan ${operation === "EXTEND" ? "ditambahkan" : "dibeli"} untuk ${contact.mikrotikUsername}`, {
        contactId: contact.id,
        transactionId: purchase.id,
        amount: storedPurchase?.amount || contact.monthlyPaymentAmount,
        activeUntil: purchase.activeUntil,
        operation,
      });
      return {
        operation,
        purchase: storedPurchase || purchase,
        contact: persisted,
      };
    });
  }

  async deleteContactWithHotspot(contactId) {
    return this.hotspotProvisioningLock.runExclusive(String(contactId), async () => {
      const contact = this.dataManager.getContact(contactId);
      if (!contact) throw new Error("Kontak tidak ditemukan.");

      const username = sanitizeInput(contact.mikrotikUsername || "");
      let hotspotDeletion = {
        username: username || null,
        removedUsers: 0,
        activeSessionsKilled: 0,
        skipped: !username,
      };

      if (username) {
        try {
          hotspotDeletion = {
            ...await this.mikrotikService.deleteHotspotUser(username, contact.phoneNumber),
            skipped: false,
          };
        } catch (error) {
          const wrapped = new Error(`Data pelanggan belum dihapus karena akun hotspot gagal dihapus: ${error.message}`);
          wrapped.statusCode = 502;
          wrapped.cause = error;
          throw wrapped;
        }
      }

      let deleted;
      try {
        deleted = await this.dataManager.deleteContact(contact.id);
      } catch (error) {
        if (!username || hotspotDeletion.removedUsers < 1) throw error;

        const password = sanitizeInput(contact.mikrotikPassword || "")
          || String(contact.phoneNumber || "").slice(-5);
        try {
          if (!password || !contact.mikrotikProfile) {
            throw new Error("Data profile atau password hotspot tidak lengkap.");
          }
          await this.mikrotikService.reactivateHotspotUser({
            username,
            password,
            profile: contact.mikrotikProfile,
            phoneNumber: contact.phoneNumber,
          });
          if (normalizeHotspotProvisioningStatus(contact.hotspotProvisioningStatus) === HOTSPOT_PROVISIONING_STATUS.DISABLED) {
            await this.mikrotikService.setHotspotUserDisabled(username, contact.phoneNumber, true);
          }
        } catch (rollbackError) {
          this.activityLog.push("error", "mikrotik", `Rollback penghapusan akun hotspot ${username} gagal: ${rollbackError.message}`, {
            contactId: contact.id,
          });
          const wrapped = new Error("Akun hotspot sudah terhapus, tetapi data pelanggan gagal dihapus dan akun tidak dapat dipulihkan. Periksa MikroTik secara manual.");
          wrapped.statusCode = 502;
          wrapped.cause = error;
          throw wrapped;
        }

        const wrapped = new Error(`Data pelanggan gagal dihapus. Akun hotspot ${username} sudah dipulihkan.`);
        wrapped.statusCode = 500;
        wrapped.cause = error;
        throw wrapped;
      }

      this.activityLog.push("info", "mikrotik", username
        ? `Pelanggan dan akun hotspot ${username} dihapus`
        : `Pelanggan ${contact.name || contact.id} dihapus tanpa akun hotspot`, {
        contactId: contact.id,
        username: username || null,
        removedUsers: hotspotDeletion.removedUsers,
        activeSessionsKilled: hotspotDeletion.activeSessionsKilled,
      });
      return {
        ...deleted,
        deletedContact: typeof this.dataManager.toPublicContact === "function"
          ? this.dataManager.toPublicContact(deleted.deletedContact)
          : {
              id: deleted.deletedContact.id,
              name: deleted.deletedContact.name,
              phoneNumber: deleted.deletedContact.phoneNumber,
              mikrotikUsername: deleted.deletedContact.mikrotikUsername || "",
            },
        hotspot: hotspotDeletion,
      };
    });
  }

  async recoverHotspotAfterPayment(contact) {
    const currentState = this.dataManager.getContact(contact?.id) || contact;
    const hydratedState = currentState && typeof this.dataManager.hydrateContact === "function"
      ? this.dataManager.hydrateContact(currentState)
      : currentState;
    if (hydratedState?.hasDebt
      || String(hydratedState?.currentPaymentStatus || hydratedState?.paymentStatus || "UNPAID").toUpperCase() !== PAYMENT_STATUS.PAID) {
      return { attempted: false, reason: "outstanding_balance" };
    }
    if (!parseBoolean(currentState?.hotspotSuspendedForArrears, false)) {
      return { attempted: false, reason: "not_arrears_suspension" };
    }
    const password = sanitizeInput(contact?.mikrotikPassword || "")
      || String(contact?.phoneNumber || "").slice(-5);
    if (!contact?.id || !contact.mikrotikUsername || !contact.mikrotikProfile || !password) {
      return { attempted: false, reason: "incomplete_account" };
    }
    if (typeof this.mikrotikService.getHotspotUsers !== "function") {
      return { attempted: false, reason: "unsupported" };
    }

    const users = await this.mikrotikService.getHotspotUsers();
    const username = String(contact.mikrotikUsername).toLowerCase();
    const matchedUser = (users || []).find((user) => String(user.username || "").toLowerCase() === username) || null;
    const routerUser = matchedUser?.source === "active" ? null : matchedUser;
    if (routerUser && routerUser.disabled) {
      const result = await this.setHotspotContactDisabled(contact, false);
      return { attempted: true, action: "enabled", contact: result.contact, result };
    }
    if (routerUser) {
      const current = this.dataManager.getContact(contact.id) || contact;
      if (normalizeHotspotProvisioningStatus(current.hotspotProvisioningStatus) === HOTSPOT_PROVISIONING_STATUS.ACTIVE) {
        return { attempted: true, action: "already_active", contact: current };
      }
      const persisted = await this.dataManager.markHotspotEnabled(current.id, {
        password: current.mikrotikPassword,
        profile: current.mikrotikProfile,
      });
      return { attempted: true, action: "already_active", contact: persisted };
    }

    return this.hotspotProvisioningLock.runExclusive(String(contact.id), async () => {
      const current = this.dataManager.getContact(contact.id) || contact;
      await this.dataManager.prepareHotspotLifecycleOperation(current.id, HOTSPOT_PROVISIONING_OPERATION.ENABLE);
      await this.dataManager.updateHotspotProvisioningStatus(
        current.id,
        HOTSPOT_PROVISIONING_STATUS.PROVISIONING,
        { error: "" }
      );
      try {
        const registered = await this.mikrotikService.reactivateHotspotUser({
          username: current.mikrotikUsername,
          password,
          profile: current.mikrotikProfile,
          phoneNumber: current.phoneNumber,
        });
        await this.mikrotikService.verifyHotspotCustomer(registered);
        const persisted = await this.dataManager.markHotspotEnabled(current.id, registered);
        return { attempted: true, action: "created", contact: persisted, result: registered };
      } catch (error) {
        await this.dataManager.updateHotspotProvisioningStatus(current.id, HOTSPOT_PROVISIONING_STATUS.FAILED, {
          error: error.message,
          checkedAt: new Date().toISOString(),
        }).catch(() => {});
        throw error;
      }
    });
  }

  async changeCustomerHotspotPassword(contactId, currentPassword, requestedPassword) {
    return this.hotspotProvisioningLock.runExclusive(String(contactId), async () => {
      const account = this.dataManager.getCustomerPortalAccountByContactId(contactId);
      if (!account) throw new Error("Akun pelanggan tidak ditemukan.");
      const hotspotStatus = normalizeHotspotProvisioningStatus(
        account.contact.hotspotProvisioningStatus || account.pelanggan?.hotspotProvisioningStatus,
        account.contact.mikrotikUsername || account.pelanggan?.username
          ? HOTSPOT_PROVISIONING_STATUS.ACTIVE
          : HOTSPOT_PROVISIONING_STATUS.NONE
      );
      if (isHotspotAccountUnavailable(
        hotspotStatus,
        account.contact.hotspotProvisioningError || account.pelanggan?.hotspotProvisioningError
      )) {
        const error = new Error(getHotspotUnavailableMessage(
          hotspotStatus,
          account.contact.hotspotProvisioningError || account.pelanggan?.hotspotProvisioningError
        ));
        error.statusCode = 404;
        throw error;
      }

      const oldPassword = String(currentPassword || "");
      const originalPassword = String(
        account.contact.mikrotikPassword || account.pelanggan?.password || ""
      );
      const rawNewPassword = String(requestedPassword || "");
      const newPassword = sanitizeInput(rawNewPassword);
      if (!safeCompareString(oldPassword, originalPassword)) {
        const error = new Error("Password hotspot saat ini tidak sesuai.");
        error.statusCode = 403;
        throw error;
      }
      if (newPassword.length < 5 || newPassword.length > 64) {
        throw new Error("Password baru harus terdiri dari 5 sampai 64 karakter.");
      }
      if (newPassword !== rawNewPassword || !/^[\x21-\x7E]+$/.test(newPassword)) {
        throw new Error("Password baru tidak boleh mengandung spasi atau karakter khusus non-ASCII.");
      }
      if (safeCompareString(newPassword, originalPassword)) {
        throw new Error("Password baru harus berbeda dari password saat ini.");
      }
      if (!account.contact.mikrotikUsername || !account.contact.mikrotikProfile) {
        throw new Error("Data akun hotspot belum lengkap.");
      }

      const updateRouterPassword = (password) => this.mikrotikService.updateHotspotCustomer({
        previousUsername: account.contact.mikrotikUsername,
        previousPhoneNumber: account.contact.phoneNumber,
        name: account.contact.name,
        phoneNumber: account.contact.phoneNumber,
        profile: account.contact.mikrotikProfile,
        username: account.contact.mikrotikUsername,
        password,
      });

      try {
        await updateRouterPassword(newPassword);
      } catch (error) {
        const wrapped = new Error(`Password belum diubah karena sinkronisasi MikroTik gagal: ${error.message}`);
        wrapped.statusCode = 502;
        wrapped.cause = error;
        throw wrapped;
      }

      try {
        const portalData = await this.dataManager.updateCustomerHotspotPassword(
          contactId,
          oldPassword,
          newPassword
        );
        this.activityLog.push("info", "customer-hotspot", `Password hotspot diubah oleh pelanggan ${account.contact.mikrotikUsername}`, {
          contactId: account.contact.id,
        });
        return portalData;
      } catch (error) {
        try {
          await updateRouterPassword(originalPassword);
        } catch (rollbackError) {
          this.activityLog.push("error", "customer-hotspot", `Rollback password hotspot gagal untuk ${account.contact.mikrotikUsername}: ${rollbackError.message}`, {
            contactId: account.contact.id,
          });
          const wrapped = new Error("Password berubah di MikroTik tetapi database gagal diperbarui. Hubungi administrator segera.");
          wrapped.statusCode = 502;
          wrapped.cause = error;
          throw wrapped;
        }

        const wrapped = new Error(`Password gagal disimpan dan perubahan MikroTik sudah dibatalkan: ${error.message}`);
        wrapped.statusCode = 500;
        wrapped.cause = error;
        throw wrapped;
      }
    });
  }

  async reconcileMidtransTransaction(orderId) {
    if (!this.midtransService.isConfigured()) return { status: "DISABLED" };
    const localTransaction = this.dataManager.getPaymentGatewayTransaction(orderId);
    if (!localTransaction) return { status: "UNKNOWN_ORDER", orderId };

    const gatewayData = await this.midtransService.getTransactionStatus(orderId);
    if (!gatewayData.transaction_status) {
      const notFound = String(gatewayData.status_code || "") === "404"
        || /doesn't exist|not found/i.test(String(gatewayData.status_message || ""));
      if (notFound) {
        const createdAt = new Date(localTransaction.createdAt || 0).getTime();
        const withinRetryWindow = Number.isFinite(createdAt)
          && Date.now() - createdAt <= Math.max(60_000, Number(CONFIG.MIDTRANS_NOT_FOUND_RETRY_WINDOW) || 0);
        const transaction = await this.dataManager.updatePaymentGatewayTransaction(orderId, {
          // Keep it pending while Midtrans is still propagating the order.
          // This allows the minute scheduler and the next portal refresh to
          // verify it again automatically.
          status: withinRetryWindow ? PAYMENT_GATEWAY_STATUS.PENDING : PAYMENT_GATEWAY_STATUS.FAILED,
          gatewayStatus: "not_found",
          error: sanitizeInput(String(gatewayData.status_message || "Transaction not found")),
        });
        return { status: transaction.status, alreadyProcessed: false, transaction };
      }
      throw new Error(`Status transaksi Midtrans tidak tersedia: ${gatewayData.status_message || "unknown"}`);
    }
    if (String(gatewayData.order_id || "") !== String(orderId)) {
      throw new Error("Order ID hasil verifikasi Midtrans tidak sesuai.");
    }
    const status = normalizeMidtransPaymentStatus(
      gatewayData.transaction_status,
      gatewayData.fraud_status
    );

    if ([PAYMENT_GATEWAY_STATUS.REFUNDED, PAYMENT_GATEWAY_STATUS.PARTIALLY_REFUNDED].includes(status)) {
      const partial = status === PAYMENT_GATEWAY_STATUS.PARTIALLY_REFUNDED;
      const result = await this.paymentGatewayLock.runExclusive(String(orderId), () => (
        this.dataManager.refundMidtransPayment(orderId, gatewayData, { partial })
      ));
      if (!result.alreadyProcessed) {
        this.activityLog.push("warn", "payment", `Pembayaran Midtrans ${orderId} ${partial ? "direfund sebagian" : "direfund"}`, {
          contactId: result.contact.id,
          amount: localTransaction.amount,
          reversedPeriods: result.reversedPeriods,
        });
        if (typeof this.notificationBot.sendAdminBroadcast === "function") {
          await this.notificationBot.sendAdminBroadcast(
            partial ? "Refund sebagian Midtrans perlu ditinjau" : "Refund pembayaran Midtrans",
            `Order: ${orderId}\nPelanggan: ${result.contact.name || result.contact.id}\nNominal transaksi: ${localTransaction.amount}\nNominal refund: ${gatewayData.refund_amount || localTransaction.amount}\nPeriode dibatalkan: ${result.reversedPeriods.join(", ") || (partial ? "tidak dibatalkan otomatis" : "tidak ada (sudah ditimpa pembayaran lain)")}`
          ).catch((error) => {
            this.activityLog.push("error", "payment", `Notifikasi admin untuk refund ${orderId} gagal: ${error.message}`);
          });
        }
      }
      return {
        status,
        alreadyProcessed: result.alreadyProcessed,
        transaction: result.transaction,
        reversedPeriods: result.reversedPeriods,
      };
    }

    if (status === PAYMENT_GATEWAY_STATUS.PAID) {
      const result = await this.paymentGatewayLock.runExclusive(String(orderId), () => (
        this.dataManager.completeMidtransPayment(orderId, gatewayData)
      ));
      let hotspotRecovery = { attempted: false, reason: "incomplete_account" };
      try {
        hotspotRecovery = await this.recoverHotspotAfterPayment(result.contact);
        if (hotspotRecovery.attempted && hotspotRecovery.action !== "already_active") {
          this.activityLog.push("info", "payment", `Hotspot pelanggan dipulihkan setelah pembayaran ${orderId}`, {
            contactId: result.contact.id,
            action: hotspotRecovery.action,
          });
        }
      } catch (error) {
        hotspotRecovery = { attempted: true, action: "failed", error: error.message };
        this.activityLog.push("error", "payment", `Pembayaran ${orderId} lunas tetapi pemulihan hotspot gagal`, {
          contactId: result.contact.id,
          error: error.message,
        });
      }
      const notificationContact = hotspotRecovery.contact
        || (typeof this.dataManager.getContact === "function" ? this.dataManager.getContact(result.contact.id) : null)
        || result.contact;
      if (!result.alreadyProcessed && typeof this.notificationBot.sendPaymentNotification === "function") {
        await this.notificationBot.sendPaymentNotification(
          notificationContact,
          orderId,
          PAYMENT_TYPES.FULL_PAID,
          {
            paymentAmount: Math.max(0, Number(result.transaction?.amount || localTransaction.amount) || 0),
            paymentDate: result.transaction?.paidAt || new Date().toISOString(),
            remainingDebtAmount: Math.max(0, Number(notificationContact?.debtAmount) || 0),
            activeUntil: notificationContact?.serviceActiveUntil
              || notificationContact?.hotspotReactivationAt
              || null,
          }
        ).catch((error) => {
          this.activityLog.push("error", "payment", `Pembayaran ${orderId} lunas tetapi notifikasi WhatsApp gagal`, {
            error: error.message,
            contactId: result.contact.id,
          });
        });
      }
      this.activityLog.push("info", "payment", `Pembayaran Midtrans ${orderId} terverifikasi lunas`, {
        contactId: result.contact.id,
        amount: localTransaction.amount,
        alreadyProcessed: result.alreadyProcessed,
      });
      return { status, alreadyProcessed: result.alreadyProcessed, transaction: result.transaction, hotspotRecovery };
    }

    const updated = await this.dataManager.updatePaymentGatewayTransaction(orderId, {
      status,
      gatewayStatus: sanitizeInput(String(gatewayData.transaction_status || "pending")),
      transactionId: sanitizeInput(String(gatewayData.transaction_id || "")) || null,
      paymentMethod: sanitizeInput(String(gatewayData.payment_type || "")) || null,
    });
    return { status, alreadyProcessed: false, transaction: updated };
  }

  async reconcilePendingMidtransPayments(contactId = null) {
    if (!this.midtransService.isConfigured()) return { checked: 0, updated: 0, skipped: "disabled" };
    if (typeof this.dataManager.getPendingPaymentGatewayTransactions !== "function") {
      return { checked: 0, updated: 0, skipped: "unsupported" };
    }
    const pending = this.dataManager.getPendingPaymentGatewayTransactions(contactId);
    let updated = 0;
    const errors = [];
    for (const transaction of pending) {
      try {
        const result = await this.reconcileMidtransTransaction(transaction.orderId);
        if (result.status !== PAYMENT_GATEWAY_STATUS.PENDING) updated += 1;
      } catch (error) {
        errors.push({ orderId: transaction.orderId, error: error.message });
        this.activityLog.push("warn", "payment", `Rekonsiliasi Midtrans ${transaction.orderId} gagal: ${error.message}`);
      }
    }
    return { checked: pending.length, updated, errors };
  }

  setupRoutes() {
    this.app.use((req, res, next) => {
      const incomingRequestId = String(req.headers["x-request-id"] || "");
      req.requestId = /^[a-zA-Z0-9._:-]{1,128}$/.test(incomingRequestId)
        ? incomingRequestId
        : crypto.randomUUID();
      res.setHeader("X-Request-Id", req.requestId);
      res.setHeader(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
      );
      res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
      res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
      res.setHeader("X-DNS-Prefetch-Control", "off");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("X-Frame-Options", "DENY");
      res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
      if (CONFIG.NODE_ENV === "production" && req.secure) {
        res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
      }
      if (req.path.startsWith("/api/") || ["/login", "/dashboard", "/transport", "/pelanggan", "/pelanggan/login"].includes(req.path)) {
        res.setHeader("Cache-Control", "no-store");
      }
      next();
    });

    this.app.use((req, res, next) => {
      const startedAt = process.hrtime.bigint();
      res.on("finish", () => {
        if (res.statusCode < 400) return;
        const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
        this.activityLog.push(res.statusCode >= 500 ? "error" : "warn", "http", `${req.method} ${req.originalUrl} -> ${res.statusCode}`, {
          requestId: req.requestId,
          durationMs: Number(durationMs.toFixed(1)),
        });
      });
      next();
    });

    this.app.use(express.json({ limit: "1mb" }));
    this.app.use(express.urlencoded({ extended: true, limit: "1mb" }));

    this.app.use((req, res, next) => {
      if (!["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) return next();
      const transportFormPaths = new Set([
        "/transport/reset-pairing",
        "/transport/enable-sending",
        "/transport/disable-sending",
        "/transport/reconnect",
      ]);
      // Transport forms use a session-bound CSRF token because some reverse
      // proxies rewrite Origin on regular HTML form submissions.
      if (transportFormPaths.has(req.path)) return next();
      const origin = req.headers.origin;
      if (!origin) return next();

      try {
        const parsedOrigin = new URL(origin);
        const requestOrigin = new URL(`${req.protocol}://${req.get("host")}`).origin;
        const publicOrigin = CONFIG.PUBLIC_ORIGIN ? new URL(CONFIG.PUBLIC_ORIGIN).origin : "";
        if (parsedOrigin.origin === requestOrigin || (publicOrigin && parsedOrigin.origin === publicOrigin)) {
          return next();
        }
      } catch {
        // Invalid browser origins are rejected below.
      }

      return res.status(403).json({ success: false, error: "Cross-origin request ditolak." });
    });

    this.app.get("/healthz", (_req, res) => {
      res.setHeader("Cache-Control", "no-store");
      res.json({ status: "ok", uptimeSeconds: Math.floor(process.uptime()) });
    });

    this.app.get("/readyz", async (_req, res) => {
      res.setHeader("Cache-Control", "no-store");
      if (!this.ready) {
        return res.status(503).json({ status: "not_ready" });
      }

      try {
        if (typeof this.dataManager.healthCheck === "function") {
          await this.dataManager.healthCheck();
        }
        return res.json({ status: "ready" });
      } catch (error) {
        this.activityLog.push("error", "health", `Readiness check gagal: ${error.message}`);
        return res.status(503).json({ status: "not_ready" });
      }
    });

    this.app.get("/favicon.ico", (_req, res) => res.status(204).end());

    this.app.use("/public", (req, res, next) => {
      if (["/app.js", "/customer.js", "/customer.css", "/customer-login.js"].includes(req.path)) {
        res.setHeader("Cache-Control", "no-store, max-age=0");
      }
      next();
    }, express.static(CONFIG.PUBLIC_PATH, { etag: true, maxAge: "1h" }));
    this.app.get("/vendor/alpine.min.js", (_req, res) => {
      res.sendFile(require.resolve("alpinejs/dist/cdn.min.js"));
    });
    const fontAwesomePath = path.dirname(require.resolve("@fortawesome/fontawesome-free/package.json"));
    this.app.use("/vendor/fontawesome/css", express.static(path.join(fontAwesomePath, "css")));
    this.app.use("/vendor/fontawesome/webfonts", express.static(path.join(fontAwesomePath, "webfonts")));

    const hasApiKeyAccess = (req) => {
      const apiKey = req.headers["x-api-key"];
      const apiKeyIsConfigured = Boolean(CONFIG.WEB_API_KEY);
      return Boolean(apiKeyIsConfigured && apiKey && safeCompareString(apiKey, CONFIG.WEB_API_KEY));
    };

    const readSession = (req) => {
      const cookies = parseCookies(req.headers.cookie);
      const token = cookies[CONFIG.SESSION_COOKIE_NAME];
      const session = this.authManager.getSession(token);
      return { token, session };
    };

    const readCustomerSession = (req) => {
      const cookies = parseCookies(req.headers.cookie);
      const token = cookies[CONFIG.CUSTOMER_SESSION_COOKIE_NAME];
      const session = this.authManager.getCustomerSession(token);
      return { token, session };
    };

    const requireApiAuth = (req, res, next) => {
      if (hasApiKeyAccess(req)) {
        req.authUsingApiKey = true;
        return next();
      }

      const { session } = readSession(req);
      if (!session) {
        return res.status(401).json({ success: false, error: "Unauthorized" });
      }

      req.authSession = session;
      return next();
    };

    const requirePageAuth = (req, res, next) => {
      const { token, session } = readSession(req);
      if (!session) {
        return res.redirect("/login");
      }

      req.authSessionToken = token;
      req.authSession = session;
      return next();
    };

    const getTransportCsrfToken = (sessionToken) => crypto
      .createHmac("sha256", CONFIG.SESSION_SECRET)
      .update(`transport:${sessionToken}`)
      .digest("hex");

    const requireTransportFormAuth = (req, res, next) => {
      const { token, session } = readSession(req);
      if (!session) return res.redirect("/login");
      const submittedToken = sanitizeInput(String(req.body.csrfToken || ""));
      const expectedToken = getTransportCsrfToken(token);
      if (!submittedToken || !safeCompareString(submittedToken, expectedToken)) {
        return res.redirect(`/transport?error=${encodeURIComponent("Form sudah kedaluwarsa. Muat ulang halaman transport lalu coba lagi.")}`);
      }
      req.authSessionToken = token;
      req.authSession = session;
      return next();
    };

    const requireCustomerApiAuth = (req, res, next) => {
      const { token, session } = readCustomerSession(req);
      const portalData = session ? this.dataManager.getCustomerPortalData?.(session.contactId) : null;
      if (!session || !portalData || portalData.account.username !== session.username) {
        return res.status(401).json({ success: false, error: "Sesi pelanggan tidak valid. Silakan masuk kembali." });
      }
      req.customerSessionToken = token;
      req.customerSession = session;
      req.customerPortalData = portalData;
      return next();
    };

    const requireCustomerPageAuth = (req, res, next) => {
      const { session } = readCustomerSession(req);
      const portalData = session ? this.dataManager.getCustomerPortalData?.(session.contactId) : null;
      if (!session || !portalData || portalData.account.username !== session.username) {
        return res.redirect("/pelanggan/login");
      }
      req.customerSession = session;
      return next();
    };

    const handleApi = (handler) => async (req, res) => {
      try {
        const data = await handler(req, res);
        if (!res.headersSent) {
          res.json({ success: true, data });
        }
      } catch (error) {
        this.activityLog.push("error", "api", error.message);
        if (!res.headersSent) {
          const statusCode = error.statusCode || res.statusCode;
          res.status(statusCode >= 400 ? statusCode : 400).json({ success: false, error: error.message });
        }
      }
    };

    const requireRegisteredWhatsAppNumber = async (value) => {
      const phoneNumber = normalizePhoneNumber(value);
      if (!isValidPhoneNumber(phoneNumber)) {
        const error = new Error("Nomor WhatsApp harus berformat 628xxx.");
        error.statusCode = 400;
        throw error;
      }

      const result = await this.notificationBot.checkPhoneNumber(phoneNumber);
      if (!result.registered) {
        const error = new Error(`Nomor ${phoneNumber} tidak terdaftar di WhatsApp.`);
        error.code = "WHATSAPP_NUMBER_NOT_REGISTERED";
        error.statusCode = 422;
        throw error;
      }
      return result;
    };

    this.app.get("/", (req, res) => res.redirect("/dashboard"));
    this.app.get("/pelanggan/login", async (req, res, next) => {
      try {
        const { session } = readCustomerSession(req);
        const portalData = session ? this.dataManager.getCustomerPortalData?.(session.contactId) : null;
        if (session && portalData && portalData.account.username === session.username) {
          return res.redirect("/pelanggan");
        }
        res.send(await this.renderCustomerLoginPage());
      } catch (error) {
        next(error);
      }
    });

    this.app.post("/api/pelanggan/auth/login", handleApi(async (req, res) => {
      const username = sanitizeInput(req.body.username);
      const password = String(req.body.password || "");
      const sourceAddress = req.ip || req.socket?.remoteAddress || "unknown";
      const attemptKeys = [
        `customer-ip:${sourceAddress}`,
        `customer-account:${username.toLowerCase()}`,
      ];

      if (attemptKeys.some((key) => this.authManager.isLoginBlocked(key))) {
        const error = new Error("Terlalu banyak percobaan login. Coba lagi beberapa saat.");
        error.statusCode = 429;
        throw error;
      }

      const account = this.dataManager.findCustomerPortalAccount?.(username) || null;
      const passwordMatches = safeCompareString(password, account?.account?.password || "invalid-customer-password");
      if (!account || !passwordMatches) {
        attemptKeys.forEach((key) => this.authManager.recordLoginFailure(key));
        this.activityLog.push("warn", "customer-auth", `Login portal pelanggan gagal untuk ${username || "(kosong)"}`);
        const error = new Error("Username atau password salah.");
        error.statusCode = 401;
        throw error;
      }

      attemptKeys.forEach((key) => this.authManager.clearLoginFailures(key));
      const { token, session } = this.authManager.createCustomerSession({
        username: account.account.username,
        contactId: account.contact.id,
      });
      const secureCookie = CONFIG.SESSION_COOKIE_SECURE || req.secure;
      res.setHeader("Set-Cookie", serializeCookie(CONFIG.CUSTOMER_SESSION_COOKIE_NAME, token, {
        path: "/",
        httpOnly: true,
        sameSite: "Lax",
        secure: secureCookie,
        maxAge: Math.floor(CONFIG.SESSION_TTL / 1000),
      }));
      this.activityLog.push("info", "customer-auth", `Login portal sukses untuk ${account.account.username}`, {
        contactId: account.contact.id,
      });
      return {
        username: session.username,
        name: account.contact.name,
        expiresAt: new Date(session.expiresAt).toISOString(),
      };
    }));

    this.app.post("/api/pelanggan/auth/logout", handleApi(async (req, res) => {
      const { token, session } = readCustomerSession(req);
      this.authManager.destroyCustomerSession(token);
      const secureCookie = CONFIG.SESSION_COOKIE_SECURE || req.secure;
      res.setHeader("Set-Cookie", serializeCookie(CONFIG.CUSTOMER_SESSION_COOKIE_NAME, "", {
        path: "/",
        httpOnly: true,
        sameSite: "Lax",
        secure: secureCookie,
        maxAge: 0,
      }));
      if (session) {
        this.activityLog.push("info", "customer-auth", `Logout portal untuk ${session.username}`);
      }
      return { loggedOut: true };
    }));

    this.app.get("/api/pelanggan/account", requireCustomerApiAuth, handleApi(async (req) => {
      await this.reconcilePendingMidtransPayments(req.customerSession.contactId);
      const contact = typeof this.dataManager.getContact === "function"
        ? this.dataManager.getContact(req.customerSession.contactId)
        : null;
      if (contact) {
        const hydrated = typeof this.dataManager.hydrateContact === "function"
          ? this.dataManager.hydrateContact(contact)
          : contact;
        const hotspotStatus = normalizeHotspotProvisioningStatus(contact.hotspotProvisioningStatus);
        const recoveryFailed = hotspotStatus === HOTSPOT_PROVISIONING_STATUS.FAILED
          && contact.hotspotProvisioningOperation === HOTSPOT_PROVISIONING_OPERATION.ENABLE;
        if (hydrated.currentPaymentStatus === PAYMENT_STATUS.PAID
          && !hydrated.hasDebt
          && (isHotspotAccountUnavailable(hotspotStatus, contact.hotspotProvisioningError) || recoveryFailed)) {
          await this.recoverHotspotAfterPayment(contact).catch((error) => {
            this.activityLog.push("error", "payment", `Retry pemulihan hotspot pelanggan ${contact.id} gagal`, {
              contactId: contact.id,
              error: error.message,
            });
          });
        }
      }
      return this.dataManager.getCustomerPortalData(req.customerSession.contactId);
    }));
    this.app.post("/api/pelanggan/payments/midtrans", requireCustomerApiAuth, handleApi(async (req) => {
      if (!this.midtransService.isConfigured()) {
        const error = new Error("Pembayaran Midtrans belum diaktifkan oleh administrator.");
        error.statusCode = 503;
        throw error;
      }

      const amount = Math.floor(Number(req.customerPortalData.billing?.totalAmount) || 0);
      const periods = (req.customerPortalData.billing?.history || [])
        .filter((payment) => payment.status !== PAYMENT_STATUS.PAID)
        .map((payment) => payment.period);
      if (amount <= 0 || periods.length === 0) {
        throw new Error("Tidak ada tagihan yang perlu dibayar.");
      }

      return this.paymentGatewayLock.runExclusive(
        `create:${req.customerSession.contactId}`,
        async () => {
          const reusable = await this.dataManager.findReusablePaymentGatewayTransaction?.({
            contactId: req.customerSession.contactId,
            amount,
            periods,
          });
          if (reusable) {
            return {
              orderId: reusable.orderId,
              redirectUrl: reusable.redirectUrl,
              amount: reusable.amount,
              reused: true,
            };
          }

          const orderId = `RB-${Date.now()}-${crypto.randomBytes(5).toString("hex").toUpperCase()}`;
          const transaction = await this.dataManager.createPaymentGatewayTransaction({
            orderId,
            contactId: req.customerSession.contactId,
            amount,
            periods,
          });
          const fallbackFinishUrl = `${req.protocol}://${req.get("host")}/pelanggan?payment=finish`;
          const finishUrl = CONFIG.MIDTRANS_FINISH_URL || fallbackFinishUrl;

          try {
            const snap = await this.midtransService.createSnapTransaction({
              orderId,
              amount,
              customer: req.customerPortalData.customer,
              itemName: `Tagihan internet ${req.customerPortalData.billing.periodLabel}`,
              finishUrl,
            });
            await this.dataManager.updatePaymentGatewayTransaction(orderId, {
              token: sanitizeInput(String(snap.token || "")) || null,
              redirectUrl: String(snap.redirect_url || ""),
              gatewayStatus: "pending",
            });
            if (!snap.redirect_url) throw new Error("Midtrans tidak mengembalikan URL pembayaran.");
            this.activityLog.push("info", "payment", `Transaksi Midtrans ${orderId} dibuat`, {
              contactId: transaction.contactId,
              amount,
              environment: CONFIG.MIDTRANS_IS_PRODUCTION ? "production" : "sandbox",
            });
            return { orderId, redirectUrl: snap.redirect_url, amount, reused: false };
          } catch (error) {
            await this.dataManager.updatePaymentGatewayTransaction(orderId, {
              status: PAYMENT_GATEWAY_STATUS.FAILED,
              gatewayStatus: "create_failed",
              error: sanitizeInput(error.message),
            }).catch(() => {});
            throw error;
          }
        }
      );
    }));

    this.app.post("/api/payments/midtrans/notification", handleApi(async (req) => {
      if (!this.midtransService.verifyNotificationSignature(req.body || {})) {
        const error = new Error("Signature notifikasi Midtrans tidak valid.");
        error.statusCode = 403;
        throw error;
      }

      const orderId = sanitizeInput(String(req.body.order_id || ""));
      if (!this.dataManager.getPaymentGatewayTransaction(orderId)) {
        this.activityLog.push("warn", "payment", `Notifikasi Midtrans untuk transaksi tidak dikenal ${orderId}`);
        return { received: true, ignored: "unknown_order" };
      }
      const result = await this.reconcileMidtransTransaction(orderId);
      return { received: true, status: result.status, alreadyProcessed: result.alreadyProcessed };
    }));

    this.app.put("/api/pelanggan/account/password", requireCustomerApiAuth, handleApi(async (req) => {
      const currentPassword = String(req.body.currentPassword || "");
      const newPassword = String(req.body.newPassword || "");
      const confirmation = String(req.body.confirmPassword || "");
      if (!currentPassword || !newPassword || !confirmation) {
        throw new Error("Password saat ini, password baru, dan konfirmasi wajib diisi.");
      }
      if (!safeCompareString(newPassword, confirmation)) {
        throw new Error("Konfirmasi password baru tidak sama.");
      }

      const portalData = await this.dataManager.updateCustomerPortalPassword(
        req.customerSession.contactId,
        currentPassword,
        newPassword
      );
      this.authManager.destroyCustomerSessionsForContact(
        req.customerSession.contactId,
        req.customerSessionToken
      );
      this.activityLog.push("info", "customer-auth", `Password akun pelanggan diubah untuk ${req.customerSession.username}`, {
        contactId: req.customerSession.contactId,
      });
      return portalData;
    }));
    this.app.put("/api/pelanggan/hotspot/password", requireCustomerApiAuth, handleApi(async (req) => {
      const currentPassword = String(req.body.currentPassword || "");
      const newPassword = String(req.body.newPassword || "");
      const confirmation = String(req.body.confirmPassword || "");
      if (!currentPassword || !newPassword || !confirmation) {
        throw new Error("Password saat ini, password baru, dan konfirmasi wajib diisi.");
      }
      if (!safeCompareString(newPassword, confirmation)) {
        throw new Error("Konfirmasi password baru tidak sama.");
      }

      const portalData = await this.changeCustomerHotspotPassword(
        req.customerSession.contactId,
        currentPassword,
        newPassword
      );
      this.authManager.destroyCustomerSessionsForContact(
        req.customerSession.contactId,
        req.customerSessionToken
      );
      return portalData;
    }));
    this.app.get("/pelanggan", requireCustomerPageAuth, async (_req, res, next) => {
      try {
        res.send(await this.renderCustomerPortal());
      } catch (error) {
        next(error);
      }
    });

    this.app.get("/login", async (req, res, next) => {
      try {
        const { session } = readSession(req);
        if (session) {
          return res.redirect("/dashboard");
        }
        res.send(await this.renderLoginPage());
      } catch (error) {
        next(error);
      }
    });

    this.app.post("/api/auth/login", handleApi(async (req, res) => {
      const username = sanitizeInput(req.body.username);
      const password = String(req.body.password || "");
      const attemptKey = req.ip || req.socket?.remoteAddress || "unknown";

      if (this.authManager.isLoginBlocked(attemptKey)) {
        const error = new Error("Terlalu banyak percobaan login. Coba lagi beberapa saat.");
        error.statusCode = 429;
        throw error;
      }

      if (!this.authManager.validateCredentials(username, password)) {
        this.authManager.recordLoginFailure(attemptKey);
        this.activityLog.push("error", "auth", `Login gagal untuk user ${username || "(kosong)"}`);
        const error = new Error("Username atau password salah.");
        error.statusCode = 401;
        throw error;
      }

      this.authManager.clearLoginFailures(attemptKey);
      const { token, session } = this.authManager.createSession(username);
      const secureCookie = CONFIG.SESSION_COOKIE_SECURE || req.secure;
      res.setHeader("Set-Cookie", serializeCookie(CONFIG.SESSION_COOKIE_NAME, token, {
        path: "/",
        httpOnly: true,
        sameSite: "Lax",
        secure: secureCookie,
        maxAge: Math.floor(CONFIG.SESSION_TTL / 1000),
      }));

      this.activityLog.push("info", "auth", `Login sukses untuk user ${username}`);
      return {
        username: session.username,
        expiresAt: new Date(session.expiresAt).toISOString(),
      };
    }));

    this.app.post("/api/auth/logout", handleApi(async (req, res) => {
      const { token, session } = readSession(req);
      this.authManager.destroySession(token);
      const secureCookie = CONFIG.SESSION_COOKIE_SECURE || req.secure;
      res.setHeader("Set-Cookie", serializeCookie(CONFIG.SESSION_COOKIE_NAME, "", {
        path: "/",
        httpOnly: true,
        sameSite: "Lax",
        secure: secureCookie,
        maxAge: 0,
      }));

      if (session) {
        this.activityLog.push("info", "auth", `Logout untuk user ${session.username}`);
      }

      return { loggedOut: true };
    }));

    this.app.get("/api/auth/me", requireApiAuth, handleApi(async (req) => ({
      username: req.authSession?.username || null,
      expiresAt: req.authSession ? new Date(req.authSession.expiresAt).toISOString() : null,
      usingApiKey: Boolean(req.authUsingApiKey),
    })));

    this.app.get("/dashboard", requirePageAuth, async (req, res, next) => {
      try {
        res.send(await this.renderDashboard());
      } catch (error) {
        next(error);
      }
    });
    this.app.post("/transport/reset-pairing", requireTransportFormAuth, async (req, res) => {
      try {
        const instanceId = sanitizeInput(req.body.instanceId) || null;
        if (sanitizeInput(req.body.confirmReset).toLowerCase() !== "yes") {
          throw new Error("Centang konfirmasi sebelum menghapus sesi dan membuat QR baru.");
        }
        await this.notificationBot.resetPairing(instanceId);
        this.activityLog.push("info", "notification", `Pairing Baileys ${instanceId || "primary"} direset tanpa restart aplikasi`);
        return res.redirect(`/transport?pairingReset=1${instanceId ? `&instance=${encodeURIComponent(instanceId)}` : ""}`);
      } catch (error) {
        this.activityLog.push("error", "notification", `Gagal mereset pairing Baileys: ${error.message}`);
        return res.redirect(`/transport?error=${encodeURIComponent(error.message)}`);
      }
    });
    this.app.post("/transport/enable-sending", requireTransportFormAuth, async (req, res) => {
      try {
        this.notificationBot.enableOutbound();
        this.activityLog.push("info", "notification", "Pengiriman WhatsApp diaktifkan manual dari halaman transport");
        return res.redirect("/transport?sendingEnabled=1");
      } catch (error) {
        this.activityLog.push("error", "notification", `Gagal mengaktifkan pengiriman WhatsApp: ${error.message}`);
        return res.redirect(`/transport?error=${encodeURIComponent(error.message)}`);
      }
    });
    this.app.post("/transport/disable-sending", requireTransportFormAuth, (req, res) => {
      this.notificationBot.disableOutbound();
      this.activityLog.push("info", "notification", "Pengiriman WhatsApp dijeda manual dari halaman transport");
      return res.redirect("/transport?sendingDisabled=1");
    });
    this.app.post("/transport/reconnect", requireTransportFormAuth, async (_req, res) => {
      try {
        await this.notificationBot.reconnect();
        return res.redirect("/transport");
      } catch (error) {
        return res.redirect(`/transport?error=${encodeURIComponent(error.message)}`);
      }
    });
    this.app.get("/transport", requirePageAuth, async (req, res) => {
      const csrfToken = getTransportCsrfToken(req.authSessionToken);
      const status = await this.notificationBot.getTransportStatus();
      if (status.whatsappProviderEnabled) {
        const instances = Array.isArray(status.instances) && status.instances.length > 0
          ? status.instances
          : [{
              id: "primary",
              role: "primary",
              connected: status.deviceReady,
              canSend: status.outboundEnabled,
              account: status.account,
              currentQR: status.currentQR,
              detail: status.transportError,
            }];
        const instanceCards = await Promise.all(instances.map(async (instance) => {
          const qrDataUrl = instance.currentQR
            ? await QRCode.toDataURL(instance.currentQR, { width: 280, margin: 2, errorCorrectionLevel: "M" })
            : null;
          const stateClass = instance.connected ? "connected" : (qrDataUrl ? "pairing" : "disconnected");
          return `
            <section class="connection-card">
              <div class="connection-heading">
                <div><strong>${escapeHtml(instance.id)}</strong><small>${escapeHtml(instance.role || "backup")}</small></div>
                <span class="status-badge ${stateClass}">${instance.connected ? (instance.id === status.activeInstanceId ? "Aktif" : "Siaga") : (qrDataUrl ? "Perlu QR" : "Terputus")}</span>
              </div>
              ${instance.account ? `<p class="account"><span>Akun terhubung</span><strong>${escapeHtml(instance.account)}</strong></p>` : ""}
              ${instance.detail ? `<p class="connection-detail">${escapeHtml(instance.detail)}</p>` : ""}
              ${qrDataUrl ? `<div class="qr-panel"><img src="${qrDataUrl}" alt="Kode QR untuk menghubungkan ${escapeHtml(instance.id)}" width="280" height="280"><p>Pindai melalui menu Perangkat tertaut di WhatsApp.</p></div>` : ""}
              <form method="post" action="/transport/reset-pairing" class="reset-form">
                <input type="hidden" name="csrfToken" value="${csrfToken}">
                <input type="hidden" name="instanceId" value="${escapeHtml(instance.id)}">
                <label>
                  <input type="checkbox" name="confirmReset" value="yes" required>
                  <span>Saya paham sesi ${escapeHtml(instance.id)} akan dihapus dan harus memindai QR lagi.</span>
                </label>
                <button type="submit" class="button danger-secondary">Hapus sesi dan buat QR baru</button>
              </form>
            </section>
          `;
        }));
        const sendingEnabled = req.query.sendingEnabled === "1";
        const sendingDisabled = req.query.sendingDisabled === "1";
        const pairingReset = req.query.pairingReset === "1";
        const error = sanitizeInput(req.query.error);
        const connectedCount = instances.filter((item) => item.connected).length;
        return res.status(status.deviceReady ? 200 : 503).send(`
          <!doctype html>
          <html lang="id">
          <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width,initial-scale=1">
            <title>Status WhatsApp</title>
            <style>
              :root{--primary:#2563eb;--primary-dark:#1d4ed8;--ink:#182230;--muted:#667085;--border:#e4e7ec;--canvas:#f6f7f9;--success:#15803d;--warning:#9a6700;--danger:#b42318}*{box-sizing:border-box}body{min-height:100vh;margin:0;color:var(--ink);background:var(--canvas);font:14px/1.5 Inter,"Segoe UI",Roboto,Arial,sans-serif;-webkit-font-smoothing:antialiased}.transport-page{width:min(960px,calc(100% - 40px));margin:0 auto;padding:28px 0 44px}.topbar{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:28px}.brand{display:flex;align-items:center;gap:11px;color:inherit;text-decoration:none}.brand-mark{display:inline-flex;width:38px;height:38px;align-items:center;justify-content:center;color:#fff;border-radius:9px;background:var(--primary);font-size:18px;font-weight:800}.brand-copy{display:flex;flex-direction:column}.brand-copy strong{font-size:14px}.brand-copy small{margin-top:1px;color:var(--muted);font-size:11px}.top-actions{display:flex;gap:8px}.button{display:inline-flex;min-height:44px;align-items:center;justify-content:center;gap:7px;padding:9px 13px;color:#344054;border:1px solid var(--border);border-radius:8px;background:#fff;font-family:inherit;font-size:13px;font-weight:700;line-height:1.2;text-decoration:none;cursor:pointer}.button:hover{border-color:#bfdbfe;background:#eff6ff}.button.primary{color:#fff;border-color:var(--primary);background:var(--primary)}.button.primary:hover{background:var(--primary-dark)}.button.danger{color:#fff;border-color:var(--danger);background:var(--danger)}.button.danger-secondary{color:var(--danger);border-color:#f0c7c3;background:#fff}.button.danger-secondary:hover{background:#fff7f6}.page-heading{margin-bottom:20px}.eyebrow{margin:0 0 6px;color:var(--primary-dark);font-size:11px;font-weight:800;text-transform:uppercase}.page-heading h1{margin:0;font-size:clamp(25px,4vw,32px);line-height:1.2}.page-heading p{max-width:680px;margin:8px 0 0;color:var(--muted)}.notice{margin:0 0 12px;padding:11px 13px;border:1px solid;border-radius:8px;font-weight:650}.notice.success{color:var(--success);border-color:#bbdec7;background:#f2fbf5}.notice.warning{color:#805600;border-color:#f2d28d;background:#fffaf0}.notice.error{color:var(--danger);border-color:#f0c7c3;background:#fff7f6}.summary-bar{display:flex;align-items:center;justify-content:space-between;gap:18px;margin:18px 0;padding:15px 16px;border:1px solid var(--border);border-radius:10px;background:#fff}.summary-bar strong{display:block;font-size:15px}.summary-bar p{margin:3px 0 0;color:var(--muted);font-size:12px}.summary-status{display:flex;align-items:center;gap:8px;white-space:nowrap}.summary-status::before{width:8px;height:8px;border-radius:50%;background:${status.outboundEnabled ? "#16a34a" : "#d97706"};content:""}.connection-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px}.connection-card{min-width:0;padding:18px;border:1px solid var(--border);border-radius:10px;background:#fff}.connection-heading{display:flex;align-items:center;justify-content:space-between;gap:12px}.connection-heading strong{font-size:16px}.connection-heading small{display:block;margin-top:2px;color:var(--muted);font-size:10px;font-weight:750;text-transform:uppercase}.status-badge{padding:5px 8px;border-radius:6px;font-size:11px;font-weight:750}.status-badge.connected{color:var(--success);background:#edf8f1}.status-badge.pairing{color:var(--warning);background:#fff7e6}.status-badge.disconnected{color:var(--danger);background:#fff0ef}.account{display:flex;justify-content:space-between;gap:12px;margin:16px 0 0;padding:10px 11px;border-radius:8px;background:#f8fafc}.account span{color:var(--muted);font-size:12px}.account strong{overflow-wrap:anywhere;font-size:12px;text-align:right}.connection-detail{margin:12px 0 0;color:var(--muted);font-size:12px}.qr-panel{margin-top:16px;text-align:center}.qr-panel img{display:block;width:min(100%,280px);height:auto;margin:auto;border:1px solid var(--border);border-radius:8px}.qr-panel p{margin:9px 0 0;color:var(--muted);font-size:12px}.reset-form{margin-top:18px;padding-top:16px;border-top:1px solid var(--border)}.reset-form label{display:flex;align-items:flex-start;gap:9px;margin-bottom:12px;color:#7a342d;font-size:12px}.reset-form input{width:17px;height:17px;flex:0 0 17px;margin:1px 0 0;accent-color:var(--danger)}.sending-panel{display:flex;align-items:center;justify-content:space-between;gap:20px;margin-top:12px;padding:18px;border:1px solid var(--border);border-radius:10px;background:#fff}.sending-panel h2{margin:0;font-size:16px}.sending-panel p{max-width:600px;margin:5px 0 0;color:var(--muted);font-size:12px}.sending-actions{display:flex;flex:0 0 auto;gap:8px}.helper{margin:18px 0 0;padding:13px 15px;color:var(--muted);border-left:3px solid #bfdbfe;background:#f8fbff;font-size:12px}.disabled-card{max-width:560px;margin:15vh auto 0;padding:24px;border:1px solid var(--border);border-radius:10px;background:#fff}.disabled-card h1{margin:0 0 8px;font-size:22px}.disabled-card p{margin:0 0 18px;color:var(--muted)}:focus-visible{outline:3px solid #2563eb;outline-offset:2px}@media(max-width:640px){.transport-page{width:min(100% - 20px,960px);padding-top:14px}.topbar{align-items:flex-start;margin-bottom:22px}.brand-copy small{display:none}.top-actions{flex-direction:column}.page-heading{margin-bottom:16px}.summary-bar,.sending-panel{align-items:flex-start;flex-direction:column}.sending-actions{width:100%;flex-direction:column}.sending-actions form,.sending-actions .button{width:100%}.connection-card{padding:15px}.reset-form .button{width:100%}}@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important;transition:none!important}}
            </style>
          </head>
          <body>
            <main class="transport-page">
              <header class="topbar">
                <a class="brand" href="/dashboard"><span class="brand-mark">R</span><span class="brand-copy"><strong>Reminder Bot</strong><small>Pengaturan koneksi</small></span></a>
                <nav class="top-actions" aria-label="Aksi halaman"><a class="button" href="/dashboard">Kembali</a><a class="button" href="/transport">Muat ulang</a></nav>
              </header>
              <section class="page-heading">
                <p class="eyebrow">Kanal pengiriman</p>
                <h1>Status WhatsApp</h1>
                <p>Pantau koneksi, atur pengiriman, atau pindai ulang QR bila perangkat terputus.</p>
              </section>
              ${sendingEnabled ? '<p class="notice success" role="status">Pengiriman WhatsApp sudah diaktifkan.</p>' : ""}
              ${sendingDisabled ? '<p class="notice warning" role="status">Pengiriman WhatsApp sudah dijeda.</p>' : ""}
              ${pairingReset ? '<p class="notice success" role="status">Sesi dihapus. QR baru sedang disiapkan; muat ulang halaman beberapa saat lagi.</p>' : ""}
              ${error ? `<p class="notice error" role="alert">${escapeHtml(error)}</p>` : ""}
              <section class="summary-bar" aria-label="Ringkasan koneksi">
                <div><strong>${connectedCount} dari ${instances.length} koneksi terhubung</strong><p>Satu koneksi aktif digunakan dan sistem dapat berpindah ke koneksi cadangan.</p></div>
                <span class="summary-status">Pengiriman ${status.outboundEnabled ? "aktif" : "dijeda"}</span>
              </section>
              <div class="connection-grid">${instanceCards.join("")}</div>
              <section class="sending-panel">
                <div><h2>Kontrol pengiriman</h2><p>${status.outboundEnabled ? "Pesan dapat dikirim melalui koneksi aktif." : "Periksa antrean pengingat sebelum mengaktifkan kembali pengiriman."}</p></div>
                <div class="sending-actions">
                  <form method="post" action="/transport/reconnect"><input type="hidden" name="csrfToken" value="${csrfToken}"><button type="submit" class="button">Hubungkan ulang</button></form>
                  ${status.outboundEnabled ? `
                    <form method="post" action="/transport/disable-sending"><input type="hidden" name="csrfToken" value="${csrfToken}"><button type="submit" class="button danger">Jeda pengiriman</button></form>
                  ` : `
                    <form method="post" action="/transport/enable-sending"><input type="hidden" name="csrfToken" value="${csrfToken}"><button type="submit" class="button primary">Aktifkan pengiriman</button></form>
                  `}
                </div>
              </section>
              <p class="helper">Untuk menghubungkan QR, buka WhatsApp → Perangkat tertaut → Tautkan perangkat. Gunakan sesi berbeda untuk setiap koneksi.</p>
            </main>
          </body>
          </html>
        `);
      }

      return res.send(`<!doctype html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Status WhatsApp</title><style>*{box-sizing:border-box}body{margin:0;padding:20px;color:#182230;background:#f6f7f9;font:14px/1.5 Inter,"Segoe UI",Roboto,Arial,sans-serif}.disabled-card{max-width:560px;margin:15vh auto 0;padding:24px;border:1px solid #e4e7ec;border-radius:10px;background:#fff}.disabled-card h1{margin:0 0 8px;font-size:22px}.disabled-card p{margin:0 0 18px;color:#667085}.disabled-card a{display:inline-flex;min-height:42px;align-items:center;padding:9px 13px;color:#fff;border-radius:8px;background:#2563eb;font-weight:700;text-decoration:none}</style></head><body><main class="disabled-card"><h1>WhatsApp belum aktif</h1><p>Aktifkan BAILEYS_ENABLED pada environment untuk menggunakan kanal WhatsApp.</p><a href="/dashboard">Kembali ke dashboard</a></main></body></html>`);
    });

    this.app.get("/api/status", requireApiAuth, handleApi(async () => {
      const bot = await this.notificationBot.getTransportStatus();
      return {
        bot,
        summary: this.dataManager.getDashboardSummary(),
        settings: this.dataManager.getSettings(),
        billingPeriod: getBillingPeriodKey(new Date(), this.dataManager.getTimezone()),
        scheduler: {
          isProcessing: this.reminderScheduler.isProcessing,
          hotspotReactivationProcessing: this.hotspotReactivationScheduler?.isProcessing || false,
        },
      };
    }));

    this.app.get("/api/whatsapp/status", requireApiAuth, handleApi(async () => this.notificationBot.getTransportStatus()));
    this.app.post("/api/whatsapp/reconnect", requireApiAuth, handleApi(async () => this.notificationBot.reconnect()));
    this.app.post("/api/whatsapp/validate-number", requireApiAuth, handleApi(async (req) => {
      const result = await requireRegisteredWhatsAppNumber(req.body.phoneNumber || req.body.phone || "");
      return { phoneNumber: result.phoneNumber, registered: true };
    }));
    this.app.post("/api/whatsapp/test", requireApiAuth, handleApi(async (req) => {
      const phoneNumber = normalizePhoneNumber(req.body.phoneNumber || req.body.phone || "");
      const message = sanitizeMultilineText(req.body.message || "");
      if (phoneNumber || message) {
        if (!isValidPhoneNumber(phoneNumber)) throw new Error("Nomor tujuan tidak valid.");
        if (!message) throw new Error("Pesan test wajib diisi.");
        const result = await this.notificationBot.sendMessage(phoneNumber, message, {
          maxAttempts: 1,
          context: { type: "test" },
        });
        const deliveryConfirmed = result.deliveryStatus === "delivered" || result.deliveryStatus === "read";
        this.activityLog.push(deliveryConfirmed ? "info" : "warn", "manual", deliveryConfirmed
          ? `WhatsApp test message delivered to ${phoneNumber}`
          : `WhatsApp test message accepted; delivery pending for ${phoneNumber}`, {
          event: "whatsapp.message.sent",
          provider: result.provider,
          deliveryStatus: result.deliveryStatus || "accepted",
        });
        return { type: "message", phoneNumber, ...result };
      }
      return { type: "connection", ...(await this.notificationBot.testConnection()) };
    }));

    this.app.get("/api/logs", requireApiAuth, handleApi(async () => this.activityLog.list()));

    this.app.get("/api/contacts", requireApiAuth, handleApi(async () => this.dataManager.getSortedContacts().map((contact) => this.dataManager.toPublicContact(contact))));
    this.app.post("/api/contacts", requireApiAuth, handleApi(async (req) => {
      await requireRegisteredWhatsAppNumber(req.body.phoneNumber);
      const payload = await this.resolveContactNetworkLink(req.body);
      return this.dataManager.toPublicContact(await this.dataManager.addContact(payload));
    }));
    this.app.put("/api/contacts/:id", requireApiAuth, handleApi(async (req) => {
      const current = this.dataManager.getContact(req.params.id);
      if (!current) throw new Error("Kontak tidak ditemukan.");
      if (req.body.phoneNumber !== undefined
        && normalizePhoneNumber(req.body.phoneNumber) !== current.phoneNumber) {
        await requireRegisteredWhatsAppNumber(req.body.phoneNumber);
      }
      const payload = await this.resolveContactNetworkLink(req.body, current);
      const prepared = await this.dataManager.prepareContactUpdate(req.params.id, payload);
      if (prepared.hotspotSyncRequired) {
        const result = await this.provisionHotspotContact(prepared.contact, { sendCredentials: false });
        return { ...result.contact, hotspotSynced: true };
      }
      return this.dataManager.toPublicContact(prepared.contact);
    }));
    this.app.post("/api/contacts/:id/hotspot", requireApiAuth, handleApi(async (req) => {
      const current = this.dataManager.getContact(req.params.id);
      if (!current) throw new Error("Pelanggan tidak ditemukan.");

      const username = sanitizeInput(String(req.body.mikrotikUsername || req.body.username || ""));
      const profile = sanitizeInput(String(req.body.mikrotikProfile || req.body.profile || ""));
      const password = req.body.mikrotikPassword !== undefined
        ? sanitizeInput(String(req.body.mikrotikPassword || ""))
        : (req.body.password !== undefined ? sanitizeInput(String(req.body.password || "")) : undefined);
      if (!username) throw new Error("Username hotspot wajib diisi.");
      if (!profile) throw new Error("Profile hotspot wajib dipilih.");

      const hotspotPayload = {
        mikrotikUsername: username,
        mikrotikProfile: profile,
        hotspotReactivationEnabled: req.body.hotspotReactivationEnabled,
        hotspotReactivationAt: req.body.hotspotReactivationAt,
      };
      // An empty password on an existing account means keep the current one.
      if (password !== undefined && password) hotspotPayload.mikrotikPassword = password;

      const prepared = await this.dataManager.prepareContactUpdate(req.params.id, hotspotPayload);
      if (!prepared.hotspotSyncRequired) {
        return this.dataManager.toPublicContact(prepared.contact);
      }

      const result = await this.provisionHotspotContact(prepared.contact, {
        sendCredentials: req.body.sendCredentials,
      });
      return { ...result.contact, hotspotSynced: true };
    }));
    this.app.delete("/api/contacts/:id", requireApiAuth, handleApi(async (req) => this.deleteContactWithHotspot(req.params.id)));
    this.app.post("/api/contacts/:id/account-credentials", requireApiAuth, handleApi(async (req) => {
      const contact = this.dataManager.getContact(req.params.id);
      if (!contact) throw new Error("Kontak tidak ditemukan.");

      const includePortal = parseBoolean(req.body.includePortal, false);
      const includeHotspot = parseBoolean(req.body.includeHotspot, false);
      if (!includePortal && !includeHotspot) {
        throw new Error("Pilih minimal satu akun yang akan dikirim.");
      }

      const customerAccount = this.dataManager.getCustomerPortalAccountByContactId(contact.id);
      if (includePortal && (!customerAccount?.account?.username || !customerAccount.account.password)) {
        const error = new Error("Akun portal pelanggan belum tersedia.");
        error.statusCode = 404;
        throw error;
      }

      const portalData = this.dataManager.getCustomerPortalData(contact.id);
      if (includeHotspot && !portalData?.hotspot) {
        const error = new Error("Akun hotspot tidak tersedia atau sedang dinonaktifkan di MikroTik.");
        error.statusCode = 409;
        throw error;
      }

      const phone = await requireRegisteredWhatsAppNumber(contact.phoneNumber);
      const sentAccounts = [];
      const portalLoginUrl = `${req.protocol}://${req.get("host")}/pelanggan/login`;
      let portalAccountDetails = "";
      let hotspotAccountDetails = "";
      if (includePortal) {
        portalAccountDetails = [
          "*Akun Portal Pelanggan*",
          `Alamat: ${portalLoginUrl}`,
          `Username: ${customerAccount.account.username}`,
          `Password: ${customerAccount.account.password}`,
        ].join("\n");
        sentAccounts.push("portal");
      }
      if (includeHotspot) {
        hotspotAccountDetails = [
          "*Akun Hotspot*",
          `Username: ${portalData.hotspot.username}`,
          `Password: ${portalData.hotspot.password}`,
          `Profile: ${portalData.hotspot.profile || "-"}`,
        ].join("\n");
        sentAccounts.push("hotspot");
      }

      const settings = this.dataManager.getSettings();
      const companyName = sanitizeInput(settings.companyName) || "Emmeril Hotspot";
      const supportSignature = sanitizeInput(settings.supportSignature) || companyName;
      const portalAccessGuide = includePortal
        ? "Silakan masuk ke portal pelanggan melalui tautan di atas. Di portal tersebut, Anda dapat memeriksa tagihan, melihat informasi akun hotspot yang aktif, serta mengganti password hotspot secara mandiri."
        : "";
      const messageTemplate = sanitizeMultilineText(settings.customerAccountMessageTemplate)
        || DEFAULT_SETTINGS.customerAccountMessageTemplate;
      const message = messageTemplate
        .replace(/{{\s*name\s*}}/gi, contact.name || "-")
        .replace(/{{\s*phoneNumber\s*}}/gi, contact.phoneNumber || "-")
        .replace(/{{\s*companyName\s*}}/gi, companyName)
        .replace(/{{\s*companyNameUpper\s*}}/gi, companyName.toUpperCase())
        .replace(/{{\s*supportSignature\s*}}/gi, supportSignature)
        .replace(/{{\s*portalAccountDetails\s*}}/gi, portalAccountDetails)
        .replace(/{{\s*hotspotAccountDetails\s*}}/gi, hotspotAccountDetails)
        .replace(/{{\s*portalAccessGuide\s*}}/gi, portalAccessGuide)
        .replace(/{{\s*portalLoginUrl\s*}}/gi, includePortal ? portalLoginUrl : "-")
        .replace(/{{\s*portalUsername\s*}}/gi, includePortal ? customerAccount.account.username : "-")
        .replace(/{{\s*portalPassword\s*}}/gi, includePortal ? customerAccount.account.password : "-")
        .replace(/{{\s*hotspotUsername\s*}}/gi, includeHotspot ? portalData.hotspot.username : "-")
        .replace(/{{\s*hotspotPassword\s*}}/gi, includeHotspot ? portalData.hotspot.password : "-")
        .replace(/{{\s*hotspotProfile\s*}}/gi, includeHotspot ? portalData.hotspot.profile || "-" : "-")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
      const delivery = await this.notificationBot.sendMessage(phone.phoneNumber, message, {
        maxAttempts: 1,
        context: { type: "customer-account-credentials", contactId: String(contact.id) },
      });
      this.activityLog.push("info", "customer-account", `Akun pelanggan dikirim ke ${contact.phoneNumber}`, {
        contactId: String(contact.id),
        accounts: sentAccounts,
        provider: delivery.provider || null,
      });
      return {
        phoneNumber: phone.phoneNumber,
        accounts: sentAccounts,
        provider: delivery.provider || null,
        messageId: delivery.messageId || null,
        deliveryStatus: delivery.deliveryStatus || "accepted",
      };
    }));

    this.app.get("/api/mikrotik/profiles", requireApiAuth, handleApi(async () => this.mikrotikService.getHotspotProfiles()));
    this.app.get("/api/mikrotik/hotspot-users", requireApiAuth, handleApi(async () => this.mikrotikService.getHotspotUsers()));
    this.app.get("/api/mikrotik/netwatch", requireApiAuth, handleApi(async () => (
      this.buildNetworkMonitorView(await this.mikrotikService.getNetwatchStatus())
    )));
    this.app.post("/api/contacts/:id/hotspot/provision", requireApiAuth, handleApi(async (req) => {
      const contact = this.dataManager.getContact(req.params.id);
      if (!contact) throw new Error("Kontak tidak ditemukan.");
      if (contact.hotspotProvisioningOperation === HOTSPOT_PROVISIONING_OPERATION.ENABLE
        || contact.hotspotProvisioningOperation === HOTSPOT_PROVISIONING_OPERATION.DISABLE) {
        const toggleResult = await this.setHotspotContactDisabled(
          contact,
          contact.hotspotProvisioningOperation === HOTSPOT_PROVISIONING_OPERATION.DISABLE
        );
        return {
          ...toggleResult,
          contact: this.dataManager.toPublicContact(toggleResult.contact),
        };
      }
      if (contact.hotspotProvisioningOperation === HOTSPOT_PROVISIONING_OPERATION.REACTIVATE
        || contact.hotspotProvisioningOperation === HOTSPOT_PROVISIONING_OPERATION.DEACTIVATE) {
        const lifecycleResult = contact.hotspotProvisioningOperation === HOTSPOT_PROVISIONING_OPERATION.REACTIVATE
          ? await this.hotspotReactivationScheduler.reactivateContact(this.dataManager.hydrateContact(contact))
          : await this.hotspotReactivationScheduler.deactivateContact(this.dataManager.hydrateContact(contact));
        return {
          ...lifecycleResult,
          contact: this.dataManager.toPublicContact(lifecycleResult.contact),
          password: undefined,
        };
      }
      return this.provisionHotspotContact(contact, {
        sendCredentials: req.body.sendCredentials !== undefined
          ? req.body.sendCredentials
          : (contact.hotspotProvisioningOperation === HOTSPOT_PROVISIONING_OPERATION.CREATE
            ? contact.hotspotSendCredentials
            : false),
      });
    }));
    this.app.post("/api/contacts/:id/hotspot/reactivate", requireApiAuth, handleApi(async (req) => {
      const contact = this.dataManager.getContact(req.params.id);
      if (!contact) throw new Error("Kontak tidak ditemukan.");
      const result = await this.hotspotReactivationScheduler.reactivateContact(
        this.dataManager.hydrateContact(contact),
        { manual: true }
      );
      return {
        ...result,
        contact: this.dataManager.toPublicContact(result.contact),
        password: undefined,
      };
    }));
    this.app.post("/api/contacts/:id/hotspot/disable", requireApiAuth, handleApi(async (req) => {
      const contact = this.dataManager.getContact(req.params.id);
      if (!contact) throw new Error("Kontak tidak ditemukan.");
      const result = await this.setHotspotContactDisabled(contact, true);
      return {
        ...result,
        contact: this.dataManager.toPublicContact(result.contact),
      };
    }));
    this.app.post("/api/contacts/:id/hotspot/enable", requireApiAuth, handleApi(async (req) => {
      const contact = this.dataManager.getContact(req.params.id);
      if (!contact) throw new Error("Kontak tidak ditemukan.");
      const result = await this.setHotspotContactDisabled(contact, false);
      return {
        ...result,
        contact: this.dataManager.toPublicContact(result.contact),
      };
    }));
    this.app.post("/api/contacts/:id/active-period-purchase", requireApiAuth, handleApi(async (req) => {
      const result = await this.purchaseActivePeriod(req.params.id);
      const remainingDebtAmount = Math.max(0, Number(result.contact.debtAmount) || 0);
      let notificationSent = false;
      let notificationError = null;
      try {
        await this.notificationBot.sendPaymentNotification(
          result.contact,
          result.purchase.id,
          PAYMENT_TYPES.ACTIVE_PERIOD,
          {
            paymentAmount: result.purchase.amount,
            paymentDate: result.purchase.purchasedAt,
            activeUntil: result.purchase.activeUntil,
            remainingDebtAmount,
          }
        );
        notificationSent = true;
      } catch (error) {
        notificationError = error.message;
        this.activityLog.push("error", "payment", `Masa aktif tersimpan tetapi notifikasi gagal dikirim ke ${result.contact.phoneNumber}`, {
          contactId: result.contact.id,
          transactionId: result.purchase.id,
          error: error.message,
        });
      }
      return {
        ...result,
        contact: this.dataManager.toPublicContact(result.contact),
        notificationSent,
        notificationError,
      };
    }));
    this.app.post("/api/hotspot/reactivations/run", requireApiAuth, handleApi(async () => this.hotspotReactivationScheduler.processDueReactivations()));
    this.app.post("/api/mikrotik/customers", requireApiAuth, handleApi(async (req) => {
      await requireRegisteredWhatsAppNumber(req.body.phoneNumber);
      const persisted = await this.dataManager.prepareHotspotRegistration(req.body);
      return this.provisionHotspotContact(persisted.contact, {
        sendCredentials: req.body.sendCredentials,
      });
    }));
    this.app.post("/api/mikrotik/backup/send", requireApiAuth, handleApi(async () => {
      if (!TelegramManager.isConfigured()) {
        throw new Error("Transport backup Telegram belum siap. Isi TELEGRAM_BOT_TOKEN dan TELEGRAM_CHAT_IDS.");
      }

      const recipients = TelegramManager.getChatIds();
      if (recipients.length === 0) {
        throw new Error("TELEGRAM_CHAT_IDS masih kosong.");
      }

      const backup = await this.mikrotikService.generateDailyBackupFile();
      try {
        const caption = `Backup MikroTik manual\nWaktu: ${new Date().toLocaleString("id-ID", { timeZone: this.dataManager.getTimezone() })}`;
        const results = [];

        for (const chatId of recipients) {
          try {
            await this.notificationBot.sendTelegramFile(chatId, backup.filePath, caption);
            results.push({ chatId, status: "sent", provider: "telegram" });
          } catch (error) {
            results.push({ chatId, status: "failed", error: error.message, provider: "telegram" });
          }
        }

        this.activityLog.push("info", "mikrotik-backup", "Pengiriman backup MikroTik manual dieksekusi", {
          fileName: backup.fileName,
          results,
        });

        return {
          fileName: backup.fileName,
          results,
        };
      } finally {
        await backup.cleanup().catch((error) => {
          this.activityLog.push("warn", "mikrotik-backup", `Gagal membersihkan file backup sementara: ${error.message}`);
        });
      }
    }));

    this.app.post("/api/contacts/:id/payment", requireApiAuth, handleApi(async (req) => {
      const status = sanitizeInput(req.body.status).toUpperCase();
      const requestedPaymentType = sanitizeInput(req.body.paymentType).toUpperCase();
      const paymentType = requestedPaymentType || null;
      const paymentAmount = req.body.paymentAmount === undefined || req.body.paymentAmount === null || req.body.paymentAmount === ""
        ? null
        : Number(req.body.paymentAmount);
      let updatedContact = await this.dataManager.updatePaymentStatus(
        req.params.id,
        status,
        paymentType,
        paymentAmount
      );
      let hotspotRecovery = { attempted: false, reason: "outstanding_balance" };
      try {
        hotspotRecovery = await this.recoverHotspotAfterPayment(updatedContact);
        if (hotspotRecovery.contact) updatedContact = hotspotRecovery.contact;
      } catch (error) {
        hotspotRecovery = { attempted: true, action: "failed", error: error.message };
        this.activityLog.push("error", "payment", "Pembayaran tersimpan tetapi pemulihan hotspot gagal", {
          contactId: updatedContact.id,
          error: error.message,
        });
      }
      const effectivePaymentType = paymentType || updatedContact.paymentType;
      const appliedPaymentAmount = Math.max(0, Number(updatedContact.paymentAppliedAmount) || 0);
      const remainingDebtAmount = Math.max(0, Number(updatedContact.debtAmount) || 0);
      const shouldSendPaymentNotification = status === PAYMENT_STATUS.PAID || effectivePaymentType === PAYMENT_TYPES.ARREARS_ONLY;

      if (!shouldSendPaymentNotification) {
        return {
          contact: this.dataManager.toPublicContact(updatedContact),
          notificationSent: false,
          hotspotRecovery,
        };
      }

      const transactionId = `TRX-${Date.now()}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
      try {
        await this.notificationBot.sendPaymentNotification(updatedContact, transactionId, effectivePaymentType, {
          paymentAmount: appliedPaymentAmount,
          remainingDebtAmount,
        });
        return {
          contact: this.dataManager.toPublicContact(updatedContact),
          transactionId,
          paymentType: effectivePaymentType,
          paymentAmount: appliedPaymentAmount,
          remainingDebtAmount,
          notificationSent: true,
          hotspotRecovery,
        };
      } catch (error) {
        this.activityLog.push("error", "payment", `Status paid tersimpan tapi notifikasi gagal dikirim ke ${updatedContact.phoneNumber}`, {
          error: error.message,
          transactionId,
          contactId: updatedContact.id,
        });

        return {
          contact: this.dataManager.toPublicContact(updatedContact),
          transactionId,
          paymentType: effectivePaymentType,
          paymentAmount: appliedPaymentAmount,
          remainingDebtAmount,
          notificationSent: false,
          notificationError: error.message,
          hotspotRecovery,
        };
      }
    }));

    this.app.post("/api/contacts/:id/billing-reminder", requireApiAuth, handleApi(async (req) => {
      const contact = this.dataManager.getContact(req.params.id);
      if (!contact) throw new Error("Kontak tidak ditemukan.");
      const contactState = this.dataManager.hydrateContact(contact);
      const currentStatus = String(
        contactState.currentPaymentStatus || contactState.paymentStatus || PAYMENT_STATUS.UNPAID
      ).toUpperCase();
      const isOverdue = String(contactState.dueStatus || "").toUpperCase() === "OVERDUE";
      const hasDebt = Boolean(contactState.hasDebt && Number(contactState.debtCount) > 0);
      if (!hasDebt && (currentStatus !== PAYMENT_STATUS.UNPAID || !isOverdue)) {
        throw new Error("Pengingat hanya dapat dikirim untuk tagihan yang jatuh tempo atau memiliki tunggakan.");
      }

      const result = await this.notificationBot.sendBillingDebtReminder(contactState);
      return {
        contact: this.dataManager.toPublicContact(contactState),
        ...result,
      };
    }));

    this.app.post("/api/contacts/:id/payment-amount", requireApiAuth, handleApi(async (req) => {
      const contact = await this.dataManager.updateContactPaymentAmount(
        req.params.id,
        req.body.monthlyPaymentAmount,
        { useProfileDefault: parseBoolean(req.body.useProfileDefault, false) }
      );
      return this.dataManager.toPublicContact(contact);
    }));

    this.app.post("/api/contacts/:id/payment-month", requireApiAuth, handleApi(async (req) => {
      const year = Number(req.body.year);
      const month = Number(req.body.month);
      const status = sanitizeInput(req.body.status).toUpperCase();
      const paymentType = sanitizeInput(req.body.paymentType).toUpperCase();
      let updated = await this.dataManager.setPaymentForMonth(
        req.params.id,
        year,
        month,
        status,
        paymentType || null
      );
      let hotspotRecovery = { attempted: false, reason: "outstanding_balance" };
      try {
        hotspotRecovery = await this.recoverHotspotAfterPayment(updated);
        if (hotspotRecovery.contact) updated = hotspotRecovery.contact;
      } catch (error) {
        hotspotRecovery = { attempted: true, action: "failed", error: error.message };
        this.activityLog.push("error", "payment", "Pembayaran per bulan tersimpan tetapi pemulihan hotspot gagal", {
          contactId: updated.id,
          error: error.message,
        });
      }
      if (status !== PAYMENT_STATUS.PAID || typeof this.notificationBot.sendPaymentNotification !== "function") {
        return {
          ...this.dataManager.toPublicContact(updated),
          notificationSent: false,
          hotspotRecovery,
        };
      }

      const transactionId = `TRX-${Date.now()}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
      const effectivePaymentType = paymentType || updated.paymentType || PAYMENT_TYPES.CURRENT_ONLY;
      try {
        await this.notificationBot.sendPaymentNotification(updated, transactionId, effectivePaymentType, {
          paymentAmount: Math.max(0, Number(updated.monthlyPaymentAmount) || 0),
          remainingDebtAmount: Math.max(0, Number(updated.debtAmount) || 0),
          activeUntil: updated.serviceActiveUntil || updated.hotspotReactivationAt || null,
        });
        return {
          ...this.dataManager.toPublicContact(updated),
          transactionId,
          notificationSent: true,
          hotspotRecovery,
        };
      } catch (error) {
        this.activityLog.push("error", "payment", "Pembayaran per bulan tersimpan tetapi notifikasi WhatsApp gagal", {
          contactId: updated.id,
          transactionId,
          error: error.message,
        });
        return {
          ...this.dataManager.toPublicContact(updated),
          transactionId,
          notificationSent: false,
          notificationError: error.message,
          hotspotRecovery,
        };
      }
    }));

    this.app.get("/api/reminders", requireApiAuth, handleApi(async () => this.dataManager.getSortedReminders()));
    this.app.post("/api/reminders", requireApiAuth, handleApi(async (req) => {
      const when = parseDateTimeInput(req.body.reminderDateTime, this.dataManager.getTimezone());
      if (!when) throw new Error("Format reminderDateTime harus YYYY-MM-DD HH:mm.");
      if (when.getTime() <= Date.now()) throw new Error("Reminder harus dijadwalkan di masa depan.");
      return this.dataManager.addReminder({
        contactId: req.body.contactId,
        reminderDateTime: when,
        message: req.body.message,
        templateName: req.body.templateName,
      });
    }));
    this.app.put("/api/reminders/:id", requireApiAuth, handleApi(async (req) => {
      const payload = { ...req.body };
      if (payload.reminderDateTime !== undefined) {
        const when = parseDateTimeInput(payload.reminderDateTime, this.dataManager.getTimezone());
        if (!when) throw new Error("Format reminderDateTime harus YYYY-MM-DD HH:mm.");
        payload.reminderDateTime = when;
      }
      return this.dataManager.updateReminder(req.params.id, payload);
    }));
    this.app.delete("/api/reminders/:id", requireApiAuth, handleApi(async (req) => this.dataManager.deleteReminder(req.params.id)));
    this.app.get("/api/reminders/sent", requireApiAuth, handleApi(async () => this.dataManager.getSentReminders()));

    this.app.get("/api/templates", requireApiAuth, handleApi(async () => this.templateManager.listTemplates()));
    this.app.post("/api/templates", requireApiAuth, handleApi(async (req) => this.templateManager.createTemplate(req.body.name, req.body.content)));
    this.app.put("/api/templates/:name", requireApiAuth, handleApi(async (req) => {
      const template = await this.templateManager.updateTemplate(req.params.name, req.body.content);
      const sync = await this.dataManager.syncActiveRemindersWithTemplates([template]);
      return { ...template, remindersMatched: sync.matched, remindersUpdated: sync.updated };
    }));
    this.app.delete("/api/templates/:name", requireApiAuth, handleApi(async (req) => this.templateManager.deleteTemplate(req.params.name)));

    this.app.get("/api/settings", requireApiAuth, handleApi(async () => this.dataManager.getSettings()));
    this.app.put("/api/settings", requireApiAuth, handleApi(async (req) => this.dataManager.updateSettings(req.body)));

    this.app.get("/api/admin-recipients", requireApiAuth, handleApi(async () => this.dataManager.getAdminRecipients()));
    this.app.put("/api/admin-recipients", requireApiAuth, handleApi(async (req) => {
      const recipients = Array.isArray(req.body.recipients)
        ? req.body.recipients.map(normalizePhoneNumber).filter(Boolean)
        : String(req.body.recipients || "")
            .split(/\r?\n|,/)
            .map(normalizePhoneNumber)
            .filter(Boolean);

      const invalid = recipients.filter((phoneNumber) => !isValidPhoneNumber(phoneNumber));
      if (invalid.length > 0) {
        throw new Error(`Nomor admin tidak valid: ${invalid.join(", ")}`);
      }

      return this.dataManager.setAdminRecipients([...new Set(recipients)]);
    }));

    this.app.post("/api/notifications/test", requireApiAuth, handleApi(async (req) => {
      const message = sanitizeMultilineText(req.body.message);
      const requestedPhone = normalizePhoneNumber(req.body.phoneNumber);
      const contactId = sanitizeInput(req.body.contactId);
      const selectedContact = contactId ? this.dataManager.getContact(contactId) : null;
      const phoneNumber = selectedContact?.phoneNumber || requestedPhone;

      if (contactId && !selectedContact) throw new Error("Contact tidak ditemukan.");
      if (!isValidPhoneNumber(phoneNumber)) throw new Error("Nomor tujuan tidak valid.");
      if (!message) throw new Error("Pesan notifikasi wajib diisi.");

      const delivery = await this.notificationBot.sendMessage(phoneNumber, message);
      const deliveryStatus = delivery.deliveryStatus || "accepted";
      const deliveryConfirmed = deliveryStatus === "delivered" || deliveryStatus === "read";
      this.activityLog.push(deliveryConfirmed ? "info" : "warn", "manual", deliveryConfirmed
        ? `Manual notification delivered to ${phoneNumber}`
        : `Manual notification accepted by WhatsApp; delivery pending for ${phoneNumber}`, { deliveryStatus });
      return {
        phoneNumber,
        contactId: selectedContact?.id || null,
        contactName: selectedContact?.name || null,
        status: deliveryStatus,
        deliveryStatus,
        messageId: delivery.messageId || null,
      };
    }));

    this.app.post("/api/notifications/admin-broadcast", requireApiAuth, handleApi(async (req) => {
      const title = sanitizeInput(req.body.title) || "Status Bot";
      const body = sanitizeMultilineText(req.body.message);
      if (!body) throw new Error("Pesan broadcast wajib diisi.");
      return this.notificationBot.sendAdminBroadcast(title, body);
    }));

    this.app.post("/api/notifications/broadcast", requireApiAuth, handleApi(async (req) => {
      const title = sanitizeInput(req.body.title) || "Pengumuman";
      const templateName = sanitizeInput(req.body.templateName || "");
      let body = sanitizeMultilineText(req.body.message);
      if (templateName) {
        const templatePath = this.templateManager.getTemplatePath(templateName);
        body = sanitizeMultilineText(await fs.readFile(templatePath, "utf-8"));
      }
      if (!body) throw new Error("Pesan broadcast wajib diisi.");
      return this.notificationBot.sendContactBroadcast(title, body, {
        renderMessage: (contact, content) =>
          this.templateManager.applyTemplate(content, {
            name: contact?.name || "",
            phoneNumber: contact?.phoneNumber || "",
            date: new Date().toLocaleDateString("id-ID", { timeZone: this.dataManager.getTimezone() }),
          }),
      });
    }));

    this.app.post("/api/scheduler/run", requireApiAuth, handleApi(async () => {
      await this.reminderScheduler.processDueReminders();
      return { queued: true };
    }));

    this.app.get("/api/payments/history", requireApiAuth, handleApi(async () => {
      const history = this.dataManager.getAllPaymentsHistory();
      return Object.fromEntries(Object.entries(history).map(([period, item]) => [period, {
        ...item,
        contacts: item.contacts.map((contact) => this.dataManager.toPublicContact(contact)),
      }]));
    }));
    this.app.get("/api/payments/export.xlsx", requireApiAuth, handleApi(async (req, res) => {
      const workbook = await this.dataManager.createPaymentRecapWorkbook();
      const period = getBillingPeriodKey(new Date(), this.dataManager.getTimezone());
      const buffer = await workbook.xlsx.writeBuffer();
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", `attachment; filename="rekap-pembayaran-${period}.xlsx"`);
      res.setHeader("Content-Length", buffer.length);
      res.send(Buffer.from(buffer));
    }));
    this.app.get("/api/payments/current", requireApiAuth, handleApi(async () => {
      const now = new Date();
      const { year: currentYear, month: currentMonth } = getBillingPeriodParts(
        now,
        this.dataManager.getTimezone()
      );
      const payments = this.dataManager.getPaymentsByMonth(currentYear, currentMonth);
      const allHistory = this.dataManager.getAllPaymentsHistory();
      const prevMonth = currentMonth === 1 ? 12 : currentMonth - 1;
      const prevYear = currentMonth === 1 ? currentYear - 1 : currentYear;
      const prevPayments = allHistory[`${prevYear}-${String(prevMonth).padStart(2, "0")}`]?.total || 0;
      const growth = prevPayments > 0 ? Number((((payments.length - prevPayments) / prevPayments) * 100).toFixed(1)) : 0;

      return {
        current: {
          year: currentYear,
          month: currentMonth,
          total: payments.length,
          contacts: payments.map((contact) => this.dataManager.toPublicContact(contact)),
        },
        previous: { year: prevYear, month: prevMonth, total: prevPayments },
        growth,
      };
    }));

    this.app.get("/api/payments/:year/:month", requireApiAuth, handleApi(async (req) => {
      const year = Number(req.params.year);
      const month = Number(req.params.month);
      if (!year || !month || year < 2000 || year > 2100 || month < 1 || month > 12) {
        throw new Error("Invalid year or month");
      }

      const periodKey = makeBillingPeriodKey(year, month);
      return this.dataManager.getPaymentsByMonth(year, month).map((contact) => {
        const payment = contact.paymentMonths?.[periodKey] || {};
        return {
          id: contact.id,
          name: contact.name,
          phoneNumber: contact.phoneNumber,
          paymentDate: payment.paidDate || null,
          paymentStatus: payment.status || PAYMENT_STATUS.UNPAID,
          paymentType: payment.paymentType || null,
        };
      });
    }));

    this.app.use((req, res) => {
      if (req.path.startsWith("/api/")) {
        return res.status(404).json({ success: false, error: "Endpoint tidak ditemukan." });
      }
      return res.status(404).type("text/plain").send("Halaman tidak ditemukan.");
    });

    this.app.use((error, req, res, _next) => {
      const requestedStatus = Number(error.statusCode || error.status);
      const statusCode = requestedStatus >= 400 && requestedStatus <= 599 ? requestedStatus : 500;
      const publicMessage = statusCode < 500 ? error.message : "Terjadi kesalahan internal.";
      this.activityLog.push("error", "http", `Request ${req.requestId || "unknown"} gagal: ${error.message}`, {
        requestId: req.requestId || null,
        method: req.method,
        path: req.originalUrl,
        statusCode,
      });

      if (res.headersSent) return _next(error);
      if (req.path.startsWith("/api/")) {
        res.status(statusCode).json({ success: false, error: publicMessage, requestId: req.requestId });
        return;
      }
      res.status(statusCode).type("text/plain").send(`${publicMessage}\nRequest ID: ${req.requestId}`);
    });
  }

  async renderDashboard() {
    const title = escapeHtml(this.dataManager.getSettings().dashboardTitle);
    const templatePath = path.join(CONFIG.PUBLIC_PATH, "index.html");
    const html = await fs.readFile(templatePath, "utf-8");

    return html.replace(/__DASHBOARD_TITLE__/g, title);
  }

  async renderLoginPage() {
    const title = escapeHtml(this.dataManager.getSettings().dashboardTitle);
    const templatePath = path.join(CONFIG.PUBLIC_PATH, "login.html");
    const html = await fs.readFile(templatePath, "utf-8");
    return html.replace(/__DASHBOARD_TITLE__/g, title);
  }

  async renderCustomerLoginPage() {
    const settings = this.dataManager.getSettings();
    const title = escapeHtml(settings.companyName || settings.dashboardTitle);
    const templatePath = path.join(CONFIG.PUBLIC_PATH, "customer-login.html");
    const html = await fs.readFile(templatePath, "utf-8");
    return html.replace(/__CUSTOMER_PORTAL_TITLE__/g, title);
  }

  async renderCustomerPortal() {
    const settings = this.dataManager.getSettings();
    const title = escapeHtml(settings.companyName || settings.dashboardTitle);
    const templatePath = path.join(CONFIG.PUBLIC_PATH, "customer.html");
    const html = await fs.readFile(templatePath, "utf-8");
    return html.replace(/__CUSTOMER_PORTAL_TITLE__/g, title);
  }

  async start() {
    if (this.server) return this.server;
    this.ready = true;

    return new Promise((resolve, reject) => {
      const server = this.app.listen(CONFIG.PORT, CONFIG.HOST);
      this.server = server;
      const handleError = (error) => {
        this.server = null;
        reject(error);
      };
      server.once("error", handleError);
      server.once("listening", () => {
        server.off("error", handleError);
        this.activityLog.push("info", "web", `Dashboard running at http://${CONFIG.HOST}:${CONFIG.PORT}/dashboard`);
        this.activityLog.push("info", "web", `WhatsApp provider status page running at http://${CONFIG.HOST}:${CONFIG.PORT}/transport`);
        resolve(server);
      });
    });
  }

  async stop(timeoutMs = Math.min(CONFIG.SHUTDOWN_TIMEOUT, 10_000)) {
    this.ready = false;
    const server = this.server;
    if (!server) return;

    await new Promise((resolve) => {
      let completed = false;
      const finish = () => {
        if (completed) return;
        completed = true;
        clearTimeout(forceCloseTimer);
        this.server = null;
        resolve();
      };
      const forceCloseTimer = setTimeout(() => {
        this.activityLog.push("warn", "shutdown", "HTTP connection dipaksa tutup setelah melewati batas waktu");
        server.closeAllConnections?.();
        finish();
      }, Math.max(250, timeoutMs));
      forceCloseTimer.unref?.();
      server.closeIdleConnections?.();
      server.close(finish);
    });
  }
}

// ===============================
// SEND MONTHLY RESET NOTIFICATION
// ===============================

async function sendMonthlyResetNotification(notificationBot, dataManager, activityLog) {
  const resetResult = await dataManager.ensureMonthlyPaymentReset();
  if (!resetResult.reset) {
    return;
  }

  const count = resetResult.count;
  const settings = dataManager.getSettings();
  const now = new Date();
  const { year: currentYear, month: currentMonth } = getBillingPeriodParts(
    now,
    dataManager.getTimezone()
  );
  const overdue = dataManager.getOverdueContacts(currentYear, currentMonth);

  activityLog.push("info", "billing", `Monthly payment status reset completed for ${count} contact(s)`);

  if (!settings.notifyAdminsOnPaymentReset || !notificationBot.getStatus().whatsappProviderEnabled) {
    return;
  }

  let body = `Status pembayaran bulan ${MONTH_NAMES[currentMonth]} ${currentYear} telah direset.\n\nKontak yang direset: ${count}.`;
  if (overdue.length > 0) {
    body += `\n\nMasih ada ${overdue.length} kontak dengan tunggakan dari periode sebelumnya:\n${overdue.slice(0, 8).map((item, index) => `${index + 1}. ${item.name}`).join("\n")}`;
    if (overdue.length > 8) {
      body += `\n...dan ${overdue.length - 8} lainnya.`;
    }
  } else {
    body += "\n\nTidak ada tunggakan dari periode sebelumnya.";
  }

  await notificationBot.sendAdminBroadcast("Reset pembayaran bulanan", body);
}

async function runScheduledTasks(tasks, activityLog) {
  const results = await Promise.allSettled(
    tasks.map((task) => Promise.resolve().then(() => task.run()))
  );

  results.forEach((result, index) => {
    if (result.status !== "rejected") return;
    const errorMessage = result.reason?.message || String(result.reason);
    activityLog.push("error", "scheduler", `Scheduled task ${tasks[index].name} failed: ${errorMessage}`, {
      task: tasks[index].name,
      error: errorMessage,
    });
  });

  return results;
}

// ===============================
// APPLICATION BOOTSTRAP
// ===============================

async function bootstrap() {
  assertSecureConfiguration();
  if (!cron.validate(CONFIG.CRON_SCHEDULE)
    || !cron.validate(CONFIG.HOTSPOT_STATUS_SYNC_SCHEDULE)
    || !cron.validate(CONFIG.SENT_HISTORY_CLEANUP_SCHEDULE)) {
    throw new Error("Konfigurasi cron tidak valid.");
  }

  const activityLog = new ActivityLog();
  for (const warning of collectSecurityWarnings()) {
    activityLog.push("warn", "config", warning);
  }

  const authManager = new AuthManager(activityLog);
  const dataManager = new DataManager(activityLog);
  const templateManager = new TemplateManager(activityLog);
  const notificationBot = new NotificationBot(dataManager, activityLog);
  const mikrotikService = new MikrotikService(activityLog);
  const apDownNotifier = new ApDownNotifier(mikrotikService, notificationBot, dataManager, activityLog);
  const whatsappProviderStatusNotifier = new WhatsAppProviderStatusNotifier(
    notificationBot,
    dataManager,
    activityLog
  );
  const mikrotikBackupScheduler = new MikrotikBackupScheduler(
    mikrotikService,
    notificationBot,
    dataManager,
    activityLog
  );
  const databaseBackupScheduler = new DatabaseBackupScheduler(dataManager, activityLog);
  const hotspotReactivationScheduler = new HotspotReactivationScheduler(
    mikrotikService,
    dataManager,
    activityLog
  );
  const hotspotStatusSyncScheduler = new HotspotStatusSyncScheduler(
    mikrotikService,
    dataManager,
    activityLog
  );

  await dataManager.loadAll();
  await dataManager.syncActiveRemindersWithTemplates(await templateManager.listTemplates());

  const reminderScheduler = new ReminderScheduler(notificationBot, dataManager, activityLog);
  const webServer = new WebServer(
    notificationBot,
    dataManager,
    templateManager,
    activityLog,
    reminderScheduler,
    authManager,
    mikrotikService,
    hotspotReactivationScheduler
  );

  await sendMonthlyResetNotification(notificationBot, dataManager, activityLog);

  const scheduledJobs = [];
  const intervals = [];
  const backgroundTasks = new Set();
  const trackBackgroundTask = (promise) => {
    const task = Promise.resolve(promise);
    backgroundTasks.add(task);
    task.then(
      () => backgroundTasks.delete(task),
      () => backgroundTasks.delete(task)
    );
    return task;
  };
  scheduledJobs.push(cron.schedule(CONFIG.CRON_SCHEDULE, () => {
    void trackBackgroundTask(runScheduledTasks([
      { name: "reminders", run: () => reminderScheduler.processDueReminders() },
      { name: "ap-monitor", run: () => apDownNotifier.processNetwatchChanges() },
      { name: "whatsapp-provider-status", run: () => whatsappProviderStatusNotifier.processStatusChanges() },
      { name: "mikrotik-backup", run: () => mikrotikBackupScheduler.processDailyBackup() },
      { name: "database-backup", run: () => databaseBackupScheduler.processDailyBackup() },
      { name: "hotspot-reactivation", run: () => hotspotReactivationScheduler.processDueReactivations() },
      { name: "midtrans-payments", run: () => webServer.reconcilePendingMidtransPayments() },
      { name: "monthly-payment-reset", run: () => sendMonthlyResetNotification(notificationBot, dataManager, activityLog) },
    ], activityLog));
  }));

  scheduledJobs.push(cron.schedule(CONFIG.HOTSPOT_STATUS_SYNC_SCHEDULE, () => {
    void trackBackgroundTask(runScheduledTasks([
      { name: "hotspot-status-sync", run: () => hotspotStatusSyncScheduler.processStatusSync() },
    ], activityLog));
  }));

  scheduledJobs.push(cron.schedule(CONFIG.SENT_HISTORY_CLEANUP_SCHEDULE, () => {
    void trackBackgroundTask(dataManager.cleanupSentHistory().catch((error) => {
      activityLog.push("error", "storage", `Sent History auto-clean failed: ${error.message}`);
    }));
  }));

  intervals.push(setInterval(() => {
    void trackBackgroundTask(dataManager.saveAll().catch((error) => {
      activityLog.push("error", "storage", `Auto-save failed: ${error.message}`);
    }));
  }, CONFIG.AUTO_SAVE_INTERVAL));

  intervals.push(setInterval(() => {
    authManager.cleanupExpiredSessions();
  }, 60 * 60 * 1000));

  let shutdownPromise = null;
  const shutdown = (reason = "manual") => {
    if (shutdownPromise) return shutdownPromise;

    shutdownPromise = (async () => {
      activityLog.push("info", "shutdown", `Graceful shutdown dimulai: ${reason}`);
      webServer.ready = false;
      scheduledJobs.forEach((job) => {
        job.stop();
        job.destroy?.();
      });
      intervals.forEach((interval) => clearInterval(interval));

      const shutdownWork = (async () => {
        await webServer.stop();
        await Promise.allSettled([...backgroundTasks]);
        await notificationBot.shutdown().catch((error) => {
          activityLog.push("error", "shutdown", `Transport gagal dihentikan: ${error.message}`);
        });
        await dataManager.saveAll().catch((error) => {
          activityLog.push("error", "shutdown", `Penyimpanan akhir gagal: ${error.message}`);
        });
        await dataManager.close().catch((error) => {
          activityLog.push("error", "shutdown", `Database gagal ditutup: ${error.message}`);
        });
      })();

      let timeoutId;
      try {
        await Promise.race([
          shutdownWork,
          new Promise((_, reject) => {
            timeoutId = setTimeout(() => reject(new Error("Graceful shutdown timeout.")), Math.max(1_000, CONFIG.SHUTDOWN_TIMEOUT));
            timeoutId.unref?.();
          }),
        ]);
        activityLog.push("info", "shutdown", "Graceful shutdown selesai");
      } finally {
        clearTimeout(timeoutId);
      }
    })();
    return shutdownPromise;
  };

  const terminate = (reason, exitCode) => {
    shutdown(reason)
      .catch((error) => {
        activityLog.push("error", "shutdown", `Graceful shutdown gagal: ${error.message}`);
      })
      .finally(() => process.exit(exitCode));
  };
  const handleSigint = () => terminate("SIGINT", 0);
  const handleSigterm = () => terminate("SIGTERM", 0);
  const handleUncaughtException = (error) => {
    activityLog.push("error", "runtime", `Uncaught exception: ${error.message}`, { stack: error.stack });
    terminate("uncaughtException", 1);
  };
  const handleUnhandledRejection = (reason) => {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    activityLog.push("error", "runtime", `Unhandled rejection: ${error.message}`, { stack: error.stack });
    terminate("unhandledRejection", 1);
  };

  process.once("SIGINT", handleSigint);
  process.once("SIGTERM", handleSigterm);
  process.once("uncaughtException", handleUncaughtException);
  process.once("unhandledRejection", handleUnhandledRejection);

  await webServer.start();
  const notificationInitialization = notificationBot.initialize()
    .then(() => activityLog.push("info", "notification", "Notification transport initialized"))
    .catch((error) => {
      activityLog.push("error", "notification", `Initial notification startup failed: ${error.message}`);
    });

  return {
    activityLog,
    dataManager,
    notificationBot,
    notificationInitialization,
    webServer,
    async shutdown(reason = "manual") {
      process.removeListener("SIGINT", handleSigint);
      process.removeListener("SIGTERM", handleSigterm);
      process.removeListener("uncaughtException", handleUncaughtException);
      process.removeListener("unhandledRejection", handleUnhandledRejection);
      return shutdown(reason);
    },
  };
}

module.exports = {
  DataManager,
  MidtransService,
  MikrotikService,
  NotificationBot,
  WebServer,
  bootstrap,
  runScheduledTasks,
};
