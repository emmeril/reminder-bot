#!/usr/bin/env node

/*
 * Local-only bridge for WhatsApp Android. It uses Appium UiAutomator2 for
 * accessibility/UI automation; it never pretends that WhatsApp has a REST API.
 */
const http = require("http");
const { execFile, spawn } = require("child_process");
const { promisify } = require("util");
const crypto = require("crypto");

const execFileAsync = promisify(execFile);
const HOST = process.env.ANDROID_BRIDGE_HOST || "127.0.0.1";
const PORT = Number(process.env.ANDROID_BRIDGE_PORT || 3030);
const APPIUM_URL = String(process.env.APPIUM_URL || "http://127.0.0.1:4723").replace(/\/$/, "");
const ADB_SERIAL = process.env.ANDROID_ADB_SERIAL || "";
const WHATSAPP_PACKAGE = process.env.WHATSAPP_PACKAGE || "com.whatsapp";
const SEND_XPATH = process.env.ANDROID_SEND_XPATH || '//*[@content-desc="Send" or @content-desc="Kirim"]';
const CONFIRM_TIMEOUT_MS = Math.max(3000, Number(process.env.ANDROID_CONFIRM_TIMEOUT_MS || 12000));
const TOKEN = String(process.env.ANDROID_BRIDGE_TOKEN || "").trim();
const MANAGE_APPIUM = ["1", "true", "yes", "on"].includes(String(process.env.ANDROID_BRIDGE_MANAGE_APPIUM || "").toLowerCase());
const AUTO_START_WHATSAPP = ["1", "true", "yes", "on"].includes(String(process.env.ANDROID_AUTO_START_WHATSAPP || "").toLowerCase());
let appiumProcess = null;

function isLoopback(host) {
  return ["127.0.0.1", "localhost", "::1"].includes(host);
}

if (!isLoopback(HOST)) {
  throw new Error("ANDROID_BRIDGE_HOST wajib loopback; bridge tidak boleh diekspos ke LAN/internet");
}
if (!isLoopback(new URL(APPIUM_URL).hostname)) {
  throw new Error("APPIUM_URL wajib loopback; Appium tidak boleh diekspos ke LAN/internet");
}

function json(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

async function command(commandName, args = []) {
  try {
    const result = await execFileAsync(commandName, args, { timeout: 10000, maxBuffer: 1024 * 1024 });
    return { ok: true, output: `${result.stdout || ""}${result.stderr || ""}` };
  } catch (error) {
    return { ok: false, output: `${error.stdout || ""}${error.stderr || ""}${error.message || ""}` };
  }
}

function adbArgs(args) {
  return ADB_SERIAL ? ["-s", ADB_SERIAL, ...args] : args;
}

async function probe() {
  const waydroid = await command("waydroid", ["status"]);
  const adb = await command("adb", adbArgs(["get-state"]));
  const packageProbe = adb.ok
    ? await command("adb", adbArgs(["shell", "pm", "path", WHATSAPP_PACKAGE]))
    : { ok: false, output: "ADB tidak siap" };
  let processProbe = adb.ok
    ? await command("adb", adbArgs(["shell", "pidof", WHATSAPP_PACKAGE]))
    : { ok: false, output: "ADB tidak siap" };
  if (AUTO_START_WHATSAPP && adb.ok && packageProbe.ok && !/\d/.test(processProbe.output.trim())) {
    await command("adb", adbArgs(["shell", "monkey", "-p", WHATSAPP_PACKAGE, "-c", "android.intent.category.LAUNCHER", "1"]));
    await new Promise((resolve) => setTimeout(resolve, 1500));
    processProbe = await command("adb", adbArgs(["shell", "pidof", WHATSAPP_PACKAGE]));
  }
  let appium = { ok: false, output: "Appium tidak siap" };
  try {
    const response = await fetch(`${APPIUM_URL}/status`, { signal: AbortSignal.timeout(5000) });
    appium = { ok: response.ok, output: await response.text() };
  } catch (error) {
    appium = { ok: false, output: error.message };
  }
  const waydroidRunning = waydroid.ok && /running/i.test(waydroid.output);
  const whatsappInstalled = packageProbe.ok && /package:/i.test(packageProbe.output);
  const whatsappRunning = processProbe.ok && /\d/.test(processProbe.output.trim());
  const bridgeReady = true;
  const ready = waydroidRunning && whatsappInstalled && whatsappRunning && appium.ok && bridgeReady;
  return {
    ready,
    state: ready ? "ready" : "unavailable",
    detail: ready ? "Waydroid dan WhatsApp Android siap" : "Waydroid/WhatsApp/Appium belum seluruhnya siap",
    waydroid: waydroidRunning ? "running" : "stopped",
    whatsappInstalled,
    whatsappRunning,
    whatsapp: whatsappRunning ? "running" : "stopped",
    bridge: bridgeReady ? "connected" : "disconnected",
    appium: appium.ok ? "connected" : "disconnected",
    checkedAt: new Date().toISOString(),
  };
}

async function appiumRequest(pathname, options = {}) {
  const response = await fetch(`${APPIUM_URL}${pathname}`, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers || {}) },
    signal: options.signal || AbortSignal.timeout(options.timeoutMs || 30000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.value?.error) {
    const error = new Error(payload.value?.message || payload.error || `Appium HTTP ${response.status}`);
    error.statusCode = 502;
    throw error;
  }
  return payload.value ?? payload;
}

