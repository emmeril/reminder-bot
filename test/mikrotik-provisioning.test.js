const assert = require("node:assert/strict");
const test = require("node:test");

const { MikrotikService } = require("../src/app");

function createServiceWithUsers(initialUsers = []) {
  const users = initialUsers.map((user) => ({ ...user }));
  let addCalls = 0;
  const userMenu = {
    print: async () => users.map((user) => ({ ...user })),
    add: async (payload) => {
      addCalls += 1;
      users.push({ ".id": `*${users.length + 1}`, ...payload, disabled: "false" });
      return {};
    },
  };
  const connection = {
    menu: (path) => {
      if (path === "/ip/hotspot/user") return userMenu;
      if (path === "/ip/hotspot/user/profile") {
        return { print: async () => [{ name: "100M" }] };
      }
      throw new Error(`Menu tidak dikenal: ${path}`);
    },
  };
  const service = new MikrotikService({ push() {} });
  service.withConnection = async (operation) => operation(connection, {});
  return { service, users, getAddCalls: () => addCalls };
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
