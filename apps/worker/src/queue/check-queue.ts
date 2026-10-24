import { Queue, Worker } from "bullmq";
import type { Redis } from "ioredis";

export const CHECK_QUEUE_NAME = "service-checks";

export interface CheckJobData {
  serviceId: string;
  /** When the check was due, in epoch milliseconds. */
  slot: number;
}

/** The scheduler depends on this, not on BullMQ, so its logic is testable without Redis. */
export interface CheckQueue {
  enqueue(jobs: readonly CheckJobData[]): Promise<void>;
  waitingCount(): Promise<number>;
  close(): Promise<void>;
}

/**
 * Deterministic: the same service and slot always produce the same id, and BullMQ ignores a
 * second add with an existing id. A repeated claim therefore cannot create a duplicate check.
 * (BullMQ forbids ":" in custom ids, hence "-".)
 */
export const jobIdFor = (data: CheckJobData): string => `${data.serviceId}-${data.slot}`;

export function createBullCheckQueue(connection: Redis, name = CHECK_QUEUE_NAME): CheckQueue {
  const queue = new Queue<CheckJobData>(name, {
    connection,
    defaultJobOptions: {
      // Retries are for OUR failures (database down, bug). A failing target is a recorded
      // result, not a failed job, so it never consumes attempts.
      attempts: 3,
      backoff: { type: "exponential", delay: 2000 },
      removeOnComplete: { age: 3600, count: 5000 },
      removeOnFail: { age: 86400, count: 5000 },
    },
  });
  return {
    async enqueue(jobs) {
      if (jobs.length === 0) return;
      await queue.addBulk(
        jobs.map((data) => ({ name: "check", data, opts: { jobId: jobIdFor(data) } })),
      );
    },
    waitingCount: () => queue.getWaitingCount(),
    close: () => queue.close(),
  };
}

export function createBullCheckWorker(
  connection: Redis,
  handler: (data: CheckJobData) => Promise<unknown>,
  options: { name?: string; concurrency: number },
): Worker<CheckJobData> {
  return new Worker<CheckJobData>(options.name ?? CHECK_QUEUE_NAME, (job) => handler(job.data), {
    connection,
    concurrency: options.concurrency,
  });
}
