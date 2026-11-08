const assert = require("node:assert/strict");
const test = require("node:test");

const { MikrotikService } = require("../src/app");

function createServiceWithUsers(initialUsers = [], initialScripts = [], initialBindings = []) {
  const users = initialUsers.map((user) => ({ ...user }));
  const scripts = initialScripts.map((script) => ({ ...script }));
  const bindings = initialBindings.map((binding) => ({ ...binding }));
  const addedPayloads = [];
  let addCalls = 0;
  let updateCalls = 0;
  let removeCalls = 0;
  let killedSessions = 0;
  const userMenu = {
    print: async () => users.map((user) => ({ ...user })),
    add: async (payload) => {
      addCalls += 1;
      addedPayloads.push({ ...payload });
      users.push({ ".id": `*${users.length + 1}`, ...payload, disabled: "false" });
      return {};
    },
    update: async (payload, id) => {
      updateCalls += 1;
      const user = users.find((item) => String(item[".id"] || item.id) === String(id));
      if (!user) throw new Error("user tidak ditemukan");
      Object.assign(user, payload);
      return [];
    },
    remove: async (id) => {
      removeCalls += 1;
      const index = users.findIndex((item) => String(item[".id"] || item.id) === String(id));
      if (index >= 0) users.splice(index, 1);
      return [];
    },
  };
  const connection = {
    menu: (path) => {
      if (path === "/ip/hotspot/user") return userMenu;
      if (path === "/ip/hotspot/ip-binding") {
        return {
          print: async () => bindings.map((binding) => {
            const returned = { ...binding };
            if (returned.type === "regular") delete returned.type;
            return returned;
          }),
          add: async (payload) => {
            bindings.push({ ".id": `*B${bindings.length + 1}`, ...payload });
            return {};
          },
          update: async (payload, id) => {
            const binding = bindings.find((item) => String(item[".id"] || item.id) === String(id));
            if (!binding) throw new Error("binding tidak ditemukan");
            Object.assign(binding, payload);
            return [];
          },
          remove: async (id) => {
            const index = bindings.findIndex((item) => String(item[".id"] || item.id) === String(id));
            if (index >= 0) bindings.splice(index, 1);
            return [];
          },
        };
      }
      if (path === "/ip/hotspot/user/profile") {
        return { print: async () => [{ name: "100M", "on-login": ':put (",rem,0,1d,40000,,Disable,0,")' }] };
      }
      if (path === "/system/scheduler") {
        return { print: async () => [{ name: "100M", disabled: "false", comment: "Monitor Profile 100M" }] };
      }
      if (path === "/system/script") {
        return { print: async () => scripts.map((script) => ({ ...script })) };
      }
      if (path === "/ip/hotspot") {
        return { print: async () => [{ name: "hotspot-utama" }] };
      }
      if (path === "/ip/hotspot/active") {
        return {
          print: async () => users
            .filter((user) => user.active)
            .map((user) => ({ ".id": `active-${user[".id"]}`, user: user.name })),
          remove: async () => {
            killedSessions += 1;
          },
        };
      }
      throw new Error(`Menu tidak dikenal: ${path}`);
    },
  };
  const service = new MikrotikService({ push() {} });
  service.withConnection = async (operation) => operation(connection, {});
  return {
    service,
    users,
    bindings,
    getAddCalls: () => addCalls,
    getUpdateCalls: () => updateCalls,
    getRemoveCalls: () => removeCalls,
    getKilledSessions: () => killedSessions,
    getAddedPayloads: () => addedPayloads.map((payload) => ({ ...payload })),
  };
}

test("membuat satu voucher hotspot dengan kredensial yang ditentukan", async () => {
  const { service, users, getAddedPayloads } = createServiceWithUsers();

  const result = await service.createHotspotVouchers({
    generationType: "SINGLE",
    username: "voucher-001",
    password: "rahasia-001",
    profile: "100M",
    server: "hotspot-utama",
    limitUptime: "12h",
    dataLimit: 2,
    dataUnit: "GB",
    comment: "Event November",
  });

  assert.equal(result.quantity, 1);
  assert.equal(result.sellingPrice, 40000);
  assert.deepEqual(result.vouchers, [{ username: "voucher-001", password: "rahasia-001" }]);
  assert.equal(users[0].name, "voucher-001");
  assert.equal(users[0].profile, "100M");
  assert.equal(getAddedPayloads()[0].server, "hotspot-utama");
  assert.equal(getAddedPayloads()[0]["limit-uptime"], "12h");
  assert.equal(getAddedPayloads()[0]["limit-bytes-total"], String(2 * 1_073_741_824));
  assert.match(getAddedPayloads()[0].comment, /^vc\|[a-z0-9]+-[a-f0-9]+\|Event November$/);
});

test("membuat banyak voucher unik dengan username dan password yang sama", async () => {
  const { service, users } = createServiceWithUsers([{ ".id": "*1", name: "wifi-abcd", profile: "100M" }]);
  const progress = [];

  const result = await service.createHotspotVouchers({
    generationType: "BULK",
    quantity: 25,
    credentialMode: "SAME",
    codeLength: 6,
    characterSet: "LOWER",
    prefix: "wifi-",
    profile: "100M",
    server: "all",
  }, {
    onProgress: (update) => progress.push(update),
  });

  assert.equal(result.quantity, 25);
  assert.equal(new Set(result.vouchers.map((voucher) => voucher.username.toLowerCase())).size, 25);
  assert.equal(result.vouchers.every((voucher) => voucher.username === voucher.password), true);
  assert.equal(result.vouchers.every((voucher) => /^wifi-[a-z0-9]{6}$/.test(voucher.username)), true);
  assert.equal(users.length, 26);
  assert.deepEqual(progress.at(-1), { phase: "VERIFYING", completed: 25, total: 25 });
});

