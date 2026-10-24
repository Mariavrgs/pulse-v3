import { describe, expect, it } from "vitest";
import { KeyedSemaphore } from "./keyed-semaphore.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("KeyedSemaphore", () => {
  it("never runs more than `limit` tasks at once for one key", async () => {
    const sem = new KeyedSemaphore(2);
    let running = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 8 }, () =>
        sem.run("host-a", async () => {
          running++;
          peak = Math.max(peak, running);
          await sleep(10);
          running--;
        }),
      ),
    );
    expect(peak).toBe(2);
  });

  it("lets different keys run in parallel", async () => {
    const sem = new KeyedSemaphore(1);
    let running = 0;
    let peak = 0;
    const task = () =>
      sem.run(`host-${Math.random()}`, async () => {
        running++;
        peak = Math.max(peak, running);
        await sleep(20);
        running--;
      });
    await Promise.all([task(), task(), task()]);
    expect(peak).toBe(3);
  });

  it("serves waiters in arrival order", async () => {
    const sem = new KeyedSemaphore(1);
    const order: number[] = [];
    await Promise.all(
      [1, 2, 3, 4].map((n) =>
        sem.run("k", async () => {
          order.push(n);
          await sleep(5);
        }),
      ),
    );
    expect(order).toEqual([1, 2, 3, 4]);
  });

  it("releases the slot when the task throws", async () => {
    const sem = new KeyedSemaphore(1);
    await expect(sem.run("k", async () => Promise.reject(new Error("fail")))).rejects.toThrow(
      "fail",
    );
    await expect(sem.run("k", async () => "still works")).resolves.toBe("still works");
  });

  it("forgets keys that are idle, so memory does not grow with every hostname ever seen", async () => {
    const sem = new KeyedSemaphore(2);
    await Promise.all(
      Array.from({ length: 50 }, (_, i) => sem.run(`host-${i}`, async () => undefined)),
    );
    expect(sem.trackedKeys).toBe(0);
  });

  it("rejects an invalid limit", () => {
    expect(() => new KeyedSemaphore(0)).toThrow(RangeError);
    expect(() => new KeyedSemaphore(1.5)).toThrow(RangeError);
  });
});
