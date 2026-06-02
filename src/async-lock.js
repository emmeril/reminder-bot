class AsyncLock {
  constructor() {
    this._locks = new Map();
  }

  async acquire(key) {
    while (this._locks.has(key)) {
      await this._locks.get(key);
    }
    let releaseResolver;
    const releasePromise = new Promise((resolve) => {
      releaseResolver = resolve;
    });
    this._locks.set(key, releasePromise);
    const release = () => {
      this._locks.delete(key);
      releaseResolver();
    };
    return release;
  }

  async runExclusive(key, fn) {
    const release = await this.acquire(key);
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

module.exports = AsyncLock;