test("menghapus voucher memutus sesi aktif dan hanya menerima voucher dari batch yang sama", async () => {
  const batchId = "batch-delete-1";
  const { service, users, getRemoveCalls, getKilledSessions } = createServiceWithUsers([
    {
      ".id": "*1",
      name: "voucher-delete",
      profile: "100M",
      comment: `vc|${batchId}|Batch test`,
      active: true,
    },
  ]);

  const result = await service.deleteHotspotVoucher({ batchId, username: "voucher-delete" });

  assert.equal(result.removedUsers, 1);
  assert.equal(result.activeSessionsKilled, 1);
  assert.equal(result.alreadyAbsent, false);
  assert.equal(getRemoveCalls(), 1);
  assert.equal(getKilledSessions(), 1);
  assert.equal(users.length, 0);

  const unrelated = createServiceWithUsers([{
    ".id": "*2",
    name: "voucher-reused",
    profile: "100M",
    comment: "vc|batch-lain|Bukan batch ini",
  }]).service;
  await assert.rejects(
    () => unrelated.deleteHotspotVoucher({ batchId, username: "voucher-reused" }),
    /tidak lagi terhubung ke batch yang dipilih/,
  );
});

test("reset perangkat voucher melepas MAC dan memutus sesi aktif tanpa menghapus user", async () => {
  const batchId = "mh123-abc123";
  const { service, users, getUpdateCalls, getKilledSessions } = createServiceWithUsers([{
    ".id": "*1",
    name: "voucher-reset",
    profile: "100M",
    comment: `vc|${batchId}|Batch perangkat`,
    "mac-address": "AA:BB:CC:DD:EE:FF",
    active: true,
  }]);

  const result = await service.resetHotspotVoucherMac({ batchId, username: "voucher-reset" });

  assert.equal(result.previousMacAddress, "AA:BB:CC:DD:EE:FF");
  assert.equal(result.activeSessionsKilled, 1);
  assert.equal(result.alreadyReset, false);
  assert.equal(getUpdateCalls(), 1);
  assert.equal(getKilledSessions(), 1);
  assert.equal(users.length, 1);
  assert.equal(users[0]["mac-address"], "00:00:00:00:00:00");

  const unrelated = createServiceWithUsers([{
    ".id": "*2",
    name: "voucher-reset",
    profile: "100M",
    comment: "vc|mh456-def456|Batch lain",
    "mac-address": "11:22:33:44:55:66",
  }]).service;
  await assert.rejects(
    () => unrelated.resetHotspotVoucherMac({ batchId, username: "voucher-reset" }),
    /tidak lagi terhubung ke batch yang dipilih/,
  );
});

test("riwayat batch voucher dibaca kembali dari data MikroTik", async () => {
  const { service } = createServiceWithUsers();
  const firstBatch = await service.createHotspotVouchers({
    generationType: "SINGLE",
    username: "voucher-lama",
    password: "password-lama",
    profile: "100M",
    server: "all",
    comment: "Batch pertama",
  });
  const secondBatch = await service.createHotspotVouchers({
    generationType: "BULK",
    quantity: 2,
    credentialMode: "SAME",
    codeLength: 6,
    characterSet: "UPPER",
    prefix: "NEW-",
    profile: "100M",
    server: "hotspot-utama",
    comment: "Batch kedua",
  });

  const batches = await service.getHotspotVoucherBatches();

  assert.equal(batches.length, 2);
  assert.deepEqual(new Set(batches.map((batch) => batch.batchId)), new Set([
    firstBatch.batchId,
    secondBatch.batchId,
  ]));
  const restoredFirst = batches.find((batch) => batch.batchId === firstBatch.batchId);
  const restoredSecond = batches.find((batch) => batch.batchId === secondBatch.batchId);
  assert.equal(restoredFirst.quantity, 1);
  assert.equal(restoredFirst.sellingPrice, 40000);
  assert.equal(restoredFirst.validity, "1d");
  assert.equal(restoredFirst.comment, "Batch pertama");
  assert.deepEqual(restoredFirst.vouchers[0], {
    username: "voucher-lama",
    password: "password-lama",
    macAddress: "",
    disabled: false,
    used: false,
    usageStatus: "UNUSED",
    usedAt: null,
  });
  assert.equal(restoredSecond.quantity, 2);
  assert.equal(restoredSecond.server, "hotspot-utama");
  assert.equal(restoredSecond.vouchers.every((voucher) => voucher.username === voucher.password), true);
});

test("riwayat batch menandai voucher yang sudah digunakan tanpa menghilangkannya", async () => {
  const batchId = "lxyz-abc123";
  const { service } = createServiceWithUsers([
    {
      ".id": "*1",
      name: "voucher-belum",
      password: "router-belum",
      profile: "100M",
      comment: `vc|${batchId}|Batch November`,
    },
    {
      ".id": "*2",
      name: "voucher-sudah",
      password: "router-sudah",
      profile: "100M",
      comment: "nov/03/2026 08:00:00",
    },
  ], [{
    ".id": "*A",
    comment: "Mikhmon",
    name: `nov/03/2026-|-08:00:00-|-voucher-sudah-|-40000-|-10.0.0.2-|-AA:BB:CC:DD:EE:FF-|-1d-|-100M-|-vc|${batchId}|Batch November-|-hotspot`,
  }, {
    ".id": "*B",
    comment: "Mikhmon",
    name: "nov/02/2026-|-08:00:00-|-voucher-belum-|-40000-|-10.0.0.3-|-AA:BB:CC:DD:EE:00-|-1d-|-100M-|-vc|batchlama-aabbcc|Batch lama-|-hotspot",
  }]);

  const [batch] = await service.getHotspotVoucherBatches({
    knownBatches: [{
      batchId,
      profile: "100M",
      dataLimit: 2,
      dataUnit: "GB",
      vouchers: [
        { username: "voucher-belum", password: "simpan-belum" },
        { username: "voucher-sudah", password: "simpan-sudah" },
        { username: "voucher-hilang", password: "simpan-hilang" },
      ],
    }],
  });

  const vouchers = Object.fromEntries(batch.vouchers.map((voucher) => [voucher.username, voucher]));
  assert.equal(batch.quantity, 3);
  assert.equal(batch.dataLimit, 2);
  assert.equal(batch.dataUnit, "GB");
  assert.equal(vouchers["voucher-belum"].usageStatus, "UNUSED");
  assert.equal(vouchers["voucher-sudah"].usageStatus, "USED");
  assert.equal(vouchers["voucher-sudah"].used, true);
  assert.match(vouchers["voucher-sudah"].usedAt, /^2026-11-03T/);
  assert.equal(vouchers["voucher-sudah"].password, "simpan-sudah");
  assert.equal(vouchers["voucher-hilang"].usageStatus, "MISSING");
});

