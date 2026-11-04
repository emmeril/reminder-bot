const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function createDashboardApp(globals = {}) {
  const source = fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8");
  const dashboardApp = vm.runInNewContext(`${source}\n;dashboardApp`, {
    window: { matchMedia: () => ({ matches: false }) },
    ...globals,
  });
  return dashboardApp();
}

test("formatter input tanggal membiarkan jadwal kosong tetap kosong", () => {
  const app = createDashboardApp();

  assert.equal(app.formatDateInput(null), "");
  assert.equal(app.formatDateInput(undefined), "");
  assert.equal(app.formatDateInput(""), "");
  assert.equal(app.formatTimeInput(null), "");
});

test("jadwal layanan membedakan aktif otomatis, penonaktifan, dan tanpa jadwal", () => {
  const app = createDashboardApp();

  assert.equal(app.getReactivationLabel({
    hotspotReactivationEnabled: true,
    hotspotReactivationAt: "2026-10-20T01:00:00.000Z",
  }), "Aktif otomatis");
  assert.equal(app.getReactivationLabel({
    hotspotReactivationEnabled: false,
    hotspotReactivationAt: "2026-10-20T01:00:00.000Z",
  }), "Penonaktifan terjadwal");
  assert.equal(app.getReactivationLabel({
    hotspotReactivationEnabled: false,
    hotspotReactivationAt: null,
  }), "Tanpa jadwal");
});

test("aksi aktifkan sekarang hanya tersedia untuk akun yang nonaktif terjadwal", () => {
  const app = createDashboardApp();

  assert.equal(app.canReactivateHotspot({ hotspotProvisioningStatus: "DEACTIVATED" }), true);
  assert.equal(app.canReactivateHotspot({ hotspotProvisioningStatus: "ACTIVE" }), false);
  assert.equal(app.canReactivateHotspot({ hotspotProvisioningStatus: "DISABLED" }), false);
});

test("form jadwal memakai tanggal dan waktu dari modal khusus", () => {
  const app = createDashboardApp();

  assert.equal(app.buildHotspotReactivationAt({ date: "2026-10-20", time: "08:30" }), "2026-10-20 08:30");
  app.forms.hotspotSchedule = { mode: "NONE", date: "", time: "00:00" };
  assert.equal(app.getHotspotScheduleSummary(), "Tidak ada perubahan otomatis pada akun hotspot.");
});

test("simpan jadwal mengirim pilihan modal dan menutup form setelah berhasil", async () => {
  const app = createDashboardApp();
  let request = null;
  let notification = "";
  let closed = false;
  app.hotspotScheduleModal = {
    open: true,
    loading: false,
    contact: {
      id: "contact-schedule",
      mikrotikUsername: "pelanggan_jadwal",
      mikrotikProfile: "50M",
    },
  };
  app.forms.hotspotSchedule = {
    contactId: "contact-schedule",
    mode: "DEACTIVATE",
    date: "2026-10-20",
    time: "08:30",
  };
  app.withProcessing = async (_message, action) => action();
  app.clearFormError = () => {};
  app.setFormError = (_key, error) => { throw error; };
  app.api = async (url, options) => {
    request = { url, payload: JSON.parse(options.body) };
    return {};
  };
  app.closeHotspotScheduleModal = () => { closed = true; };
  app.notify = (message) => { notification = message; };
  app.loadContacts = async () => {};
  app.loadStatus = async () => {};
  app.loadLogs = async () => {};

  await app.saveHotspotSchedule();

  assert.equal(request.url, "/api/contacts/contact-schedule/hotspot");
  assert.equal(request.payload.hotspotReactivationEnabled, false);
  assert.equal(request.payload.hotspotReactivationAt, "2026-10-20 08:30");
  assert.equal(closed, true);
  assert.equal(notification, "Jadwal penonaktifan berhasil disimpan.");
});

