const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const html = fs.readFileSync(path.join(__dirname, "../public/index.html"), "utf8");
const styles = fs.readFileSync(path.join(__dirname, "../public/styles.css"), "utf8");
const interfaceCss = fs.readFileSync(path.join(__dirname, "../public/interface.css"), "utf8");
const uiSource = fs.readFileSync(path.join(__dirname, "../public/dashboard/ui.js"), "utf8");
const tabs = ["general", "rates", "backup", "delivery", "isolation", "messages", "automation"];

function panel(key) {
  const start = html.indexOf(`<section id="settings-${key}-panel"`);
  assert.notEqual(start, -1, `Panel ${key} harus ada`);
  const end = html.indexOf("\n            </section>", start);
  assert.notEqual(end, -1);
  return html.slice(start, end);
}

test("setiap tab pengaturan punya panel yang sesuai, termasuk Pengiriman", () => {
  const navigation = html.match(/<div class="settings-tabs"[^>]*>[\s\S]*?<\/div>/)?.[0];
  assert.ok(navigation, "Navigasi tab pengaturan harus ada");
  assert.deepEqual(Array.from(navigation.matchAll(/id="settings-([a-z]+)-tab"/g), (match) => match[1]), tabs);
  for (const key of tabs) {
    assert.ok(navigation.includes(`aria-controls="settings-${key}-panel"`), key);
    assert.ok(navigation.includes(`selectSettingsTab('${key}')`), key);
    assert.ok(panel(key).includes(`aria-labelledby="settings-${key}-tab"`), key);
    assert.ok(panel(key).includes(`activeSettingsTab === '${key}'`), key);
  }
});

test("backup dan pengiriman tidak mencampur input, opsi aktivasi backup tetap tersedia", () => {
  const backup = panel("backup");
  const delivery = panel("delivery");
  for (const field of ["mikrotikBackupTime", "mikrotikBackupTimezone", "enableMikrotikBackupToWa"]) {
    assert.ok(backup.includes(`forms.settings.${field}`), `Backup: ${field}`);
    assert.ok(!delivery.includes(`forms.settings.${field}`), `Pengiriman tidak berisi ${field}`);
  }
  for (const field of ["waRandomDelayMinSeconds", "waRandomDelayMaxSeconds"]) {
    assert.ok(delivery.includes(`forms.settings.${field}`), `Pengiriman: ${field}`);
    assert.ok(!backup.includes(`forms.settings.${field}`), `Backup tidak berisi ${field}`);
  }
  assert.equal(html.match(/x-model="forms.settings.enableMikrotikBackupToWa"/g)?.length, 1);
  assert.match(html, /x-show="activeSettingsTab === 'backup'"[^>]*type="button" @click="sendMikrotikBackupNow\(\)"/);
  assert.match(html, /@submit.prevent="saveSettings\(\)"/);
});

test("Pengiriman dapat dipilih dengan klik dan panah keyboard", () => {
  let focused = "";
  const createDashboardUi = vm.runInNewContext(uiSource + "\n;createDashboardUi", {
    document: { getElementById: (id) => ({ focus: () => { focused = id; } }) },
  });
  const app = createDashboardUi();
  app.$nextTick = (callback) => callback();
  app.selectSettingsTab("delivery");
  assert.equal(app.activeSettingsTab, "delivery");
  app.selectAdjacentSettingsTab(1);
  assert.equal(app.activeSettingsTab, "isolation");
  assert.equal(focused, "settings-isolation-tab");
  app.selectAdjacentSettingsTab(-1);
  assert.equal(app.activeSettingsTab, "delivery");
  assert.equal(focused, "settings-delivery-tab");
  app.selectSettingsTab("not-a-tab");
  assert.equal(app.activeSettingsTab, "delivery");
  app.selectSettingsTab("automation");
  app.selectAdjacentSettingsTab(1);
  assert.equal(app.activeSettingsTab, "general");
});

test("tab Pengiriman tetap terpilih setelah halaman dimuat ulang", async () => {
  const memory = new Map([["dashboardSettingsTab", "delivery"]]);
  const watchers = {};
  const createDashboardUi = vm.runInNewContext(uiSource + "\n;createDashboardUi", {
    window: { location: { search: "" } },
    localStorage: {
      getItem: (key) => memory.get(key) || null,
      setItem: (key, value) => memory.set(key, value),
    },
    setTimeout: () => 1,
  });
  const app = createDashboardUi();
  app.navMenus = [];
  app.isMobile = false;
  app.$watch = (key, listener) => { watchers[key] = listener; };
  for (const action of ["loadStatus", "loadContacts", "loadReminders", "loadTemplates"]) {
    app[action] = async () => {};
  }
  app.startPolling = () => {};
  await app.init();
  assert.equal(app.activeSettingsTab, "delivery");
  app.selectSettingsTab("backup");
  watchers.activeSettingsTab(app.activeSettingsTab);
  assert.equal(memory.get("dashboardSettingsTab"), "backup");
});

test("tab beradaptasi di desktop, tablet, dan layar ponsel sempit", () => {
  assert.ok(styles.includes(".settings-tabs { display: grid; grid-template-columns: repeat(7,minmax(0,1fr));"));
  assert.ok(styles.includes("@media (min-width: 768px) and (max-width: 1279px) {"));
  assert.ok(styles.includes(".settings-tabs { grid-template-columns: repeat(4,minmax(0,1fr)); }"));
  assert.match(interfaceCss, /@media \(max-width: 767px\) \{[\s\S]*?\.settings-tabs \{\s*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\) !important;/);
  assert.match(interfaceCss, /@media \(max-width: 420px\) \{[\s\S]*?\.settings-tabs \{\s*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\) !important;/);
});
