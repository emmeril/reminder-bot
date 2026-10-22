const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { ReminderScheduler } = require("../src/schedulers");
const { DEFAULT_REMINDER_MESSAGE_TEMPLATE } = require("../src/config");
const { formatDate } = require("../src/utils");

test("Penagihan.txt sama dengan template reminder bawaan", () => {
  const template = fs.readFileSync(path.join(__dirname, "../templates/Penagihan.txt"), "utf8").trimEnd();

  assert.equal(template, DEFAULT_REMINDER_MESSAGE_TEMPLATE);
});

test("template reminder dirender dari variabel saat pesan akan dikirim", () => {
  const reminder = {
    contactName: "Nouval",
    phoneNumber: "6287728972090",
    reminderDateTime: "2026-08-15T01:00:00.000Z",
    message: DEFAULT_REMINDER_MESSAGE_TEMPLATE,
    messageSource: DEFAULT_REMINDER_MESSAGE_TEMPLATE,
  };
  const dataManager = {
    getSettings: () => ({
      companyName: "Emmeril Hotspot",
      supportSignature: "CS Emmeril Hotspot",
      hotspotIsolationGraceDays: 3,
    }),
    getTimezone: () => "Asia/Jakarta",
    getResolvedReminderContact: () => ({
      name: "Nouval",
      phoneNumber: "6287728972090",
      paymentStatus: "UNPAID",
      currentPaymentStatus: "UNPAID",
      debtCount: 1,
      debtPeriods: [{ key: "2026-07", label: "Juli 2026" }],
      monthlyPaymentAmount: 100_000,
    }),
  };

  const message = new ReminderScheduler({}, dataManager, { push() {} }).buildReminderMessage(reminder);

  assert.match(message, /^Yth\. Nouval,/);
  assert.match(message, /Wifi Emmeril Hotspot Anda sebesar Rp\s?200\.000/);
  assert.match(message, /Tanggal jatuh tempo: 2026-08-15/);
  assert.match(message, /Masa tenggang: 3 hari/);
  assert.match(message, /Tanggal isolir layanan: 2026-08-18/);
  assert.match(message, /Informasi layanan/);
  assert.match(message, /masa aktif akun Anda tidak akan diperpanjang otomatis/);
  assert.match(message, /CS Emmeril Hotspot$/);
  assert.doesNotMatch(message, /{{|}}/);
});

test("informasi perpanjangan otomatis tidak ditampilkan tanpa tunggakan", () => {
  const scheduler = new ReminderScheduler({}, {
    getSettings: () => ({ hotspotIsolationGraceDays: 3 }),
    getTimezone: () => "Asia/Jakarta",
    getResolvedReminderContact: () => ({
      paymentStatus: "UNPAID",
      currentPaymentStatus: "UNPAID",
      debtCount: 0,
      monthlyPaymentAmount: 100_000,
    }),
  }, { push() {} });

  const message = scheduler.buildReminderMessage({
    reminderDateTime: "2026-08-15T01:00:00.000Z",
    message: "Tagihan {{totalAmount}}{{renewalStatusInfo}}",
  });

  assert.match(message, /^Tagihan Rp\s?100\.000$/);
  assert.doesNotMatch(message, /Informasi layanan|tidak akan diperpanjang otomatis|{{|}}/);
});

test("variabel masa tenggang nol memakai tanggal jatuh tempo sebagai tanggal isolir", () => {
  const scheduler = new ReminderScheduler({}, {
    getSettings: () => ({ hotspotIsolationGraceDays: 0 }),
    getTimezone: () => "Asia/Jakarta",
    getResolvedReminderContact: () => ({
      paymentStatus: "UNPAID",
      currentPaymentStatus: "UNPAID",
      monthlyPaymentAmount: 100_000,
    }),
  }, { push() {} });

  const message = scheduler.buildReminderMessage({
    reminderDateTime: "2026-08-15T01:00:00.000Z",
    message: "Tenggang {{graceDays}} hari. Isolir {{isolationDate}}.",
  });

  assert.match(message, /^Tenggang 0 hari\. Isolir 2026-08-15\./);
  assert.doesNotMatch(message, /{{|}}/);
});

