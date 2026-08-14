const assert = require("node:assert/strict");
const test = require("node:test");

const { MikrotikService } = require("../src/app");

function createServiceWithUsers(initialUsers = []) {
  const users = initialUsers.map((user) => ({ ...user }));
  let addCalls = 0;
  let updateCalls = 0;
  let killedSessions = 0;
  const userMenu = {
    print: async () => users.map((user) => ({ ...user })),
    add: async (payload) => {
      addCalls += 1;
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
  };
  const connection = {
    menu: (path) => {
      if (path === "/ip/hotspot/user") return userMenu;
      if (path === "/ip/hotspot/user/profile") {
        return { print: async () => [{ name: "100M" }] };
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
    getAddCalls: () => addCalls,
    getUpdateCalls: () => updateCalls,
    getKilledSessions: () => killedSessions,
  };
}

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

test("akun MikroTik yang cocok diperlakukan sebagai retry idempotent", async () => {
  const { service, getAddCalls } = createServiceWithUsers([{
    ".id": "*1",
    name: "pelanggan_baru",
    profile: "100M",
    email: "6281234567890@localhost.local",
  }]);

  const result = await service.createHotspotCustomer({
    name: "Pelanggan Baru",
    phoneNumber: "6281234567890",
    profile: "100M",
  });

  assert.equal(result.created, false);
  assert.equal(result.id, "*1");
  assert.equal(getAddCalls(), 0);
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
