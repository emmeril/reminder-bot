const assert = require("node:assert/strict");
const test = require("node:test");
const { buildVoucherProfileScripts, parseVoucherUsageRecord } = require("../src/modules/vouchers/domain");
const { runRouterScript } = require("./helpers/routeros-script");

const profile = {
  name: "VCR-1D", expiredMode: "remc", validity: "1d",
  sellingPrice: 3000, costPrice: 2000, commission: 1000, lockUser: false,
};

function fixture({ date = "nov/22/2026", time = "08:00:00", users, onCommentCheck, commentWriteFailure } = {}) {
  const rows = (users || [{ name: "test-voucher", comment: "vc|batch-abc123|", profile: profile.name }])
    .map((user, index) => ({ ".id": `*U${index}`, "mac-address": "00:00:00:00:00:00", uptime: 0, disabled: false, ...user }));
  const schedulers = [];
  const records = [];
  const disconnected = [];
  const writes = [];
  const logs = [];
  let commentReads = 0;
  const idOf = (value) => Array.isArray(value) ? value[0] : value;
  const router = ({ path, action, args, positional }) => {
    if (path === "system/clock" && action === "get") return positional[0] === "date" ? date : time;
    let table;
    if (path === "ip/hotspot/user") table = rows;
    else if (path === "system/scheduler") table = schedulers;
    else if (path === "system/script" && action === "add") { records.push(args); return; }
    else if (path === "ip/hotspot/active") {
      if (action === "find") return [args.user];
      if (action === "remove") { disconnected.push(...positional[0]); return; }
    }
    if (!table) throw new Error(`Unsupported router command ${path} ${action}`);
    if (action === "find") return table.filter((row) => Object.entries(args).every(([key, value]) => row[key] === value)).map((row) => row[".id"]);
    if (action === "add") {
      if (table.some((row) => row.name === args.name)) throw new Error("Duplicate scheduler");
      table.push({ ".id": "*TEMP", ...args });
      writes.push({ path, action, args });
      return;
    }
    const row = table.find((item) => item[".id"] === idOf(positional[0]));
    if (!row) throw new Error("Router item not found");
    if (action === "get") {
      if (positional[1] === "comment" && ++commentReads === 2) onCommentCheck?.(rows);
      if (positional[1] === "disabled") return [true, "yes", "true"].includes(row.disabled);
      return row[positional[1]] ?? "";
    }
    if (action === "set" && args.comment && commentWriteFailure) {
      if (commentWriteFailure === "throw") throw new Error("Connection interrupted while saving expiry");
      return;
    }
    if (action === "set") Object.assign(row, args);
    else if (action === "remove") table.splice(table.indexOf(row), 1);
    else throw new Error(`Unsupported router action ${action}`);
    writes.push({ path, action, args, name: row.name });
  };
  return {
    rows, schedulers, records, disconnected, writes, logs,
    run(source) {
      return runRouterScript(source, {
        router, logs,
        variables: { user: "test-voucher", address: "10.0.0.2", "mac-address": "AA:BB:CC:DD:EE:FF" },
      });
    },
  };
}

