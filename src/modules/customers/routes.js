const crypto = require("crypto");
const { generatePortalPassword } = require("../../portal-password");
const {
  BILLING_REMINDER_STOP_DEBT_COUNT,
  DEFAULT_SETTINGS,
  PAYMENT_STATUS,
  PAYMENT_TYPES,
} = require("../../config");
const {
  normalizePhoneNumber,
  parseBoolean,
  sanitizeInput,
  sanitizeMultilineText,
} = require("../../utils");

function registerCustomerRoutes({
  app,
  requireApiAuth,
  handleApi,
  dataManager,
  notificationBot,
  activityLog,
  hotspotReactivationScheduler,
  backgroundOperationLock,
  accountCredentialsLock,
  invalidateCustomerSessions,
  hotspotProvisioningStatus,
  hotspotProvisioningOperation,
  hotspotAccessModes,
  normalizeMacAddresses,
  normalizeHotspotProvisioningStatus,
  getContactHotspotAccessMode,
  isPrepaidPackage,
  requireRegisteredWhatsAppNumber,
  resolveContactNetworkLink,
  provisionHotspotContact,
  setHotspotContactAccessMode,
  syncContactIpBindings,
  deleteContactWithHotspot,
  setHotspotContactDisabled,
  purchaseActivePeriod,
  createBackgroundJob,
  recoverHotspotAfterPayment,
}) {
  app.get("/api/contacts", requireApiAuth, handleApi(async () => (
    dataManager.getSortedContacts().map((contact) => dataManager.toPublicContact(contact, { alreadyHydrated: true }))
  )));

  app.post("/api/contacts", requireApiAuth, handleApi(async (req) => {
    await requireRegisteredWhatsAppNumber(req.body.phoneNumber);
    const payload = await resolveContactNetworkLink(req.body);
    return dataManager.toPublicContact(await dataManager.addContact(payload));
  }));

  app.put("/api/contacts/:id", requireApiAuth, handleApi(async (req) => {
    const current = dataManager.getContact(req.params.id);
    if (!current) throw new Error("Kontak tidak ditemukan.");
    if (req.body.phoneNumber !== undefined
      && normalizePhoneNumber(req.body.phoneNumber) !== current.phoneNumber) {
      await requireRegisteredWhatsAppNumber(req.body.phoneNumber);
    }
    const payload = await resolveContactNetworkLink(req.body, current);
    const prepared = await dataManager.prepareContactUpdate(req.params.id, payload);
    if (prepared.hotspotSyncRequired) {
      const result = await provisionHotspotContact(prepared.contact, { sendCredentials: false });
      const latestContact = dataManager.getContact(req.params.id);
      if (getContactHotspotAccessMode(latestContact) !== hotspotAccessModes.IP_BINDING_ONLY) {
        return { ...result.contact, hotspotSynced: true };
      }
      const accessResult = await setHotspotContactAccessMode(
        latestContact,
        getContactHotspotAccessMode(latestContact)
      );
      return { ...dataManager.toPublicContact(accessResult.contact), hotspotSynced: true };
    }
    return dataManager.toPublicContact(prepared.contact);
  }));

  app.post("/api/contacts/:id/hotspot", requireApiAuth, handleApi(async (req) => {
    const current = dataManager.getContact(req.params.id);
    if (!current) throw new Error("Pelanggan tidak ditemukan.");
    const keepServiceDisabled = normalizeHotspotProvisioningStatus(current.hotspotProvisioningStatus)
      === hotspotProvisioningStatus.DISABLED;

    const macAddresses = Object.hasOwn(req.body, "mikrotikMacAddresses")
      ? normalizeMacAddresses(req.body.mikrotikMacAddresses)
      : normalizeMacAddresses(current.mikrotikMacAddresses);
    const bindingsChanged = macAddresses.join(",") !== normalizeMacAddresses(current.mikrotikMacAddresses).join(",");
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
    if (password !== undefined && password) hotspotPayload.mikrotikPassword = password;

    const prepared = await dataManager.prepareContactUpdate(req.params.id, hotspotPayload);
    if (!prepared.hotspotSyncRequired) {
      await syncContactIpBindings(prepared.contact, macAddresses);
      const latestContact = dataManager.getContact(req.params.id);
      const latestMode = getContactHotspotAccessMode(latestContact);
      const previousMode = getContactHotspotAccessMode(current);
      let syncedContact = dataManager.toPublicContact(latestContact);
      if (keepServiceDisabled) {
        const accessResult = await setHotspotContactDisabled(latestContact, true);
        syncedContact = dataManager.toPublicContact(accessResult.contact);
      } else if (latestMode === hotspotAccessModes.IP_BINDING_ONLY
        || (previousMode === hotspotAccessModes.IP_BINDING_ONLY
          && latestMode === hotspotAccessModes.HOTSPOT_ONLY)) {
        const accessResult = await setHotspotContactAccessMode(latestContact, latestMode);
        syncedContact = dataManager.toPublicContact(accessResult.contact);
      }
      return bindingsChanged ? { ...syncedContact, hotspotSynced: true } : syncedContact;
    }

    const result = await provisionHotspotContact(prepared.contact, {
      sendCredentials: req.body.sendCredentials,
    });
    await syncContactIpBindings(dataManager.getContact(req.params.id), macAddresses);
    const latestContact = dataManager.getContact(req.params.id);
    if (keepServiceDisabled) {
      const accessResult = await setHotspotContactDisabled(latestContact, true);
      return { ...dataManager.toPublicContact(accessResult.contact), hotspotSynced: true };
    }
    if (getContactHotspotAccessMode(latestContact) === hotspotAccessModes.IP_BINDING_ONLY) {
      const accessResult = await setHotspotContactAccessMode(
        latestContact,
        hotspotAccessModes.IP_BINDING_ONLY
      );
      return { ...dataManager.toPublicContact(accessResult.contact), hotspotSynced: true };
    }
    return { ...result.contact, ...dataManager.toPublicContact(latestContact), hotspotSynced: true };
  }));

  app.delete("/api/contacts/:id", requireApiAuth, handleApi(async (req) => (
    deleteContactWithHotspot(req.params.id)
  )));

  app.post("/api/contacts/:id/account-credentials", requireApiAuth, handleApi(async (req) => accountCredentialsLock.runExclusive(
    String(req.params.id),
    async () => {
    const contact = dataManager.getContact(req.params.id);
    if (!contact) throw new Error("Kontak tidak ditemukan.");

    const includePortal = parseBoolean(req.body.includePortal, false);
    const includeHotspot = parseBoolean(req.body.includeHotspot, false);
    if (!includePortal && !includeHotspot) {
      throw new Error("Pilih minimal satu akun yang akan dikirim.");
    }

    const customerAccount = dataManager.getCustomerPortalAccountByContactId(contact.id);
    if (includePortal && (!customerAccount?.account?.username || !customerAccount.account.password)) {
      const error = new Error("Akun portal pelanggan belum tersedia.");
      error.statusCode = 404;
      throw error;
    }

    const portalData = dataManager.getCustomerPortalData(contact.id);
    if (includeHotspot && !portalData?.hotspot) {
      const error = new Error("Akun hotspot tidak tersedia atau sedang dinonaktifkan di MikroTik.");
      error.statusCode = 409;
      throw error;
    }

    const phone = await requireRegisteredWhatsAppNumber(contact.phoneNumber);
    const sentAccounts = [];
    const portalLoginUrl = `${req.protocol}://${req.get("host")}/pelanggan/login`;
    const portalPassword = includePortal ? generatePortalPassword() : "";
    let portalAccountDetails = "";
    let hotspotAccountDetails = "";
    if (includePortal) {
      portalAccountDetails = [
        "*Akun Portal Pelanggan*",
        `Alamat portal: ${portalLoginUrl}`,
        `Username: ${customerAccount.account.username}`,
        `Password: ${portalPassword}`,
      ].join("\n");
      sentAccounts.push("portal");
    }
    if (includeHotspot) {
      hotspotAccountDetails = [
        "*Akun WiFi*",
        `Username: ${portalData.hotspot.username}`,
        `Password: ${portalData.hotspot.password}`,
        `Profil: ${portalData.hotspot.profile || "-"}`,
      ].join("\n");
      sentAccounts.push("hotspot");
    }

    const settings = dataManager.getSettings();
    const companyName = sanitizeInput(settings.companyName) || "Emmeril Hotspot";
    const supportSignature = sanitizeInput(settings.supportSignature) || companyName;
    const portalAccessGuide = includePortal
      ? "Gunakan portal untuk melihat tagihan, memeriksa akun WiFi, atau mengganti password."
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
      .replace(/{{\s*portalPassword\s*}}/gi, includePortal ? portalPassword : "-")
      .replace(/{{\s*hotspotUsername\s*}}/gi, includeHotspot ? portalData.hotspot.username : "-")
      .replace(/{{\s*hotspotPassword\s*}}/gi, includeHotspot ? portalData.hotspot.password : "-")
      .replace(/{{\s*hotspotProfile\s*}}/gi, includeHotspot ? portalData.hotspot.profile || "-" : "-")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    const rotation = includePortal
      ? await dataManager.resetCustomerPortalPassword(contact.id, portalPassword)
      : null;
    let delivery;
    try {
      delivery = await notificationBot.sendMessage(phone.phoneNumber, message, {
        maxAttempts: 1,
        context: { type: "customer-account-credentials", contactId: String(contact.id) },
      });
      if (delivery?.unconfirmed === true || delivery?.confirmed === false) {
        throw new Error("WhatsApp belum mengonfirmasi penerimaan kredensial akun.");
      }
    } catch (error) {
      if (rotation) {
        try {
          const restored = await dataManager.restoreCustomerPortalPassword(
            contact.id, rotation.previousHash, rotation.currentHash
          );
          if (!restored) activityLog.push("warn", "customer-account", "Password portal berubah sebelum rollback pengiriman akun", { contactId: String(contact.id) });
        } catch (rollbackError) {
          activityLog.push("error", "customer-account", `Rollback password portal gagal: ${rollbackError.message}`, { contactId: String(contact.id) });
        }
      }
      throw error;
    }
    if (includePortal) invalidateCustomerSessions(contact.id);
    activityLog.push("info", "customer-account", `Akun pelanggan dikirim ke ${contact.phoneNumber}`, {
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
    }
  )));

  app.post("/api/contacts/:id/hotspot/provision", requireApiAuth, handleApi(async (req) => {
    const contact = dataManager.getContact(req.params.id);
    if (!contact) throw new Error("Kontak tidak ditemukan.");
    if (contact.hotspotProvisioningOperation === hotspotProvisioningOperation.ENABLE
      || contact.hotspotProvisioningOperation === hotspotProvisioningOperation.DISABLE) {
      const toggleResult = await setHotspotContactDisabled(
        contact,
        contact.hotspotProvisioningOperation === hotspotProvisioningOperation.DISABLE
      );
      return {
        ...toggleResult,
        contact: dataManager.toPublicContact(toggleResult.contact),
      };
    }
    if (contact.hotspotProvisioningOperation === hotspotProvisioningOperation.REACTIVATE
      || contact.hotspotProvisioningOperation === hotspotProvisioningOperation.DEACTIVATE) {
      const lifecycleResult = contact.hotspotProvisioningOperation === hotspotProvisioningOperation.REACTIVATE
        ? await hotspotReactivationScheduler.reactivateContact(dataManager.hydrateContact(contact))
        : await hotspotReactivationScheduler.deactivateContact(dataManager.hydrateContact(contact));
      return {
        ...lifecycleResult,
        contact: dataManager.toPublicContact(lifecycleResult.contact),
        password: undefined,
      };
    }
    const result = await provisionHotspotContact(contact, {
      sendCredentials: req.body.sendCredentials !== undefined
        ? req.body.sendCredentials
        : (contact.hotspotProvisioningOperation === hotspotProvisioningOperation.CREATE
          ? contact.hotspotSendCredentials
          : false),
    });
    const latestContact = dataManager.getContact(req.params.id);
    if (getContactHotspotAccessMode(latestContact) !== hotspotAccessModes.IP_BINDING_ONLY) {
      return result;
    }
    const accessResult = await setHotspotContactAccessMode(
      latestContact,
      getContactHotspotAccessMode(latestContact)
    );
    return {
      ...result,
      ...accessResult,
      contact: dataManager.toPublicContact(accessResult.contact),
    };
  }));

  app.post("/api/contacts/:id/hotspot/reactivate", requireApiAuth, handleApi(async (req) => {
    const contact = dataManager.getContact(req.params.id);
    if (!contact) throw new Error("Kontak tidak ditemukan.");
    if (isPrepaidPackage(contact) && !dataManager.hydrateContact(contact).packageActive) {
      throw new Error("Beli paket satu bulan sebelum mengaktifkan akun prabayar.");
    }
    const result = await hotspotReactivationScheduler.reactivateContact(
      dataManager.hydrateContact(contact),
      { manual: true }
    );
    return {
      ...result,
      contact: dataManager.toPublicContact(result.contact),
      password: undefined,
    };
  }));

  app.post("/api/contacts/:id/hotspot/disable", requireApiAuth, handleApi(async (req) => {
    const contact = dataManager.getContact(req.params.id);
    if (!contact) throw new Error("Kontak tidak ditemukan.");
    const result = await setHotspotContactDisabled(contact, true);
    return {
      ...result,
      contact: dataManager.toPublicContact(result.contact),
    };
  }));

  app.post("/api/contacts/:id/hotspot/enable", requireApiAuth, handleApi(async (req) => {
    const contact = dataManager.getContact(req.params.id);
    if (!contact) throw new Error("Kontak tidak ditemukan.");
    const result = await setHotspotContactDisabled(contact, false);
    return {
      ...result,
      contact: dataManager.toPublicContact(result.contact),
    };
  }));

  app.post("/api/contacts/:id/hotspot/access-mode", requireApiAuth, handleApi(async (req) => {
    const contact = dataManager.getContact(req.params.id);
    if (!contact) throw new Error("Kontak tidak ditemukan.");
    const requestedMode = String(req.body.mode || "").trim().toUpperCase();
    const result = requestedMode === "DISABLED"
      ? await setHotspotContactDisabled(contact, true)
      : await setHotspotContactAccessMode(contact, requestedMode);
    return {
      ...result,
      contact: dataManager.toPublicContact(result.contact),
    };
  }));

  app.post("/api/contacts/:id/active-period-purchase", requireApiAuth, handleApi(async (req) => {
    const result = await purchaseActivePeriod(req.params.id);
    const remainingDebtAmount = Math.max(0, Number(result.contact.debtAmount) || 0);
    let notificationSent = false;
    let notificationError = null;
    try {
      await notificationBot.sendPaymentNotification(
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
      activityLog.push("error", "payment", `Masa aktif tersimpan tetapi notifikasi gagal dikirim ke ${result.contact.phoneNumber}`, {
        contactId: result.contact.id,
        transactionId: result.purchase.id,
        error: error.message,
      });
    }
    return {
      ...result,
      contact: dataManager.toPublicContact(result.contact),
      notificationSent,
      notificationError,
    };
  }));

  app.post("/api/hotspot/reactivations/run", requireApiAuth, handleApi(async (_req, res) => {
    const total = Math.max(1, Number(dataManager.getDueHotspotReactivationContacts?.().length) || 0);
    const job = createBackgroundJob({
      type: "HOTSPOT_REACTIVATION",
      total,
      run: (update) => backgroundOperationLock.runExclusive("hotspot-reactivation", async () => {
        update({ phase: "PROCESSING", completed: 0, total });
        const results = await hotspotReactivationScheduler.processDueReactivations();
        update({ phase: "VERIFYING", completed: total, total });
        return results || [];
      }),
    });
    res.status(202);
    return job;
  }));

  app.post("/api/mikrotik/customers", requireApiAuth, handleApi(async (req) => {
    await requireRegisteredWhatsAppNumber(req.body.phoneNumber);
    const persisted = await dataManager.prepareHotspotRegistration(req.body);
    return provisionHotspotContact(persisted.contact, {
      sendCredentials: req.body.sendCredentials,
    });
  }));

  app.post("/api/contacts/:id/payment", requireApiAuth, handleApi(async (req) => {
    const paymentContact = typeof dataManager.getContact === "function"
      ? dataManager.getContact(req.params.id)
      : null;
    if (typeof dataManager.getContact === "function" && !paymentContact) {
      throw new Error("Kontak tidak ditemukan.");
    }
    if (isPrepaidPackage(paymentContact)) {
      throw new Error("Pelanggan prabayar dibayar melalui tindakan pembelian paket satu bulan.");
    }
    const status = sanitizeInput(req.body.status).toUpperCase();
    const requestedPaymentType = sanitizeInput(req.body.paymentType).toUpperCase();
    const paymentType = requestedPaymentType || null;
    const paymentAmount = req.body.paymentAmount === undefined || req.body.paymentAmount === null || req.body.paymentAmount === ""
      ? null
      : Number(req.body.paymentAmount);
    let updatedContact = await dataManager.updatePaymentStatus(
      req.params.id,
      status,
      paymentType,
      paymentAmount
    );
    const paymentRecorded = updatedContact.paymentRecorded !== false;
    let hotspotRecovery = { attempted: false, reason: "outstanding_balance" };
    try {
      hotspotRecovery = await recoverHotspotAfterPayment(updatedContact);
      if (hotspotRecovery.contact) updatedContact = hotspotRecovery.contact;
    } catch (error) {
      hotspotRecovery = { attempted: true, action: "failed", error: error.message };
      activityLog.push("error", "payment", "Pembayaran tersimpan tetapi pemulihan hotspot gagal", {
        contactId: updatedContact.id,
        error: error.message,
      });
    }
    const effectivePaymentType = paymentType || updatedContact.paymentType;
    const appliedPaymentAmount = Math.max(0, Number(updatedContact.paymentAppliedAmount) || 0);
    const remainingDebtAmount = Math.max(0, Number(updatedContact.debtAmount) || 0);
    const shouldSendPaymentNotification = paymentRecorded
      && (status === PAYMENT_STATUS.PAID || effectivePaymentType === PAYMENT_TYPES.ARREARS_ONLY);

    if (!shouldSendPaymentNotification) {
      return {
        contact: dataManager.toPublicContact(updatedContact),
        paymentRecorded,
        notificationSent: false,
        hotspotRecovery,
      };
    }

    const transactionId = `TRX-${Date.now()}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
    try {
      await notificationBot.sendPaymentNotification(updatedContact, transactionId, effectivePaymentType, {
        paymentAmount: appliedPaymentAmount,
        remainingDebtAmount,
      });
      return {
        contact: dataManager.toPublicContact(updatedContact),
        transactionId,
        paymentType: effectivePaymentType,
        paymentAmount: appliedPaymentAmount,
        remainingDebtAmount,
        paymentRecorded,
        notificationSent: true,
        hotspotRecovery,
      };
    } catch (error) {
      activityLog.push("error", "payment", `Status paid tersimpan tapi notifikasi gagal dikirim ke ${updatedContact.phoneNumber}`, {
        error: error.message,
        transactionId,
        contactId: updatedContact.id,
      });

      return {
        contact: dataManager.toPublicContact(updatedContact),
        transactionId,
        paymentType: effectivePaymentType,
        paymentAmount: appliedPaymentAmount,
        remainingDebtAmount,
        paymentRecorded,
        notificationSent: false,
        notificationError: error.message,
        hotspotRecovery,
      };
    }
  }));

  app.post("/api/contacts/:id/billing-reminder", requireApiAuth, handleApi(async (req) => {
    const contact = dataManager.getContact(req.params.id);
    if (!contact) throw new Error("Kontak tidak ditemukan.");
    const contactState = dataManager.hydrateContact(contact);
    const currentStatus = String(
      contactState.currentPaymentStatus || contactState.paymentStatus || PAYMENT_STATUS.UNPAID
    ).toUpperCase();
    const isOverdue = String(contactState.dueStatus || "").toUpperCase() === "OVERDUE";
    const hasDebt = Boolean(contactState.hasDebt && Number(contactState.debtCount) > 0);
    if (Number(contactState.debtCount) >= BILLING_REMINDER_STOP_DEBT_COUNT) {
      throw new Error("Pengingat tagihan tidak dikirim untuk pelanggan dengan 2 tunggakan atau lebih.");
    }
    if (!hasDebt && (currentStatus !== PAYMENT_STATUS.UNPAID || !isOverdue)) {
      throw new Error("Pengingat hanya dapat dikirim untuk tagihan yang jatuh tempo atau memiliki tunggakan.");
    }

    const result = await notificationBot.sendBillingDebtReminder(contactState);
    return {
      contact: dataManager.toPublicContact(contactState),
      ...result,
    };
  }));

  app.post("/api/contacts/:id/payment-amount", requireApiAuth, handleApi(async (req) => {
    const contact = await dataManager.updateContactPaymentAmount(
      req.params.id,
      req.body.monthlyPaymentAmount,
      { useProfileDefault: parseBoolean(req.body.useProfileDefault, false) }
    );
    return dataManager.toPublicContact(contact);
  }));

  app.post("/api/contacts/:id/payment-month", requireApiAuth, handleApi(async (req) => {
    const year = Number(req.body.year);
    const month = Number(req.body.month);
    const status = sanitizeInput(req.body.status).toUpperCase();
    const paymentType = sanitizeInput(req.body.paymentType).toUpperCase();
    let updated = await dataManager.setPaymentForMonth(
      req.params.id,
      year,
      month,
      status,
      paymentType || null
    );
    const paymentRecorded = updated.paymentRecorded !== false;
    let hotspotRecovery = { attempted: false, reason: "outstanding_balance" };
    try {
      hotspotRecovery = await recoverHotspotAfterPayment(updated);
      if (hotspotRecovery.contact) updated = hotspotRecovery.contact;
    } catch (error) {
      hotspotRecovery = { attempted: true, action: "failed", error: error.message };
      activityLog.push("error", "payment", "Pembayaran per bulan tersimpan tetapi pemulihan hotspot gagal", {
        contactId: updated.id,
        error: error.message,
      });
    }
    if (!paymentRecorded
      || status !== PAYMENT_STATUS.PAID
      || typeof notificationBot.sendPaymentNotification !== "function") {
      return {
        ...dataManager.toPublicContact(updated),
        paymentRecorded,
        notificationSent: false,
        hotspotRecovery,
      };
    }

    const transactionId = `TRX-${Date.now()}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
    const effectivePaymentType = paymentType || updated.paymentType || PAYMENT_TYPES.CURRENT_ONLY;
    try {
      await notificationBot.sendPaymentNotification(updated, transactionId, effectivePaymentType, {
        paymentAmount: Math.max(0, Number(updated.monthlyPaymentAmount) || 0),
        remainingDebtAmount: Math.max(0, Number(updated.debtAmount) || 0),
        activeUntil: updated.serviceActiveUntil || updated.hotspotReactivationAt || null,
      });
      return {
        ...dataManager.toPublicContact(updated),
        transactionId,
        paymentRecorded,
        notificationSent: true,
        hotspotRecovery,
      };
    } catch (error) {
      activityLog.push("error", "payment", "Pembayaran per bulan tersimpan tetapi notifikasi WhatsApp gagal", {
        contactId: updated.id,
        transactionId,
        error: error.message,
      });
      return {
        ...dataManager.toPublicContact(updated),
        transactionId,
        paymentRecorded,
        notificationSent: false,
        notificationError: error.message,
        hotspotRecovery,
      };
    }
  }));
}

module.exports = registerCustomerRoutes;
