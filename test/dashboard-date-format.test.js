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
  assert.match(html, /billing-action-quick-row[\s\S]*?aria-label="Lunasi semua tagihan"[\s\S]*?>Lunasi semua</);
  assert.match(html, /Tandai belum bayar/);
  assert.match(html, /Bayar sebagian tunggakan/);
  assert.match(html, /Catat pembayaran/);
  assert.doesNotMatch(html, /<details[^>]*customer-payment-menu/);
  assert.match(styles, /\.billing-action-option \{[^}]*width: fit-content;[^}]*justify-self: end;[^}]*border-radius: 999px;/);
  assert.match(styles, /\.billing-action-submit \{[^}]*width: fit-content;[^}]*justify-self: end;[^}]*border-radius: 999px;/);
  assert.match(styles, /\.billing-action-option:hover > i \{ color: #fff; \}/);
  assert.match(styles, /\.billing-action-option:disabled, \.billing-action-option:disabled:hover \{[^}]*cursor: not-allowed;/);
  assert.match(styles, /\.billing-action-submit > i, \.billing-action-submit:hover > i \{ color: #fff; \}/);
  assert.match(styles, /\.billing-action-option-reminder \{[^}]*background: #15803d;/);
  assert.match(styles, /\.billing-action-quick-row \{[^}]*justify-content: flex-end;/);
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
    billingPausedForArrears: true,
    hotspotProvisioningStatus: "DISABLED",
    mikrotikUsername: "pelanggan_masa_aktif",
    mikrotikProfile: "50M",
  };

  assert.match(html, /@click="purchaseActivePeriod\(billingActionModal\.contact\)"/);
  assert.match(html, /getActivePeriodPurchaseLabel\(billingActionModal\.contact\)/);
  assert.match(styles, /\.billing-action-active-period \.billing-action-option \{ width: 100%; \}/);
  assert.equal(app.canPurchaseActivePeriod(contact), true);
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

  assert.equal(app.canPayCurrentBilling({ subscriptionActive: true, currentPaymentStatus: "UNPAID" }), true);
  assert.equal(app.getCurrentBillingActionLabel({ subscriptionActive: true, currentPaymentStatus: "UNPAID" }), "Bayar bulan ini");
  assert.equal(app.canPayCurrentBilling({ subscriptionActive: true, currentPaymentStatus: "PAID" }), false);
  assert.equal(app.getCurrentBillingActionLabel({ subscriptionActive: true, currentPaymentStatus: "PAID" }), "Bulan ini sudah lunas");
  assert.equal(app.canPayCurrentBilling({ subscriptionActive: false, currentPaymentStatus: "PAID" }), false);
  assert.equal(app.getCurrentBillingActionLabel({ subscriptionActive: false, currentPaymentStatus: "PAID" }), "Tidak ada tagihan bulan ini");
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
  assert.match(html, /<option value="NOT_SCHEDULED">Perlu dijadwalkan<\/option>/);
  assert.match(html, /<option value="NOT_APPLICABLE">Tidak dijadwalkan<\/option>/);
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
  ];

  assert.deepEqual(JSON.parse(JSON.stringify(app.networkMonitorSummary)), {
    netwatch: 2,
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

  assert.match(html, /Ringkasan sinkronisasi jaringan/);
  assert.match(html, /AP tanpa pelanggan/);
  assert.match(html, /x-model="filters\.monitorAp\.linkStatus"/);
  assert.match(html, /getApCustomerSummary\(ap\)/);
  assert.match(html, /Tabel status AP dan pelanggan terkait/);
  assert.match(html, /x-for="ap in selectableApMonitors"/);
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

test("sidebar dan panel laporan pendapatan tersedia dengan filter serta ekspor", () => {
  const html = fs.readFileSync(path.join(__dirname, "../public/index.html"), "utf8");
  const script = fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8");

  assert.match(script, /key: "revenue"[^\n]*label: "Laporan Pendapatan"/);
  assert.match(html, /activeMenu === 'revenue'/);
  assert.match(html, /Pendapatan tercatat/);
  assert.match(html, /x-model="revenuePeriod"/);
  assert.match(html, /exportRevenueReport\(\)/);
  assert.match(html, /Belum ada pendapatan tercatat pada periode ini/);
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
  assert.match(html, /customer-hotspot-action-grid customer-row-actions/);
  assert.match(styles, /\.panel-shell \.customer-row-actions button \{[^}]*min-height: 36px !important;[^}]*border-radius: 9px !important;[^}]*font-size: 10px !important;/);
  assert.match(styles, /\.panel-shell \.customer-row-actions button \{[^}]*min-height: 44px !important;[^}]*font-size: 11px !important;/);
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
