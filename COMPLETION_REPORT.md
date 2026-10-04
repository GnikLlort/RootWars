# RootWars — Completion Report (review & repair pass)

Scope: review and repair the existing RootWars codebase without replacing its design or features.
No deployment, publishing or merging was performed; all work is on the working branch.

Every claim in this report is tied to a command that was actually run in this environment. Where a
check could not be executed here, it is listed under **Limitations** rather than implied as passing.

---

## 1. Exact commands and results

| Command | Result |
|---|---|
| `npx tsc --noEmit -p tsconfig.json` | clean (client, server, scripts, tests) |
| `npm run build` (`vite build && tsc -p tsconfig.server.json`) | success; client bundle `dist/client/assets/index-*.js` 291.99 kB (gzip 86.97 kB); server emitted to `dist/server/**` |
| `node dist/server/server/index.js` with an unsafe production env | **refused to start**: `SESSION_SECRET must be set explicitly in production`, `REDIS_URL is required in production`, `ALLOWED_ORIGINS must list the exact browser origins` |
| `node dist/server/server/index.js` with a valid production env but unreachable PostgreSQL | **refused to start**: `FATAL: DATABASE_URL is configured but PostgreSQL is unreachable (...). Production never falls back to embedded PGlite` (Redis behaves the same way) |
| `npx vitest run` | **10 files passed — 59 passed, 5 skipped, 0 failed (29.31s)** |
| `npx vitest run tests/lab-docker.integration.test.ts` | 1 passed / 5 skipped, with the explicit banner `REAL DOCKER ISOLATION TESTS WERE NOT EXECUTED (no Docker daemon reachable). No network-isolation claim can be made from this test run.` |
| `ROOTWARS_REQUIRE_DOCKER_TESTS=true npx vitest run tests/lab-docker.integration.test.ts` | **fails** (`refusing to pretend the lab isolation tests ran`) — the gate cannot silently pass in CI |
| `LOADTEST_MAX_SESSIONS=120 LOADTEST_RAMP_STEPS=4 LOADTEST_ROUNDS=10 npm run loadtest` | 120 sessions / 900 requests / 0 errors; results in `LOAD_TEST_RESULTS.json` (section 6) |

### Test inventory

| Suite | Kind | Tests | Result |
|---|---|---|---|
| `tests/command-parser.test.ts` | unit | 5 | passed |
| `tests/lab-policy.test.ts` | unit | 10 | passed |
| `tests/seed-safety.test.ts` | unit | 12 | passed |
| `tests/ledger.test.ts` | integration (DB) | 3 | passed |
| `tests/pvp-atomicity.test.ts` | integration (concurrency) | 6 | passed |
| `tests/exploration.test.ts` | integration (DB + HTTP) | 4 | passed |
| `tests/realtime.test.ts` | integration (2 gateways + Redis) | 5 | passed |
| `tests/auth-security.test.ts` | integration (HTTP/WS/Redis) | 9 | passed |
| `tests/lab-mission-flow.test.ts` | integration (HTTP + outbox worker) | 4 | passed |
| `tests/lab-docker.integration.test.ts` | integration (real Docker) | 1 + 5 | gate passed, 5 **skipped here** (no Docker daemon) |

The previous `tests/rootwars.test.ts` (2 of 14 failing) was removed and replaced by the focused suites
above; it asserted the old `ip netns`/`verifyLabNetworkIsolation` design that no longer exists.

---

## 2. P1 — Lab missions run real Nmap safely, or fail closed

**What was wrong (traced in code):** the runner executed `sudo ip netns …` as `uid=65534` with all
capabilities dropped, defaulted to `/usr/local/bin/nmap` while the image installs `/usr/sbin/nmap`,
and started simulated listeners *inside the scanner's own namespace* instead of connecting to
`lab-target-sovereign`. It reported success for scans that could not have touched the mission target.

**What it does now** (`src/workers/lab-docker-backend.ts`, worker role only):

1. Per-mission network: `docker network create --driver bridge --internal --subnet 10.240.<mission>.0/24`
   (label `rootwars.disposable=true`); `--internal` removes the gateway, so public and host addresses
   are unroutable by construction.
2. Disposable RootWars-owned target container bound to the **mission-assigned** IP with `--user 65534:65534`,
   `--read-only`, `--cap-drop ALL`, `--security-opt no-new-privileges`, `--pids-limit`, `--memory`,
   `--memory-swap`, `--cpus`, `noexec,nosuid` tmpfs, and the mission's service spec passed as a single env var.
3. Readiness gate (`docker exec … node /app/lab-target.mjs --selfcheck`) before scanning.
4. Scanner container: same non-root/cap-drop/read-only hardening, `nofile`/`fsize` ulimits, fixed
   `ENTRYPOINT ["/usr/bin/nmap"]`, `execFile` (never a shell), allowlisted argument vector, `execFile`
   timeout + `maxBuffer` output cap.
