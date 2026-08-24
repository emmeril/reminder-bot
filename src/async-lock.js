class AsyncLock {
  constructor() {
    this._tails = new Map();
  }

  async acquire(key) {
    const previous = this._tails.get(key) || Promise.resolve();

    let releaseCurrent;
    const current = new Promise((resolve) => {
      releaseCurrent = resolve;
    });

    const tail = previous.then(() => current);
    this._tails.set(key, tail);
    await previous;

    let released = false;
    return () => {
      if (released) return;
      released = true;
      releaseCurrent();

      if (this._tails.get(key) === tail) {
        this._tails.delete(key);
      }
    };
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
