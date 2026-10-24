/**
 * Caps concurrent work per key (here: per target hostname). Waiters are served in order, and a
 * released slot is handed straight to the next waiter, so the count never dips and there is no
 * window where a newcomer can jump the queue.
 *
 * Scope is one process. With several workers the effective cap is limit x workers.
 */
export class KeyedSemaphore {
  private readonly active = new Map<string, number>();
  private readonly waiters = new Map<string, Array<() => void>>();

  constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1)
      throw new RangeError("limit must be a positive integer");
  }

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    await this.acquire(key);
    try {
      return await fn();
    } finally {
      this.release(key);
    }
  }

  /** For tests and metrics: keys currently holding or awaiting a slot. */
  get trackedKeys(): number {
    return new Set([...this.active.keys(), ...this.waiters.keys()]).size;
  }

  private acquire(key: string): Promise<void> {
    const count = this.active.get(key) ?? 0;
    if (count < this.limit) {
      this.active.set(key, count + 1);
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const queue = this.waiters.get(key);
      if (queue) queue.push(resolve);
      else this.waiters.set(key, [resolve]);
    });
  }

  private release(key: string): void {
    const queue = this.waiters.get(key);
    const next = queue?.shift();
    if (next) {
      if (queue?.length === 0) this.waiters.delete(key);
      next(); // slot handed over: `active` stays the same
      return;
    }
    const count = (this.active.get(key) ?? 1) - 1;
    if (count <= 0) this.active.delete(key);
    else this.active.set(key, count);
  }
}
