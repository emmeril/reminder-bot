const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const { Sequelize, DataTypes, Op } = require("sequelize");
const DataManager = require("../src/modules/data-manager/service");
const MikrotikService = require("../src/modules/mikrotik/service");

function createDashboard() {
  const intervals = new Map();
  const timeouts = new Map();
  let timerId = 0;
  const context = {
    window: { location: { search: "" }, matchMedia: () => ({ matches: false }) },
    document: { hidden: false },
    localStorage: { getItem: () => null, setItem() {} },
    URLSearchParams,
    setTimeout: (fn) => { timeouts.set(++timerId, fn); return timerId; },
    clearTimeout: (id) => timeouts.delete(id),
    setInterval: (fn) => { intervals.set(++timerId, fn); return timerId; },
    clearInterval: (id) => intervals.delete(id),
  };
  const sources = ["state", "ui", "selectors", "data", "actions"]
    .map((name) => `public/dashboard/${name}.js`).concat("public/app.js")
    .map((file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8")).join("\n");
  const app = vm.runInNewContext(`${sources}\n;dashboardApp()`, context);
  app.$watch = () => {};
  return { app, intervals, timeouts };
}

test("inisialisasi berulang tidak menggandakan permintaan atau polling dan tidak memuat seluruh akun hotspot", async () => {
  const { app, intervals, timeouts } = createDashboard();
  const calls = [];
  for (const name of ["loadStatus", "loadContacts", "loadReminders", "loadTemplates", "loadApMonitors",
    "loadMikrotikProfiles", "loadHotspotUsers", "loadSent", "loadRecipients", "loadLogs"]) {
    app[name] = async () => { calls.push(name); };
  }
  await Promise.all([app.init(), app.init()]);
  for (const run of timeouts.values()) run();
  assert.equal(calls.filter((name) => name === "loadStatus").length, 1);
  assert.equal(calls.filter((name) => name === "loadContacts").length, 1);
  assert.equal(calls.includes("loadHotspotUsers"), false);
  assert.equal(calls.length, 9);
  app.startPolling();
  assert.equal(intervals.size, 2);
  assert.doesNotMatch(fs.readFileSync(path.join(__dirname, "../public/index.html"), "utf8"), /x-init="init\(\)"/);
  app.destroy();
  assert.equal(intervals.size, 0);
  assert.equal(timeouts.size, 0);
});

test("polling lambat tidak memulai permintaan baru sebelum permintaan sebelumnya selesai", async () => {
  const { app, intervals } = createDashboard();
  let finish;
  let calls = 0;
  app.loadStatus = () => { calls += 1; return new Promise((resolve) => { finish = resolve; }); };
  app.startPolling();
  const poll = [...intervals.values()][0];
  const pending = poll();
  await poll();
  assert.equal(calls, 1);
  finish();
  await pending;
  const next = poll();
  assert.equal(calls, 2);
  finish();
  await next;
  app.destroy();
});

test("respons pencarian lama tidak menimpa username dan profile hasil pencarian terbaru", async () => {
  const { app } = createDashboard();
  const pending = [];
  app.api = (url) => new Promise((resolve) => pending.push({ url, resolve }));
  app.forms.hotspotAccount.username = "rumah baru";
  const older = app.loadHotspotUsers({ silent: true, query: "lama" });
  const newer = app.loadHotspotUsers({ silent: true, query: "rumah baru" });
  assert.match(pending[1].url, /limit=30&q=rumah%20baru$/);
  pending[1].resolve([{ username: "rumah baru", profile: "Rumah" }]);
  await newer;
  pending[0].resolve([{ username: "lama", profile: "Lama" }]);
  await older;
  assert.equal(app.hotspotUsers[0].username, "rumah baru");
  assert.equal(app.forms.hotspotAccount.profile, "Rumah");
});

test("pencarian hotspot membatasi hasil, mendahulukan nama persis, dan berbagi satu pembacaan router", async () => {
  const service = new MikrotikService({ push() {} });
  let calls = 0;
  service.getHotspotUsers = async () => {
    calls += 1;
    return Array.from({ length: 150 }, (_, i) => ({ username: `rumah${i}`, profile: "Rumah" }));
  };
  const [all, match] = await Promise.all([service.searchHotspotUsers(), service.searchHotspotUsers("RUMAH1", 2)]);
  assert.equal(calls, 1);
  assert.equal(all.length, 30);
  assert.deepEqual(match.map((row) => row.username), ["rumah1", "rumah10"]);
  assert.equal((await service.searchHotspotUsers("", 10000)).length, 100);
  service.hotspotUserCache.expiresAt = 0;
  await service.searchHotspotUsers("missing");
  assert.equal(calls, 2);
});

test("pencarian hotspot dapat dicoba ulang setelah router gagal", async () => {
  const service = new MikrotikService({ push() {} });
  let calls = 0;
  service.getHotspotUsers = async () => {
    if (++calls === 1) throw new Error("router offline");
    return [{ username: "pulih" }];
  };
  await assert.rejects(service.searchHotspotUsers(), /router offline/);
  assert.equal((await service.searchHotspotUsers())[0].username, "pulih");
});

test("daftar pelanggan publik menghitung setiap pelanggan sekali dan tetap menyembunyikan kredensial", () => {
  const manager = new DataManager({ push() {} });
  manager.contacts.set("1", { id: "1", name: "Rumah", mikrotikPassword: "secret", hotspotProvisioningPrevious: { password: "secret" } });
  let hydrations = 0;
  const hydrate = manager.hydrateContact.bind(manager);
  manager.hydrateContact = (contact) => { hydrations += 1; return hydrate(contact); };
  const contacts = manager.getSortedContacts({ publicView: true });
  assert.equal(hydrations, 1);
  assert.equal(contacts[0].mikrotikPassword, undefined);
  assert.equal(contacts[0].hotspotProvisioningPrevious, undefined);
  assert.equal(manager.contacts.get("1").mikrotikPassword, "secret");
});

test("ringkasan memakai waktu retry dan menghitung pesan hari ini tanpa menyiapkan seluruh riwayat", () => {
  const manager = new DataManager({ push() {} });
  manager.settings.timezone = "Asia/Jakarta";
  manager.hydrateContact = manager.hydrateReminder = () => { throw new Error("full hydration"); };
  manager.reminders.set("late", { id: "late", reminderDateTime: "2026-11-19T00:00:00Z" });
  manager.reminders.set("retry", { id: "retry", reminderDateTime: "2026-11-17T00:00:00Z", nextDeliveryAttemptAt: "2026-11-18T01:00:00Z" });
  manager.sentReminders.set("today", { sentAt: "2026-11-17T18:00:00Z", deliveryStatus: "DELIVERED" });
  manager.sentReminders.set("yesterday", { sentAt: "2026-11-17T16:00:00Z", deliveryStatus: "SENT" });
  manager.sentReminders.set("failed", { sentAt: "2026-11-18T01:00:00Z", deliveryStatus: "FAILED" });
  const summary = manager.getDashboardSummary(new Date("2026-11-18T03:00:00Z"));
  assert.equal(summary.nextReminderAt, "2026-11-18T01:00:00.000Z");
  assert.equal(summary.sentToday, 1);
  assert.equal(summary.sentReminders, 3);
});

test("penyimpanan hanya menulis baris berubah, menghapus ID yang hilang, dan pulih setelah rollback", async (t) => {
  const sequelize = new Sequelize({ dialect: "sqlite", storage: ":memory:", logging: false });
  t.after(() => sequelize.close());
  const Contact = sequelize.define("Contact", {
    id: { type: DataTypes.STRING, primaryKey: true },
    data: { type: DataTypes.JSON, allowNull: false },
  }, { tableName: "contacts" });
  await sequelize.sync();
  const manager = new DataManager({ push() {} });
  manager.sequelize = sequelize;
  manager.models.Contact = Contact;
  const writes = [];
  const deletes = [];
  Contact.addHook("beforeBulkCreate", (instances) => writes.push(instances.map((row) => row.id)));
  Contact.addHook("beforeBulkDestroy", (options) => deletes.push(options.where.id[Op.in]));
  manager.contacts.set("a", { id: "a", name: "Awal" });
  manager.contacts.set("b", { id: "b", name: "Tetap" });
  await manager.saveContacts();
  const unchanged = await Contact.findByPk("b");
  writes.length = 0;
  await manager.saveContacts();
  assert.equal(writes.length, 0);
  assert.equal(deletes.length, 0);

  manager.contacts.get("a").name = "Baru";
  await manager.saveContacts();
  assert.deepEqual(writes, [["a"]]);
  assert.equal((await Contact.findByPk("b")).updatedAt.getTime(), unchanged.updatedAt.getTime());

  await assert.rejects(manager.withDataMutation(async () => {
    manager.contacts.get("a").name = "Rollback";
    manager.contacts.delete("b");
    await manager.withDatabaseWrite(() => sequelize.transaction(async (transaction) => {
      await manager.saveContacts({ transaction });
      throw new Error("abort transaction");
    }));
  }), /abort transaction/);
  assert.equal(manager.contacts.get("a").name, "Baru");
  assert.equal(manager.contacts.has("b"), true);
  assert.equal((await Contact.findByPk("a")).data.name, "Baru");
  assert.equal(await Contact.count(), 2);

  manager.contacts.get("a").name = "Rollback";
  await manager.saveContacts();
  assert.equal((await Contact.findByPk("a")).data.name, "Rollback");
  deletes.length = 0;
  manager.contacts.delete("b");
  await manager.saveContacts();
  assert.deepEqual(deletes, [["b"]]);
  assert.equal(await Contact.count(), 1);
  manager.contacts.clear();
  await manager.saveContacts();
  assert.equal(await Contact.count(), 0);
});