test("login ROS 6 dan 7 menghitung expired langsung tanpa scheduler sementara", () => {
  const cases = [
    ["nov/22/2026", "08:00:00", "4h", "nov/22/2026 12:00:00"],
    ["nov/22/2026", "08:00:00", "1d", "nov/23/2026 08:00:00"],
    ["dec/31/2026", "23:59:59", "1s", "jan/01/2027 00:00:00"],
    ["2026-11-22", "08:00:00", "4h", "2026-11-22 12:00:00"],
    ["2026-11-22", "08:00:00", "1d", "2026-11-23 08:00:00"],
    ["2026-12-31", "23:59:59", "1s", "2027-01-01 00:00:00"],
    ["2028-02-28", "08:00:00", "1d", "2028-02-29 08:00:00"],
    ["2027-02-28", "08:00:00", "1d", "2027-03-01 08:00:00"],
    ["2100-02-28", "08:00:00", "1d", "2100-03-01 08:00:00"],
    ["2000-02-28", "08:00:00", "1d", "2000-02-29 08:00:00"],
    ["2026-01-31", "08:00:00", "30d", "2026-03-02 08:00:00"],
    ["2026-11-22", "08:00:00", "1w2d3h4m5s", "2026-12-01 11:04:05"],
  ];
  for (const [date, time, validity, expected] of cases) {
    const state = fixture({ date, time });
    state.run(buildVoucherProfileScripts({ ...profile, validity }).onLogin);
    assert.equal(state.rows[0].comment, expected, `${date}: ${validity}`);
    assert.equal(state.schedulers.length, 0);
    assert.equal(state.logs.length, 0);
    assert.equal(state.writes.some((write) => write.path === "system/scheduler"), false);
    assert.equal(state.records.length, 1);
    const record = parseVoucherUsageRecord({ ...state.records[0], ".id": "*REC" }, new Map(), "Asia/Jakarta");
    assert.equal(record.amount, 3000);
    assert.equal(record.costPrice, 2000);
    assert.equal(record.commission, 1000);
    assert.equal(record.batchId, "batch-abc123");
    const expectedOwners = { "dec/31/2026": "dec2026", "2026-12-31": "dec2026", "2028-02-28": "feb2028", "2027-02-28": "feb2027", "2100-02-28": "feb2100", "2000-02-28": "feb2000", "2026-01-31": "jan2026" };
    assert.equal(state.records[0].owner, expectedOwners[date] || "nov2026");
  }
});

test("login ulang dan upgrade ROS mempertahankan tanggal expired yang sudah tersimpan", () => {
  for (const comment of ["nov/23/2026 08:00:00", "2026-11-23 08:00:00"]) {
    const state = fixture({ date: "2026-11-22", users: [{ name: "test-voucher", comment }] });
    state.run(buildVoucherProfileScripts({ ...profile, lockUser: true }).onLogin);
    assert.equal(state.rows[0].comment, comment);
    assert.equal(state.rows[0]["mac-address"], "AA:BB:CC:DD:EE:FF");
    assert.equal(state.records.length, 0);
    assert.equal(state.writes.some((write) => write.path === "system/scheduler"), false);
  }
});

test("aktivasi yang berubah saat login tidak ditimpa dan tidak dicatat dua kali", () => {
  const state = fixture({ onCommentCheck: (users) => { users[0].comment = "nov/25/2026 08:00:00"; } });
  state.run(buildVoucherProfileScripts(profile).onLogin);
  assert.equal(state.rows[0].comment, "nov/25/2026 08:00:00");
  assert.equal(state.records.length, 0);
  assert.equal(state.schedulers.length, 0);
});

test("kegagalan menyimpan expired memutus sesi tanpa meninggalkan scheduler atau catatan pendapatan", () => {
  for (const commentWriteFailure of ["throw", "ignore"]) {
    const state = fixture({ commentWriteFailure });
    state.run(buildVoucherProfileScripts(profile).onLogin);
    assert.equal(state.rows[0].comment, "vc|batch-abc123|");
    assert.equal(state.records.length, 0);
    assert.equal(state.schedulers.length, 0);
    assert.deepEqual(state.disconnected, ["test-voucher"]);
    assert.equal(state.logs[0].level, "error");
  }
});

test("voucher lama yang sudah dipakai tanpa expired tidak memperoleh masa aktif baru saat login", () => {
  const state = fixture({ users: [{ name: "test-voucher", profile: profile.name, comment: "up-351-04.20.26-free1", uptime: 90063 }] });
  state.run(buildVoucherProfileScripts(profile).onLogin);
  assert.equal(state.rows[0].comment, "up-351-04.20.26-free1");
  assert.equal(state.rows[0].disabled, "yes");
  assert.equal(state.records.length, 0);
  assert.deepEqual(state.disconnected, ["test-voucher"]);
  assert.equal(state.logs[0].level, "error");
});

