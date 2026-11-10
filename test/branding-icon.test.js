const assert = require("node:assert/strict");
const test = require("node:test");
const { DataManager } = require("../src/app");
const { MAX_APP_ICON_BYTES, parseAppIconDataUrl } = require("../src/branding-icon");

const IMAGE_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2Z8AAAAASUVORK5CYII=";
const IMAGE_DATA_URL = `data:image/png;base64,${IMAGE_BASE64}`;

test("validasi ikon menerima PNG dan menolak SVG, data palsu, serta berkas terlalu besar", () => {
  const parsed = parseAppIconDataUrl(IMAGE_DATA_URL);
  assert.equal(parsed.contentType, "image/png");
  assert.equal(parsed.base64, IMAGE_BASE64);
  assert.match(parsed.version, /^[a-f0-9]{20}$/);
  assert.throws(() => parseAppIconDataUrl("data:image/svg+xml;base64,PHN2Zz48L3N2Zz4="), /Format ikon tidak valid/);
  assert.throws(() => parseAppIconDataUrl("data:image/png;base64,AAAB"), /Berkas ikon tidak valid/);
  assert.throws(() => parseAppIconDataUrl(`data:image/png;base64,${"A".repeat(Math.ceil(MAX_APP_ICON_BYTES * 4 / 3) + 8)}`), /Ukuran ikon melebihi/);
});

test("ikon tersimpan di baris database terpisah dari pengaturan dan dapat dimuat ulang", async () => {
  const stored = new Map();
  const table = {
    upsert: async (row) => { stored.set(row.key, structuredClone(row.value)); },
    destroy: async ({ where }) => { stored.delete(where.key); },
    findByPk: async (key) => stored.has(key) ? { value: stored.get(key) } : null,
  };
  const manager = new DataManager({ push() {} });
  manager.models.Setting = table;
  manager.saveSettings = async () => {};
  const created = await manager.saveAppBrandIcon(IMAGE_DATA_URL);
  assert.equal(created.hasIcon, true);
  assert.equal(stored.has("app-icon"), true);
  assert.equal(stored.has("app"), false);
  assert.equal(manager.getAppBrandIconMeta().version, created.version);
  assert.equal(manager.getSettings().appBrandName, "Reminder Bot");
  assert.doesNotMatch(JSON.stringify(manager.getSettings()), /iVBORw0/);

  await manager.updateSettings({
    appBrandName: "Emmeril Hotspot",
    appBrandSubtitle: "Pusat Pelanggan",
    dashboardTitle: "Dashboard WiFi",
  });
  assert.equal(manager.getSettings().appBrandName, "Emmeril Hotspot");
  assert.equal(manager.getSettings().appBrandSubtitle, "Pusat Pelanggan");
  assert.equal(manager.getAppBrandIconMeta().version, created.version);

  const restored = new DataManager({ push() {} });
  restored.models = {
    Setting: table,
    Role: { findAll: async () => [] },
  };
  restored.loadJsonPayloadMap = async () => new Map();
  await restored.loadFromDatabase();
  assert.equal(restored.getAppBrandIconMeta().version, created.version);
  assert.equal(restored.getAppBrandIcon().base64, IMAGE_BASE64);

  const deleted = await manager.deleteAppBrandIcon();
  assert.deepEqual(deleted, { hasIcon: false, version: "" });
  assert.equal(stored.has("app-icon"), false);
});

test("nama aplikasi divalidasi dan tidak mengubah identitas jika gagal disimpan", async () => {
  const manager = new DataManager({ push() {} });
  manager.saveSettings = async () => {};
  assert.throws(() => parseAppIconDataUrl(""), /Format ikon tidak valid/);
  await assert.rejects(() => manager.updateSettings({ appBrandName: "" }), /Nama aplikasi harus berisi/);
  await assert.rejects(() => manager.updateSettings({ appBrandName: "A".repeat(65) }), /Nama aplikasi harus berisi/);
  await assert.rejects(() => manager.updateSettings({ appBrandSubtitle: "A".repeat(101) }), /Keterangan aplikasi maksimal/);
  assert.equal(manager.getSettings().appBrandName, "Reminder Bot");
});
