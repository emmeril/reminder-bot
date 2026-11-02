const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { ReminderScheduler } = require("../src/schedulers");
const {
  DEFAULT_REMINDER_MESSAGE_TEMPLATE,
  DEFAULT_SETTINGS,
  REMINDER_KINDS,
} = require("../src/config");
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
    reminderKind: REMINDER_KINDS.GRACE_PERIOD,
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

  const message = new ReminderScheduler({}, dataManager, { push() {} }).buildReminderMessage(
    reminder,
    new Date("2026-08-15T01:00:00.000Z")
  );

  assert.match(message, /^\*Pengingat Masa Tenggang\*/);
  assert.match(message, /Yth\. Bapak\/Ibu Nouval,/);
  assert.match(message, /Tagihan WiFi Anda sudah jatuh tempo dan belum lunas/);
  assert.match(message, /\*Rincian tagihan\*/);
  assert.match(message, /Juli 2026: Rp\s?100\.000/);
  assert.match(message, /Agustus 2026: Rp\s?100\.000/);
  assert.match(message, /\*Total: Rp\s?200\.000\*/);
  assert.match(message, /Jatuh tempo: 2026-08-15/);
  assert.match(message, /Masa tenggang: 3 hari/);
  assert.match(message, /Layanan aktif sampai: 2026-08-18/);
  assert.match(message, /Perpanjangan otomatis: Dijeda sampai tunggakan lunas/);
  assert.match(message, /CS Emmeril Hotspot$/);
  assert.doesNotMatch(message, /{{|}}/);
});

test("pengingat masa tenggang memakai template yang disimpan di pengaturan", () => {
  const scheduler = new ReminderScheduler({}, {
    getSettings: () => ({
      gracePeriodReminderMessageTemplate: "Halo {{name}}, batas pembayaran {{isolationDate}}. Total {{totalAmount}}.",
      hotspotIsolationGraceDays: 3,
    }),
    getTimezone: () => "Asia/Jakarta",
    getResolvedReminderContact: () => ({
      name: "Pelanggan Tenggang",
      paymentStatus: "UNPAID",
      currentPaymentStatus: "UNPAID",
      monthlyPaymentAmount: 75_000,
    }),
  }, { push() {} });

  const message = scheduler.buildReminderMessage({
    reminderDateTime: "2026-11-01T01:00:00.000Z",
    reminderKind: REMINDER_KINDS.GRACE_PERIOD,
    message: DEFAULT_REMINDER_MESSAGE_TEMPLATE,
    messageSource: DEFAULT_REMINDER_MESSAGE_TEMPLATE,
  }, new Date("2026-11-01T02:00:00.000Z"));

  assert.match(message, /^Halo Pelanggan Tenggang, batas pembayaran 2026-11-04\. Total Rp\s?75\.000/);
  assert.doesNotMatch(message, /{{|}}/);
});

test("template masa tenggang tidak mengganti reminder biasa saat jeda isolir nol", () => {
  const scheduler = new ReminderScheduler({}, {
    getSettings: () => ({
      gracePeriodReminderMessageTemplate: "Masa tenggang sampai {{isolationDate}}.",
      hotspotIsolationGraceDays: 0,
    }),
    getTimezone: () => "Asia/Jakarta",
    getResolvedReminderContact: () => ({
      paymentStatus: "UNPAID",
      currentPaymentStatus: "UNPAID",
      monthlyPaymentAmount: 100_000,
    }),
  }, { push() {} });

  const message = scheduler.buildReminderMessage({
    reminderDateTime: "2026-08-15T01:00:00.000Z",
    reminderKind: REMINDER_KINDS.BILLING,
    message: "Pengingat biasa {{totalAmount}}.",
    messageSource: "Pengingat biasa {{totalAmount}}.",
  });

  assert.match(message, /^Pengingat biasa Rp\s?100\.000/);
  assert.doesNotMatch(message, /Masa tenggang sampai/);
});