test("nominal reminder otomatis bertambah sesuai jumlah tunggakan", () => {
  const reminder = { message: "Halo, tagihan Anda sudah terbit." };
  const dataManager = {
    getSettings: () => ({}),
    getResolvedReminderContact: () => ({
      paymentStatus: "UNPAID",
      currentPaymentStatus: "UNPAID",
      debtCount: 2,
      monthlyPaymentAmount: 150_000,
    }),
  };
  const scheduler = new ReminderScheduler({}, dataManager, { push() {} });

  const message = scheduler.buildReminderMessage(reminder);

  assert.match(message, /Nominal bulanan: Rp\s?150\.000/);
  assert.match(message, /Tunggakan: 2 bulan \(Rp\s?300\.000\)/);
  assert.match(message, /Total tagihan: Rp\s?450\.000/);
});

test("reminder hutang tetap dikirim ketika bulan berjalan sudah dibayar", () => {
  const dataManager = {
    getSettings: () => ({}),
    getResolvedReminderContact: () => ({
      paymentStatus: "PAID",
      currentPaymentStatus: "PAID",
      debtCount: 1,
      monthlyPaymentAmount: 150_000,
    }),
  };
  const scheduler = new ReminderScheduler({}, dataManager, { push() {} });

  assert.equal(scheduler.isPaidReminder({}), false);
  assert.match(scheduler.buildReminderMessage({ message: "Tagihan" }), /Total tagihan: Rp\s?150\.000/);
});

test("reminder bulan depan membaca status periode jadwal, bukan status bulan ini", () => {
  let requestedPeriod = null;
  const contact = {
    id: "contact-next-period",
    paymentStatus: "PAID",
    currentPaymentStatus: "PAID",
    monthlyPaymentAmount: 100_000,
  };
  const dataManager = {
    getSettings: () => ({}),
    getTimezone: () => "Asia/Jakarta",
    getResolvedReminderContact: () => contact,
    buildDebtInfo: (_contact, period) => {
      requestedPeriod = period;
      return {
        paymentStatus: "UNPAID",
        currentPaymentStatus: "UNPAID",
        debtCount: 0,
        debtAmount: 0,
      };
    },
  };
  const scheduler = new ReminderScheduler({}, dataManager, { push() {} });
  const reminder = {
    reminderDateTime: "2026-11-17T01:00:00.000Z",
    message: "Tagihan November",
  };

  assert.equal(scheduler.isPaidReminder(reminder), false);
  assert.deepEqual(requestedPeriod, { year: 2026, month: 11 });
  assert.match(scheduler.buildReminderMessage(reminder), /Rp\s?100\.000/);
});

test("placeholder nominal pada template diganti tanpa menambah blok rincian kedua", () => {
  const dataManager = {
    getSettings: () => ({}),
    getResolvedReminderContact: () => ({
      paymentStatus: "UNPAID",
      currentPaymentStatus: "UNPAID",
      debtCount: 1,
      monthlyPaymentAmount: 100_000,
    }),
  };
  const scheduler = new ReminderScheduler({}, dataManager, { push() {} });

  const message = scheduler.buildReminderMessage({
    message: "Total {{totalAmount}}, tunggakan {{debtCount}} bulan.",
  });

  assert.match(message, /Total Rp\s?200\.000, tunggakan 1 bulan/);
  assert.doesNotMatch(message, /Rincian Pembayaran/);
});

test("nominal yang sudah ada di pesan reminder diperbarui menjadi total hutang", () => {
  const dataManager = {
    getSettings: () => ({}),
    getResolvedReminderContact: () => ({
      paymentStatus: "UNPAID",
      currentPaymentStatus: "UNPAID",
      debtCount: 1,
      monthlyPaymentAmount: 100_000,
    }),
  };
  const scheduler = new ReminderScheduler({}, dataManager, { push() {} });
  const message = scheduler.buildReminderMessage({ message: "Tagihan Emmeril Hotspot Anda sebesar Rp 100.000 belum kami terima." });

  assert.match(message, /sebesar Rp\s?200\.000/);
  assert.doesNotMatch(message, /Rincian Pembayaran/);
});

test("reminder pelanggan sekali berlangganan tidak dijadwalkan ulang", async () => {
  let created = 0;
  const scheduler = new ReminderScheduler({}, {
    getSettings: () => ({ autoRescheduleMonthly: true }),
    getTimezone: () => "Asia/Jakarta",
    getResolvedReminderContact: () => ({ id: "one-time", subscriptionType: "ONE_TIME" }),
    addReminder: async () => { created += 1; },
  }, { push() {} });

  const result = await scheduler.rescheduleMonthlyReminder({ id: "reminder-one-time", contactId: "one-time" });

  assert.equal(result, null);
  assert.equal(created, 0);
});

