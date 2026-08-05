const assert = require("node:assert/strict");
const test = require("node:test");

const { ReminderScheduler } = require("../src/schedulers");
const { addMonthsSafely, formatDate } = require("../src/utils");

test("WA reminder yang gagal tidak dicoba ulang tetapi reminder bulan berikutnya tetap dibuat", async () => {
  const timeZone = "Asia/Jakarta";
  const scheduledAt = new Date(Date.now() - 60_000);
  const currentMonthName = scheduledAt.toLocaleString("id-ID", { month: "long", timeZone });
  const nextDate = addMonthsSafely(scheduledAt, 1, timeZone);
  const nextMonthName = nextDate.toLocaleString("id-ID", { month: "long", timeZone });
  const reminder = {
    id: "reminder-1",
    contactId: "contact-1",
    contactName: "Pelanggan",
    phoneNumber: "6281234567890",
    reminderDateTime: scheduledAt.toISOString(),
    message: `Tagihan bulan ${currentMonthName} jatuh tempo ${formatDate(scheduledAt, timeZone)}`,
    templateName: "tagihan",
  };
  const reminders = new Map([[reminder.id, reminder]]);
  const archived = [];
  const created = [];
  const sendOptions = [];
  let sendCount = 0;

  const dataManager = {
    getSettings: () => ({ autoRescheduleMonthly: true, notifyAdminsOnDelivery: false }),
    getTimezone: () => timeZone,
    getSortedReminders: () => Array.from(reminders.values()),
    getResolvedReminderContact: () => ({ paymentStatus: "UNPAID" }),
    claimDueReminder: async (id) => reminders.get(id) || null,
    releaseReminderClaim: async () => null,
    moveToSent: async (id, extras) => {
      const current = reminders.get(id);
      reminders.delete(id);
      archived.push({ ...current, ...extras });
      return archived.at(-1);
    },
    addReminder: async (nextReminder) => {
      const result = { ...nextReminder, id: "reminder-2" };
      created.push(result);
      reminders.set(result.id, result);
      return result;
    },
  };
  const notificationBot = {
    getStatus: () => ({ whatsappProviderEnabled: true }),
    sendMessage: async (_phoneNumber, _message, options) => {
      sendCount += 1;
      sendOptions.push(options);
      throw new Error("WhatsApp tidak tersambung");
    },
  };
  const scheduler = new ReminderScheduler(notificationBot, dataManager, { push() {} });

  await scheduler.processDueReminders();

  assert.equal(sendCount, 1);
  assert.deepEqual(sendOptions, [{ maxAttempts: 1 }]);
  assert.equal(archived.length, 1);
  assert.equal(archived[0].deliveryStatus, "FAILED");
  assert.equal(archived[0].deliveryError, "WhatsApp tidak tersambung");
  assert.equal(created.length, 1);
  assert.equal(created[0].contactId, reminder.contactId);
  assert.equal(created[0].reminderDateTime.toISOString(), nextDate.toISOString());
  assert.match(created[0].message, new RegExp(`bulan ${nextMonthName}`, "i"));

  await scheduler.processDueReminders();
  assert.equal(sendCount, 1);
});
