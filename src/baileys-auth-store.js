const fs = require("fs/promises");
const path = require("path");
const sqlite3 = require("sqlite3");

class BaileysAuthStore {
  static MESSAGE_RETENTION_LIMIT = 1000;

  constructor(storagePath) {
    this.storagePath = storagePath;
    this.db = null;
    this.baileys = null;
    this.state = null;
    this.writeQueue = Promise.resolve();
  }

  async open() {
    if (this.db) return;

    await fs.mkdir(path.dirname(this.storagePath), { recursive: true });
    this.db = await new Promise((resolve, reject) => {
      const database = new sqlite3.Database(this.storagePath, (error) => {
        if (error) reject(error);
        else resolve(database);
      });
    });
    await fs.chmod(this.storagePath, 0o600);
    await this.run("PRAGMA journal_mode = WAL");
    await this.run("PRAGMA busy_timeout = 10000");
    await this.run(`
      CREATE TABLE IF NOT EXISTS baileys_auth (
        category TEXT NOT NULL,
        key_type TEXT NOT NULL,
        key_id TEXT NOT NULL,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (category, key_type, key_id)
      )
    `);
    await this.run(`
      CREATE TABLE IF NOT EXISTS baileys_messages (
        remote_jid TEXT NOT NULL,
        participant TEXT NOT NULL DEFAULT '',
        message_id TEXT NOT NULL,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (remote_jid, participant, message_id)
      )
    `);
    await Promise.all([
      fs.chmod(this.storagePath, 0o600),
      fs.chmod(`${this.storagePath}-wal`, 0o600).catch(() => {}),
      fs.chmod(`${this.storagePath}-shm`, 0o600).catch(() => {}),
    ]);
  }

  run(sql, parameters = []) {
    return new Promise((resolve, reject) => {
      this.db.run(sql, parameters, function onRun(error) {
        if (error) reject(error);
        else resolve({ changes: this.changes, lastID: this.lastID });
      });
    });
  }

  get(sql, parameters = []) {
    return new Promise((resolve, reject) => {
      this.db.get(sql, parameters, (error, row) => {
        if (error) reject(error);
        else resolve(row);
      });
    });
  }

  all(sql, parameters = []) {
    return new Promise((resolve, reject) => {
      this.db.all(sql, parameters, (error, rows) => {
        if (error) reject(error);
        else resolve(rows);
      });
    });
  }

  queueWrite(operation) {
    const queued = this.writeQueue.then(operation);
    this.writeQueue = queued.catch(() => {});
    return queued;
  }

  encode(value) {
    return JSON.stringify(value, this.baileys.BufferJSON.replacer);
  }

  decode(value) {
    return JSON.parse(value, this.baileys.BufferJSON.reviver);
  }

  async initialize(baileys) {
    this.baileys = baileys;
    await this.open();

    const storedCreds = await this.get(
      "SELECT value FROM baileys_auth WHERE category = ? AND key_type = ? AND key_id = ?",
      ["creds", "creds", "main"]
    );
    const creds = storedCreds ? this.decode(storedCreds.value) : baileys.initAuthCreds();

    this.state = {
      creds,
      keys: {
        get: async (type, ids) => this.getKeys(type, ids),
        set: async (data) => this.setKeys(data),
      },
    };
    if (!storedCreds) await this.saveCreds();

    return {
      state: this.state,
      saveCreds: () => this.saveCreds(),
    };
  }

  async getKeys(type, ids) {
    if (!Array.isArray(ids) || ids.length === 0) return {};

    const placeholders = ids.map(() => "?").join(", ");
    const rows = await this.all(
      `SELECT key_id, value FROM baileys_auth
       WHERE category = ? AND key_type = ? AND key_id IN (${placeholders})`,
      ["key", type, ...ids]
    );
    const result = Object.fromEntries(ids.map((id) => [id, undefined]));

    for (const row of rows) {
      let value = this.decode(row.value);
      if (type === "app-state-sync-key" && value) {
        value = this.baileys.proto.Message.AppStateSyncKeyData.create(value);
      }
      result[row.key_id] = value;
    }
    return result;
  }

  async setKeys(data) {
    return this.queueWrite(() => this.setKeysUnlocked(data));
  }

  async setKeysUnlocked(data) {
    await this.run("BEGIN IMMEDIATE");
    try {
      for (const [type, entries] of Object.entries(data || {})) {
        for (const [id, value] of Object.entries(entries || {})) {
          if (value == null) {
            await this.run(
              "DELETE FROM baileys_auth WHERE category = ? AND key_type = ? AND key_id = ?",
              ["key", type, id]
            );
          } else {
            await this.run(
              `INSERT INTO baileys_auth (category, key_type, key_id, value, updated_at)
               VALUES (?, ?, ?, ?, ?)
               ON CONFLICT(category, key_type, key_id)
               DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
              ["key", type, id, this.encode(value), Date.now()]
            );
          }
        }
      }
      await this.run("COMMIT");
    } catch (error) {
      await this.run("ROLLBACK").catch(() => {});
      throw error;
    }
  }

  async saveCreds() {
    return this.queueWrite(() => this.run(
      `INSERT INTO baileys_auth (category, key_type, key_id, value, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(category, key_type, key_id)
       DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      ["creds", "creds", "main", this.encode(this.state.creds), Date.now()]
    ));
  }

  async saveMessage(key, message) {
    const remoteJid = String(key?.remoteJid || "");
    const participant = String(key?.participant || "");
    const messageId = String(key?.id || "");
    if (!remoteJid || !messageId || !message) return;

    await this.queueWrite(async () => {
      await this.run(
        `INSERT INTO baileys_messages (remote_jid, participant, message_id, value, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(remote_jid, participant, message_id)
         DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        [remoteJid, participant, messageId, this.encode(message), Date.now()]
      );
      await this.run(
        `DELETE FROM baileys_messages
         WHERE rowid NOT IN (
           SELECT rowid FROM baileys_messages
           ORDER BY updated_at DESC
           LIMIT ?
         )`,
        [BaileysAuthStore.MESSAGE_RETENTION_LIMIT]
      );
    });
  }

  async getMessage(key) {
    const remoteJid = String(key?.remoteJid || "");
    const participant = String(key?.participant || "");
    const messageId = String(key?.id || "");
    if (!remoteJid || !messageId) return undefined;

    const row = await this.get(
      `SELECT value FROM baileys_messages
       WHERE remote_jid = ? AND participant = ? AND message_id = ?`,
      [remoteJid, participant, messageId]
    );
    return row ? this.decode(row.value) : undefined;
  }

  async clear() {
    if (!this.db) await this.open();
    await this.queueWrite(async () => {
      await this.run("BEGIN IMMEDIATE");
      try {
        await this.run("DELETE FROM baileys_auth");
        await this.run("DELETE FROM baileys_messages");
        await this.run("COMMIT");
      } catch (error) {
        await this.run("ROLLBACK").catch(() => {});
        throw error;
      }
    });
    this.state = null;
  }

  async close() {
    if (!this.db) return;
    await this.writeQueue;
    const database = this.db;
    this.db = null;
    await new Promise((resolve, reject) => {
      database.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
}

module.exports = BaileysAuthStore;
