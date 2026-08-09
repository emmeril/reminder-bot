const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { DataManager } = require("../src/app");
const { CONFIG } = require("../src/config");
const {
  migrateReminderPayload,
  migrateWhatsAppProviderMetadata,
} = require("../src/migrations/whatsapp-provider-metadata");

test("migration metadata WhatsApp bersifat additive dan idempotent", () => {
  const reminder = { id: "r1", message: "existing", customField: "preserved" };
  assert.equal(migrateReminderPayload(reminder), true);
  assert.equal(reminder.providerStatus, "pending");
  assert.equal(reminder.customField, "preserved");
  assert.equal(migrateReminderPayload(reminder), false);
});

test("migration mempertahankan database map existing dan menandai sent history", async () => {
  const saves = [];
  const dataManager = {
    reminders: new Map([["r1", { id: "r1", message: "pending" }]]),
    sentReminders: new Map([["s1", { id: "s1", deliveryStatus: "SENT_BAILEYS" }]]),
    saveReminders: async () => saves.push("reminders"),
    saveSentReminders: async () => saves.push("sent"),
  };

  const result = await migrateWhatsAppProviderMetadata(dataManager);
  assert.deepEqual(result, { remindersChanged: true, sentChanged: true });
  assert.deepEqual(saves, ["reminders", "sent"]);
  assert.equal(dataManager.sentReminders.get("s1").providerStatus, "sent");
});

test("migration membuka SQLite existing dan menambah metadata tanpa menghapus reminder", async () => {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "reminder-wa-migration-"));
  const originalStorage = CONFIG.DB_STORAGE;
  CONFIG.DB_STORAGE = path.join(temporaryDirectory, "existing.sqlite");
  const activityLog = { push() {} };
  let seedManager;
  let migratedManager;
  try {
    seedManager = new DataManager(activityLog);
    await seedManager.initDatabase();
    await seedManager.models.Reminder.create({
      id: "existing-reminder",
      data: {
        id: "existing-reminder",
        contactId: "missing-contact-is-preserved",
        reminderDateTime: "2026-08-10T03:00:00.000Z",
        message: "Existing payload",
        customField: "keep-me",
      },
    });
    await seedManager.sequelize.close();
    seedManager = null;

    migratedManager = new DataManager(activityLog);
    await migratedManager.loadAll();
    const reminder = migratedManager.getReminder("existing-reminder");

    assert.equal(reminder.message, "Existing payload");
    assert.equal(reminder.customField, "keep-me");
    assert.equal(reminder.providerStatus, "pending");
    assert.equal(reminder.providerMessageId, null);
  } finally {
    await seedManager?.sequelize?.close().catch(() => {});
    await migratedManager?.sequelize?.close().catch(() => {});
    CONFIG.DB_STORAGE = originalStorage;
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
});
