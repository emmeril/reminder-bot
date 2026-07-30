const assert = require("node:assert/strict");
const test = require("node:test");

const { WhatsAppProviderStatusNotifier } = require("../src/schedulers");

function buildStatus(whatsappConnected, fonnteConnected) {
  const connectedProviders = [
    ...(whatsappConnected ? ["whatsapp-api"] : []),
    ...(fonnteConnected ? ["fonnte"] : []),
  ];

  return {
    providers: {
      whatsappApi: {
        name: "whatsapp-api",
        configured: true,
        connection: {
          connected: whatsappConnected,
          detail: whatsappConnected ? "WhatsApp API terhubung" : "WhatsApp API tidak siap",
        },
      },
      fonnte: {
        name: "fonnte",
        configured: true,
        connection: {
          connected: fonnteConnected,
          detail: fonnteConnected ? "Fonnte terhubung" : "Fonnte tidak siap",
        },
      },
    },
    loadBalancer: { connectedProviders },
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
  const fixture = createNotifier(buildStatus(true, true));

  await fixture.notifier.processStatusChanges();
  assert.equal(fixture.broadcasts.length, 0);

  fixture.setStatus(buildStatus(false, true));
  await fixture.notifier.processStatusChanges();

  assert.equal(fixture.broadcasts.length, 1);
  assert.equal(fixture.broadcasts[0].title, "Alert provider WhatsApp");
  assert.match(fixture.broadcasts[0].body, /whatsapp-api: ONLINE -> DOWN/);
  assert.match(fixture.broadcasts[0].body, /fonnte: ONLINE/);
});

test("menunda alert saat semua provider DOWN dan mengirimnya setelah provider pulih", async () => {
  const fixture = createNotifier(buildStatus(true, true));

  await fixture.notifier.processStatusChanges();
  fixture.setStatus(buildStatus(false, false));
  await fixture.notifier.processStatusChanges();
  assert.equal(fixture.broadcasts.length, 0);

  fixture.setStatus(buildStatus(false, true));
  await fixture.notifier.processStatusChanges();

  assert.equal(fixture.broadcasts.length, 1);
  assert.equal(fixture.broadcasts[0].title, "Alert provider WhatsApp");
  assert.match(fixture.broadcasts[0].body, /fonnte: DOWN -> ONLINE/);
  assert.equal(fixture.notifier.pendingChanges.length, 0);
});
