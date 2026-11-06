const fs = require("fs/promises");
const net = require("net");
const path = require("path");
const ExcelJS = require("exceljs");
const {
  DEFAULT_SETTINGS,
  PAYMENT_STATUS,
  PAYMENT_TYPES,
} = require("../../config");
const {
  PAYMENT_TYPE_LABELS,
  compareBillingPeriods,
  formatReportDate,
  getContactBillingPeriod,
  getContactBillingStartPeriod,
  isOneTimeSubscriptionEnded,
  isPostpaidBilling,
  isPrepaidPackage,
  isRecurringSubscription,
  listBillingPeriods,
  normalizeProfileMonthlyAmounts,
  styleReportSheet,
} = require("../customers/domain");
const {
  formatBillingPeriodLabel,
  getBillingPeriodKey,
  getBillingPeriodParts,
  getPreviousBillingPeriod,
  isValidTimeZone,
  makeBillingPeriodKey,
  parseBoolean,
  sanitizeInput,
  sanitizeMultilineText,
  sanitizePositiveInteger,
  sanitizeTimeHHMM,
} = require("../../utils");
const CustomerDataManager = require("./customers");

class DataManager extends CustomerDataManager {
  getSettings() {
    const settings = { ...DEFAULT_SETTINGS, ...this.settings };
    settings.profileMonthlyAmounts = normalizeProfileMonthlyAmounts(settings.profileMonthlyAmounts);
    delete settings.monthlyPaymentAmount;
    delete settings.hotspotReactivationMessageTemplate;
    return settings;
  }
