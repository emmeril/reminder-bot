const assert = require("node:assert/strict");
const test = require("node:test");

const { WhatsAppProviderStatusNotifier } = require("../src/schedulers");

function buildStatus(connected) {
  const connectedProviders = connected ? ["baileys"] : [];

  return {
    providers: {
      baileys: {
        name: "baileys",
        configured: true,
        connection: {
          connected,
          detail: connected ? "Baileys terhubung" : "Baileys tidak siap",
        },
      },
    },
    transport: { connectedProviders },
  };
}

function createNotifier(initialStatus) {
  let currentStatus = initialStatus;
  const broadcasts = [];
  const logs = [];
  const notificationBot = {
    async getTransportStatus() {
      return currentStatus;
    },
    async sendAdminBroadcast(title, body) {
      broadcasts.push({ title, body });
      return [{ phoneNumber: "628123456789", status: "sent" }];
    },
  };
  const dataManager = {
    getSettings: () => ({ notifyAdminsOnConnectionChange: true }),
  };
  const activityLog = {
    push: (...args) => logs.push(args),
  };

  return {
    broadcasts,
    logs,
    notifier: new WhatsAppProviderStatusNotifier(notificationBot, dataManager, activityLog),
    setStatus: (status) => {
      currentStatus = status;
    },
  };
}

test("tidak mengirim status awal lalu mengirim alert ketika provider berubah DOWN", async () => {
  const fixture = createNotifier(buildStatus(true));

  await fixture.notifier.processStatusChanges();
  assert.equal(fixture.broadcasts.length, 0);

  fixture.setStatus(buildStatus(false));
  await fixture.notifier.processStatusChanges();

  assert.equal(fixture.broadcasts.length, 0);
  assert.equal(fixture.notifier.pendingChanges.length, 1);
  assert.match(fixture.logs.at(-1)[2], /ditunda/);
});

test("menunda alert saat Baileys DOWN dan mengirim rangkuman setelah pulih", async () => {
  const fixture = createNotifier(buildStatus(true));

  await fixture.notifier.processStatusChanges();
  fixture.setStatus(buildStatus(false));
  await fixture.notifier.processStatusChanges();
  assert.equal(fixture.broadcasts.length, 0);

  fixture.setStatus(buildStatus(true));
  await fixture.notifier.processStatusChanges();

  assert.equal(fixture.broadcasts.length, 1);
  assert.equal(fixture.broadcasts[0].title, "Provider WhatsApp pulih");
  assert.match(fixture.broadcasts[0].body, /baileys: ONLINE -> DOWN/);
  assert.match(fixture.broadcasts[0].body, /baileys: DOWN -> ONLINE/);
  assert.equal(fixture.notifier.pendingChanges.length, 0);
});
