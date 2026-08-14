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

async function startServer(dataManager = {}, notificationBot = {}, mikrotikService = {}) {
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
