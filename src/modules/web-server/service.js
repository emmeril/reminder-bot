const fs = require("fs/promises");
const path = require("path");
const express = require("express");
const crypto = require("crypto");
const QRCode = require("qrcode");
const {
  CONFIG,
  DEFAULT_SETTINGS,
  PAYMENT_STATUS,
  PAYMENT_TYPES,
  SUBSCRIPTION_TYPES,
} = require("../../config");
const AsyncLock = require("../../async-lock");
const { verifyPortalPassword } = require("../../portal-password");
const {
  MidtransService,
  PAYMENT_GATEWAY_STATUS,
  normalizeMidtransPaymentStatus,
} = require("../../midtrans-service");
const TelegramManager = require("../../telegram-manager");
const { sendManualBackups } = require("./manual-backup");
const {
  HOTSPOT_ACCESS_MODES,
  HOTSPOT_PROVISIONING_OPERATION,
  HOTSPOT_PROVISIONING_STATUS,
  getContactHotspotAccessMode,
  getHotspotAccessRouterState,
  getHotspotUnavailableMessage,
  isHotspotAccountUnavailable,
  isPrepaidPackage,
  isRecurringSubscription,
  normalizeHotspotAccessMode,
  normalizeHotspotProvisioningOperation,
  normalizeHotspotProvisioningStatus,
} = require("../customers/domain");
const registerCustomerRoutes = require("../customers/routes");
const {
  IP_BINDING_BANDWIDTH_STATUS,
  normalizeMacAddresses,
} = require("../mikrotik/domain");
const { normalizeVoucherGenerationPayload } = require("../vouchers/domain");
const registerVoucherRoutes = require("../vouchers/routes");
const {
  addMonthsSafely,
  escapeHtml,
  getBillingPeriodKey,
  getBillingPeriodParts,
  isValidPhoneNumber,
  makeBillingPeriodKey,
  normalizeNetworkHost,
  normalizePhoneNumber,
  parseBoolean,
  parseCookies,
  safeCompareString,
  sanitizeInput,
  sanitizeMultilineText,
  serializeCookie,
} = require("../../utils");

class WebServer {
  constructor(notificationBot, dataManager, templateManager, activityLog, reminderScheduler, authManager, mikrotikService, hotspotReactivationScheduler, midtransService = null, voucherRevenueSyncScheduler = null) {
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
    this.voucherRevenueSyncScheduler = voucherRevenueSyncScheduler;
    this.hotspotProvisioningLock = new AsyncLock();
    this.voucherGenerationLock = new AsyncLock();
    this.voucherProfileLock = new AsyncLock();
    this.backgroundJobs = new Map();
    this.backgroundOperationLock = new AsyncLock();
    this.activePeriodPurchaseLock = new AsyncLock();
    this.paymentGatewayLock = new AsyncLock();
    this.accountCredentialsLock = new AsyncLock();
    this.server = null;
    this.ready = true;
    this.setupRoutes();
  }

  pruneBackgroundJobs() {
    const expiresBefore = Date.now() - (6 * 60 * 60 * 1000);
    for (const [jobId, job] of this.backgroundJobs.entries()) {
      if (job.finishedAt && new Date(job.finishedAt).getTime() < expiresBefore) {
        this.backgroundJobs.delete(jobId);
      }
    }
  }

  toPublicBackgroundJob(job) {
    return {
      id: job.id,
      type: job.type,
      status: job.status,
      phase: job.phase,
      progress: job.progress,
      total: job.total,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      finishedAt: job.finishedAt,
      result: job.status === "COMPLETED" ? structuredClone(job.result ?? null) : null,
      error: job.status === "FAILED" ? job.error : "",
    };
  }

  createBackgroundJob({ type, total = 1, run }) {
    this.pruneBackgroundJobs();
    if (this.backgroundJobs.size >= 100) {
      const completedJobs = Array.from(this.backgroundJobs.values())
        .filter((job) => job.finishedAt)
        .sort((a, b) => new Date(a.finishedAt).getTime() - new Date(b.finishedAt).getTime());
      for (const completedJob of completedJobs) {
        this.backgroundJobs.delete(completedJob.id);
        if (this.backgroundJobs.size < 100) break;
      }
    }
    if (this.backgroundJobs.size >= 100) {
      const error = new Error("Antrean pekerjaan sedang penuh. Coba lagi setelah pekerjaan sebelumnya selesai.");
      error.statusCode = 429;
      throw error;
    }
    if (typeof run !== "function") throw new Error("Pelaksana pekerjaan latar belakang tidak tersedia.");

    const now = new Date().toISOString();
    const job = {
      id: crypto.randomUUID(),
      type: String(type || "BACKGROUND_OPERATION"),
      status: "QUEUED",
      phase: "QUEUED",
      progress: 0,
      total: Math.max(1, Number(total) || 1),
      createdAt: now,
      updatedAt: now,
      finishedAt: null,
      result: null,
      error: "",
    };
    this.backgroundJobs.set(job.id, job);

    setImmediate(() => {
      void (async () => {
        job.status = "PROCESSING";
        job.phase = "STARTING";
        job.updatedAt = new Date().toISOString();
        try {
          job.result = await run(({ phase, completed, total: progressTotal }) => {
            if (phase) job.phase = phase;
            if (completed !== undefined) job.progress = Math.max(0, Number(completed) || 0);
            if (progressTotal !== undefined) job.total = Math.max(1, Number(progressTotal) || job.total);
            job.updatedAt = new Date().toISOString();
          });
          job.status = "COMPLETED";
          job.phase = "COMPLETED";
          job.progress = job.total;
        } catch (error) {
          job.status = "FAILED";
          job.phase = "FAILED";
          job.error = error.message || "Pekerjaan gagal diselesaikan.";
          this.activityLog.push("error", "background-job", `Pekerjaan ${job.type} gagal: ${job.error}`, {
            jobId: job.id,
            progress: job.progress,
            total: job.total,
          });
        } finally {
          job.updatedAt = new Date().toISOString();
          job.finishedAt = job.updatedAt;
        }
      })();
    });

    return this.toPublicBackgroundJob(job);
  }

  getBackgroundJob(jobId, expectedType = "") {
    this.pruneBackgroundJobs();
    const job = this.backgroundJobs.get(String(jobId || ""));
    if (!job || (expectedType && job.type !== expectedType)) {
      const error = new Error("Pekerjaan tidak ditemukan atau sudah kedaluwarsa.");
      error.statusCode = 404;
      throw error;
    }
    return this.toPublicBackgroundJob(job);
  }