test("pembuatan voucher menolak username yang sudah ada", async () => {
  const { service, getAddCalls } = createServiceWithUsers([{ ".id": "*1", name: "voucher-001", profile: "100M" }]);

  await assert.rejects(() => service.createHotspotVouchers({
    generationType: "SINGLE",
    username: "VOUCHER-001",
    password: "baru-001",
    profile: "100M",
    server: "all",
  }), /sudah digunakan/);
  assert.equal(getAddCalls(), 0);
});

test("batch voucher dibatalkan jika pembuatan gagal di tengah proses", async () => {
  const users = [];
  let addCalls = 0;
  const userMenu = {
    async print() {
      return users.map((user) => ({ ...user }));
    },
    async add(payload) {
      addCalls += 1;
      if (addCalls === 2) throw new Error("router terputus");
      users.push({ ".id": "*1", ...payload });
      return {};
    },
    async remove(id) {
      const index = users.findIndex((user) => String(user[".id"]) === String(id));
      if (index >= 0) users.splice(index, 1);
    },
  };
  const service = new MikrotikService({ push() {} });
  service.withConnection = async (operation) => operation({
    menu(path) {
      if (path === "/ip/hotspot/user") return userMenu;
      if (path === "/ip/hotspot/user/profile") return { print: async () => [{ name: "100M", "on-login": ':put (",rem,0,1d,0,,Disable,0,")' }] };
      if (path === "/system/scheduler") return { print: async () => [{ name: "100M", disabled: "false" }] };
      if (path === "/ip/hotspot") return { print: async () => [{ name: "hotspot-utama" }] };
      throw new Error(`Menu tidak dikenal: ${path}`);
    },
  }, {});

  await assert.rejects(() => service.createHotspotVouchers({
    generationType: "BULK",
    quantity: 3,
    credentialMode: "SEPARATE",
    codeLength: 6,
    characterSet: "UPPER",
    profile: "100M",
    server: "all",
  }), /sudah dibatalkan/);
  assert.equal(users.length, 0);
});

test("profile voucher memasang script login, monitor expired, dan memigrasikan komentar lama", async () => {
  const profiles = [{ ".id": "*p1", name: "4Jam", "shared-users": "1", "on-login": "" }];
  const schedulers = [{ ".id": "*s1", name: "4Jam", disabled: "false", comment: "Monitor Profile 4Jam" }];
  const users = [{ ".id": "*u1", name: "voucher-lama", profile: "4Jam", comment: "voucher-mh123-abc123 Batch lama" }];
  const menuFor = (rows) => ({
    print: async () => rows.map((row) => ({ ...row })),
    add: async (payload) => { rows.push({ ".id": `*${rows.length + 1}`, ...payload }); },
    update: async (payload, id) => {
      const row = rows.find((item) => String(item[".id"]) === String(id));
      Object.assign(row, payload);
    },
  });
  const menus = {
    "/ip/hotspot/user/profile": menuFor(profiles),
    "/system/scheduler": menuFor(schedulers),
    "/ip/hotspot/user": menuFor(users),
    "/ip/pool": menuFor([{ name: "pool-voucher" }]),
    "/queue/simple": menuFor([]),
  };
  const service = new MikrotikService({ push() {} });
  service.withConnection = async (operation) => operation({ menu: (path) => menus[path] }, {});

  const saved = await service.saveVoucherProfile({
    originalName: "4Jam",
    name: "4Jam",
    sharedUsers: 1,
    rateLimit: "1M/3M",
    addressPool: "pool-voucher",
    parentQueue: "none",
    expiredMode: "rem",
    validity: "4h",
    costPrice: 2000,
    sellingPrice: 3000,
    commission: 500,
    lockUser: true,
  });

  assert.equal(saved.voucherReady, true);
  assert.equal(saved.migratedVoucherComments, 1);
  assert.match(profiles[0]["on-login"], /^:put \(",rem,2000,4h,3000,,Enable,1000,"\)/);
  assert.match(schedulers[0]["on-event"], /profile="4Jam"/);
  assert.equal(schedulers[0].disabled, "no");
  assert.equal(users[0].comment, "vc|mh123-abc123|Batch lama");

  const listed = await service.getVoucherProfiles();
  const profile = listed.profiles.find((item) => item.name === "4Jam");
  assert.equal(profile.voucherReady, true);
  assert.equal(profile.validity, "4h");
  assert.equal(profile.sellingPrice, 3000);
});

test("statistik voucher menghitung total, terpakai, dan belum terpakai per profile", async () => {
  const profiles = [
    { name: "VCR-1D", "on-login": ':put (",remc,0,1d,40000,,Disable,0,")' },
    { name: "VCR-4H", "on-login": ':put (",ntf,0,4h,10000,,Disable,0,")' },
    { name: "Bulanan", "on-login": "" },
  ];
  const users = [
    { name: "stock-1", profile: "VCR-1D", comment: "vc|batch-1|November", disabled: "false" },
    { name: "used-1", profile: "VCR-1D", comment: "nov/04/2026 08:00:00", disabled: "false" },
    { name: "expired-1", profile: "VCR-1D", comment: "nov/01/2026 08:00:00", disabled: "true" },
    { name: "customer-monthly", profile: "Bulanan", comment: "" },
  ];
  const scripts = [
    {
      name: "nov/03/2026-|-08:00:00-|-used-deleted-|-40000-|-10.0.0.2-|-AA-|-1d-|-VCR-1D-|-vc|batch-1-|-hotspot-|-0",
      comment: "mikhmon",
    },
    { name: "script-lain", comment: "operasional" },
  ];
  const service = new MikrotikService({ push() {} });
  service.withConnection = async (operation) => operation({
    menu(path) {
      if (path === "/ip/hotspot/user/profile") return { print: async () => profiles };
      if (path === "/ip/hotspot/user") return { print: async () => users };
      if (path === "/system/script") return { print: async () => scripts };
      throw new Error(`Menu tidak dikenal: ${path}`);
    },
  }, {});

  const stats = await service.getVoucherProfileStats();

  assert.deepEqual(stats.summary, { total: 4, used: 3, unused: 1 });
  assert.equal(stats.profiles.length, 2);
  assert.deepEqual(stats.profiles[0], {
    profile: "VCR-1D",
    expiredMode: "remc",
    validity: "1d",
    total: 4,
    used: 3,
    unused: 1,
  });
  assert.equal(stats.profiles[1].profile, "VCR-4H");
  assert.equal(stats.profiles[1].total, 0);
});

