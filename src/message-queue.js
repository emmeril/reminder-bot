const crypto = require("crypto");
const { Op } = require("sequelize");
const AsyncLock = require("./async-lock");
const { CONFIG, WA_CRITICAL_STATES, WA_STATES } = require("./config");
const FonnteManager = require("./fonnte-manager");

const WHATSAPP_ERROR_PATTERN =
  /not ready|timed out|protocolTimeout|detached Frame|connection|timeout|undefined|getChat|pupPage|not initialized|browser|page|disconnected|failed|error/i;

class MessageQueue {
  constructor(waManager, dataManager, activityLog) {
    this.waManager = waManager;
    this.dataManager = dataManager;
    this.activityLog = activityLog;
    this.pending = [];
    this.processing = [];
    this.failed = [];
    this.isProcessing = false;
    this.saveChain = Promise.resolve();
    this.processTimer = null;
    this.queueLock = new AsyncLock();
  }

  async loadFromDB() {
    const models = this.dataManager.models;
    const pendingItems = await models.WhatsappQueueItem.findAll({
      where: { status: { [Op.in]: ["pending", "processing"] } },
      order: [["createdAt", "ASC"]],
    });
    const failedItems = await models.WhatsappQueueItem.findAll({ where: { status: "failed" } });

    this.pending = pendingItems.map((item) => this._mapItem(item));
    this.processing = [];
    this.failed = failedItems.map((item) => this._mapItem(item));

    this.activityLog.push("info", "queue", `Loaded queue: ${this.pending.length} pending, ${this.failed.length} failed`);
  }

  _mapItem(item) {
    return {
      id: item.id,
      number: item.number,
      message: item.message,
      metadata: item.metadata,
      createdAt: item.createdAt,
      attempts: item.attempts,
      maxAttempts: item.maxAttempts,
      errorMsg: item.errorMsg,
    };
  }

  async save() {
    const items = this._snapshotItems();

    this.saveChain = this.saveChain
      .then(async () => {
        const models = this.dataManager.models;
        await this.dataManager.withDatabaseWrite(() => (
          models.sequelize.transaction(async (transaction) => {
            await models.WhatsappQueueItem.destroy({
              where: { status: { [Op.in]: ["pending", "processing", "failed"] } },
              transaction,
            });

            if (items.length) {
              await models.WhatsappQueueItem.bulkCreate(items, { transaction });
            }
          })
        ));
      })
      .catch((error) => {
        this.activityLog.push("error", "queue", `Failed to save queue: ${error.message}`);
      });

    return this.saveChain;
  }

  _snapshotItems() {
    return [
      ...this.pending.map((i) => ({ ...i, status: "pending" })),
      // Keep in-flight messages recoverable after a crash or restart.
      ...this.processing.map((i) => ({ ...i, status: "pending" })),
      ...this.failed.map((i) => ({ ...i, status: "failed" })),
    ];
  }

  _allItems() {
    return [...this.pending, ...this.processing, ...this.failed];
  }

  _removeProcessing(itemId) {
    this.processing = this.processing.filter((item) => item.id !== itemId);
  }

  _scheduleProcess(delay = 1000) {
    if (this.processTimer) return;

    this.processTimer = setTimeout(() => {
      this.processTimer = null;
      this.process().catch((error) => {
        this.activityLog.push("error", "queue", "Scheduled queue processing failed", { error: error.message });
      });
    }, delay);
  }

  add(number, message, metadata = {}) {
    if (metadata?.orderId && metadata?.type) {
      const existingItem = this._allItems().find(
        (item) => item.metadata?.orderId === metadata.orderId && item.metadata?.type === metadata.type
      );
      if (existingItem) {
        return existingItem.id;
      }
    }

    const item = {
      id: crypto.randomBytes(8).toString("hex"),
      number,
      message,
      metadata,
      createdAt: new Date(),
      attempts: 0,
      maxAttempts: 3,
    };

    this.pending.push(item);
    this.save();
    this.activityLog.push("info", "queue", `Added to queue: ${item.id} for ${number}`);

    if (this.canProcess()) {
      this._scheduleProcess(5000);
    } else if (this.waManager.reconnectAttempts === 0 && !this.waManager.isReconnecting) {
      this.waManager.scheduleReconnect();
    }

    return item.id;
  }

