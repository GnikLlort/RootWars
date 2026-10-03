# ROOTWARS // Completion & Verification Report

## 1. What Works (Verified Vertical Slice & Full Feature Set)

1. **Account Registration, Login, Logout & Persistent Character State**:
   - `scrypt` password hashing with random 16-byte salts and `crypto.timingSafeEqual` verification (`src/server/security.ts`).
   - Expiring sessions stored in PostgreSQL `sessions` table (`SHA-256` token hash) with `HttpOnly` cookies, bearer token support, and immediate session revocation on logout.
   - Automatic provisioning of a personal player-owned network bastion (`node-player-<handle>`), initial `2,500 RWC` stipend, and configurable 60-minute New-Player Shield.

2. **RootWars Browser Desktop Experience (`src/client/`)**:
   - Dark security-inspired browser desktop with blue accents, top telemetry status panel, application launcher menu, bottom taskbar dock, notifications drawer, and **Operator Terminal (`rw-term`) open by default**.
   - 7 movable, resizable, minimizable, maximizable desktop windows (`rw-term`, `net-atlas`, `ops-center`, `syndicate-hq`, `nexus-market`, `intel-watch`, `sys-config`) with responsive mobile adaptations and quick-action command chips.
   - Original RootWars SVG crest (`RootWarsCrest.tsx`) and explicit non-Kali disclaimer.

3. **Typed Terminal Command Parser (`src/shared/commandParser.ts` & `src/server/services/terminal-executor.ts`)**:
   - Strict separation between `ordinary` MMO commands (`help`, `status`, `map`, `connect`, `inspect`, `scan`, `jobs`, `accept`, `lab list`, `lab open`, `lab close`, `disconnect`, `pvp attack`, `defend`, `transfer`, `factions`, `events`, `clear`) and `lab_tool` commands (`nmap`).
   - Tab autocomplete, Up/Down command history, and strict rejection of shell metacharacters (`SHELL_METACHARACTER_REJECTED`).

4. **Real Nmap Execution in Isolated Lab Environments (`src/workers/lab-runner.ts`, `src/workers/lab-sandbox-child.ts`)**:
   - 5 seeded isolated Lab Missions (`LAB-01` through `LAB-05`) + 3 in-world operations (`OPS-01` through `OPS-03`).
   - Real `/usr/local/bin/nmap` runs inside short-lived, disposable Linux network namespaces (`ip netns`) as non-root `uid=65534(nobody)` / `gid=65534(nogroup)` with `--no-new-privs` and `prlimit` memory/CPU/process caps (`--as=268435456 --cpu=8 --nproc=32`).
   - Allowlisted Nmap profiles (`quick`, `service`, `full-ports`, `compliance-audit`) invoked via `execFile` (no shell).
   - Every tool execution is recorded in `tool_audit_logs` and parsed into mission progress and atomic RWC/XP rewards.

5. **World Map, Gradual Discovery & Dynamic NPC Factions (`src/db/seed.ts`, `src/server/services/world-factions.ts`)**:
   - 24 seeded nodes in `neo-cascadia` across Government, Banking, Exchange, Corporate, Media, Logistics, Infrastructure, Security Agency, Criminal Syndicate, and Player categories + 3 nodes in expansion region `helvetia-haven` (27 nodes total).
   - Gradual fog-of-war discovery (`player_node_discoveries`) as players inspect or scan nodes.
   - 9 NPC factions that dynamically react to player activity (`investigating`, `patching`, `changing_policies`, `changing_prices`, `issuing_advisories`, `freezing_accounts`, `offering_contracts`, `negotiating`) and 7 dynamic world event types (`election`, `sanction`, `leak`, `market_shock`, `strike`, `outage`, `security_incident`).

6. **Transactional Double-Entry Ledger & Economy (`src/server/services/ledger.ts`)**:
   - Fictional `RWC` currency only; zero real payment or crypto integrations.
   - Atomic PostgreSQL transactions with `idempotency_key UNIQUE`, deterministic account locking (`SELECT ... ORDER BY id FOR UPDATE`), and `CHECK (balance >= 0)` constraint.

7. **Open PvP, Hacking Groups, Alliances & Bounties (`src/server/services/pvp.ts`)**:
   - Hacking groups with roles (`leader`, `officer`, `operator`, `recruit`), group treasury, shared goals, and `#group` chat.
   - Alliances with configurable permissions (`share_intel`, `mutual_defense`, `coordinated_ops`) and `#alliance` chat.
   - Diplomacy stances (`allied`, `non_aggression`, `rivalry`, `war`) and bounty escrow/payouts.
   - Configurable Open PvP safeguards: per-attack loss cap (`10%`), 24-hour cumulative loss cap (`20%`), minimum protected balance floor (`500 RWC`), attacker/target cooldowns, New-Player Shield, node defense upgrades (`monitoring`, `patching`, `segmentation`, `decoys`, `ir`, `recover`), and auditable `pvp_incidents` history.

---

## 2. Actual Automated Test Results (`npm test`)