async function createSession() {
  return appiumRequest("/session", {
    method: "POST",
    body: JSON.stringify({
      capabilities: {
        alwaysMatch: {
          platformName: "Android",
          "appium:automationName": "UiAutomator2",
          "appium:deviceName": "Waydroid",
          ...(ADB_SERIAL ? { "appium:udid": ADB_SERIAL } : {}),
          "appium:appPackage": WHATSAPP_PACKAGE,
          "appium:appActivity": "com.whatsapp.Main",
          "appium:noReset": true,
          "appium:newCommandTimeout": 120,
        },
      },
    }),
  });
}

async function findElement(sessionId, xpath) {
  const value = await appiumRequest(`/session/${sessionId}/element`, {
    method: "POST",
    body: JSON.stringify({ using: "xpath", value: xpath }),
  });
  return value["element-6066-11e4-a52e-4f735466cecf"] || value.ELEMENT || null;
}

async function sendMessage(phone, message) {
  const health = await probe();
  if (!health.ready) {
    const error = new Error(health.detail);
    error.code = "ANDROID_PROVIDER_UNAVAILABLE";
    error.statusCode = 503;
    throw error;
  }

  let session = null;
  try {
    session = await createSession();
    const sessionId = session.sessionId || session.id;
    if (!sessionId) throw new Error("Appium tidak mengembalikan session id");
    const deepLink = `https://wa.me/${phone}?text=${encodeURIComponent(message)}`;
    await appiumRequest(`/session/${sessionId}/execute/sync`, {
      method: "POST",
      body: JSON.stringify({ script: "mobile: deepLink", args: [{ url: deepLink, package: WHATSAPP_PACKAGE }] }),
    });

    const deadline = Date.now() + 15000;
    let element = null;
    while (Date.now() < deadline) {
      try {
        element = await findElement(sessionId, SEND_XPATH);
        if (element) break;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (!element) {
      const error = new Error("Tombol kirim WhatsApp tidak ditemukan oleh accessibility bridge");
      error.code = "ANDROID_SEND_UNCONFIRMED";
      error.statusCode = 502;
      throw error;
    }
    await appiumRequest(`/session/${sessionId}/element/${element}/click`, { method: "POST", body: "{}" });

    const expectedText = escapeXml(message);
    const confirmDeadline = Date.now() + CONFIRM_TIMEOUT_MS;
    while (Date.now() < confirmDeadline) {
      const source = await appiumRequest(`/session/${sessionId}/source`, { method: "GET" });
      if (String(source).includes(expectedText) && String(source).includes("message_text")) {
        return {
          confirmed: true,
          messageId: crypto.randomUUID(),
          confirmedAt: new Date().toISOString(),
          providerMessageId: null,
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 700));
    }
    const error = new Error("Pesan tampil di composer tetapi bubble terkirim tidak terkonfirmasi");
    error.code = "ANDROID_SEND_UNCONFIRMED";
    error.statusCode = 502;
    throw error;
  } finally {
    if (session?.sessionId || session?.id) {
      await fetch(`${APPIUM_URL}/session/${session.sessionId || session.id}`, { method: "DELETE" }).catch(() => {});
    }
  }
}

function authorized(req) {
  if (!TOKEN) return true;
  return req.headers.authorization === `Bearer ${TOKEN}`;
}

async function readBody(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1024 * 1024) throw new Error("Request terlalu besar");
  }
  return raw ? JSON.parse(raw) : {};
}

const server = http.createServer(async (req, res) => {
  if (!authorized(req)) return json(res, 401, { error: "Unauthorized" });
  try {
    if (req.method === "GET" && (req.url === "/health" || req.url === "/v1/status")) {
      return json(res, 200, await probe());
    }
    if (req.method === "POST" && req.url === "/v1/messages") {
      const body = await readBody(req);
      const phone = String(body.phone || "").replace(/\D/g, "");
      const message = String(body.message || "").trim();
      if (!/^62\d{8,15}$/.test(phone) || !message || message.length > 4096) {
        return json(res, 400, { code: "INVALID_INPUT", error: "phone harus 628xxx dan message 1-4096 karakter", retryable: false });
      }
      return json(res, 200, await sendMessage(phone, message));
    }
    return json(res, 404, { error: "Not found" });
  } catch (error) {
    return json(res, error.statusCode || 500, {
      code: error.code || "ANDROID_BRIDGE_ERROR",
      error: error.message,
      retryable: error.code !== "INVALID_INPUT",
    });
  }
});

if (MANAGE_APPIUM) {
  const appiumUrl = new URL(APPIUM_URL);
  appiumProcess = spawn(process.env.APPIUM_BIN || "appium", [
    "--address", appiumUrl.hostname,
    "--port", appiumUrl.port || "4723",
    "--base-path", appiumUrl.pathname || "/",
  ], { stdio: "inherit" });
  appiumProcess.on("error", (error) => {
    console.error(`Managed Appium gagal dimulai: ${error.message}`);
    appiumProcess = null;
  });
  appiumProcess.on("exit", (code, signal) => {
    console.error(`Managed Appium stopped (code=${code}, signal=${signal})`);
    appiumProcess = null;
  });
}

server.listen(PORT, HOST, () => {
  console.log(`WhatsApp Android bridge listening on http://${HOST}:${PORT}`);
});

function shutdown() {
  appiumProcess?.kill("SIGTERM");
  server.close(() => process.exit(0));
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