test("pengingat jatuh tempo dikirim sesuai tanggal dan pengingat masa tenggang dikirim H-1", () => {
  const scheduler = new ReminderScheduler({}, {
    getSettings: () => ({ hotspotIsolationGraceDays: 3 }),
    getTimezone: () => "Asia/Jakarta",
  }, { push() {} });
  const billingReminder = {
    reminderDateTime: "2026-11-02T01:00:00.000Z",
    reminderKind: REMINDER_KINDS.BILLING,
  };
  const graceReminder = {
    ...billingReminder,
    reminderKind: REMINDER_KINDS.GRACE_PERIOD,
  };

  assert.equal(
    new Date(scheduler.getDueTime(billingReminder)).toISOString(),
    "2026-11-02T01:00:00.000Z"
  );
  assert.equal(
    new Date(scheduler.getDueTime(graceReminder)).toISOString(),
    "2026-11-04T01:00:00.000Z"
  );
});

test("reminder biasa, tenggang nol, dan jadwal percobaan ulang tidak ikut digeser", () => {
  const settings = { hotspotIsolationGraceDays: 3 };
  const scheduler = new ReminderScheduler({}, {
    getSettings: () => settings,
    getTimezone: () => "Asia/Jakarta",
  }, { push() {} });
  const dueAt = "2026-11-02T01:00:00.000Z";

  assert.equal(scheduler.getDueTime({ reminderDateTime: dueAt }), new Date(dueAt).getTime());

  settings.hotspotIsolationGraceDays = 0;
  assert.equal(scheduler.getDueTime({
    reminderDateTime: dueAt,
    reminderKind: REMINDER_KINDS.BILLING,
  }), new Date(dueAt).getTime());

  const retryAt = "2026-11-02T02:15:00.000Z";
  settings.hotspotIsolationGraceDays = 3;
  assert.equal(scheduler.getDueTime({
    reminderDateTime: dueAt,
    reminderKind: REMINDER_KINDS.BILLING,
    nextDeliveryAttemptAt: retryAt,
  }), new Date(retryAt).getTime());
});