Executed via `vitest run` (`tests/rootwars.test.ts`):
- **Total Test Suites**: 1 passed (6 describe blocks, **14 tests passed**, 0 failed, duration `6.39s`).
- Verified:
  1. `separates ordinary RootWars commands from allowed lab-tool commands` (PASS)
  2. `strictly rejects shell metacharacters and command injection attempts` (PASS)
  3. `rejects unapproved Nmap profiles, scripts, file outputs, and raw flags` (PASS)
  4. `rejects public internet IPs, localhost, and non-lab private subnets` (PASS)
  5. `proves lab worker runs as non-root (65534), blocks internet/host loopback, and scans assigned lab target` (PASS — `effectiveUid: 65534`, `publicInternetBlocked: true (ENETUNREACH)`, `hostLoopbackIsolated: true`, `assignedLabTargetReachable: true`, `discoveredAssignedPorts: [22, 80]`)
  6. `blocks unauthenticated access to protected endpoints` (PASS)
  7. `registers a new operator, provisions home node and 2,500 RWC starting balance` (PASS)
  8. `completes an isolated Lab Mission using real Nmap and credits reward atomically` (PASS)
  9. `revokes session on logout and denies subsequent requests` (PASS)
  10. `enforces idempotency so duplicate idempotencyKeys never double-transfer` (PASS)
  11. `prevents overdrafts and race conditions under 15 concurrent parallel transfers` (PASS — 5 succeeded, 10 rejected with `INSUFFICIENT_FUNDS`, exact balance conservation)
  12. `blocks PvP attacks against operators with active New-Player Shield` (PASS)
  13. `enforces per-attack loss cap (10%), 24h cumulative loss cap (20%), and 500 RWC minimum protected floor` (PASS)
  14. `enforces attacker cooldown when launching back-to-back PvP operations` (PASS)

---

## 3. Actual Load-Test Results (`npm run loadtest`)

Executed via `tsx scripts/load-test.ts` (saved in `LOAD_TEST_RESULTS.json`):

| Metric | Measured Value |
|---|---|
| **Platform / OS** | `Linux 6.1.158+ (x64)` |
| **CPU / Memory** | `2x Intel(R) Xeon(R) Processor @ 2.60GHz` / `3.85 GB RAM` |
| **Runtime & Backends** | `Node.js v22.22.3`, `pglite` (PostgreSQL 16 engine), `redis-mock` |
| **Concurrent Sessions** | `120` (`120` connected WebSockets; `48` idle + `72` active continuous workers) |
| **Total HTTP Requests** | `864` (`864` succeeded, `0` failed) |
| **Duration** | `10.54 seconds` |
| **Request Throughput** | `81.96 req/sec` |
| **Latency Percentiles** | `p50: 281.25 ms` \| `p90: 381.02 ms` \| `p95: 3012.09 ms` \| `p99: 7898.04 ms` |
| **Database Load** | `7,135` SQL queries (`676.87 queries/sec`, `1.24 ms` avg query latency) |

### Bottleneck Analysis
1. **Single-Connection Embedded PGlite Under Heavy Write Contention**: In standalone sandbox mode without an external PostgreSQL daemon, `@electric-sql/pglite` executes all SQL queries on a single in-process WASM connection (`8.85s` of total DB time out of `10.54s` wall clock), which causes tail-latency queuing (`p95`/`p99`) when 72 active workers fire zero-think-time write commands simultaneously. Connecting `src/db/index.ts` to an external `postgres:16` server via `DATABASE_URL` (which switches automatically to `pg.Pool` with 25 parallel connections) eliminates single-connection serialization.
2. **Authentication Burst CPU (`scrypt`)**: Simultaneous registration/login bursts are CPU-bound on 2 vCPUs (~35ms per `scrypt` derivation).
3. **Lab Namespace Spawn Overhead**: Each real Nmap execution inside `ip netns` takes ~180–350ms and should be scaled horizontally on dedicated `lab-worker` nodes.

---

## 4. Known Limitations & Environmental Notes

- **Container Daemon vs Kernel Network Namespaces**: In this sandbox environment, a Docker daemon (`dockerd`) is not running; therefore, `docker-compose.yml`, `Dockerfile.api`, and `Dockerfile.worker` are provided for standard Docker hosts, while live runtime isolation in this environment is enforced natively by the Linux kernel via `ip netns` + `setpriv` (`uid=65534`, `--no-new-privs`) + `prlimit`.
- **Standalone Database & Redis Persistence**: When external `postgresql` and `redis-server` daemons are not running on `localhost:5432` / `localhost:6379`, the server automatically persists all PostgreSQL 16 tables on disk in `./.data/pgdata` via `@electric-sql/pglite` and uses `ioredis-mock` in memory.
- **Additional Tools Beyond Nmap**: Only `nmap` is enabled on the lab tool allowlist in this MVP pass; the `validateLabToolRequest` and `LabScanRequest` interfaces in `src/workers/lab-runner.ts` provide the extension point for adding future bounded tools.
