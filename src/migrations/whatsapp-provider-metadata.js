function addMissing(target, key, value) {
  if (Object.prototype.hasOwnProperty.call(target, key)) return false;
  target[key] = value;
  return true;
}

function migrateReminderPayload(reminder, options = {}) {
  if (!reminder || typeof reminder !== "object") return false;
  let changed = false;
  changed = addMissing(reminder, "whatsappProvider", null) || changed;
  changed = addMissing(reminder, "providerMessageId", null) || changed;
  changed = addMissing(reminder, "providerError", reminder.deliveryError || null) || changed;

  let defaultStatus = null;
  if (options.sent) {
    defaultStatus = String(reminder.deliveryStatus || "").toUpperCase() === "FAILED" ? "failed" : "sent";
  } else if (!reminder.deliveryAttemptedAt) {
    defaultStatus = "pending";
  }
  changed = addMissing(reminder, "providerStatus", defaultStatus) || changed;
  return changed;
}

async function migrateWhatsAppProviderMetadata(dataManager) {
  let remindersChanged = false;
  let sentChanged = false;
  for (const reminder of dataManager.reminders.values()) {
    remindersChanged = migrateReminderPayload(reminder) || remindersChanged;
  }
  for (const reminder of dataManager.sentReminders.values()) {
    sentChanged = migrateReminderPayload(reminder, { sent: true }) || sentChanged;
  }
  if (remindersChanged) await dataManager.saveReminders();
  if (sentChanged) await dataManager.saveSentReminders();
  return { remindersChanged, sentChanged };
}

module.exports = {
  migrateReminderPayload,
  migrateWhatsAppProviderMetadata,
};
