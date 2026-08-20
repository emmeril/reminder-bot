const assert = require("node:assert/strict");
const test = require("node:test");

const AutoSafetyGuard = require("../src/whatsapp/auto-safety-guard");

test("auto safety membatasi burst per menit tanpa konfigurasi pengguna", () => {
  const guard = new AutoSafetyGuard({
    minGlobalGapMs: 0,
    recipientCooldownMs: 0,
    maxPerMinute: 2,
    maxPerHour: 100,
  });
  const now = 1_000_000;

  guard.markAttempt("628111111111", now - 2_000);
  guard.markAttempt("628222222222", now - 1_000);

  assert.equal(guard.getDelayMs("628333333333", now), 58_000);
});

test("auto safety memberi cooldown untuk penerima yang sama", () => {
  const guard = new AutoSafetyGuard({
    minGlobalGapMs: 0,
    recipientCooldownMs: 30_000,
    maxPerMinute: 100,
    maxPerHour: 100,
  });
  const now = 2_000_000;

  guard.markAttempt("628111111111", now - 5_000);

  assert.equal(guard.getDelayMs("628111111111", now), 25_000);
  assert.equal(guard.getDelayMs("628222222222", now), 0);
});

test("auto safety menjeda seluruh pengiriman sementara setelah kode 463", () => {
  const guard = new AutoSafetyGuard({ reachoutPauseMs: 15 * 60_000 });
  const now = 3_000_000;

  guard.pauseForReachout(now);

  assert.equal(guard.getPauseRemaining(now + 60_000), 14 * 60_000);
  assert.equal(guard.getStatus(now + 60_000).paused, true);
  assert.equal(guard.getPauseRemaining(now + 15 * 60_000), 0);
});
