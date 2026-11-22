"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const html = fs.readFileSync(path.join(__dirname, "../public/index.html"), "utf8");
const note = "Gunakan voucher ini untuk terhubung ke jaringan WiFi.<br><strong>Huruf besar dan kecil berpengaruh saat memasukkan username dan password.</strong>";

test("cetak voucher standar dan reward menampilkan keterangan huruf besar kecil dengan huruf tebal", () => {
  assert.match(html, /<p class="voucher-standard-note">Gunakan voucher ini untuk terhubung ke jaringan WiFi\.<br><strong>Huruf besar dan kecil berpengaruh saat memasukkan username dan password\.<\/strong><\/p>/);
  assert.match(html, /<article class="voucher-reward-card">[\s\S]*?<p>Gunakan voucher ini untuk terhubung ke jaringan WiFi\.<br><strong>Huruf besar dan kecil berpengaruh saat memasukkan username dan password\.<\/strong><\/p>/);
  assert.equal(html.split(note).length - 1, 2);
});
