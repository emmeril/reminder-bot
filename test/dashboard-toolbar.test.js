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
  assert.deepEqual(app.sortTableItems(records, "contacts", { name: (row) => row.name }).map((row) => row.name), ["Alfa", "Zeta"]);
  app.changeMobileSort("contacts", "name:desc");
  assert.equal(app.getSortAria("contacts", "name"), "descending");
  assert.deepEqual(app.sortTableItems(records, "contacts", { name: (row) => row.name }).map((row) => row.name), ["Zeta", "Alfa"]);
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