test("laporan voucher menghitung pendapatan dari catatan pemakaian dalam rentang tanggal", async () => {
  const profiles = [
    { name: "VCR-1D", "on-login": ':put (",remc,25000,1d,40000,,Disable,15000,")' },
    { name: "VCR-4H", "on-login": ':put (",ntfc,5000,4h,10000,,Disable,5000,")' },
    { name: "TANPA-RIWAYAT", "on-login": ':put (",rem,0,1d,50000,,Disable,0,")' },
  ];
  const scripts = [
    {
      ".id": "*1",
      name: "nov/03/2026-|-08:00:00-|-voucher-1-|-40000-|-10.0.0.2-|-AA:BB-|-1d-|-VCR-1D-|-vc|batch-1-|-hotspot-|-25000-|-15000",
      comment: "mikhmon",
    },
    {
      ".id": "*2",
      name: "nov/02/2026-|-09:15:00-|-voucher-2-|-0-|-10.0.0.3-|-CC:DD-|-4h-|-VCR-4H-|-vc|batch-2-|-hotspot-|-5000-|-5000",
      comment: "mikhmon",
    },
    {
      ".id": "*3",
      name: "oct/31/2026-|-20:00:00-|-voucher-lama-|-40000-|-10.0.0.4-|-EE:FF-|-1d-|-VCR-1D-|-vc|batch-1-|-hotspot-|-0",
      comment: "mikhmon",
    },
    {
      ".id": "*4",
      name: "nov/03/2026-|-10:00:00-|-voucher-tanpa-riwayat-|-50000-|-10.0.0.5-|-11:22-|-1d-|-TANPA-RIWAYAT-|-vc|batch-3-|-hotspot-|-0",
      comment: "mikhmon",
    },
  ];
  const service = new MikrotikService({ push() {} });
  service.withConnection = async (operation) => operation({
    menu(path) {
      if (path === "/ip/hotspot/user/profile") return { print: async () => profiles };
      if (path === "/system/script") return { print: async () => scripts };
      throw new Error(`Menu tidak dikenal: ${path}`);
    },
  }, {});

  const report = await service.getVoucherRevenueReport({
    dateFrom: "2026-11-02",
    dateTo: "2026-11-03",
  });

  assert.deepEqual(report.summary, {
    revenue: 50000,
    costPrice: 30000,
    commission: 20000,
    quantity: 2,
    profiles: 2,
  });
  assert.deepEqual(report.profileSummary, [
    { profile: "VCR-1D", quantity: 1, revenue: 40000, costPrice: 25000, commission: 15000 },
    { profile: "VCR-4H", quantity: 1, revenue: 10000, costPrice: 5000, commission: 5000 },
  ]);
  assert.equal(report.entries[0].username, "voucher-1");
  assert.equal(report.entries[0].usedAt, "2026-11-03T01:00:00.000Z");
  assert.equal(report.entries[1].amount, 10000);
  assert.equal(report.entries[1].costPrice, 5000);
  assert.equal(report.entries[1].commission, 5000);
  assert.equal(report.dateFrom, "2026-11-02");
  assert.equal(report.dateTo, "2026-11-03");
  await assert.rejects(
    () => service.getVoucherRevenueReport({ dateFrom: "2026-11-03", dateTo: "2026-11-02" }),
    /Tanggal mulai laporan voucher tidak boleh melewati tanggal akhir/,
  );
});

test("pembersihan hanya menghapus script voucher yang identitasnya sudah diverifikasi", async () => {
  const profiles = [
    { name: "VCR-1D", "on-login": ':put (",remc,25000,1d,40000,,Disable,15000,")' },
  ];
  const scripts = [
    {
      ".id": "*1",
      name: "nov/03/2026-|-08:00:00-|-voucher-1-|-40000-|-10.0.0.2-|-AA:BB-|-1d-|-VCR-1D-|-vc|batch-1|Reward-|-hotspot-|-25000-|-15000",
      owner: "nov2026",
      source: "nov/03/2026",
      comment: "mikhmon",
    },
    { ".id": "*2", name: "script-operasional", comment: "operasional" },
  ];
  const removedIds = [];
  const service = new MikrotikService({ push() {} });
  service.withConnection = async (operation) => operation({
    menu(path) {
      if (path === "/ip/hotspot/user/profile") return { print: async () => profiles };
      if (path === "/system/script") {
        return {
          print: async () => scripts.filter((script) => !removedIds.includes(script[".id"])),
          remove: async (id) => { removedIds.push(id); },
        };
      }
      throw new Error(`Menu tidak dikenal: ${path}`);
    },
  }, {});

  const records = await service.getVoucherUsageRecords({ timeZone: "Asia/Jakarta" });
  const cleanup = await service.deleteVoucherUsageRecords(records);

  assert.equal(records.length, 1);
  assert.equal(records[0].batchId, "batch-1");
  assert.deepEqual(removedIds, ["*1"]);
  assert.deepEqual(cleanup, { removed: 1, skipped: 0, failed: 0 });
});

test("voucher ditolak ketika profile belum memiliki aturan kedaluwarsa", async () => {
  const { service, getAddCalls } = createServiceWithUsers();
  service.withConnection = async (operation) => operation({
    menu(path) {
      if (path === "/ip/hotspot/user") return { print: async () => [], add: async () => {} };
      if (path === "/ip/hotspot/user/profile") return { print: async () => [{ name: "Bulanan", "on-login": "" }] };
      if (path === "/ip/hotspot") return { print: async () => [{ name: "hotspot-utama" }] };
      if (path === "/system/scheduler") return { print: async () => [] };
      throw new Error(`Menu tidak dikenal: ${path}`);
    },
  }, {});

  await assert.rejects(() => service.createHotspotVouchers({
    generationType: "SINGLE",
    username: "belum-siap",
    password: "password",
    profile: "Bulanan",
    server: "all",
  }), /belum siap untuk voucher/);
  assert.equal(getAddCalls(), 0);
});

