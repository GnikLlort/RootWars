# ROOTWARS // Persistent Open-World Hacking MMO

**RootWars** is a playable browser-based open-world hacking MMO with a dark cyber-security desktop interface, a typed command-line terminal, an interconnected regional world grid (24 nodes in the **Neo-Cascadia Autonomous Grid** + 3 nodes in the **Helvetia Quantum Clearing Zone**), dynamic NPC factions, an atomic double-entry fictional currency ledger (`RWC`), hacking groups, alliances, bounded Open PvP, and isolated real-tool **Nmap** lab missions.

> **Branding & Safety Notice**: RootWars uses original RootWars branding and artwork inspired by the general look and feel of dark security desktops. RootWars is an independent fictional game, is **not** affiliated with or endorsed by Kali Linux, does **not** boot an operating system, and **never** exposes a player's computer, home network, or public IP to the game. Real `nmap` is executed only inside short-lived disposable containers against RootWars-owned lab targets.

---

## 1. Architecture Overview

- **Client (`src/client/`)**: TypeScript + React 19 + Vite desktop environment with 7 movable/resizable windows (`rw-term`, `net-atlas`, `ops-center`, `syndicate-hq`, `nexus-market`, `intel-watch`, `sys-config`). Sessions are carried by an **HttpOnly `rw_session` cookie**; the client never stores a token in `localStorage` or puts one in a WebSocket URL.
- **API & WebSocket Gateway (`src/server/app.ts`, `src/server/realtime.ts`)**: Fastify server exposing REST endpoints and `/ws`. CORS uses an explicit origin allowlist, `trustProxy` is opt-in, and the WebSocket handshake is authenticated from the session cookie and validated against the allowlisted origin.
- **Realtime delivery (`src/server/realtime.ts`)**: every gateway instance subscribes to the Redis `rootwars:events` channel and fans published events out to **local** sockets only (no republish loops). Group/alliance/user channel membership is re-checked from the database per delivery, so membership changes apply to already-connected WebSockets.
- **Database Layer (`src/db/`, `migrations/`)**: PostgreSQL 16 via `pg.Pool` when `DATABASE_URL` is set, or embedded PGlite (`./.data/pgdata`) for standalone local development. PvP, bounty and ledger writes are single atomic transactions with idempotency keys (see `migrations/002_pvp_atomicity.sql`).
- **Rate limiting & sessions (`src/db/redis.ts`, `src/server/app.ts`)**: Redis-backed counters (`rl:*`), `presence:online`, and pub/sub. If the Redis backend is unreachable the API **fails closed** (`RATE_LIMIT_FAIL_MODE=closed`, the default) instead of silently disabling limits.
- **Durable Job Outbox & Workers (`src/workers/outbox-worker.ts`, `src/workers/index.ts`)**: PostgreSQL-backed `outbox_jobs` table processing NPC faction reactions, world events, mission timers, node recovery, **and lab scans**. Only processes with a worker role start the loop, so scaling API instances never duplicates world/outbox workers.
- **Isolated Real-Tool Lab Runner (`src/workers/lab-docker-backend.ts`, `src/workers/lab-runner.ts`)**: the API process enqueues a `lab_scan` job; the worker executes real `nmap` (`/usr/bin/nmap`, fixed path, `execFile` without a shell) inside a hardened container attached to a **per-mission internal-only Docker network**, against a disposable RootWars-owned target container bound to the mission's assigned `10.240.x.x` address. If no dedicated lab Docker endpoint is configured the scan **fails closed** with `LAB_BACKEND_UNAVAILABLE` and no mission credit — it never scans a loopback emulator and pretends that was the mission target.

---

## 2. Quick Start & Exact Run Commands

### Option A: Standalone Local Run (no external daemons, no Docker)

```bash
# 1. Install dependencies
npm install

# 2. Create the schema and the world data (no accounts, no demo credentials)
npm run db:migrate
npm run db:seed

# 3. OPTIONAL: create local demo accounts with a one-time generated password.
#    The password is printed once and is never stored in the repo or in a default.
npm run db:demo-seed

# 4. Build the client and start the server on http://0.0.0.0:3000
npm run build
npm run dev
```

