const assert = require("node:assert/strict");
const test = require("node:test");

const WhatsAppQueue = require("../src/whatsapp/whatsapp-queue");

test("WhatsApp queue membatasi concurrency dan menyimpan status sent", async () => {
  const queue = new WhatsAppQueue({ concurrency: 1, retryLimit: 1, retryDelayMs: 0 });
  let active = 0;
  let maxActive = 0;
  const task = (id) => queue.enqueue(async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return { provider: "baileys", messageId: id, confirmed: true };
  }, { phone: `628${id}`, provider: "baileys" });

  await Promise.all([task("1"), task("2"), task("3")]);

  assert.equal(maxActive, 1);
  assert.equal(queue.getStatus().counts.sent, 3);
  assert.equal(queue.getStatus().waiting, 0);
});

test("WhatsApp queue memberi status retry lalu sent", async () => {
  const queue = new WhatsAppQueue({ concurrency: 1, retryLimit: 3, retryDelayMs: 0 });
  let attempts = 0;
  const result = await queue.enqueue(async () => {
    attempts += 1;
    if (attempts < 3) throw new Error("koneksi sementara gagal");
    return { provider: "baileys", messageId: "ok", confirmed: true };
  }, { phone: "6281234567890", provider: "baileys" });

  assert.equal(result.messageId, "ok");
  assert.equal(attempts, 3);
  assert.equal(queue.getStatus().counts.sent, 1);
});

test("WhatsApp queue tidak mengubah respons unconfirmed menjadi sent", async () => {
  const queue = new WhatsAppQueue({ concurrency: 1, retryLimit: 1, retryDelayMs: 0 });
  await assert.rejects(
    () => queue.enqueue(async () => ({ provider: "baileys", confirmed: false }), {
      phone: "6281234567890",
      provider: "baileys",
    }),
    /tidak memberikan konfirmasi/
  );
  assert.equal(queue.getStatus().counts.failed, 1);
});

test("WhatsApp queue membedakan pesan diterima server dari pesan delivered", async () => {
  const queue = new WhatsAppQueue({ concurrency: 1, retryLimit: 1, retryDelayMs: 0 });
  const result = await queue.enqueue(async () => ({
    provider: "baileys",
    messageId: "accepted-1",
    deliveryStatus: "accepted",
  }), { phone: "6281234567890", provider: "baileys" });

  assert.equal(result.deliveryStatus, "accepted");
  assert.equal(queue.getStatus().counts.accepted, 1);
  assert.equal(queue.getStatus().counts.sent, 0);
  assert.equal(queue.getStatus().items[0].deliveryStatus, "accepted");
});

test("WhatsApp queue membatalkan item pending saat shutdown", async () => {
  const queue = new WhatsAppQueue({ concurrency: 1, retryLimit: 1, retryDelayMs: 0 });
  let release;
  const blocker = new Promise((resolve) => { release = resolve; });
  const active = queue.enqueue(async () => {
    await blocker;
    return { provider: "baileys", messageId: "active" };
  }, { phone: "628111111111", provider: "baileys" });
  const pending = queue.enqueue(async () => ({ provider: "baileys", messageId: "pending" }), {
    phone: "628222222222",
    provider: "baileys",
  });

  assert.equal(queue.getStatus().counts.processing, 1);
  assert.equal(queue.getStatus().counts.pending, 1);
  queue.shutdown();
  await assert.rejects(() => pending, /dihentikan/);
  assert.equal(queue.getStatus().counts.cancelled, 1);
  release();
  await active;
});