test("scheduler mengirim saat jatuh tempo lalu H-1 dan hanya menjadwalkan bulan berikutnya sekali", async () => {
  const reminder = {
    id: "two-stage-reminder",
    contactId: "two-stage-contact",
    contactName: "Pelanggan Dua Tahap",
    phoneNumber: "6281234567890",
    reminderDateTime: new Date(Date.now() - 1000).toISOString(),
    reminderKind: REMINDER_KINDS.BILLING,
    templateName: "Penagihan.txt",
    message: DEFAULT_REMINDER_MESSAGE_TEMPLATE,
    messageSource: DEFAULT_REMINDER_MESSAGE_TEMPLATE,
  };
  const reminders = new Map([[reminder.id, reminder]]);
  const sentMessages = [];
  const histories = [];
  const nextReminders = [];
  let graceTransitions = 0;

  const contact = {
    id: "two-stage-contact",
    subscriptionType: "RECURRING",
    paymentStatus: "UNPAID",
    currentPaymentStatus: "UNPAID",
    debtCount: 0,
    monthlyPaymentAmount: 75_000,
  };
  const dataManager = {
    getSettings: () => ({
      autoRescheduleMonthly: true,
      hotspotIsolationGraceDays: 1,
      gracePeriodReminderMessageTemplate: "*Pengingat Masa Tenggang*\n\nHalo {{name}}, bayar sebelum {{isolationDate}}.",
      notifyAdminsOnDelivery: false,
    }),
    getTimezone: () => "Asia/Jakarta",
    getSortedReminders: () => Array.from(reminders.values()),
    getResolvedReminderContact: () => contact,
    claimDueReminder: async (id) => reminders.get(id) || null,
    markReminderDeliveryAttempt: async (id) => {
      const current = reminders.get(id);
      current.deliveryAttempts = 1;
      current.deliveryAttemptedAt = new Date().toISOString();
      current.providerStatus = "processing";
      return current;
    },
    moveToGracePeriod: async (id, extras) => {
      const current = reminders.get(id);
      histories.push({ ...current, ...extras });
      current.reminderKind = REMINDER_KINDS.GRACE_PERIOD;
      delete current.deliveryAttempts;
      delete current.deliveryAttemptedAt;
      delete current.providerStatus;
      graceTransitions += 1;
      return {
        sentReminder: histories.at(-1),
        reminder: { ...current, deliveryDateTime: current.reminderDateTime },
      };
    },
    moveToSent: async (id, extras) => {
      const current = reminders.get(id);
      reminders.delete(id);
      const history = { ...current, ...extras };
      histories.push(history);
      return history;
    },
    addReminder: async (payload) => {
      const next = { ...payload, id: "next-month-reminder" };
      nextReminders.push(next);
      return next;
    },
    releaseReminderClaim: async () => null,
  };
  const notificationBot = {
    getStatus: () => ({ whatsappProviderEnabled: true, isAvailable: true, outboundEnabled: true }),
    sendMessage: async (_phoneNumber, message) => {
      sentMessages.push(message);
      return { provider: "baileys", providerMessageId: `message-${sentMessages.length}` };
    },
  };
  const scheduler = new ReminderScheduler(notificationBot, dataManager, { push() {} });

  await scheduler.processDueReminders();
  await scheduler.processDueReminders();

  assert.equal(sentMessages.length, 2);
  assert.match(sentMessages[0], /^\*Pengingat Tagihan\*/);
  assert.match(sentMessages[1], /^\*Pengingat Masa Tenggang\*/);
  assert.equal(graceTransitions, 1);
  assert.equal(histories.length, 2);
  assert.equal(nextReminders.length, 1);
  assert.equal(nextReminders[0].reminderKind, REMINDER_KINDS.BILLING);
});

test("reminder menampilkan nominal setiap periode pada tagihan akumulasi", () => {
  const reminder = {
    contactName: "Khrisna",
    phoneNumber: "6281234567890",
    reminderDateTime: "2026-11-01T01:00:00.000Z",
    message: DEFAULT_REMINDER_MESSAGE_TEMPLATE,
    messageSource: DEFAULT_REMINDER_MESSAGE_TEMPLATE,
  };
  const dataManager = {
    getSettings: () => ({
      supportSignature: "CS Emmeril Hotspot",
      hotspotIsolationGraceDays: 3,
    }),
    getTimezone: () => "Asia/Jakarta",
    getResolvedReminderContact: () => ({
      name: "Khrisna",
      phoneNumber: "6281234567890",
      paymentStatus: "UNPAID",
      currentPaymentStatus: "UNPAID",
      debtCount: 1,
      debtAmount: 75_000,
      debtPeriods: [{
        key: "2026-10",
        label: "Oktober 2026",
        remainingAmount: 75_000,
      }],
      monthlyPaymentAmount: 75_000,
      paymentMonths: {},
    }),
  };

  const message = new ReminderScheduler({}, dataManager, { push() {} }).buildReminderMessage(reminder);

  assert.match(message, /Oktober 2026: Rp\s?75\.000/);
  assert.match(message, /November 2026: Rp\s?75\.000/);
  assert.match(message, /\*Total: Rp\s?150\.000\*/);
  assert.match(message, /Jatuh tempo: 2026-11-01/);
  assert.doesNotMatch(message, /{{|}}/);
});

