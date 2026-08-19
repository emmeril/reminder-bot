const assert = require("node:assert/strict");
const { afterEach, test } = require("node:test");

const AuthManager = require("../src/auth-manager");
const { WebServer } = require("../src/app");
const { CONFIG, PAYMENT_STATUS, PAYMENT_TYPES } = require("../src/config");

const originalAuthConfig = {
  WEB_API_KEY: CONFIG.WEB_API_KEY,
  AUTH_USERNAME: CONFIG.AUTH_USERNAME,
  AUTH_PASSWORD: CONFIG.AUTH_PASSWORD,
  SESSION_SECRET: CONFIG.SESSION_SECRET,
  SESSION_COOKIE_SECURE: CONFIG.SESSION_COOKIE_SECURE,
  HOST: CONFIG.HOST,
  PORT: CONFIG.PORT,
};
const openServers = [];

afterEach(async () => {
  Object.assign(CONFIG, originalAuthConfig);
  await Promise.all(openServers.splice(0).map((server) => new Promise((resolve, reject) => {
    server.closeAllConnections?.();
    server.close((error) => (error ? reject(error) : resolve()));
  })));
});

async function startServer(dataManager = {}, notificationBot = {}, mikrotikService = {}, hotspotReactivationScheduler = {}) {
  const activityLog = { push() {}, list: () => [] };
  const authManager = new AuthManager(activityLog);
  const server = new WebServer(
    {
      getTransportStatus: async () => ({}),
      getStatus: () => ({}),
      setProvider: async () => ({}),
      reconnect: async () => ({}),
      testConnection: async () => ({}),
      checkPhoneNumber: async (phoneNumber) => ({ phoneNumber, registered: true }),
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
    mikrotikService,
    { isProcessing: false, ...hotspotReactivationScheduler }
  ).app.listen(0, "127.0.0.1");
  openServers.push(server);
  await new Promise((resolve) => server.once("listening", resolve));
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

async function login(baseUrl) {
  Object.assign(CONFIG, {
    AUTH_USERNAME: "operator",
    AUTH_PASSWORD: "test-password",
    SESSION_SECRET: "test-session-secret",
  });
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "operator", password: "test-password" }),
  });
  assert.equal(response.status, 200);
  return response.headers.get("set-cookie").split(";", 1)[0];
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

test("health check publik tidak membocorkan framework dan membawa request ID", async () => {
  const baseUrl = await startServer();
  const response = await fetch(`${baseUrl}/healthz`, {
    headers: { "x-request-id": "probe-123" },
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.status, "ok");
  assert.equal(response.headers.get("x-request-id"), "probe-123");
  assert.equal(response.headers.get("x-powered-by"), null);
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("readiness mengembalikan 503 ketika database tidak sehat", async () => {
  const baseUrl = await startServer({
    healthCheck: async () => {
      throw new Error("database unavailable");
    },
  });
  const response = await fetch(`${baseUrl}/readyz`);
  const payload = await response.json();

  assert.equal(response.status, 503);
  assert.equal(payload.status, "not_ready");
});

test("request mutasi dari origin lain ditolak", async () => {
  CONFIG.WEB_API_KEY = "test-api-key";
  const baseUrl = await startServer();
  const response = await fetch(`${baseUrl}/api/settings`, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      "x-api-key": CONFIG.WEB_API_KEY,
      origin: "https://attacker.example",
    },
    body: JSON.stringify({ dashboardTitle: "Changed" }),
  });
  const payload = await response.json();

  assert.equal(response.status, 403);
  assert.match(payload.error, /Cross-origin/);
});

test("cookie sesi dapat dipaksa Secure saat TLS berakhir di luar aplikasi", async () => {
  CONFIG.SESSION_COOKIE_SECURE = true;
  const baseUrl = await startServer();
  const cookie = await login(baseUrl);

  assert.match(cookie, /^reminder_bot_session=/);
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "operator", password: "test-password" }),
  });
  assert.match(response.headers.get("set-cookie"), /; Secure(?:;|$)/);
});

