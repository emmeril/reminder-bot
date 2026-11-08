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
