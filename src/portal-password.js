const crypto = require("node:crypto");
const { promisify } = require("node:util");

const { safeCompareString } = require("./utils");

const scrypt = promisify(crypto.scrypt);
const PREFIX = "scrypt:v1:";
const KEY_LENGTH = 64;

function isPortalPasswordHash(value) {
  return typeof value === "string" && value.startsWith(PREFIX);
}

function generatePortalPassword() {
  return crypto.randomBytes(18).toString("base64url");
}

async function hashPortalPassword(password) {
  const value = String(password || "");
  if (!value) throw new Error("Password portal tidak boleh kosong.");
  const salt = crypto.randomBytes(16);
  const derived = await scrypt(value, salt, KEY_LENGTH);
  return `${PREFIX}${salt.toString("hex")}:${derived.toString("hex")}`;
}

async function verifyPortalPassword(password, storedPassword) {
  const candidate = String(password || "");
  const stored = String(storedPassword || "");
  if (!candidate || !stored) return false;
  if (!isPortalPasswordHash(stored)) {
    return safeCompareString(candidate, stored);
  }

  const [saltHex, hashHex, extra] = stored.slice(PREFIX.length).split(":");
  if (extra !== undefined || !/^[0-9a-f]{32}$/i.test(saltHex || "")
    || !/^[0-9a-f]{128}$/i.test(hashHex || "")) {
    return false;
  }
  const actual = await scrypt(candidate, Buffer.from(saltHex, "hex"), KEY_LENGTH);
  return crypto.timingSafeEqual(actual, Buffer.from(hashHex, "hex"));
}

module.exports = {
  generatePortalPassword,
  hashPortalPassword,
  isPortalPasswordHash,
  verifyPortalPassword,
};