test("WebServer menutup listener dan menandai readiness saat shutdown", async () => {
  Object.assign(CONFIG, { HOST: "127.0.0.1", PORT: 0 });
  const activityLog = { push() {}, list: () => [] };
  const webServer = new WebServer(
    { getStatus: () => ({}) },
    { getSettings: () => ({ dashboardTitle: "Test" }), healthCheck: async () => true },
    {},
    activityLog,
    {},
    new AuthManager(activityLog),
    {},
    {}
  );
  const server = await webServer.start();
  const port = server.address().port;

  const readyResponse = await fetch(`http://127.0.0.1:${port}/readyz`);
  assert.equal(readyResponse.status, 200);

  await webServer.stop(1_000);
  assert.equal(webServer.ready, false);
  assert.equal(webServer.server, null);
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

test("pelanggan login dengan akun portal terpisah dan hanya membaca data miliknya", async () => {
  CONFIG.SESSION_SECRET = "test-session-secret";
  const ownPortalData = {
    customer: { id: "contact-customer", name: "Pelanggan Satu", phoneNumber: "6281234567890" },
    billing: { totalAmount: 200000, history: [] },
    hotspot: { username: "pelanggan_satu", password: "67890", profile: "50M", status: "ACTIVE" },
    account: { username: "akun_pelanggan_satu" },
    company: { name: "Test ISP" },
  };
  const baseUrl = await startServer({
    findCustomerPortalAccount: (username) => (
      String(username).toLowerCase() === "akun_pelanggan_satu"
        ? {
            account: { contactId: "contact-customer", username: "akun_pelanggan_satu", password: "portal-123" },
            pelanggan: { username: "pelanggan_satu", password: "67890" },
            contact: { id: "contact-customer", name: "Pelanggan Satu" },
          }
        : null
    ),
    getCustomerPortalData: (contactId) => (
      contactId === "contact-customer" ? ownPortalData : null
    ),
  });

  const loginResponse = await fetch(`${baseUrl}/api/pelanggan/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "akun_pelanggan_satu", password: "portal-123" }),
  });
  const cookie = loginResponse.headers.get("set-cookie").split(";", 1)[0];
  assert.equal(loginResponse.status, 200);
  assert.match(cookie, /^reminder_bot_customer_session=/);

  const accountResponse = await fetch(`${baseUrl}/api/pelanggan/account`, { headers: { cookie } });
  const payload = await accountResponse.json();
  assert.equal(accountResponse.status, 200);
  assert.equal(payload.data.customer.id, "contact-customer");
  assert.equal(payload.data.hotspot.password, "67890");

  const adminCookie = await login(baseUrl);
  const rejected = await fetch(`${baseUrl}/api/pelanggan/account`, { headers: { cookie: adminCookie } });
  assert.equal(rejected.status, 401);
});

test("login pelanggan menolak password akun portal yang salah", async () => {
  CONFIG.SESSION_SECRET = "test-session-secret";
  const baseUrl = await startServer({
    findCustomerPortalAccount: () => ({
      account: { contactId: "contact-customer", username: "akun_pelanggan_satu", password: "portal-123" },
      pelanggan: { username: "pelanggan_satu", password: "67890" },
      contact: { id: "contact-customer", name: "Pelanggan Satu" },
    }),
  });

  const response = await fetch(`${baseUrl}/api/pelanggan/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "akun_pelanggan_satu", password: "salah" }),
  });
  const payload = await response.json();

  assert.equal(response.status, 401);
  assert.equal(payload.error, "Username atau password salah.");
  assert.equal(response.headers.get("set-cookie"), null);
});