Open `http://localhost:3000` and register a new operator handle (new operators receive a personal home node and a `2,500 RWC` starting stipend). There is **no shared demo password** in a deployed instance: demo accounts exist only if a local administrator runs `npm run db:demo-seed` and keeps the generated password.

Lab missions in this mode will fail closed (`LAB_BACKEND_UNAVAILABLE`) because there is no dedicated lab Docker endpoint; that is intentional and reported in the terminal output.

### Option B: Docker Compose (multi-container)

```bash
export SESSION_SECRET="$(openssl rand -hex 32)"
export POSTGRES_PASSWORD="$(openssl rand -hex 16)"
export ALLOWED_ORIGINS="https://your-host.example"

# Build the lab images once (scanner = alpine + /usr/bin/nmap, target = service emulator)
bash scripts/build-lab-images.sh

docker compose up --build
```

This launches `postgres`, `redis`, `api` (`ROLE=api`, compiled production server, **no Docker socket, non-root**), `lab-worker` (`ROLE=worker`, non-root `65534:65534`, `cap_drop: ALL`, `no-new-privileges`, resource-limited) and `lab-dind` (a dedicated Docker daemon used exclusively for disposable lab containers, reachable only from the worker over the internal `lab_control_net`). The API and worker refuse to start in production without `SESSION_SECRET`, `POSTGRES_PASSWORD`, `ALLOWED_ORIGINS` and `REDIS_URL`, and refuse known development secrets.

Leftover lab resources can always be removed with `LAB_DOCKER_HOST=tcp://localhost:2375 bash scripts/reap-lab-resources.sh`.

---

## 3. Terminal Commands Reference