test("rincian reminder memakai sisa tagihan setelah pembayaran sebagian", () => {
  const dataManager = {
    getSettings: () => ({ hotspotIsolationGraceDays: 3 }),
    getTimezone: () => "Asia/Jakarta",
    getResolvedReminderContact: () => ({
      name: "Pelanggan Parsial",
      paymentStatus: "UNPAID",
      currentPaymentStatus: "UNPAID",
      debtCount: 1,
      debtAmount: 50_000,
      debtPeriods: [{
        key: "2026-10",
        label: "Oktober 2026",
        remainingAmount: 50_000,
      }],
      monthlyPaymentAmount: 75_000,
      paymentMonths: {
        "2026-11": { status: "UNPAID", paidAmount: 25_000 },
      },
    }),
  };
  const scheduler = new ReminderScheduler({}, dataManager, { push() {} });

  const message = scheduler.buildReminderMessage({
    reminderDateTime: "2026-11-01T01:00:00.000Z",
    message: DEFAULT_REMINDER_MESSAGE_TEMPLATE,
    messageSource: DEFAULT_REMINDER_MESSAGE_TEMPLATE,
  });

  assert.match(message, /Oktober 2026: Rp\s?50\.000/);
  assert.match(message, /November 2026: Rp\s?50\.000/);
  assert.match(message, /\*Total: Rp\s?100\.000\*/);
});

test("reminder masa aktif menampilkan batas aktif dan tunggakan yang masih tersimpan", () => {
  const reminder = {
    contactId: "contact-active-period-reminder",
    reminderDateTime: "2026-11-25T01:00:00.000Z",
    reminderKind: REMINDER_KINDS.ACTIVE_PERIOD_EXPIRY,
    activePeriodUntil: "2026-11-28T01:00:00.000Z",
    message: DEFAULT_SETTINGS.activePeriodReminderMessageTemplate,
    messageSource: DEFAULT_SETTINGS.activePeriodReminderMessageTemplate,
  };
  const dataManager = {
    getSettings: () => ({
      companyName: "Emmeril Hotspot",
      supportSignature: "CS Emmeril Hotspot",
      hotspotIsolationGraceDays: 3,
    }),
    getTimezone: () => "Asia/Jakarta",
    getResolvedReminderContact: () => ({
      name: "Pelanggan Masa Aktif",
      phoneNumber: "6281234567890",
      paymentStatus: "PAID",
      currentPaymentStatus: "PAID",
      debtCount: 2,
      debtAmount: 200_000,
      debtPeriods: [
        { key: "2026-09", label: "September 2026" },
        { key: "2026-10", label: "Oktober 2026" },
      ],
      monthlyPaymentAmount: 100_000,
    }),
  };

  const message = new ReminderScheduler({}, dataManager, { push() {} }).buildReminderMessage(reminder);

  assert.match(message, /Masa aktif WiFi Anda akan berakhir pada 28 November 2026 pukul 08\.00/);
  assert.match(message, /Tunggakan: 2 bulan/);
  assert.match(message, /Total: Rp\s?200\.000/);
  assert.match(message, /September 2026, Oktober 2026/);
  assert.match(message, /Lunasi tunggakan atau beli masa aktif/);
  assert.doesNotMatch(message, /{{|}}/);
});

