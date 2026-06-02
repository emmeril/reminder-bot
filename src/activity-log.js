const { CONFIG } = require("./config");
const { generateId } = require("./utils");

class ActivityLog {
  constructor(limit = CONFIG.LOG_LIMIT) {
    this.limit = limit;
    this.entries = [];
  }

  push(level, source, message, meta = null) {
    const entry = {
      id: generateId(),
      level,
      source,
      message,
      meta,
      timestamp: new Date().toISOString(),
    };

    this.entries.unshift(entry);
    if (this.entries.length > this.limit) {
      this.entries.length = this.limit;
    }

    const line = `[${entry.timestamp}] [${level}] [${source}] ${message}`;
    if (level === "error") {
      console.error(line);
    } else if (level === "warn") {
      console.warn(line);
    } else {
      console.log(line);
    }
    return entry;
  }

  list() {
    return this.entries;
  }
}

module.exports = ActivityLog;
