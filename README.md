# ROOTWARS // Persistent Open-World Hacking MMO

**RootWars** is a playable browser-based open-world hacking MMO with a dark cyber-security desktop interface, a typed command-line terminal, an interconnected regional world grid (24 nodes in the **Neo-Cascadia Autonomous Grid** + 3 nodes in the **Helvetia Quantum Clearing Zone**), dynamic NPC factions, an atomic double-entry fictional currency ledger (`RWC`), hacking groups, alliances, bounded Open PvP, and isolated real-tool **Nmap** lab missions.

> **Branding & Safety Notice**: RootWars uses original RootWars branding and artwork inspired by the general look and feel of dark security desktops. RootWars is an independent fictional game, is **not** affiliated with or endorsed by Kali Linux, does **not** boot an operating system, and **never** exposes a player's computer, home network, or public IP to the game.

---

## 1. Architecture Overview

- **Client (`src/client/`)**: TypeScript + React 19 + Vite desktop environment featuring a top telemetry panel, application launcher, bottom dock, and 7 movable/resizable desktop windows (`rw-term` Terminal open by default, `net-atlas` World Map, `ops-center` Missions & Isolated Labs, `syndicate-hq` Groups/Alliances/Open PvP/Chat, `nexus-market` Equipment & Ledger, `intel-watch` Factions/World Events/Audit Logs, and `sys-config` Settings & Command Manual).
- **API & WebSocket Gateway (`src/server/`)**: Stateless Fastify server (`src/server/app.ts`) providing REST endpoints and `/ws` WebSockets for chat (`#global`, `#group`, `#alliance`), mission alerts, PvP incident alerts, and world updates.
- **Database Layer (`src/db/`, `migrations/001_initial_schema.sql`)**: PostgreSQL 16 as the durable source of truth. Connects via `pg.Pool` when `DATABASE_URL` points to an external PostgreSQL daemon (such as in `docker-compose.yml`), and automatically uses persistent on-disk PostgreSQL 16 (`@electric-sql/pglite` stored in `./.data/pgdata`) when running standalone without a local Docker daemon.
- **Ephemeral State & Rate Limiting (`src/db/redis.ts`)**: Connects to Redis (`REDIS_URL`) via `ioredis` for rate limits (`rl:*`), online presence (`presence:online`), and realtime pub/sub (`rootwars:events`), with automatic fallback to embedded `ioredis-mock` in standalone local environments.
- **Durable Job Outbox & Workers (`src/workers/outbox-worker.ts`, `src/workers/index.ts`)**: PostgreSQL-backed `outbox_jobs` table processing asynchronous NPC faction reactions, dynamic world events, mission timers, node outage recovery, and isolated lab scans.
- **Isolated Real-Tool Lab Runner (`src/workers/lab-runner.ts`, `src/workers/lab-sandbox-child.ts`)**: Executes real `/usr/local/bin/nmap` strictly inside short-lived, disposable Linux network namespaces (`ip netns`) as unprivileged `uid=65534(nobody)` / `gid=65534(nogroup)` with `--no-new-privs` and `prlimit` memory/CPU/process caps against ephemeral `10.240.x.x` mission target listeners.

---

## 2. Quick Start & Exact Run Commands

### Option A: Standalone Local Run (Zero External Daemons Required)

```bash
# 1. Install dependencies
npm install

# 2. Ensure static Nmap binary & service probes are installed (if not already on PATH)
bash scripts/install-nmap.sh

# 3. Run PostgreSQL migrations & seed world data (27 nodes, 9 factions, 8 missions, market, groups)
npm run db:migrate
npm run db:seed

# 4. Build client & start the RootWars server on http://0.0.0.0:3000
npm run build
npm run dev
```

Open `http://localhost:3000` in your browser.
- **Demo Operator Login**: Handle `cipher_wolf` / Passphrase `RootWars!2026` (or register any new operator handle to receive a personal home network node and `2,500 RWC` starting stipend).

### Option B: Docker Compose (Multi-Container Setup)

```bash
docker compose up --build
```

This launches:
- `postgres` (`postgres:16-alpine`)
- `redis` (`redis:7-alpine`)
- `api` (Fastify API + WebSocket + Static Client on port `3000`)
- `lab-worker` (Non-root `65534:65534`, `cap_drop: ALL`, `no-new-privileges:true`, resource-limited worker attached to `internal: true` bridge network `10.240.0.0/16`)
- `lab-target-sovereign` (Isolated `10.240.10.10` lab target container)

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
- `lab open --mission <mission-id>` — Provision an isolated lab target for the specified mission.
- `lab close` — Close and tear down the active lab session.
- `disconnect` — Disconnect from the current in-world network node.
- `pvp attack --target <player-node> --method <probe|heist|disrupt|contest>` — Launch a bounded Open PvP operation against an in-game player network node.
- `defend --action <monitor|patch|segment|decoy|ir|recover>` — Upgrade defenses or recover your personal home node.
- `transfer --to <username> --amount <rwc> [--memo <text>]` — Atomically transfer RWC to another operator.
- `factions` — View NPC faction alert levels, policy stances, tariffs, and security advisories.
- `events` — View recent dynamic regional world events.
- `clear` — Clear terminal output.

