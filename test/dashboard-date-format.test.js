const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function createDashboardApp() {
  const source = fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8");
  const dashboardApp = vm.runInNewContext(`${source}\n;dashboardApp`, {
    window: { matchMedia: () => ({ matches: false }) },
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
