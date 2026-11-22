const fs = require("node:fs/promises");
const path = require("node:path");

function quoteRouterValue(value) {
  return `"${String(value).replace(/[\\"$\r\n]/g, (character) => ({
    "\\": "\\\\", '"': '\\"', "$": "\\$", "\r": "\\r", "\n": "\\n",
  })[character])}"`;
}

function renderVoucherScriptUpgrade(plan, direction = "after") {
  if (!["before", "after"].includes(direction)) throw new Error("Arah pembaruan script tidak valid.");
  return plan.changes.map((change) => {
    const name = quoteRouterValue(change.name);
    const profileId = quoteRouterValue(change.profileId);
    const schedulerId = quoteRouterValue(change.schedulerId);
    const scripts = change[direction];
    return [
      `:if ([/ip hotspot user profile get ${profileId} name] != ${name} or [/system scheduler get ${schedulerId} name] != ${name}) do={ :error "Profile atau scheduler berubah; hentikan pembaruan"; };`,
      `/system scheduler set ${schedulerId} on-event=${quoteRouterValue(scripts.onEvent)};`,
      `/ip hotspot user profile set ${profileId} on-login=${quoteRouterValue(scripts.onLogin)};`,
    ].join("\n");
  }).join("\n\n") + "\n";
}

async function writeVoucherScriptUpgrade(plan, outputDir) {
  await fs.mkdir(outputDir, { recursive: true, mode: 0o700 });
  for (const [filename, contents] of [
    ["snapshot.json", JSON.stringify(plan, null, 2) + "\n"],
    ["apply.rsc", renderVoucherScriptUpgrade(plan, "after")],
    ["rollback.rsc", renderVoucherScriptUpgrade(plan, "before")],
  ]) {
    await fs.writeFile(path.join(outputDir, filename), contents, { mode: 0o600, flag: "wx" });
  }
}

async function main() {
  require("dotenv").config({ quiet: true, path: path.resolve(__dirname, "../.env") });
  const MikrotikService = require("../src/modules/mikrotik/service");
  const { buildVoucherScriptUpdatePlan } = require("../src/modules/vouchers/domain");
  const service = new MikrotikService({ push() {} });
  const outputDir = path.resolve(process.argv[2] || path.join(__dirname, "../database/voucher-script-upgrades", new Date().toISOString().replace(/[:.]/g, "-")));
  const plan = await service.withConnection(async (conn, connectionInfo) => {
    const identity = await conn.menu("/system/identity").getOnly();
    const resource = await conn.menu("/system/resource").getOnly();
    const [profiles, schedulers] = await Promise.all([
      conn.menu("/ip/hotspot/user/profile").print(),
      conn.menu("/system/scheduler").print(),
    ]);
    return {
      observedAt: new Date().toISOString(),
      router: { identity: identity.name, version: resource.version, connection: connectionInfo.label },
      ...buildVoucherScriptUpdatePlan(profiles, schedulers),
    };
  });
  await writeVoucherScriptUpgrade(plan, outputDir);
  console.log(JSON.stringify({
    router: plan.router,
    profiles: plan.changes.map((change) => change.name),
    skipped: plan.skipped,
    outputDir,
    message: "Preview dan rollback tersimpan. Belum ada perubahan di router.",
  }, null, 2));
}

if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });

module.exports = { quoteRouterValue, renderVoucherScriptUpgrade, writeVoucherScriptUpgrade };