  canUseWhatsAppWeb() {
    return this.waManager.state === WA_STATES.CONNECTED && !this.waManager.isReconnecting;
  }

  canUseBackup() {
    return FonnteManager.isConfigured();
  }

  canProcess() {
    return this.pending.length > 0 && (this.canUseWhatsAppWeb() || this.canUseBackup());
  }

  async process() {
    await this.queueLock.runExclusive("whatsapp_queue_process", async () => {
      if (this.isProcessing) return;

      if (!this.canProcess() || (this.waManager.isReconnecting && !this.canUseBackup())) {
        if (this.pending.length > 0 && !this.canUseWhatsAppWeb() && !this.canUseBackup()) {
          this.activityLog.push("info", "queue", `Queue waiting for WA/Fonnte (State: ${this.waManager.state})`);
        }
        return;
      }

      this.isProcessing = true;
      this.activityLog.push("info", "queue", `Processing ${this.pending.length} messages`);

      try {
        const items = this.pending.splice(0, CONFIG.WA_MAX_QUEUE_PROCESS);
        this.processing.push(...items);
        await this.save();

        for (const item of items) {
          try {
            this.activityLog.push("info", "queue", `Processing ${item.id} (attempt ${item.attempts + 1}/${item.maxAttempts})`);

            const result = await this._sendWithAvailableProvider(item);

            if (result.status === "success") {
              this.activityLog.push("info", "queue", `Sent successfully: ${item.id} via ${result.provider || "whatsapp-web"}`);
              this._removeProcessing(item.id);
              await this.save();

              // Kirim notifikasi ke admin via WhatsApp (jika bukan directRequest)
              if (process.env.ADMIN_NUMBER && item.metadata?.directRequest !== true) {
                setTimeout(() => {
                  this._sendAdminDeliveryNotification(item, result.provider || "whatsapp-web").catch((error) => {
                    this.activityLog.push("error", "queue", "Admin notification failed", { error: error.message });
                  });
                }, 1000);
              }

              await new Promise((resolve) => setTimeout(resolve, CONFIG.WA_MESSAGE_DELAY));
            } else {
              this._removeProcessing(item.id);
              this._handleFailure(item, result.message);
              break;
            }
          } catch (error) {
            this._removeProcessing(item.id);
            this._handleFailure(item, error.message);
            break;
          }
        }
      } finally {
        this.isProcessing = false;
      }

      // Periksa kembali setelah proses selesai
      if (this.pending.length > 0 && this.canProcess()) {
        this._scheduleProcess(1000);
      }
    });
  }

  async _sendWithAvailableProvider(item) {
    let fallbackReason = "";
    if (this.canUseWhatsAppWeb() && this.waManager.client) {
      const result = await this.waManager.sendMessage(item.number, item.message);
      if (result.status === "success") {
        if (typeof this.waManager.noteProviderUsed === "function") {
          await this.waManager.noteProviderUsed("whatsapp-web", {
            source: "queue",
            itemId: item.id,
            phoneNumber: item.number,
          });
        }
        return { ...result, provider: "whatsapp-web" };
      }

      if (!this.canUseBackup()) {
        return result;
      }

      fallbackReason = result.message;
      this.activityLog.push("warn", "queue", `WhatsApp Web failed for ${item.id}, trying Fonnte backup`, {
        error: result.message,
      });
    }

    if (this.canUseBackup()) {
      const backupResult = await FonnteManager.sendMessage(item.number, item.message);
      if (backupResult.status === "success" && typeof this.waManager.noteProviderUsed === "function") {
        await this.waManager.noteProviderUsed("fonnte", {
          source: "queue",
          itemId: item.id,
          phoneNumber: item.number,
          reason: fallbackReason || `WhatsApp state: ${this.waManager.state}`,
          waState: this.waManager.state,
        });
      }
      return backupResult;
    }

    if (this.waManager.state !== WA_STATES.CONNECTED) this.waManager.scheduleReconnect();
    return {
      status: "error",
      message: `WhatsApp not ready (State: ${this.waManager.state}) and Fonnte backup is not configured`,
    };
  }