test("pelanggan dapat mengganti password hotspot dan sesi lain diakhiri", async () => {
  CONFIG.SESSION_SECRET = "test-session-secret";
  let hotspotPassword = "67890";
  const portalPassword = "portal-123";
  const routerPasswords = [];
  const contact = {
    id: "contact-customer",
    name: "Pelanggan Satu",
    phoneNumber: "6281234567890",
    mikrotikUsername: "pelanggan_satu",
    mikrotikProfile: "50M",
  };
  const buildPortalData = () => ({
    customer: { id: contact.id, name: contact.name, phoneNumber: contact.phoneNumber },
    billing: { totalAmount: 200000, history: [] },
    hotspot: { username: contact.mikrotikUsername, password: hotspotPassword, profile: "50M", status: "ACTIVE" },
    account: { username: "akun_pelanggan_satu" },
    company: { name: "Test ISP" },
  });
  const account = () => ({
    account: { contactId: contact.id, username: "akun_pelanggan_satu", password: portalPassword },
    pelanggan: { username: "pelanggan_satu", password: hotspotPassword, contactId: contact.id },
    contact: { ...contact, mikrotikPassword: hotspotPassword },
  });
  const baseUrl = await startServer({
    findCustomerPortalAccount: (username) => String(username).toLowerCase() === "akun_pelanggan_satu" ? account() : null,
    getCustomerPortalAccountByContactId: (contactId) => contactId === contact.id ? account() : null,
    getCustomerPortalData: (contactId) => contactId === contact.id ? buildPortalData() : null,
    updateCustomerHotspotPassword: async (_contactId, currentPassword, newPassword) => {
      assert.equal(currentPassword, hotspotPassword);
      hotspotPassword = newPassword;
      return buildPortalData();
    },
  }, {}, {
    updateHotspotCustomer: async ({ password: nextPassword }) => {
      routerPasswords.push(nextPassword);
      return { username: contact.mikrotikUsername, password: nextPassword, profile: "50M" };
    },
  });

  const customerLogin = async () => {
    const response = await fetch(`${baseUrl}/api/pelanggan/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "akun_pelanggan_satu", password: portalPassword }),
    });
    assert.equal(response.status, 200);
    return response.headers.get("set-cookie").split(";", 1)[0];
  };
  const firstCookie = await customerLogin();
  const secondCookie = await customerLogin();

  const response = await fetch(`${baseUrl}/api/pelanggan/hotspot/password`, {
    method: "PUT",
    headers: { cookie: firstCookie, "content-type": "application/json" },
    body: JSON.stringify({
      currentPassword: "67890",
      newPassword: "baru-67890",
      confirmPassword: "baru-67890",
    }),
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.data.hotspot.password, "baru-67890");
  assert.deepEqual(routerPasswords, ["baru-67890"]);
  assert.equal(hotspotPassword, "baru-67890");

  const currentSession = await fetch(`${baseUrl}/api/pelanggan/account`, { headers: { cookie: firstCookie } });
  const invalidatedSession = await fetch(`${baseUrl}/api/pelanggan/account`, { headers: { cookie: secondCookie } });
  assert.equal(currentSession.status, 200);
  assert.equal(invalidatedSession.status, 401);

  const hotspotCredentialLogin = await fetch(`${baseUrl}/api/pelanggan/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "akun_pelanggan_satu", password: hotspotPassword }),
  });
  assert.equal(hotspotCredentialLogin.status, 401);

  const loginAfterHotspotChange = await customerLogin();
  assert.match(loginAfterHotspotChange, /^reminder_bot_customer_session=/);
});

