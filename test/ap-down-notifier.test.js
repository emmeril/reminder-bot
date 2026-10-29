const assert = require("node:assert/strict");
const test = require("node:test");

const { DEFAULT_SETTINGS } = require("../src/config");
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

function createFixture() {
  let monitors = [{ host: "ap-pelanggan.local", status: "UP", since: "" }];
  const contacts = [
    { id: "one", name: "Satu", phoneNumber: "628111111111", linkedApHost: "AP-PELANGGAN.LOCAL" },
    { id: "two", name: "Dua", phoneNumber: "628222222222", linkedApHost: "ap-pelanggan.local" },
  ];
  const sendCalls = [];
  const attempts = new Map();
  const notifier = new ApDownNotifier(
    { getNetwatchStatus: async () => monitors },
    {
      sendMessage: async (phoneNumber) => {
        sendCalls.push(phoneNumber);
        const count = (attempts.get(phoneNumber) || 0) + 1;
        attempts.set(phoneNumber, count);
        if (phoneNumber === contacts[1].phoneNumber && count === 1) {
          throw new Error("transport sementara gagal");
        }
      },
    },
    {
      getContacts: () => contacts,
      getSettings: () => ({
        notifyContactsOnApDown: true,
        apDownMinimumDownMinutes: 1,
        apDownMessageTemplate: "AP {{host}} down untuk {{name}}",
      }),
    },
    { push() {} }
  );

  return {
    notifier,
    sendCalls,
    setMonitors(value) {
      monitors = value;
    },
  };
}

test("tidak mencoba ulang kontak AP DOWN yang gagal dikirimi", async () => {
  const fixture = createFixture();
  await fixture.notifier.processNetwatchChanges();

  const since = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  fixture.setMonitors([{ host: "ap-pelanggan.local", status: "DOWN", since }]);
  await fixture.notifier.processNetwatchChanges();
  await fixture.notifier.processNetwatchChanges();

  assert.deepEqual(fixture.sendCalls, [
    "628111111111",
    "628222222222",
  ]);
  assert.equal(fixture.notifier.monitorStates.get("ap-pelanggan.local").alertAttempted, true);
  assert.deepEqual(
    Array.from(fixture.notifier.monitorStates.get("ap-pelanggan.local").attemptedContactIds),
    ["one", "two"]
  );
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
      getContacts: () => [],
      getSettings: () => ({ notifyContactsOnApDown: true, apDownMinimumDownMinutes: 1 }),
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
