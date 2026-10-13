const assert = require("node:assert/strict");
const test = require("node:test");

const TemplateManager = require("../src/template-manager");

test("nilai template dengan pola dolar dipertahankan apa adanya", () => {
  const manager = new TemplateManager({ push() {} });

  assert.equal(
    manager.applyTemplate("Halo {{name}}!", { name: "$& dan $'" }),
    "Halo $& dan $'!"
  );
});

test("nama variabel template diperlakukan sebagai teks literal", () => {
  const manager = new TemplateManager({ push() {} });

  assert.equal(
    manager.applyTemplate("Nilai {{customer.name}} dan {{customerXname}}", {
      "customer.name": "Ayu",
    }),
    "Nilai Ayu dan {{customerXname}}"
  );
});
