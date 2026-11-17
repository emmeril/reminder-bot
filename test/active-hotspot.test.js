const assert = require("node:assert/strict");
const test = require("node:test");
const MikrotikService = require("../src/modules/mikrotik/service");

function createService(sessions, users = []) {
  const reads = [];
  const service = new MikrotikService({ push() {} });
  service.withConnection = async (operation) => operation({
    menu(path) {
      const read = { path, fields: [], names: [] };
      reads.push(read);
      return {
        select(fields) { read.fields = fields; return this; },
        where(key, value) { assert.equal(key, "name"); read.names.push(value); return this; },
        orWhere(key, value) { return this.where(key, value); },
        async print() {
          if (path === "/ip/hotspot/active") return sessions;
          assert.equal(path, "/ip/hotspot/user");
          assert.ok(read.names.length, "Account reads must be filtered to active usernames");
          return users.filter((user) => read.names.includes(user.name));
        },
      };
    },
  }, { label: "backup" });
  return { service, reads };
}

test("sesi Hotspot aktif mempertahankan beberapa perangkat per username tanpa mengekspos kredensial", async () => {
  const { service, reads } = createService([
    { ".id": "*2", user: "shared", address: "192.0.2.2", "mac-address": "AA:BB:CC:DD:EE:02", uptime: "1h", server: "hs1", password: "private" },
    { ".id": "*1", user: "shared", address: "192.0.2.1", macAddress: "AA:BB:CC:DD:EE:01", uptime: "2h", server: "hs1" },
    { ".id": "*3", user: "radius-only", address: "192.0.2.3" },
  ], [{ name: "shared", profile: "Harian", password: "private" }, { name: "offline", profile: "Bulanan" }]);
  const snapshot = await service.getActiveHotspotUsers();
  assert.equal(snapshot.users.length, 3);
  assert.equal(snapshot.router, "backup");
  assert.ok(Number.isFinite(new Date(snapshot.checkedAt).getTime()));
  assert.equal(snapshot.users.filter((user) => user.username === "shared").length, 2);
  assert.equal(snapshot.users.find((user) => user.id === "*1").macAddress, "AA:BB:CC:DD:EE:01");
  assert.equal(snapshot.users.find((user) => user.username === "radius-only").profile, "");
  assert.deepEqual(reads[0].fields, [".id", "user", "address", "mac-address", "uptime", "server"]);
  assert.deepEqual(reads[1].fields, ["name", "profile"]);
  assert.deepEqual(reads[1].names, ["shared", "radius-only"]);
  assert.ok(snapshot.users.every((user) => !("password" in user)));
  assert.equal(snapshot.users.some((user) => user.username === "offline"), false);
});

test("router tanpa sesi aktif tidak membaca seluruh akun Hotspot", async () => {
  const { service, reads } = createService([]);
  assert.deepEqual((await service.getActiveHotspotUsers()).users, []);
  assert.equal(reads.length, 1);
});

test("lookup profile dibatasi 100 username aktif per permintaan", async () => {
  const { service, reads } = createService(Array.from({ length: 201 }, (_, index) => ({
    user: `user${index}`, address: `192.0.2.${index + 1}`,
  })));
  const { users } = await service.getActiveHotspotUsers();
  assert.deepEqual(reads.slice(1).map((read) => read.names.length), [100, 100, 1]);
  assert.equal(new Set(users.map((user) => user.id)).size, 201);
});

test("permintaan bersamaan berbagi pembacaan router dan kegagalan dapat dicoba ulang", async () => {
  const service = new MikrotikService({ push() {} });
  let reads = 0;
  let finish;
  service.withConnection = () => { reads += 1; return new Promise((resolve) => { finish = resolve; }); };
  const first = service.getActiveHotspotUsers();
  const second = service.getActiveHotspotUsers();
  assert.equal(reads, 1);
  finish({ users: [] });
  assert.deepEqual(await first, await second);
  service.withConnection = async () => { throw new Error("offline"); };
  await assert.rejects(service.getActiveHotspotUsers(), /offline/);
  service.withConnection = async () => ({ users: [] });
  assert.deepEqual(await service.getActiveHotspotUsers(), { users: [] });
});
