const fs = require("fs/promises");
const path = require("path");
const { CONFIG } = require("./config");

class TelegramManager {
  static isConfigured() {
    return Boolean(CONFIG.TELEGRAM_BOT_TOKEN) && this.getChatIds().length > 0;
  }

  static getChatIds() {
    return String(CONFIG.TELEGRAM_CHAT_IDS || "")
      .split(/\r?\n|,/)
      .map((value) => value.trim())
      .filter(Boolean);
  }

  static getApiUrl(method) {
    const baseUrl = String(CONFIG.TELEGRAM_API_URL || "https://api.telegram.org").replace(/\/+$/, "");
    return `${baseUrl}/bot${CONFIG.TELEGRAM_BOT_TOKEN}/${method}`;
  }

  static async sendDocument(chatId, filePath, caption = "") {
    if (!CONFIG.TELEGRAM_BOT_TOKEN) {
      throw new Error("Telegram bot token belum dikonfigurasi.");
    }

    if (!String(chatId || "").trim()) {
      throw new Error("Telegram chat id kosong.");
    }

    const buffer = await fs.readFile(filePath);
    const fileName = path.basename(filePath);
    const blob = new Blob([buffer], { type: "application/octet-stream" });
    const formData = new FormData();
    formData.append("chat_id", String(chatId).trim());
    formData.append("caption", String(caption || ""));
    formData.append("document", blob, fileName);

    const response = await fetch(this.getApiUrl("sendDocument"), {
      method: "POST",
      body: formData,
    });

    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }

    if (!response.ok || payload?.ok === false) {
      const description = payload?.description || `HTTP ${response.status}`;
      throw new Error(`Telegram gagal mengirim dokumen: ${description}`);
    }

    return {
      status: "success",
      provider: "telegram",
      chatId: String(chatId).trim(),
      messageId: payload?.result?.message_id,
    };
  }
}

module.exports = TelegramManager;
