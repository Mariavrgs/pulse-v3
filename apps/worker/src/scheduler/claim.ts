import type { PrismaClient } from "@pulse/db";

export interface ClaimedService {
  id: string;
  /** The moment this check was due. Together with the id it identifies the job. */
  slot: Date;
  /** The nextCheckAt value we wrote. Lets a release undo only our own claim. */
  claimedUntil: Date;
}

/**
 * Atomically claims up to `limit` due services and pushes their nextCheckAt forward.
 *
 * `FOR UPDATE SKIP LOCKED` is what makes several schedulers safe: a row locked by another
 * scheduler's claim is skipped instead of awaited, so no two schedulers ever claim the same
 * service and none of them blocks. The claim is a single statement, so it either happens
 * completely or not at all.
 *
 * Next due time: on schedule when keeping up (slot + interval, so there is no drift), and
 * now + interval when behind. A service that was overdue for an hour is therefore checked once,
 * not sixty times in a burst.
 */
export function claimDueServices(
  prisma: PrismaClient,
  now: Date,
  limit: number,
): Promise<ClaimedService[]> {
  return prisma.$queryRaw<ClaimedService[]>`
    WITH due AS (
      SELECT id, "nextCheckAt" AS slot
      FROM "Service"
      WHERE "isActive" AND "nextCheckAt" <= ${now}::timestamptz
      ORDER BY "nextCheckAt"
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE "Service" s
    SET "nextCheckAt" = CASE
          WHEN due.slot + make_interval(secs => s."intervalSeconds") > ${now}::timestamptz
            THEN due.slot + make_interval(secs => s."intervalSeconds")
          ELSE ${now}::timestamptz + make_interval(secs => s."intervalSeconds")
        END
    FROM due
    WHERE s.id = due.id
    RETURNING s.id, due.slot AS slot, s."nextCheckAt" AS "claimedUntil"
  `;
}

/**
 * Undoes claims whose jobs could not be enqueued, so those services are due again on the next
 * tick instead of silently skipping a whole interval. Conditional on nextCheckAt still being
 * the value we set, so a user edit made in between is never overwritten.
 */
export async function releaseClaims(
  prisma: PrismaClient,
  claims: readonly ClaimedService[],
): Promise<void> {
  await Promise.all(
    claims.map((c) =>
      prisma.service.updateMany({
        where: { id: c.id, nextCheckAt: c.claimedUntil },
        data: { nextCheckAt: c.slot },
      }),
    ),
  );
}