test("membuat akun hotspot lalu membacanya kembali dari MikroTik", async () => {
  const { service, getAddCalls } = createServiceWithUsers();

  const result = await service.createHotspotCustomer({
    name: "Pelanggan Baru",
    phoneNumber: "6281234567890",
    profile: "100M",
  });
  const verified = await service.verifyHotspotCustomer(result);

  assert.equal(result.username, "pelanggan_baru");
  assert.equal(result.password, "67890");
  assert.equal(result.created, true);
  assert.equal(verified.username, "pelanggan_baru");
  assert.equal(verified.profile, "100M");
  assert.equal(getAddCalls(), 1);
});

test("sinkronisasi hotspot hanya meminta field RouterOS yang dipakai", async () => {
  const selectedFields = new Map();
  const menus = {
    "/ip/hotspot/user": [{ id: "*1", name: "pelanggan", profile: "100M", disabled: false }],
    "/ip/hotspot/active": [{ id: "*2", user: "pelanggan", address: "192.0.2.10" }],
  };
  const connection = {
    menu(path) {
      return {
        select(fields) {
          selectedFields.set(path, [...fields]);
          return this;
        },
        async print() {
          return menus[path];
        },
      };
    },
  };
  const service = new MikrotikService({ push() {} });
  service.withReadConnection = async (operation) => operation(connection, {});

  const users = await service.getHotspotUsers();

  assert.deepEqual(selectedFields.get("/ip/hotspot/user"), [
    "id", "name", "profile", "comment", "disabled", "email",
  ]);
  assert.deepEqual(selectedFields.get("/ip/hotspot/active"), [
    "id", "user", "address", "mac-address", "uptime", "server",
  ]);
  assert.equal(users.length, 1);
  assert.equal(users[0].active, true);
});

test("sinkronisasi status tidak membaca sesi aktif atau field akun yang tidak diperlukan", async () => {
  const menuCalls = [];
  let selectedFields = [];
  const filters = [];
  const connection = {
    menu(path) {
      menuCalls.push(path);
      return {
        select(fields) {
          selectedFields = [...fields];
          return this;
        },
        where(key, value) {
          filters.push({ operator: "where", key, value });
          return this;
        },
        orWhere(key, value) {
          filters.push({ operator: "orWhere", key, value });
          return this;
        },
        async print() {
          return [{ name: "pelanggan", profile: "100M", disabled: "false", email: "6281@localhost.local" }];
        },
      };
    },
  };
  const service = new MikrotikService({ push() {} });
  service.withConnection = async (operation) => operation(connection, {});

  const users = await service.getHotspotUsersForStatusSync(["pelanggan", "pelanggan_dua"]);

  assert.deepEqual(menuCalls, ["/ip/hotspot/user"]);
  assert.deepEqual(selectedFields, ["name", "profile", "disabled", "email"]);
  assert.deepEqual(filters, [
    { operator: "where", key: "name", value: "pelanggan" },
    { operator: "orWhere", key: "name", value: "pelanggan_dua" },
  ]);
  assert.deepEqual(users, [{
    username: "pelanggan",
    profile: "100M",
    disabled: false,
    email: "6281@localhost.local",
    source: "user",
  }]);
});

test("akun MikroTik yang cocok diperlakukan sebagai retry idempotent", async () => {
  const { service, users, getAddCalls, getUpdateCalls } = createServiceWithUsers([{
    ".id": "*1",
    name: "pelanggan_baru",
    profile: "profile-lama",
    password: "password-lama",
    email: "6281234567890@localhost.local",
    disabled: "true",
  }]);

  const result = await service.createHotspotCustomer({
    name: "Pelanggan Baru",
    phoneNumber: "6281234567890",
    profile: "100M",
  });

  assert.equal(result.created, false);
  assert.equal(result.id, "*1");
  assert.equal(getAddCalls(), 0);
  assert.equal(getUpdateCalls(), 1);
  assert.equal(users[0].profile, "100M");
  assert.equal(users[0].password, "67890");
  assert.equal(users[0].disabled, "no");
});

test("retry dapat mengadopsi akun MikroTik existing yang belum memiliki email pemilik", async () => {
  const { service, users, getAddCalls, getUpdateCalls } = createServiceWithUsers([{
    ".id": "*1",
    name: "cantik",
    profile: "100M",
    password: "password-lama",
    email: "",
    disabled: "true",
  }]);

  const result = await service.createHotspotCustomer({
    name: "Cantik",
    phoneNumber: "6288972126048",
    username: "cantik",
    password: "cantik67890",
    profile: "100M",
    adoptExisting: true,
  });

  assert.equal(result.created, false);
  assert.equal(result.updated, true);
  assert.equal(result.adopted, true);
  assert.equal(getAddCalls(), 0);
  assert.equal(getUpdateCalls(), 1);
  assert.equal(users[0].email, "6288972126048@localhost.local");
  assert.equal(users[0].disabled, "no");
});

test("retry akun tanpa email dapat sekaligus mengganti profile MikroTik", async () => {
  const { service, users, getUpdateCalls } = createServiceWithUsers([{
    ".id": "*1",
    name: "nini",
    profile: "30Hari",
    password: "password-lama",
    email: "",
  }]);

  const result = await service.createHotspotCustomer({
    name: "Nini",
    phoneNumber: "6285703100985",
    username: "nini",
    password: "00985",
    profile: "100M",
    adoptExisting: true,
  });

  assert.equal(result.adopted, true);
  assert.equal(getUpdateCalls(), 1);
  assert.equal(users[0].profile, "100M");
  assert.equal(users[0].email, "6285703100985@localhost.local");
});

test("retry akun yang pernah dikelola dapat memperbarui email pemilik yang sudah berubah", async () => {
  const { service, users, getAddCalls, getUpdateCalls } = createServiceWithUsers([{
    ".id": "*1",
    name: "mainang",
    profile: "profile-lama",
    password: "password-lama",
    email: "6281372968275@localhost.local",
  }]);

  const result = await service.createHotspotCustomer({
    name: "Ma Inang",
    phoneNumber: "62895619074907",
    username: "mainang",
    password: "68275",
    profile: "100M",
    adoptExisting: true,
    adoptExistingOwnerMismatch: true,
  });

  assert.equal(result.created, false);
  assert.equal(result.updated, true);
  assert.equal(result.adopted, true);
  assert.equal(getAddCalls(), 0);
  assert.equal(getUpdateCalls(), 1);
  assert.equal(users[0].email, "62895619074907@localhost.local");
  assert.equal(users[0].profile, "100M");
});

