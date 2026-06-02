const { CONFIG } = require("./config");
const { isValidPhoneNumber, normalizePhoneNumber } = require("./utils");

class FonnteManager {
  static isConfigured() {
    return (CONFIG.FONNTE_ENABLED || CONFIG.FONNTE_BACKUP_ENABLED) && Boolean(CONFIG.FONNTE_TOKEN);
  }

  static async sendMessage(number, message) {
    if (!this.isConfigured()) {
      throw new Error("Fonnte backup is not configured");
    }

    const normalized = normalizePhoneNumber(number);
    if (!isValidPhoneNumber(normalized)) {
      throw new Error("Invalid target phone number");
    }

    const formData = new FormData();
    formData.append("target", normalized);
    formData.append("message", String(message || ""));

    const response = await fetch(CONFIG.FONNTE_API_URL, {
      method: "POST",
      headers: {
        Authorization: CONFIG.FONNTE_TOKEN,
      },
      body: formData,
    });

    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }

    if (!response.ok || payload?.status === false) {
      const errorMessage = payload?.reason
        || payload?.detail
        || payload?.message
        || `HTTP ${response.status}`;
      throw new Error(`Fonnte gagal mengirim pesan: ${errorMessage}`);
    }

    return {
      status: "success",
      provider: "fonnte",
      message: payload.detail || "Message sent via Fonnte",
      messageId: Array.isArray(payload.id) ? payload.id[0] : payload.id,
      requestId: payload.requestid,
    };
  }
}

module.exports = FonnteManager;
