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
  assert.match(html, /x-show="activeSettingsTab === 'backup'"[^>]*type="button" @click="sendBackupsNow\(\)"/);
  assert.ok(html.includes('@submit.prevent="saveSettings()"'));
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
    URLSearchParams,
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


test("zona waktu Umum dan Backup memakai dropdown dan menyimpan nilai IANA", () => {
  for (const [tab, field] of [["general", "timezone"], ["backup", "mikrotikBackupTimezone"]]) {
    const markup = panel(tab);
    const select = markup.match(new RegExp(`<select[^>]*x-model="forms\\.settings\\.${field}"[^>]*>[\\s\\S]*?<\\/select>`))?.[0];
    assert.ok(select, `Dropdown ${field} harus tersedia`);
    assert.match(select, /required/);
    assert.match(select, /x-for="zone in settingsTimezoneOptions"/);
    assert.match(select, /:value="zone.value"/);
    assert.doesNotMatch(markup, new RegExp(`<input[^>]*x-model="forms\\.settings\\.${field}"`));
  }
  assert.ok(html.includes('@submit.prevent="saveSettings()"'));
});

test("pilihan WIB WITA WIT tersedia dan zona waktu lama tidak hilang", () => {
  const createDashboardUi = vm.runInNewContext(uiSource + "\n;createDashboardUi");
  const app = createDashboardUi();
  app.forms = { settings: { timezone: "America/New_York", mikrotikBackupTimezone: "Europe/London" } };
  const zones = app.settingsTimezoneOptions;
  for (const value of ["Asia/Jakarta", "Asia/Makassar", "Asia/Jayapura", "UTC", "America/New_York", "Europe/London"]) {
    assert.ok(zones.some((zone) => zone.value === value), value);
  }
  assert.equal(zones.find((zone) => zone.value === "Asia/Jakarta").label, "WIB (UTC+07:00) - Jakarta");
  assert.equal(zones.find((zone) => zone.value === "America/New_York").label, "America/New_York (tersimpan)");
  app.forms.settings.timezone = "Asia/Makassar";
  assert.equal(app.settingsTimezoneOptions.filter((zone) => zone.value === "Asia/Makassar").length, 1);
  assert.ok(app.settingsTimezoneOptions.some((zone) => zone.value === "Europe/London"));
});


test("tab Backup menampilkan jadwal database dan opsi pengiriman Telegram yang terpisah", () => {
  const backup = panel("backup");
  for (const field of ["mikrotikBackupTime", "databaseBackupTime"]) {
    assert.match(backup, new RegExp(`<input[^>]*x-model="forms\\.settings\\.${field}"[^>]*type="time"[^>]*required`));
    assert.equal(html.match(new RegExp(`x-model="forms\\.settings\\.${field}"`, "g")).length, 1);
  }
  assert.match(backup, /x-model="forms\.settings\.enableMikrotikBackupToWa"[^>]*type="checkbox"/);
  assert.match(backup, /x-model="forms\.settings\.enableDatabaseBackupToTelegram"[^>]*type="checkbox"/);
  assert.match(backup, /Zona waktu untuk kedua jadwal backup/);
  assert.match(backup, /Backup lokal tetap dibuat setiap hari/);
  assert.match(backup, /TELEGRAM_CHAT_IDS/);
  assert.match(backup, /md:grid-cols-2/);
});

test("tombol backup manual mengirim MikroTik dan database aplikasi", () => {
  const backup = panel("backup");
  assert.match(html, /@click="sendBackupsNow\(\)"/);
  assert.match(html, /Kirim Backup MikroTik & Aplikasi/);
  assert.doesNotMatch(html, /Kirim Backup MikroTik Sekarang/);
  assert.match(backup, /Tombol kirim manual mengirim kedua backup/);
});

test("Penerima admin hanya muncul di Pengaturan > Pengiriman dan tidak membuat form bersarang", () => {
  const html = fs.readFileSync(path.join(__dirname, "../public/index.html"), "utf8");
  const delivery = panel("delivery");
  const notificationsStart = html.indexOf('<aside x-show="activeMenu === \'notifications\'"');
  const notificationsEnd = html.indexOf("</aside>", notificationsStart);
  const notifications = html.slice(notificationsStart, notificationsEnd);
  assert.ok(notificationsStart > -1 && notificationsEnd > notificationsStart);
  assert.match(notifications, /Pesan personal/);
  assert.match(notifications, /Broadcast pelanggan/);
  assert.doesNotMatch(notifications, /Penerima admin|forms\.recipients|saveRecipients/);

  assert.match(delivery, /<h3[^>]*>Penerima admin<\/h3>/);
  assert.match(delivery, /<textarea[^>]*id="settings-admin-recipients"[^>]*x-model="forms\.recipients"/);
  assert.doesNotMatch(delivery, /@click="saveRecipients\(\)"|Simpan penerima admin/);
  assert.match(delivery, /x-show="formErrors\.recipients"/);
  assert.match(delivery, /@input\.stop="recipientsDirty = true" @change\.stop="recipientsDirty = true"/);
  assert.match(delivery, /Simpan perubahan melalui tombol Simpan Pengaturan/);
  assert.doesNotMatch(delivery, /<form\b/i);
  assert.equal(html.match(/x-model="forms\.recipients"/g)?.length, 1);
  assert.equal(html.match(/@click="saveRecipients\(\)"/g)?.length ?? 0, 0);
  assert.equal(html.match(/@submit\.prevent="saveSettings\(\)"/g)?.length, 1);
});

test("layout Kirim Pesan menampilkan dua formulir responsif", () => {
  const html = fs.readFileSync(path.join(__dirname, "../public/index.html"), "utf8");
  const aside = html.match(/<aside x-show="activeMenu === 'notifications'"[^>]*>/)?.[0];
  assert.ok(aside);
  assert.match(aside, /grid gap-6 md:grid-cols-2 w-full/);
  assert.doesNotMatch(aside, /xl:grid-cols-3/);
});
