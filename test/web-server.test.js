const assert = require("node:assert/strict");
const { afterEach, test } = require("node:test");

const AuthManager = require("../src/auth-manager");
const { WebServer } = require("../src/app");
const { CONFIG, PAYMENT_STATUS, PAYMENT_TYPES } = require("../src/config");

const originalApiKey = CONFIG.WEB_API_KEY;
const openServers = [];

afterEach(async () => {
  CONFIG.WEB_API_KEY = originalApiKey;
  await Promise.all(openServers.splice(0).map((server) => new Promise((resolve, reject) => {
    server.closeAllConnections?.();
    server.close((error) => (error ? reject(error) : resolve()));
  })));
});

async function startServer(dataManager = {}, notificationBot = {}) {
  const activityLog = { push() {}, list: () => [] };
  const authManager = new AuthManager(activityLog);
  const server = new WebServer(
    {
      getTransportStatus: async () => ({}),
      getStatus: () => ({}),
      setProvider: async () => ({}),
      reconnect: async () => ({}),
      testConnection: async () => ({}),
      sendMessage: async () => ({ provider: "baileys", messageId: "test" }),
      ...notificationBot,
    },
    {
      getSettings: () => ({ dashboardTitle: "Test" }),
      getTimezone: () => "Asia/Jakarta",
      ...dataManager,
    },
    {},
    activityLog,
    { isProcessing: false, processDueReminders: async () => {} },
    authManager,
    {},
    { isProcessing: false }
  ).app.listen(0, "127.0.0.1");
  openServers.push(server);
  await new Promise((resolve) => server.once("listening", resolve));
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

test("halaman login memakai aset lokal dan mengirim CSP", async () => {
  const baseUrl = await startServer();
  const response = await fetch(`${baseUrl}/login`);
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-security-policy"), /default-src 'self'/);
  assert.doesNotMatch(html, /https:\/\//);
  assert.match(html, /\/vendor\/alpine\.min\.js/);
});

test("API key dapat membaca identitas auth tanpa sesi dashboard", async () => {
  CONFIG.WEB_API_KEY = "test-api-key";
  const baseUrl = await startServer();

  const response = await fetch(`${baseUrl}/api/auth/me`, {
    headers: { "x-api-key": CONFIG.WEB_API_KEY },
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.success, true);
  assert.equal(payload.data.username, null);
  assert.equal(payload.data.expiresAt, null);
  assert.equal(payload.data.usingApiKey, true);
});

test("endpoint pairing code nomor WhatsApp tidak tersedia", async () => {
  const baseUrl = await startServer();
  const response = await fetch(`${baseUrl}/transport/pairing-code`, {
    method: "POST",
    redirect: "manual",
  });

  assert.equal(response.status, 404);
});

test("riwayat pembayaran bulanan memakai metadata periode yang diminta", async () => {
  CONFIG.WEB_API_KEY = "test-api-key";
  const baseUrl = await startServer({
    getPaymentsByMonth: () => [{
      id: "contact-1",
      name: "Pelanggan",
      phoneNumber: "6281234567890",
      paymentDate: "2026-08-01T00:00:00.000Z",
      paymentStatus: PAYMENT_STATUS.UNPAID,
      paymentMonths: {
        "2026-07": {
          status: PAYMENT_STATUS.PAID,
          paidDate: "2026-07-10T03:00:00.000Z",
          paymentType: PAYMENT_TYPES.CURRENT_ONLY,
        },
      },
    }],
  });

  const response = await fetch(`${baseUrl}/api/payments/2026/7`, {
    headers: { "x-api-key": CONFIG.WEB_API_KEY },
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.data[0].paymentDate, "2026-07-10T03:00:00.000Z");
  assert.equal(payload.data[0].paymentStatus, PAYMENT_STATUS.PAID);
  assert.equal(payload.data[0].paymentType, PAYMENT_TYPES.CURRENT_ONLY);
});

test("API WhatsApp status dan provider memakai auth existing", async () => {
  CONFIG.WEB_API_KEY = "test-api-key";
  let settings = { dashboardTitle: "Test", whatsappProvider: "baileys" };
  let selected = "baileys";
  const baseUrl = await startServer({
    getSettings: () => ({ ...settings }),
    updateSettings: async (patch) => {
      settings = { ...settings, ...patch };
      return { ...settings };
    },
  }, {
    getTransportStatus: async () => ({
      selectedProvider: selected,
      state: "READY",
      deviceReady: true,
      waydroid: selected === "android" ? "running" : null,
      whatsapp: "ready",
      bridge: selected === "android" ? "connected" : null,
    }),
    setProvider: async (provider) => {
      selected = provider;
    },
  });
  const headers = { "x-api-key": CONFIG.WEB_API_KEY, "content-type": "application/json" };

  const statusResponse = await fetch(`${baseUrl}/api/whatsapp/status`, { headers });
  const status = await statusResponse.json();
  assert.equal(statusResponse.status, 200);
  assert.equal(status.data.selectedProvider, "baileys");

  const providerResponse = await fetch(`${baseUrl}/api/whatsapp/provider`, {
    method: "POST",
    headers,
    body: JSON.stringify({ provider: "android" }),
  });
  const provider = await providerResponse.json();
  assert.equal(providerResponse.status, 200);
  assert.equal(provider.data.provider, "android");
  assert.equal(provider.data.status.bridge, "connected");

  const invalidResponse = await fetch(`${baseUrl}/api/whatsapp/provider`, {
    method: "POST",
    headers,
    body: JSON.stringify({ provider: "invalid" }),
  });
  assert.equal(invalidResponse.status, 400);
});