test("reminder jatuh tempo pelanggan sekali berlangganan dilewati tanpa mengirim WA", async () => {
  const reminder = {
    id: "reminder-one-time-due",
    contactId: "one-time",
    phoneNumber: "6281234567890",
    reminderDateTime: new Date(Date.now() - 1000).toISOString(),
    message: "Tagihan sekali berlangganan",
  };
  const archived = [];
  let sendCount = 0;
  const dataManager = {
    getSettings: () => ({ autoRescheduleMonthly: true }),
    getSortedReminders: () => [reminder],
    getResolvedReminderContact: () => ({ id: "one-time", subscriptionType: "ONE_TIME" }),
    claimDueReminder: async () => reminder,
    moveToSent: async (_id, extras) => {
      archived.push(extras);
      return extras;
    },
    releaseReminderClaim: async () => null,
  };
  const notificationBot = {
    getStatus: () => ({ whatsappProviderEnabled: true, isAvailable: true, outboundEnabled: true }),
    sendMessage: async () => { sendCount += 1; },
  };

  await new ReminderScheduler(notificationBot, dataManager, { push() {} }).processDueReminders();

  assert.equal(sendCount, 0);
  assert.equal(archived.length, 1);
  assert.equal(archived[0].deliveryStatus, "SKIPPED_ONE_TIME");
  assert.equal(archived[0].providerStatus, "skipped");
});

test("WA reminder yang gagal tetap diarsipkan dan dijadwalkan bulan berikutnya", async () => {
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
  assert.equal(archived.length, 1);
  assert.equal(archived[0].deliveryStatus, "FAILED");
  assert.match(archived[0].deliveryError, /WhatsApp tidak tersambung/);
  assert.equal(created.length, 1);
  assert.equal(created[0].contactId, reminder.contactId);

  await scheduler.processDueReminders();
  assert.equal(sendCount, 1);
});

test("WA tidak siap tidak menahan pengarsipan dan jadwal reminder berikutnya", async () => {
  const reminder = {
    id: "reminder-provider-down",
    contactId: "contact-1",
    phoneNumber: "6281234567890",
    reminderDateTime: new Date(Date.now() - 1000).toISOString(),
    message: "Tagihan bulan Agustus",
  };
  const reminders = new Map([[reminder.id, reminder]]);
  const archived = [];
  const created = [];
  const dataManager = {
    getSettings: () => ({ autoRescheduleMonthly: true }),
    getTimezone: () => "Asia/Jakarta",
    getSortedReminders: () => Array.from(reminders.values()),
    getResolvedReminderContact: () => ({ paymentStatus: "UNPAID" }),
    claimDueReminder: async (id) => reminders.get(id) || null,
    markReminderDeliveryAttempt: async () => ({ ...reminder, deliveryAttempts: 1 }),
    releaseReminderClaim: async () => null,
    moveToSent: async (id, extras) => {
      reminders.delete(id);
      archived.push({ ...reminder, ...extras });
      return archived.at(-1);
    },
    addReminder: async (nextReminder) => {
      created.push(nextReminder);
      return { ...nextReminder, id: "reminder-next" };
    },
  };
  const notificationBot = {
    getTransportStatus: async () => ({
      whatsappProviderEnabled: true,
      isAvailable: false,
      outboundEnabled: true,
      selectedProvider: "baileys",
    }),
    sendMessage: async () => { throw new Error("WhatsApp belum siap"); },
  };

  await new ReminderScheduler(notificationBot, dataManager, { push() {} }).processDueReminders();

  assert.equal(archived.length, 1);
  assert.equal(archived[0].deliveryStatus, "FAILED");
  assert.equal(created.length, 1);
});

test("provider WA yang dimatikan tetap memfinalkan reminder dan membuat jadwal berikutnya", async () => {
  const reminder = {
    id: "reminder-provider-disabled",
    contactId: "contact-1",
    phoneNumber: "6281234567890",
    reminderDateTime: new Date(Date.now() - 1000).toISOString(),
    message: "Tagihan bulan Agustus",
  };
  const reminders = new Map([[reminder.id, reminder]]);
  const archived = [];
  const created = [];
  const dataManager = {
    getSettings: () => ({ autoRescheduleMonthly: true }),
    getTimezone: () => "Asia/Jakarta",
    getSortedReminders: () => Array.from(reminders.values()),
    getResolvedReminderContact: () => ({ paymentStatus: "UNPAID" }),
    claimDueReminder: async (id) => reminders.get(id) || null,
    markReminderDeliveryAttempt: async () => ({ ...reminder, deliveryAttempts: 1 }),
    releaseReminderClaim: async () => null,
    moveToSent: async (id, extras) => {
      reminders.delete(id);
      archived.push({ ...reminder, ...extras });
      return archived.at(-1);
    },
    addReminder: async (nextReminder) => {
      created.push(nextReminder);
      return { ...nextReminder, id: "reminder-next" };
    },
  };
  const notificationBot = {
    getStatus: () => ({ whatsappProviderEnabled: false, isAvailable: false, outboundEnabled: false }),
    sendMessage: async () => { throw new Error("Baileys dinonaktifkan"); },
  };

  await new ReminderScheduler(notificationBot, dataManager, { push() {} }).processDueReminders();

  assert.equal(archived.length, 1);
  assert.equal(archived[0].deliveryStatus, "FAILED");
  assert.equal(created.length, 1);
});