test("retry tetap menolak akun milik pelanggan lain tanpa riwayat pengelolaan", async () => {
  const { service, getUpdateCalls } = createServiceWithUsers([{
    ".id": "*1",
    name: "pelanggan_baru",
    profile: "profile-lama",
    password: "password-lama",
    email: "6289999999999@localhost.local",
  }]);

  await assert.rejects(
    () => service.createHotspotCustomer({
      name: "Pelanggan Baru",
      phoneNumber: "6281234567890",
      profile: "100M",
      adoptExisting: true,
    }),
    /dipakai akun MikroTik lain/
  );
  assert.equal(getUpdateCalls(), 0);
});

test("menolak username MikroTik yang dimiliki pelanggan lain", async () => {
  const { service, getAddCalls } = createServiceWithUsers([{
    ".id": "*1",
    name: "pelanggan_baru",
    profile: "100M",
    email: "6289999999999@localhost.local",
  }]);

  await assert.rejects(
    () => service.createHotspotCustomer({
      name: "Pelanggan Baru",
      phoneNumber: "6281234567890",
      profile: "100M",
    }),
    /dipakai akun MikroTik lain/
  );
  assert.equal(getAddCalls(), 0);
});

test("memperbarui akun hotspot lama dan memverifikasi username baru", async () => {
  const { service, users, getUpdateCalls, getKilledSessions } = createServiceWithUsers([{
    ".id": "*1",
    name: "pelanggan_lama",
    profile: "50M",
    password: "67805",
    email: "6281234567805@localhost.local",
    active: true,
  }]);

  const result = await service.updateHotspotCustomer({
    previousUsername: "pelanggan_lama",
    previousPhoneNumber: "6281234567805",
    name: "Pelanggan Baru",
    username: "pelanggan_baru",
    phoneNumber: "6281234567806",
    password: "67806",
    profile: "100M",
  });
  const verified = await service.verifyHotspotCustomer(result);

  assert.equal(result.updated, true);
  assert.equal(result.username, "pelanggan_baru");
  assert.equal(verified.email, "6281234567806@localhost.local");
  assert.equal(users[0].name, "pelanggan_baru");
  assert.equal(getUpdateCalls(), 1);
  assert.equal(getKilledSessions(), 1);
});

test("edit semua data tetap memperbarui akun walau email MikroTik lama sudah berbeda", async () => {
  const { service, users, getUpdateCalls } = createServiceWithUsers([{
    ".id": "*1",
    name: "pelanggan_lama",
    profile: "50M",
    password: "67805",
    // Simulates a manual number change or a partially completed retry.
    email: "6281399999999@localhost.local",
  }]);

  const result = await service.updateHotspotCustomer({
    previousUsername: "pelanggan_lama",
    name: "Pelanggan Baru",
    username: "pelanggan_baru",
    phoneNumber: "6281234567806",
    password: "password-baru",
    profile: "100M",
  });

  assert.equal(result.updated, true);
  assert.equal(users[0].name, "pelanggan_baru");
  assert.equal(users[0].password, "password-baru");
  assert.equal(users[0].profile, "100M");
  assert.equal(users[0].email, "6281234567806@localhost.local");
  assert.equal(getUpdateCalls(), 1);
});

test("retry edit idempotent menerima akun baru ketika akun lama sudah berganti nama", async () => {
  const { service, getUpdateCalls } = createServiceWithUsers([{
    ".id": "*1",
    name: "pelanggan_baru",
    profile: "100M",
    password: "67806",
    email: "6281234567806@localhost.local",
  }]);

  const result = await service.updateHotspotCustomer({
    previousUsername: "pelanggan_lama",
    previousPhoneNumber: "6281234567805",
    name: "Pelanggan Baru",
    username: "pelanggan_baru",
    phoneNumber: "6281234567806",
    password: "67806",
    profile: "100M",
  });

  assert.equal(result.updated, false);
  assert.equal(result.username, "pelanggan_baru");
  assert.equal(getUpdateCalls(), 0);
});

test("retry edit menyelesaikan akun baru yang baru tersinkron sebagian", async () => {
  const { service, users, getUpdateCalls } = createServiceWithUsers([{
    ".id": "*1",
    name: "pelanggan_baru",
    profile: "profile-lama",
    password: "password-lama",
    email: "6281234567806@localhost.local",
    disabled: "true",
  }]);

  const result = await service.updateHotspotCustomer({
    previousUsername: "pelanggan_lama",
    name: "Pelanggan Baru",
    username: "pelanggan_baru",
    phoneNumber: "6281234567806",
    password: "67806",
    profile: "100M",
  });

  assert.equal(result.updated, true);
  assert.equal(result.recovered, true);
  assert.equal(getUpdateCalls(), 1);
  assert.equal(users[0].profile, "100M");
  assert.equal(users[0].password, "67806");
  assert.equal(users[0].disabled, "no");
});

test("edit hotspot menolak username baru yang sudah digunakan akun lain", async () => {
  const { service, getUpdateCalls } = createServiceWithUsers([{
    ".id": "*1",
    name: "pelanggan_lama",
    profile: "50M",
    email: "6281234567805@localhost.local",
  }, {
    ".id": "*2",
    name: "pelanggan_baru",
    profile: "100M",
    email: "6289999999999@localhost.local",
  }]);

  await assert.rejects(
    () => service.updateHotspotCustomer({
      previousUsername: "pelanggan_lama",
      previousPhoneNumber: "6281234567805",
      name: "Pelanggan Baru",
      username: "pelanggan_baru",
      phoneNumber: "6281234567806",
      password: "67806",
      profile: "100M",
    }),
    /Username baru.*sudah dipakai/
  );
  assert.equal(getUpdateCalls(), 0);
});

test("reaktivasi memperbarui akun yang sama tanpa menghapus user terlebih dahulu", async () => {
  const {
    service,
    users,
    getUpdateCalls,
    getRemoveCalls,
    getKilledSessions,
  } = createServiceWithUsers([{
    ".id": "*1",
    name: "pelanggan_reaktivasi",
    profile: "50M",
    password: "lama",
    email: "6281234567895@localhost.local",
    disabled: "true",
    active: true,
  }]);

  const result = await service.reactivateHotspotUser({
    username: "pelanggan_reaktivasi",
    phoneNumber: "6281234567895",
    password: "67895",
    profile: "100M",
  });

  assert.equal(result.updated, true);
  assert.equal(result.created, false);
  assert.equal(users.length, 1);
  assert.equal(users[0].password, "67895");
  assert.equal(users[0].disabled, "no");
  assert.equal(getUpdateCalls(), 1);
  assert.equal(getRemoveCalls(), 0);
  assert.equal(getKilledSessions(), 1);
});

