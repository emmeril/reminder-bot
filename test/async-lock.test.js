const assert = require("node:assert/strict");
const test = require("node:test");

const AsyncLock = require("../src/async-lock");

function createDeferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

test("menjalankan antrean untuk key yang sama secara berurutan", async () => {
  const lock = new AsyncLock();
  const firstStarted = createDeferred();
  const secondStarted = createDeferred();
  const firstCanFinish = createDeferred();
  const secondCanFinish = createDeferred();
  const events = [];

  const first = lock.runExclusive("customer-1", async () => {
    events.push("first:start");
    firstStarted.resolve();
    await firstCanFinish.promise;
    events.push("first:end");
  });
  const second = lock.runExclusive("customer-1", async () => {
    events.push("second:start");
    secondStarted.resolve();
    await secondCanFinish.promise;
    events.push("second:end");
  });
  const third = lock.runExclusive("customer-1", async () => {
    events.push("third:start");
    events.push("third:end");
  });

  await firstStarted.promise;
  assert.deepEqual(events, ["first:start"]);

  firstCanFinish.resolve();
  await first;
  await secondStarted.promise;
  assert.deepEqual(events, ["first:start", "first:end", "second:start"]);

  secondCanFinish.resolve();
  await Promise.all([second, third]);
  assert.deepEqual(events, [
    "first:start",
    "first:end",
    "second:start",
    "second:end",
    "third:start",
    "third:end",
  ]);
});

test("tidak memblokir pekerjaan dengan key yang berbeda", async () => {
  const lock = new AsyncLock();
  const firstCanFinish = createDeferred();
  const events = [];

  const first = lock.runExclusive("customer-1", async () => {
    events.push("first:start");
    await firstCanFinish.promise;
    events.push("first:end");
  });
  const second = lock.runExclusive("customer-2", async () => {
    events.push("second:start");
    events.push("second:end");
  });

  await second;
  assert.deepEqual(events, ["first:start", "second:start", "second:end"]);

  firstCanFinish.resolve();
  await first;
  assert.deepEqual(events, ["first:start", "second:start", "second:end", "first:end"]);
});

test("melepas lock ketika pekerjaan gagal", async () => {
  const lock = new AsyncLock();

  await assert.rejects(
    lock.runExclusive("customer-1", async () => {
      throw new Error("operation failed");
    }),
    /operation failed/
  );

  await assert.doesNotReject(lock.runExclusive("customer-1", async () => {}));
});