test("kegagalan notifikasi admin tidak menahan reschedule reminder yang terkirim", async () => {
  const reminder = {
    id: "reminder-admin-notification-failed",
    contactId: "contact-1",
    phoneNumber: "6281234567890",
    reminderDateTime: new Date(Date.now() - 1000).toISOString(),
    message: "Tagihan bulan Agustus",
  };
  const reminders = new Map([[reminder.id, reminder]]);
  const created = [];
  const dataManager = {
    getSettings: () => ({ autoRescheduleMonthly: true, notifyAdminsOnDelivery: true }),
    getTimezone: () => "Asia/Jakarta",
    getSortedReminders: () => Array.from(reminders.values()),
    getResolvedReminderContact: () => ({ paymentStatus: "UNPAID" }),
    claimDueReminder: async (id) => reminders.get(id) || null,
    markReminderDeliveryAttempt: async () => ({ ...reminder, deliveryAttempts: 1 }),
    releaseReminderClaim: async () => null,
    moveToSent: async (id) => { reminders.delete(id); return reminder; },
    addReminder: async (nextReminder) => {
      created.push(nextReminder);
      return { ...nextReminder, id: "reminder-next" };
    },
  };
  const notificationBot = {
    getStatus: () => ({ whatsappProviderEnabled: true, isAvailable: true, outboundEnabled: true }),
    sendMessage: async () => ({ provider: "baileys", confirmed: true }),
    sendAdminBroadcast: async () => { throw new Error("WA admin gagal"); },
  };

  await new ReminderScheduler(notificationBot, dataManager, { push() {} }).processDueReminders();

  assert.equal(created.length, 1);
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
      selectedProvider: "baileys",
    }),
    sendMessage: async () => ({
      provider: "baileys",
      confirmed: true,
      messageId: "bridge-confirmation-1",
    }),
  };

  await new ReminderScheduler(notificationBot, dataManager, { push() {} }).processDueReminders();

  assert.equal(archived.length, 1);
  assert.equal(archived[0].deliveryStatus, "SENT_BAILEYS");
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

test("pengiriman WA yang dijeda tetap memfinalkan reminder dan membuat jadwal berikutnya", async () => {
  const reminder = {
    id: "reminder-outbound-paused",
    contactId: "contact-1",
    phoneNumber: "6281234567890",
    reminderDateTime: new Date(Date.now() - 1000).toISOString(),
    message: "Tagihan bulan Agustus",
  };
  const reminders = new Map([[reminder.id, reminder]]);
  const archived = [];
  const created = [];
  const dataManager = {
    getSettings: () => ({ autoRescheduleMonthly: true }),
    getTimezone: () => "Asia/Jakarta",
    getSortedReminders: () => Array.from(reminders.values()),
    getResolvedReminderContact: () => ({ paymentStatus: "UNPAID" }),
    claimDueReminder: async (id) => reminders.get(id) || null,
    markReminderDeliveryAttempt: async () => ({ ...reminder, deliveryAttempts: 1 }),
    releaseReminderClaim: async () => null,
    moveToSent: async (id, extras) => {
      reminders.delete(id);
      archived.push({ ...reminder, ...extras });
      return archived.at(-1);
    },
    addReminder: async (nextReminder) => {
      created.push(nextReminder);
      return { ...nextReminder, id: "reminder-next" };
    },
  };
  const notificationBot = {
    getStatus: () => ({ whatsappProviderEnabled: true, isAvailable: true, outboundEnabled: false, selectedProvider: "baileys" }),
    sendMessage: async () => {
      throw new Error("Pengiriman WhatsApp belum diaktifkan dari halaman transport");
    },
  };
  const scheduler = new ReminderScheduler(notificationBot, dataManager, { push() {} });

  await scheduler.processDueReminders();

  assert.equal(archived.length, 1);
  assert.equal(archived[0].deliveryStatus, "FAILED");
  assert.equal(created.length, 1);
});