test("reaktivasi membuat akun jika user memang sudah tidak ada", async () => {
  const { service, users, getAddCalls } = createServiceWithUsers();

  const result = await service.reactivateHotspotUser({
    username: "pelanggan_hilang",
    phoneNumber: "6281234567896",
    password: "67896",
    profile: "100M",
  });

  assert.equal(result.created, true);
  assert.equal(result.updated, false);
  assert.equal(users[0].name, "pelanggan_hilang");
  assert.equal(getAddCalls(), 1);
});

test("deaktivasi memastikan user sudah tidak tersisa di MikroTik", async () => {
  const { service, users, getRemoveCalls } = createServiceWithUsers([{
    ".id": "*1",
    name: "pelanggan_nonaktif",
    profile: "100M",
    email: "6281234567897@localhost.local",
  }]);

  const result = await service.deleteHotspotUser("pelanggan_nonaktif", "6281234567897");

  assert.equal(result.removedUsers, 1);
  assert.equal(users.length, 0);
  assert.equal(getRemoveCalls(), 1);
});

test("deaktivasi menolak menghapus akun yang dimiliki pelanggan lain", async () => {
  const { service, users, getRemoveCalls, getKilledSessions } = createServiceWithUsers([{
    ".id": "*1",
    name: "pelanggan_nonaktif",
    profile: "100M",
    email: "6289999999999@localhost.local",
    active: true,
  }]);

  await assert.rejects(
    () => service.deleteHotspotUser("pelanggan_nonaktif", "6281234567897"),
    /terhubung ke pelanggan yang berbeda/
  );
  assert.equal(users.length, 1);
  assert.equal(getRemoveCalls(), 0);
  assert.equal(getKilledSessions(), 0);
});

test("menonaktifkan dan mengaktifkan akun hotspot tanpa menghapus user", async () => {
  const { service, users, getUpdateCalls, getRemoveCalls, getKilledSessions } = createServiceWithUsers([{
    ".id": "*1",
    name: "pelanggan_toggle",
    profile: "100M",
    password: "67898",
    email: "6281234567898@localhost.local",
    active: true,
    disabled: "false",
  }]);

  const disabled = await service.setHotspotUserDisabled("pelanggan_toggle", "6281234567898", true);
  assert.equal(disabled.disabled, true);
  assert.equal(users.length, 1);
  assert.equal(users[0].disabled, "yes");
  assert.equal(disabled.activeSessionsKilled, 1);

  const enabled = await service.setHotspotUserDisabled("pelanggan_toggle", "6281234567898", false);
  assert.equal(enabled.disabled, false);
  assert.equal(users[0].disabled, "no");
  assert.equal(getUpdateCalls(), 2);
  assert.equal(getRemoveCalls(), 0);
  assert.equal(getKilledSessions(), 1);
});

test("IP Binding pelanggan memakai MAC saja dan mempertahankan penanda pemilik", async () => {
  const { service, bindings } = createServiceWithUsers();

  const created = await service.upsertIpBinding({
    macAddress: "aa-bb-cc-dd-ee-02",
    contactId: "contact-binding-1",
    type: "bypassed",
  });

  assert.equal(created.macAddress, "AA:BB:CC:DD:EE:02");
  assert.equal(bindings[0]["mac-address"], "AA:BB:CC:DD:EE:02");
  assert.equal(bindings[0].address, undefined);
  assert.equal(bindings[0].type, "bypassed");
  assert.equal(bindings[0].comment, "reminder-bot:contact-binding-1");

  await service.upsertIpBinding({
    macAddress: "AA:BB:CC:DD:EE:02",
    contactId: "contact-binding-1",
    type: "regular",
  });
  assert.equal(bindings[0].type, "regular");

  await service.setIpBindingDisabled({
    macAddress: "AA:BB:CC:DD:EE:02",
    contactId: "contact-binding-1",
    disabled: true,
  });
  assert.equal(bindings[0].type, "blocked");

  const deleted = await service.deleteIpBinding({
    macAddress: "AA:BB:CC:DD:EE:02",
    contactId: "contact-binding-1",
  });
  assert.equal(deleted.removedBindings, 1);
  assert.equal(bindings.length, 0);
});

test("IP Binding menolak MAC yang sudah dimiliki pelanggan lain", async () => {
  const { service } = createServiceWithUsers([], [], [{
    ".id": "*B1",
    "mac-address": "AA:BB:CC:DD:EE:04",
    type: "bypassed",
    comment: "reminder-bot:contact-lain",
  }]);

  await assert.rejects(
    () => service.upsertIpBinding({
      macAddress: "AA:BB:CC:DD:EE:04",
      contactId: "contact-binding-2",
    }),
    /sudah terhubung ke pelanggan lain/,
  );
});

function createBandwidthService({ profiles = [], leases = [], hosts = [], queues = [] } = {}) {
  const rows = queues.map((queue) => ({ ...queue }));
  const queueMenu = {
    print: async () => rows.map((queue) => ({ ...queue })),
    add: async (payload) => {
      rows.push({ ".id": `*Q${rows.length + 1}`, ...payload });
      return {};
    },
    update: async (payload, id) => {
      const queue = rows.find((item) => String(item[".id"] || item.id) === String(id));
      if (!queue) throw new Error("queue tidak ditemukan");
      Object.assign(queue, payload);
      return [];
    },
    remove: async (id) => {
      const index = rows.findIndex((item) => String(item[".id"] || item.id) === String(id));
      if (index >= 0) rows.splice(index, 1);
      return [];
    },
  };
  const service = new MikrotikService({ push() {} });
  service.withConnection = async (operation) => operation({
    menu(path) {
      if (path === "/queue/simple") return queueMenu;
      if (path === "/ip/hotspot/user/profile") return { print: async () => profiles.map((row) => ({ ...row })) };
      if (path === "/ip/dhcp-server/lease") return { print: async () => leases.map((row) => ({ ...row })) };
      if (path === "/ip/hotspot/host") return { print: async () => hosts.map((row) => ({ ...row })) };
      throw new Error(`Menu tidak dikenal: ${path}`);
    },
  }, {});
  return { service, queues: rows };
}

