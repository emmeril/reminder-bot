const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildIpBindingBandwidthQueueName,
  normalizeMacAddress,
  normalizeMacAddresses,
  normalizeQueueTarget,
  parseHotspotRateLimitForSimpleQueue,
  readRouterValue,
} = require("../src/modules/mikrotik/domain");

test("normalisasi MAC menghasilkan format RouterOS dan membuang duplikat", () => {
  assert.equal(normalizeMacAddress("7c-aa-de-53-5d-77"), "7C:AA:DE:53:5D:77");
  assert.deepEqual(
    normalizeMacAddresses(["7c-aa-de-53-5d-77", "7C:AA:DE:53:5D:77"]),
    ["7C:AA:DE:53:5D:77"]
  );
  assert.throws(() => normalizeMacAddress("01:00:5E:00:00:01"), /unicast/);
});

test("rate limit sederhana tetap cocok untuk Simple Queue IP Binding", () => {
  assert.deepEqual(parseHotspotRateLimitForSimpleQueue("5M/5M"), {
    source: "5M/5M",
    maxLimit: "5M/5M",
    burstLimit: "0/0",
    burstThreshold: "0/0",
    burstTime: "0s/0s",
    priority: "8/8",
    limitAt: "0/0",
  });
});

test("target Simple Queue hanya berisi IPv4 unik dan terurut", () => {
  assert.deepEqual(
    normalizeQueueTarget(["192.168.1.20/32", "192.168.1.3", "192.168.1.20", "invalid"]),
    ["192.168.1.3", "192.168.1.20"]
  );
});

test("helper MikroTik menjaga kompatibilitas field API dan nama queue stabil", () => {
  assert.equal(readRouterValue({ "rate-limit": "5M/5M" }, "rate-limit", "rateLimit"), "5M/5M");
  assert.equal(readRouterValue({ rateLimit: "10M/10M" }, "rate-limit", "rateLimit"), "10M/10M");
  assert.equal(
    buildIpBindingBandwidthQueueName("customer-1"),
    buildIpBindingBandwidthQueueName("customer-1")
  );
  assert.equal(
    buildIpBindingBandwidthQueueName("customer-1", "192.168.1.10"),
    buildIpBindingBandwidthQueueName("customer-1", "192.168.1.10")
  );
  assert.notEqual(
    buildIpBindingBandwidthQueueName("customer-1", "192.168.1.10"),
    buildIpBindingBandwidthQueueName("customer-1", "192.168.1.11")
  );
});