  createVoucherGenerationJob(payload) {
    const request = normalizeVoucherGenerationPayload(payload);
    return this.createBackgroundJob({
      type: "VOUCHER_GENERATION",
      total: request.quantity,
      run: (update) => this.voucherGenerationLock.runExclusive("mikrotik-vouchers", async () => {
        update({ phase: "CONNECTING", completed: 0, total: request.quantity });
        const batch = await this.mikrotikService.createHotspotVouchers(request, { onProgress: update });
        if (typeof this.dataManager.storeVoucherBatches === "function") {
          await this.dataManager.storeVoucherBatches([batch]);
        }
        return batch;
      }),
    });
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

  async syncContactIpBindings(contact, requestedMacAddresses) {
    const desired = normalizeMacAddresses(requestedMacAddresses);
    const current = normalizeMacAddresses(contact.mikrotikMacAddresses);
    const duplicate = desired.find((macAddress) => this.dataManager.hasContactMikrotikMac(macAddress, contact.id));
    if (duplicate) throw new Error(`MAC ${duplicate} sudah terhubung ke pelanggan lain.`);

    const added = desired.filter((macAddress) => !current.includes(macAddress));
    const removed = current.filter((macAddress) => !desired.includes(macAddress));
    if (added.length === 0 && removed.length === 0) {
      return this.syncContactIpBindingBandwidth(contact);
    }

    const serviceDisabled = normalizeHotspotProvisioningStatus(contact.hotspotProvisioningStatus) === HOTSPOT_PROVISIONING_STATUS.DISABLED;
    const accessMode = getContactHotspotAccessMode(contact);
    const accessState = getHotspotAccessRouterState(accessMode, serviceDisabled);
    const completedAdds = [];
    const completedRemovals = [];
    try {
      for (const macAddress of added) {
        await this.mikrotikService.upsertIpBinding({
          macAddress,
          contactId: contact.id,
          type: accessState.bindingType,
        });
        completedAdds.push(macAddress);
      }
      for (const macAddress of removed) {
        await this.mikrotikService.deleteIpBinding({ macAddress, contactId: contact.id });
        completedRemovals.push(macAddress);
      }
      const updated = await this.dataManager.setContactMikrotikMacAddresses(contact.id, desired);
      return this.syncContactIpBindingBandwidth(updated);
    } catch (error) {
      for (const macAddress of completedAdds.reverse()) {
        await this.mikrotikService.deleteIpBinding({ macAddress, contactId: contact.id }).catch(() => {});
      }
      for (const macAddress of completedRemovals.reverse()) {
        await this.mikrotikService.upsertIpBinding({
          macAddress,
          contactId: contact.id,
          type: accessState.bindingType,
        }).catch(() => {});
      }
      throw error;
    }
  }

  async syncContactIpBindingBandwidth(contact) {
    const current = this.dataManager.getContact(contact?.id) || contact;
    if (!current) throw new Error("Kontak tidak ditemukan.");
    if (typeof this.mikrotikService.syncIpBindingBandwidthForCustomer !== "function"
      || typeof this.dataManager.updateContactIpBindingBandwidthStatus !== "function") {
      return this.dataManager.toPublicContact(current);
    }

    let result;
    try {
      result = await this.mikrotikService.syncIpBindingBandwidthForCustomer({
        contactId: current.id,
        profile: current.mikrotikProfile,
        macAddresses: current.mikrotikMacAddresses,
        disabled: normalizeHotspotProvisioningStatus(current.hotspotProvisioningStatus)
          === HOTSPOT_PROVISIONING_STATUS.DISABLED
          || getContactHotspotAccessMode(current) === HOTSPOT_ACCESS_MODES.HOTSPOT_ONLY,
      });
    } catch (error) {
      result = {
        contactId: String(current.id),
        status: IP_BINDING_BANDWIDTH_STATUS.FAILED,
        rateLimit: "",
        targetAddresses: [],
        pendingMacAddresses: normalizeMacAddresses(current.mikrotikMacAddresses),
        devices: [],
        error: error.message,
        syncedAt: new Date().toISOString(),
      };
      this.activityLog.push("warn", "mikrotik", `Bandwidth IP Binding ${current.name || current.id} belum tersinkron: ${error.message}`, {
        contactId: current.id,
      });
    }

    const persisted = await this.dataManager.updateContactIpBindingBandwidthStatus(current.id, result);
    if ([IP_BINDING_BANDWIDTH_STATUS.ACTIVE, IP_BINDING_BANDWIDTH_STATUS.PARTIAL].includes(result.status)
      && result.changed) {
      this.activityLog.push("info", "mikrotik", `Simple Queue per IP Binding ${current.name || current.id} disinkronkan`, {
        contactId: current.id,
        rateLimit: result.rateLimit,
        targets: result.targetAddresses,
        queueNames: result.queueNames,
        pendingMacAddresses: result.pendingMacAddresses,
      });
    }
    return this.dataManager.toPublicContact(persisted);
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
      const accessMode = getContactHotspotAccessMode(current);
      const previousServiceDisabled = normalizeHotspotProvisioningStatus(current.hotspotProvisioningStatus)
        === HOTSPOT_PROVISIONING_STATUS.DISABLED;
      const previousAccessState = getHotspotAccessRouterState(accessMode, previousServiceDisabled);
      const targetAccessState = getHotspotAccessRouterState(accessMode, disabled);
      if (!disabled && !options.activePeriodPurchase) {
        const currentState = typeof this.dataManager.hydrateContact === "function"
          ? this.dataManager.hydrateContact(current)
          : current;
        if (isPrepaidPackage(current) && !currentState.packageActive) {
          const error = new Error("Beli paket satu bulan sebelum mengaktifkan akun prabayar.");
          error.statusCode = 409;
          throw error;
        }
        if (currentState.hasDebt) {
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
      let bindingsUpdated = 0;
      try {
        result = await this.mikrotikService.setHotspotUserDisabled(
          current.mikrotikUsername,
          current.phoneNumber,
          targetAccessState.userDisabled
        );
        const updatedBindings = [];
        try {
          for (const macAddress of normalizeMacAddresses(current.mikrotikMacAddresses)) {
            await this.mikrotikService.upsertIpBinding({
              macAddress,
              contactId: current.id,
              type: targetAccessState.bindingType,
            });
            updatedBindings.push(macAddress);
          }
          bindingsUpdated = updatedBindings.length;
        } catch (bindingError) {
          for (const macAddress of updatedBindings.reverse()) {
            await this.mikrotikService.upsertIpBinding({
              macAddress,
              contactId: current.id,
              type: previousAccessState.bindingType,
            }).catch(() => {});
          }
          await this.mikrotikService.setHotspotUserDisabled(
            current.mikrotikUsername,
            current.phoneNumber,
            previousAccessState.userDisabled
          ).catch(() => {});
          throw bindingError;
        }
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
            previousAccessState.userDisabled
          );
          for (const macAddress of normalizeMacAddresses(current.mikrotikMacAddresses)) {
            await this.mikrotikService.upsertIpBinding({
              macAddress,
              contactId: current.id,
              type: previousAccessState.bindingType,
            });
          }
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

      if (typeof this.mikrotikService.syncIpBindingBandwidthForCustomer === "function"
        && typeof this.dataManager.updateContactIpBindingBandwidthStatus === "function") {
        await this.syncContactIpBindingBandwidth(this.dataManager.getContact(current.id));
        persisted = this.dataManager.getContact(current.id) || persisted;
      }

      this.activityLog.push("info", "mikrotik", `Akses ${current.mikrotikUsername} ${disabled ? "dinonaktifkan" : `dipulihkan ke mode ${accessMode}`}`, {
        contactId: current.id,
        username: current.mikrotikUsername,
        activeSessionsKilled: result.activeSessionsKilled || 0,
      });
      return {
        operation: disabled ? "DISABLE" : "ENABLE",
        contact: persisted,
        username: result.username,
        bindingsUpdated,
        disabled: Boolean(disabled),
        accessMode,
        activeSessionsKilled: result.activeSessionsKilled || 0,
      };
    });
  }

  async setHotspotContactAccessMode(contact, requestedMode) {
    return this.hotspotProvisioningLock.runExclusive(String(contact.id), async () => {
      const current = this.dataManager.getContact(contact.id);
      if (!current) throw new Error("Kontak tidak ditemukan.");
      if (!current.mikrotikUsername || !current.mikrotikProfile) {
        throw new Error("Data akun hotspot pelanggan belum lengkap.");
      }
      const accessMode = normalizeHotspotAccessMode(requestedMode, "");
      if (!accessMode) throw new Error("Mode akses hotspot tidak valid.");
      const macAddresses = normalizeMacAddresses(current.mikrotikMacAddresses);
      if (accessMode !== HOTSPOT_ACCESS_MODES.HOTSPOT_ONLY && macAddresses.length === 0) {
        const error = new Error("Tambahkan minimal satu MAC IP Binding sebelum memilih mode ini.");
        error.statusCode = 409;
        throw error;
      }

      const serviceDisabled = normalizeHotspotProvisioningStatus(current.hotspotProvisioningStatus)
        === HOTSPOT_PROVISIONING_STATUS.DISABLED;
      if (serviceDisabled) {
        const currentState = typeof this.dataManager.hydrateContact === "function"
          ? this.dataManager.hydrateContact(current)
          : current;
        if (isPrepaidPackage(current) && !currentState.packageActive) {
          const error = new Error("Beli paket satu bulan sebelum mengaktifkan akses prabayar.");
          error.statusCode = 409;
          throw error;
        }
        if (currentState.hasDebt) {
          const error = new Error("Akses tidak dapat diaktifkan karena pelanggan masih memiliki tunggakan.");
          error.statusCode = 409;
          throw error;
        }
      }

      const previousMode = getContactHotspotAccessMode(current);
      const previousState = getHotspotAccessRouterState(previousMode, serviceDisabled);
      const targetState = getHotspotAccessRouterState(accessMode, false);
      let userUpdated = false;
      const bindingsUpdated = [];
      let result;
      try {
        result = await this.mikrotikService.setHotspotUserDisabled(
          current.mikrotikUsername,
          current.phoneNumber,
          targetState.userDisabled
        );
        userUpdated = true;
        for (const macAddress of macAddresses) {
          await this.mikrotikService.upsertIpBinding({
            macAddress,
            contactId: current.id,
            type: targetState.bindingType,
          });
          bindingsUpdated.push(macAddress);
        }
      } catch (error) {
        for (const macAddress of bindingsUpdated.reverse()) {
          await this.mikrotikService.upsertIpBinding({
            macAddress,
            contactId: current.id,
            type: previousState.bindingType,
          }).catch(() => {});
        }
        if (userUpdated) {
          await this.mikrotikService.setHotspotUserDisabled(
            current.mikrotikUsername,
            current.phoneNumber,
            previousState.userDisabled
          ).catch(() => {});
        }
        const wrapped = new Error(`Mode akses gagal diterapkan di MikroTik: ${error.message}`);
        wrapped.statusCode = 502;
        wrapped.cause = error;
        throw wrapped;
      }

      let persisted;
      try {
        persisted = await this.dataManager.setContactHotspotAccessMode(current.id, accessMode);
      } catch (error) {
        try {
          await this.mikrotikService.setHotspotUserDisabled(
            current.mikrotikUsername,
            current.phoneNumber,
            previousState.userDisabled
          );
          for (const macAddress of macAddresses) {
            await this.mikrotikService.upsertIpBinding({
              macAddress,
              contactId: current.id,
              type: previousState.bindingType,
            });
          }
        } catch (rollbackError) {
          const wrapped = new Error(`Mode akses berubah di MikroTik tetapi gagal disimpan dan rollback tidak lengkap: ${rollbackError.message}`);
          wrapped.statusCode = 502;
          wrapped.cause = error;
          throw wrapped;
        }
        throw error;
      }

      if (typeof this.mikrotikService.syncIpBindingBandwidthForCustomer === "function"
        && typeof this.dataManager.updateContactIpBindingBandwidthStatus === "function") {
        await this.syncContactIpBindingBandwidth(this.dataManager.getContact(current.id));
        persisted = this.dataManager.getContact(current.id) || persisted;
      }

      this.activityLog.push("info", "mikrotik", `Mode akses ${current.mikrotikUsername} diubah menjadi ${accessMode}`, {
        contactId: current.id,
        previousMode,
        accessMode,
        userDisabled: targetState.userDisabled,
        bindingType: targetState.bindingType,
        bindingsUpdated: bindingsUpdated.length,
      });
      return {
        operation: "ACCESS_MODE",
        contact: persisted,
        username: result?.username || current.mikrotikUsername,
        accessMode,
        userDisabled: targetState.userDisabled,
        bindingType: targetState.bindingType,
        bindingsUpdated: bindingsUpdated.length,
        activeSessionsKilled: result?.activeSessionsKilled || 0,
      };
    });
  }

  async getActivePeriodPurchaseStatus(contactId, requestId) {
    if (typeof this.dataManager.getActivePeriodPurchaseRequest !== "function") {
      return { status: "NOT_FOUND", requestId };
    }
    const request = await this.dataManager.getActivePeriodPurchaseRequest(contactId, requestId);
    if (!request) return { status: "NOT_FOUND", requestId };
    const contact = this.dataManager.getContact(contactId);
    const purchase = (contact?.activePeriodPurchases || [])
      .find((item) => String(item.id) === requestId);
    if (purchase && request.status !== "COMPLETED") {
      await this.dataManager.completeActivePeriodPurchaseRequest(contactId, requestId);
      return { status: "COMPLETED", requestId, purchase, reused: true, notificationStatus: "PENDING" };
    }
    if (request.status === "COMPLETED" && !purchase) {
      const error = new Error("Data pembelian berhasil tidak ditemukan. Periksa riwayat transaksi sebelum melanjutkan.");
      error.statusCode = 409;
      throw error;
    }
    return {
      status: request.status,
      requestId,
      purchase: purchase || null,
      reused: true,
      notificationStatus: request.notificationStatus,
    };
  }

  async dispatchActivePeriodNotifications() {
    if (this.purchaseNotificationRunning
      || typeof this.dataManager.getPendingActivePeriodNotifications !== "function") return;
    this.purchaseNotificationRunning = true;
    try {
      const pending = await this.dataManager.getPendingActivePeriodNotifications();
      for (const task of pending) {
        if (!await this.dataManager.claimActivePeriodNotification(task.requestId)) continue;
        const contact = this.dataManager.getContact(task.contactId);
        const purchase = (contact?.activePeriodPurchases || [])
          .find((item) => String(item.id) === task.requestId);
        try {
          if (!contact || !purchase) throw new Error("Data pembelian tidak ditemukan.");
          const hydrated = this.dataManager.hydrateContact(contact);
          await this.notificationBot.sendPaymentNotification(
            hydrated,
            purchase.id,
            PAYMENT_TYPES.ACTIVE_PERIOD,
            {
              paymentAmount: purchase.amount,
              paymentDate: purchase.purchasedAt,
              activeUntil: purchase.activeUntil,
              remainingDebtAmount: Math.max(0, Number(hydrated.debtAmount) || 0),
            }
          );
          await this.dataManager.setActivePeriodNotificationStatus(task.requestId, "SENT");
        } catch (error) {
          this.activityLog.push("error", "payment", "Notifikasi pembelian paket gagal dikirim", {
            contactId: task.contactId,
            transactionId: task.requestId,
            error: error.message,
          });
          await this.dataManager.setActivePeriodNotificationStatus(task.requestId, "FAILED");
        }
      }
    } finally {
      this.purchaseNotificationRunning = false;
    }
  }

  async purchaseActivePeriod(contactId, requestId = `ACT-${crypto.randomUUID()}`) {
    return this.activePeriodPurchaseLock.runExclusive(String(contactId), async () => {
      if (!/^ACT-[0-9a-f-]{36}$/i.test(requestId)) {
        const error = new Error("ID permintaan pembelian tidak valid.");
        error.statusCode = 400;
        throw error;
      }
      const previous = await this.getActivePeriodPurchaseStatus(contactId, requestId);
      if (previous.status === "COMPLETED") {
        return {
          operation: "REUSED",
          purchase: previous.purchase,
          contact: this.dataManager.hydrateContact(this.dataManager.getContact(contactId)),
          reused: true,
        };
      }
      if (previous.status === "PROCESSING" || previous.status === "REVIEW_REQUIRED") {
        const error = new Error("Status pembelian sebelumnya belum pasti. Periksa riwayat sebelum membuat pembelian baru.");
        error.statusCode = 409;
        throw error;
      }
      const contact = this.dataManager.getContact(contactId);
      if (!contact) throw new Error("Kontak tidak ditemukan.");
      const hydrated = this.dataManager.hydrateContact(contact);
      if (!isRecurringSubscription(contact)) {
        throw new Error("Pembelian masa aktif hanya tersedia untuk pelanggan bulanan.");
      }
      const prepaidPackage = isPrepaidPackage(contact);
      if (!prepaidPackage && !hydrated.hasDebt) {
        throw new Error("Pembelian masa aktif hanya tersedia untuk pelanggan yang memiliki tunggakan.");
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
        && (prepaidPackage || parseBoolean(contact.hotspotManualActivationWithArrears, false));
      const canActivate = currentStatus === HOTSPOT_PROVISIONING_STATUS.DISABLED;
      if (!canExtend && !canActivate) {
        const error = new Error(prepaidPackage
          ? "Akun hotspot harus sudah tersedia atau dalam keadaan nonaktif."
          : "Akun hotspot harus nonaktif karena tunggakan atau sedang memakai masa aktif sementara.");
        error.statusCode = 409;
        throw error;
      }

      if (typeof this.dataManager.beginActivePeriodPurchaseRequest === "function") {
        const reserved = await this.dataManager.beginActivePeriodPurchaseRequest(contactId, requestId);
        if (!reserved) {
          const existing = await this.getActivePeriodPurchaseStatus(contactId, requestId);
          if (existing.status === "COMPLETED") {
            return {
              operation: "REUSED",
              purchase: existing.purchase,
              contact: this.dataManager.hydrateContact(this.dataManager.getContact(contactId)),
              reused: true,
            };
          }
          const error = new Error("Pembelian sebelumnya masih diproses atau perlu diperiksa.");
          error.statusCode = 409;
          throw error;
        }
      }

      const activeFrom = canExtend && Number.isFinite(currentEnd.getTime()) && currentEnd.getTime() > now.getTime()
        ? currentEnd
        : now;
      const activeUntil = addMonthsSafely(activeFrom, 1, this.dataManager.getTimezone());
      const purchase = {
        id: requestId,
        purchasedAt: now.toISOString(),
        activeFrom: activeFrom.toISOString(),
        activeUntil: activeUntil.toISOString(),
        paymentProvider: "manual",
      };

      let persisted;
      let operation;
      try {
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

      if (typeof this.dataManager.completeActivePeriodPurchaseRequest === "function") {
        await this.dataManager.completeActivePeriodPurchaseRequest(contactId, requestId);
      }
      } catch (error) {
        if (typeof this.dataManager.markActivePeriodPurchaseForReview === "function") {
          await this.dataManager.markActivePeriodPurchaseForReview(contactId, requestId)
            .catch((statusError) => this.activityLog.push("error", "payment", statusError.message));
        }
        throw error;
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
    return this.paymentGatewayLock.runExclusive(`create:${contactId}`, () => (
      this.hotspotProvisioningLock.runExclusive(String(contactId), async () => {
      const contact = this.dataManager.getContact(contactId);
      if (!contact) throw new Error("Kontak tidak ditemukan.");
      this.dataManager.assertContactDeletionAllowed?.(contact.id);

      const username = sanitizeInput(contact.mikrotikUsername || "");
      const macAddresses = normalizeMacAddresses(contact.mikrotikMacAddresses);
      const password = sanitizeInput(contact.mikrotikPassword || "")
        || String(contact.phoneNumber || "").slice(-5);
      const accessMode = getContactHotspotAccessMode(contact);
      const serviceDisabled = normalizeHotspotProvisioningStatus(contact.hotspotProvisioningStatus)
        === HOTSPOT_PROVISIONING_STATUS.DISABLED;
      const restoreState = getHotspotAccessRouterState(accessMode, serviceDisabled);
      const bindingType = restoreState.bindingType;
      const removedMacAddresses = [];
      let bandwidthQueueRemoved = false;
      let hotspotDeletion = {
        username: username || null,
        macAddresses,
        removedUsers: 0,
        removedBindings: 0,
        removedQueues: 0,
        activeSessionsKilled: 0,
        skipped: !username && macAddresses.length === 0,
      };
      const restoreMikrotikAccess = async ({
        restoreUser = false,
        restoreBindings = [],
        restoreBandwidth = false,
      } = {}) => {
        if (restoreUser) {
          if (!password || !contact.mikrotikProfile) throw new Error("Data profile atau password hotspot tidak lengkap.");
          await this.mikrotikService.reactivateHotspotUser({
            username,
            password,
            profile: contact.mikrotikProfile,
            phoneNumber: contact.phoneNumber,
          });
          if (restoreState.userDisabled) {
            await this.mikrotikService.setHotspotUserDisabled(username, contact.phoneNumber, true);
          }
        }
        for (const macAddress of restoreBindings) {
          await this.mikrotikService.upsertIpBinding({
            macAddress,
            contactId: contact.id,
            type: bindingType,
          });
        }
        if (restoreBandwidth && typeof this.mikrotikService.syncIpBindingBandwidthForCustomer === "function") {
          await this.mikrotikService.syncIpBindingBandwidthForCustomer({
            contactId: contact.id,
            profile: contact.mikrotikProfile,
            macAddresses,
            disabled: serviceDisabled || accessMode === HOTSPOT_ACCESS_MODES.HOTSPOT_ONLY,
          });
        }
      };

      if (username || macAddresses.length > 0) {
        try {
          if (username) {
            Object.assign(hotspotDeletion, await this.mikrotikService.deleteHotspotUser(username, contact.phoneNumber));
          }
          for (const macAddress of macAddresses) {
            const bindingResult = await this.mikrotikService.deleteIpBinding({ macAddress, contactId: contact.id });
            hotspotDeletion.removedBindings += bindingResult.removedBindings || 0;
            if (bindingResult.removedBindings > 0) removedMacAddresses.push(macAddress);
          }
          if (typeof this.mikrotikService.deleteIpBindingBandwidthQueue === "function") {
            const queueResult = await this.mikrotikService.deleteIpBindingBandwidthQueue(contact.id);
            hotspotDeletion.removedQueues = queueResult.removedQueues || 0;
            bandwidthQueueRemoved = hotspotDeletion.removedQueues > 0;
          }
          hotspotDeletion.skipped = false;
        } catch (error) {
          try {
            await restoreMikrotikAccess({
              restoreUser: hotspotDeletion.removedUsers > 0,
              restoreBindings: removedMacAddresses,
              restoreBandwidth: bandwidthQueueRemoved,
            });
          } catch (rollbackError) {
            const wrapped = new Error(`Penghapusan akses MikroTik gagal dan rollback tidak lengkap: ${rollbackError.message}`);
            wrapped.statusCode = 502;
            wrapped.cause = error;
            throw wrapped;
          }
          const wrapped = new Error(`Data pelanggan belum dihapus karena akses MikroTik gagal dihapus: ${error.message}`);
          wrapped.statusCode = 502;
          wrapped.cause = error;
          throw wrapped;
        }
      }

      let deleted;
      try {
        deleted = await this.dataManager.deleteContact(contact.id);
      } catch (error) {
        if ((!username || hotspotDeletion.removedUsers < 1) && hotspotDeletion.removedBindings < 1) throw error;

        try {
          await restoreMikrotikAccess({
            restoreUser: username && hotspotDeletion.removedUsers > 0,
            restoreBindings: removedMacAddresses,
            restoreBandwidth: bandwidthQueueRemoved,
          });
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

      this.activityLog.push("info", "mikrotik", username || macAddresses.length > 0
        ? `Pelanggan, akun hotspot, dan ${macAddresses.length} IP Binding dihapus`
        : `Pelanggan ${contact.name || contact.id} dihapus tanpa akun hotspot`, {
        contactId: contact.id,
        username: username || null,
        macAddresses,
        removedUsers: hotspotDeletion.removedUsers,
        removedBindings: hotspotDeletion.removedBindings,
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
      })
    ));
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
    const prepaidPackage = isPrepaidPackage(currentState);
    if (!prepaidPackage && !parseBoolean(currentState?.hotspotSuspendedForArrears, false)) {
      return { attempted: false, reason: "not_arrears_suspension" };
    }
    if (prepaidPackage
      && normalizeHotspotProvisioningStatus(currentState?.hotspotProvisioningStatus) === HOTSPOT_PROVISIONING_STATUS.DISABLED
      && /oleh administrator/i.test(String(currentState?.hotspotProvisioningError || ""))) {
      return { attempted: false, reason: "manual_suspension" };
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
      const currentHotspot = this.dataManager.getContact?.(result.contact.id) || result.contact;
      const alreadyRecovered = result.alreadyProcessed
        && normalizeHotspotProvisioningStatus(currentHotspot?.hotspotProvisioningStatus)
          === HOTSPOT_PROVISIONING_STATUS.ACTIVE;
      if (alreadyRecovered) {
        hotspotRecovery = { attempted: false, reason: "already_processed_active" };
      } else {
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
      }
      const notificationContact = hotspotRecovery.contact
        || (typeof this.dataManager.getContact === "function" ? this.dataManager.getContact(result.contact.id) : null)
        || result.contact;
      if (!result.alreadyProcessed && typeof this.notificationBot.sendPaymentNotification === "function") {
        await this.notificationBot.sendPaymentNotification(
          notificationContact,
          orderId,
          result.transaction?.paymentType || localTransaction.paymentType || PAYMENT_TYPES.FULL_PAID,
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
        "default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
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

    const serveAppIcon = (_req, res) => {
      res.setHeader("Cache-Control", "no-store");
      const icon = this.dataManager.getAppBrandIcon?.();
      if (!icon) return res.status(204).end();
      res.type("png").send(Buffer.from(icon.base64, "base64"));
    };
    this.app.get("/favicon.ico", serveAppIcon);
    this.app.get("/branding/icon", serveAppIcon);

    this.app.use("/public", (req, res, next) => {
      const isDashboardModule = req.path.startsWith("/dashboard/") && req.path.endsWith(".js");
      if (isDashboardModule
        || ["/app.js", "/styles.css", "/interface.css", "/customer.js", "/customer.css", "/customer-login.js"].includes(req.path)) {
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
      const passwordMatches = await verifyPortalPassword(password, account?.account?.password || "");
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

      const prepaidPackage = req.customerPortalData.billing?.subscriptionType === SUBSCRIPTION_TYPES.RECURRING;
      const amount = Math.floor(Number(prepaidPackage
        ? req.customerPortalData.billing?.monthlyAmount
        : req.customerPortalData.billing?.totalAmount) || 0);
      const periods = prepaidPackage
        ? []
        : (req.customerPortalData.billing?.history || [])
          .filter((payment) => payment.status !== PAYMENT_STATUS.PAID)
          .map((payment) => payment.period);
      const paymentType = prepaidPackage ? PAYMENT_TYPES.ACTIVE_PERIOD : PAYMENT_TYPES.FULL_PAID;
      if (amount <= 0 || (!prepaidPackage && periods.length === 0)) {
        throw new Error(prepaidPackage
          ? "Harga paket prabayar belum diatur."
          : "Tidak ada tagihan yang perlu dibayar.");
      }

      return this.paymentGatewayLock.runExclusive(
        `create:${req.customerSession.contactId}`,
        async () => {
          const reusable = await this.dataManager.findReusablePaymentGatewayTransaction?.({
            contactId: req.customerSession.contactId,
            amount,
            periods,
            paymentType,
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
            paymentType,
          });
          const fallbackFinishUrl = `${req.protocol}://${req.get("host")}/pelanggan?payment=finish`;
          const finishUrl = CONFIG.MIDTRANS_FINISH_URL || fallbackFinishUrl;

          try {
            const snap = await this.midtransService.createSnapTransaction({
              orderId,
              amount,
              customer: req.customerPortalData.customer,
              itemName: prepaidPackage
                ? "Paket internet prabayar 1 bulan"
                : `Tagihan internet ${req.customerPortalData.billing.periodLabel}`,
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
            <style>
              :root{--primary:#0f6b57;--primary-dark:#0a5142;--ink:#17251f;--muted:#5f6f67;--border:#d8ddd8;--canvas:#f4f2ec;--success:#176b45;--warning:#9a5d00;--danger:#a5312b}
              .skip-link{position:fixed;top:10px;left:10px;z-index:20;padding:10px 14px;color:#fff;border-radius:7px;background:var(--ink);font-weight:700;text-decoration:none;transform:translateY(-160%)}
              .skip-link:focus{transform:translateY(0)}
              .button{border-color:#77877f}.button:hover{border-color:#0f6b57;background:#e6f2ee}
              .button.danger-secondary{border-color:#d9aaa5}
              .page-heading .eyebrow,.connection-heading small{text-transform:none}
              .summary-bar,.connection-card,.sending-panel,.disabled-card{box-shadow:none}
              .helper{border:1px solid #c9ddd6;border-radius:8px;background:#f9fbfa}
              .brand-mark.has-custom-icon{border:0;border-radius:0;background:transparent}
              .brand-mark.has-custom-icon img{display:block;width:100%;height:100%;object-fit:contain}
              :focus-visible{outline-color:#c9572a}
            </style>
          </head>
          <body>
            <a class="skip-link" href="#transport-content">Langsung ke konten</a>
            <main id="transport-content" class="transport-page" tabindex="-1">
              <header class="topbar">
                <a class="brand" href="/dashboard"><span class="brand-mark${this.dataManager.getAppBrandIconMeta?.()?.hasIcon ? " has-custom-icon" : ""}">${this.dataManager.getAppBrandIconMeta?.()?.hasIcon ? '<img src="/branding/icon" alt="" width="25" height="25">' : "R"}</span><span class="brand-copy"><strong>${escapeHtml(this.dataManager.getSettings().appBrandName || "Reminder Bot")}</strong><small>Pengaturan koneksi</small></span></a>
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

      return res.send(`<!doctype html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Status WhatsApp</title><style>*{box-sizing:border-box}body{margin:0;padding:20px;color:#17251f;background:#f4f2ec;font:14px/1.5 "Segoe UI",Roboto,Arial,sans-serif}.disabled-card{max-width:560px;margin:15vh auto 0;padding:24px;border:1px solid #d8ddd8;border-radius:10px;background:#fff}.disabled-card h1{margin:0 0 8px;font-size:22px}.disabled-card p{margin:0 0 18px;color:#5f6f67}.disabled-card a{display:inline-flex;min-height:44px;align-items:center;padding:9px 13px;color:#fff;border-radius:8px;background:#0f6b57;font-weight:700;text-decoration:none}.disabled-card a:hover{background:#0a5142}.disabled-card a:focus-visible{outline:3px solid #c9572a;outline-offset:2px}</style></head><body><main class="disabled-card"><h1>WhatsApp belum aktif</h1><p>Aktifkan BAILEYS_ENABLED pada environment untuk menggunakan kanal WhatsApp.</p><a href="/dashboard">Kembali ke dashboard</a></main></body></html>`);
    });

    this.app.get("/api/status", requireApiAuth, handleApi(async () => {
      const bot = await this.notificationBot.getTransportStatus();
      return {
        bot,
        summary: this.dataManager.getDashboardSummary(),
        settings: this.dataManager.getSettings(),
        branding: this.dataManager.getAppBrandIconMeta?.() || { hasIcon: false, version: "" },
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

    registerCustomerRoutes({
      app: this.app,
      requireApiAuth,
      handleApi,
      dataManager: this.dataManager,
      notificationBot: this.notificationBot,
      activityLog: this.activityLog,
      hotspotReactivationScheduler: this.hotspotReactivationScheduler,
      backgroundOperationLock: this.backgroundOperationLock,
      accountCredentialsLock: this.accountCredentialsLock,
      invalidateCustomerSessions: (contactId) => this.authManager.destroyCustomerSessionsForContact(contactId),
      hotspotProvisioningStatus: HOTSPOT_PROVISIONING_STATUS,
      hotspotProvisioningOperation: HOTSPOT_PROVISIONING_OPERATION,
      hotspotAccessModes: HOTSPOT_ACCESS_MODES,
      normalizeMacAddresses,
      normalizeHotspotProvisioningStatus,
      getContactHotspotAccessMode,
      isPrepaidPackage,
      requireRegisteredWhatsAppNumber,
      resolveContactNetworkLink: (payload, current) => this.resolveContactNetworkLink(payload, current),
      provisionHotspotContact: (contact, options) => this.provisionHotspotContact(contact, options),
      setHotspotContactAccessMode: (contact, mode) => this.setHotspotContactAccessMode(contact, mode),
      syncContactIpBindings: (contact, macAddresses) => this.syncContactIpBindings(contact, macAddresses),
      deleteContactWithHotspot: (contactId) => this.deleteContactWithHotspot(contactId),
      setHotspotContactDisabled: (contact, disabled) => this.setHotspotContactDisabled(contact, disabled),
      purchaseActivePeriod: (contactId, requestId) => this.purchaseActivePeriod(contactId, requestId),
      getActivePeriodPurchaseStatus: (contactId, requestId) => this.getActivePeriodPurchaseStatus(contactId, requestId),
      dispatchActivePeriodNotifications: () => this.dispatchActivePeriodNotifications(),
      createBackgroundJob: (options) => this.createBackgroundJob(options),
      recoverHotspotAfterPayment: (contact) => this.recoverHotspotAfterPayment(contact),
    });

    this.app.get("/api/mikrotik/profiles", requireApiAuth, handleApi(async () => this.mikrotikService.getHotspotProfiles()));
    this.app.get("/api/mikrotik/hotspot-servers", requireApiAuth, handleApi(async () => this.mikrotikService.getHotspotServers()));
    this.app.get("/api/mikrotik/hotspot-users", requireApiAuth, handleApi(async () => this.mikrotikService.getHotspotUsers()));
    registerVoucherRoutes({
      app: this.app,
      requireApiAuth,
      handleApi,
      dataManager: this.dataManager,
      mikrotikService: this.mikrotikService,
      voucherRevenueSyncScheduler: this.voucherRevenueSyncScheduler,
      voucherProfileLock: this.voucherProfileLock,
      voucherGenerationLock: this.voucherGenerationLock,
      createVoucherGenerationJob: (payload) => this.createVoucherGenerationJob(payload),
      getBackgroundJob: (jobId, expectedType) => this.getBackgroundJob(jobId, expectedType),
      activityLog: this.activityLog,
    });
    this.app.get("/api/jobs/:jobId", requireApiAuth, handleApi(async (req) => (
      this.getBackgroundJob(req.params.jobId)
    )));
    this.app.get("/api/mikrotik/netwatch", requireApiAuth, handleApi(async () => (
      this.buildNetworkMonitorView(await this.mikrotikService.getNetwatchStatus())
    )));
    this.app.post("/api/mikrotik/backup/send", requireApiAuth, handleApi(async (_req, res) => {
      if (!TelegramManager.isConfigured()) {
        throw new Error("Transport backup Telegram belum siap. Isi TELEGRAM_BOT_TOKEN dan TELEGRAM_CHAT_IDS.");
      }

      const recipients = TelegramManager.getChatIds();
      if (recipients.length === 0) {
        throw new Error("TELEGRAM_CHAT_IDS masih kosong.");
      }

      const job = this.createBackgroundJob({
        type: "MIKROTIK_BACKUP",
        total: recipients.length,
        run: (update) => this.backgroundOperationLock.runExclusive("mikrotik-backup", async () => {
          update({ phase: "CREATING_BACKUP", completed: 0, total: recipients.length });
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
              update({ phase: "SENDING", completed: results.length, total: recipients.length });
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
        }),
      });
      res.status(202);
      return job;
    }));

    this.app.post("/api/backups/send", requireApiAuth, handleApi(async (_req, res) => {
      if (!TelegramManager.isConfigured()) {
        throw new Error("Transport backup Telegram belum siap. Isi TELEGRAM_BOT_TOKEN dan TELEGRAM_CHAT_IDS.");
      }
      const recipients = TelegramManager.getChatIds();
      const job = this.createBackgroundJob({
        type: "MANUAL_BACKUPS",
        total: recipients.length * 2,
        run: (update) => this.backgroundOperationLock.runExclusive("mikrotik-backup", () => (
          sendManualBackups({
            mikrotikService: this.mikrotikService,
            dataManager: this.dataManager,
            notificationBot: this.notificationBot,
            activityLog: this.activityLog,
            recipients,
            update,
          })
        )),
      });
      res.status(202);
      return job;
    }));

    this.app.get("/api/reminders", requireApiAuth, handleApi(async () => {
      const now = new Date();
      return this.dataManager.getSortedReminders().map((reminder) => {
        if (reminder.processingAt || reminder.deliveryAttemptedAt
          || this.reminderScheduler.isPaidReminder(reminder)) return reminder;
        return { ...reminder, message: this.reminderScheduler.buildReminderMessage(reminder, now) };
      });
    }));
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
    this.app.put("/api/settings/icon", requireApiAuth, handleApi(async (req) => (
      this.dataManager.saveAppBrandIcon(req.body?.dataUrl)
    )));
    this.app.delete("/api/settings/icon", requireApiAuth, handleApi(async () => (
      this.dataManager.deleteAppBrandIcon()
    )));

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

    this.app.post("/api/notifications/admin-broadcast", requireApiAuth, handleApi(async (req, res) => {
      const title = sanitizeInput(req.body.title) || "Status Bot";
      const body = sanitizeMultilineText(req.body.message);
      if (!body) throw new Error("Pesan broadcast wajib diisi.");
      const total = Math.max(1, Number(this.dataManager.getAdminRecipients().length) || 0);
      const job = this.createBackgroundJob({
        type: "ADMIN_BROADCAST",
        total,
        run: (update) => this.backgroundOperationLock.runExclusive("admin-broadcast", () => (
          this.notificationBot.sendAdminBroadcast(title, body, { onProgress: update })
        )),
      });
      res.status(202);
      return job;
    }));

    this.app.post("/api/notifications/broadcast", requireApiAuth, handleApi(async (req, res) => {
      const title = sanitizeInput(req.body.title) || "Pengumuman";
      const templateName = sanitizeInput(req.body.templateName || "");
      let body = sanitizeMultilineText(req.body.message);
      if (templateName) {
        const templatePath = this.templateManager.getTemplatePath(templateName);
        body = sanitizeMultilineText(await fs.readFile(templatePath, "utf-8"));
      }
      if (!body) throw new Error("Pesan broadcast wajib diisi.");
      const settings = this.dataManager.getSettings();
      const companyName = sanitizeInput(settings.companyName) || DEFAULT_SETTINGS.companyName;
      const supportSignature = sanitizeInput(settings.supportSignature)
        || DEFAULT_SETTINGS.supportSignature;
      const total = Math.max(1, Number(this.dataManager.getContacts().length) || 0);
      const job = this.createBackgroundJob({
        type: "CONTACT_BROADCAST",
        total,
        run: (update) => this.backgroundOperationLock.runExclusive("contact-broadcast", async () => (
          this.notificationBot.sendContactBroadcast(title, body, {
            onProgress: update,
            renderMessage: (contact, content) =>
              this.templateManager.applyTemplate(content, {
                name: contact?.name || "",
                phoneNumber: contact?.phoneNumber || "",
                date: new Date().toLocaleDateString("id-ID", { timeZone: this.dataManager.getTimezone() }),
                companyName,
                companyNameUpper: companyName.toUpperCase(),
                supportSignature,
              }),
          })
        )),
      });
      res.status(202);
      return job;
    }));

    this.app.post("/api/scheduler/run", requireApiAuth, handleApi(async (_req, res) => {
      const job = this.createBackgroundJob({
        type: "REMINDER_SCHEDULER",
        total: 1,
        run: (update) => this.backgroundOperationLock.runExclusive("reminder-scheduler", async () => {
          update({ phase: "PROCESSING", completed: 0, total: 1 });
          await this.reminderScheduler.processDueReminders();
          update({ phase: "COMPLETED", completed: 1, total: 1 });
          return { completed: true };
        }),
      });
      res.status(202);
      return job;
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
    const settings = this.dataManager.getSettings();
    const title = escapeHtml(settings.dashboardTitle);
    const name = escapeHtml(settings.appBrandName || "Reminder Bot");
    const subtitle = escapeHtml(settings.appBrandSubtitle || "");
    const hasIcon = this.dataManager.getAppBrandIconMeta?.().hasIcon;
    const iconMarkup = hasIcon
      ? '<img src="/branding/icon" width="28" height="28" alt="" aria-hidden="true">'
      : '<i class="fa-solid fa-bell" aria-hidden="true"></i>';
    const templatePath = path.join(CONFIG.PUBLIC_PATH, "login.html");
    const html = await fs.readFile(templatePath, "utf-8");
    return html.replace(/__DASHBOARD_TITLE__/g, title)
      .replace(/__APP_BRAND_NAME__/g, name)
      .replace(/__APP_BRAND_SUBTITLE__/g, subtitle)
      .replace(/__APP_BRAND_ICON__/g, iconMarkup)
      .replace(/__APP_BRAND_ICON_CLASS__/g, hasIcon ? " has-custom-icon" : "");
  }

  renderCustomerBranding(html, settings) {
    const title = escapeHtml(settings.companyName || settings.dashboardTitle || "Hotspot");
    const name = escapeHtml(settings.appBrandName || settings.companyName || settings.dashboardTitle || "Hotspot");
    const hasIcon = Boolean(this.dataManager.getAppBrandIconMeta?.()?.hasIcon);
    const iconMarkup = hasIcon
      ? '<img src="/branding/icon" width="40" height="40" alt="" aria-hidden="true">'
      : '<i class="fa-solid fa-wifi" aria-hidden="true"></i>';
    return html.replace(/__CUSTOMER_PORTAL_TITLE__/g, title)
      .replace(/__CUSTOMER_APP_NAME__/g, name)
      .replace(/__CUSTOMER_APP_ICON__/g, iconMarkup)
      .replace(/__CUSTOMER_APP_ICON_CLASS__/g, hasIcon ? " has-custom-icon" : "");
  }

  async renderCustomerLoginPage() {
    const settings = this.dataManager.getSettings();
    const templatePath = path.join(CONFIG.PUBLIC_PATH, "customer-login.html");
    const html = await fs.readFile(templatePath, "utf-8");
    return this.renderCustomerBranding(html, settings);
  }

  async renderCustomerPortal() {
    const settings = this.dataManager.getSettings();
    const templatePath = path.join(CONFIG.PUBLIC_PATH, "customer.html");
    const html = await fs.readFile(templatePath, "utf-8");
    return this.renderCustomerBranding(html, settings);
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
        this.purchaseNotificationTimer = setInterval(() => {
          void this.dispatchActivePeriodNotifications().catch((error) => {
            this.activityLog.push("error", "payment", `Antrean notifikasi paket gagal: ${error.message}`);
          });
        }, 30_000);
        this.purchaseNotificationTimer.unref?.();
        void this.dispatchActivePeriodNotifications().catch((error) => {
          this.activityLog.push("error", "payment", `Antrean notifikasi paket gagal: ${error.message}`);
        });
        this.activityLog.push("info", "web", `Dashboard running at http://${CONFIG.HOST}:${CONFIG.PORT}/dashboard`);
        this.activityLog.push("info", "web", `WhatsApp provider status page running at http://${CONFIG.HOST}:${CONFIG.PORT}/transport`);
        resolve(server);
      });
    });
  }

  async stop(timeoutMs = Math.min(CONFIG.SHUTDOWN_TIMEOUT, 10_000)) {
    this.ready = false;
    clearInterval(this.purchaseNotificationTimer);
    this.purchaseNotificationTimer = null;
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


module.exports = WebServer;
