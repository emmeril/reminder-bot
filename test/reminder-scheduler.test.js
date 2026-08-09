const assert = require("node:assert/strict");
const test = require("node:test");

const { ReminderScheduler } = require("../src/schedulers");
const { formatDate } = require("../src/utils");

test("WA reminder yang gagal tetap pending dan dijadwalkan retry", async () => {
  const timeZone = "Asia/Jakarta";
  const scheduledAt = new Date(Date.now() - 60_000);
  const currentMonthName = scheduledAt.toLocaleString("id-ID", { month: "long", timeZone });
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
  const retries = [];
  const sendOptions = [];
  let sendCount = 0;

  const dataManager = {
    getSettings: () => ({ autoRescheduleMonthly: true, notifyAdminsOnDelivery: false }),
    getTimezone: () => timeZone,
    getSortedReminders: () => Array.from(reminders.values()),
    getResolvedReminderContact: () => ({ paymentStatus: "UNPAID" }),
    claimDueReminder: async (id) => reminders.get(id) || null,
    markReminderDeliveryAttempt: async (id) => {
      const current = reminders.get(id);
      if (!current) return null;
      current.deliveryAttempts = (current.deliveryAttempts || 0) + 1;
      current.deliveryAttemptedAt ||= new Date().toISOString();
      current.providerStatus = "processing";
      return current;
    },
    scheduleReminderRetry: async (id, error, options) => {
      const current = reminders.get(id);
      current.providerStatus = "retry";
      current.providerError = error.message;
      current.nextDeliveryAttemptAt = new Date(Date.now() + 30_000).toISOString();
      retries.push({ id, error: error.message, options });
      return current;
    },
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
    getStatus: () => ({ whatsappProviderEnabled: true, isAvailable: true, outboundEnabled: true }),
    sendMessage: async (_phoneNumber, _message, options) => {
      sendCount += 1;
      sendOptions.push(options);
      throw new Error("WhatsApp tidak tersambung");
    },
  };
  const scheduler = new ReminderScheduler(notificationBot, dataManager, { push() {} });

  await scheduler.processDueReminders();

  assert.equal(sendCount, 1);
  assert.deepEqual(sendOptions, [{
    maxAttempts: 1,
    context: { type: "reminder", reminderId: reminder.id },
  }]);
  assert.equal(archived.length, 0);
  assert.equal(created.length, 0);
  assert.equal(retries.length, 1);
  assert.equal(retries[0].id, reminder.id);
  assert.equal(reminders.get(reminder.id).providerStatus, "retry");

  await scheduler.processDueReminders();
  assert.equal(sendCount, 1);
});

test("reminder baru diarsipkan sent setelah provider memberi konfirmasi", async () => {
  const reminder = {
    id: "reminder-confirmed",
    contactId: "contact-1",
    phoneNumber: "6281234567890",
    reminderDateTime: new Date(Date.now() - 1000).toISOString(),
    message: "Pesan terkonfirmasi",
    providerStatus: "pending",
  };
  const reminders = new Map([[reminder.id, reminder]]);
  const archived = [];
  const dataManager = {
    getSettings: () => ({ autoRescheduleMonthly: false, notifyAdminsOnDelivery: false }),
    getTimezone: () => "Asia/Jakarta",
    getSortedReminders: () => Array.from(reminders.values()),
    getResolvedReminderContact: () => ({ paymentStatus: "UNPAID" }),
    claimDueReminder: async () => reminder,
    markReminderDeliveryAttempt: async () => ({ ...reminder, deliveryAttempts: 1 }),
    releaseReminderClaim: async () => null,
    moveToSent: async (_id, extras) => {
      archived.push(extras);
      reminders.delete(reminder.id);
      return extras;
    },
  };
  const notificationBot = {
    getTransportStatus: async () => ({
      whatsappProviderEnabled: true,
      isAvailable: true,
      outboundEnabled: true,
      selectedProvider: "android",
    }),
    sendMessage: async () => ({
      provider: "android",
      confirmed: true,
      messageId: "bridge-confirmation-1",
    }),
  };

  await new ReminderScheduler(notificationBot, dataManager, { push() {} }).processDueReminders();

  assert.equal(archived.length, 1);
  assert.equal(archived[0].deliveryStatus, "SENT_ANDROID");
  assert.equal(archived[0].providerStatus, "sent");
  assert.equal(archived[0].providerMessageId, "bridge-confirmation-1");
});

test("reminder dengan penanda kegagalan lama tetap dijadwalkan bulan berikutnya", async () => {
  const scheduledAt = new Date(Date.now() - 60_000);
  const reminder = {
    id: "reminder-lama",
    contactId: "contact-1",
    contactName: "Pelanggan",
    phoneNumber: "6281234567890",
    reminderDateTime: scheduledAt.toISOString(),
    message: "Tagihan bulan Agustus",
    deliveryAttemptedAt: new Date().toISOString(),
    lastDeliveryError: "WhatsApp terputus saat proses sebelumnya",
  };
  const reminders = new Map([[reminder.id, reminder]]);
  const archived = [];
  const created = [];
  let sendCount = 0;

  const dataManager = {
    getSettings: () => ({ autoRescheduleMonthly: true }),
    getTimezone: () => "Asia/Jakarta",
    getSortedReminders: () => Array.from(reminders.values()),
    claimDueReminder: async (id) => reminders.get(id) || null,
    releaseReminderClaim: async () => null,
    moveToSent: async (id, extras) => {
      const current = reminders.get(id);
      reminders.delete(id);
      archived.push({ ...current, ...extras });
      return archived.at(-1);
    },
    addReminder: async (nextReminder) => {
      const result = { ...nextReminder, id: "reminder-baru" };
      created.push(result);
      reminders.set(result.id, result);
      return result;
    },
  };
  const notificationBot = {
    getStatus: () => ({ whatsappProviderEnabled: true, isAvailable: true, outboundEnabled: true }),
    sendMessage: async () => {
      sendCount += 1;
    },
  };
  const scheduler = new ReminderScheduler(notificationBot, dataManager, { push() {} });

  await scheduler.processDueReminders();

  assert.equal(sendCount, 0);
  assert.equal(archived.length, 1);
  assert.equal(archived[0].deliveryStatus, "FAILED");
  assert.equal(archived[0].deliveryError, reminder.lastDeliveryError);
  assert.equal(created.length, 1);
  assert.equal(created[0].contactId, reminder.contactId);
});

test("antrean reminder tidak disentuh selama pengiriman belum diaktifkan", async () => {
  let claims = 0;
  let sends = 0;
  let pending = 0;
  const dataManager = {
    getSortedReminders: () => [{ id: "lama", reminderDateTime: new Date(0).toISOString() }],
    markDueRemindersPending: async () => {
      pending += 1;
      return 1;
    },
    claimDueReminder: async () => {
      claims += 1;
      return null;
    },
  };
  const notificationBot = {
    getStatus: () => ({ whatsappProviderEnabled: true, isAvailable: true, outboundEnabled: false }),
    sendMessage: async () => {
      sends += 1;
    },
  };
  const scheduler = new ReminderScheduler(notificationBot, dataManager, { push() {} });

  await scheduler.processDueReminders();

  assert.equal(claims, 0);
  assert.equal(sends, 0);
  assert.equal(pending, 1);
});
