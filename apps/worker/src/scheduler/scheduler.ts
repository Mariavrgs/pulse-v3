import type { PrismaClient } from "@pulse/db";
import type { Logger } from "pino";
import type { CheckQueue } from "../queue/check-queue.js";
import { claimDueServices, releaseClaims } from "./claim.js";

export interface SchedulerOptions {
  prisma: PrismaClient;
  queue: CheckQueue;
  logger: Logger;
  intervalMs: number;
  batchSize: number;
  /** Stop claiming while at least this many jobs are waiting. */
  maxQueueDepth: number;
  /** Upper bound of batches per tick, so one tick cannot monopolize the loop. */
  maxBatchesPerTick?: number;
  now?: () => Date;
}

export interface TickResult {
  claimed: number;
  /** How late the oldest claimed check was, in ms. The main health signal of the scheduler. */
  maxLagMs: number;
  backpressure: boolean;
}

export class Scheduler {
  private timer: NodeJS.Timeout | undefined;
  private inflight: Promise<void> = Promise.resolve();
  private running = false;

  constructor(private readonly opts: SchedulerOptions) {}

  /** One pass: claim due services in batches and enqueue them. Exposed for tests. */
  async tick(): Promise<TickResult> {
    const { prisma, queue, batchSize, maxQueueDepth } = this.opts;
    const maxBatches = this.opts.maxBatchesPerTick ?? 20;
    const result: TickResult = { claimed: 0, maxLagMs: 0, backpressure: false };

    for (let i = 0; i < maxBatches; i++) {
      // The database stays the source of truth: when the queue is full we simply do not claim,
      // the services remain due, and the lag grows visibly instead of the queue growing forever.
      if ((await queue.waitingCount()) >= maxQueueDepth) {
        result.backpressure = true;
        break;
      }

      const now = this.opts.now?.() ?? new Date();
      const batch = await claimDueServices(prisma, now, batchSize);
      if (batch.length === 0) break;

      try {
        await queue.enqueue(batch.map((c) => ({ serviceId: c.id, slot: c.slot.getTime() })));
      } catch (err) {
        await releaseClaims(prisma, batch).catch((releaseErr: unknown) =>
          this.opts.logger.error(
            { err: releaseErr },
            "failed to release claims after enqueue error",
          ),
        );
        throw err;
      }

      result.claimed += batch.length;
      const oldest = Math.min(...batch.map((c) => c.slot.getTime()));
      result.maxLagMs = Math.max(result.maxLagMs, now.getTime() - oldest);
      if (batch.length < batchSize) break;
    }
    return result;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.scheduleNext(0);
  }

  async stop(): Promise<void> {
    this.running = false;
    clearTimeout(this.timer);
    await this.inflight;
  }

  private scheduleNext(delayMs: number): void {
    this.timer = setTimeout(() => {
      this.inflight = this.runOnce().then((saturated) => {
        // Still more work than one tick could take: go again immediately.
        if (this.running) this.scheduleNext(saturated ? 0 : this.opts.intervalMs);
      });
    }, delayMs);
  }

  private async runOnce(): Promise<boolean> {
    try {
      const result = await this.tick();
      if (result.claimed > 0 || result.backpressure) {
        this.opts.logger.info(result, "scheduler tick");
      }
      return result.claimed >= this.opts.batchSize * (this.opts.maxBatchesPerTick ?? 20);
    } catch (err) {
      this.opts.logger.error({ err }, "scheduler tick failed");
      return false;
    }
  }
}
