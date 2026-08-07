const assert = require("node:assert/strict");
const test = require("node:test");

const { ApDownNotifier } = require("../src/schedulers");

function createFixture() {
  let monitors = [{ host: "10.0.0.1", status: "UP", since: "" }];
  const contacts = [
    { id: "one", name: "Satu", phoneNumber: "628111111111", linkedApHost: "10.0.0.1" },
    { id: "two", name: "Dua", phoneNumber: "628222222222", linkedApHost: "10.0.0.1" },
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
  fixture.setMonitors([{ host: "10.0.0.1", status: "DOWN", since }]);
  await fixture.notifier.processNetwatchChanges();
  await fixture.notifier.processNetwatchChanges();

  assert.deepEqual(fixture.sendCalls, [
    "628111111111",
    "628222222222",
  ]);
  assert.equal(fixture.notifier.monitorStates.get("10.0.0.1").alertAttempted, true);
  assert.deepEqual(
    Array.from(fixture.notifier.monitorStates.get("10.0.0.1").attemptedContactIds),
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