test("monitor memblokir voucher terpakai tanpa expired dan membiarkan stok baru serta pelanggan biasa", () => {
  const state = fixture({ users: [
    { name: "stuck", profile: profile.name, comment: "up-351-04.20.26-free1", uptime: 90063 },
    { name: "new", profile: profile.name, comment: "vc|batch-abc123|", uptime: 0 },
    { name: "just-logged-in", profile: profile.name, comment: "vc|batch-abc123|", uptime: 1 },
    { name: "customer", profile: profile.name, comment: "Pelanggan Prabayar", uptime: 90063 },
    { name: "unmarked", profile: profile.name, comment: "", uptime: 90063 },
  ] });
  const monitor = buildVoucherProfileScripts(profile).monitor;
  state.run(monitor);
  assert.deepEqual(state.rows.filter(row => row.disabled === "yes").map(row => row.name), ["stuck"]);
  assert.deepEqual(state.disconnected, ["stuck"]);
  assert.equal(state.rows.length, 5);
  assert.equal(state.logs.length, 1);
  state.run(monitor);
  assert.equal(state.logs.length, 1);
});

test("monitor memproses komentar ROS 6 dan 7 pada batas detik, hari, dan tahun", () => {
  for (const date of ["nov/22/2026", "2026-11-22"]) {
    for (const expiredMode of ["rem", "remc", "ntf", "ntfc"]) {
      const comments = [
        "nov/21/2026 08:00:00", "2026-11-21 23:59:59", "nov/22/2026 08:00:00", "2026-11-22 07:59:59",
        "dec/31/2025 23:59:59", "2026-11-22 08:00:01", "nov/23/2026 00:00:00", "2027-01-01 00:00:00",
        "vc|batch-abc123|", "voucher-batch-abc123 catatan", "", "catatan bebas", "2026-02-30 00:00:00", "xxx/22/2026 08:00:00", "2026-11-22 24:00:00",
      ];
      const state = fixture({ date, users: comments.map((comment, index) => ({ name: `user-${index}`, profile: profile.name, comment })) });
      state.run(buildVoucherProfileScripts({ ...profile, expiredMode }).monitor);
      const expired = ["user-0", "user-1", "user-2", "user-3", "user-4"];
      assert.deepEqual(state.disconnected, expired, `${date} ${expiredMode}`);
      assert.equal(state.logs.length, 0);
      if (expiredMode.startsWith("rem")) assert.equal(state.rows.length, comments.length - expired.length);
      else assert.deepEqual(state.rows.filter((user) => user["limit-uptime"] === "1s").map((user) => user.name), expired);
    }
  }
});

test("monitor membedakan tahun kabisat, komentar rusak, dan profile lain", () => {
  const state = fixture({ date: "2028-03-01", users: [
    { name: "leap", profile: profile.name, comment: "2028-02-29 08:00:00" },
    { name: "invalid-leap", profile: profile.name, comment: "2027-02-29 08:00:00" },
    { name: "other", profile: "Bulanan", comment: "nov/20/2026 08:00:00" },
  ] });
  state.run(buildVoucherProfileScripts(profile).monitor);
  assert.deepEqual(state.disconnected, ["leap"]);
  assert.deepEqual(state.rows.map((user) => user.name), ["invalid-leap", "other"]);
});

test("monitor menolak jam router yang tidak valid tanpa mengubah user", () => {
  const state = fixture({ date: "invalid", users: [{ name: "old", profile: profile.name, comment: "nov/20/2026 08:00:00" }] });
  assert.throws(() => state.run(buildVoucherProfileScripts(profile).monitor), /Invalid router clock/);
  assert.equal(state.writes.length, 0);
  assert.equal(state.disconnected.length, 0);
});