5. Teardown of scanner container, target container and network in a `finally` block;
   `scripts/reap-lab-resources.sh` is the hard-kill safety net.
6. **Fail closed:** with no `LAB_DOCKER_HOST` (or an unreachable one), `runLabScan` returns
   `allowed:false, backendAvailable:false, isolationMode:'unavailable'`, reason
   `LAB_BACKEND_UNAVAILABLE: No dedicated lab Docker endpoint is configured…`, zero ports, no credit.
   There is deliberately no simulation fallback.

**API/worker split:** the API only enqueues a durable `lab_scan` outbox job and waits (poll with
`LAB_SCAN_WAIT_MS`, default 20 s). API containers receive no Docker socket; only `ROLE=worker`
processes start the outbox loop.

**Verified here:** `tests/lab-mission-flow.test.ts` drives the real HTTP terminal route: accept → `lab open`
→ wrong target rejected with `UNAUTHORIZED_LAB_TARGET` + audit row (`Target mismatch`, `isolation_mode='not-executed'`)
→ assigned target fails closed with `[LAB_POLICY_DENIED] LAB_BACKEND_UNAVAILABLE…`, audit row
`isolation_mode='unavailable'`, `discovered_ports=[]`, `raw_output=''`, no mission credit and no ledger delta.
`tests/lab-policy.test.ts` covers target/profile/service validation, subnet derivation, fixed argv, and the
fail-closed result shape.

**Not verified here:** real Docker/network isolation. `tests/lab-docker.integration.test.ts` contains the
live tests (approved target reachable; another mission's target unreachable; `1.1.1.1` and `127.0.0.1`
unreachable; `ip route` has no `default`; scanner `uid=65534`; no leftover labelled containers/networks)
and is skip-gated with a loud banner because this sandbox has no Docker daemon. Run it with
`bash scripts/build-lab-images.sh` then
`ROOTWARS_REQUIRE_DOCKER_TESTS=true ROOTWARS_BUILD_LAB_IMAGES=true npx vitest run tests/lab-docker.integration.test.ts`.

---

## 3. P2 — Atomic, idempotent PvP

**What was wrong:** balances/cooldowns/caps were read before the transaction, currency moved in a separate
statement, and retries could double-apply.

**What it does now:** `executePvpOperation` opens one transaction that (a) deterministically locks the
target node (`FOR UPDATE OF n`), then (b) locks attacker and defender accounts/user rows in id `ORDER BY`,
re-reads balances, cooldowns, per-attack cap, 24 h loss allowance and the protected floor inside the lock,
then applies seizure, bounty claim, node state, heat/XP, group progress, mission/intel updates and the
incident row in the same transaction. Idempotency keys are unique; a replay returns the original incident
and ledger entries; a unique-violation race re-reads and returns the winner's incident. Requests without an
explicit key receive a server-generated `requestId`.

Verified by `tests/pvp-atomicity.test.ts` (6 passed):

- six attackers hitting one node simultaneously never exceed the 10 % per-attack cap or the 20 % / 24 h cap;
  total RWC seized == 400 of 2,000; `ledger_transactions(tx_type='pvp_seizure')` count == incidents with `rwc_stolen > 0`;
- two simultaneous attacks from one attacker produce exactly one success and one `ATTACKER_COOLDOWN`;
- one concurrent bounty claim wins; bounty status `claimed`; exactly one `bounty_payout` ledger row;
- replayed `requestId` returns the original incident (sequential and concurrent), one incident row;
- a mid-operation failure (frozen account) rolls back node state, ledger, heat, XP and the incident;
- at the protected floor only 20 RWC of a 520 RWC balance can be taken.

`tests/ledger.test.ts` additionally proves idempotent transfers, 5-of-15 concurrent transfers succeeding
on a 1,000 RWC account (never overdrawn), and that balances never go negative.

---

## 4. P3 — No public default credentials

- `seedDatabase(db)` creates **world data only**: 0 users, 0 player nodes (verified), 2 regions, 5 lab missions,
  27 NPC nodes, market/faction/world data.
- `src/db/demo-seed.ts` (`npm run db:demo-seed`) is the only way to create demo operators. It refuses to run
  with `NODE_ENV=production`, accepts `--password=`/`DEMO_SEED_PASSWORD` (min 8 chars) or generates a one-time
  random password that is printed once.
- Production startup (`src/server/config.ts`) fails on: missing/short/known-development `SESSION_SECRET`,
  `DEMO_SEED_PASSWORD`/`ALLOW_DEMO_SEED`, the development database password, missing `REDIS_URL` or
  `ALLOWED_ORIGINS`, `TRUST_PROXY=true`, `RATE_LIMIT_FAIL_MODE=open`, `FORCE_PGLITE`/`FORCE_REDIS_MOCK`,
  host Docker socket / `LAB_ALLOW_HOST_DOCKER=true` in production.
