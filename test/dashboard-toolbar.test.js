const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const scripts = [
  "../public/dashboard/state.js",
  "../public/dashboard/ui.js",
  "../public/dashboard/selectors.js",
  "../public/dashboard/data.js",
  "../public/dashboard/actions.js",
  "../public/app.js",
];
const html = fs.readFileSync(path.join(__dirname, "../public/index.html"), "utf8");
const css = fs.readFileSync(path.join(__dirname, "../public/interface.css"), "utf8");

function createApp() {
  const source = scripts.map((file) => fs.readFileSync(path.join(__dirname, file), "utf8")).join("\n");
  const dashboardApp = vm.runInNewContext(source + "\n;dashboardApp", {
    window: { matchMedia: () => ({ matches: false }) },
  });
  return dashboardApp();
}

test("semua tabel sortable menyediakan pilihan urut yang sama di mobile", () => {
  const app = createApp();
  const desktop = new Map();
  for (const match of html.matchAll(/getSortAria\('([^']+)', '([^']+)'\)/g)) {
    if (!desktop.has(match[1])) desktop.set(match[1], new Set());
    desktop.get(match[1]).add(match[2]);
  }

  for (const [tableKey, fields] of Object.entries(app.mobileSortFields)) {
    const expected = Array.from(fields, ([key]) => key);
    assert.deepEqual(expected, Array.from(desktop.get(tableKey) || []), tableKey);
    assert.ok(html.includes(`changeMobileSort('${tableKey}', $event.target.value)`), tableKey);
    assert.ok(html.includes(`getMobileSortOptions('${tableKey}')`), tableKey);
    assert.equal(app.getMobileSortOptions(tableKey).length, 1 + fields.length * 2, tableKey);
  }
  assert.match(css, /@media \(max-width: 767px\) \{[\s\S]*?\.toolbar-mobile-sort \{\s*display: flex !important;/);
});

test("pilihan urutan mobile sesuai tombol header dan dapat dikembalikan", () => {
  const app = createApp();
  const records = [{ name: "Zeta" }, { name: "Alfa" }];
  app.filters.contacts.page = 3;
  app.changeMobileSort("contacts", "name:asc");
  assert.equal(app.filters.contacts.page, 1);
  assert.equal(app.getSortAria("contacts", "name"), "ascending");
  assert.deepEqual(Array.from(app.sortTableItems(records, "contacts", { name: (row) => row.name }), (row) => row.name), ["Alfa", "Zeta"]);
  app.changeMobileSort("contacts", "name:desc");
  assert.equal(app.getSortAria("contacts", "name"), "descending");
  assert.deepEqual(Array.from(app.sortTableItems(records, "contacts", { name: (row) => row.name }), (row) => row.name), ["Zeta", "Alfa"]);
  app.changeMobileSort("contacts", "name:invalid");
  assert.equal(app.getMobileSortValue("contacts"), "name:desc");
  app.changeMobileSort("contacts", "");
  assert.equal(app.getSortAria("contacts", "name"), "none");
  assert.equal(app.getMobileSortValue("contacts"), "");
});

test("reset filter laporan dan jaringan membersihkan kondisi yang aktif tanpa mengubah jumlah baris", () => {
  const app = createApp();
  app.formatDateInput = () => "2026-11-08";
  app.billingPeriod = "2026-11";
  app.revenueDateFrom = "2026-10-01";
  app.revenueDateTo = "2026-10-31";
  app.activeRevenueTab = "customers";
  app.filters.revenue = { search: "Alea", status: "PARTIAL", page: 4, pageSize: 50 };
  assert.equal(app.hasRevenueFilters, true);
  app.resetRevenueFilters();
  assert.equal(app.hasRevenueFilters, false);
  assert.equal(app.revenueDateFrom, "2026-11-01");
  assert.equal(app.revenueDateTo, "2026-11-08");
  assert.equal(app.revenueRangeError, "");
  assert.deepEqual({ ...app.filters.revenue }, { search: "", status: "ALL", page: 1, pageSize: 50 });

  app.filters.voucherRevenue = { search: "vcr", profile: "VCR", page: 3, pageSize: 25 };
  assert.equal(app.hasVoucherRevenueFilters, true);
  app.resetVoucherRevenueFilters();
  assert.equal(app.hasVoucherRevenueFilters, false);
  assert.deepEqual({ ...app.filters.voucherRevenue }, { search: "", profile: "ALL", page: 1, pageSize: 25 });

  app.filters.monitorAp = { search: "ap", status: "DOWN", linkStatus: "LINKED", page: 3, pageSize: 100 };
  assert.equal(app.hasMonitorApFilters, true);
  app.resetMonitorApFilters();
  assert.equal(app.hasMonitorApFilters, false);
  assert.deepEqual({ ...app.filters.monitorAp }, { search: "", status: "ALL", linkStatus: "ALL", page: 1, pageSize: 100 });
  for (const name of ["Revenue", "VoucherRevenue", "MonitorAp"]) {
    assert.ok(html.includes(`@click="reset${name}Filters()"`));
    assert.ok(html.includes(`:disabled="!has${name}Filters"`));
  }
});

test("toolbar jaringan dan log punya nama aksesibel serta pencarian tidak dipaksa melebar", () => {
  assert.match(html, /aria-label="Filter status jaringan"/);
  assert.match(html, /aria-label="Filter keterkaitan pelanggan dengan AP"/);
  assert.match(html, /aria-label="Jumlah log per halaman"/);
  assert.match(css, /\.filter-inline \.filter-inline-search \{\s*min-width: 0 !important;/);
});

test("semua pencarian tabel memperbarui hasil dan mengembalikan halaman pertama", () => {
  const app = createApp();
  const tableKeys = ["contacts", "contactBilling", "contactHotspot", "revenue", "voucherRevenue", "monitorAp", "reminders", "sent"];
  for (const tableKey of tableKeys) {
    const input = new RegExp(`x-model="filters\\.${tableKey}\\.search"[^>]*@input="handleTableSearchInput\\('${tableKey}', \\$event\\.target\\.value\\)"`);
    assert.match(html, input);
    app.filters[tableKey].page = 3;
    app.handleTableSearchInput(tableKey, "Alea");
    assert.equal(app.filters[tableKey].search, "Alea");
    assert.equal(app.filters[tableKey].page, 1);
  }
  app.handleTableSearchInput("logs", "ignored");
  assert.equal(app.filters.logs.search, undefined);
});

test("Jadwal mencari gabungan nama, nomor WA, jenis waktu, tanggal, template, dan pesan", () => {
  const app = createApp();
  app.reminders = [
    {
      id: "r-alea", contactName: "Alea Putri", phoneNumber: "6281234567890",
      deliveryScheduleType: "GRACE_PERIOD", billingCycle: "PREPAID",
      deliveryDateTime: "2026-11-15T03:00:00.000Z",
      reminderDateTime: "2026-11-16T03:00:00.000Z",
      templateName: "PaketPrabayar.txt", message: "Paket WiFi akan segera berakhir",
    },
    {
      id: "r-bima", contactName: "Bima", phoneNumber: "6287654321098",
      deliveryScheduleType: "BILLING_DUE", billingCycle: "PREPAID",
      deliveryDateTime: "2026-11-20T03:00:00.000Z",
      reminderDateTime: "2026-11-20T03:00:00.000Z",
      templateName: "Reminder.txt", message: "Tagihan prabayar",
    },
  ];
  const find = (search) => {
    app.handleTableSearchInput("reminders", search);
    return Array.from(app.filteredReminders, (row) => row.id);
  };
  assert.deepEqual(find("alea"), ["r-alea"]);
  assert.deepEqual(find("putri 081234567890"), ["r-alea"]);
  assert.deepEqual(find("masa tenggang paket"), ["r-alea"]);
  assert.deepEqual(find("16/11/2026 alea"), ["r-alea"]);
  assert.deepEqual(find("PAKETPRABAYAR WIFI"), ["r-alea"]);
  assert.deepEqual(find("BIMA pengingat masa aktif paket"), ["r-bima"]);
  assert.deepEqual(find("alea masa aktif paket berakhir"), ["r-alea"]);
  assert.deepEqual(find("nama tidak ada"), []);
  assert.deepEqual(find(""), ["r-alea", "r-bima"]);
  app.filters.reminders.schedule = "UPCOMING";
  app.resetReminderFilters();
  assert.equal(app.filters.reminders.search, "");
  assert.equal(app.filters.reminders.schedule, "ALL");
});

test("pencarian cocok dengan label, angka, dan tanggal yang benar-benar terlihat di laporan", () => {
  const app = createApp();
  app.revenueDateFrom = "2026-11-01";
  app.revenueDateTo = "2026-11-30";
  app.contacts = [{
    id: "p-1",
    name: "Alea",
    phoneNumber: "6281234567890",
    monthlyPaymentAmount: 75000,
    paymentMonths: {
      "2026-11": {
        status: "PAID",
        paidAmount: 75000,
        paidDate: "2026-11-09T03:00:00.000Z",
      },
    },
  }];
  app.handleTableSearchInput("revenue", "Alea Lunas 75.000");
  assert.equal(app.filteredRevenueEntries.length, 1);
  app.handleTableSearchInput("revenue", "Nov 2026 081234567890");
  assert.equal(app.filteredRevenueEntries.length, 1);
  app.handleTableSearchInput("revenue", "Pelanggan Tidak Ada");
  assert.equal(app.filteredRevenueEntries.length, 0);

  app.voucherRevenue.entries = [{
    id: "v-1", username: "voucher-001", profile: "Paket 4 Jam",
    amount: 3000, costPrice: 1000, commission: 2000,
    validity: "4h", usedAt: "2026-11-09T03:00:00.000Z",
  }];
  app.handleTableSearchInput("voucherRevenue", "voucher 09/11/2026");
  assert.equal(app.filteredVoucherRevenueEntries.length, 1);
  app.handleTableSearchInput("voucherRevenue", "paket 2000");
  assert.equal(app.filteredVoucherRevenueEntries.length, 1);
});

test("pencarian jaringan, riwayat, dan voucher menangani status lokal", () => {
  const app = createApp();
  app.apMonitors = [{
    id: "ap-1", host: "ap-utama.local", status: "UP",
    linkStatus: "LINKED", linkedContacts: [{ name: "Alea", phoneNumber: "6281234567890" }],
    customerCount: 1, since: "2026-11-01",
  }];
  app.handleTableSearchInput("monitorAp", "Terhubung Alea");
  assert.equal(app.filteredApMonitors.length, 1);
  app.handleTableSearchInput("monitorAp", "081234567890");
  assert.equal(app.filteredApMonitors.length, 1);
  app.sent = [{
    id: "s-1", contactName: "Alea", phoneNumber: "6281234567890",
    deliveryStatus: "UNCONFIRMED", sentAt: "2026-11-09T03:00:00.000Z",
    message: "Pesan terkirim",
  }];
  app.handleTableSearchInput("sent", "belum terkonfirmasi Alea");
  assert.equal(app.filteredSent.length, 1);

  app.voucherBatches = [{
    batchId: "b-1", profile: "Paket Harian", createdAt: "2026-11-09T03:00:00.000Z",
    vouchers: [{ username: "test-1", password: "rahasia", usageStatus: "USED", usedAt: "2026-11-09T03:00:00.000Z" }],
  }];
  app.voucherBatchFilters.search = "sudah digunakan paket";
  assert.equal(app.filteredVoucherBatchVouchers.length, 1);
  app.voucherBatchFilters.search = "tidak ditemukan";
  assert.equal(app.filteredVoucherBatchVouchers.length, 0);
});

test("pencarian di seluruh menu memakai pencocokan kata tanpa mengubah filter dan halaman lain", () => {
  const app = createApp();
  app.contacts = [{ name: "Alea Putri", phoneNumber: "+62 812-3456-7890", id: "p-1", mikrotikUsername: "alea", monthlyPaymentAmount: 75000 }];
  app.handleTableSearchInput("contacts", "PUTRI 081234567890");
  assert.equal(app.filteredContacts.length, 1);
  app.handleTableSearchInput("contactBilling", "alea 75000");
  assert.equal(app.filteredBillingContacts.length, 1);
  app.handleTableSearchInput("contactHotspot", "alea");
  assert.equal(app.filteredHotspotContacts.length, 1);
  app.handleTableSearchInput("contacts", "tidak cocok");
  assert.equal(app.filteredContacts.length, 0);
  assert.equal(app.filters.contactBilling.search, "alea 75000");
  assert.equal(app.filters.contactHotspot.search, "alea");
});