test("aksi tagihan memakai satu tombol dan menampilkan pilihan di modal", () => {
  const html = fs.readFileSync(path.join(__dirname, "../public/index.html"), "utf8");
  const styles = fs.readFileSync(path.join(__dirname, "../public/styles.css"), "utf8");

  assert.match(html, /billing-action-trigger[^>]*>[\s\S]*?hasBillingActions\(contact\) \? 'Kelola' : 'Tidak tersedia'/);
  assert.match(html, /class="billing-action-dialog w-full max-w-md/);
  assert.match(html, /id="billing-action-dialog"[\s\S]*?role="dialog"[\s\S]*?aria-modal="true"/);
  assert.match(html, /@keydown\.escape\.window="closeBillingActionModal\(\)"/);
  assert.match(html, /@keydown\.tab="trapModalFocus\(\$event, 'billing-action-dialog'\)"/);
  assert.match(html, /billing-action-section-heading[\s\S]*?Pilih tindakan/);
  const currentBillingButton = html.match(/billing-action-primary-row">[\s\S]*?(<button[\s\S]*?<\/button>)/)?.[1] || "";
  assert.doesNotMatch(currentBillingButton, /x-show=/);
  assert.match(currentBillingButton, /:disabled="!canPayCurrentBilling\(billingActionModal\.contact\)"/);
  assert.match(currentBillingButton, /getCurrentBillingActionLabel\(billingActionModal\.contact\)/);
  assert.match(html, /billing-action-primary-row[\s\S]*?aria-label="Kirim pengingat WhatsApp"[\s\S]*?>Kirim WhatsApp</);
  assert.match(html, /billing-action-quick-row[\s\S]*?:aria-label="getFullPaymentActionLabel\(billingActionModal\.contact\)"[\s\S]*?getFullPaymentActionLabel\(billingActionModal\.contact\)/);
  assert.match(html, /Tandai belum bayar/);
  assert.match(html, /getArrearsPaymentLabel\(billingActionModal\.contact\)/);
  assert.match(html, /getArrearsPaymentSubmitLabel\(billingActionModal\.contact\)/);
  assert.doesNotMatch(html, /<details[^>]*customer-payment-menu/);
  assert.match(styles, /\.billing-action-option \{[^}]*width: fit-content;[^}]*justify-self: end;[^}]*border-radius: 999px;/);
  assert.match(styles, /\.billing-action-submit \{[^}]*width: fit-content;[^}]*justify-self: end;[^}]*border-radius: 999px;/);
  assert.match(styles, /\.billing-action-option:hover > i \{ color: #fff; \}/);
  assert.match(styles, /\.billing-action-option:disabled, \.billing-action-option:disabled:hover \{[^}]*cursor: not-allowed;/);
  assert.match(styles, /\.billing-action-submit > i, \.billing-action-submit:hover > i \{ color: #fff; \}/);
  assert.match(styles, /\.billing-action-option-reminder \{[^}]*background: #15803d;/);
  assert.match(styles, /\.billing-action-quick-row \{[^}]*justify-content: flex-end;/);
});

test("tombol pengingat disembunyikan setelah tunggakan mencapai dua bulan", () => {
  const app = createDashboardApp();

  assert.equal(app.canSendBillingReminder({ hasDebt: true, debtCount: 1 }), true);
  assert.equal(app.canSendBillingReminder({ hasDebt: true, debtCount: 2 }), false);
  assert.equal(app.canSendBillingReminder({ hasDebt: true, debtCount: 3 }), false);
});

test("fallback tunggakan tetap membaca periode lama yang dikoreksi belum lunas", () => {
  const app = createDashboardApp();
  app.billingPeriod = "2026-11";
  const periods = app.getDebtPeriods({
    createdAt: "2026-10-01T00:00:00.000Z",
    paymentType: "FULL-PAID",
    paymentMonths: {
      "2026-10": { status: "UNPAID", paidAmount: 0 },
      "2026-11": { status: "PAID", paidAmount: 100_000 },
    },
  });

  assert.deepEqual(Array.from(periods, (period) => period.key), ["2026-10"]);
});

test("aksi beli masa aktif tersedia untuk akun menunggak dan memanggil endpoint khusus", async () => {
  const html = fs.readFileSync(path.join(__dirname, "../public/index.html"), "utf8");
  const styles = fs.readFileSync(path.join(__dirname, "../public/styles.css"), "utf8");
  const app = createDashboardApp();
  const contact = {
    id: "contact-active-period-ui",
    subscriptionType: "RECURRING",
    monthlyPaymentAmount: 100000,
    hasDebt: true,
    billingPausedForArrears: false,
    hotspotProvisioningStatus: "DISABLED",
    mikrotikUsername: "pelanggan_masa_aktif",
    mikrotikProfile: "50M",
  };

  assert.match(html, /@click="purchaseActivePeriod\(billingActionModal\.contact\)"/);
  assert.match(html, /getActivePeriodPurchaseLabel\(billingActionModal\.contact\)/);
  assert.match(styles, /\.billing-action-active-period \.billing-action-option \{ width: 100%; \}/);
  assert.equal(app.canPurchaseActivePeriod(contact), true);
  assert.equal(app.canPurchaseActivePeriod({ ...contact, hasDebt: false }), false);
  assert.equal(app.canEnableHotspot(contact), false);

  let confirmation = null;
  let request = null;
  let notification = "";
  let refreshCount = 0;
  app.closeBillingActionModal = () => {};
  app.openDeleteConfirm = (options) => { confirmation = options; };
  app.api = async (url, options) => {
    request = { url, method: options.method, payload: JSON.parse(options.body) };
    return {
      purchase: { activeUntil: "2026-11-28T03:00:00.000Z" },
      notificationSent: true,
    };
  };
  app.notify = (message) => { notification = message; };
  app.loadContacts = async () => { refreshCount += 1; };
  app.loadStatus = async () => { refreshCount += 1; };
  app.loadLogs = async () => { refreshCount += 1; };

  app.purchaseActivePeriod(contact);
  assert.equal(confirmation.title, "Beli masa aktif satu bulan?");
  assert.match(confirmation.description, /Tunggakan tetap tersimpan/);
  assert.equal(confirmation.processingMessage, "Mencatat pembelian masa aktif...");

  await confirmation.action();

  assert.deepEqual(request, {
    url: "/api/contacts/contact-active-period-ui/active-period-purchase",
    method: "POST",
    payload: {},
  });
  assert.match(notification, /Masa aktif tercatat sampai/);
  assert.match(notification, /Bukti pembayaran terkirim/);
  assert.equal(refreshCount, 3);
});

test("pengaturan menyediakan template reminder berakhirnya masa aktif", () => {
  const html = fs.readFileSync(path.join(__dirname, "../public/index.html"), "utf8");
  const app = createDashboardApp();

  assert.match(html, /Masa aktif akan berakhir/);
  assert.match(html, /x-model="forms\.settings\.activePeriodReminderMessageTemplate"/);
  assert.match(html, /<code>{{activeUntil}}<\/code>/);
  assert.equal(app.forms.settings.activePeriodReminderMessageTemplate, "");
});

test("pengaturan menyediakan template pengingat masa tenggang", () => {
  const html = fs.readFileSync(path.join(__dirname, "../public/index.html"), "utf8");
  const app = createDashboardApp();

  assert.match(html, /Pengingat masa tenggang/);
  assert.match(html, /x-model="forms\.settings\.gracePeriodReminderMessageTemplate"/);
  assert.match(html, /<code>{{isolationDate}}<\/code>/);
  assert.equal(app.forms.settings.gracePeriodReminderMessageTemplate, "");
});

test("simpan pengaturan mengirim template pengingat masa tenggang", async () => {
  const app = createDashboardApp();
  const template = "Halo {{name}}, masa tenggang berakhir {{isolationDate}}.";
  let request = null;
  let notification = "";
  let statusReloaded = false;
  app.forms.settings.gracePeriodReminderMessageTemplate = template;
  app.clearFormError = () => {};
  app.setFormError = (_key, error) => { throw error; };
  app.withProcessing = async (_message, action) => action();
  app.api = async (url, options) => {
    request = { url, method: options.method, payload: JSON.parse(options.body) };
    return {};
  };
  app.notify = (message) => { notification = message; };
  app.loadStatus = async () => { statusReloaded = true; };

  await app.saveSettings();

  assert.equal(request.url, "/api/settings");
  assert.equal(request.method, "PUT");
  assert.equal(request.payload.gracePeriodReminderMessageTemplate, template);
  assert.equal(notification, "Settings diperbarui.");
  assert.equal(statusReloaded, true);
});

test("pengaturan menyediakan template akun WiFi setelah pembayaran", () => {
  const html = fs.readFileSync(path.join(__dirname, "../public/index.html"), "utf8");
  const app = createDashboardApp();

  assert.match(html, /Akun WiFi setelah pembayaran/);
  assert.match(html, /x-model="forms\.settings\.paymentHotspotAccountMessageTemplate"/);
  assert.match(html, /<code>{{hotspotStatus}}<\/code>/);
  assert.match(html, /<code>{{hotspotAccountDetails}}<\/code>/);
  assert.equal(app.forms.settings.paymentHotspotAccountMessageTemplate, "");
});

test("tombol tagihan bulan ini tetap tampil dengan status tindakan yang sesuai", () => {
  const app = createDashboardApp();
  app.billingPeriod = "2026-11";

  assert.equal(app.canPayCurrentBilling({ subscriptionActive: true, currentPaymentStatus: "UNPAID" }), true);
  assert.equal(app.getCurrentBillingActionLabel({ subscriptionActive: true, currentPaymentStatus: "UNPAID", monthlyPaymentAmount: 75000 }), "Bayar November 2026 · Rp\u00a075.000");
  assert.equal(app.canPayCurrentBilling({ subscriptionActive: true, currentPaymentStatus: "PAID" }), false);
  assert.equal(app.getCurrentBillingActionLabel({ subscriptionActive: true, currentPaymentStatus: "PAID" }), "November 2026 sudah lunas");
  assert.equal(app.canPayCurrentBilling({ subscriptionActive: false, currentPaymentStatus: "PAID" }), false);
  assert.equal(app.getCurrentBillingActionLabel({ subscriptionActive: false, currentPaymentStatus: "PAID" }), "Tidak ada tagihan November 2026");
});

test("mode pascabayar memakai periode tagihan dari server dan tersedia di form pelanggan", () => {
  const app = createDashboardApp();
  const html = fs.readFileSync(path.join(__dirname, "../public/index.html"), "utf8");
  const contact = {
    subscriptionType: "RECURRING",
    billingCycle: "POSTPAID",
    billingPeriodLabel: "Oktober 2026",
    subscriptionActive: true,
    currentPaymentStatus: "UNPAID",
    monthlyPaymentAmount: 100_000,
  };

  assert.equal(app.getSubscriptionTypeLabel(contact), "Bulanan pascabayar");
  assert.equal(app.getCurrentBillingActionLabel(contact), "Bayar Oktober 2026 · Rp\u00a0100.000");
  assert.equal(app.blankContactForm().billingCycle, "PREPAID");
  assert.match(html, /x-model="forms\.contact\.billingCycle"/);
  assert.match(html, /x-model="forms\.contactEdit\.billingCycle"/);
  assert.match(html, /Pascabayar, bayar bulan sebelumnya/);
});

test("aksi tagihan menyebut periode dan nominal agar pilihan pembayaran tidak tertukar", () => {
  const app = createDashboardApp();
  const html = fs.readFileSync(path.join(__dirname, "../public/index.html"), "utf8");
  const styles = fs.readFileSync(path.join(__dirname, "../public/styles.css"), "utf8");
  app.billingPeriod = "2026-11";
  const contact = {
    subscriptionActive: true,
    currentPaymentStatus: "UNPAID",
    monthlyPaymentAmount: 75000,
    debtAmount: 75000,
    debtPeriods: [{ key: "2026-10", label: "Oktober 2026", remainingAmount: 75000 }],
  };

  assert.equal(app.getCurrentBillingActionLabel(contact), "Bayar November 2026 · Rp\u00a075.000");
  assert.equal(app.getArrearsPaymentLabel(contact), "Bayar tunggakan Oktober 2026");
  assert.equal(app.getArrearsPaymentHelp(contact), "Sisa Oktober 2026 Rp\u00a075.000.");
  assert.equal(app.getArrearsPaymentSubmitLabel(contact), "Catat ke Oktober 2026");
  assert.equal(app.getFullPaymentActionLabel(contact), "Lunasi semua · Rp\u00a0150.000");
  assert.match(html, /x-text="getArrearsPaymentLabel\(billingActionModal\.contact\)"/);
  assert.match(html, /x-text="getFullPaymentActionLabel\(billingActionModal\.contact\)"/);
  assert.match(styles, /\.billing-action-option \{[^}]*white-space: normal;/);
  assert.match(styles, /\.billing-action-submit \{[^}]*white-space: normal;/);
});

test("pengaturan memiliki tab masa tenggang isolir", () => {
  const app = createDashboardApp();
  const html = fs.readFileSync(path.join(__dirname, "../public/index.html"), "utf8");

  app.selectSettingsTab("isolation");
  assert.equal(app.activeSettingsTab, "isolation");
  assert.match(html, /id="settings-isolation-tab"/);
  assert.match(html, /x-model\.number="forms\.settings\.hotspotIsolationGraceDays"/);
  assert.match(html, /Jeda setelah jatuh tempo \(hari\)/);
});

test("form template reminder menampilkan variabel masa tenggang dan tanggal isolir", () => {
  const html = fs.readFileSync(path.join(__dirname, "../public/index.html"), "utf8");

  assert.match(html, /\{\{graceDays\}\}/);
  assert.match(html, /\{\{isolationDate\}\}/);
  assert.match(html, /\{\{renewalStatusInfo\}\}/);
});

test("status jatuh tempo membedakan jadwal yang perlu dibuat dan sekali berlangganan", () => {
  const app = createDashboardApp();
  const html = fs.readFileSync(path.join(__dirname, "../public/index.html"), "utf8");

  assert.equal(app.getDueStatusLabel("NOT_SCHEDULED"), "Perlu Dijadwalkan");
  assert.equal(app.getDueStatusLabel("NOT_APPLICABLE"), "Tidak Dijadwalkan");
  assert.equal(app.getDueDateLabel({ dueStatus: "NOT_SCHEDULED" }), "Jadwal belum tersedia");
  assert.equal(
    app.getDueDateLabel({ dueStatus: "NOT_APPLICABLE" }),
    "Tidak ada perpanjangan otomatis"
  );
  assert.match(html, /<option value="NOT_SCHEDULED">Belum ada jadwal<\/option>/);
  assert.match(html, /<option value="NOT_APPLICABLE">Tanpa jadwal bulanan<\/option>/);
  assert.match(html, /x-text="getDueDateLabel\(contact\)"/);
});

test("monitor jaringan menggabungkan AP dengan pelanggan terkait", () => {
  const app = createDashboardApp();
  app.contacts = [
    { id: "one", name: "Satu", linkedApHost: "ap-a.local" },
    { id: "two", name: "Dua", linkedApHost: "" },
  ];
  app.apMonitors = [
    {
      id: "*1",
      host: "ap-a.local",
      status: "UP",
      availableInNetwatch: true,
      linkStatus: "LINKED",
      customerCount: 1,
      linkedContacts: [{ id: "one", name: "Satu", phoneNumber: "628111111111" }],
    },
    {
      id: "*2",
      host: "ap-b.local",
      status: "DOWN",
      availableInNetwatch: true,
      linkStatus: "UNLINKED",
      customerCount: 0,
      linkedContacts: [],
    },
    {
      id: "missing-reference",
      host: "ap-lama.local",
      status: "UP",
      availableInNetwatch: false,
      linkStatus: "UNLINKED",
      customerCount: 0,
      linkedContacts: [],
    },
  ];

  assert.deepEqual(JSON.parse(JSON.stringify(app.networkMonitorSummary)), {
    netwatch: 2,
    up: 1,
    down: 1,
    unlinkedMonitors: 1,
    linkedCustomers: 1,
    unlinkedCustomers: 1,
    missingReferences: 0,
  });
  assert.equal(app.getApCustomerSummary(app.apMonitors[0]), "Satu");
  app.filters.monitorAp.linkStatus = "LINKED";
  assert.deepEqual(app.filteredApMonitors.map(({ host }) => host), ["ap-a.local"]);

  app.selectMenu = (key) => { app.activeMenu = key; };
  app.showApCustomers(app.apMonitors[0]);
  assert.equal(app.activeMenu, "contacts");
  assert.equal(app.activeContactTab, "data");
  assert.equal(app.filters.contacts.search, "ap-a.local");
});

test("tampilan monitor jaringan menyediakan ringkasan dan filter sinkronisasi", () => {
  const html = fs.readFileSync(path.join(__dirname, "../public/index.html"), "utf8");

  assert.match(html, /Ringkasan status jaringan/);
  assert.match(html, /x-text="networkMonitorSummary\.up"/);
  assert.match(html, /x-text="networkMonitorSummary\.down"/);
  assert.match(html, />AP UP<\/span>/);
  assert.match(html, />AP DOWN<\/span>/);
  assert.match(html, /AP tanpa pelanggan/);
  assert.match(html, /x-model="filters\.monitorAp\.linkStatus"/);
  assert.match(html, /getApCustomerSummary\(ap\)/);
  assert.match(html, /Tabel status AP dan pelanggan terkait/);
  assert.match(html, /x-for="ap in selectableApMonitors"/);
});

test("ringkasan menempatkan status di kiri dan kondisi utama di kanan", () => {
  const app = createDashboardApp({
    window: { matchMedia: () => ({ matches: false }), scrollTo: () => {} },
  });
  const html = fs.readFileSync(path.join(__dirname, "../public/index.html"), "utf8");
  const styles = fs.readFileSync(path.join(__dirname, "../public/styles.css"), "utf8");
  const script = fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8");

  assert.ok(html.indexOf("status-panel") < html.indexOf("overview-summary-region"));
  assert.match(html, /Kondisi hari ini/);
  assert.match(html, /x-text="currentDateLabel"/);
  assert.match(html, /@click="selectMenu\(metric\.menu\)"/);
  assert.match(html, /:aria-label="'Buka ' \+ metric\.label"/);
  assert.doesNotMatch(html, /metric\.label\.includes\('bayar'\)/);
  assert.match(styles, /\.page-grid\.overview-workspace \{ grid-template-columns: minmax\(300px, 1fr\) minmax\(0, 2fr\);/);
  assert.match(styles, /\.overview-workspace > \.status-panel,[\s\S]*?\.overview-workspace > \.quick-panel \{[^}]*width: 100%;[^}]*height: 100%;/);
  assert.match(styles, /@media \(max-width: 767px\)[\s\S]*?\.page-grid\.overview-workspace \{ grid-template-columns: minmax\(0, 1fr\);/);
  assert.match(script, /label: "Penerima admin"[^\n]*menu: "notifications"/);
  assert.match(script, /label: "AP bermasalah"[^\n]*menu: "monitor-ap"/);

  app.selectMenu("payment-amount");
  assert.equal(app.activeMenu, "contacts");
  assert.equal(app.activeContactTab, "billing");
});

test("pembayaran tunggakan mengirim nominal custom admin", async () => {
  const app = createDashboardApp();
  const contact = {
    id: "contact-partial-payment",
    debtAmount: 200_000,
    paymentStatus: "UNPAID",
    currentPaymentStatus: "UNPAID",
  };
  let request = null;
  let notification = "";
  let modalClosed = false;
  app.contacts = [contact];
  app.arrearsPaymentAmounts = { [contact.id]: 100_000 };
  app.withProcessing = async (_message, action) => action();
  app.api = async (url, options) => {
    request = { url, payload: JSON.parse(options.body) };
    return {
      paymentAmount: 100_000,
      remainingDebtAmount: 100_000,
      notificationSent: false,
    };
  };
  app.notify = (message) => { notification = message; };
  app.loadContacts = async () => {};
  app.loadReminders = async () => {};
  app.loadStatus = async () => {};
  app.closeBillingActionModal = () => { modalClosed = true; };

  await app.payArrears(contact);

  assert.equal(request.url, "/api/contacts/contact-partial-payment/payment");
  assert.deepEqual(request.payload, {
    status: "UNPAID",
    paymentType: "ARREARS-ONLY",
    paymentAmount: 100_000,
  });
  assert.match(notification, /Pembayaran Rp\s?100\.000 dicatat/);
  assert.match(notification, /Sisa tunggakan Rp\s?100\.000/);
  assert.equal(modalClosed, true);
  assert.equal(app.arrearsPaymentAmounts[contact.id], undefined);
});

test("laporan pendapatan menghitung pembayaran lunas dan sebagian tanpa bulan jeda", () => {
  const app = createDashboardApp();
  app.revenuePeriod = "2026-10";
  app.contacts = [
    {
      id: "revenue-paid",
      name: "Pelanggan Lunas",
      phoneNumber: "628111111111",
      monthlyPaymentAmount: 100000,
      paymentMonths: {
        "2026-10": { status: "PAID", paidDate: "2026-10-10T03:00:00.000Z", paymentType: "CURRENT-ONLY" },
      },
    },
    {
      id: "revenue-partial",
      name: "Pelanggan Sebagian",
      phoneNumber: "628222222222",
      monthlyPaymentAmount: 100000,
      paymentMonths: {
        "2026-10": { status: "UNPAID", paidAmount: 40000, lastPaymentDate: "2026-10-11T03:00:00.000Z", paymentType: "ARREARS-ONLY" },
      },
    },
    {
      id: "revenue-recorded-amount",
      name: "Pelanggan Tarif Berubah",
      phoneNumber: "628333333333",
      monthlyPaymentAmount: 150000,
      paymentMonths: {
        "2026-10": { status: "PAID", paidAmount: 120000, paidDate: "2026-10-12T03:00:00.000Z", paymentType: "CURRENT-ONLY" },
      },
    },
    {
      id: "revenue-paused",
      name: "Periode Jeda",
      phoneNumber: "628444444444",
      monthlyPaymentAmount: 100000,
      paymentMonths: {
        "2026-10": { status: "PAID", paidAmount: 100000, billingPaused: true },
      },
    },
  ];

  assert.equal(app.revenueEntries.length, 3);
  assert.equal(app.revenueTotal, 260000);
  assert.equal(app.revenuePaidCount, 2);
  assert.equal(app.revenuePartialTotal, 40000);
  assert.equal(app.revenueAverage, 86667);
  assert.equal(app.revenueEntries.find((entry) => entry.contactId === "revenue-recorded-amount").amount, 120000);

  app.filters.revenue.status = "PARTIAL";
  assert.equal(app.filteredRevenueEntries.length, 1);
  assert.equal(app.filteredRevenueEntries[0].name, "Pelanggan Sebagian");
});

test("laporan pendapatan memasukkan pembelian masa aktif pada bulan transaksi", () => {
  const app = createDashboardApp();
  app.revenuePeriod = "2026-10";
  app.contacts = [{
    id: "revenue-active-period",
    name: "Pelanggan Masa Aktif",
    phoneNumber: "628555555555",
    paymentMonths: {},
    activePeriodPurchases: [{
      id: "ACT-REPORT-1",
      amount: 100000,
      purchasedAt: "2026-10-28T03:00:00.000Z",
      activeUntil: "2026-11-28T03:00:00.000Z",
    }],
  }];

  assert.equal(app.revenueEntries.length, 1);
  assert.equal(app.revenueEntries[0].id, "active-period-revenue-active-period-ACT-REPORT-1");
  assert.equal(app.revenueEntries[0].paymentType, "ACTIVE-PERIOD");
  assert.equal(app.revenueEntries[0].amount, 100000);
  assert.equal(app.revenueEntries[0].activeUntil, "2026-11-28T03:00:00.000Z");
  assert.equal(app.revenueTotal, 100000);
});

test("ekspor laporan pendapatan membuat CSV aman dari formula spreadsheet", async () => {
  let downloaded = false;
  let removed = false;
  let revokedUrl = "";
  let createdBlob = null;
  const link = {
    href: "",
    download: "",
    click() { downloaded = true; },
    remove() { removed = true; },
  };
  const app = createDashboardApp({
    Blob,
    URL: {
      createObjectURL(blob) {
        createdBlob = blob;
        return "blob:revenue-report";
      },
      revokeObjectURL(url) { revokedUrl = url; },
    },
    document: {
      createElement: () => link,
      body: { appendChild: () => {} },
    },
  });
  app.revenuePeriod = "2026-10";
  app.contacts = [{
    id: "revenue-export",
    name: "=Pelanggan Formula",
    phoneNumber: "628555555555",
    monthlyPaymentAmount: 100000,
    paymentMonths: {
      "2026-10": { status: "PAID", paidAmount: 100000, paidDate: "2026-10-13T03:00:00.000Z", paymentType: "CURRENT-ONLY" },
    },
  }];
  app.notify = () => {};

  app.exportRevenueReport();

  const csv = await createdBlob.text();
  assert.equal(downloaded, true);
  assert.equal(removed, true);
  assert.equal(revokedUrl, "blob:revenue-report");
  assert.equal(link.download, "laporan-pendapatan-2026-10.csv");
  assert.match(csv, /"'=Pelanggan Formula"/);
  assert.match(csv, /"100000"/);
});

test("laporan pendapatan voucher dimuat dan difilter terpisah dari pelanggan", async () => {
  const app = createDashboardApp();
  app.revenuePeriod = "2026-11";
  app.api = async (url, options) => {
    assert.equal(url, "/api/mikrotik/voucher-revenue?period=2026-11");
    assert.equal(options.timeoutMs, 45_000);
    assert.match(options.timeoutMessage, /MikroTik belum merespons laporan voucher/);
    return {
      period: "2026-11",
      summary: { revenue: 50000, costPrice: 30000, commission: 20000, quantity: 2, profiles: 2 },
      profileSummary: [
        { profile: "VCR-1D", quantity: 1, revenue: 40000 },
        { profile: "VCR-4H", quantity: 1, revenue: 10000 },
      ],
      entries: [
        { id: "*1", username: "voucher-satu", profile: "VCR-1D", amount: 40000, costPrice: 25000, commission: 15000, usedAt: "2026-11-03T01:00:00.000Z", validity: "1d", address: "10.0.0.2", macAddress: "AA:BB" },
        { id: "*2", username: "voucher-dua", profile: "VCR-4H", amount: 10000, costPrice: 5000, commission: 5000, usedAt: "2026-11-02T02:00:00.000Z", validity: "4h", address: "10.0.0.3", macAddress: "CC:DD" },
      ],
    };
  };
  app.notify = () => {};

  await app.loadVoucherRevenue({ silent: true });

  assert.deepEqual({ ...app.voucherRevenue.summary }, { revenue: 50000, costPrice: 30000, commission: 20000, quantity: 2, profiles: 2 });
  assert.deepEqual(Array.from(app.voucherRevenueProfiles), ["VCR-1D", "VCR-4H"]);
  app.filters.voucherRevenue.profile = "VCR-4H";
  assert.equal(app.filteredVoucherRevenueEntries.length, 1);
  assert.equal(app.filteredVoucherRevenueEntries[0].username, "voucher-dua");
  app.filters.voucherRevenue.profile = "ALL";
  app.filters.voucherRevenue.search = "voucher-satu";
  assert.equal(app.filteredVoucherRevenueEntries[0].username, "voucher-satu");
});

test("laporan voucher keluar dari status memuat ketika MikroTik melewati batas waktu", async () => {
  const app = createDashboardApp({ AbortController, setTimeout, clearTimeout });
  app.revenuePeriod = "2026-11";
  app.api = async (_url, options) => {
    throw new Error(options.timeoutMessage);
  };

  await app.loadVoucherRevenue({ silent: true });

  assert.equal(app.loading.voucherRevenue, false);
  assert.match(app.voucherRevenueError, /Periksa koneksi lalu tekan Muat ulang/);
});

test("pagination laporan voucher berpindah halaman sesuai jumlah data", () => {
  const app = createDashboardApp();
  app.voucherRevenue.entries = Array.from({ length: 25 }, (_value, index) => ({
    id: `voucher-${index + 1}`,
    username: `voucher-${index + 1}`,
    profile: "VCR-1D",
  }));

  app.setPage("voucherRevenue", 2);

  assert.equal(app.filters.voucherRevenue.page, 2);
  assert.deepEqual(Array.from(app.paginatedVoucherRevenueEntries, (entry) => entry.id), [
    "voucher-11",
    "voucher-12",
    "voucher-13",
    "voucher-14",
    "voucher-15",
    "voucher-16",
    "voucher-17",
    "voucher-18",
    "voucher-19",
    "voucher-20",
  ]);
  app.setPage("voucherRevenue", 3);
  assert.equal(app.paginationLabel("voucherRevenue", 25), "Menampilkan 21-25 dari 25 data");
});

test("ekspor laporan voucher membuat berkas CSV tersendiri", async () => {
  let createdBlob = null;
  const link = { href: "", download: "", click() {}, remove() {} };
  const app = createDashboardApp({
    Blob,
    URL: {
      createObjectURL(blob) { createdBlob = blob; return "blob:voucher-revenue"; },
      revokeObjectURL() {},
    },
    document: { createElement: () => link, body: { appendChild() {} } },
  });
  app.revenuePeriod = "2026-11";
  app.voucherRevenue.entries = [{
    id: "*1",
    username: "=voucher-formula",
    profile: "VCR-1D",
    amount: 40000,
    costPrice: 25000,
    commission: 15000,
    period: "2026-11",
    usedAt: "2026-11-03T01:00:00.000Z",
    validity: "1d",
    address: "10.0.0.2",
    macAddress: "AA:BB",
  }];
  app.notify = () => {};

  app.exportVoucherRevenueReport();

  const csv = await createdBlob.text();
  assert.equal(link.download, "laporan-pendapatan-voucher-2026-11.csv");
  assert.match(csv, /"'=voucher-formula"/);
  assert.match(csv, /"40000"/);
  assert.match(csv, /"HPP"/);
  assert.match(csv, /"25000"/);
  assert.match(csv, /"Keuntungan"/);
});

test("sidebar dan panel laporan pendapatan tersedia dengan filter serta ekspor", () => {
  const html = fs.readFileSync(path.join(__dirname, "../public/index.html"), "utf8");
  const script = fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8");

  assert.match(script, /key: "revenue"[^\n]*label: "Laporan Pendapatan"/);
  assert.match(html, /activeMenu === 'revenue'/);
  assert.match(html, /Laporan pendapatan/);
  assert.match(html, /Pendapatan pelanggan/);
  assert.match(html, /Pendapatan voucher/);
  assert.match(html, /Total pendapatan pelanggan/);
  assert.match(html, /Total harga jual/);
  assert.match(html, /<span class="metric-label">Keuntungan<\/span>/);
  assert.match(html, /Pembayaran tercatat/);
  assert.match(html, /Pembayaran lunas/);
  assert.doesNotMatch(html, /<span class="metric-label">Pembayaran sebagian<\/span>/);
  assert.doesNotMatch(html, /<span class="metric-label">Rata-rata pembayaran<\/span>/);
  assert.match(html, /x-model="revenuePeriod"/);
  assert.match(html, /exportRevenueReport\(\)/);
  assert.match(html, /exportVoucherRevenueReport\(\)/);
  assert.match(html, /Belum ada pendapatan pelanggan pada periode ini/);
  assert.match(html, /Belum ada pemakaian voucher yang tercatat pada periode ini/);
  assert.match(html, /x-show\.important="loading\.voucherRevenue && !voucherRevenue\.entries\.length"/);
  assert.match(html, /x-show\.important="!loading\.voucherRevenue && !voucherRevenueError && !filteredVoucherRevenueEntries\.length"/);
  assert.doesNotMatch(html, /voucher-revenue-volume/);
  const voucherRevenueTable = html.match(/<table class="[^"]*voucher-revenue-table[^"]*">[\s\S]*?<\/table>/)?.[0] || "";
  assert.doesNotMatch(voucherRevenueTable, />Perangkat</);
});

test("modal aksi tagihan hanya aktif ketika pelanggan memiliki tindakan", () => {
  const app = createDashboardApp();

  assert.equal(app.hasBillingActions({
    subscriptionActive: false,
    currentPaymentStatus: "PAID",
    hasDebt: false,
    dueStatus: "PAID",
  }), false);
  assert.equal(app.hasBillingActions({
    subscriptionActive: true,
    currentPaymentStatus: "UNPAID",
    hasDebt: false,
    dueStatus: "UPCOMING",
  }), true);
  assert.equal(app.hasBillingActions({
    subscriptionActive: false,
    currentPaymentStatus: "PAID",
    hasDebt: true,
    dueStatus: "PAID",
  }), true);
});

test("status bulan ini tidak memakai jenis pembayaran periode sebelumnya", () => {
  const app = createDashboardApp();

  assert.equal(app.getCurrentPaymentLabel({
    currentPaymentStatus: "UNPAID",
    paymentType: "ARREARS-ONLY",
  }), "Belum Bayar");
  assert.equal(app.getCurrentPaymentLabel({
    currentPaymentStatus: "PAID",
    currentPaymentType: "CURRENT-ONLY",
    paymentType: "ARREARS-ONLY",
  }), "Periode Tagihan");
  assert.equal(app.getCurrentPaymentLabel({
    currentPaymentStatus: "PAID",
    currentPaymentType: null,
  }), "Lunas");
});

test("modal aksi tagihan memindahkan fokus lalu mengembalikannya saat ditutup", () => {
  let bodyLocked = false;
  let closeFocused = false;
  let triggerFocused = false;
  const trigger = { id: "billing-action-trigger-contact-billing-modal", focus() { triggerFocused = true; } };
  const document = {
    activeElement: trigger,
    body: {
      classList: {
        add() { bodyLocked = true; },
        remove() { bodyLocked = false; },
      },
    },
    getElementById(id) {
      if (id === "billing-action-close") return { focus() { closeFocused = true; } };
      if (id === trigger.id) return trigger;
      return null;
    },
  };
  const app = createDashboardApp({ document });
  app.$nextTick = (callback) => callback();
  const contact = {
    id: "contact-billing-modal",
    subscriptionActive: true,
    currentPaymentStatus: "UNPAID",
    hasDebt: false,
    dueStatus: "UPCOMING",
  };

  app.openBillingActionModal(contact, trigger);
  assert.equal(app.billingActionModal.open, true);
  assert.equal(app.billingActionModal.contact.id, contact.id);
  assert.equal(bodyLocked, true);
  assert.equal(closeFocused, true);

  app.closeBillingActionModal();
  assert.equal(app.billingActionModal.open, false);
  assert.equal(bodyLocked, false);
  assert.equal(triggerFocused, true);
});

test("menu template memakai modal bersama untuk tambah dan edit", () => {
  const html = fs.readFileSync(path.join(__dirname, "../public/index.html"), "utf8");

  assert.match(html, /id="template-add-button"[^>]*@click="openTemplateCreateModal\(\$event\.currentTarget\)"/);
  assert.match(html, /@click="openTemplateEditModal\(template, \$event\.currentTarget\)"/);
  assert.match(html, /id="template-dialog"[\s\S]*?role="dialog"[\s\S]*?aria-modal="true"/);
  assert.match(html, /@keydown\.escape\.window="closeTemplateModal\(\)"/);
  assert.match(html, /@keydown\.tab="trapModalFocus\(\$event, 'template-dialog'\)"/);
  assert.match(html, /@submit\.prevent="saveTemplate\(\)"/);
  assert.match(html, /templateModal\.mode === 'edit' \? 'Simpan perubahan' : 'Simpan template'/);
  assert.doesNotMatch(html, /@submit\.prevent="createTemplate\(\)"/);
});

test("modal template mengisi data edit, memindahkan fokus, dan mengembalikan fokus", () => {
  let bodyLocked = false;
  let contentFocused = false;
  let triggerFocused = false;
  const trigger = { id: "template-edit-0", focus() { triggerFocused = true; } };
  const document = {
    body: {
      classList: {
        add() { bodyLocked = true; },
        remove() { bodyLocked = false; },
      },
    },
    getElementById(id) {
      if (id === "template-content-input") return { focus() { contentFocused = true; } };
      if (id === trigger.id) return trigger;
      return null;
    },
  };
  const app = createDashboardApp({ document });
  app.$nextTick = (callback) => callback();

  app.openTemplateEditModal({ name: "Tagihan.txt", content: "Halo {{name}}" }, trigger);
  assert.equal(app.templateModal.open, true);
  assert.equal(app.templateModal.mode, "edit");
  assert.equal(app.forms.template.name, "Tagihan.txt");
  assert.equal(app.forms.template.content, "Halo {{name}}");
  assert.equal(contentFocused, true);
  assert.equal(bodyLocked, true);

  app.closeTemplateModal();
  assert.equal(app.templateModal.open, false);
  assert.equal(bodyLocked, false);
  assert.equal(triggerFocused, true);
});

test("simpan template memilih endpoint tambah dan edit yang sesuai", async () => {
  const app = createDashboardApp();
  const requests = [];
  const notifications = [];
  let closed = 0;
  let reminderLoads = 0;
  app.withProcessing = async (_message, action) => action();
  app.api = async (url, options) => {
    requests.push({ url, method: options.method, body: JSON.parse(options.body) });
    return options.method === "PUT" ? { remindersUpdated: 2 } : {};
  };
  app.loadTemplates = async () => true;
  app.loadReminders = async () => { reminderLoads += 1; };
  app.notify = (message) => notifications.push(message);
  app.closeTemplateModal = () => { closed += 1; };

  app.templateModal = { open: true, loading: false, mode: "create", originalName: "", returnFocusId: "" };
  app.forms.template = { name: " Info pelanggan ", content: " Halo {{name}} " };
  await app.saveTemplate();

  app.templateModal = { open: true, loading: false, mode: "edit", originalName: "Info pelanggan.txt", returnFocusId: "" };
  app.forms.template = { name: "Info pelanggan.txt", content: " Pesan diperbarui " };
  await app.saveTemplate();

  assert.deepEqual(requests, [
    {
      url: "/api/templates",
      method: "POST",
      body: { name: "Info pelanggan", content: " Halo {{name}} " },
    },
    {
      url: "/api/templates/Info%20pelanggan.txt",
      method: "PUT",
      body: { content: " Pesan diperbarui " },
    },
  ]);
  assert.deepEqual(notifications, ["Template ditambahkan.", "Template diperbarui. 2 jadwal reminder disinkronkan."]);
  assert.equal(reminderLoads, 1);
  assert.equal(closed, 2);
});

test("simpan template menolak nama atau isi yang kosong", async () => {
  const app = createDashboardApp();
  let apiCalled = false;
  app.api = async () => { apiCalled = true; };
  app.setFormError = (key, message) => { app.formErrors[key] = message; };

  app.forms.template = { name: "", content: "Pesan" };
  await app.saveTemplate();
  assert.equal(app.formErrors.template, "Nama file template wajib diisi.");

  app.forms.template = { name: "Tagihan", content: "   " };
  await app.saveTemplate();
  assert.equal(app.formErrors.template, "Isi template wajib diisi.");
  assert.equal(apiCalled, false);
});

test("tombol aksi data, tagihan, dan hotspot memakai bentuk bersama", () => {
  const html = fs.readFileSync(path.join(__dirname, "../public/index.html"), "utf8");
  const styles = fs.readFileSync(path.join(__dirname, "../public/styles.css"), "utf8");

  assert.match(html, /customer-data-actions customer-row-actions/);
  assert.match(html, /customer-billing-actions customer-row-actions/);
  assert.match(html, /customer-hotspot-action-grid[^\"]*customer-row-actions/);
  assert.match(html, /customer-hotspot-account-actions[^\"]*customer-row-actions/);
  assert.match(html, /customer-hotspot-service-actions[^\"]*customer-row-actions/);
  assert.match(html, /data-label="Langganan"/);
  assert.match(html, /data-label="Nomor HP"/);
  assert.match(html, /data-label="Status Jatuh Tempo"/);
  assert.match(html, /data-label="Sumber Nominal"/);
  assert.match(html, /data-label="Bulan Ini"/);
  assert.match(html, /data-label="Tunggakan"/);
  assert.match(html, /data-label="Status Akun"/);
  assert.match(html, /data-label="User Hotspot"/);
  assert.match(html, /data-label="Profile"/);
  assert.match(html, /data-label="Status Jadwal"/);
  assert.match(html, /data-label="Jadwal Layanan"/);
  assert.match(html, /data-label="IP Access Point"/);
  assert.match(html, /data-label="Status AP"/);
  assert.match(html, /data-label="Aksi Akun"/);
  assert.match(html, /data-label="Aksi Layanan"/);
  assert.match(html, /<td colspan="10"[^>]*Tidak ada tagihan yang cocok/);
  assert.match(html, /<td colspan="11"[^>]*Tidak ada akun hotspot yang cocok/);
  assert.match(html, /Pelanggan<\/th>\s*<th[^>]*>Nomor HP<\/th>\s*<th[^>]*>User Hotspot<\/th>/);
  assert.match(styles, /\.panel-shell \.customer-row-actions button \{[^}]*min-height: 36px !important;[^}]*border-radius: 9px !important;[^}]*font-size: 10px !important;/);
  assert.match(styles, /\.panel-shell \.customer-row-actions button \{[^}]*min-height: 44px !important;[^}]*font-size: 11px !important;/);
  assert.match(styles, /\.customer-due-status \{[^}]*white-space: nowrap;/);
  assert.match(styles, /\.customer-hotspot-status, \.customer-schedule-status \{[^}]*white-space: nowrap;/);
  assert.match(styles, /\.customer-hotspot-table \{ min-width: 1780px; \}/);
  assert.match(styles, /\.customer-hotspot-table th:nth-child\(5\) \{ width: 12%; \}/);
  assert.match(styles, /\.customer-hotspot-table th:nth-child\(6\) \{ width: 12%; \}/);
  assert.match(styles, /\.customer-hotspot-account-actions button \{[^}]*gap: 7px;[^}]*padding-inline: 12px !important;/);
  assert.match(styles, /\.customer-hotspot-table th:nth-child\(10\) \{ width: 8%; \}/);
});

test("filter tagihan dan hotspot dapat direset tanpa mengubah jumlah baris", () => {
  const app = createDashboardApp();
  const html = fs.readFileSync(path.join(__dirname, "../public/index.html"), "utf8");

  app.filters.contactBilling = { search: "Nayya", status: "HAS-DEBT", dueStatus: "OVERDUE", page: 3, pageSize: 25 };
  assert.equal(app.hasContactBillingFilters, true);
  app.resetContactBillingFilters();
  assert.deepEqual(app.filters.contactBilling, { search: "", status: "ALL", dueStatus: "ALL", page: 1, pageSize: 25 });
  assert.equal(app.hasContactBillingFilters, false);

  app.filters.contactHotspot = { search: "bintang", status: "ACTIVE", page: 2, pageSize: 50 };
  assert.equal(app.hasContactHotspotFilters, true);
  app.resetContactHotspotFilters();
  assert.deepEqual(app.filters.contactHotspot, { search: "", status: "ALL", page: 1, pageSize: 50 });
  assert.equal(app.hasContactHotspotFilters, false);

  assert.match(html, /@click="resetContactBillingFilters\(\)"/);
  assert.match(html, /@click="resetContactHotspotFilters\(\)"/);
  assert.match(html, /Jumlah tagihan per halaman/);
  assert.match(html, /Jumlah akun hotspot per halaman/);
});

test("jadwal reminder memakai waktu kirim H-1 dan tetap menampilkan jatuh tempo", () => {
  const app = createDashboardApp();
  const html = fs.readFileSync(path.join(__dirname, "../public/index.html"), "utf8");
  const script = fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8");

  assert.match(html, /Waktu pengiriman/);
  assert.equal(app.getReminderDeliveryLabel({ deliveryScheduleType: "GRACE_PERIOD" }), "Pengingat masa tenggang");
  assert.equal(app.getReminderDeliveryLabel({ deliveryScheduleType: "BILLING_DUE" }), "Jatuh tempo tagihan");
  assert.equal(app.getReminderDeliveryLabel({ deliveryScheduleType: "RETRY" }), "Percobaan ulang");
  assert.equal(app.getReminderDeliveryLabel({ deliveryScheduleType: "STANDARD" }), "Waktu reminder");
  assert.match(html, /getReminderDeliveryLabel\(reminder\)/);
  assert.match(html, /'Jatuh tempo tagihan: ' \+ formatDateTime\(reminder\.reminderDateTime\)/);
  assert.match(script, /const deliveryDateTime = reminder\.deliveryDateTime \|\| reminder\.reminderDateTime;/);
  assert.match(script, /this\.isToday\(deliveryDateTime\)/);
});

test("baris akun pelanggan membuka modal ganti password melalui ikon chevron", () => {
  const html = fs.readFileSync(path.join(__dirname, "../public/customer.html"), "utf8");
  const script = fs.readFileSync(path.join(__dirname, "../public/customer.js"), "utf8");

  assert.match(html, /class="portal-account-trigger"[^>]*openPasswordModal\('portal'\)/);
  assert.match(html, /Akun pelanggan:[\s\S]*?fa-chevron-right/);
  assert.doesNotMatch(html, /Ganti password login/);
  assert.match(html, /Ganti Password Akun Pelanggan/);
  assert.match(script, /this\.\$refs\.portalPasswordTrigger/);
  assert.match(script, /trigger\?\.focus\(\)/);
});

test("menu voucher mendukung pembuatan satu akun dan batch", async () => {
  const app = createDashboardApp();
  const html = fs.readFileSync(path.join(__dirname, "../public/index.html"), "utf8");
  const styles = fs.readFileSync(path.join(__dirname, "../public/interface.css"), "utf8");
  const script = fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8");
  let request = null;
  let reloadedUsers = false;

  assert.equal(app.navMenus.some((menu) => menu.key === "vouchers"), true);
  assert.equal(app.forms.voucher.generationType, "SINGLE");
  assert.equal(app.forms.voucher.quantity, 10);
  assert.match(html, /Voucher hotspot/);
  assert.match(html, /value="SINGLE"/);
  assert.match(html, /value="BULK"/);
  assert.match(html, /@click="copyVoucherCredentials\(\)"/);
  assert.match(html, /@click="printVouchers\(\)"/);
  assert.match(html, /@click="printRewardVouchers\(\)"/);
  assert.match(html, /@click="removeVoucher\(voucher\)"/);
  assert.match(html, /@click="resetVoucherDevice\(voucher\)"/);
  assert.match(html, /getVoucherDeviceLabel\(voucher\)/);
  assert.match(html, /:aria-label="'Hapus voucher ' \+ voucher\.username"/);
  assert.match(html, /voucher-card-used/);
  assert.match(html, /voucher-usage-badge/);
  assert.match(html, /getVoucherUsageLabel\(voucher\)/);
  assert.match(html, /x-model\.trim="voucherBatchFilters\.search"/);
  assert.match(html, /x-model="voucherBatchFilters\.usage"/);
  assert.match(html, /<option value="ALL"[\s\S]*?Semua riwayat batch/);
  assert.match(html, /x-for="\(voucher, index\) in filteredVoucherBatchVouchers"/);
  assert.match(html, /voucher-filter-reset[\s\S]*?fa-filter-circle-xmark mr-2[\s\S]*?Reset filter/);
  assert.match(html, />Belum digunakan<\/option>/);
  assert.match(html, />Sudah digunakan<\/option>/);
  assert.match(html, /id="delete-confirm-dialog"[\s\S]*?role="dialog"[\s\S]*?aria-modal="true"/);
  assert.match(html, /@keydown\.tab="trapModalFocus\(\$event, 'delete-confirm-dialog'\)"/);
  assert.match(script, /voucher-print-root/);
  assert.match(html, /getVoucherPriceLabel\(\)/);
  assert.match(html, /<dt>Masa berlaku<\/dt><dd x-text="getVoucherValidityLabel\(\)"><\/dd>/);
  assert.match(html, /<dt>Nilai reward<\/dt><dd>GRATIS<\/dd>/);
  assert.match(html, /Gunakan voucher ini untuk terhubung ke jaringan WiFi\./);
  assert.match(html, /Riwayat batch/);
  assert.match(html, /@change="selectVoucherBatch\(selectedVoucherBatchId\)"/);
  assert.match(html, /Profile voucher/);
  assert.match(html, /Masa berlaku mulai dihitung saat voucher pertama kali login/);
  assert.match(html, /x-show="voucherCreateModal\.open"/);
  assert.match(html, /x-show="voucherProfileModal\.open"/);
  assert.match(html, /role="dialog" aria-modal="true" aria-labelledby="voucher-create-title"/);
  assert.match(html, /role="dialog" aria-modal="true" aria-labelledby="voucher-profile-title"/);
  assert.match(html, /x-show="activeVoucherTab === 'profiles'" class="voucher-profile-page"/);
  assert.match(html, /x-show="activeVoucherTab === 'stats'" class="voucher-stats-page"/);
  assert.match(html, /Jumlah voucher per profile/);
  assert.match(html, /Voucher terpakai/);
  assert.match(html, /Belum terpakai/);
  assert.match(html, /Profile voucher baru/);
  assert.match(styles, /\.voucher-workspace \{[\s\S]*?grid-template-columns:/);
  assert.match(styles, /@media \(max-width: 620px\) \{[\s\S]*?\.voucher-fields\.two-columns/);
  assert.match(styles, /@media print \{[\s\S]*?body\.voucher-print-mode/);
  assert.match(styles, /grid-template-columns: repeat\(3, minmax\(0, 1fr\)\);[\s\S]*?grid-template-rows: repeat\(5, minmax\(0, 1fr\)\)/);
  assert.match(styles, /voucher-print-page-grid \.voucher-card dd \{[\s\S]*?font-size: 14px/);
  assert.match(styles, /voucher-reward-card dd \{[\s\S]*?font-size: 13px/);
  assert.match(styles, /\.voucher-delete-button:focus-visible/);
  assert.match(styles, /\.voucher-card-heading-actions \{[\s\S]*?gap: 10px;[\s\S]*?margin-left: 10px/);
  assert.match(styles, /\.voucher-card-heading \{[\s\S]*?gap: 14px/);
  assert.match(styles, /\.voucher-card-heading > span \{[\s\S]*?padding-right: 4px/);
  assert.match(styles, /\.voucher-usage-badge\.status-used/);
  assert.match(styles, /\.voucher-list-tools \{[\s\S]*?grid-template-columns:/);
  assert.match(styles, /\.voucher-list-field \{[\s\S]*?gap: 9px/);
  assert.match(styles, /\.voucher-filter-reset \{[\s\S]*?min-height: 44px[\s\S]*?padding: 10px 18px !important/);
  assert.match(styles, /@media \(max-width: 620px\) \{[\s\S]*?\.voucher-list-tools \{[\s\S]*?grid-template-columns: 1fr/);

  app.voucherResult = {
    profile: "VCR-1H",
    sellingPrice: 25000,
    vouchers: Array.from({ length: 31 }, (_, index) => ({ username: `voucher-${index + 1}` })),
  };
  app.voucherProfiles = [{ name: "VCR-1H", validity: "1d" }];
  assert.deepEqual(Array.from(app.getVoucherPrintPages(), (page) => page.length), [15, 15, 1]);
  assert.deepEqual(Array.from(app.getVoucherRewardPrintPages(), (page) => page.length), [15, 15, 1]);
  assert.match(app.getVoucherPriceLabel(), /25\.000/);
  assert.equal(app.getVoucherValidityLabel(), "1 hari");
  assert.equal(app.getVoucherValidityLabel({ profile: "VCR-1H", validity: "1w2d4h" }), "1 minggu 2 hari 4 jam");
  assert.equal(app.getVoucherUsageStatus({ usageStatus: "USED" }), "USED");
  assert.equal(app.getVoucherUsageLabel({ used: true }), "Sudah digunakan");
  assert.equal(app.getVoucherUsageLabel({ usageStatus: "UNUSED" }), "Belum digunakan");
  assert.equal(app.getVoucherUsageLabel({ usageStatus: "MISSING" }), "Tidak ditemukan di MikroTik");

  app.voucherBatches = [{
    batchId: "batch-satu",
    profile: "VCR-1H",
    comment: "Batch pagi",
    vouchers: [
      { username: "voucher-belum", password: "kode-belum", usageStatus: "UNUSED" },
      { username: "voucher-hilang", password: "kode-hilang", usageStatus: "MISSING" },
    ],
  }, {
    batchId: "batch-dua",
    profile: "VCR-4H",
    comment: "Batch malam",
    vouchers: [
      { username: "voucher-sudah", password: "kode-sudah", macAddress: "AA:BB:CC:DD:EE:FF", usageStatus: "USED" },
    ],
  }];
  app.selectVoucherBatch("ALL");
  assert.equal(app.filteredVoucherBatchVouchers.length, 3);
  app.voucherBatchFilters.search = "SUDAH";
  assert.deepEqual(Array.from(app.filteredVoucherBatchVouchers, (voucher) => voucher.username), ["voucher-sudah"]);
  app.voucherBatchFilters.search = "AA:BB:CC";
  assert.deepEqual(Array.from(app.filteredVoucherBatchVouchers, (voucher) => voucher.username), ["voucher-sudah"]);
  app.voucherBatchFilters.search = "";
  app.voucherBatchFilters.usage = "UNUSED";
  assert.deepEqual(Array.from(app.filteredVoucherBatchVouchers, (voucher) => voucher.username), ["voucher-belum"]);
  app.voucherBatchFilters.usage = "USED";
  assert.deepEqual(Array.from(app.filteredVoucherBatchVouchers, (voucher) => voucher.username), ["voucher-sudah"]);
  app.resetVoucherBatchFilters();
  assert.equal(app.hasVoucherBatchFilters, false);
  assert.equal(app.filteredVoucherBatchVouchers.length, 3);
  assert.equal(app.getVoucherCardBatchLabel(app.filteredVoucherBatchVouchers[0]), "Batch pagi");
  app.selectVoucherBatch("batch-dua");
  assert.deepEqual(Array.from(app.filteredVoucherBatchVouchers, (voucher) => voucher.username), ["voucher-sudah"]);

  app.api = async (url) => {
    assert.equal(url, "/api/mikrotik/voucher-stats");
    return {
      summary: { total: 12, used: 7, unused: 5 },
      profiles: [{ profile: "VCR-1H", total: 12, used: 7, unused: 5 }],
    };
  };
  app.notify = () => {};
  await app.loadVoucherStats({ silent: true });
  assert.deepEqual({ ...app.voucherStats.summary }, { total: 12, used: 7, unused: 5 });
  assert.equal(app.voucherStats.profiles[0].profile, "VCR-1H");

  app.forms.voucher = {
    ...app.forms.voucher,
    generationType: "SINGLE",
    username: "voucher-ui",
    password: "password-ui",
    profile: "100M",
    server: "all",
  };
  app.withProcessing = async (_message, action) => action();
  app.api = async (url, options) => {
    request = { url, payload: JSON.parse(options.body) };
    return {
      batchId: "batch-ui",
      quantity: 1,
      profile: "100M",
      server: "all",
      vouchers: [{ username: "voucher-ui", password: "password-ui" }],
    };
  };
  app.loadHotspotUsers = async () => { reloadedUsers = true; };
  app.loadVoucherStats = async () => {};
  app.notify = () => {};

  await app.createVouchers();

  assert.equal(request.url, "/api/mikrotik/vouchers");
  assert.equal(request.payload.quantity, 1);
  assert.equal(request.payload.username, "voucher-ui");
  assert.equal(app.voucherResult.quantity, 1);
  assert.equal(app.voucherBatches.length, 3);
  assert.equal(app.selectedVoucherBatchId, "batch-ui");
  assert.equal(app.voucherBatches[0].batchId, "batch-ui");
  assert.equal(app.forms.voucher.username, "");
  assert.equal(app.forms.voucher.password, "");
  assert.equal(reloadedUsers, true);
});

test("pembuatan banyak voucher memakai pekerjaan latar belakang", async () => {
  const app = createDashboardApp();
  const requests = [];
  app.forms.voucher = {
    ...app.forms.voucher,
    generationType: "BULK",
    quantity: 450,
    profile: "100M",
    server: "all",
  };
  app.withProcessing = async (_message, action) => action();
  app.api = async (url, options = {}) => {
    requests.push({ url, method: options.method || "GET" });
    if (url === "/api/mikrotik/voucher-jobs") {
      return {
        id: "job-voucher-ui",
        status: "COMPLETED",
        total: 450,
        progress: 450,
        result: {
          batchId: "batch-bulk-ui",
          quantity: 450,
          profile: "100M",
          server: "all",
          vouchers: [{ username: "bulk-1", password: "bulk-1" }],
        },
      };
    }
    throw new Error(`Endpoint tidak dikenal: ${url}`);
  };
  app.loadHotspotUsers = async () => {};
  app.loadVoucherStats = async () => {};
  app.notify = () => {};

  await app.createVouchers();

  assert.deepEqual(requests, [{ url: "/api/mikrotik/voucher-jobs", method: "POST" }]);
  assert.equal(app.voucherResult.batchId, "batch-bulk-ui");
  assert.equal(app.voucherResult.quantity, 450);
  assert.equal(app.getVoucherJobMessage({ phase: "CREATING", progress: 125, total: 450 }), "Membuat voucher 125 dari 450 di MikroTik...");
});

test("respons HTML dari proxy tidak ditampilkan mentah sebagai pesan error", async () => {
  let notification = "";
  const app = createDashboardApp({
    fetch: async () => ({
      status: 524,
      ok: false,
      headers: { get: () => "text/html" },
      text: async () => "<!DOCTYPE html><html><title>524 timeout</title></html>",
    }),
  });
  app.notify = (message) => { notification = message; };

  await assert.rejects(() => app.api("/api/test"), /Permintaan terlalu lama diproses/);
  assert.doesNotMatch(notification, /doctype|<html/i);
});

test("API browser membatalkan permintaan yang melewati batas waktu", async () => {
  let aborted = false;
  const app = createDashboardApp({
    AbortController,
    setTimeout,
    clearTimeout,
    fetch: async (_path, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => {
        aborted = true;
        const error = new Error("Request aborted");
        error.name = "AbortError";
        reject(error);
      }, { once: true });
    }),
  });
  app.notify = () => {};

  await assert.rejects(() => app.api("/api/test", {
    silent: true,
    timeoutMs: 5,
    timeoutMessage: "Permintaan uji melewati batas waktu.",
  }), /Permintaan uji melewati batas waktu/);
  assert.equal(aborted, true);
});

test("broadcast massal memakai pekerjaan latar belakang dan menghitung status accepted", async () => {
  const app = createDashboardApp();
  const requests = [];
  let notification = "";
  app.forms.broadcast = { title: "Info", templateName: "", message: "Pesan" };
  app.withProcessing = async (_message, action) => action();
  app.api = async (url, options = {}) => {
    requests.push({ url, method: options.method || "GET" });
    return {
      id: "job-broadcast-ui",
      type: "CONTACT_BROADCAST",
      status: "COMPLETED",
      progress: 2,
      total: 2,
      result: [
        { phoneNumber: "628111111111", status: "accepted" },
        { phoneNumber: "628222222222", status: "failed" },
      ],
    };
  };
  app.loadLogs = async () => {};
  app.notify = (message) => { notification = message; };

  await app.sendBroadcast();

  assert.deepEqual(requests, [{ url: "/api/notifications/broadcast", method: "POST" }]);
  assert.equal(notification, "Broadcast terkirim: 1 berhasil, 1 gagal.");
  assert.equal(app.getOperationJobMessage({ type: "CONTACT_BROADCAST", progress: 7, total: 10 }), "Mengirim pesan 7 dari 10 pelanggan...");
  assert.equal(app.getOperationJobMessage({ type: "MIKROTIK_BACKUP", phase: "CREATING_BACKUP" }), "Membuat file backup MikroTik...");
});

test("ikon X voucher membuka konfirmasi lalu menghapus akun dari MikroTik dan riwayat", async () => {
  const app = createDashboardApp();
  let confirmation = null;
  let request = null;
  let reloadOptions = null;
  let statsReloaded = false;
  let usersReloaded = false;
  let notification = "";
  app.voucherResult = {
    batchId: "batch-ui-delete",
    quantity: 2,
    vouchers: [
      { username: "voucher-hapus", password: "rahasia" },
      { username: "voucher-sisa", password: "rahasia" },
    ],
  };
  app.selectedVoucherBatchId = "batch-ui-delete";
  app.openDeleteConfirm = (options) => { confirmation = options; };
  app.api = async (url, options) => {
    request = { url, method: options.method };
    return { batchRemoved: false, remaining: 1 };
  };
  app.loadVoucherBatches = async (options) => { reloadOptions = options; };
  app.loadVoucherStats = async () => { statsReloaded = true; };
  app.loadHotspotUsers = async () => { usersReloaded = true; };
  app.notify = (message) => { notification = message; };

  app.removeVoucher(app.voucherResult.vouchers[0]);

  assert.equal(confirmation.title, "Hapus voucher?");
  assert.match(confirmation.description, /voucher-hapus/);
  assert.equal(confirmation.confirmLabel, "Hapus voucher");
  await confirmation.action();
  assert.deepEqual(request, {
    url: "/api/mikrotik/voucher-batches/batch-ui-delete/vouchers/voucher-hapus",
    method: "DELETE",
  });
  assert.equal(reloadOptions.silent, true);
  assert.equal(reloadOptions.batchId, "batch-ui-delete");
  assert.equal(statsReloaded, true);
  assert.equal(usersReloaded, true);
  assert.equal(notification, "Voucher voucher-hapus berhasil dihapus.");
});

test("reset perangkat voucher melepas MAC melalui konfirmasi dan memuat ulang batch", async () => {
  const app = createDashboardApp();
  let confirmation = null;
  let request = null;
  let reloadOptions = null;
  let notification = "";
  const voucher = {
    batchId: "batch-ui-reset",
    username: "voucher-reset",
    macAddress: "AA:BB:CC:DD:EE:FF",
  };
  app.voucherBatches = [{
    batchId: "batch-ui-reset",
    lockUser: true,
    vouchers: [voucher],
  }];
  app.selectVoucherBatch("ALL");
  app.openDeleteConfirm = (options) => { confirmation = options; };
  app.api = async (url, options) => {
    request = { url, method: options.method };
    return { activeSessionsKilled: 1 };
  };
  app.loadVoucherBatches = async (options) => { reloadOptions = options; };
  app.loadHotspotUsers = async () => {};
  app.notify = (message) => { notification = message; };

  assert.equal(app.getVoucherMacAddress(voucher), "AA:BB:CC:DD:EE:FF");
  assert.equal(app.getVoucherDeviceLabel(voucher), "AA:BB:CC:DD:EE:FF");
  assert.equal(app.getVoucherDeviceLabel({ batchId: "batch-ui-reset" }), "Belum terkunci");
  app.resetVoucherDevice(voucher);

  assert.equal(confirmation.title, "Reset perangkat voucher?");
  assert.match(confirmation.description, /Masa berlaku dan riwayat pemakaian tidak berubah/);
  assert.equal(confirmation.confirmLabel, "Reset perangkat");
  await confirmation.action();
  assert.deepEqual(request, {
    url: "/api/mikrotik/voucher-batches/batch-ui-reset/vouchers/voucher-reset/reset-device",
    method: "POST",
  });
  assert.equal(reloadOptions.silent, true);
  assert.equal(reloadOptions.batchId, "ALL");
  assert.equal(notification, "Perangkat voucher voucher-reset berhasil direset.");
});

test("tombol voucher membuka modal dan penutupan mengembalikan fokus", async () => {
  const focused = [];
  const elements = new Map([
    ["voucher-create-button", { focus: () => focused.push("voucher-create-button") }],
    ["voucher-profile-button", { focus: () => focused.push("voucher-profile-button") }],
    ["voucher-create-dialog", { querySelector: () => ({ focus: () => focused.push("voucher-create-input") }) }],
    ["voucher-profile-dialog", { focus: () => focused.push("voucher-profile-dialog") }],
  ]);
  const app = createDashboardApp({ document: { getElementById: (id) => elements.get(id) || null } });
  app.$nextTick = (callback) => callback();
  app.voucherProfiles = [{ name: "4Jam", voucherReady: true }];
  app.mikrotikServers = ["hotspot1"];

  await app.openVoucherCreateModal({ id: "voucher-create-button" });
  assert.equal(app.voucherCreateModal.open, true);
  assert.equal(focused.at(-1), "voucher-create-input");
  app.closeVoucherCreateModal();
  assert.equal(app.voucherCreateModal.open, false);
  assert.equal(focused.at(-1), "voucher-create-button");

  await app.openVoucherProfileModal({ id: "voucher-profile-button" });
  assert.equal(app.voucherProfileModal.open, true);
  assert.equal(focused.at(-1), "voucher-profile-dialog");
  app.closeVoucherProfileModal();
  assert.equal(app.voucherProfileModal.open, false);
  assert.equal(focused.at(-1), "voucher-profile-button");
});

test("profile voucher dapat dibuat dan dipilih untuk batch baru", async () => {
  const app = createDashboardApp();
  let request = null;
  app.withProcessing = async (_message, action) => action();
  app.loadVoucherProfiles = async () => {
    app.voucherProfiles = [{ name: "VCR-4JAM", voucherReady: true }];
  };
  app.notify = () => {};
  app.forms.voucherProfile = {
    ...app.forms.voucherProfile,
    name: "VCR-4JAM",
    validity: "4h",
    expiredMode: "rem",
  };
  app.api = async (url, options) => {
    request = { url, payload: JSON.parse(options.body) };
    return { ...request.payload, voucherReady: true };
  };

  await app.saveVoucherProfile();

  assert.equal(request.url, "/api/mikrotik/voucher-profiles");
  assert.equal(request.payload.validity, "4h");
  assert.equal(request.payload.expiredMode, "rem");
  assert.equal(app.forms.voucher.profile, "VCR-4JAM");
  assert.equal(app.forms.voucherProfile.name, "");
});

test("keuntungan profile voucher dihitung otomatis dari harga jual dikurangi HPP", () => {
  const app = createDashboardApp();
  app.forms.voucherProfile.costPrice = 2000;
  app.forms.voucherProfile.sellingPrice = 3000;

  app.updateVoucherProfileProfit();

  assert.equal(app.forms.voucherProfile.commission, 1000);
  app.forms.voucherProfile.sellingPrice = 1500;
  app.updateVoucherProfileProfit();
  assert.equal(app.forms.voucherProfile.commission, 0);
});

test("riwayat voucher memilih kembali batch yang tersimpan di MikroTik", async () => {
  const app = createDashboardApp();
  app.api = async () => [{
    batchId: "batch-baru",
    createdAt: "2026-11-02T12:00:00.000Z",
    quantity: 2,
    profile: "30H-2user",
    server: "all",
    vouchers: [
      { username: "voucher-1", password: "password-1" },
      { username: "voucher-2", password: "password-2" },
    ],
  }, {
    batchId: "batch-lama",
    createdAt: "2026-11-01T12:00:00.000Z",
    quantity: 1,
    profile: "12JAM",
    server: "all",
    vouchers: [{ username: "voucher-lama", password: "password-lama" }],
  }];

  await app.loadVoucherBatches({ silent: true, batchId: "batch-lama" });

  assert.equal(app.voucherBatches.length, 2);
  assert.equal(app.selectedVoucherBatchId, "batch-lama");
  assert.equal(app.voucherResult.vouchers[0].username, "voucher-lama");
  app.selectVoucherBatch("batch-baru");
  assert.equal(app.voucherResult.quantity, 2);
  assert.match(app.getVoucherBatchLabel(app.voucherResult), /2 voucher/);
});
