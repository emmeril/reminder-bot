const { generateId } = require("../utils");

const TERMINAL_STATUSES = new Set(["sent", "accepted", "failed", "cancelled"]);

class WhatsAppQueue {
  constructor(options = {}) {
    this.concurrency = Math.max(1, Number(options.concurrency) || 1);
    this.retryLimit = Math.max(1, Number(options.retryLimit) || 3);
    this.retryDelayMs = Math.max(0, Number(options.retryDelayMs ?? 30000));
    this.activityLog = options.activityLog || null;
    this.pending = [];
    this.items = new Map();
    this.active = 0;
    this.stopped = false;
    this.historyLimit = Math.max(20, Number(options.historyLimit) || 250);
    this.messageItems = new Map();
    this.lateDeliveryStatuses = new Map();
  }

  log(level, event, message, meta = {}) {
    this.activityLog?.push(level, event, message, { event, ...meta });
  }

  enqueue(task, metadata = {}, options = {}) {
    if (this.stopped) return Promise.reject(new Error("WhatsApp queue sudah dihentikan"));
    const item = {
      id: generateId(),
      phone: metadata.phone || null,
      provider: metadata.provider || null,
      context: metadata.context || null,
      status: "pending",
      attempts: 0,
      maxAttempts: Math.max(1, Number(options.maxAttempts) || this.retryLimit),
      queuedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      error: null,
      result: null,
      task,
    };
    this.items.set(item.id, item);
    this.pending.push(item);
    this.log("info", "whatsapp.message.queued", `Message queued: ${item.phone || "unknown"}`, {
      queueId: item.id,
      phoneNumber: item.phone,
      provider: item.provider,
    });
    this.trimHistory();
    this.drain();
    return new Promise((resolve, reject) => {
      item.resolve = resolve;
      item.reject = reject;
    });
  }

  drain() {
    while (!this.stopped && this.active < this.concurrency && this.pending.length > 0) {
      const item = this.pending.shift();
      this.active += 1;
      void this.run(item).finally(() => {
        this.active -= 1;
        this.drain();
      });
    }
  }

  async run(item) {
    while (!this.stopped && item.attempts < item.maxAttempts) {
      item.attempts += 1;
      item.status = "processing";
      item.updatedAt = new Date().toISOString();
      try {
        const result = await item.task({ attempt: item.attempts, queueId: item.id });
        if (result?.confirmed === false || result?.unconfirmed === true) {
          const error = new Error("Provider tidak memberikan konfirmasi pengiriman");
          error.code = "WHATSAPP_SEND_UNCONFIRMED";
          throw error;
        }
        const deliveryStatus = String(result?.deliveryStatus || "").toLowerCase();
        const deliveryConfirmed = deliveryStatus === "delivered" || deliveryStatus === "read";
        item.status = result?.deliveryStatus
          ? (deliveryConfirmed ? "sent" : "accepted")
          : "sent";
        item.deliveryStatus = deliveryStatus || (item.status === "sent" ? "delivered" : "accepted");
        item.result = result;
        item.updatedAt = new Date().toISOString();
        this.log(item.status === "sent" ? "info" : "warn", item.status === "sent" ? "whatsapp.message.sent" : "whatsapp.message.accepted", item.status === "sent"
          ? `Message delivered: ${item.phone || "unknown"}`
          : `Message accepted by WhatsApp; delivery pending: ${item.phone || "unknown"}`, {
          queueId: item.id,
          phoneNumber: item.phone,
          provider: result?.provider || item.provider,
          providerMessageId: result?.providerMessageId || result?.messageId || null,
          deliveryStatus: item.deliveryStatus,
        });
        // Register after the initial queue event so a late ACK produces a
        // correctly ordered follow-up event instead of preceding "accepted".
        this.registerProviderMessage(item, result);
        item.resolve(result);
        return;
      } catch (error) {
        item.error = error?.message || String(error);
        item.updatedAt = new Date().toISOString();
        const retryable = error?.retryable !== false && item.attempts < item.maxAttempts;
        if (!retryable) {
          item.status = "failed";
          this.log("error", "whatsapp.message.failed", `Message failed: ${item.phone || "unknown"}`, {
            queueId: item.id,
            phoneNumber: item.phone,
            provider: item.provider,
            attempts: item.attempts,
            error: item.error,
            code: error?.code || null,
          });
          error.queueItem = this.toPublicItem(item);
          item.reject(error);
          return;
        }
        item.status = "retry";
        this.log("warn", "whatsapp.message.retry", `Message retry ${item.attempts}/${item.maxAttempts}: ${item.phone || "unknown"}`, {
          queueId: item.id,
          phoneNumber: item.phone,
          provider: item.provider,
          error: item.error,
        });
        if (this.retryDelayMs > 0) {
          await new Promise((resolve) => {
            const timer = setTimeout(resolve, this.retryDelayMs);
            timer.unref?.();
          });
        }
      }
    }

    if (this.stopped && !TERMINAL_STATUSES.has(item.status)) {
      item.status = "cancelled";
      const error = new Error("WhatsApp queue dihentikan sebelum pesan diproses");
      error.code = "WHATSAPP_QUEUE_CANCELLED";
      item.reject(error);
    }
  }