test("bandwidth beberapa IP Binding membuat satu Simple Queue untuk setiap IP", async () => {
  const { service, queues } = createBandwidthService({
    profiles: [{ name: "Keluarga", "rate-limit": "10M/30M 20M/40M 8M/24M 20/20 6 1M/2M" }],
    leases: [
      { "mac-address": "AA:BB:CC:DD:EE:10", address: "10.20.0.10", status: "bound" },
      { "mac-address": "AA:BB:CC:DD:EE:11", "active-address": "10.20.0.11", status: "bound" },
    ],
  });

  const result = await service.syncIpBindingBandwidthForCustomer({
    contactId: "pelanggan-keluarga",
    profile: "Keluarga",
    macAddresses: ["AA:BB:CC:DD:EE:10", "AA:BB:CC:DD:EE:11"],
  });

  assert.equal(result.status, "ACTIVE");
  assert.equal(result.rateLimit, "10M/30M 20M/40M 8M/24M 20/20 6 1M/2M");
  assert.deepEqual(result.targetAddresses, ["10.20.0.10", "10.20.0.11"]);
  assert.equal(queues.length, 2);
  assert.deepEqual(queues.map((queue) => queue.target).sort(), ["10.20.0.10/32", "10.20.0.11/32"]);
  assert.equal(new Set(queues.map((queue) => queue.name)).size, 2);
  assert.deepEqual(result.queueNames.sort(), queues.map((queue) => queue.name).sort());
  for (const queue of queues) {
    assert.equal(queue["max-limit"], "10M/30M");
    assert.equal(queue["burst-limit"], "20M/40M");
    assert.equal(queue["burst-threshold"], "8M/24M");
    assert.equal(queue["burst-time"], "20s/20s");
    assert.equal(queue.priority, "6/6");
    assert.equal(queue["limit-at"], "1M/2M");
    assert.equal(queue.comment, "reminder-bot-bandwidth:pelanggan-keluarga");
    queue["max-limit"] = "10000000/30000000";
    queue["burst-limit"] = "20000000/40000000";
    queue["burst-threshold"] = "8000000/24000000";
    queue["limit-at"] = "1000000/2000000";
  }
  const repeated = await service.syncIpBindingBandwidthForCustomer({
    contactId: "pelanggan-keluarga",
    profile: "Keluarga",
    macAddresses: ["AA:BB:CC:DD:EE:10", "AA:BB:CC:DD:EE:11"],
  });
  assert.equal(repeated.changed, false);
  assert.equal(queues.length, 2);
});

test("queue gabungan lama dimigrasikan menjadi Simple Queue per IP", async () => {
  const ownerComment = "reminder-bot-bandwidth:pelanggan-migrasi";
  const { service, queues } = createBandwidthService({
    profiles: [{ name: "Migrasi", "rate-limit": "8M/8M" }],
    leases: [
      { "mac-address": "AA:BB:CC:DD:EE:40", address: "10.50.0.10" },
      { "mac-address": "AA:BB:CC:DD:EE:41", address: "10.50.0.11" },
    ],
    queues: [{
      ".id": "*Q1",
      name: "queue-gabungan-lama",
      target: "10.50.0.10/32,10.50.0.11/32",
      "max-limit": "8M/8M",
      comment: ownerComment,
    }],
  });

  const result = await service.syncIpBindingBandwidthForCustomer({
    contactId: "pelanggan-migrasi",
    profile: "Migrasi",
    macAddresses: ["AA:BB:CC:DD:EE:40", "AA:BB:CC:DD:EE:41"],
  });

  assert.equal(result.changed, true);
  assert.equal(queues.length, 2);
  assert.deepEqual(queues.map((queue) => queue.target).sort(), ["10.50.0.10/32", "10.50.0.11/32"]);
  assert.equal(queues.some((queue) => queue.name === "queue-gabungan-lama"), false);
  assert.equal(queues.every((queue) => queue.comment === ownerComment), true);
});

test("bandwidth IP Binding menunggu IP dan melengkapi target dari Hotspot host", async () => {
  const { service, queues } = createBandwidthService({
    profiles: [{ name: "Rumah", "rate-limit": "5M/15M" }],
    hosts: [{ "mac-address": "AA:BB:CC:DD:EE:20", address: "10.30.0.20" }],
  });

  const partial = await service.syncIpBindingBandwidthForCustomer({
    contactId: "pelanggan-rumah",
    profile: "Rumah",
    macAddresses: ["AA:BB:CC:DD:EE:20", "AA:BB:CC:DD:EE:21"],
  });

  assert.equal(partial.status, "PARTIAL");
  assert.deepEqual(partial.pendingMacAddresses, ["AA:BB:CC:DD:EE:21"]);
  assert.equal(queues[0].target, "10.30.0.20/32");

  const pendingOnly = createBandwidthService({
    profiles: [{ name: "Rumah", "rate-limit": "5M/15M" }],
  });
  const pending = await pendingOnly.service.syncIpBindingBandwidthForCustomer({
    contactId: "pelanggan-baru",
    profile: "Rumah",
    macAddresses: ["AA:BB:CC:DD:EE:22"],
  });
  assert.equal(pending.status, "PENDING_DHCP");
  assert.equal(pendingOnly.queues.length, 0);
});

test("profile tanpa rate limit tidak meninggalkan Simple Queue IP Binding", async () => {
  const { service, queues } = createBandwidthService({
    profiles: [{ name: "Tanpa Limit", "rate-limit": "" }],
    queues: [{
      ".id": "*Q1",
      name: "lama",
      target: "10.40.0.10/32",
      "max-limit": "1M/1M",
      comment: "reminder-bot-bandwidth:pelanggan-tanpa-limit",
    }],
  });

  const result = await service.syncIpBindingBandwidthForCustomer({
    contactId: "pelanggan-tanpa-limit",
    profile: "Tanpa Limit",
    macAddresses: ["AA:BB:CC:DD:EE:30"],
  });

  assert.equal(result.status, "NO_RATE_LIMIT");
  assert.equal(result.removedQueues, 1);
  assert.equal(queues.length, 0);
});
