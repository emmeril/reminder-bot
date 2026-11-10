const crypto = require("node:crypto");

const MAX_APP_ICON_BYTES = 256 * 1024;
const PNG_SIGNATURE = Buffer.from("89504e470d0a1a0a", "hex");

function parseAppIconDataUrl(dataUrl) {
  if (typeof dataUrl !== "string" || dataUrl.length > Math.ceil(MAX_APP_ICON_BYTES * 4 / 3) + 40) {
    const error = new Error("Ukuran ikon melebihi 256 KB. Pilih gambar lain.");
    error.statusCode = 413;
    throw error;
  }

  const match = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  if (!match) {
    const error = new Error("Format ikon tidak valid. Unggah gambar PNG, JPG, atau WebP melalui pemilih gambar.");
    error.statusCode = 400;
    throw error;
  }

  const bytes = Buffer.from(match[1], "base64");
  const validPng = bytes.length >= 45
    && bytes.length <= MAX_APP_ICON_BYTES
    && bytes.subarray(0, 8).equals(PNG_SIGNATURE)
    && bytes.readUInt32BE(8) === 13
    && bytes.toString("ascii", 12, 16) === "IHDR"
    && bytes.toString("ascii", bytes.length - 8, bytes.length - 4) === "IEND"
    && bytes.readUInt32BE(16) >= 1
    && bytes.readUInt32BE(16) <= 512
    && bytes.readUInt32BE(20) >= 1
    && bytes.readUInt32BE(20) <= 512
    && bytes.toString("base64") === match[1];
  if (!validPng) {
    const error = new Error("Berkas ikon tidak valid. Gunakan gambar yang bisa dibuka di perangkat Anda.");
    error.statusCode = bytes.length > MAX_APP_ICON_BYTES ? 413 : 400;
    throw error;
  }

  return {
    contentType: "image/png",
    base64: match[1],
    version: crypto.createHash("sha256").update(bytes).digest("hex").slice(0, 20),
  };
}

module.exports = { MAX_APP_ICON_BYTES, parseAppIconDataUrl };