### Isolated Lab-Tool Command
- `nmap --profile <quick|service|full-ports|compliance-audit> [--target <10.240.x.x>]`
  - Executes real `/usr/local/bin/nmap` using `execFile` (never a shell) inside a disposable Linux network namespace against your active mission's assigned `10.240.x.x` target.
  - Arbitrary Nmap scripts (`--script`, `-sC`), file writes (`-oN`, `-oX`, `-iL`), spoofing options, and non-lab IPs (`1.1.1.1`, `127.0.0.1`, `192.168.x.x`) are rejected by the parser and server validator.

---

## 4. Lab Safety & Network Isolation Verification

1. **No Shell Evaluation**: `parseTerminalCommand` rejects shell metacharacters, and `lab-sandbox-child.ts` invokes `/usr/bin/prlimit` -> `setpriv` -> `/usr/local/bin/nmap` via `child_process.execFile` with a fixed array of allowlisted arguments from `APPROVED_NMAP_PROFILES`.
2. **Disposable Network Namespace (`ip netns`)**: Each scan creates a fresh `rw-lab-<random>` Linux network namespace with **no external interface and no default route**. Only the single assigned `10.240.x.x/32` mission IP is bound inside the namespace, and the namespace is deleted immediately in a `finally` block (`ip netns del`).
3. **Non-Root & Resource Limited**: Inside the namespace, `setpriv --reuid=65534 --regid=65534 --clear-groups --no-new-privs` drops privileges to `nobody:nogroup`, and `prlimit --as=268435456 --cpu=8 --nproc=32` enforces strict memory, CPU, and process limits.
4. **Automated Isolation Proof (`verifyLabNetworkIsolation`)**:
   - Verified `effectiveUid = 65534` and `effectiveGid = 65534`.
   - Verified outbound TCP connection to public internet (`1.1.1.1:80`) fails immediately with kernel `ENETUNREACH`.
   - Verified outbound TCP connection to host loopback (`127.0.0.1:22`) is isolated and refused.
   - Verified real Nmap scan against assigned lab target (`10.240.99.10`) succeeds and enumerates open ports.

---

## 5. Environment Variables

See `.env.example` for all configurable parameters:

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP & WebSocket listen port |
| `HOST` | `0.0.0.0` | Listen address |
| `DATABASE_URL` | `postgresql://...` | External PostgreSQL URL (falls back to persistent PGlite in `./.data/pgdata` if unreachable) |
| `PGLITE_DATA_DIR` | `./.data/pgdata` | On-disk directory for embedded PostgreSQL 16 engine |
| `REDIS_URL` | `redis://localhost:6379` | Redis URL (falls back to embedded `ioredis-mock` if unreachable) |
| `SESSION_SECRET` | `...` | Cookie signing secret |
| `SESSION_TTL_SECONDS` | `86400` | Session expiration (24 hours) |
| `PVP_MAX_LOSS_BPS` | `1000` | Max RWC loss per PvP heist (1000 bps = 10%) |
| `PVP_DAILY_LOSS_CAP_BPS` | `2000` | Max cumulative 24h RWC loss (2000 bps = 20%) |
| `PVP_MIN_PROTECTED_BALANCE` | `500` | Minimum protected RWC balance floor |
| `PVP_ATTACKER_COOLDOWN_SECONDS` | `60` | Per-attacker PvP cooldown |
| `PVP_TARGET_COOLDOWN_SECONDS` | `120` | Per-target node PvP cooldown |
| `PVP_NEW_PLAYER_SHIELD_MINUTES` | `60` | New-player protection shield duration |

---

## 6. Testing & Load Testing

```bash
# Run the automated Vitest verification suite (14 tests across all 6 required areas)
npm test

# Run the realistic concurrent MMO load test
npm run loadtest
```

### Actual Load-Test Summary (`LOAD_TEST_RESULTS.json`)
- **Tested Environment**: Linux 6.1.158+ x86_64, 2x Intel Xeon vCPU @ 2.60GHz, 3.85 GB RAM, Node.js v22.22.3, PGlite (embedded PostgreSQL 16), Redis-Mock.
- **Concurrent Sessions**: `120` authenticated sessions (`120` open WebSockets; `48` idle presence sessions + `72` active workers executing continuous mixed requests across terminal commands, map reads, mission reads, and chat broadcasts).
- **Total Requests**: `864` HTTP requests + `7,135` SQL queries in `10.54s` (`0` errors, `100%` success).
- **Throughput**: `81.96 req/sec` (`676.87 SQL queries/sec` at `1.24 ms` average query time).
- **Latency Percentiles**: `p50 = 281.25 ms`, `p90 = 381.02 ms`, `p95 = 3012.09 ms`, `p99 = 7898.04 ms`.
- **Bottlenecks & Scaling Path**: Under standalone embedded PGlite, all 72 active workers share a single in-process WASM PostgreSQL connection, saturating DB execution time (`8.85s` of `10.54s`). Deploying with external PostgreSQL (`pg.Pool` with connection pooling + read replicas) and external Redis via `docker-compose.yml` removes single-connection serialization and enables horizontal scaling across multiple stateless Fastify API instances.
