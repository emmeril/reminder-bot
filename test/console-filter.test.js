const assert = require("node:assert/strict");
const test = require("node:test");

const { installLibsignalConsoleFilter } = require("../src/console-filter");

function createConsole() {
  const calls = { info: [], warn: [], error: [] };
  return {
    calls,
    info: (...args) => calls.info.push(args),
    warn: (...args) => calls.warn.push(args),
    error: (...args) => calls.error.push(args),
  };
}

test("menyembunyikan detail sesi libsignal dan membiarkan log lain", () => {
  const target = createConsole();
  installLibsignalConsoleFilter(target);

  target.info("Closing session:", { privateKey: Buffer.from("secret") });
  target.warn("Closing open session in favor of incoming prekey bundle");
  target.info("log aplikasi", { safe: true });
  target.error("error aplikasi");

  assert.deepEqual(target.calls.info, [["log aplikasi", { safe: true }]]);
  assert.deepEqual(target.calls.warn, []);
  assert.deepEqual(target.calls.error, [["error aplikasi"]]);
});

test("meringkas rangkaian Bad MAC menjadi satu peringatan aman", () => {
  const target = createConsole();
  let currentTime = new Date("2026-08-18T02:00:00.000Z");
  const now = () => currentTime;
  installLibsignalConsoleFilter(target, now);

  target.error("Failed to decrypt message with any known session...");
  target.error("Session error:Error: Bad MAC", "stack dengan detail internal");
  target.error("Failed to decrypt message with any known session...");
  target.error("Session error:Error: Bad MAC", "stack kedua");

  assert.deepEqual(target.calls.error, []);
  assert.deepEqual(target.calls.warn, [[
    "[2026-08-18T02:00:00.000Z] [warn] [baileys-signal] Bad MAC; sesi pesan akan disinkronkan ulang",
  ]]);

  currentTime = new Date("2026-08-18T02:01:00.000Z");
  target.error("Session error:Error: Bad MAC", "stack setelah rate limit");
  assert.equal(target.calls.warn.length, 2);
});

test("pemasangan filter bersifat idempoten", () => {
  const target = createConsole();

  assert.equal(installLibsignalConsoleFilter(target), true);
  assert.equal(installLibsignalConsoleFilter(target), false);
});
