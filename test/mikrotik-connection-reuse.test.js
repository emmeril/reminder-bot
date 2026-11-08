const assert = require("node:assert/strict");
const { test } = require("node:test");
const MikrotikService = require("../src/modules/mikrotik/service");
const { CONFIG } = require("../src/config");

function makeService() {
  const service = new MikrotikService({ push() {} });
  const connections = [];
  service.getConnectionConfigs = () => [{ label: "primary", config: { host: "192.0.2.1" } }];
  service.tryConnect = async ({ label, config }) => {
    const obj = {
      label,
      config,
      connection: { id: connections.length + 1 },
      client: {
        close() {
          obj.closed = true;
        },
      },
      closed: false,
    };
    connections.push(obj);
    return obj;
  };
  return { service, connections };
}

test("RouterOS menggunakan ulang koneksi untuk operasi berurutan", async () => {
  const { service, connections } = makeService();
  try {
    const first = await service.withConnection((conn) => conn.id);
    const second = await service.withConnection((conn) => conn.id);
    assert.equal(first, second);
    assert.equal(connections.length, 1);
    assert.equal(connections[0].closed, false);
  } finally {
    await service.close();
  }
  assert.equal(connections[0].closed, true);
});

test("operasi RouterOS berjalan satu per satu pada koneksi yang sama", async () => {
  const { service } = makeService();
  const sequence = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  try {
    const first = service.withConnection(async () => {
      sequence.push("first-start");
      await firstGate;
      sequence.push("first-end");
    });
    const second = service.withConnection(async () => {
      sequence.push("second-start");
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(sequence, ["first-start"]);
    releaseFirst();
    await Promise.all([first, second]);
    assert.deepEqual(sequence, ["first-start", "first-end", "second-start"]);
  } finally {
    releaseFirst();
    await service.close();
  }
});

test("gagal menjalankan operasi memutus koneksi tanpa mengulang operasi tulis", async () => {
  const { service, connections } = makeService();
  let attempts = 0;
  try {
    await assert.rejects(
      () => service.withConnection(() => {
        attempts++;
        throw new Error("write failed");
      }),
      /write failed/
    );
    assert.equal(attempts, 1);
    assert.equal(connections[0].closed, true);
    assert.equal(await service.withConnection((conn) => conn.id), 2);
  } finally {
    await service.close();
  }
});

test("RouterOS menolak antrean yang melebihi batas", async () => {
  const previous = CONFIG.MIKROTIK_MAX_PENDING_OPERATIONS;
  CONFIG.MIKROTIK_MAX_PENDING_OPERATIONS = 1;
  const { service } = makeService();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  try {
    const running = service.withConnection(() => gate);
    await assert.rejects(
      () => service.withConnection(async () => "never"),
      (error) => error.statusCode === 503
    );
    release();
    await running;
  } finally {
    release();
    await service.close();
    CONFIG.MIKROTIK_MAX_PENDING_OPERATIONS = previous;
  }
});

test("pengukuran RouterOS memisahkan antrean, koneksi, dan perintah", async () => {
  const { service } = makeService();
  const metrics = {};
  try {
    const result = await service.withConnection(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return "hotspot-1";
    }, metrics);
    assert.equal(result, "hotspot-1");
    for (const name of ["queueMs", "connectionMs", "commandMs", "totalMs"]) {
      assert.equal(Number.isFinite(metrics[name]), true, name);
      assert.equal(metrics[name] >= 0, true, name);
    }
    assert.ok(metrics.totalMs >= metrics.commandMs);
  } finally {
    await service.close();
  }
});

test("pengukuran menunjukkan antrean ketika koneksi sedang digunakan", async () => {
  const { service } = makeService();
  let release;
  const wait = new Promise((resolve) => { release = resolve; });
  try {
    const first = service.withConnection(() => wait);
    const metrics = {};
    const second = service.withConnection(() => "second", metrics);
    await new Promise((resolve) => setTimeout(resolve, 8));
    release();
    await Promise.all([first, second]);
    assert.ok(metrics.queueMs >= 1, `queueMs=${metrics.queueMs}`);
    assert.equal(Number.isFinite(metrics.commandMs), true);
  } finally {
    release();
    await service.close();
  }
});

test("dashboard read tidak menunggu operasi tulis yang sedang berjalan", async () => {
  const { service, connections } = makeService();
  let releaseWrite;
  let markWriteStarted;
  const writeStarted = new Promise((resolve) => { markWriteStarted = resolve; });
  const writeGate = new Promise((resolve) => { releaseWrite = resolve; });
  try {
    const write = service.withConnection(async () => {
      markWriteStarted();
      await writeGate;
      return "changed";
    }, null, "updateHotspotCustomer");
    await writeStarted;
    const metrics = {};
    const read = await service.withReadConnection(() => "dashboard", metrics, "getHotspotServers");
    assert.equal(read, "dashboard");
    assert.equal(metrics.lane, "read");
    assert.equal(metrics.waiting, 0);
    assert.equal(connections.length, 2);
    assert.equal(connections[0].closed, false);
    assert.equal(connections[1].closed, false);
    releaseWrite();
    assert.equal(await write, "changed");
  } finally {
    releaseWrite?.();
    await service.close();
  }
  assert.equal(connections.every((item) => item.closed), true);
});

test("dashboard reads tetap serial dan melaporkan operasi penghambat", async () => {
  const { service } = makeService();
  let release;
  let started;
  const firstStarted = new Promise((resolve) => { started = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  try {
    const first = service.withReadConnection(async () => {
      started();
      await gate;
      return "users";
    }, null, "getHotspotUsers");
    await firstStarted;
    const metrics = {};
    const second = service.withReadConnection(() => "hotspot-1", metrics, "getHotspotServers");
    await new Promise((resolve) => setTimeout(resolve, 8));
    release();
    const [users, servers] = await Promise.all([first, second]);
    assert.equal(users, "users");
    assert.equal(servers, "hotspot-1");
    assert.equal(metrics.blockedBy, "getHotspotUsers");
    assert.equal(metrics.waiting, 1);
    assert.ok(metrics.queueMs >= 1);
  } finally {
    release?.();
    await service.close();
  }
});

test("kegagalan pembacaan hanya menutup koneksi read dan tidak mengulang operasi", async () => {
  const { service, connections } = makeService();
  let calls = 0;
  try {
    const writer = await service.withConnection((conn) => conn.id);
    await assert.rejects(() => service.withReadConnection(() => {
      calls += 1;
      throw new Error("read failed");
    }), /read failed/);
    assert.equal(calls, 1);
    assert.equal(connections[0].closed, false);
    assert.equal(connections[1].closed, true);
    assert.equal(await service.withConnection((conn) => conn.id), writer);
    assert.equal(await service.withReadConnection((conn) => conn.id), 3);
  } finally {
    await service.close();
  }
});
