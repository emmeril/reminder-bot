
class ApDownNotifier {
  constructor(mikrotikService, notificationBot, dataManager, activityLog) {
    this.mikrotikService = mikrotikService;
    this.notificationBot = notificationBot;
    this.dataManager = dataManager;
    this.activityLog = activityLog;
    this.lastStatuses = new Map();
    this.isInitialized = false;
  }

  normalizeStatus(value) {
    return String(value || "UNKNOWN").trim().toUpperCase();
  }

  renderApDownMessage(template, context) {
    return String(template || "")
      .replace(/{{\s*name\s*}}/gi, context.name || "")
      .replace(/{{\s*host\s*}}/gi, context.host || "")
      .replace(/{{\s*status\s*}}/gi, context.status || "")
      .replace(/{{\s*supportSignature\s*}}/gi, context.supportSignature || "CS Emmeril Hotspot")
      .replace(/{{\s*companyName\s*}}/gi, context.companyName || "");
  }

  async processNetwatchChanges() {
    const monitors = await this.mikrotikService.getNetwatchStatus();
    const currentStatuses = new Map(
      monitors.map((item) => [String(item.host || ""), this.normalizeStatus(item.status)])
    );

    if (!this.isInitialized) {
      this.lastStatuses = currentStatuses;
      this.isInitialized = true;
      return;
    }

    for (const monitor of monitors) {
      const host = String(monitor.host || "");
      if (!host) continue;

      const currentStatus = this.normalizeStatus(monitor.status);
      const previousStatus = this.lastStatuses.get(host);
      const isTransitionToDown = previousStatus
        && previousStatus !== "DOWN"
        && currentStatus === "DOWN";

      if (!isTransitionToDown) continue;

      const linkedContacts = this.dataManager
        .getContacts()
        .filter((contact) => String(contact.linkedApHost || "") === host);

      if (linkedContacts.length === 0) continue;

      for (const contact of linkedContacts) {
        try {
          const settings = this.dataManager.getSettings();
          const message = this.renderApDownMessage(settings.apDownMessageTemplate, {
            name: contact.name,
            host,
            status: currentStatus,
            supportSignature: settings.supportSignature || "CS Emmeril Hotspot",
            companyName: settings.companyName || "",
          });
          await this.notificationBot.sendMessage(
            contact.phoneNumber,
            message
          );
          this.activityLog.push("info", "ap-monitor", `Notifikasi AP DOWN terkirim ke ${contact.phoneNumber}`, {
            host,
            contactId: contact.id,
          });
        } catch (error) {
          this.activityLog.push("error", "ap-monitor", `Gagal kirim notifikasi AP DOWN ke ${contact.phoneNumber}`, {
            host,
            error: error.message,
            contactId: contact.id,
          });
        }
      }
    }

    this.lastStatuses = currentStatuses;
  }
}

module.exports = ApDownNotifier;
