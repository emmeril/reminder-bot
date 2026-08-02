const assert = require("node:assert/strict");
const test = require("node:test");

const { DataManager } = require("../src/app");
const { HotspotReactivationScheduler } = require("../src/schedulers");

test("menyimpan dan mencoba ulang notifikasi kredensial tanpa reaktivasi router ulang", async () => {
  const manager = new DataManager({ push() {} });
  manager.saveContacts = async () => {};
  const contact = {
    id: "contact-retry",
    name: "Pelanggan",
    phoneNumber: "6281234567890",
    mikrotikUsername: "pelanggan",
    mikrotikPassword: "secret",
    mikrotikProfile: "100M",
    hotspotReactivationEnabled: true,
    hotspotReactivationAt: new Date(Date.now() - 60_000).toISOString(),
    paymentMonths: {},
    createdAt: new Date().toISOString(),
  };
  manager.contacts.set(contact.id, contact);

  let routerCalls = 0;
  let sendCalls = 0;
  const scheduler = new HotspotReactivationScheduler(
    {
      async reactivateHotspotUser(payload) {
        routerCalls += 1;
        return { ...payload, activeSessionsKilled: 0, removedUsers: 1 };
      },
    },
    manager,
    { push() {} },
    {
      async sendMessage() {
        sendCalls += 1;
        if (sendCalls === 1) throw new Error("transport sementara gagal");
      },
    }
  );

  const first = await scheduler.reactivateContact(manager.hydrateContact(contact));
  assert.equal(first.notification.sent, false);
  assert.equal(Boolean(manager.getContact(contact.id).hotspotNotificationPending), true);

  manager.getContact(contact.id).hotspotNotificationPending.nextAttemptAt = new Date(Date.now() - 1).toISOString();
  await scheduler.processDueReactivations();

  assert.equal(routerCalls, 1);
  assert.equal(sendCalls, 2);
  assert.equal(manager.getContact(contact.id).hotspotNotificationPending, null);
});
