const assert = require("node:assert/strict");
const { afterEach, test } = require("node:test");

const { CONFIG } = require("../src/config");
const {
  MidtransService,
  PAYMENT_GATEWAY_STATUS,
  normalizeMidtransPaymentStatus,
} = require("../src/midtrans-service");

const originalConfig = {
  MIDTRANS_ENABLED: CONFIG.MIDTRANS_ENABLED,
  MIDTRANS_IS_PRODUCTION: CONFIG.MIDTRANS_IS_PRODUCTION,
  MIDTRANS_SERVER_KEY: CONFIG.MIDTRANS_SERVER_KEY,
};

afterEach(() => Object.assign(CONFIG, originalConfig));

test("menormalkan status transaksi Midtrans", () => {
  const cases = [
    ["settlement", "", PAYMENT_GATEWAY_STATUS.PAID],
    ["capture", "accept", PAYMENT_GATEWAY_STATUS.PAID],
    ["capture", "deny", PAYMENT_GATEWAY_STATUS.FAILED],
    ["cancel", "", PAYMENT_GATEWAY_STATUS.FAILED],
    ["expire", "", PAYMENT_GATEWAY_STATUS.EXPIRED],
    ["partial_refund", "", PAYMENT_GATEWAY_STATUS.REFUNDED],
    ["pending", "", PAYMENT_GATEWAY_STATUS.PENDING],
    [undefined, undefined, PAYMENT_GATEWAY_STATUS.PENDING],
  ];

  for (const [transactionStatus, fraudStatus, expected] of cases) {
    assert.equal(normalizeMidtransPaymentStatus(transactionStatus, fraudStatus), expected);
  }
});

test("membuat payload Snap dan hanya menerima redirect resmi Midtrans", async () => {
  CONFIG.MIDTRANS_IS_PRODUCTION = false;
  const service = new MidtransService();
  let request;
  service.request = async (url, options) => {
    request = { url, options };
    return { redirect_url: "https://app.sandbox.midtrans.com/snap/v4/redirection/token" };
  };

  const response = await service.createSnapTransaction({
    orderId: "ORDER-1",
    amount: 125000,
    customer: { name: "Pelanggan Satu", phoneNumber: "628123456789" },
    itemName: "Tagihan internet Agustus",
    finishUrl: "https://billing.example/selesai",
  });

  assert.equal(request.url, "https://app.sandbox.midtrans.com/snap/v1/transactions");
  assert.equal(request.options.method, "POST");
  assert.deepEqual(JSON.parse(request.options.body), {
    transaction_details: { order_id: "ORDER-1", gross_amount: 125000 },
    item_details: [{
      id: "internet-bill",
      price: 125000,
      quantity: 1,
      name: "Tagihan internet Agustus",
    }],
    customer_details: { first_name: "Pelanggan Satu", phone: "628123456789" },
    callbacks: { finish: "https://billing.example/selesai" },
  });
  assert.equal(response.redirect_url, "https://app.sandbox.midtrans.com/snap/v4/redirection/token");
});

test("menolak redirect pembayaran di luar domain Midtrans", async () => {
  const service = new MidtransService();
  service.request = async () => ({ redirect_url: "https://attacker.example/payment" });

  await assert.rejects(
    service.createSnapTransaction({
      orderId: "ORDER-2",
      amount: 100000,
      customer: { name: "Pelanggan", phoneNumber: "628123456789" },
    }),
    (error) => error.statusCode === 502 && /URL pembayaran yang tidak aman/.test(error.message)
  );
});

test("menolak request ketika Midtrans belum dikonfigurasi", async () => {
  Object.assign(CONFIG, { MIDTRANS_ENABLED: false, MIDTRANS_SERVER_KEY: "" });
  const service = new MidtransService();

  await assert.rejects(
    service.request("https://api.sandbox.midtrans.com/v2/ORDER-3/status"),
    (error) => error.statusCode === 503 && /belum dikonfigurasi/.test(error.message)
  );
});