  getProviderMessageId(result) {
    return String(result?.providerMessageId || result?.messageId || "");
  }

  registerProviderMessage(item, result) {
    const messageId = this.getProviderMessageId(result);
    if (!messageId) return;
    this.messageItems.set(messageId, item);
    const lateStatus = this.lateDeliveryStatuses.get(messageId);
    if (lateStatus) {
      this.lateDeliveryStatuses.delete(messageId);
      this.applyDeliveryStatus(item, lateStatus);
    }
  }

  handleDeliveryStatus(update = {}) {
    const messageId = String(update.messageId || "");
    if (!messageId) return;
    const cutoff = Date.now() - 60_000;
    for (const [pendingId, pending] of this.lateDeliveryStatuses) {
      if ((pending.recordedAt || 0) < cutoff) this.lateDeliveryStatuses.delete(pendingId);
    }
    const item = this.messageItems.get(messageId);
    if (!item) {
      this.lateDeliveryStatuses.set(messageId, { ...update, recordedAt: Date.now() });
      return;
    }
    this.applyDeliveryStatus(item, update);
  }

  applyDeliveryStatus(item, update = {}) {
    const nextStatus = String(update.deliveryStatus || "").toLowerCase();
    if (!nextStatus) return;
    if (nextStatus === "failed") {
      if (item.status === "failed") return;
      item.status = "failed";
      item.deliveryStatus = "failed";
      item.error = update.error?.message || "WhatsApp menolak pesan setelah pengiriman awal";
      item.updatedAt = new Date().toISOString();
      if (item.result) item.result.deliveryStatus = "failed";
      this.log("error", "whatsapp.message.failed", `Message failed after acceptance: ${item.phone || "unknown"}`, {
        queueId: item.id,
        phoneNumber: item.phone,
        provider: item.provider,
        providerMessageId: this.getProviderMessageId(item.result),
        deliveryStatus: "failed",
        error: item.error,
        code: update.error?.code || null,
      });
      return;
    }

    const rank = { accepted: 1, delivered: 2, read: 3 };
    const currentStatus = String(item.deliveryStatus || "accepted").toLowerCase();
    if ((rank[nextStatus] || 0) <= (rank[currentStatus] || 0)) return;

    item.deliveryStatus = nextStatus;
    item.status = "sent";
    item.updatedAt = new Date().toISOString();
    if (item.result) {
      item.result.deliveryStatus = nextStatus;
      item.result.deliveryConfirmed = true;
    }
    this.log("info", `whatsapp.message.${nextStatus}`, `Message ${nextStatus} after acceptance: ${item.phone || "unknown"}`, {
      queueId: item.id,
      phoneNumber: item.phone,
      provider: item.provider,
      providerMessageId: this.getProviderMessageId(item.result),
      deliveryStatus: nextStatus,
    });
  }

  toPublicItem(item) {
    const { task, resolve, reject, ...publicItem } = item;
    return publicItem;
  }

  getStatus() {
    const counts = { pending: 0, processing: 0, accepted: 0, sent: 0, failed: 0, retry: 0, cancelled: 0 };
    for (const item of this.items.values()) {
      if (counts[item.status] !== undefined) counts[item.status] += 1;
    }
    return {
      concurrency: this.concurrency,
      active: this.active,
      waiting: this.pending.length,
      counts,
      items: Array.from(this.items.values()).map((item) => this.toPublicItem(item)),
    };
  }

  trimHistory() {
    if (this.items.size <= this.historyLimit) return;
    for (const [id, item] of this.items) {
      if (!TERMINAL_STATUSES.has(item.status)) continue;
      this.items.delete(id);
      const messageId = this.getProviderMessageId(item.result);
      if (messageId) this.messageItems.delete(messageId);
      if (this.items.size <= this.historyLimit) break;
    }
  }

  shutdown() {
    this.stopped = true;
    this.messageItems.clear();
    this.lateDeliveryStatuses.clear();
    for (const item of this.pending.splice(0)) {
      item.status = "cancelled";
      item.updatedAt = new Date().toISOString();
      const error = new Error("WhatsApp queue dihentikan sebelum pesan diproses");
      error.code = "WHATSAPP_QUEUE_CANCELLED";
      item.reject(error);
    }
  }
}

module.exports = WhatsAppQueue;
