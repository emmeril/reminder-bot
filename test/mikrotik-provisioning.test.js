const assert = require("node:assert/strict");
const test = require("node:test");

const { MikrotikService } = require("../src/app");

function createServiceWithUsers(initialUsers = []) {
  const users = initialUsers.map((user) => ({ ...user }));
  let addCalls = 0;
  let updateCalls = 0;
  let removeCalls = 0;
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
    getRemoveCalls: () => removeCalls,
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
