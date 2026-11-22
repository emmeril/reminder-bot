const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { buildVoucherScriptUpdatePlan, parseVoucherProfileMetadata } = require("../src/modules/vouchers/domain");
const { quoteRouterValue, renderVoucherScriptUpgrade, writeVoucherScriptUpgrade } = require("../scripts/prepare-voucher-script-upgrade");

function fixture() {
  return {
    profiles: [
      { ".id": "*1", name: "4Jam", "on-login": ':put (",remc,667,4h,1000,,Enable,123,"); old-script', "rate-limit": "1M/3M" },
      { ".id": "*2", name: "Bulanan", "on-login": ':put (",,100000,30d,100000,noexp,Disable,")' },
    ],
    schedulers: [{ ".id": "*A", name: "4Jam", comment: "Monitor Profile 4Jam", "on-event": "old-monitor", disabled: "true", interval: "2m35s" }],
  };
}

test("preview pembaruan hanya memilih script voucher dan mempertahankan metadata serta konfigurasi awal", () => {
  const { profiles, schedulers } = fixture();
  const original = structuredClone({ profiles, schedulers });
  const plan = buildVoucherScriptUpdatePlan(profiles, schedulers);
  assert.equal(plan.changes.length, 1);
  assert.deepEqual(plan.skipped, []);
  const [change] = plan.changes;
  assert.equal(change.name, "4Jam");
  assert.equal(change.profileId, "*1");
  assert.equal(change.schedulerId, "*A");
  assert.equal(change.schedulerDisabled, "true");
  assert.deepEqual(change.before, { onLogin: profiles[0]["on-login"], onEvent: "old-monitor" });
  assert.deepEqual(parseVoucherProfileMetadata(change.after.onLogin), parseVoucherProfileMetadata(change.before.onLogin));
  assert.deepEqual({ profiles, schedulers }, original);
  profiles[0]["on-login"] = change.after.onLogin;
  schedulers[0]["on-event"] = change.after.onEvent;
  assert.deepEqual(buildVoucherScriptUpdatePlan(profiles, schedulers), { changes: [], skipped: [] });
});

test("preview melewati scheduler hilang, konflik nama, dan metadata voucher tidak valid", () => {
  const { profiles, schedulers } = fixture();
  for (const rows of [[], [{ ...schedulers[0], comment: "Fungsi lain" }], [schedulers[0], schedulers[0]]]) {
    const plan = buildVoucherScriptUpdatePlan(profiles, rows);
    assert.equal(plan.changes.length, 0);
    assert.equal(plan.skipped.length, 1);
  }
  profiles[0]["on-login"] = ':put (",remc,667,invalid,1000,,Enable,123,")';
  assert.equal(buildVoucherScriptUpdatePlan(profiles, schedulers).skipped.length, 1);
  assert.throws(() => buildVoucherScriptUpdatePlan(null, schedulers), /tidak valid/);
});

test("file import mengutip dollar, tanda kutip, backslash, dan baris baru sebagai nilai literal", () => {
  assert.equal(quoteRouterValue('$user "x" \\ \n\r'), '"\\$user \\"x\\" \\\\ \\n\\r"');
  const { profiles, schedulers } = fixture();
  const plan = buildVoucherScriptUpdatePlan(profiles, schedulers);
  for (const direction of ["before", "after"]) {
    const script = renderVoucherScriptUpgrade(plan, direction);
    assert.ok(script.indexOf("/system scheduler set") < script.indexOf("/ip hotspot user profile set"));
    assert.ok(script.includes(`on-login=${quoteRouterValue(plan.changes[0][direction].onLogin)}`));
    assert.ok(script.includes(`on-event=${quoteRouterValue(plan.changes[0][direction].onEvent)}`));
    const changedFields = [...script.matchAll(/^\/[^\n]+ set "\*[^\"]+" ([a-z-]+)=/gm)].map((match) => match[1]);
    assert.deepEqual(changedFields, ["on-event", "on-login"]);
    assert.match(script, /get "\*1" name/);
    assert.match(script, /get "\*A" name/);
  }
});

test("snapshot dan rollback disimpan privat tanpa menimpa backup sebelumnya", async (t) => {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "voucher-upgrade-"));
  t.after(() => fs.rm(outputDir, { recursive: true, force: true }));
  const { profiles, schedulers } = fixture();
  const plan = buildVoucherScriptUpdatePlan(profiles, schedulers);
  await writeVoucherScriptUpgrade(plan, outputDir);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(outputDir, "snapshot.json"), "utf8")), plan);
  assert.equal(await fs.readFile(path.join(outputDir, "rollback.rsc"), "utf8"), renderVoucherScriptUpgrade(plan, "before"));
  assert.equal((await fs.stat(path.join(outputDir, "snapshot.json"))).mode & 0o777, 0o600);
  await assert.rejects(writeVoucherScriptUpgrade(plan, outputDir), { code: "EEXIST" });
});