- `README.md` no longer advertises a shared demo password; it documents `npm run db:demo-seed` instead.
- Test fixtures generate their own random demo password per harness (`tests/support/harness.ts`) and never
  reuse a documented value.

`tests/seed-safety.test.ts` (12 passed) enforces all of the above by exercising the code and by asserting the
deployment files (`Dockerfile.api`, `docker-compose.yml`, `.env.example`, `README.md`) stay consistent.

---

## 5. P4 — Realtime across instances

`src/server/realtime.ts`: every gateway subscribes to the Redis `rootwars:events` channel once, stamps the
origin instance id, ignores its own publications (no republish loop) and fans out to local sockets only.
Private channels (`user`, `group`, `alliance`) re-check membership from the database per delivery, so
membership changes apply to already-open sockets.

Verified by `tests/realtime.test.ts` (5 passed) with **two real Fastify instances sharing one database and
one Redis**: cross-instance group chat is delivered once to each member on both instances and never to a
non-member; alliance events reach only alliance members; a member removed from a group stops receiving
group events while the socket stays open; a global event is delivered exactly once per client; a
user-scoped event reaches only that user.

The live load test additionally measured **8,100 / 8,100** expected WebSocket deliveries (ratio 1.0) across
120 sockets.

---

## 6. Security, production and load-test changes

- Sessions: HttpOnly `rw_session` cookie (`SameSite=Lax`, `Secure` in production), SHA-256 hashed tokens in
  the database. The client no longer stores a token in `localStorage` and the WebSocket URL no longer
  carries one; `/ws` authenticates from the cookie during the handshake and validates `Origin`.
- CORS: explicit allowlist from `ALLOWED_ORIGINS` (no `origin: true`); denied origins are rejected without
  throwing (see Limitations for the 500-vs-close caveat).
- Rate limiting: `trustProxy` is opt-in (`TRUST_PROXY`), so spoofed `X-Forwarded-For` headers cannot
  create fresh buckets; limits are the config values (`RATE_LIMIT_MAX_PER_MINUTE`, …); when Redis is down
  the API **fails closed** (503) for auth/command/chat/event paths instead of silently disabling limits.
- World events: the player-facing endpoint is admin-only (non-admin gets 403) and rate-limited; world
  events continue to be scheduled by the worker.
- Deployment: `Dockerfile.api` runs the compiled server as `USER node` (`CMD ["node","dist/server/server/index.js"]`,
  path verified against the actual build output); API role starts no outbox/world loop; the worker owns the
  dedicated lab Docker endpoint; Compose requires `SESSION_SECRET`, `POSTGRES_PASSWORD` and `ALLOWED_ORIGINS`,
  mounts no Docker socket into the API, and puts the lab daemon on an internal-only network.
- Load test (`scripts/load-test.ts`) rewritten: cookie-based sessions, gradual ramp, optional real
  PostgreSQL/Redis and multiple API instances (`LOADTEST_DATABASE_URL`, `LOADTEST_REDIS_URL`,
  `LOADTEST_INSTANCES`), reports p50/p90/p95/p99 by category, error counts by status, DB pool saturation
  (pg.Pool waiting count or "PGlite serialized"), outbox queue depth/lag, WebSocket delivery ratio, and an
  explicit `claimsNotSupportedByThisRun` list.

### Load-test run in this environment (embedded backends)

```bash
LOADTEST_MAX_SESSIONS=120 LOADTEST_RAMP_STEPS=4 LOADTEST_ROUNDS=10 npm run loadtest
```

- Environment: Linux 6.1.158+ x64, 2 vCPU @ 2.60 GHz, 3.85 GB RAM, Node v22.22.3, **PGlite + ioredis-mock, 1 API instance**.
- Ramp: 4 steps to 120 sessions (48 idle sockets / 72 active workers), 900 HTTP requests in 25.92 s, **0 errors**, 34.72 req/s.
- Latency: p50 349.08 ms, p90 501.27 ms, p95 587.67 ms, p99 2532.68 ms (max 3206.94 ms).
- WebSocket delivery: 8,100 expected / 8,100 delivered, 0 socket errors.
- Database: PGlite reports `serialized: true` (single connection) — tail latency here is serialization-bound.
- Outbox queue: max depth 4, max lag 0.17 s.
- **This run does not demonstrate thousands of concurrent players.** A representative measurement requires
  PostgreSQL + Redis (`LOADTEST_DATABASE_URL`/`LOADTEST_REDIS_URL`, `LOADTEST_INSTANCES=3`); that stack was
  not available in this sandbox and no such claim is made.

---

## 7. Additional defects found and fixed during verification

