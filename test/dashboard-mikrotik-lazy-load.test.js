const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const file = path.join(__dirname, "../public/dashboard/ui.js");
const code = fs.readFileSync(file, "utf8");
const createUi = vm.runInNewContext(`${code}\ncreateDashboardUi`);

function mockDashboard() {
  const dashboard = createUi();
  const calls = [];
  dashboard.activeMenu = "overview";
  dashboard.activeContactTab = "data";
  dashboard.activeSettingsTab = "general";
  dashboard.apMonitors = [];
  dashboard.hotspotUsers = [];
  dashboard.mikrotikProfiles = [];
  for (const method of [
    "loadApMonitors",
    "loadHotspotUsers",
    "loadMikrotikProfiles",
    "loadSent",
    "loadRecipients",
    "loadLogs",
  ]) {
    dashboard[method] = async (options) => {
      calls.push({ method, options });
    };
  }
  return { dashboard, calls };
}

test("pemuatan data tambahan tidak menghubungi MikroTik dari ringkasan", async () => {
  const { dashboard, calls } = mockDashboard();
  await dashboard.loadNonCriticalData();
  assert.deepEqual(calls.map(({ method }) => method), [
    "loadSent", "loadRecipients", "loadLogs",
  ]);
  calls.length = 0;
  await dashboard.loadVisibleMikrotikData();
  assert.deepEqual(calls, []);
});

test("pembacaan MikroTik mengikuti menu yang dibuka", async () => {
  const { dashboard, calls } = mockDashboard();
  dashboard.activeMenu = "monitor-ap";
  await dashboard.loadVisibleMikrotikData();
  assert.deepEqual(calls.map(({ method }) => method), ["loadApMonitors"]);

  calls.length = 0;
  dashboard.activeMenu = "contacts";
  dashboard.activeContactTab = "hotspot";
  await dashboard.loadVisibleMikrotikData();
  assert.deepEqual(calls.map(({ method }) => method), ["loadHotspotUsers", "loadMikrotikProfiles"]);

  calls.length = 0;
  dashboard.activeMenu = "settings";
  dashboard.activeSettingsTab = "rates";
  await dashboard.loadVisibleMikrotikData();
  assert.deepEqual(calls.map(({ method }) => method), ["loadMikrotikProfiles"]);
});

test("refresh manual meminta data terbaru pada menu aktif saja", async () => {
  const { dashboard, calls } = mockDashboard();
  dashboard.activeMenu = "monitor-ap";
  dashboard.apMonitors = [{ host: "192.0.2.10" }];
  await dashboard.loadVisibleMikrotikData();
  assert.equal(calls.length, 0);

  await dashboard.loadVisibleMikrotikData({ refresh: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "loadApMonitors");
  assert.equal(calls[0].options.fresh, true);
});

test("voucher memuat data berat berurutan sesuai tab aktif", async () => {
  const { dashboard } = mockDashboard();
  const calls = [];
  for (const method of ["loadVoucherOptions", "loadVoucherBatches", "loadVoucherStats"]) {
    dashboard[method] = async () => { calls.push(method); };
  }
  dashboard.activeMenu = "overview";
  dashboard.activeVoucherTab = "create";
  await dashboard.loadVisibleVoucherData();
  assert.deepEqual(calls, []);

  dashboard.activeMenu = "vouchers";
  await dashboard.loadVisibleVoucherData();
  assert.deepEqual(calls, ["loadVoucherOptions", "loadVoucherBatches"]);

  calls.length = 0;
  dashboard.activeVoucherTab = "profiles";
  await dashboard.loadVisibleVoucherData();
  assert.deepEqual(calls, ["loadVoucherOptions"]);

  calls.length = 0;
  dashboard.activeVoucherTab = "stats";
  await dashboard.loadVisibleVoucherData();
  assert.deepEqual(calls, ["loadVoucherStats"]);
});

test("pergantian tab tidak memuat batch voucher setelah pengguna keluar", async () => {
  const { dashboard } = mockDashboard();
  dashboard.activeMenu = "vouchers";
  dashboard.activeVoucherTab = "create";
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const calls = [];
  dashboard.loadVoucherOptions = async () => { await gate; calls.push("options"); };
  dashboard.loadVoucherBatches = async () => { calls.push("batches"); };

  const task = dashboard.loadVisibleVoucherData();
  dashboard.activeMenu = "contacts";
  release();
  await task;
  assert.deepEqual(calls, ["options"]);
});
