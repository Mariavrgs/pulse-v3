# Pulse

Uptime and performance monitoring for web services. Work in progress; see the milestone checklist below.

## Requirements

- Node.js >= 22.12 (see `.nvmrc`)
- pnpm 12 (`corepack enable` or `npm i -g pnpm`)
- Docker with Compose v2

## Quick start

```bash
pnpm install
cp .env.example .env
pnpm infra:up      # Postgres 17 + Redis 7, waits until healthy
pnpm --filter @pulse/db migrate:deploy
pnpm check         # generate Prisma client, lint, format, typecheck, tests
pnpm dev:api      # http://localhost:3000  (docs at /docs)
pnpm dev:worker   # scheduler + checker (needs Postgres and Redis)
```

`.env` is read from the repository root. If port 5432 is already taken on your machine (for example by a native
Postgres), set `POSTGRES_PORT` and the port inside `DATABASE_URL` to the same free port.

## API

Fastify 5 with Zod schemas as the single source of truth for validation, types and the OpenAPI document.
Interactive docs: `GET /docs`. Machine-readable: `GET /docs/json`.

| Area     | Endpoints                                                                             |
| -------- | ------------------------------------------------------------------------------------- |
| Auth     | `POST /auth/register`, `/auth/login`, `/auth/refresh`, `/auth/logout`, `GET /auth/me` |
| Services | `POST /services`, `GET /services`, `GET/PATCH/DELETE /services/:id`                   |
| Health   | `GET /health/live`, `GET /health/ready`                                               |

**Sessions.** Passwords are hashed with Argon2id. Access tokens are short-lived JWTs (HS256, 15 min) sent as
`Authorization: Bearer`. The refresh token is opaque, single-use and rotated on every refresh. It travels only in an
`httpOnly`, `SameSite=Strict` cookie scoped to `/auth`, and only its SHA-256 is stored. Presenting an already-used
refresh token revokes all of that user's sessions.

**Authorization.** Every data query is scoped by owner. Another user's resource answers `404`, never `403`.

**Errors.** Always `{ "error": { "code", "message", "details?", "requestId" } }`. Unexpected failures return a generic
500; the details go to the structured logs only.

```bash
curl -s -X POST localhost:3000/auth/register -H 'content-type: application/json' \
  -d '{"email":"me@example.com","password":"correct horse battery"}'

curl -s -X POST localhost:3000/services -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"name":"My API","url":"https://example.com/health","intervalSeconds":60}'
```

## Worker

A separate process (`apps/worker`) that decides _when_ to check, performs the HTTP checks and records the
results. It never shares memory with the API: they meet only in Postgres and Redis.

```
Postgres (source of truth)                      Redis / BullMQ
  Service.nextCheckAt  --claim (SKIP LOCKED)-->  queue "service-checks"  --> checks (bounded concurrency)
  CheckResult  <------------------ record -------------------------------------'
```

- **Scheduler.** Every `SCHEDULER_INTERVAL_MS` it claims due services with one atomic
  `UPDATE ... FOR UPDATE SKIP LOCKED` that also advances `nextCheckAt`, so any number of workers can run without
  coordinating and no service is claimed twice. On schedule it keeps the cadence (no drift); after downtime it
  checks once instead of replaying every missed run. The job id is `serviceId-slot`, so a repeated enqueue is a no-op.
  If the queue rejects a batch, the claims are given back.
- **Checker.** Re-validates the URL on every run, then connects **only** to the IPs the SSRF policy validated (DNS
  pinning), verifies TLS, does not follow redirects, never reads the response body, and enforces one deadline over DNS,
  connect, TLS and time to headers. Latency is time to response headers.
- **A down target is a result, not a failure.** Timeouts, refused connections, HTTP 500 and so on are stored as
  `CheckResult` rows with an `errorType`. Only _our_ failures (database unavailable) fail the job, and only those are
  retried with exponential backoff.
- **Load control.** `WORKER_CONCURRENCY` bounds simultaneous checks, `WORKER_PER_HOST_CONCURRENCY` bounds checks
  against a single hostname (per process), a job that waited longer than one interval is dropped instead of run late,
  and the scheduler stops claiming while `MAX_QUEUE_DEPTH` jobs are waiting (work stays in Postgres and the lag shows up in
  the `scheduler tick` log).
- **Shutdown.** On SIGTERM it stops claiming, lets running checks finish and records them, then exits.

| `errorType`         | Meaning                                                               |
| ------------------- | --------------------------------------------------------------------- |
| `UNEXPECTED_STATUS` | Responded, but outside the expected status range (redirects included) |
| `TIMEOUT`           | No response headers before `timeoutMs`                                |
| `CONNECTION`        | Refused, reset, unreachable, or TLS certificate problems              |
| `DNS`               | Hostname did not resolve                                              |
| `INVALID_RESPONSE`  | The server did not speak valid HTTP                                   |
| `BLOCKED_TARGET`    | Rejected by the SSRF policy; no connection was made                   |
| `INTERNAL`          | Unclassified error in the checker (logged; not the service's fault)   |

## Database

Schema: `packages/db/prisma/schema.prisma`. Migrations: `packages/db/prisma/migrations`.

```bash
pnpm --filter @pulse/db migrate:deploy   # apply migrations to DATABASE_URL
pnpm --filter @pulse/db migrate:status
```

Some guarantees cannot be expressed in Prisma's schema language and live as hand-written SQL at the end
of the init migration: the partial unique index that allows only one open incident per service, and `CHECK`
constraints on service configuration and check results.

## SSRF policy

`packages/shared/src/net` validates every monitored URL (scheme, credentials, port allowlist, blocked
hostnames, DNS resolution, every resolved IP against blocked ranges including IPv4-embedded IPv6 forms).
`validateTarget()` returns the validated addresses, and the HTTP client must connect to exactly those IPs.

## Milestones

- [x] M0 Foundation
- [x] M1 Data model + SSRF policy
- [x] M2 API
- [x] M3 Worker
- [ ] M4 Incident engine
- [ ] M5 Query API
- [ ] M6 Frontend
- [ ] M7 Load experiment
- [ ] M8 Extras (percentiles, status page, webhooks, ADR)
- [ ] M9 Polish
