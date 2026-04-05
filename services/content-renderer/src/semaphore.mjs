export class Semaphore {
  constructor(maxConcurrency) {
    this.maxConcurrency = Math.max(1, maxConcurrency);
    this.inUse = 0;
    this.waiters = [];
  }

  async acquire() {
    if (this.inUse < this.maxConcurrency) {
      this.inUse += 1;
      return () => this.release();
    }

    return await new Promise((resolve) => {
      this.waiters.push(() => {
        this.inUse += 1;
        resolve(() => this.release());
      });
    });
  }

  release() {
    if (this.inUse > 0) {
      this.inUse -= 1;
    }

    const waiter = this.waiters.shift();
    if (waiter) {
      waiter();
    }
  }
}
