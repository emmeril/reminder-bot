const { sanitizeInput } = require("../../utils");

function registerVoucherRoutes({
  app,
  requireApiAuth,
  handleApi,
  dataManager,
  mikrotikService,
  voucherRevenueSyncScheduler,
  voucherProfileLock,
  voucherGenerationLock,
  createVoucherGenerationJob,
  getBackgroundJob,
  activityLog,
}) {
  app.get("/api/mikrotik/voucher-profiles", requireApiAuth, handleApi(async () => (
    mikrotikService.getVoucherProfiles()
  )));

  app.get("/api/mikrotik/voucher-stats", requireApiAuth, handleApi(async () => (
    mikrotikService.getVoucherProfileStats({
      knownUsageEntries: typeof dataManager.getVoucherRevenueEntries === "function"
        ? dataManager.getVoucherRevenueEntries()
        : [],
    })
  )));

  app.get("/api/mikrotik/voucher-revenue", requireApiAuth, handleApi(async (req) => {
    if (!voucherRevenueSyncScheduler || typeof dataManager.getVoucherRevenueReport !== "function") {
      return mikrotikService.getVoucherRevenueReport({
        period: req.query.period,
        dateFrom: req.query.from,
        dateTo: req.query.to,
        timeZone: dataManager.getTimezone(),
      });
    }
    try {
      await voucherRevenueSyncScheduler.processSync();
    } catch (error) {
      const storedEntries = dataManager.getVoucherRevenueEntries();
      if (storedEntries.length === 0) throw error;
      activityLog.push("error", "voucher", "MikroTik tidak dapat disinkronkan; memakai laporan voucher database", {
        error: error.message,
      });
    }
    return dataManager.getVoucherRevenueReport({
      period: req.query.period,
      dateFrom: req.query.from,
      dateTo: req.query.to,
    });
  }));

  app.post("/api/mikrotik/voucher-profiles", requireApiAuth, handleApi(async (req) => (
    voucherProfileLock.runExclusive("mikrotik-voucher-profiles", async () => {
      if (typeof dataManager.storeVoucherBatches === "function") {
        const legacyBatches = await mikrotikService.getHotspotVoucherBatches({ limit: 100 });
        await dataManager.storeVoucherBatches(legacyBatches);
      }
      return mikrotikService.saveVoucherProfile(req.body);
    })
  )));

  app.get("/api/mikrotik/voucher-batches", requireApiAuth, handleApi(async (req) => {
    const limit = req.query.limit === "all"
      ? "all"
      : Math.min(100, Math.max(1, Number(req.query.limit) || 50));
    try {
      const knownBatches = typeof dataManager.getVoucherBatches === "function"
        ? dataManager.getVoucherBatches(limit)
        : [];
      const routerBatches = await mikrotikService.getHotspotVoucherBatches({
        limit,
        knownBatches,
        knownUsageEntries: typeof dataManager.getVoucherRevenueEntries === "function"
          ? dataManager.getVoucherRevenueEntries()
          : [],
        timeZone: dataManager.getTimezone(),
      });
      if (typeof dataManager.storeVoucherBatches === "function") {
        await dataManager.storeVoucherBatches(routerBatches);
        return dataManager.getVoucherBatches(limit);
      }
      return routerBatches;
    } catch (error) {
      const stored = typeof dataManager.getVoucherBatches === "function"
        ? dataManager.getVoucherBatches(limit)
        : [];
      if (stored.length > 0) {
        activityLog.push("error", "voucher", "MikroTik tidak dapat dibaca; memakai riwayat voucher database", {
          error: error.message,
        });
        return stored;
      }
      throw error;
    }
  }));

  app.post("/api/mikrotik/voucher-jobs", requireApiAuth, handleApi(async (req, res) => {
    const job = createVoucherGenerationJob(req.body);
    res.status(202);
    return job;
  }));

  app.get("/api/mikrotik/voucher-jobs/:jobId", requireApiAuth, handleApi(async (req) => (
    getBackgroundJob(req.params.jobId, "VOUCHER_GENERATION")
  )));

  app.post("/api/mikrotik/vouchers", requireApiAuth, handleApi(async (req, res) => {
    if (String(req.body.generationType || "SINGLE").toUpperCase() === "BULK") {
      const job = createVoucherGenerationJob(req.body);
      res.status(202);
      return job;
    }
    return voucherGenerationLock.runExclusive("mikrotik-vouchers", async () => {
      const batch = await mikrotikService.createHotspotVouchers(req.body);
      if (typeof dataManager.storeVoucherBatches === "function") {
        await dataManager.storeVoucherBatches([batch]);
      }
      return batch;
    });
  }));

  app.delete("/api/mikrotik/voucher-batches/:batchId/vouchers/:username", requireApiAuth, handleApi(async (req) => (
    voucherGenerationLock.runExclusive("mikrotik-vouchers", async () => {
      const batchId = sanitizeInput(req.params.batchId);
      const username = sanitizeInput(req.params.username);
      const storedBatch = typeof dataManager.getVoucherBatch === "function"
        ? dataManager.getVoucherBatch(batchId)
        : null;
      const storedVoucher = storedBatch?.vouchers?.find((voucher) => (
        String(voucher.username || "").toLowerCase() === username.toLowerCase()
      ));
      if (!storedBatch || !storedVoucher) {
        const error = new Error("Voucher tidak ditemukan pada batch yang dipilih.");
        error.statusCode = 404;
        throw error;
      }

      const routerResult = await mikrotikService.deleteHotspotVoucher({ batchId, username });
      const storageResult = await dataManager.removeVoucherFromBatch(batchId, username);
      activityLog.push("info", "voucher", `Voucher ${username} dihapus`, {
        batchId,
        username,
        removedFromRouter: routerResult.removedUsers > 0,
        activeSessionsKilled: routerResult.activeSessionsKilled,
      });
      return { ...routerResult, ...storageResult };
    })
  )));

  app.post("/api/mikrotik/voucher-batches/:batchId/vouchers/:username/reset-device", requireApiAuth, handleApi(async (req) => (
    voucherGenerationLock.runExclusive("mikrotik-vouchers", async () => {
      const batchId = sanitizeInput(req.params.batchId);
      const username = sanitizeInput(req.params.username);
      const storedBatch = typeof dataManager.getVoucherBatch === "function"
        ? dataManager.getVoucherBatch(batchId)
        : null;
      const storedVoucher = storedBatch?.vouchers?.find((voucher) => (
        String(voucher.username || "").toLowerCase() === username.toLowerCase()
      ));
      if (!storedBatch || !storedVoucher) {
        const error = new Error("Voucher tidak ditemukan pada batch yang dipilih.");
        error.statusCode = 404;
        throw error;
      }

      const result = await mikrotikService.resetHotspotVoucherMac({ batchId, username });
      activityLog.push("info", "voucher", `Perangkat voucher ${username} direset`, {
        batchId,
        username,
        previousMacAddress: result.previousMacAddress,
        activeSessionsKilled: result.activeSessionsKilled,
      });
      return result;
    })
  )));
}

module.exports = registerVoucherRoutes;