test("reminder berikutnya kembali menjadi reminder tagihan setelah masa aktif berakhir", () => {
  const scheduler = new ReminderScheduler({}, {
    getTimezone: () => "Asia/Jakarta",
  }, { push() {} });

  const next = scheduler.buildNextReminder({
    contactId: "contact-active-period-next",
    reminderDateTime: "2026-11-25T01:00:00.000Z",
    reminderKind: REMINDER_KINDS.ACTIVE_PERIOD_EXPIRY,
    activePeriodUntil: "2026-11-28T01:00:00.000Z",
    message: DEFAULT_SETTINGS.activePeriodReminderMessageTemplate,
    messageSource: DEFAULT_SETTINGS.activePeriodReminderMessageTemplate,
    templateName: "MasaAktifSementara",
  });

  assert.equal(next.reminderKind, REMINDER_KINDS.BILLING);
  assert.equal(next.reminderDateTime.toISOString(), "2026-12-25T01:00:00.000Z");
  assert.equal(next.templateName, "Penagihan.txt");
  assert.equal(next.message, DEFAULT_REMINDER_MESSAGE_TEMPLATE);
  assert.equal(next.activePeriodUntil, undefined);
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

  assert.match(message, /^Tagihan Rp\s?100\.000/);
  assert.match(message, /Rincian tagihan/);
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
  const reminder = {
    reminderDateTime: "2026-08-15T01:00:00.000Z",
    message: "Halo, tagihan Anda sudah terbit.",
  };
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

  assert.match(message, /Tunggakan sebelumnya: Rp\s?300\.000/);
  assert.match(message, /Agustus 2026: Rp\s?150\.000/);
  assert.match(message, /Total: Rp\s?450\.000/);
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
  assert.match(scheduler.buildReminderMessage({ message: "Tagihan" }), /Total: Rp\s?150\.000/);
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
  assert.doesNotMatch(message, /Rincian tagihan/);
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
  assert.match(message, /Rincian tagihan/);
  assert.match(message, /Total: Rp\s?200\.000/);
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

test("reschedule reminder memakai jadwal masa aktif terbaru setelah pembayaran bersamaan", async () => {
  const nextServiceDate = new Date(Date.now() + 20 * 24 * 60 * 60 * 1000);
  let createdPayload = null;
  const dataManager = {
    getSettings: () => ({ autoRescheduleMonthly: true }),
    getTimezone: () => "Asia/Jakarta",
    getResolvedReminderContact: () => ({
      id: "concurrent-payment",
      subscriptionType: "RECURRING",
      billingPausedForArrears: false,
      hotspotReactivationAt: nextServiceDate.toISOString(),
    }),
    addReminder: async (payload) => {
      createdPayload = payload;
      return { id: "next-reminder", reminderDateTime: new Date(payload.reminderDateTime).toISOString() };
    },
  };
  const reminder = {
    id: "processing-reminder",
    contactId: "concurrent-payment",
    reminderDateTime: new Date(Date.now() - 60_000).toISOString(),
    message: DEFAULT_REMINDER_MESSAGE_TEMPLATE,
    messageSource: DEFAULT_REMINDER_MESSAGE_TEMPLATE,
    templateName: "Penagihan.txt",
  };

  await new ReminderScheduler({}, dataManager, { push() {} })
    .rescheduleMonthlyReminder(reminder, "SKIPPED_PAID");

  assert.equal(new Date(createdPayload.reminderDateTime).toISOString(), nextServiceDate.toISOString());
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

test("reminder dengan dua tunggakan dihentikan tanpa WhatsApp dan tanpa jadwal berikutnya", async () => {
  const reminder = {
    id: "reminder-two-arrears",
    contactId: "two-arrears",
    phoneNumber: "6281234567890",
    reminderDateTime: new Date(Date.now() - 1000).toISOString(),
    reminderKind: REMINDER_KINDS.BILLING,
    message: "Pengingat tagihan",
  };
  const archived = [];
  const created = [];
  let sendCount = 0;
  const contact = {
    id: "two-arrears",
    subscriptionType: "RECURRING",
    paymentStatus: "UNPAID",
    currentPaymentStatus: "UNPAID",
    debtCount: 2,
    debtPeriods: [
      { key: "2026-08", label: "Agustus 2026" },
      { key: "2026-09", label: "September 2026" },
    ],
    monthlyPaymentAmount: 100_000,
  };
  const dataManager = {
    getSettings: () => ({ autoRescheduleMonthly: true }),
    getTimezone: () => "Asia/Jakarta",
    getSortedReminders: () => [reminder],
    getResolvedReminderContact: () => contact,
    claimDueReminder: async () => reminder,
    moveToSent: async (_id, extras) => {
      archived.push(extras);
      return extras;
    },
    addReminder: async (payload) => {
      created.push(payload);
      return { ...payload, id: "next-reminder" };
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
  assert.equal(archived[0].deliveryStatus, "SKIPPED_ARREARS_LIMIT");
  assert.equal(archived[0].providerStatus, "skipped");
  assert.equal(created.length, 0);
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