  async _sendAdminDeliveryNotification(item, provider) {
    const message = `[OK] WhatsApp sent (${item.id})\nProvider: ${provider}\nTo: ${item.number}\n${item.message.substring(0, 50)}...`;
    const adminNumber = process.env.ADMIN_NUMBER;
    if (!adminNumber) return;

    if (this.canUseWhatsAppWeb() && this.waManager.client) {
      const result = await this.waManager.sendMessage(adminNumber, message);
      if (result.status === "success") return result;
    }

    if (this.canUseBackup()) {
      return await FonnteManager.sendMessage(adminNumber, message);
    }

    throw new Error("No WhatsApp provider available for admin notification");
  }

  _isWhatsAppError(errorMsg) {
    return WHATSAPP_ERROR_PATTERN.test(String(errorMsg || ""));
  }

  _requeueForWhatsAppRecovery(item, isWAError) {
    this.activityLog.push("info", "queue", `WhatsApp issue, requeuing (State: ${this.waManager.state})`);
    if (isWAError) this.waManager.state = WA_STATES.TIMEOUT;

    this.pending.unshift(item);
    this.save();

    if (!WA_CRITICAL_STATES.has(this.waManager.state)) return;

    if (this.waManager.reconnectAttempts < CONFIG.WA_MAX_RECONNECT_ATTEMPTS) {
      this.waManager.scheduleReconnect();
      return;
    }

    this.activityLog.push("error", "queue", "Max reconnect attempts, manual intervention required.");
  }

  _scheduleRetry(item) {
    const delay = Math.min(60000, 5000 * Math.pow(2, item.attempts));
    this.activityLog.push("info", "queue", `Retrying ${item.id} in ${delay / 1000}s`);

    setTimeout(() => {
      this.pending.push(item);
      this.save();

      if (this.canProcess()) {
        this._scheduleProcess(1000);
      }
    }, delay);
  }

  _moveToFailed(item, errorMsg) {
    this.failed.push({ ...item, errorMsg });
    this.save();
    this.activityLog.push("info", "queue", `Message ${item.id} moved to failed after ${item.maxAttempts} attempts`);
    this._sendAdminFailureEmail(item, errorMsg);
  }

  _sendAdminFailureEmail(item, errorMsg) {
    const { ADMIN_EMAIL, EMAIL_USER, EMAIL_PASSWORD } = process.env;
    if (!ADMIN_EMAIL) return;

    if (!EMAIL_USER || !EMAIL_PASSWORD) {
      this.activityLog.push("warn", "queue", "Admin email notification skipped because email credentials are incomplete");
      return;
    }

    let nodemailer;
    try {
      nodemailer = require("nodemailer");
    } catch (error) {
      this.activityLog.push("warn", "queue", "Admin email notification skipped because nodemailer is not installed", {
        error: error.message,
      });
      return;
    }

    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user: EMAIL_USER, pass: EMAIL_PASSWORD },
    });

    transporter.sendMail({
      from: EMAIL_USER,
      to: ADMIN_EMAIL,
      subject: `[FAILED] WhatsApp message failed after ${item.maxAttempts} attempts`,
      text: `ID: ${item.id}\nTo: ${item.number}\nError: ${String(errorMsg || "").substring(0, 200)}`,
    }).catch((error) => {
      this.activityLog.push("error", "queue", "Admin email notification failed", { error: error.message });
    });
  }

  _handleFailure(item, errorMsg) {
    this.activityLog.push("error", "queue", `Send failed for ${item.id}: ${errorMsg} (State: ${this.waManager.state})`);

    const isWAError = this._isWhatsAppError(errorMsg);

    if (isWAError || this.waManager.state !== WA_STATES.CONNECTED) {
      this._requeueForWhatsAppRecovery(item, isWAError);
      return;
    }

    item.attempts++;
    if (item.attempts >= item.maxAttempts) {
      this._moveToFailed(item, errorMsg);
    } else {
      this._scheduleRetry(item);
    }
  }

  restoreFailed() {
    if (this.failed.length > 0) {
      this.activityLog.push("info", "queue", `Restoring ${this.failed.length} failed messages`);
      this.pending.push(
        ...this.failed.map((item) => ({
          ...item,
          attempts: 0,
          status: "retrying",
          retriedAt: new Date().toISOString(),
        }))
      );
      this.failed = [];
      this.save();
    }
  }
}

module.exports = MessageQueue;