1. **`inspect` returned HTTP 500 on a non-demo world** (`player_node_discoveries_node_id_fkey`): NPC
   adjacency lists reference PvP player nodes that only exist with demo fixtures. Discovery inserts are now
   `INSERT … SELECT … FROM network_nodes` in both the terminal inspector and the PvP probe path, so a stale
   reference is skipped instead of aborting the command/transaction. Regression: `tests/exploration.test.ts`
   (4 passed; both paths were confirmed to fail when the fix is reverted and to pass with it).
2. **Compiled server could not find migrations** (`dist/migrations`): `runMigrations` now resolves the first
   existing candidate directory (env override, `cwd/migrations`, source-relative, compiled-relative) and
   raises a clear error if none exists. Verified by starting the built server and by a unit assertion on both
   layouts.
3. **Production silently fell back to embedded backends:** with `NODE_ENV=production`, an unreachable
   `DATABASE_URL`/`REDIS_URL` now aborts startup with a `FATAL:` message instead of quietly running on
   PGlite/ioredis-mock (which would split state across containers and break cross-instance realtime).
   Development keeps the documented fallback with a warning. Regression in `tests/seed-safety.test.ts`.
4. **Stale isolation labels:** scanner audit rows no longer claim `linux-netns-nonroot`; rejected scans record
   `isolation_mode='not-executed'` and the terminal/README/client copy describes the Docker model.
5. **Obsolete installer removed:** `scripts/install-nmap.sh` (which installed a different static nmap to
   `/usr/local/bin`) was deleted; the scanner image installs `/usr/bin/nmap`, which is the configured path.

---

## 8. Changed files

New: `src/server/config.ts`, `src/server/realtime.ts`, `src/workers/lab-docker-backend.ts`,
`src/db/demo-seed.ts`, `migrations/002_pvp_atomicity.sql`, `Dockerfile.lab-scanner`, `Dockerfile.lab-target`,
`scripts/lab-target.mjs`, `scripts/build-lab-images.sh`, `scripts/reap-lab-resources.sh`,
`tests/support/harness.ts`, `tests/{auth-security,command-parser,exploration,lab-docker.integration,lab-mission-flow,lab-policy,ledger,pvp-atomicity,realtime,seed-safety}.test.ts`.

Modified: `src/server/app.ts`, `src/server/index.ts`, `src/server/services/{pvp,ledger,terminal-executor}.ts`,
`src/workers/{outbox-worker,index,lab-runner}.ts`, `src/db/{index,migrate,redis,seed}.ts`, `src/client/App.tsx`,
`docker-compose.yml`, `Dockerfile.api`, `Dockerfile.worker`, `scripts/load-test.ts`, `package.json`,
`.env.example`, `README.md`, `COMPLETION_REPORT.md`, `LOAD_TEST_RESULTS.json`.

Removed: `src/workers/lab-sandbox-child.ts`, `scripts/install-nmap.sh`, `tests/rootwars.test.ts`.

---

## 9. Limitations (not verified in this environment)

1. **Real Docker lab isolation is untested here** (no Docker daemon, no nmap): the live suite is written and
   skip-gated, and it hard-fails under `ROOTWARS_REQUIRE_DOCKER_TESTS=true`. No isolation claim is made from
   this run. Run it on a disposable Docker host.
2. **No multi-instance/real-database load measurement**: the load test ran on PGlite + ioredis-mock with one
   API instance. Cross-instance behaviour is covered functionally by `tests/realtime.test.ts`, not at scale.
3. **PostgreSQL-specific concurrency**: PGlite serializes transactions in-process, so the PvP races here do not
   prove `FOR UPDATE` behaviour under true parallel PostgreSQL sessions. Point `TEST_DATABASE_URL` at PostgreSQL
   (the tests use the same code path) for that proof; row-locking SQL was chosen for PostgreSQL semantics.
4. **Rate limiting**: only the fail-closed path and trusted-proxy spoofing are tested; multi-instance Redis
   counters under load are not.
5. **WebSocket backpressure/slow-consumer handling** (dropping a saturated client) is not implemented or tested.
6. Compose/worker/lab-daemon topology is validated statically (no `docker.sock` in API, required secrets,
   internal lab network, non-root users) but the stack itself was not started here.
7. Windows/macOS hosts and Docker Desktop networking were not exercised; the isolation tests assume a Linux
   Docker host.

## 10. Readiness for review

The review items P1–P4, the security hardening and the production/scale items are implemented and covered by
59 passing automated tests (5 Docker tests skipped with an explicit banner), a clean build, and a repeatable
load-test harness that reports its own environment and limitations. The main outstanding item for a follow-up
review is executing the Docker isolation suite and a PostgreSQL + Redis multi-instance load run on a
disposable host; the instructions to do so are in the README and in this report.
