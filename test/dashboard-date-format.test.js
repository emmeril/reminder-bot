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
