const crypto = require("crypto");

const { CONFIG } = require("./config");
const { safeCompareString } = require("./utils");

const PAYMENT_GATEWAY_STATUS = Object.freeze({
  PENDING: "PENDING",
  PAID: "PAID",
  FAILED: "FAILED",
  EXPIRED: "EXPIRED",
  REFUNDED: "REFUNDED",
  PARTIALLY_REFUNDED: "PARTIALLY_REFUNDED",
});

function normalizeMidtransPaymentStatus(transactionStatus, fraudStatus = "") {
  const status = String(transactionStatus || "").toLowerCase();
  const fraud = String(fraudStatus || "").toLowerCase();

  if (status === "settlement" || (status === "capture" && fraud === "accept")) {
    return PAYMENT_GATEWAY_STATUS.PAID;
  }
  if (["deny", "cancel"].includes(status) || (status === "capture" && fraud === "deny")) {
    return PAYMENT_GATEWAY_STATUS.FAILED;
  }
  if (status === "expire") return PAYMENT_GATEWAY_STATUS.EXPIRED;
  if (status === "refund") return PAYMENT_GATEWAY_STATUS.REFUNDED;
  if (status === "partial_refund") return PAYMENT_GATEWAY_STATUS.PARTIALLY_REFUNDED;
  return PAYMENT_GATEWAY_STATUS.PENDING;
}

class MidtransService {
  isConfigured() {
    return Boolean(CONFIG.MIDTRANS_ENABLED && CONFIG.MIDTRANS_SERVER_KEY);
  }

  getApiBaseUrl() {
    return CONFIG.MIDTRANS_IS_PRODUCTION
      ? "https://app.midtrans.com"
      : "https://app.sandbox.midtrans.com";
  }

  getStatusApiBaseUrl() {
    return CONFIG.MIDTRANS_IS_PRODUCTION
      ? "https://api.midtrans.com"
      : "https://api.sandbox.midtrans.com";
  }

  getAuthorizationHeader() {
    return `Basic ${Buffer.from(`${CONFIG.MIDTRANS_SERVER_KEY}:`).toString("base64")}`;
  }

  async request(url, options = {}) {
    if (!this.isConfigured()) {
      const error = new Error("Pembayaran Midtrans belum dikonfigurasi oleh administrator.");
      error.statusCode = 503;
      throw error;
    }

    const acceptedStatuses = new Set(options.acceptedStatuses || []);
    const { acceptedStatuses: _acceptedStatuses, ...fetchOptions } = options;
    const response = await fetch(url, {
      ...fetchOptions,
      signal: AbortSignal.timeout(Math.max(1_000, CONFIG.MIDTRANS_HTTP_TIMEOUT)),
      headers: {
        Accept: "application/json",
        Authorization: this.getAuthorizationHeader(),
        "Content-Type": "application/json",
        ...(fetchOptions.headers || {}),
      },
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok && !acceptedStatuses.has(response.status)) {
      const message = payload.error_messages?.join(", ")
        || payload.status_message
        || `Midtrans merespons HTTP ${response.status}.`;
      const error = new Error(message);
      error.statusCode = 502;
      error.gatewayStatus = response.status;
      throw error;
    }
    return payload;
  }

  async createSnapTransaction({ orderId, amount, customer, itemName, finishUrl }) {
    const payload = {
      transaction_details: {
        order_id: orderId,
        gross_amount: amount,
      },
      item_details: [{
        id: "internet-bill",
        price: amount,
        quantity: 1,
        name: String(itemName || "Tagihan internet").slice(0, 50),
      }],
      customer_details: {
        first_name: String(customer.name || "Pelanggan").slice(0, 50),
        phone: customer.phoneNumber,
      },
      callbacks: finishUrl ? { finish: finishUrl } : undefined,
    };
    const response = await this.request(`${this.getApiBaseUrl()}/snap/v1/transactions`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    const redirectUrl = String(response.redirect_url || "");
    if (!/^https:\/\/[^/]*\.midtrans\.com\//i.test(redirectUrl)) {
      const error = new Error("Midtrans mengembalikan URL pembayaran yang tidak aman.");
      error.statusCode = 502;
      throw error;
    }
    return response;
  }

  verifyNotificationSignature(notification) {
    if (!this.isConfigured()) return false;
    const orderId = String(notification.order_id || "");
    const statusCode = String(notification.status_code || "");
    const grossAmount = String(notification.gross_amount || "");
    const signature = String(notification.signature_key || "");
    if (!orderId || !statusCode || !grossAmount || !signature) return false;
    const expected = crypto
      .createHash("sha512")
      .update(`${orderId}${statusCode}${grossAmount}${CONFIG.MIDTRANS_SERVER_KEY}`)
      .digest("hex");
    return safeCompareString(signature.toLowerCase(), expected.toLowerCase());
  }

  async getTransactionStatus(orderId) {
    return this.request(`${this.getStatusApiBaseUrl()}/v2/${encodeURIComponent(orderId)}/status`, {
      method: "GET",
      // Midtrans dapat mengembalikan HTTP 404 sesaat setelah transaksi Snap
      // dibuat. Rekonsiliasi perlu membaca payload tersebut untuk menentukan
      // apakah transaksi masih perlu dicoba ulang.
      acceptedStatuses: [404],
    });
  }
}

module.exports = {
  MidtransService,
  PAYMENT_GATEWAY_STATUS,
  normalizeMidtransPaymentStatus,
};