RootWars uses a strict typed command parser (`src/shared/commandParser.ts`) that rejects shell metacharacters (`;`, `|`, `&`, `` ` ``, `$`, `>`, `<`) and separates **Ordinary MMO Commands** from **Allowed Lab-Tool Commands**.

### Ordinary MMO Commands
- `help [command]` — Show command syntax and examples.
- `status` — Show operator telemetry, RWC balance, heat level, connected node, and active lab status.
- `map [--region <neo-cascadia|helvetia-haven>]` — List discovered nodes in a region.
- `connect --target <node-id|hostname|ip>` — Connect terminal to an in-world network node.
- `inspect --target <node-id|hostname|ip>` — Inspect node posture/services and discover adjacent nodes.
- `scan [--target <node-id>]` — Sweep topology from current/target node to reveal hidden neighbors.
- `jobs` — List available world contracts and isolated Lab Missions.
- `accept --job <job-id|code>` — Accept a mission (e.g. `accept --job msn-lab-01`).
- `lab list` — List all isolated `10.240.x.x` real-tool lab missions.
- `lab open --mission <mission-id>` — Provision the isolated lab target for the specified mission.
- `lab close` — Close and tear down the active lab session.
- `disconnect` — Disconnect from the current in-world network node.
- `pvp attack --target <player-node> --method <probe|heist|disrupt|contest>` — Launch a bounded Open PvP operation (atomic + idempotent; cooldowns, per-attack and 24h loss caps enforced).
- `defend --action <monitor|patch|segment|decoy|ir|recover>` — Upgrade defenses or recover your personal home node.
- `transfer --to <username> --amount <rwc> [--memo <text>]` — Atomically transfer RWC to another operator.
- `factions` — View NPC faction alert levels, policy stances, tariffs, and security advisories.
- `events` — View recent dynamic regional world events.
- `clear` — Clear terminal output.

### Isolated Lab-Tool Command
- `nmap --profile <quick|service|full-ports|compliance-audit> [--target <10.240.x.x>]`
  - Queues a real `nmap` run (`/usr/bin/nmap`, fixed path, `execFile` never a shell) inside a hardened scanner container on the active mission's internal-only lab network.
  - Only the mission-assigned address is accepted. Arbitrary Nmap scripts (`--script`, `-sC`), file writes (`-oN`, `-oX`, `-iL`), spoofing options, and non-lab addresses (`1.1.1.1`, `127.0.0.1`, `192.168.x.x`) are rejected by the parser and re-validated by the server before any container starts.

---

## 4. Lab Safety & Isolation (what is enforced, and what is not verified here)

Enforced by construction (`src/workers/lab-docker-backend.ts`):

1. **Per-mission disposable network**: `docker network create --driver bridge --internal --subnet 10.240.<mission>.0/24` labelled `rootwars.disposable=true`. `--internal` removes the gateway, so there is no route to the public internet or the host.
2. **RootWars-owned target only**: a disposable target container is created per scan with `--ip <mission-assigned address>`, `--user 65534:65534`, `--read-only`, `--cap-drop ALL`, `--security-opt no-new-privileges`, `--pids-limit`, `--memory`, `--memory-swap`, `--cpus` and a `noexec,nosuid` tmpfs. The player can never provide the target address.
3. **Hardened scanner**: `--user 65534:65534`, `--read-only`, `--cap-drop ALL`, `--security-opt no-new-privileges`, pids/memory/CPU limits, `nofile`/`fsize` ulimits, `maxBuffer` + timeout on the `execFile` call, and a fixed allowlisted argument vector from `APPROVED_NMAP_PROFILES`.
4. **API process never runs lab tools**: the API enqueues a durable `lab_scan` outbox job and polls for the result. The API container has no Docker socket; the scan runs in the worker against a dedicated lab Docker daemon (in Compose: `lab-dind`, internal-only).
5. **Fail closed**: without a dedicated endpoint (`LAB_DOCKER_HOST`) the backend reports `LAB_BACKEND_UNAVAILABLE`, records `isolation_mode='unavailable'` in `tool_audit_logs`, discovers zero ports, and awards no mission progress (verified by `tests/lab-mission-flow.test.ts`).
6. **Teardown on every path**: the mission network, target container and scanner container are removed in a `finally` block, and `scripts/reap-lab-resources.sh` reaps anything left behind by a hard kill.

**Verification status (do not overstate):** `tests/lab-docker.integration.test.ts` is the only suite that exercises a real Docker daemon and real networks; it asserts the approved target is reachable, another mission's target is unroutable, `1.1.1.1`/`127.0.0.1` are unreachable, `ip route` has no `default`, the scanner runs as `uid=65534`, and no labelled containers/networks are left behind. In environments without Docker (including the sandbox used for the last review run) that suite is **skipped with a loud banner** and this document makes **no isolation claim from that run**. Run it in a disposable Docker host with:

```bash
bash scripts/build-lab-images.sh
ROOTWARS_REQUIRE_DOCKER_TESTS=true ROOTWARS_BUILD_LAB_IMAGES=true npx vitest run tests/lab-docker.integration.test.ts
```

`ROOTWARS_REQUIRE_DOCKER_TESTS=true` turns the skip into a hard failure, so CI can require real isolation rather than silently passing.

---

## 5. Environment Variables

See `.env.example` for the full list. Security-relevant values:

| Variable | Default | Description |
|---|---|---|
| `NODE_ENV` | `development` | `production` enables cookie `Secure`, disables dev fallbacks and enforces the startup guards |
| `SESSION_SECRET` | dev-only fallback | **Required in production**, ≥32 chars, must not be a known development secret |
| `ALLOWED_ORIGINS` | localhost dev origins | **Required in production**; comma-separated CORS/WebSocket origin allowlist |
| `TRUST_PROXY` | unset | Explicit trusted proxy list (`false`/IP(s)); `true` is rejected in production |
| `RATE_LIMIT_FAIL_MODE` | `closed` | On Redis failure auth/command/chat fail closed (503); `open` is rejected in production |
| `COOKIE_SECURE` | follows `NODE_ENV` | Force `Secure` cookies outside production (e.g. behind TLS-terminating proxies) |
| `DATABASE_URL` | *(PGlite)* | PostgreSQL URL; production requires a non-default password |
| `REDIS_URL` | *(ioredis-mock)* | **Required in production** for rate limits, presence and cross-instance realtime |
| `ROLE` | `all` | `api` or `worker`; only worker roles start the outbox/world loop |
| `LAB_DOCKER_HOST` | unset | Dedicated lab Docker endpoint (e.g. `tcp://lab-dind:2375`); unset ⇒ lab scans fail closed |
| `LAB_ALLOW_HOST_DOCKER` | `false` | Development-only escape hatch to use the local Docker socket; rejected in production |
| `LAB_NMAP_PATH` / `LAB_NMAP_DATADIR` | `/usr/bin/nmap` / `/usr/share/nmap` | Fixed binary path inside the scanner image |
| `LAB_SCANNER_IMAGE` / `LAB_TARGET_IMAGE` | `rootwars/lab-scanner:1.0.0` / `rootwars/lab-target:1.0.0` | Lab images |
| `PVP_MAX_LOSS_BPS` | `1000` | Max RWC loss per PvP heist (1000 bps = 10%) |
| `PVP_DAILY_LOSS_CAP_BPS` | `2000` | Max cumulative 24h RWC loss (2000 bps = 20%) |
| `PVP_MIN_PROTECTED_BALANCE` | `500` | Minimum protected RWC balance floor |
| `PVP_ATTACKER_COOLDOWN_SECONDS` | `60` | Per-attacker PvP cooldown |
| `PVP_TARGET_COOLDOWN_SECONDS` | `120` | Per-target node PvP cooldown |
| `PVP_NEW_PLAYER_SHIELD_MINUTES` | `60` | New-player protection shield duration |

---

## 6. Testing & Load Testing

```bash
# Full typecheck (client, server, scripts, tests)
npx tsc --noEmit -p tsconfig.json

# Automated Vitest suite (unit + integration; Docker lab isolation tests skip loudly
# without a Docker daemon, and fail hard with ROOTWARS_REQUIRE_DOCKER_TESTS=true)
npm test

# Repeatable load test (embedded backends by default; see section below for a real stack)
npm run loadtest
```

Test inventory (see `COMPLETION_REPORT.md` for exact run results):

| Suite | Kind | Covers |
|---|---|---|
| `tests/command-parser.test.ts` | unit | typed parser, shell-metacharacter rejection, lab-target allowlisting |
| `tests/lab-policy.test.ts` | unit | lab target/profile/service validation, fail-closed backend, nmap output parsing |
| `tests/lab-mission-flow.test.ts` | integration | accept → `lab open` → assigned-target fail-closed scan → audit trail, no credit |
| `tests/pvp-atomicity.test.ts` | integration | concurrent attacks, daily cap, bounty race, idempotent replay, mid-operation rollback, protected floor |
| `tests/ledger.test.ts` | integration | idempotent transfers, overdraft protection under 15 concurrent transfers |
| `tests/realtime.test.ts` | integration | two simulated gateways, cross-instance delivery, membership changes, no duplicates |
| `tests/auth-security.test.ts` | integration | HttpOnly cookies, WS origin/cookie auth, CORS, admin-only world events, fail-closed limits, trusted proxy |
| `tests/seed-safety.test.ts` | unit | no demo accounts from a plain seed, production secret guards, deploy config regressions |
| `tests/lab-docker.integration.test.ts` | integration (Docker) | real container/network isolation, skipped without Docker |

### Load test (`scripts/load-test.ts`)

The load test is repeatable and self-describing: it reports the environment and backend it actually ran against, a gradual concurrency ramp, p50/p90/p95/p99 latency, error counts by category and status, DB pool saturation, outbox queue depth/lag, and WebSocket delivery counts. It also records what the run does **not** prove.

```bash
# Embedded backends (fast smoke benchmark; single serialized PGlite connection)
npm run loadtest

# Representative measurement: real PostgreSQL + Redis and 3 API instances
LOADTEST_DATABASE_URL=postgresql://rootwars:<pw>@localhost:5432/rootwars \
LOADTEST_REDIS_URL=redis://localhost:6379 \
LOADTEST_INSTANCES=3 \
LOADTEST_MAX_SESSIONS=120 \
npm run loadtest
```

Results are written to `LOAD_TEST_RESULTS.json`. The current report is the embedded-backend run performed in this review sandbox; it is **not** evidence of thousands of concurrent players, and it says so in `claimsNotSupportedByThisRun`.
