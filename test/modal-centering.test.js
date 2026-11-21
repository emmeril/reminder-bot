"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
const dashboardHtml = read("public/index.html");
const customerHtml = read("public/customer.html");
const styles = read("public/styles.css");
const interfaceCss = read("public/interface.css");
const customerCss = read("public/customer.css");

test("semua overlay modal dashboard memakai posisi tengah", () => {
  const overlays = [...dashboardHtml.matchAll(/class="([^"]*\bdashboard-modal-overlay\b[^"]*)"/g)];
  assert.ok(overlays.length >= 10, "modal dashboard tidak boleh luput dari audit");
  for (const [, classes] of overlays) {
    assert.match(classes, /\bfixed\b/);
    assert.match(classes, /\binset-0\b/);
    assert.match(classes, /\bitems-center\b/);
    assert.match(classes, /\bjustify-center\b/);
  }
  assert.match(customerHtml, /class="portal-modal-overlay"/);
});

test("aturan responsif tidak memindahkan modal ke atas atau bawah", () => {
  for (const css of [styles, interfaceCss, customerCss]) {
    assert.doesNotMatch(css, /\.dashboard-modal-overlay(?:\:not\([^)]*\))?\s*\{[^}]*align-items:\s*flex-(?:start|end)/);
    assert.doesNotMatch(css, /\.voucher-modal-overlay\s*\{[^}]*align-items:\s*flex-(?:start|end)/);
    assert.doesNotMatch(css, /\.portal-modal-overlay\s*\{[^}]*align-items:\s*flex-(?:start|end)/);
  }
  assert.match(styles, /\.dashboard-modal-overlay:not\(\.dashboard-modal-overlay-priority\)\s*\{[^}]*align-items:\s*center\s*!important/);
  assert.match(interfaceCss, /\.dashboard-modal-overlay\s*\{[^}]*align-items:\s*center\s*!important/);
  assert.match(interfaceCss, /\.voucher-modal-overlay\s*\{[^}]*align-items:\s*center\s*!important/);
  assert.match(customerCss, /\.portal-modal-overlay\s*\{[^}]*align-items:\s*center/);
});

test("dialog panjang dibatasi viewport dan dapat di-scroll", () => {
  assert.match(interfaceCss, /\.dashboard-modal-overlay\s*>\s*div\s*\{[^}]*max-height:\s*calc\(100dvh - 40px\)/);
  assert.match(interfaceCss, /\.dashboard-modal-overlay\s*>\s*div\s*\{[^}]*max-height:\s*calc\(100dvh - 24px\)\s*!important/);
  assert.match(interfaceCss, /\.voucher-modal-dialog,\s*\.voucher-profile-modal-dialog\s*\{[^}]*max-height:\s*calc\(100dvh - 24px\)/);
  assert.match(customerCss, /\.portal-modal\s*\{[^}]*max-height:\s*calc\(100dvh - 24px\)/);
  assert.match(interfaceCss, /\.dashboard-modal-overlay\s*>\s*div\s*\{[^}]*overflow-y:\s*auto/);
  assert.match(customerCss, /\.portal-modal\s*\{[^}]*overflow-y:\s*auto/);
});

test("CSS tidak memaksa display modal saat Alpine x-show menutupnya", () => {
  for (const css of [styles, interfaceCss, customerCss]) {
    const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
    for (const [, selector, declarations] of rules) {
      if (!/\.(?:dashboard-modal-overlay|voucher-modal-overlay|portal-modal-overlay)(?=\s|\{|:|$)/.test(selector)) continue;
      assert.doesNotMatch(declarations, /\bdisplay\s*:\s*[^;]*!important/, selector.trim());
    }
  }
});
