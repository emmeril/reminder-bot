const assert = require("node:assert/strict");
const { afterEach, test } = require("node:test");

const { CONFIG } = require("../src/config");
const TelegramManager = require("../src/telegram-manager");

const originalConfig = {
  TELEGRAM_BOT_TOKEN: CONFIG.TELEGRAM_BOT_TOKEN,
  TELEGRAM_API_URL: CONFIG.TELEGRAM_API_URL,
  TELEGRAM_HTTP_TIMEOUT: CONFIG.TELEGRAM_HTTP_TIMEOUT,
};
const originalFetch = global.fetch;

afterEach(() => {
  Object.assign(CONFIG, originalConfig);
  global.fetch = originalFetch;
});

test("pengiriman dokumen Telegram memasang batas waktu HTTP", async () => {
  Object.assign(CONFIG, {
    TELEGRAM_BOT_TOKEN: "telegram-test-token",
    TELEGRAM_API_URL: "https://api.telegram.invalid",
    TELEGRAM_HTTP_TIMEOUT: 1_500,
  });
  let requestOptions = null;
  global.fetch = async (_url, options) => {
    requestOptions = options;
    return new Response(JSON.stringify({ ok: true, result: { message_id: 42 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const result = await TelegramManager.sendDocument("12345", __filename, "Backup test");

  assert.equal(result.messageId, 42);
  assert.equal(requestOptions.method, "POST");
  assert.ok(requestOptions.signal instanceof AbortSignal);
});
