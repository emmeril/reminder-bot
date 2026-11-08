const fs = require("fs/promises");
const net = require("net");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const ftp = require("basic-ftp");
const { RouterOSClient } = require("routeros-client");
const AsyncLock = require("../../async-lock");
const { CONFIG, DEFAULT_SETTINGS } = require("../../config");
const {
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
} = require("../vouchers/domain");
const {
  IP_BINDING_BANDWIDTH_STATUS,
  buildIpBindingBandwidthOwnerComment,
  buildIpBindingBandwidthQueueName,
  buildIpBindingOwnerComment,
  normalizeMacAddress,
  normalizeMacAddresses,
  normalizeQueueTarget,
  normalizeSimpleQueueLimitForComparison,
  parseHotspotRateLimitForSimpleQueue,
  readRouterValue,
} = require("./domain");
const {
  buildHotspotEmailFromPhone,
  formatUsernameFromName,
  isValidPhoneNumber,
  isValidTimeZone,
  normalizePhoneNumber,
  sanitizeInput,
  sleep,
} = require("../../utils");

class MikrotikService {
  constructor(activityLog) {
    this.activityLog = activityLog;
    this.connectionLock = new AsyncLock();
    this.liveConnection = null;
    this.pendingOperations = 0;
    this.idleDisconnectTimer = null;
    this.activeOperation = null;
    this.readConnectionLock = new AsyncLock();
    this.readLiveConnection = null;
    this.readPendingOperations = 0;
    this.readIdleDisconnectTimer = null;
    this.activeReadOperation = null;
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
      try {
        await client.close();
      } catch {
        // A failed connect may not have an open socket to close.
      }
      this.activityLog.push("error", "mikrotik", `Gagal konek MikroTik ${label}: ${error.message}`);
      return null;
    }
  }

  async disconnectCurrentConnection() {
    const active = this.liveConnection;
    this.liveConnection = null;
    if (!active) return;
    try {
      await active.client.close();
    } catch (error) {
      this.activityLog.push("warn", "mikrotik", `Gagal menutup koneksi MikroTik: ${error.message}`);
    }
  }

  scheduleIdleDisconnect() {
    clearTimeout(this.idleDisconnectTimer);
    this.idleDisconnectTimer = null;
    if (!this.liveConnection) return;

    const idleMs = Math.max(0, Number(CONFIG.MIKROTIK_IDLE_TIMEOUT_MS) || 0);
    if (idleMs === 0) return;
    this.idleDisconnectTimer = setTimeout(() => {
      this.idleDisconnectTimer = null;
      void this.connectionLock.runExclusive("routeros", async () => {
        if (this.liveConnection && this.pendingOperations === 0) {
          await this.disconnectCurrentConnection();
        }
      }).catch((error) => {
        this.activityLog.push("warn", "mikrotik", `Pembersihan koneksi idle gagal: ${error.message}`);
      });
    }, idleMs);
    this.idleDisconnectTimer.unref?.();
  }

  async withConnection(operation, metrics = null, label = "operation") {
    const started = process.hrtime.bigint();
    const blockedBy = this.activeOperation;
    const waiting = this.pendingOperations;
    const limit = Math.max(1, Number(CONFIG.MIKROTIK_MAX_PENDING_OPERATIONS) || 40);
    if (this.pendingOperations >= limit) {
      const error = new Error("Antrean MikroTik sedang penuh. Coba beberapa saat lagi.");
      error.statusCode = 503;
      throw error;
    }

    this.pendingOperations += 1;
    try {
      return await this.connectionLock.runExclusive("routeros", async () => {
        if (metrics) {
          metrics.queueMs = Number(process.hrtime.bigint() - started) / 1e6;
          metrics.lane = "write";
          metrics.waiting = waiting;
          if (blockedBy) metrics.blockedBy = blockedBy;
        }
        this.activeOperation = label;
        clearTimeout(this.idleDisconnectTimer);
        this.idleDisconnectTimer = null;

        const connectionStarted = process.hrtime.bigint();
        try {
          if (this.liveConnection
            && typeof this.liveConnection.client.isConnected === "function"
            && !this.liveConnection.client.isConnected()) {
            await this.disconnectCurrentConnection();
          }

          if (!this.liveConnection) {
            const configs = this.getConnectionConfigs();
            if (configs.length === 0) {
              throw new Error("Konfigurasi MikroTik belum lengkap. Isi IP_MIKROTIK, USER_MIKROTIK, dan PASSWORD_MIKROTIK di .env.");
            }
            for (const item of configs) {
              this.liveConnection = await this.tryConnect(item);
              if (this.liveConnection) break;
            }
          }

          if (!this.liveConnection) {
            throw new Error("Gagal terhubung ke MikroTik primary maupun backup.");
          }

          if (metrics) metrics.connectionMs = Number(process.hrtime.bigint() - connectionStarted) / 1e6;
          const commandStarted = process.hrtime.bigint();
          try {
            return await operation(this.liveConnection.connection, this.liveConnection);
          } finally {
            if (metrics) metrics.commandMs = Number(process.hrtime.bigint() - commandStarted) / 1e6;
          }
        } catch (error) {
          await this.disconnectCurrentConnection();
          throw error;
        } finally {
          this.activeOperation = null;
          this.scheduleIdleDisconnect();
        }
      });
    } finally {
      this.pendingOperations -= 1;
      const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
      if (metrics) metrics.totalMs = durationMs;
      if (durationMs > 1500) {
        this.activityLog.push("warn", "performance",
          `RouterOS write ${label} memerlukan ${Math.round(durationMs)} ms (waiting=${waiting}, blockedBy=${blockedBy || "none"})`);
      }
    }
  }

  async disconnectReadConnection() {
    const active = this.readLiveConnection;
    this.readLiveConnection = null;
    if (!active) return;
    try {
      await active.client.close();
    } catch (error) {
      this.activityLog.push("warn", "mikrotik", `Gagal menutup koneksi pembacaan: ${error.message}`);
    }
  }

  scheduleReadIdleDisconnect() {
    clearTimeout(this.readIdleDisconnectTimer);
    this.readIdleDisconnectTimer = null;
    if (!this.readLiveConnection) return;
    const idleMs = Math.max(0, Number(CONFIG.MIKROTIK_IDLE_TIMEOUT_MS) || 0);
    if (idleMs === 0) return;
    this.readIdleDisconnectTimer = setTimeout(() => {
      this.readIdleDisconnectTimer = null;
      void this.readConnectionLock.runExclusive("routeros-read", async () => {
        if (this.readLiveConnection && this.readPendingOperations === 0) {
          await this.disconnectReadConnection();
        }
      }).catch((error) => {
        this.activityLog.push("warn", "mikrotik", `Pembersihan koneksi pembacaan gagal: ${error.message}`);
      });
    }, idleMs);
    this.readIdleDisconnectTimer.unref?.();
  }

  async withReadConnection(operation, metrics = null, label = "read") {
    const started = process.hrtime.bigint();
    const blockedBy = this.activeReadOperation;
    const waiting = this.readPendingOperations;
    const limit = Math.max(1, Number(CONFIG.MIKROTIK_MAX_PENDING_OPERATIONS) || 40);
    if (this.readPendingOperations >= limit) {
      const error = new Error("Antrean pembacaan MikroTik sedang penuh. Coba beberapa saat lagi.");
      error.statusCode = 503;
      throw error;
    }
    this.readPendingOperations += 1;
    try {
      return await this.readConnectionLock.runExclusive("routeros-read", async () => {
        this.activeReadOperation = label;
        if (metrics) {
          metrics.queueMs = Number(process.hrtime.bigint() - started) / 1e6;
          metrics.lane = "read";
          metrics.waiting = waiting;
          if (blockedBy) metrics.blockedBy = blockedBy;
        }
        clearTimeout(this.readIdleDisconnectTimer);
        this.readIdleDisconnectTimer = null;
        const connectionStarted = process.hrtime.bigint();
        try {
          if (this.readLiveConnection
            && typeof this.readLiveConnection.client.isConnected === "function"
            && !this.readLiveConnection.client.isConnected()) {
            await this.disconnectReadConnection();
          }
          if (!this.readLiveConnection) {
            const configs = this.getConnectionConfigs();
            if (configs.length === 0) {
              throw new Error("Konfigurasi MikroTik belum lengkap. Isi IP_MIKROTIK, USER_MIKROTIK, dan PASSWORD_MIKROTIK di .env.");
            }
            for (const item of configs) {
              this.readLiveConnection = await this.tryConnect(item);
              if (this.readLiveConnection) break;
            }
          }
          if (!this.readLiveConnection) {
            throw new Error("Gagal terhubung ke MikroTik primary maupun backup.");
          }
          if (metrics) metrics.connectionMs = Number(process.hrtime.bigint() - connectionStarted) / 1e6;
          const commandStarted = process.hrtime.bigint();
          try {
            return await operation(this.readLiveConnection.connection, this.readLiveConnection);
          } finally {
            if (metrics) metrics.commandMs = Number(process.hrtime.bigint() - commandStarted) / 1e6;
          }
        } catch (error) {
          await this.disconnectReadConnection();
          throw error;
        } finally {
          this.activeReadOperation = null;
          this.scheduleReadIdleDisconnect();
        }
      });
    } finally {
      this.readPendingOperations -= 1;
      const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
      if (metrics) metrics.totalMs = durationMs;
      if (durationMs > 1500 && !metrics) {
        this.activityLog.push("warn", "performance",
          `RouterOS read ${label} memerlukan ${Math.round(durationMs)} ms (waiting=${waiting}, blockedBy=${blockedBy || "none"})`);
      }
    }
  }

  async close() {
    clearTimeout(this.idleDisconnectTimer);
    clearTimeout(this.readIdleDisconnectTimer);
    this.idleDisconnectTimer = null;
    this.readIdleDisconnectTimer = null;
    await Promise.all([
      this.connectionLock.runExclusive("routeros", () => this.disconnectCurrentConnection()),
      this.readConnectionLock.runExclusive("routeros-read", () => this.disconnectReadConnection()),
    ]);
  }

  async getHotspotProfiles(options = {}) {
    return this.withReadConnection(async (conn) => {
      const profiles = await conn.menu("/ip/hotspot/user/profile").print();
      return (profiles || [])
        .map((profile) => ({
          name: profile.name,
          rateLimit: readRouterValue(profile, "rate-limit", "rateLimit", ""),
        }))
        .filter((profile) => profile.name)
        .sort((a, b) => a.name.localeCompare(b.name, "id-ID"));
    }, options.metrics, "getHotspotProfiles");
  }

  async getVoucherProfiles() {
    return this.withConnection(async (conn) => {
      const [profiles, schedulers, pools, queues] = await Promise.all([
        conn.menu("/ip/hotspot/user/profile").print(),
        conn.menu("/system/scheduler").print(),
        conn.menu("/ip/pool").print(),
        conn.menu("/queue/simple").print(),
      ]);
      const schedulerByName = new Map((schedulers || []).map((scheduler) => [
        String(scheduler.name || ""),
        scheduler,
      ]));
      const rows = (profiles || []).map((profile) => {
        const metadata = parseVoucherProfileMetadata(readRouterValue(profile, "on-login", "onLogin", ""));
        const scheduler = schedulerByName.get(String(profile.name || ""));
        const schedulerEnabled = Boolean(scheduler)
          && String(scheduler.disabled || "false").toLowerCase() !== "true";
        const hasExpiryRule = Boolean(VOUCHER_EXPIRY_MODES[metadata.expiredMode] && metadata.validity);
        return {
          id: profile[".id"] || profile.id || "",
          name: sanitizeInput(String(profile.name || "")),
          sharedUsers: Math.max(1, Number(readRouterValue(profile, "shared-users", "sharedUsers", 1)) || 1),
          rateLimit: sanitizeInput(String(readRouterValue(profile, "rate-limit", "rateLimit", ""))),
          addressPool: sanitizeInput(String(readRouterValue(profile, "address-pool", "addressPool", ""))) || "none",
          parentQueue: sanitizeInput(String(readRouterValue(profile, "parent-queue", "parentQueue", ""))) || "none",
          ...metadata,
          schedulerEnabled,
          voucherReady: hasExpiryRule && schedulerEnabled,
          status: hasExpiryRule
            ? (schedulerEnabled ? "READY" : "SCHEDULER_MISSING")
            : "EXPIRY_MISSING",
        };
      }).filter((profile) => profile.name)
        .sort((a, b) => a.name.localeCompare(b.name, "id-ID"));

      return {
        profiles: rows,
        pools: (pools || []).map((pool) => sanitizeInput(String(pool.name || ""))).filter(Boolean).sort(),
        parentQueues: (queues || [])
          .filter((queue) => String(queue.dynamic || "false").toLowerCase() !== "true")
          .map((queue) => sanitizeInput(String(queue.name || ""))).filter(Boolean).sort(),
        expiryModes: Object.entries(VOUCHER_EXPIRY_MODES).map(([value, mode]) => ({
          value,
          label: mode.label,
        })),
      };
    }, null, "getVoucherProfiles");
  }

  async getVoucherProfileStats(options = {}) {
    return this.withConnection(async (conn) => {
      const [profiles, users, reportScripts] = await Promise.all([
        conn.menu("/ip/hotspot/user/profile").print(),
        conn.menu("/ip/hotspot/user").print(),
        conn.menu("/system/script").print(),
      ]);
      const statsByProfile = new Map();

      for (const profile of profiles || []) {
        const name = sanitizeInput(String(profile.name || ""));
        if (!name) continue;
        const metadata = parseVoucherProfileMetadata(readRouterValue(profile, "on-login", "onLogin", ""));
        if (!VOUCHER_EXPIRY_MODES[metadata.expiredMode] || !metadata.validity) continue;
        statsByProfile.set(name, {
          profile: name,
          expiredMode: metadata.expiredMode,
          validity: metadata.validity,
          totalUsers: new Set(),
          usedUsers: new Set(),
          unusedUsers: new Set(),
        });
      }

      const markUsed = (row, username) => {
        row.totalUsers.add(username);
        row.unusedUsers.delete(username);
        row.usedUsers.add(username);
      };

      for (const user of users || []) {
        const profileName = sanitizeInput(String(user.profile || ""));
        const row = statsByProfile.get(profileName);
        if (!row) continue;
        const username = sanitizeInput(String(user.name || user.user || user[".id"] || ""));
        if (!username) continue;
        const comment = String(user.comment || "").trim();
        const disabled = ["true", "yes"].includes(String(user.disabled || "").trim().toLowerCase());
        const expiredByLimit = String(readRouterValue(user, "limit-uptime", "limitUptime", "")) === "1s";
        const unused = !disabled
          && !expiredByLimit
          && /^(?:vc\||vc-|up-|voucher-)/i.test(comment);
        row.totalUsers.add(username);
        if (unused) row.unusedUsers.add(username);
        else row.usedUsers.add(username);
      }

      for (const script of reportScripts || []) {
        if (String(script.comment || "").trim().toLowerCase() !== "mikhmon") continue;
        const parts = String(script.name || "").split("-|-");
        const username = sanitizeInput(String(parts[2] || ""));
        const profileName = sanitizeInput(String(parts[7] || ""));
        const service = String(parts[9] || "hotspot").trim().toLowerCase();
        const row = statsByProfile.get(profileName);
        if (!row || !username || service !== "hotspot") continue;
        if (!VOUCHER_EXPIRY_MODES[row.expiredMode]?.recordsUsage) continue;
        markUsed(row, username);
      }

      for (const entry of Array.isArray(options.knownUsageEntries) ? options.knownUsageEntries : []) {
        const row = statsByProfile.get(sanitizeInput(String(entry?.profile || "")));
        const username = sanitizeInput(String(entry?.username || ""));
        if (!row || !username || !VOUCHER_EXPIRY_MODES[row.expiredMode]?.recordsUsage) continue;
        markUsed(row, username);
      }

      const profileStats = Array.from(statsByProfile.values())
        .map((row) => ({
          profile: row.profile,
          expiredMode: row.expiredMode,
          validity: row.validity,
          total: row.totalUsers.size,
          used: row.usedUsers.size,
          unused: row.unusedUsers.size,
        }))
        .sort((a, b) => b.total - a.total || a.profile.localeCompare(b.profile, "id-ID"));
      const summary = profileStats.reduce((totals, row) => ({
        total: totals.total + row.total,
        used: totals.used + row.used,
        unused: totals.unused + row.unused,
      }), { total: 0, used: 0, unused: 0 });

      return { summary, profiles: profileStats };
    }, null, "getVoucherProfileStats");
  }

  async getVoucherRevenueReport(options = {}) {
    const range = normalizeVoucherRevenueRange(options);
    const timeZone = sanitizeInput(String(options.timeZone || DEFAULT_SETTINGS.timezone)) || DEFAULT_SETTINGS.timezone;
    return this.withConnection(async (conn) => {
      const [profiles, reportScripts] = await Promise.all([
        conn.menu("/ip/hotspot/user/profile").print(),
        conn.menu("/system/script").print(),
      ]);
      const profileFinancials = new Map();
      const recordProfiles = new Set();
      for (const profile of profiles || []) {
        const name = sanitizeInput(String(profile.name || ""));
        if (!name) continue;
        const metadata = parseVoucherProfileMetadata(readRouterValue(profile, "on-login", "onLogin", ""));
        const mode = VOUCHER_EXPIRY_MODES[metadata.expiredMode];
        if (!mode?.recordsUsage || !metadata.validity) continue;
        recordProfiles.add(name);
        profileFinancials.set(name, {
          sellingPrice: metadata.sellingPrice,
          costPrice: metadata.costPrice,
          commission: metadata.commission,
        });
      }

      const entriesById = new Map();
      for (const script of reportScripts || []) {
        const entry = parseVoucherUsageRecord(script, profileFinancials, timeZone);
        if (!entry || !recordProfiles.has(entry.profile)) continue;
        entriesById.set(entry.id, entry);
      }
      return buildVoucherRevenueReport(Array.from(entriesById.values()), { ...range, timeZone });
    }, null, "getVoucherRevenueReport");
  }

  async getVoucherUsageRecords(options = {}) {
    const timeZone = sanitizeInput(String(options.timeZone || DEFAULT_SETTINGS.timezone)) || DEFAULT_SETTINGS.timezone;
    return this.withConnection(async (conn) => {
      const [profiles, reportScripts] = await Promise.all([
        conn.menu("/ip/hotspot/user/profile").print(),
        conn.menu("/system/script").print(),
      ]);
      const profileFinancials = new Map();
      for (const profile of profiles || []) {
        const name = sanitizeInput(String(profile.name || ""));
        if (!name) continue;
        const metadata = parseVoucherProfileMetadata(readRouterValue(profile, "on-login", "onLogin", ""));
        profileFinancials.set(name, {
          sellingPrice: metadata.sellingPrice,
          costPrice: metadata.costPrice,
          commission: metadata.commission,
        });
      }
      return (reportScripts || [])
        .map((script) => parseVoucherUsageRecord(script, profileFinancials, timeZone))
        .filter(Boolean);
    }, null, "getVoucherUsageRecords");
  }

  async deleteVoucherUsageRecords(records = []) {
    const expectedByRouterId = new Map((Array.isArray(records) ? records : [])
      .filter((record) => record?.routerScriptId && record?.id)
      .map((record) => [String(record.routerScriptId), String(record.id)]));
    if (expectedByRouterId.size === 0) return { removed: 0, skipped: 0, failed: 0 };

    return this.withConnection(async (conn) => {
      const menu = conn.menu("/system/script");
      const scripts = await menu.print();
      let removed = 0;
      let skipped = 0;
      let failed = 0;
      for (const script of scripts || []) {
        const routerScriptId = sanitizeInput(String(script[".id"] || script.id || ""));
        const expectedId = expectedByRouterId.get(routerScriptId);
        if (!expectedId) continue;
        const currentRecord = parseVoucherUsageRecord(script, new Map(), DEFAULT_SETTINGS.timezone);
        if (!currentRecord || currentRecord.id !== expectedId) {
          skipped += 1;
          continue;
        }
        try {
          await menu.remove(routerScriptId);
          removed += 1;
        } catch (error) {
          failed += 1;
          this.activityLog.push("error", "voucher", `Catatan voucher ${routerScriptId} gagal dihapus dari MikroTik`, {
            error: error.message,
          });
        }
      }
      return { removed, skipped, failed };
    }, null, "deleteVoucherUsageRecords");
  }

  async saveVoucherProfile(payload) {
    const request = normalizeVoucherProfilePayload(payload);
    const scripts = buildVoucherProfileScripts(request);
    return this.withConnection(async (conn) => {
      const profileMenu = conn.menu("/ip/hotspot/user/profile");
      const schedulerMenu = conn.menu("/system/scheduler");
      const userMenu = conn.menu("/ip/hotspot/user");
      const [profiles, schedulers, pools, queues] = await Promise.all([
        profileMenu.print(),
        schedulerMenu.print(),
        conn.menu("/ip/pool").print(),
        conn.menu("/queue/simple").print(),
      ]);
      const lookupName = request.originalName || request.name;
      const existing = (profiles || []).find((profile) => String(profile.name || "") === lookupName);
      const conflicting = (profiles || []).find((profile) => (
        String(profile.name || "") === request.name
        && String(profile[".id"] || profile.id || "") !== String(existing?.[".id"] || existing?.id || "")
      ));
      if (conflicting) throw new Error(`Profile "${request.name}" sudah ada di MikroTik.`);

      const poolNames = new Set((pools || []).map((pool) => String(pool.name || "")));
      if (request.addressPool !== "none" && !poolNames.has(request.addressPool)) {
        throw new Error(`Address pool "${request.addressPool}" tidak ditemukan.`);
      }
      const queueNames = new Set((queues || [])
        .filter((queue) => String(queue.dynamic || "false").toLowerCase() !== "true")
        .map((queue) => String(queue.name || "")));
      if (request.parentQueue !== "none" && !queueNames.has(request.parentQueue)) {
        throw new Error(`Parent queue "${request.parentQueue}" tidak ditemukan.`);
      }

      const scheduler = (schedulers || []).find((item) => String(item.name || "") === lookupName);
      if (scheduler && !/^Monitor Profile /i.test(String(scheduler.comment || ""))) {
        throw new Error(`Scheduler "${lookupName}" sudah dipakai untuk fungsi lain. Ubah nama profile voucher.`);
      }

      const profilePayload = {
        name: request.name,
        "address-pool": request.addressPool,
        "rate-limit": request.rateLimit,
        "shared-users": String(request.sharedUsers),
        "status-autorefresh": "1m",
        "on-login": scripts.onLogin,
        "parent-queue": request.parentQueue,
      };
      if (existing) {
        const id = existing[".id"] || existing.id;
        await profileMenu.update(profilePayload, String(id));
      } else {
        await profileMenu.add(profilePayload);
      }

      const schedulerPayload = {
        name: request.name,
        "start-time": "01:17:31",
        interval: "00:02:31",
        "on-event": scripts.monitor,
        disabled: "no",
        comment: `Monitor Profile ${request.name}`,
      };
      if (scheduler) {
        await schedulerMenu.update(schedulerPayload, String(scheduler[".id"] || scheduler.id));
      } else {
        await schedulerMenu.add(schedulerPayload);
      }

      const users = await userMenu.print();
      let migratedVoucherComments = 0;
      for (const user of users || []) {
        if (String(user.profile || "") !== request.name) continue;
        const comment = String(user.comment || "");
        const match = comment.match(/^voucher-([a-z0-9]+-[a-f0-9]+)(?:\s+(.*))?$/i);
        if (!match) continue;
        await userMenu.update({ comment: `vc|${match[1]}|${sanitizeInput(String(match[2] || ""))}` }, String(user[".id"] || user.id));
        migratedVoucherComments += 1;
      }

      this.activityLog.push("info", "voucher-profile", `${existing ? "Profile diperbarui" : "Profile dibuat"}: ${request.name}`, {
        expiredMode: request.expiredMode,
        validity: request.validity,
        migratedVoucherComments,
      });
      return {
        ...request,
        voucherReady: true,
        schedulerEnabled: true,
        status: "READY",
        migratedVoucherComments,
      };
    }, null, "saveVoucherProfile");
  }

  async getHotspotServers(options = {}) {
    return this.withReadConnection(async (conn) => {
      const servers = await conn.menu("/ip/hotspot").print();
      return (servers || [])
        .map((server) => sanitizeInput(String(server.name || "")))
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b, "id-ID"));
    }, options.metrics, "getHotspotServers");
  }

  async getHotspotVoucherBatches(options = {}) {
    const includeAll = options.limit === "all";
    const requestedLimit = Number(options.limit ?? 50);
    const limit = includeAll
      ? Number.POSITIVE_INFINITY
      : (Number.isInteger(requestedLimit) && requestedLimit > 0 ? Math.min(requestedLimit, 100) : 50);
    return this.withConnection(async (conn) => {
      const knownBatches = Array.isArray(options.knownBatches) ? options.knownBatches : [];
      const timeZone = isValidTimeZone(options.timeZone) ? options.timeZone : DEFAULT_SETTINGS.timezone;
      const [users, profiles, reportScripts] = await Promise.all([
        conn.menu("/ip/hotspot/user").print(),
        conn.menu("/ip/hotspot/user/profile").print(),
        conn.menu("/system/script").print(),
      ]);
      const profileDetails = new Map((profiles || []).map((profile) => {
        const metadata = parseVoucherProfileMetadata(readRouterValue(profile, "on-login", "onLogin", ""));
        return [
          String(profile.name || ""),
          {
            sellingPrice: Math.max(0, Number(metadata.sellingPrice || metadata.costPrice) || 0),
            validity: sanitizeInput(String(metadata.validity || "")),
            lockUser: Boolean(metadata.lockUser),
          },
        ];
      }));
      const usersByName = new Map((users || []).map((user) => [
        String(user.name || user.user || "").toLowerCase(),
        user,
      ]).filter(([username]) => username));
      const usageByUsername = new Map();
      const rememberUsage = (entry) => {
        const username = sanitizeInput(String(entry?.username || ""));
        if (!username) return;
        const key = username.toLowerCase();
        const records = usageByUsername.get(key) || [];
        const usage = {
          batchId: sanitizeInput(String(entry?.batchId || "")),
          usedAt: entry?.usedAt || null,
        };
        if (!records.some((record) => record.batchId === usage.batchId && record.usedAt === usage.usedAt)) {
          records.push(usage);
        }
        usageByUsername.set(key, records);
      };
      for (const entry of Array.isArray(options.knownUsageEntries) ? options.knownUsageEntries : []) {
        rememberUsage(entry);
      }
      for (const script of reportScripts || []) {
        if (String(script.comment || "").trim().toLowerCase() !== "mikhmon") continue;
        const parts = String(script.name || "").split("-|-");
        const username = sanitizeInput(String(parts[2] || ""));
        if (!username) continue;
        const usageDate = parseRouterVoucherUsageDate(parts[0], parts[1], timeZone);
        const batch = parseVoucherBatchComment(parts[8]);
        rememberUsage({
          username,
          batchId: batch?.batchId || "",
          usedAt: usageDate?.date?.toISOString() || null,
        });
      }
      const findBatchUsage = (username, batchId) => {
        const records = usageByUsername.get(String(username || "").toLowerCase()) || [];
        return records.findLast((record) => record.batchId === batchId) || null;
      };
      const batches = new Map();

      for (const user of users || []) {
        const comment = sanitizeInput(String(user.comment || ""));
        const parsedComment = parseVoucherBatchComment(comment);
        if (!parsedComment) continue;
        const username = sanitizeInput(String(user.name || user.user || ""));
        if (!username) continue;

        const batchId = parsedComment.batchId;
        const batchComment = parsedComment.comment;
        if (!batches.has(batchId)) {
          const profileName = sanitizeInput(String(user.profile || ""));
          const profileDetail = profileDetails.get(profileName) || {};
          const timestamp = Number.parseInt(batchId.split("-", 1)[0], 36);
          const timestampIsValid = Number.isFinite(timestamp)
            && timestamp >= Date.UTC(2020, 0, 1)
            && timestamp <= Date.now() + 86_400_000;
          batches.set(batchId, {
            batchId,
            createdAt: timestampIsValid ? new Date(timestamp).toISOString() : null,
            generationType: "BULK",
            server: sanitizeInput(String(user.server || "")) || "all",
            profile: profileName,
            sellingPrice: profileDetail.sellingPrice || 0,
            validity: profileDetail.validity || "",
            lockUser: Boolean(profileDetail.lockUser),
            limitUptime: sanitizeInput(String(readRouterValue(user, "limit-uptime", "limitUptime", ""))) || null,
            dataLimitBytes: Math.max(0, Number(readRouterValue(user, "limit-bytes-total", "limitBytesTotal", 0)) || 0),
            comment: sanitizeInput(String(batchComment)),
            vouchers: [],
          });
        }

        const batch = batches.get(batchId);
        const usage = findBatchUsage(username, batchId);
        batch.vouchers.push({
          username,
          password: sanitizeInput(String(user.password || "")),
          macAddress: sanitizeInput(String(readRouterValue(user, "mac-address", "macAddress", ""))),
          disabled: String(user.disabled || "false").toLowerCase() === "true",
          used: Boolean(usage),
          usageStatus: usage ? "USED" : "UNUSED",
          usedAt: usage?.usedAt || null,
        });
        if (!batch.profile && user.profile) batch.profile = sanitizeInput(String(user.profile));
        if ((!batch.server || batch.server === "all") && user.server) {
          batch.server = sanitizeInput(String(user.server));
        }
        batch.dataLimitBytes = Math.max(
          batch.dataLimitBytes,
          Math.max(0, Number(readRouterValue(user, "limit-bytes-total", "limitBytesTotal", 0)) || 0)
        );
      }

      for (const knownBatch of knownBatches) {
        if (!knownBatch?.batchId || !Array.isArray(knownBatch.vouchers)) continue;
        const batchId = String(knownBatch.batchId);
        if (!batches.has(batchId)) {
          batches.set(batchId, { ...structuredClone(knownBatch), batchId, vouchers: [] });
        }
        const batch = batches.get(batchId);
        if (!batch.createdAt && knownBatch.createdAt) batch.createdAt = knownBatch.createdAt;
        if (!batch.profile && knownBatch.profile) batch.profile = knownBatch.profile;
        if (!batch.validity && knownBatch.validity) batch.validity = knownBatch.validity;
        if (batch.lockUser === undefined && knownBatch.lockUser !== undefined) {
          batch.lockUser = Boolean(knownBatch.lockUser);
        }
        if ((!batch.server || batch.server === "all") && knownBatch.server) batch.server = knownBatch.server;
        if (!batch.limitUptime && knownBatch.limitUptime) batch.limitUptime = knownBatch.limitUptime;
        if (!batch.comment && knownBatch.comment) batch.comment = knownBatch.comment;
        if (!batch.sellingPrice && knownBatch.sellingPrice) batch.sellingPrice = knownBatch.sellingPrice;
        if (!(batch.dataLimitBytes > 0) && Number(knownBatch.dataLimit) > 0) {
          batch.dataLimit = knownBatch.dataLimit;
          batch.dataUnit = knownBatch.dataUnit || "MB";
        }
        const vouchersByUsername = new Map((batch.vouchers || []).map((voucher) => [
          String(voucher.username || "").toLowerCase(),
          voucher,
        ]).filter(([username]) => username));
        for (const storedVoucher of knownBatch.vouchers) {
          const username = sanitizeInput(String(storedVoucher.username || ""));
          if (!username) continue;
          const key = username.toLowerCase();
          const routerUser = usersByName.get(key);
          const usage = findBatchUsage(key, batchId);
          const routerBatch = parseVoucherBatchComment(routerUser?.comment);
          const belongsToAnotherBatch = Boolean(
            routerBatch?.batchId && routerBatch.batchId.toLowerCase() !== batchId.toLowerCase()
          );
          let usageStatus = "MISSING";
          if (usage || (routerUser && routerBatch?.batchId !== batchId)) usageStatus = "USED";
          else if (routerUser) usageStatus = "UNUSED";
          else if (storedVoucher.used || storedVoucher.usageStatus === "USED") usageStatus = "USED";
          const routerVoucher = vouchersByUsername.get(key) || {};
          vouchersByUsername.set(key, {
            ...storedVoucher,
            ...routerVoucher,
            username,
            password: storedVoucher.password || routerVoucher.password || "",
            macAddress: routerUser && !belongsToAnotherBatch
              ? sanitizeInput(String(readRouterValue(routerUser, "mac-address", "macAddress", "")))
              : "",
            disabled: routerUser
              ? String(routerUser.disabled || "false").toLowerCase() === "true"
              : Boolean(storedVoucher.disabled),
            used: usageStatus === "USED",
            usageStatus,
            usedAt: usage?.usedAt || storedVoucher.usedAt || null,
          });
        }
        batch.vouchers = Array.from(vouchersByUsername.values());
      }

      return Array.from(batches.values())
        .map((batch) => {
          const useGigabytes = batch.dataLimitBytes > 0
            && batch.dataLimitBytes % 1_073_741_824 === 0;
          const dataUnit = batch.dataLimitBytes > 0
            ? (useGigabytes ? "GB" : "MB")
            : (batch.dataUnit || "MB");
          const divisor = useGigabytes ? 1_073_741_824 : 1_048_576;
          const vouchers = batch.vouchers.sort((a, b) => a.username.localeCompare(b.username, "id-ID"));
          return {
            ...batch,
            generationType: vouchers.length === 1 ? "SINGLE" : "BULK",
            quantity: vouchers.length,
            dataLimit: batch.dataLimitBytes > 0
              ? batch.dataLimitBytes / divisor
              : Math.max(0, Number(batch.dataLimit) || 0),
            dataUnit,
            vouchers,
            disabledCount: vouchers.filter((voucher) => voucher.disabled).length,
            dataLimitBytes: undefined,
          };
        })
        .sort((a, b) => {
          const timeDifference = new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime();
          return timeDifference || b.batchId.localeCompare(a.batchId, "id-ID");
        })
        .slice(0, limit);
    }, null, "getHotspotVoucherBatches");
  }

  async createHotspotVouchers(payload, options = {}) {
    const request = normalizeVoucherGenerationPayload(payload);
    const onProgress = typeof options.onProgress === "function" ? options.onProgress : () => {};
    const batchId = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
    const routerComment = `vc|${batchId}|${request.comment || ""}`;

    const result = await this.withConnection(async (conn) => {
      const userMenu = conn.menu("/ip/hotspot/user");
      const [users, profiles, servers] = await Promise.all([
        userMenu.print(),
        conn.menu("/ip/hotspot/user/profile").print(),
        conn.menu("/ip/hotspot").print(),
      ]);
      const selectedProfile = (profiles || []).find((profile) => String(profile.name || "") === request.profile);
      if (!selectedProfile) {
        throw new Error(`Profile "${request.profile}" tidak ditemukan di MikroTik.`);
      }
      const profileMetadata = parseVoucherProfileMetadata(
        readRouterValue(selectedProfile, "on-login", "onLogin", "")
      );
      const schedulers = await conn.menu("/system/scheduler").print();
      const profileScheduler = (schedulers || []).find((scheduler) => (
        String(scheduler.name || "") === request.profile
        && String(scheduler.disabled || "false").toLowerCase() !== "true"
      ));
      if (!VOUCHER_EXPIRY_MODES[profileMetadata.expiredMode] || !profileMetadata.validity || !profileScheduler) {
        throw new Error(`Profile "${request.profile}" belum siap untuk voucher. Atur masa berlaku dan monitor expired terlebih dahulu.`);
      }
      const serverNames = new Set((servers || []).map((server) => String(server.name || "")));
      if (request.server !== "all" && !serverNames.has(request.server)) {
        throw new Error(`Server hotspot "${request.server}" tidak ditemukan di MikroTik.`);
      }

      const reservedUsernames = new Set((users || [])
        .map((user) => String(user.name || "").toLowerCase())
        .filter(Boolean));
      const vouchers = [];

      if (request.generationType === "SINGLE") {
        if (reservedUsernames.has(request.username.toLowerCase())) {
          throw new Error(`Username "${request.username}" sudah digunakan di MikroTik.`);
        }
        vouchers.push({ username: request.username, password: request.password });
      } else {
        const characters = VOUCHER_CHARACTER_SETS[request.characterSet];
        for (let index = 0; index < request.quantity; index += 1) {
          let username = "";
          for (let attempt = 0; attempt < 250; attempt += 1) {
            const candidate = `${request.prefix}${generateSecureVoucherCode(request.codeLength, characters)}`;
            if (!reservedUsernames.has(candidate.toLowerCase())) {
              username = candidate;
              reservedUsernames.add(candidate.toLowerCase());
              break;
            }
          }
          if (!username) {
            throw new Error("Kode voucher unik tidak dapat dibuat. Tambah panjang kode atau ubah prefix.");
          }
          const password = request.credentialMode === "SAME"
            ? username
            : generateSecureVoucherCode(request.codeLength, characters);
          vouchers.push({ username, password });
        }
      }

      const dataLimitMultiplier = request.dataUnit === "GB" ? 1_073_741_824 : 1_048_576;
      const dataLimitBytes = request.dataLimit * dataLimitMultiplier;
      const createdUsernames = [];
      try {
        for (const voucher of vouchers) {
          const addPayload = {
            server: request.server,
            name: voucher.username,
            password: voucher.password,
            profile: request.profile,
            comment: routerComment,
          };
          if (request.limitUptime) addPayload["limit-uptime"] = request.limitUptime;
          if (dataLimitBytes > 0) addPayload["limit-bytes-total"] = String(dataLimitBytes);
          const addResult = await userMenu.add(addPayload);
          if (addResult?.["!trap"]) {
            const message = addResult["!trap"]?.[0]?.message || "Error tidak diketahui dari MikroTik.";
            throw new Error(`MikroTik menolak voucher "${voucher.username}": ${message}`);
          }
          createdUsernames.push(voucher.username);
          onProgress({
            phase: "CREATING",
            completed: createdUsernames.length,
            total: vouchers.length,
          });
        }

        onProgress({ phase: "VERIFYING", completed: vouchers.length, total: vouchers.length });
        const verifiedUsers = await userMenu.print();
        const verifiedByName = new Map((verifiedUsers || []).map((user) => [
          String(user.name || "").toLowerCase(),
          user,
        ]));
        const invalidVoucher = vouchers.find((voucher) => {
          const verified = verifiedByName.get(voucher.username.toLowerCase());
          return !verified || String(verified.profile || "") !== request.profile;
        });
        if (invalidVoucher) {
          throw new Error(`Voucher "${invalidVoucher.username}" gagal diverifikasi setelah dibuat.`);
        }
      } catch (error) {
        const cleanupFailures = [];
        for (const username of [...createdUsernames].reverse()) {
          try {
            await this.removeHotspotUsersByName(conn, username);
          } catch (cleanupError) {
            cleanupFailures.push(username);
          }
        }
        if (cleanupFailures.length > 0) {
          error.message = `${error.message} ${cleanupFailures.length} voucher gagal dibersihkan; periksa MikroTik.`;
        } else if (createdUsernames.length > 0) {
          error.message = `${error.message} Voucher yang sempat dibuat sudah dibatalkan.`;
        }
        throw error;
      }

      return {
        batchId,
        createdAt: new Date().toISOString(),
        generationType: request.generationType,
        quantity: vouchers.length,
        server: request.server,
        profile: request.profile,
        sellingPrice: Math.max(0, Number(profileMetadata.sellingPrice || profileMetadata.costPrice) || 0),
        validity: sanitizeInput(String(profileMetadata.validity || "")),
        lockUser: Boolean(profileMetadata.lockUser),
        limitUptime: request.limitUptime || null,
        dataLimit: request.dataLimit,
        dataUnit: request.dataUnit,
        comment: request.comment,
        vouchers,
      };
    }, null, "createHotspotVouchers");

    this.activityLog.push("info", "voucher", `${result.quantity} voucher hotspot berhasil dibuat`, {
      batchId: result.batchId,
      profile: result.profile,
      server: result.server,
      quantity: result.quantity,
    });
    return result;
  }

  async deleteHotspotVoucher(payload = {}) {
    const batchId = normalizeVoucherCredential(payload.batchId, "ID batch voucher", { maxLength: 128 });
    const username = normalizeVoucherCredential(payload.username, "Username voucher");
    return this.withConnection(async (conn) => {
      const users = await conn.menu("/ip/hotspot/user").print();
      const matches = (users || []).filter((user) => (
        String(user.name || user.user || "").toLowerCase() === username.toLowerCase()
      ));
      if (matches.length > 0) {
        const normalizedBatchId = batchId.toLowerCase();
        const belongsToBatch = matches.every((user) => {
          const comment = String(user.comment || "").trim().toLowerCase();
          const legacyComment = `voucher-${normalizedBatchId}`;
          return comment.startsWith(`vc|${normalizedBatchId}|`)
            || comment === legacyComment
            || comment.startsWith(`${legacyComment} `);
        });
        if (!belongsToBatch) {
          throw new Error(`Voucher "${username}" tidak lagi terhubung ke batch yang dipilih.`);
        }
      }

      const activeResult = await this.removeActiveHotspotSessionsByName(conn, username);
      const removeResult = await this.removeHotspotUsersByName(conn, username);
      const remainingUsers = await conn.menu("/ip/hotspot/user").print();
      const stillExists = (remainingUsers || []).some((user) => (
        String(user.name || user.user || "").toLowerCase() === username.toLowerCase()
      ));
      if (stillExists) throw new Error(`Voucher "${username}" masih ditemukan setelah penghapusan.`);

      return {
        batchId,
        username,
        activeSessionsKilled: activeResult.killed,
        removedUsers: removeResult.removed,
        alreadyAbsent: matches.length === 0,
      };
    }, null, "deleteHotspotVoucher");
  }

  async resetHotspotVoucherMac(payload = {}) {
    const batchId = normalizeVoucherCredential(payload.batchId, "ID batch voucher", { maxLength: 128 });
    const username = normalizeVoucherCredential(payload.username, "Username voucher");
    return this.withConnection(async (conn) => {
      const userMenu = conn.menu("/ip/hotspot/user");
      const users = await userMenu.print();
      const user = (users || []).find((item) => (
        String(item.name || item.user || "").toLowerCase() === username.toLowerCase()
      ));
      if (!user) {
        const error = new Error(`Voucher "${username}" tidak ditemukan di MikroTik.`);
        error.statusCode = 404;
        throw error;
      }

      const linkedBatch = parseVoucherBatchComment(user.comment)?.batchId;
      if (linkedBatch && linkedBatch.toLowerCase() !== batchId.toLowerCase()) {
        throw new Error(`Voucher "${username}" tidak lagi terhubung ke batch yang dipilih.`);
      }

      const previousMacAddress = sanitizeInput(String(readRouterValue(user, "mac-address", "macAddress", "")));
      const normalizedMac = previousMacAddress.toLowerCase();
      const alreadyReset = !normalizedMac || normalizedMac === "00:00:00:00:00:00";
      if (alreadyReset) {
        return { batchId, username, previousMacAddress: "", activeSessionsKilled: 0, alreadyReset: true };
      }

      const userId = String(user[".id"] || user.id || "");
      if (!userId) throw new Error(`ID voucher "${username}" tidak ditemukan di MikroTik.`);
      await userMenu.update({ "mac-address": "00:00:00:00:00:00" }, userId);

      const refreshedUsers = await userMenu.print();
      const refreshed = (refreshedUsers || []).find((item) => (
        String(item.name || item.user || "").toLowerCase() === username.toLowerCase()
      ));
      const currentMacAddress = sanitizeInput(String(readRouterValue(
        refreshed,
        "mac-address",
        "macAddress",
        ""
      ))).toLowerCase();
      if (currentMacAddress && currentMacAddress !== "00:00:00:00:00:00") {
        throw new Error(`MAC perangkat voucher "${username}" belum berhasil direset.`);
      }

      const activeResult = await this.removeActiveHotspotSessionsByName(conn, username);
      return {
        batchId,
        username,
        previousMacAddress,
        activeSessionsKilled: activeResult.killed,
        alreadyReset: false,
      };
    }, null, "resetHotspotVoucherMac");
  }

  async getHotspotUsers(options = {}) {
    return this.withReadConnection(async (conn) => {
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
    }, options.metrics, "getHotspotUsers");
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
    }, null, "getHotspotUsersForStatusSync");
  }

  async getIpBindingsForStatusSync(macAddresses = []) {
    const managedMacs = new Set(macAddresses.map((value) => normalizeMacAddress(value)).filter(Boolean));
    return this.withConnection(async (conn) => {
      const rows = await conn.menu("/ip/hotspot/ip-binding").print();
      return (rows || []).map((row) => ({
        id: row[".id"] || row.id || row.numbers || "",
        macAddress: normalizeMacAddress(readRouterValue(row, "mac-address", "macAddress", "")),
        type: sanitizeInput(String(row.type || "regular")).toLowerCase(),
        server: sanitizeInput(String(row.server || "all")) || "all",
        comment: sanitizeInput(String(row.comment || "")),
      })).filter((row) => row.macAddress && (managedMacs.size === 0 || managedMacs.has(row.macAddress)));
    }, null, "getIpBindingsForStatusSync");
  }

  async upsertIpBinding({ macAddress, contactId, type = "bypassed" }) {
    const normalizedMac = normalizeMacAddress(macAddress, { required: true });
    const normalizedType = String(type || "").trim().toLowerCase();
    if (!["regular", "bypassed", "blocked"].includes(normalizedType)) throw new Error("Tipe IP Binding tidak valid.");
    const ownerComment = buildIpBindingOwnerComment(contactId);

    return this.withConnection(async (conn) => {
      const menu = conn.menu("/ip/hotspot/ip-binding");
      const rows = await menu.print();
      const matches = (rows || []).filter((row) => {
        try {
          return normalizeMacAddress(readRouterValue(row, "mac-address", "macAddress", "")) === normalizedMac;
        } catch (_error) {
          return false;
        }
      });
      if (matches.length > 1) throw new Error(`MAC ${normalizedMac} memiliki lebih dari satu IP Binding di MikroTik.`);
      const existing = matches[0] || null;
      const existingComment = sanitizeInput(String(existing?.comment || ""));
      if (existingComment.startsWith("reminder-bot:") && existingComment !== ownerComment) {
        throw new Error(`MAC ${normalizedMac} sudah terhubung ke pelanggan lain.`);
      }

      const payload = {
        "mac-address": normalizedMac,
        type: normalizedType,
        server: "all",
        comment: ownerComment,
      };
      let created = false;
      if (existing) {
        const id = existing[".id"] || existing.id || existing.numbers || existing.number;
        if (!id) throw new Error(`ID IP Binding ${normalizedMac} tidak ditemukan di MikroTik.`);
        await menu.update(payload, String(id));
      } else {
        await menu.add(payload);
        created = true;
      }

      const verifiedRows = await menu.print();
      const verified = (verifiedRows || []).find((row) => {
        try {
          return normalizeMacAddress(readRouterValue(row, "mac-address", "macAddress", "")) === normalizedMac;
        } catch (_error) {
          return false;
        }
      });
      const verifiedType = sanitizeInput(String(verified?.type || "regular")).toLowerCase();
      if (!verified
        || verifiedType !== normalizedType
        || sanitizeInput(String(verified.comment || "")) !== ownerComment) {
        throw new Error(`IP Binding ${normalizedMac} gagal diverifikasi setelah disimpan.`);
      }
      return {
        id: verified[".id"] || verified.id || verified.numbers || "",
        macAddress: normalizedMac,
        type: normalizedType,
        server: sanitizeInput(String(verified.server || "all")) || "all",
        created,
        updated: !created,
      };
    }, null, "upsertIpBinding");
  }

  async setIpBindingDisabled({ macAddress, contactId, disabled = true }) {
    return this.upsertIpBinding({
      macAddress,
      contactId,
      type: disabled ? "blocked" : "bypassed",
    });
  }

  async deleteIpBinding({ macAddress, contactId }) {
    const normalizedMac = normalizeMacAddress(macAddress, { required: true });
    const ownerComment = buildIpBindingOwnerComment(contactId);
    return this.withConnection(async (conn) => {
      const menu = conn.menu("/ip/hotspot/ip-binding");
      const rows = await menu.print();
      const matches = (rows || []).filter((row) => {
        try {
          return normalizeMacAddress(readRouterValue(row, "mac-address", "macAddress", "")) === normalizedMac;
        } catch (_error) {
          return false;
        }
      });
      if (matches.some((row) => sanitizeInput(String(row.comment || "")) !== ownerComment)) {
        throw new Error(`IP Binding ${normalizedMac} bukan milik pelanggan ini.`);
      }
      for (const row of matches) {
        const id = row[".id"] || row.id || row.numbers || row.number;
        if (!id) throw new Error(`ID IP Binding ${normalizedMac} tidak ditemukan di MikroTik.`);
        await menu.remove(String(id));
      }
      return { macAddress: normalizedMac, removedBindings: matches.length };
    }, null, "deleteIpBinding");
  }

  async syncIpBindingBandwidthForCustomer(customer) {
    return this.withConnection((conn) => this.syncIpBindingBandwidthWithConnection(conn, customer), null, "syncIpBindingBandwidthForCustomer");
  }

  async syncIpBindingBandwidthForCustomers(customers = []) {
    return this.withConnection(async (conn) => {
      const results = [];
      for (const customer of customers) {
        try {
          results.push(await this.syncIpBindingBandwidthWithConnection(conn, customer));
        } catch (error) {
          results.push({
            contactId: String(customer?.contactId || customer?.id || ""),
            status: IP_BINDING_BANDWIDTH_STATUS.FAILED,
            rateLimit: "",
            targetAddresses: [],
            pendingMacAddresses: normalizeMacAddresses(customer?.macAddresses || customer?.mikrotikMacAddresses),
            devices: [],
            error: error.message,
            syncedAt: new Date().toISOString(),
          });
        }
      }
      return results;
    }, null, "syncIpBindingBandwidthForCustomers");
  }

  async syncIpBindingBandwidthWithConnection(conn, customer = {}) {
    const contactId = String(customer.contactId || customer.id || "").trim();
    if (!contactId) throw new Error("ID pelanggan wajib diisi untuk sinkronisasi bandwidth.");
    const profileName = sanitizeInput(String(customer.profile || customer.mikrotikProfile || ""));
    const macAddresses = normalizeMacAddresses(customer.macAddresses || customer.mikrotikMacAddresses);
    const ownerComment = buildIpBindingBandwidthOwnerComment(contactId);
    const queueMenu = conn.menu("/queue/simple");
    const queueRows = await queueMenu.print();
    const ownedQueues = (queueRows || []).filter((row) => sanitizeInput(String(row.comment || "")) === ownerComment);
    const removeOwnedQueues = async () => {
      for (const row of ownedQueues) {
        const id = row[".id"] || row.id || row.numbers || row.number;
        if (!id) throw new Error("ID Simple Queue bandwidth pelanggan tidak ditemukan.");
        await queueMenu.remove(String(id));
      }
      return ownedQueues.length;
    };
    const baseResult = {
      contactId,
      rateLimit: "",
      targetAddresses: [],
      pendingMacAddresses: [],
      devices: [],
      error: "",
      syncedAt: new Date().toISOString(),
    };

    if (macAddresses.length === 0) {
      const removedQueues = await removeOwnedQueues();
      return { ...baseResult, status: IP_BINDING_BANDWIDTH_STATUS.NONE, removedQueues };
    }
    if (!profileName) throw new Error("Profile hotspot wajib diisi untuk mengatur bandwidth IP Binding.");

    const profiles = await conn.menu("/ip/hotspot/user/profile").print();
    const profile = (profiles || []).find((row) => String(row.name || "") === profileName);
    if (!profile) throw new Error(`Profile hotspot "${profileName}" tidak ditemukan di MikroTik.`);
    const queueLimits = parseHotspotRateLimitForSimpleQueue(
      readRouterValue(profile, "rate-limit", "rateLimit", "")
    );
    if (!queueLimits) {
      const removedQueues = await removeOwnedQueues();
      return {
        ...baseResult,
        status: IP_BINDING_BANDWIDTH_STATUS.NO_RATE_LIMIT,
        pendingMacAddresses: macAddresses,
        devices: macAddresses.map((macAddress) => ({ macAddress, address: "", source: "", status: "NO_RATE_LIMIT" })),
        removedQueues,
      };
    }

    const [leases, hotspotHosts] = await Promise.all([
      conn.menu("/ip/dhcp-server/lease").print(),
      conn.menu("/ip/hotspot/host").print(),
    ]);
    const addressByMac = new Map();
    const rememberAddress = (row, source) => {
      let macAddress;
      try {
        macAddress = normalizeMacAddress(readRouterValue(row, "mac-address", "macAddress", ""));
      } catch (_error) {
        return;
      }
      if (!macAddresses.includes(macAddress) || addressByMac.has(macAddress)) return;
      const candidates = source === "DHCP"
        ? [
            readRouterValue(row, "active-address", "activeAddress", ""),
            row.address,
          ]
        : [
            readRouterValue(row, "to-address", "toAddress", ""),
            row.address,
          ];
      const address = candidates.map((value) => String(value || "").trim())
        .find((value) => net.isIP(value) === 4);
      if (address) addressByMac.set(macAddress, { address, source });
    };
    for (const lease of leases || []) rememberAddress(lease, "DHCP");
    for (const host of hotspotHosts || []) rememberAddress(host, "HOTSPOT");

    const devices = macAddresses.map((macAddress) => {
      const resolved = addressByMac.get(macAddress);
      return resolved
        ? { macAddress, address: resolved.address, source: resolved.source, status: "READY" }
        : { macAddress, address: "", source: "", status: "PENDING_DHCP" };
    });
    const targetAddresses = normalizeQueueTarget(devices.map((device) => device.address));
    const pendingMacAddresses = devices
      .filter((device) => !device.address)
      .map((device) => device.macAddress);

    if (targetAddresses.length === 0) {
      const removedQueues = await removeOwnedQueues();
      return {
        ...baseResult,
        status: IP_BINDING_BANDWIDTH_STATUS.PENDING_DHCP,
        rateLimit: queueLimits.source,
        pendingMacAddresses,
        devices,
        removedQueues,
      };
    }

    const disabled = Boolean(customer.disabled);
    const queueLimitsMatch = (row) => (
      normalizeSimpleQueueLimitForComparison(readRouterValue(row, "max-limit", "maxLimit", ""))
        === normalizeSimpleQueueLimitForComparison(queueLimits.maxLimit)
      && normalizeSimpleQueueLimitForComparison(readRouterValue(row, "burst-limit", "burstLimit", ""))
        === normalizeSimpleQueueLimitForComparison(queueLimits.burstLimit)
      && normalizeSimpleQueueLimitForComparison(readRouterValue(row, "burst-threshold", "burstThreshold", ""))
        === normalizeSimpleQueueLimitForComparison(queueLimits.burstThreshold)
      && sanitizeInput(String(readRouterValue(row, "burst-time", "burstTime", ""))) === queueLimits.burstTime
      && sanitizeInput(String(row.priority || "")) === queueLimits.priority
      && normalizeSimpleQueueLimitForComparison(readRouterValue(row, "limit-at", "limitAt", ""))
        === normalizeSimpleQueueLimitForComparison(queueLimits.limitAt)
    );
    const desiredQueues = targetAddresses.map((address) => ({
      address,
      payload: {
        name: buildIpBindingBandwidthQueueName(contactId, address),
        target: `${address}/32`,
        "max-limit": queueLimits.maxLimit,
        "burst-limit": queueLimits.burstLimit,
        "burst-threshold": queueLimits.burstThreshold,
        "burst-time": queueLimits.burstTime,
        priority: queueLimits.priority,
        "limit-at": queueLimits.limitAt,
        disabled: disabled ? "yes" : "no",
        comment: ownerComment,
      },
    }));
    const desiredByAddress = new Map(desiredQueues.map((entry) => [entry.address, entry]));
    const foreignQueueNames = new Set((queueRows || [])
      .filter((row) => sanitizeInput(String(row.comment || "")) !== ownerComment)
      .map((row) => String(row.name || "")));
    for (const entry of desiredQueues) {
      if (foreignQueueNames.has(entry.payload.name)) {
        throw new Error(`Nama Simple Queue "${entry.payload.name}" sudah digunakan oleh konfigurasi lain.`);
      }
    }

    const retainedByAddress = new Map();
    let changed = false;
    for (const row of ownedQueues) {
      const currentTargets = normalizeQueueTarget(readRouterValue(row, "target", "target", ""));
      const address = currentTargets.length === 1 ? currentTargets[0] : "";
      const desired = desiredByAddress.get(address);
      const canRetain = desired
        && !retainedByAddress.has(address)
        && String(row.name || "") === desired.payload.name;
      if (canRetain) {
        retainedByAddress.set(address, row);
        continue;
      }

      const id = row[".id"] || row.id || row.numbers || row.number;
      if (!id) throw new Error("ID Simple Queue bandwidth pelanggan tidak ditemukan.");
      await queueMenu.remove(String(id));
      changed = true;
    }

    for (const entry of desiredQueues) {
      const existing = retainedByAddress.get(entry.address);
      if (!existing) {
        await queueMenu.add(entry.payload);
        changed = true;
        continue;
      }

      const currentDisabled = existing.disabled === true
        || ["true", "yes"].includes(String(existing.disabled || "").toLowerCase());
      const currentTargets = normalizeQueueTarget(readRouterValue(existing, "target", "target", ""));
      const targetMatches = currentTargets.length === 1 && currentTargets[0] === entry.address;
      const needsUpdate = !targetMatches
        || !queueLimitsMatch(existing)
        || currentDisabled !== disabled;
      if (!needsUpdate) continue;
      const id = existing[".id"] || existing.id || existing.numbers || existing.number;
      if (!id) throw new Error("ID Simple Queue bandwidth pelanggan tidak ditemukan.");
      await queueMenu.update(entry.payload, String(id));
      changed = true;
    }

    const verifiedQueues = await queueMenu.print();
    const verifiedOwned = (verifiedQueues || [])
      .filter((row) => sanitizeInput(String(row.comment || "")) === ownerComment);
    const verifiedByAddress = new Map();
    let verificationFailed = verifiedOwned.length !== desiredQueues.length;
    for (const row of verifiedOwned) {
      const targets = normalizeQueueTarget(readRouterValue(row, "target", "target", ""));
      const address = targets.length === 1 ? targets[0] : "";
      const desired = desiredByAddress.get(address);
      const verifiedDisabled = row.disabled === true
        || ["true", "yes"].includes(String(row.disabled || "").toLowerCase());
      if (!desired
        || verifiedByAddress.has(address)
        || String(row.name || "") !== desired.payload.name
        || !queueLimitsMatch(row)
        || verifiedDisabled !== disabled) {
        verificationFailed = true;
        break;
      }
      verifiedByAddress.set(address, row);
    }
    if (verificationFailed || verifiedByAddress.size !== desiredQueues.length) {
      throw new Error("Simple Queue bandwidth IP Binding gagal diverifikasi setelah disimpan.");
    }

    return {
      ...baseResult,
      status: pendingMacAddresses.length > 0
        ? IP_BINDING_BANDWIDTH_STATUS.PARTIAL
        : IP_BINDING_BANDWIDTH_STATUS.ACTIVE,
      rateLimit: queueLimits.source,
      targetAddresses,
      pendingMacAddresses,
      devices,
      queueNames: desiredQueues.map((entry) => entry.payload.name),
      queueName: desiredQueues[0]?.payload.name || "",
      changed,
      disabled,
    };
  }

  async deleteIpBindingBandwidthQueue(contactId) {
    const ownerComment = buildIpBindingBandwidthOwnerComment(contactId);
    return this.withConnection(async (conn) => {
      const menu = conn.menu("/queue/simple");
      const rows = await menu.print();
      const matches = (rows || []).filter((row) => sanitizeInput(String(row.comment || "")) === ownerComment);
      for (const row of matches) {
        const id = row[".id"] || row.id || row.numbers || row.number;
        if (!id) throw new Error("ID Simple Queue bandwidth pelanggan tidak ditemukan.");
        await menu.remove(String(id));
      }
      return { contactId: String(contactId), removedQueues: matches.length };
    }, null, "deleteIpBindingBandwidthQueue");
  }

  async getNetwatchStatus(options = {}) {
    return this.withReadConnection(async (conn) => {
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
    }, options.metrics, "getNetwatchStatus");
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
    }, null, "deleteHotspotUser");
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
    }, null, "setHotspotUserDisabled");
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
    }, null, "reactivateHotspotUser");
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
    }, null, "createHotspotCustomer");
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
    }, null, "verifyHotspotCustomer");

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
    }, null, "updateHotspotCustomer");
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
      }, null, "generateDailyBackupFile");
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


module.exports = MikrotikService;
