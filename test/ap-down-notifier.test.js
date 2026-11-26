const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { CONFIG, DEFAULT_SETTINGS } = require("../src/config");
const DataManager = require("../src/modules/data-manager/service");
const { ApDownNotifier } = require("../src/schedulers");

test("template perangkat tidak aktif dirender ringkas tanpa variabel tersisa", () => {
  const notifier = new ApDownNotifier({}, {}, {}, { push() {} });
  const message = notifier.renderApDownMessage(DEFAULT_SETTINGS.apDownMessageTemplate, {
    name: "Pelanggan Satu",
    host: "ap-pelanggan.local",
    status: "DOWN",
    companyName: "Emmeril Hotspot",
    supportSignature: "CS Emmeril Hotspot",
  });

  assert.match(message, /^\*Pemberitahuan Perangkat\*/);
  assert.match(message, /Yth\. Bapak\/Ibu Pelanggan Satu/);
  assert.match(message, /Perangkat WiFi ap-pelanggan\.local terdeteksi tidak aktif/);
  assert.doesNotMatch(message, /{{|}}/);
});

async function createFixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ap-down-notifier-"));
  const originalStorage = CONFIG.DB_STORAGE;
  const originalDatabaseUrl = process.env.DATABASE_URL;
  CONFIG.DB_STORAGE = path.join(directory, "db.sqlite");
  delete process.env.DATABASE_URL;
  let manager;
  t.after(async () => {
    await manager?.close();
    CONFIG.DB_STORAGE = originalStorage;
    if (originalDatabaseUrl !== undefined) process.env.DATABASE_URL = originalDatabaseUrl;
    await fs.rm(directory, { recursive: true, force: true });
  });

  const host = "ap-pelanggan.local";
  let monitors = [{ host, status: "UP", since: "" }];
  const contacts = [
    { id: "one", name: "Satu", phoneNumber: "628111111111", linkedApHost: "AP-PELANGGAN.LOCAL" },
    { id: "two", name: "Dua", phoneNumber: "628222222222", linkedApHost: host },
  ];
  const sendCalls = [];
  const activityLog = { push() {} };
  let failSecondContact = options.failSecondContact === true;
  const notificationBot = {
    sendMessage: async (phoneNumber) => {
      sendCalls.push(phoneNumber);
      if (failSecondContact && phoneNumber === contacts[1].phoneNumber) {
        failSecondContact = false;
        throw new Error("transport sementara gagal");
      }
      return { deliveryStatus: "accepted" };
    },
  };

  async function restart() {
    await manager?.close();
    manager = new DataManager(activityLog);
    await manager.initDatabase();
    manager.settings.apDownMinimumDownMinutes = 1;
    manager.contacts = new Map(contacts.map((contact) => [contact.id, contact]));

    return new ApDownNotifier(
      { getNetwatchStatus: async () => monitors },
      notificationBot,
      manager,
      activityLog
    );
  }

  return {
    notifier: await restart(),
    restart,
    sendCalls,
    get manager() {
      return manager;
    },
    readAttempts: async () => {
      const rows = await manager.models.ApDownNotification.findAll({ order: [["contactId", "ASC"]] });
      return rows.map((row) => row.get({ plain: true }));
    },
    setMonitors(value) {
      monitors = value;
    },
    setStatus(status, since = "") {
      monitors = [{ host, status, since }];
    },
  };
}

test("percobaan AP DOWN dan waktu kirim bertahan setelah bot dan database dibuka ulang", async (t) => {
  const fixture = await createFixture(t, { failSecondContact: true });
  await fixture.notifier.processNetwatchChanges();

  fixture.setStatus("DOWN", new Date().toISOString());
  await fixture.notifier.processNetwatchChanges();
  assert.equal(fixture.sendCalls.length, 0);

  const since = new Date(Date.now() - 10 * 60 * 1000);
  since.setMilliseconds(0);
  fixture.setStatus("DOWN", since.toISOString());
  await fixture.notifier.processNetwatchChanges();
  await fixture.notifier.processNetwatchChanges();

  assert.deepEqual(fixture.sendCalls, ["628111111111", "628222222222"]);
  const attempts = await fixture.readAttempts();
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0].status, "accepted");
  assert.ok(attempts[0].sentAt instanceof Date);
  assert.ok(attempts[0].sentAt >= attempts[0].attemptedAt);
  assert.equal(attempts[1].status, "failed");
  assert.equal(attempts[1].sentAt, null);

  const restarted = await fixture.restart();
  await restarted.processNetwatchChanges();
  fixture.setStatus("UNKNOWN");
  await restarted.processNetwatchChanges();
  fixture.setMonitors([]);
  await restarted.processNetwatchChanges();
  fixture.setStatus("DOWN", since.toUTCString());
  await restarted.processNetwatchChanges();
  assert.deepEqual(await fixture.readAttempts(), attempts);
  assert.equal(fixture.sendCalls.length, 2);

  fixture.setStatus("UP");
  await restarted.processNetwatchChanges();
  fixture.setStatus("DOWN", since.toISOString());
  await restarted.processNetwatchChanges();
  assert.equal(fixture.sendCalls.length, 4);
  assert.equal(new Set((await fixture.readAttempts()).map((attempt) => attempt.incidentId)).size, 2);
});

test("restart melanjutkan kontak lain tanpa mengirim ulang percobaan yang hasilnya belum tercatat", async (t) => {
  const fixture = await createFixture(t);
  const firstObservedAt = new Date(Date.now() - 5 * 60 * 1000);
  const incident = await fixture.manager.observeApDownIncident("ap-pelanggan.local", null, firstObservedAt);
  assert.equal(await fixture.manager.reserveApDownNotification(incident, "one"), true);
  assert.equal(await fixture.manager.reserveApDownNotification(incident, "one"), false);

  fixture.setStatus("DOWN");
  const restarted = await fixture.restart();
  await restarted.processNetwatchChanges();
  await restarted.processNetwatchChanges();

  fixture.setStatus("DOWN", new Date(firstObservedAt - 60000).toISOString());
  await restarted.processNetwatchChanges();
  assert.deepEqual(fixture.sendCalls, ["628222222222"]);
  const attempts = await fixture.readAttempts();
  assert.deepEqual(attempts.map((attempt) => attempt.status), ["pending", "accepted"]);
  assert.equal(attempts[0].sentAt, null);
  assert.equal(attempts[1].incidentId, incident.incidentId);

  fixture.setStatus("DOWN", new Date(firstObservedAt.getTime() + 60000).toISOString());
  await restarted.processNetwatchChanges();
  assert.deepEqual(fixture.sendCalls, ["628222222222", "628111111111", "628222222222"]);
});

test("mencegah pemeriksaan netwatch yang tumpang tindih", async () => {
  let resolveMonitors;
  let calls = 0;
  const notifier = new ApDownNotifier(
    {
      getNetwatchStatus: async () => {
        calls += 1;
        return new Promise((resolve) => {
          resolveMonitors = resolve;
        });
      },
    },
    { sendMessage: async () => {} },
    {
      getSettings: () => ({ notifyContactsOnApDown: true, apDownMinimumDownMinutes: 1 }),
      closeRecoveredApDownIncidents: async () => {},
    },
    { push() {} }
  );

  const firstRun = notifier.processNetwatchChanges();
  await Promise.resolve();
  await notifier.processNetwatchChanges();
  assert.equal(calls, 1);

  resolveMonitors([]);
  await firstRun;
  assert.equal(notifier.isProcessing, false);
});