test("password lokal tidak berubah ketika sinkronisasi MikroTik gagal", async () => {
  CONFIG.SESSION_SECRET = "test-session-secret";
  let persistenceCalls = 0;
  const contact = {
    id: "contact-customer",
    name: "Pelanggan Satu",
    phoneNumber: "6281234567890",
    mikrotikUsername: "pelanggan_satu",
    mikrotikProfile: "50M",
  };
  const portalData = {
    customer: { id: contact.id, name: contact.name },
    billing: { history: [] },
    hotspot: { username: "pelanggan_satu", password: "67890", profile: "50M", status: "ACTIVE" },
    account: { username: "akun_pelanggan_satu" },
    company: { name: "Test ISP" },
  };
  const baseUrl = await startServer({
    findCustomerPortalAccount: () => ({ account: { username: "akun_pelanggan_satu", password: "portal-123" }, pelanggan: { username: "pelanggan_satu", password: "67890" }, contact: { ...contact, mikrotikPassword: "67890" } }),
    getCustomerPortalAccountByContactId: () => ({ account: { username: "akun_pelanggan_satu", password: "portal-123" }, pelanggan: { username: "pelanggan_satu", password: "67890" }, contact: { ...contact, mikrotikPassword: "67890" } }),
    getCustomerPortalData: () => portalData,
    updateCustomerHotspotPassword: async () => { persistenceCalls += 1; },
  }, {}, {
    updateHotspotCustomer: async () => { throw new Error("router offline"); },
  });
  const loginResponse = await fetch(`${baseUrl}/api/pelanggan/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "akun_pelanggan_satu", password: "portal-123" }),
  });
  const cookie = loginResponse.headers.get("set-cookie").split(";", 1)[0];

  const response = await fetch(`${baseUrl}/api/pelanggan/hotspot/password`, {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ currentPassword: "67890", newPassword: "baru-67890", confirmPassword: "baru-67890" }),
  });
  const payload = await response.json();

  assert.equal(response.status, 502);
  assert.match(payload.error, /sinkronisasi MikroTik gagal/);
  assert.equal(persistenceCalls, 0);
});

test("password MikroTik dikembalikan ketika penyimpanan database gagal", async () => {
  CONFIG.SESSION_SECRET = "test-session-secret";
  const routerPasswords = [];
  const contact = {
    id: "contact-customer",
    name: "Pelanggan Satu",
    phoneNumber: "6281234567890",
    mikrotikUsername: "pelanggan_satu",
    mikrotikProfile: "50M",
  };
  const portalData = {
    customer: { id: contact.id, name: contact.name },
    billing: { history: [] },
    hotspot: { username: "pelanggan_satu", password: "67890", profile: "50M", status: "ACTIVE" },
    account: { username: "akun_pelanggan_satu" },
    company: { name: "Test ISP" },
  };
  const account = { account: { username: "akun_pelanggan_satu", password: "portal-123" }, pelanggan: { username: "pelanggan_satu", password: "67890" }, contact: { ...contact, mikrotikPassword: "67890" } };
  const baseUrl = await startServer({
    findCustomerPortalAccount: () => account,
    getCustomerPortalAccountByContactId: () => account,
    getCustomerPortalData: () => portalData,
    updateCustomerHotspotPassword: async () => { throw new Error("database gagal"); },
  }, {}, {
    updateHotspotCustomer: async ({ password }) => {
      routerPasswords.push(password);
      return { username: "pelanggan_satu", password, profile: "50M" };
    },
  });
  const loginResponse = await fetch(`${baseUrl}/api/pelanggan/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "akun_pelanggan_satu", password: "portal-123" }),
  });
  const cookie = loginResponse.headers.get("set-cookie").split(";", 1)[0];

  const response = await fetch(`${baseUrl}/api/pelanggan/hotspot/password`, {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ currentPassword: "67890", newPassword: "baru-67890", confirmPassword: "baru-67890" }),
  });
  const payload = await response.json();

  assert.equal(response.status, 500);
  assert.match(payload.error, /perubahan MikroTik sudah dibatalkan/);
  assert.deepEqual(routerPasswords, ["baru-67890", "67890"]);
});

test("endpoint pairing code nomor WhatsApp tidak tersedia", async () => {
  const baseUrl = await startServer();
  const response = await fetch(`${baseUrl}/transport/pairing-code`, {
    method: "POST",
    redirect: "manual",
  });

  assert.equal(response.status, 404);
});

