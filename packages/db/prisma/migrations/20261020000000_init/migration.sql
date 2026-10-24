-- CreateEnum
CREATE TYPE "HttpMethod" AS ENUM ('GET', 'HEAD');

-- CreateEnum
CREATE TYPE "ServiceStatus" AS ENUM ('UNKNOWN', 'UP', 'DEGRADED', 'DOWN');

-- CreateEnum
CREATE TYPE "CheckErrorType" AS ENUM ('TIMEOUT', 'CONNECTION', 'DNS', 'BLOCKED_TARGET', 'UNEXPECTED_STATUS', 'INVALID_RESPONSE', 'INTERNAL');

-- CreateEnum
CREATE TYPE "IncidentType" AS ENUM ('DOWNTIME', 'DEGRADATION');

-- CreateTable
CREATE TABLE "User" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Service" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "method" "HttpMethod" NOT NULL DEFAULT 'GET',
    "expectedStatusMin" INTEGER NOT NULL DEFAULT 200,
    "expectedStatusMax" INTEGER NOT NULL DEFAULT 299,
    "intervalSeconds" INTEGER NOT NULL DEFAULT 60,
    "timeoutMs" INTEGER NOT NULL DEFAULT 10000,
    "degradedLatencyMs" INTEGER,
    "failureThreshold" INTEGER NOT NULL DEFAULT 3,
    "recoveryThreshold" INTEGER NOT NULL DEFAULT 2,
    "degradedThreshold" INTEGER NOT NULL DEFAULT 3,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "status" "ServiceStatus" NOT NULL DEFAULT 'UNKNOWN',
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "consecutiveSuccesses" INTEGER NOT NULL DEFAULT 0,
    "consecutiveSlow" INTEGER NOT NULL DEFAULT 0,
    "nextCheckAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastCheckedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Service_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CheckResult" (
    "id" BIGSERIAL NOT NULL,
    "serviceId" UUID NOT NULL,
    "checkedAt" TIMESTAMPTZ(3) NOT NULL,
    "success" BOOLEAN NOT NULL,
    "statusCode" INTEGER,
    "durationMs" INTEGER,
    "errorType" "CheckErrorType",
    "errorMessage" TEXT,

    CONSTRAINT "CheckResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Incident" (
    "id" UUID NOT NULL,
    "serviceId" UUID NOT NULL,
    "type" "IncidentType" NOT NULL,
    "startedAt" TIMESTAMPTZ(3) NOT NULL,
    "resolvedAt" TIMESTAMPTZ(3),
    "trigger" TEXT,

    CONSTRAINT "Incident_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "Service_isActive_nextCheckAt_idx" ON "Service"("isActive", "nextCheckAt");

-- CreateIndex
CREATE INDEX "Service_ownerId_idx" ON "Service"("ownerId");

-- CreateIndex
CREATE INDEX "CheckResult_serviceId_checkedAt_idx" ON "CheckResult"("serviceId", "checkedAt" DESC);

-- CreateIndex
CREATE INDEX "Incident_serviceId_startedAt_idx" ON "Incident"("serviceId", "startedAt" DESC);

-- AddForeignKey
ALTER TABLE "Service" ADD CONSTRAINT "Service_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckResult" ADD CONSTRAINT "CheckResult_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Incident" ADD CONSTRAINT "Incident_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Hand-written section: guarantees Prisma cannot express in schema.prisma.
-- ---------------------------------------------------------------------------

-- Incident deduplication: at most ONE open incident per service, enforced by the
-- database so that concurrent workers cannot create duplicates.
CREATE UNIQUE INDEX "Incident_one_open_per_service" ON "Incident"("serviceId") WHERE "resolvedAt" IS NULL;

-- Defense in depth: reject nonsensical configuration even if application validation is bypassed.
ALTER TABLE "Service" ADD CONSTRAINT "Service_interval_range" CHECK ("intervalSeconds" BETWEEN 10 AND 86400);
ALTER TABLE "Service" ADD CONSTRAINT "Service_timeout_range" CHECK ("timeoutMs" BETWEEN 100 AND 60000);
ALTER TABLE "Service" ADD CONSTRAINT "Service_timeout_lt_interval" CHECK ("timeoutMs" < "intervalSeconds" * 1000);
ALTER TABLE "Service" ADD CONSTRAINT "Service_expected_status_range" CHECK ("expectedStatusMin" BETWEEN 100 AND 599 AND "expectedStatusMax" BETWEEN 100 AND 599 AND "expectedStatusMin" <= "expectedStatusMax");
ALTER TABLE "Service" ADD CONSTRAINT "Service_thresholds_positive" CHECK ("failureThreshold" >= 1 AND "recoveryThreshold" >= 1 AND "degradedThreshold" >= 1);
ALTER TABLE "Service" ADD CONSTRAINT "Service_degraded_latency_positive" CHECK ("degradedLatencyMs" IS NULL OR "degradedLatencyMs" > 0);

-- A successful check carries no error; a failed check always names its error type.
ALTER TABLE "CheckResult" ADD CONSTRAINT "CheckResult_error_consistency" CHECK (("success" AND "errorType" IS NULL) OR (NOT "success" AND "errorType" IS NOT NULL));
ALTER TABLE "CheckResult" ADD CONSTRAINT "CheckResult_duration_nonnegative" CHECK ("durationMs" IS NULL OR "durationMs" >= 0);

ALTER TABLE "Incident" ADD CONSTRAINT "Incident_resolved_after_started" CHECK ("resolvedAt" IS NULL OR "resolvedAt" >= "startedAt");
