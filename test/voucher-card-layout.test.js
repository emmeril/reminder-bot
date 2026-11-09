const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const html = fs.readFileSync(path.join(__dirname, "../public/index.html"), "utf8");
const css = fs.readFileSync(path.join(__dirname, "../public/interface.css"), "utf8");

test("voucher cards reserve room for status and usage timestamp", () => {
  const grid = css.match(/\.voucher-card-grid\s*\{([^}]*)\}/)?.[1];
  assert.ok(grid, "Voucher card grid styles must exist");
  assert.match(grid, /grid-template-columns: repeat\(auto-fill, minmax\(min\(100%, 280px\), 1fr\)\)/);
  assert.match(css, /\.voucher-card-heading\s*\{[^}]*flex-wrap: wrap/);
  assert.match(css, /\.voucher-card-heading > span\s*\{[^}]*flex: 1 0 92px/);
  assert.match(css, /\.voucher-usage-row\s*\{[^}]*flex-direction: column/);
  assert.match(css, /\.voucher-usage-date\s*\{[^}]*flex-wrap: wrap/);
  assert.match(css, /\.voucher-usage-row time\s*\{[^}]*text-align: left/);
  assert.match(
    html,
    /<div class="voucher-usage-date" x-show="voucher\.usedAt">[\s\S]*?<span>Dipakai:<\/span>[\s\S]*?<time :datetime="voucher\.usedAt" x-text="formatDateTime\(voucher\.usedAt\)"><\/time>/,
  );
});

test("voucher layout remains responsive without changing print cards", () => {
  assert.match(css, /@media \(max-width: 620px\) \{[\s\S]*?\.voucher-card-grid \{\s*grid-template-columns: 1fr/);
  assert.match(css, /body\.voucher-print-mode \.voucher-print-page-grid \.voucher-card \{/);
  assert.match(html, /href="\/public\/interface\.css\?v=20261109-1"/);
});