test("reset pairing memerlukan konfirmasi eksplisit", async () => {
  let resetCalls = 0;
  const baseUrl = await startServer({}, {
    resetPairing: async () => { resetCalls += 1; },
    getTransportStatus: async () => ({
      whatsappProviderEnabled: true,
      deviceReady: true,
      outboundEnabled: true,
      activeInstanceId: "primary",
      instances: [{
        id: "primary",
        role: "primary",
        connected: true,
        canSend: true,
        account: "Reminder Bot",
        currentQR: false,
        detail: "Baileys terhubung",
      }],
    }),
  });
  const cookie = await login(baseUrl);

  const pageResponse = await fetch(`${baseUrl}/transport`, { headers: { cookie } });
  const html = await pageResponse.text();
  assert.equal(pageResponse.status, 200);
  assert.match(html, /name="confirmReset" value="yes" required/);
  assert.match(html, /Hapus Sesi &amp; Buat QR Baru/);

  const rejected = await fetch(`${baseUrl}/transport/reset-pairing`, {
    method: "POST",
    redirect: "manual",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: "instanceId=primary",
  });
  assert.equal(rejected.status, 302);
  assert.match(rejected.headers.get("location"), /error=/);
  assert.equal(resetCalls, 0);

  const confirmed = await fetch(`${baseUrl}/transport/reset-pairing`, {
    method: "POST",
    redirect: "manual",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: "instanceId=primary&confirmReset=yes",
  });
  assert.equal(confirmed.status, 302);
  assert.match(confirmed.headers.get("location"), /pairingReset=1/);
  assert.equal(resetCalls, 1);
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

test("API WhatsApp status memakai auth existing dan endpoint pemilih provider dihapus", async () => {
  CONFIG.WEB_API_KEY = "test-api-key";
  let settings = { dashboardTitle: "Test" };
  const baseUrl = await startServer({
    getSettings: () => ({ ...settings }),
    updateSettings: async (patch) => {
      settings = { ...settings, ...patch };
      return { ...settings };
    },
  }, {
    getTransportStatus: async () => ({
      selectedProvider: "baileys",
      state: "READY",
      deviceReady: true,
      whatsapp: "ready",
    }),
  });
  const headers = { "x-api-key": CONFIG.WEB_API_KEY, "content-type": "application/json" };

  const statusResponse = await fetch(`${baseUrl}/api/whatsapp/status`, { headers });
  const status = await statusResponse.json();
  assert.equal(statusResponse.status, 200);
  assert.equal(status.data.selectedProvider, "baileys");

  const providerResponse = await fetch(`${baseUrl}/api/whatsapp/provider`, {
    method: "POST",
    headers,
    body: JSON.stringify({ provider: "baileys" }),
  });
  assert.equal(providerResponse.status, 404);
});

test("API menolak pelanggan dengan nomor yang tidak terdaftar di WhatsApp", async () => {
  CONFIG.WEB_API_KEY = "test-api-key";
  let addContactCalls = 0;
  const baseUrl = await startServer({
    addContact: async (payload) => {
      addContactCalls += 1;
      return payload;
    },
    toPublicContact: (contact) => contact,
  }, {
    checkPhoneNumber: async (phoneNumber) => ({ phoneNumber, registered: false }),
  });

  const response = await fetch(`${baseUrl}/api/contacts`, {
    method: "POST",
    headers: { "x-api-key": CONFIG.WEB_API_KEY, "content-type": "application/json" },
    body: JSON.stringify({ name: "Tidak Ada WA", phoneNumber: "6281234567890" }),
  });
  const payload = await response.json();

  assert.equal(response.status, 422);
  assert.match(payload.error, /tidak terdaftar di WhatsApp/);
  assert.equal(addContactCalls, 0);
});

test("API menyimpan pelanggan setelah nomor dipastikan terdaftar di WhatsApp", async () => {
  CONFIG.WEB_API_KEY = "test-api-key";
  let validatedPhone = null;
  let savedPayload = null;
  const baseUrl = await startServer({
    addContact: async (payload) => {
      savedPayload = payload;
      return { id: "contact-1", ...payload };
    },
    toPublicContact: (contact) => contact,
  }, {
    checkPhoneNumber: async (phoneNumber) => {
      validatedPhone = phoneNumber;
      return { phoneNumber, registered: true };
    },
  });

  const response = await fetch(`${baseUrl}/api/contacts`, {
    method: "POST",
    headers: { "x-api-key": CONFIG.WEB_API_KEY, "content-type": "application/json" },
    body: JSON.stringify({ name: "Ada WA", phoneNumber: "6281234567890" }),
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(validatedPhone, "6281234567890");
  assert.equal(savedPayload.phoneNumber, "6281234567890");
  assert.equal(payload.data.id, "contact-1");
});

test("registrasi hotspot menyimpan PENDING sebelum membuat akun MikroTik", async () => {
  CONFIG.WEB_API_KEY = "test-api-key";
  const events = [];
  const contact = {
    id: "contact-hotspot-1",
    name: "Pelanggan Hotspot",
    phoneNumber: "6281234567890",
    mikrotikUsername: "pelanggan_hotspot",
    mikrotikProfile: "100M",
    mikrotikPassword: "67890",
    hotspotSendCredentials: false,
  };
  const baseUrl = await startServer({
    prepareHotspotRegistration: async () => {
      events.push("db:pending");
      contact.hotspotProvisioningStatus = "PENDING";
      return { contact };
    },
    getContact: () => contact,
    updateHotspotProvisioningStatus: async (_id, status) => {
      events.push(`db:${status.toLowerCase()}`);
      contact.hotspotProvisioningStatus = status;
      return { contact, pelanggan: { username: contact.mikrotikUsername } };
    },
    toPublicContact: (value) => value,
  }, {}, {
    createHotspotCustomer: async () => {
      events.push("mikrotik:create");
      return {
        username: contact.mikrotikUsername,
        password: contact.mikrotikPassword,
        profile: contact.mikrotikProfile,
        name: contact.name,
        phoneNumber: contact.phoneNumber,
        created: true,
      };
    },
    verifyHotspotCustomer: async (registered) => {
      events.push("mikrotik:verify");
      return { username: registered.username };
    },
  });

  const response = await fetch(`${baseUrl}/api/mikrotik/customers`, {
    method: "POST",
    headers: { "x-api-key": CONFIG.WEB_API_KEY, "content-type": "application/json" },
    body: JSON.stringify({
      name: contact.name,
      phoneNumber: contact.phoneNumber,
      profile: contact.mikrotikProfile,
    }),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(events, [
    "db:pending",
    "db:provisioning",
    "mikrotik:create",
    "mikrotik:verify",
    "db:active",
  ]);
});

test("kegagalan provisioning mempertahankan pelanggan sebagai FAILED", async () => {
  CONFIG.WEB_API_KEY = "test-api-key";
  const statuses = [];
  const contact = {
    id: "contact-hotspot-failed",
    name: "Pelanggan Gagal",
    phoneNumber: "6281234567891",
    mikrotikUsername: "pelanggan_gagal",
    mikrotikProfile: "100M",
    mikrotikPassword: "67891",
  };
  const baseUrl = await startServer({
    prepareHotspotRegistration: async () => ({ contact }),
    getContact: () => contact,
    updateHotspotProvisioningStatus: async (_id, status, options) => {
      statuses.push({ status, error: options.error });
      contact.hotspotProvisioningStatus = status;
      contact.hotspotProvisioningError = options.error || "";
      return { contact, pelanggan: { username: contact.mikrotikUsername } };
    },
    toPublicContact: (value) => value,
  }, {}, {
    createHotspotCustomer: async () => {
      throw new Error("router tidak terjangkau");
    },
  });

  const response = await fetch(`${baseUrl}/api/mikrotik/customers`, {
    method: "POST",
    headers: { "x-api-key": CONFIG.WEB_API_KEY, "content-type": "application/json" },
    body: JSON.stringify({
      name: contact.name,
      phoneNumber: contact.phoneNumber,
      profile: contact.mikrotikProfile,
    }),
  });
  const payload = await response.json();

  assert.equal(response.status, 502);
  assert.match(payload.error, /Data pelanggan tersimpan/);
  assert.equal(contact.hotspotProvisioningStatus, "FAILED");
  assert.match(contact.hotspotProvisioningError, /router tidak terjangkau/);
  assert.deepEqual(statuses.map((item) => item.status), ["PROVISIONING", "FAILED"]);
});

test("endpoint retry provisioning memakai data pelanggan tersimpan secara idempotent", async () => {
  CONFIG.WEB_API_KEY = "test-api-key";
  const statuses = [];
  const contact = {
    id: "contact-hotspot-retry",
    name: "Pelanggan Retry",
    phoneNumber: "6281234567892",
    mikrotikUsername: "pelanggan_retry",
    mikrotikProfile: "100M",
    mikrotikPassword: "67892",
    hotspotProvisioningStatus: "FAILED",
    hotspotProvisioningOperation: "CREATE",
    hotspotSendCredentials: false,
  };
  const baseUrl = await startServer({
    getContact: () => contact,
    updateHotspotProvisioningStatus: async (_id, status) => {
      statuses.push(status);
      contact.hotspotProvisioningStatus = status;
      return { contact, pelanggan: { username: contact.mikrotikUsername } };
    },
    toPublicContact: (value) => value,
  }, {}, {
    createHotspotCustomer: async (payload) => ({ ...payload, created: false }),
    verifyHotspotCustomer: async (registered) => ({ username: registered.username }),
  });

  const response = await fetch(`${baseUrl}/api/contacts/${contact.id}/hotspot/provision`, {
    method: "POST",
    headers: { "x-api-key": CONFIG.WEB_API_KEY, "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.data.created, false);
  assert.equal(payload.data.contact.hotspotProvisioningStatus, "ACTIVE");
  assert.deepEqual(statuses, ["PROVISIONING", "ACTIVE"]);
});

test("edit hotspot menyimpan PENDING sebelum memperbarui akun MikroTik lama", async () => {
  CONFIG.WEB_API_KEY = "test-api-key";
  const events = [];
  const contact = {
    id: "contact-hotspot-edit",
    name: "Pelanggan Edit",
    phoneNumber: "6281234567893",
    mikrotikUsername: "pelanggan_baru",
    mikrotikProfile: "100M",
    mikrotikPassword: "67893",
    hotspotProvisioningStatus: "PENDING",
    hotspotProvisioningOperation: "UPDATE",
    hotspotProvisioningPrevious: {
      username: "pelanggan_lama",
      phoneNumber: "6281234567892",
      profile: "50M",
      password: "67892",
    },
  };
  const baseUrl = await startServer({
    getContact: () => contact,
    prepareContactUpdate: async () => {
      events.push("db:pending-update");
      return { contact, hotspotSyncRequired: true };
    },
    updateHotspotProvisioningStatus: async (_id, status) => {
      events.push(`db:${status.toLowerCase()}`);
      contact.hotspotProvisioningStatus = status;
      if (status === "ACTIVE") {
        contact.hotspotProvisioningOperation = "NONE";
        contact.hotspotProvisioningPrevious = null;
      }
      return { contact, pelanggan: { username: contact.mikrotikUsername } };
    },
    toPublicContact: (value) => value,
  }, {}, {
    updateHotspotCustomer: async (payload) => {
      events.push(`mikrotik:update:${payload.previousUsername}`);
      return {
        username: payload.username,
        password: payload.password,
        profile: payload.profile,
        name: payload.name,
        phoneNumber: payload.phoneNumber,
        updated: true,
      };
    },
    verifyHotspotCustomer: async (registered) => {
      events.push("mikrotik:verify");
      return { username: registered.username };
    },
  });

  const response = await fetch(`${baseUrl}/api/contacts/${contact.id}`, {
    method: "PUT",
    headers: { "x-api-key": CONFIG.WEB_API_KEY, "content-type": "application/json" },
    body: JSON.stringify({
      name: contact.name,
      phoneNumber: contact.phoneNumber,
      mikrotikUsername: contact.mikrotikUsername,
      mikrotikProfile: contact.mikrotikProfile,
    }),
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.data.hotspotSynced, true);
  assert.deepEqual(events, [
    "db:pending-update",
    "db:provisioning",
    "mikrotik:update:pelanggan_lama",
    "mikrotik:verify",
    "db:active",
  ]);
});

test("retry edit hotspot tetap memakai snapshot username lama", async () => {
  CONFIG.WEB_API_KEY = "test-api-key";
  const statuses = [];
  let previousUsername = null;
  const contact = {
    id: "contact-hotspot-edit-retry",
    name: "Pelanggan Edit Retry",
    phoneNumber: "6281234567894",
    mikrotikUsername: "username_baru",
    mikrotikProfile: "100M",
    mikrotikPassword: "67894",
    hotspotProvisioningStatus: "FAILED",
    hotspotProvisioningOperation: "UPDATE",
    hotspotProvisioningPrevious: {
      username: "username_lama",
      phoneNumber: "6281234567893",
      profile: "50M",
      password: "67893",
    },
  };
  const baseUrl = await startServer({
    getContact: () => contact,
    updateHotspotProvisioningStatus: async (_id, status) => {
      statuses.push(status);
      contact.hotspotProvisioningStatus = status;
      return { contact, pelanggan: { username: contact.mikrotikUsername } };
    },
    toPublicContact: (value) => value,
  }, {}, {
    updateHotspotCustomer: async (payload) => {
      previousUsername = payload.previousUsername;
      return { ...payload, updated: false };
    },
    verifyHotspotCustomer: async (registered) => ({ username: registered.username }),
  });

  const response = await fetch(`${baseUrl}/api/contacts/${contact.id}/hotspot/provision`, {
    method: "POST",
    headers: { "x-api-key": CONFIG.WEB_API_KEY, "content-type": "application/json" },
    body: JSON.stringify({}),
  });

  assert.equal(response.status, 200);
  assert.equal(previousUsername, "username_lama");
  assert.deepEqual(statuses, ["PROVISIONING", "ACTIVE"]);
});

test("retry lifecycle reaktivasi diteruskan ke scheduler, bukan provisioning create", async () => {
  CONFIG.WEB_API_KEY = "test-api-key";
  let schedulerCalls = 0;
  let createCalls = 0;
  const contact = {
    id: "contact-reactivation-retry",
    name: "Pelanggan Reaktivasi",
    phoneNumber: "6281234567899",
    mikrotikUsername: "pelanggan_reaktivasi",
    mikrotikProfile: "100M",
    hotspotProvisioningStatus: "FAILED",
    hotspotProvisioningOperation: "REACTIVATE",
  };
  const baseUrl = await startServer({
    getContact: () => contact,
    hydrateContact: (value) => value,
    toPublicContact: (value) => value,
  }, {}, {
    createHotspotCustomer: async () => {
      createCalls += 1;
    },
  }, {
    reactivateContact: async () => {
      schedulerCalls += 1;
      contact.hotspotProvisioningStatus = "ACTIVE";
      contact.hotspotProvisioningOperation = "NONE";
      return {
        operation: "REACTIVATE",
        username: contact.mikrotikUsername,
        password: "secret",
        contact,
        notification: { sent: false },
      };
    },
  });

  const response = await fetch(`${baseUrl}/api/contacts/${contact.id}/hotspot/provision`, {
    method: "POST",
    headers: { "x-api-key": CONFIG.WEB_API_KEY, "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.data.operation, "REACTIVATE");
  assert.equal(payload.data.password, undefined);
  assert.equal(schedulerCalls, 1);
  assert.equal(createCalls, 0);
});

test("endpoint pengingat tagihan mengirim untuk pelanggan belum bayar yang memiliki tunggakan", async () => {
  CONFIG.WEB_API_KEY = "test-api-key";
  let sentContact = null;
  const contact = {
    id: "contact-billing-reminder",
    name: "Pelanggan Tunggakan",
    phoneNumber: "6281234567890",
    paymentStatus: "UNPAID",
    currentPaymentStatus: "UNPAID",
    hasDebt: true,
    debtCount: 2,
  };
  const baseUrl = await startServer({
    getContact: () => contact,
    hydrateContact: (value) => value,
    toPublicContact: (value) => value,
  }, {
    sendBillingDebtReminder: async (value) => {
      sentContact = value;
      return {
        phoneNumber: value.phoneNumber,
        debtCount: value.debtCount,
        totalAmount: 300000,
        provider: "baileys",
      };
    },
  });

  const response = await fetch(`${baseUrl}/api/contacts/${contact.id}/billing-reminder`, {
    method: "POST",
    headers: { "x-api-key": CONFIG.WEB_API_KEY, "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(sentContact.id, contact.id);
  assert.equal(payload.data.phoneNumber, contact.phoneNumber);
  assert.equal(payload.data.totalAmount, 300000);
});

test("endpoint pengingat tagihan mengirim tagihan jatuh tempo meski belum memiliki tunggakan bulan lalu", async () => {
  CONFIG.WEB_API_KEY = "test-api-key";
  let sentContact = null;
  const contact = {
    id: "overdue-current-billing",
    name: "Pelanggan Jatuh Tempo",
    phoneNumber: "6281234567890",
    paymentStatus: "UNPAID",
    currentPaymentStatus: "UNPAID",
    dueStatus: "OVERDUE",
    hasDebt: false,
    debtCount: 0,
  };
  const baseUrl = await startServer({
    getContact: () => contact,
    hydrateContact: (value) => value,
    toPublicContact: (value) => value,
  }, {
    sendBillingDebtReminder: async (value) => {
      sentContact = value;
      return { phoneNumber: value.phoneNumber, debtCount: 0, totalAmount: 100000, provider: "baileys" };
    },
  });

  const response = await fetch(`${baseUrl}/api/contacts/${contact.id}/billing-reminder`, {
    method: "POST",
    headers: { "x-api-key": CONFIG.WEB_API_KEY, "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(sentContact.id, contact.id);
  assert.equal(payload.data.totalAmount, 100000);
});

test("endpoint pengingat tagihan menolak pelanggan lunas atau tagihan yang belum jatuh tempo tanpa tunggakan", async () => {
  CONFIG.WEB_API_KEY = "test-api-key";
  const cases = [
    {
      contact: { id: "paid", paymentStatus: "PAID", currentPaymentStatus: "PAID", hasDebt: true, debtCount: 1 },
      error: /belum membayar bulan berjalan/,
    },
    {
      contact: { id: "no-debt", paymentStatus: "UNPAID", currentPaymentStatus: "UNPAID", dueStatus: "UPCOMING", hasDebt: false, debtCount: 0 },
      error: /jatuh tempo atau memiliki tunggakan/,
    },
  ];

  for (const item of cases) {
    const baseUrl = await startServer({
      getContact: () => item.contact,
      hydrateContact: (value) => value,
    });
    const response = await fetch(`${baseUrl}/api/contacts/${item.contact.id}/billing-reminder`, {
      method: "POST",
      headers: { "x-api-key": CONFIG.WEB_API_KEY, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const payload = await response.json();

    assert.equal(response.status, 400);
    assert.match(payload.error, item.error);
  }
});
