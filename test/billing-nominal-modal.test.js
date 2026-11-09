const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const dashboardSource = [
  "state.js", "ui.js", "selectors.js", "data.js", "actions.js",
].map((name) => fs.readFileSync(path.join(__dirname, "../public/dashboard", name), "utf8"))
  .concat(fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8"))
  .join("\n");

function setup() {
  let locked = false;
  const document = {
    body: { classList: { add() { locked = true; }, remove() { locked = false; } } },
    getElementById() { return null; },
  };
  const factory = vm.runInNewContext(dashboardSource + "\n;dashboardApp", {
    document, window: { matchMedia: () => ({ matches: false }) },
  });
  const app = factory();
  app.$nextTick = (callback) => callback();
  app.withProcessing = async (_message, action) => action();
  app.loadReminders = async () => {};
  app.notify = () => {};
  return { app, isLocked: () => locked };
}

function customer() {
  return {
    id: "member-1",
    name: "Member Test",
    subscriptionType: "RECURRING",
    mikrotikProfile: "HOME",
    monthlyPaymentAmount: 75000,
    monthlyPaymentAmountCustomized: false,
    hotspotProvisioningStatus: "NONE",
  };
}

test("draf nominal tidak mengubah data pelanggan sebelum disimpan atau setelah modal ditutup", () => {
  const { app, isLocked } = setup();
  const contact = customer();
  app.contacts = [contact];
  app.openBillingActionModal(contact);
  assert.equal(isLocked(), true);
  assert.equal(app.billingActionModal.activeTab, "actions");
  assert.equal(app.billingActionModal.amountDraft, "75000");
  app.selectBillingActionTab("amount");
  assert.equal(app.billingActionModal.activeTab, "amount");
  app.billingActionModal.amountDraft = "125000";
  assert.equal(contact.monthlyPaymentAmount, 75000);
  assert.equal(app.contacts[0].monthlyPaymentAmount, 75000);
  app.closeBillingActionModal();
  assert.equal(isLocked(), false);
  assert.equal(app.billingActionModal.amountDraft, "");
  app.openBillingActionModal(contact);
  assert.equal(app.billingActionModal.activeTab, "actions");
  assert.equal(app.billingActionModal.amountDraft, "75000");
  app.closeBillingActionModal();
});

test("simpan nominal di modal memakai endpoint lama dan memperbarui tabel", async () => {
  const { app } = setup();
  const contact = customer();
  app.contacts = [contact];
  const requests = [];
  app.api = async (url, options) => {
    const payload = JSON.parse(options.body);
    requests.push({ url, method: options.method, payload });
    return { ...contact, monthlyPaymentAmount: payload.monthlyPaymentAmount, monthlyPaymentAmountCustomized: true };
  };
  app.openBillingActionModal(contact);
  app.selectBillingActionTab("amount");
  app.billingActionModal.amountDraft = "82500";
  await app.saveBillingActionAmount();
  assert.deepEqual(requests, [{
    url: "/api/contacts/member-1/payment-amount",
    method: "POST",
    payload: { monthlyPaymentAmount: 82500 },
  }]);
  assert.equal(contact.monthlyPaymentAmount, 75000);
  assert.equal(app.contacts[0].monthlyPaymentAmount, 82500);
  assert.equal(app.billingActionModal.contact.monthlyPaymentAmount, 82500);
  assert.equal(app.billingActionModal.amountDraft, "82500");
  assert.equal(app.billingActionModal.activeTab, "amount");
  assert.equal(app.billingActionModal.open, true);
  assert.equal(app.billingActionModal.amountError, "");
  app.closeBillingActionModal();
});

test("invalid input ditolak sebelum API; error server tidak mengubah nominal dan bisa dicoba lagi", async () => {
  const { app } = setup();
  const contact = customer();
  app.contacts = [contact];
  let count = 0;
  app.api = async () => {
    count += 1;
    throw new Error("Koneksi gagal");
  };
  app.openBillingActionModal(contact);
  for (const value of ["", "-5", "1.5", "1e6", "1000000001", "bukan angka"]) {
    app.billingActionModal.amountDraft = value;
    await app.saveBillingActionAmount();
    assert.match(app.billingActionModal.amountError, /Masukkan nominal bulanan/);
  }
  assert.equal(count, 0);
  assert.equal(contact.monthlyPaymentAmount, 75000);
  app.billingActionModal.amountDraft = "50000";
  await app.saveBillingActionAmount();
  assert.equal(count, 1);
  assert.equal(app.billingActionModal.amountError, "Koneksi gagal");
  assert.equal(app.billingActionModal.amountDraft, "50000");
  assert.equal(app.contacts[0].monthlyPaymentAmount, 75000);
  app.api = async (_url, options) => ({
    ...contact,
    monthlyPaymentAmount: JSON.parse(options.body).monthlyPaymentAmount,
    monthlyPaymentAmountCustomized: true,
  });
  await app.saveBillingActionAmount();
  assert.equal(app.contacts[0].monthlyPaymentAmount, 50000);
  assert.equal(app.billingActionModal.amountError, "");
  app.closeBillingActionModal();
});

test("tarif profil dipulihkan dari modal dan tombol kelola tetap ada ketika paket belum siap", async () => {
  const { app } = setup();
  const contact = { ...customer(), monthlyPaymentAmount: 85000, monthlyPaymentAmountCustomized: true };
  app.forms.settings.profileMonthlyAmounts = { HOME: 65000 };
  app.contacts = [contact];
  assert.equal(app.hasBillingActions(contact), true);
  assert.equal(app.hasBillingPaymentActions(contact), false);
  let resetPayload = null;
  app.api = async (_url, options) => {
    resetPayload = JSON.parse(options.body);
    return { ...contact, monthlyPaymentAmount: 65000, monthlyPaymentAmountCustomized: false };
  };
  app.openBillingActionModal(contact);
  app.selectBillingActionTab("amount");
  await app.resetBillingActionAmount();
  assert.deepEqual(resetPayload, { useProfileDefault: true });
  assert.equal(app.contacts[0].monthlyPaymentAmount, 65000);
  assert.equal(app.billingActionModal.contact.monthlyPaymentAmountCustomized, false);
  assert.equal(app.billingActionModal.amountDraft, "65000");
  app.closeBillingActionModal();
});
