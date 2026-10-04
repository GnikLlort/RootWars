import { DatabaseAdapter, DbClient } from '../../db/index.js';
import { generateId } from '../security.js';
import {
  SYSTEM_MINT_ACCOUNT_ID,
  applyLedgerTransfer,
  getAccountBalance,
  getUserAccountId
} from './ledger.js';

export class PvpError extends Error {
  public readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export interface PvpConfig {
  maxLossBps: number; // default 1000 = 10% per attack
  dailyLossCapBps: number; // default 2000 = 20% max in 24h
  minProtectedBalance: number; // default 500 RWC floor
  attackerCooldownSeconds: number; // default 60s
  targetCooldownSeconds: number; // default 120s
}

export function getPvpConfig(overrides?: Partial<PvpConfig>): PvpConfig {
  return {
    maxLossBps: overrides?.maxLossBps ?? Number(process.env.PVP_MAX_LOSS_BPS ?? 1000),
    dailyLossCapBps: overrides?.dailyLossCapBps ?? Number(process.env.PVP_DAILY_LOSS_CAP_BPS ?? 2000),
    minProtectedBalance:
      overrides?.minProtectedBalance ?? Number(process.env.PVP_MIN_PROTECTED_BALANCE ?? 500),
    attackerCooldownSeconds:
      overrides?.attackerCooldownSeconds ?? Number(process.env.PVP_ATTACKER_COOLDOWN_SECONDS ?? 60),
    targetCooldownSeconds:
      overrides?.targetCooldownSeconds ?? Number(process.env.PVP_TARGET_COOLDOWN_SECONDS ?? 120)
  };
}

export interface PvpAttackInput {
  attackerUserId: string;
  targetNodeIdentifier: string;
  method: 'probe' | 'heist' | 'disrupt' | 'contest';
  /**
   * Client supplied idempotency key. Replaying the same key returns the original
   * incident result instead of executing a second attack.
   */
  requestId?: string;
  configOverrides?: Partial<PvpConfig>;
  /** Test-only escape hatch; never set by HTTP routes. */
  bypassCooldownForTest?: boolean;
}

export interface PvpAttackOutput {
  incidentId: string;
  idempotentReplay: boolean;
  outcome: 'success' | 'partial' | 'repelled' | 'decoys_triggered';
  method: 'probe' | 'heist' | 'disrupt' | 'contest';
  targetNodeId: string;
  targetNodeName: string;
  defenderHandle: string;
  attackScore: number;
  defenseScore: number;
  rwcStolen: number;
  bountyClaimedRwc: number;
  intelExposed: string[];
  nodeStatusAfter: string;
  mitigationApplied: string;
  summary: string;
}

function isUniqueViolation(err: any): boolean {
  const code = err?.code ?? err?.cause?.code;
  return code === '23505' || /unique constraint|duplicate key/i.test(String(err?.message ?? ''));
}

function mapIncidentRow(row: any, replay: boolean): PvpAttackOutput {
  return {
    incidentId: row.id,
    idempotentReplay: replay,
    outcome: row.outcome,
    method: row.operation_method,
    targetNodeId: row.target_node_id,
    targetNodeName: row.target_node_name ?? row.target_node_id,
    defenderHandle: row.defender_handle ?? row.defender_user_id ?? 'unclaimed',
    attackScore: Number(row.attack_score),
    defenseScore: Number(row.defense_score),
    rwcStolen: Number(row.rwc_stolen),
    bountyClaimedRwc: Number(row.bounty_claimed_rwc ?? 0),
    intelExposed: Array.isArray(row.intel_exposed) ? row.intel_exposed : [],
    nodeStatusAfter: row.node_status_after,
    mitigationApplied: row.mitigation_applied ?? '',
    summary: row.summary
  };
}

async function loadIncidentOutput(db: DbClient, incidentId: string, replay: boolean): Promise<PvpAttackOutput | null> {
  const res = await db.query<any>(
    `SELECT p.*, n.name AS target_node_name, n.hostname AS target_node_hostname,
            du.username AS defender_handle
     FROM pvp_incidents p
     LEFT JOIN network_nodes n ON n.id = p.target_node_id
     LEFT JOIN users du ON du.id = p.defender_user_id
     WHERE p.id = $1`,
    [incidentId]
  );
  if (res.rows.length === 0) return null;
  return mapIncidentRow(res.rows[0], replay);
}

/**
 * Executes one Open PvP operation as a single atomic transaction.
 *
 * Concurrency & integrity guarantees:
 *  - The target node row is locked first, then the attacker/defender user rows are
 *    locked in deterministic (lexicographic) order, then ledger accounts are locked
 *    in lexicographic order. Every code path uses the same ordering, so concurrent
 *    attacks cannot deadlock.
 *  - Cooldowns, balances, the 24h loss allowance, node status, bounty state and the
 *    incident record are all evaluated inside the same transaction after locking, so
 *    stale reads cannot let concurrent attackers exceed caps or bypass cooldowns.
 *  - `requestId` is persisted with a unique index; a replayed request returns the
 *    original incident instead of executing again.
 */
export async function executePvpOperation(
  db: DatabaseAdapter,
  input: PvpAttackInput
): Promise<PvpAttackOutput> {
  const cfg = getPvpConfig(input.configOverrides);
  const requestId = input.requestId?.trim() || generateId('pvp');

  try {
    return await db.transaction(async (tx) => {
      // 1. Idempotent replay: return the original result for a repeated request id.
      const replayRes = await tx.query<any>(
        `SELECT id FROM pvp_incidents WHERE idempotency_key = $1`,
        [requestId]
      );
      if (replayRes.rows.length > 0) {
        const replay = await loadIncidentOutput(tx, replayRes.rows[0].id, true);
        if (replay) return replay;
      }

      // 2. Lock the target node first (deterministic lock ordering applies to every path).
      const targetRes = await tx.query<any>(
        `SELECT n.*, u.username as defender_handle, u.new_player_shield_until,
                gm.group_id as defender_group_id, g.alliance_id as defender_alliance_id
         FROM network_nodes n
         LEFT JOIN users u ON u.id = n.owner_user_id
         LEFT JOIN group_members gm ON gm.user_id = n.owner_user_id
         LEFT JOIN groups g ON g.id = gm.group_id
         WHERE n.id = $1 OR LOWER(n.hostname) = LOWER($1) OR n.ip_address = $1
         FOR UPDATE OF n`,
        [input.targetNodeIdentifier]
      );

      if (targetRes.rows.length === 0) {
        throw new PvpError('TARGET_NOT_FOUND', `Target node "${input.targetNodeIdentifier}" not found.`);
      }
      const targetNode = targetRes.rows[0];

      if (targetNode.category !== 'player' || !targetNode.owner_user_id) {
        throw new PvpError(
          'NOT_PLAYER_NODE',
          `Node "${targetNode.name}" is an NPC ${targetNode.category} network. Open PvP operations only target player-owned in-game networks.`
        );
      }

      if (targetNode.owner_user_id === input.attackerUserId) {
        throw new PvpError('SELF_TARGET', 'You cannot launch a PvP attack against your own network node.');
      }

      // 3. Lock the participating user rows in deterministic (lexicographic) order,
      //    then read their current state under those locks.
      await tx.query<any>(
        `SELECT id FROM users WHERE id IN ($1, $2) ORDER BY id FOR UPDATE`,
        [input.attackerUserId, targetNode.owner_user_id]
      );
      const lockedUsers = await tx.query<any>(
        `SELECT u.id, u.username, u.level, u.xp, u.heat, u.new_player_shield_until,
                gm.group_id, g.alliance_id
         FROM users u
         LEFT JOIN group_members gm ON gm.user_id = u.id
         LEFT JOIN groups g ON g.id = gm.group_id
         WHERE u.id IN ($1, $2)
         ORDER BY u.id`,
        [input.attackerUserId, targetNode.owner_user_id]
      );
      const attacker = lockedUsers.rows.find((u) => u.id === input.attackerUserId);
      const defender = lockedUsers.rows.find((u) => u.id === targetNode.owner_user_id);

      if (!attacker) {
        throw new PvpError('ATTACKER_NOT_FOUND', 'Attacker account not found.');
      }
      if (!defender) {
        throw new PvpError('DEFENDER_NOT_FOUND', 'Target node owner account not found.');
      }

      if (attacker.group_id && targetNode.defender_group_id && attacker.group_id === targetNode.defender_group_id) {
        throw new PvpError('FRIENDLY_FIRE_GROUP', 'Target node belongs to a fellow member of your hacking group.');
      }

      if (
        attacker.alliance_id &&
        targetNode.defender_alliance_id &&
        attacker.alliance_id === targetNode.defender_alliance_id
      ) {
        throw new PvpError('FRIENDLY_FIRE_ALLIANCE', 'Target node is protected by your mutual defense alliance pact.');
      }

      const defenderShieldUntil = defender.new_player_shield_until ?? targetNode.new_player_shield_until;
      if (defenderShieldUntil && new Date(defenderShieldUntil).getTime() > Date.now()) {
        throw new PvpError(
          'NEW_PLAYER_PROTECTED',
          `Target operator "${defender.username}" is protected by an active New-Player Shield until ${new Date(
            defenderShieldUntil
          ).toISOString()}.`
        );
      }

      // 4. Cooldowns (evaluated after the user/node locks, so concurrent requests serialize here).
      if (!input.bypassCooldownForTest) {
        if (cfg.attackerCooldownSeconds > 0) {
          const lastAtkRes = await tx.query<{ created_at: string }>(
            `SELECT created_at FROM pvp_incidents
             WHERE attacker_user_id = $1
             ORDER BY created_at DESC LIMIT 1`,
            [attacker.id]
          );
          if (lastAtkRes.rows.length > 0) {
            const elapsedSec = (Date.now() - new Date(lastAtkRes.rows[0].created_at).getTime()) / 1000;
            if (elapsedSec < cfg.attackerCooldownSeconds) {
              const waitSec = Math.ceil(cfg.attackerCooldownSeconds - elapsedSec);
              throw new PvpError(
                'ATTACKER_COOLDOWN',
                `Offensive relay cooling down. Wait ${waitSec}s before launching another PvP operation.`
              );
            }
          }
        }

        if (cfg.targetCooldownSeconds > 0 && targetNode.last_attacked_at) {
          const elapsedTargetSec = (Date.now() - new Date(targetNode.last_attacked_at).getTime()) / 1000;
          if (elapsedTargetSec < cfg.targetCooldownSeconds) {
            const waitSec = Math.ceil(cfg.targetCooldownSeconds - elapsedTargetSec);
            throw new PvpError(
              'TARGET_COOLDOWN',
              `Target node "${targetNode.name}" has temporary post-incident rate protection for another ${waitSec}s.`
            );
          }
        }
      }

      // 5. Score computation uses state read under the same locks.
      const atkItemsRes = await tx.query<{ effects_json: any }>(
        `SELECT m.effects_json
         FROM player_inventory pi
         JOIN market_items m ON m.id = pi.item_id
         WHERE pi.user_id = $1 AND pi.equipped = TRUE`,
        [attacker.id]
      );
      let itemAttackBonus = 0;
      for (const row of atkItemsRes.rows) {
        itemAttackBonus += Number(row.effects_json?.pvp_attack_bonus ?? 0);
      }

      const defItemsRes = await tx.query<{ effects_json: any }>(
        `SELECT m.effects_json
         FROM player_inventory pi
         JOIN market_items m ON m.id = pi.item_id
         WHERE pi.user_id = $1 AND pi.equipped = TRUE`,
        [defender.id]
      );
      let itemDefenseBonus = 0;
      let itemDecoyChance = 0;
      let itemLossReductionBps = 0;
      for (const row of defItemsRes.rows) {
        itemDefenseBonus += Number(row.effects_json?.defense_bonus ?? 0);
        itemDecoyChance += Number(row.effects_json?.decoy_chance ?? 0);
        itemLossReductionBps += Number(row.effects_json?.loss_reduction_bps ?? 0);
      }

      const defCfg = targetNode.defense_config ?? {
        monitoring: 1,
        patching: 1,
        segmentation: 1,
        decoys: 0,
        incident_response: 1,
        recovery: 1
      };

      const mutualDefenseBonus = targetNode.defender_alliance_id ? 8 : 0;

      const attackScore =
        35 + Number(attacker.level) * 5 + itemAttackBonus + (input.method === 'probe' ? 10 : 0);

      const defenseScore =
        Number(targetNode.security_level ?? 35) +
        Math.floor(Number(targetNode.patch_level ?? 50) / 5) +
        Number(defCfg.monitoring ?? 1) * 4 +
        Number(defCfg.patching ?? 1) * 4 +
        Number(defCfg.segmentation ?? 1) * 4 +
        Number(defCfg.incident_response ?? 1) * 3 +
        itemDefenseBonus +
        mutualDefenseBonus;

      const decoyLevel = Number(defCfg.decoys ?? 0);
      const totalDecoyThreshold = decoyLevel * 12 + itemDecoyChance;

      let outcome: 'success' | 'partial' | 'repelled' | 'decoys_triggered' = 'repelled';
      let mitigationApplied = 'Perimeter firewall & IDS rules blocked intrusion.';

      if (decoyLevel >= 3 || (totalDecoyThreshold >= 35 && attackScore < defenseScore + 15)) {
        outcome = 'decoys_triggered';
        mitigationApplied = `Mirage Decoy Honeypots (Lvl ${decoyLevel}) diverted offensive payloads into synthetic sandbox.`;
      } else if (attackScore >= defenseScore) {
        outcome = 'success';
        mitigationApplied =
          Number(defCfg.segmentation ?? 1) > 1
            ? `Micro-segmentation (Lvl ${defCfg.segmentation}) capped lateral exposure.`
            : 'Standard loss cap & protected floor enforced.';
      } else if (attackScore + 12 >= defenseScore) {
        outcome = 'partial';
        mitigationApplied = `IDS Monitoring (Lvl ${defCfg.monitoring ?? 1}) & Patching throttled operation impact by 50%.`;
      }

      const incidentId = generateId('inc');
      let rwcStolen = 0;
      let bountyClaimedRwc = 0;
      let intelExposed: string[] = [];
      let nodeStatusAfter = targetNode.status;

      // 6. Apply all state changes inside this same transaction.
      if (outcome === 'success' || outcome === 'partial') {
        if (input.method === 'probe') {
          const adj: string[] = Array.isArray(targetNode.adjacent_nodes) ? targetNode.adjacent_nodes : [];
          intelExposed = outcome === 'success' ? adj : adj.slice(0, 2);
          for (const nodeId of intelExposed) {
            // FK-safe: never let a stale adjacency reference abort an otherwise
            // successful PvP transaction.
            await tx.query(
              `INSERT INTO player_node_discoveries (user_id, node_id, discovery_source, inspected)
               SELECT $1, n.id, 'scan', FALSE FROM network_nodes n WHERE n.id = $2
               ON CONFLICT (user_id, node_id) DO NOTHING`,
              [attacker.id, nodeId]
            );
          }
        } else if (input.method === 'heist') {
          const defenderAccountId = getUserAccountId(defender.id);
          const attackerAccountId = getUserAccountId(attacker.id);
          const defenderBalance = await getAccountBalance(tx, defenderAccountId);

          // Loss caps: protected floor, per-attack cap (reduced by segmentation), 24h cap.
          const aboveFloor = Math.max(0, defenderBalance - cfg.minProtectedBalance);
          const segmentationReductionBps = Math.min(
            500,
            (Number(defCfg.segmentation ?? 1) - 1) * 150 + itemLossReductionBps
          );
          const effectiveMaxBps = Math.max(100, cfg.maxLossBps - segmentationReductionBps);
          let perAttackMax = Math.floor((defenderBalance * effectiveMaxBps) / 10000);
          if (outcome === 'partial') {
            perAttackMax = Math.floor(perAttackMax * 0.5);
          }

          const recentLossesRes = await tx.query<{ total_lost: string | number }>(
            `SELECT COALESCE(SUM(rwc_stolen), 0) AS total_lost
             FROM pvp_incidents
             WHERE defender_user_id = $1
               AND created_at >= NOW() - INTERVAL '24 hours'`,
            [defender.id]
          );
          const lostLast24h = Number(recentLossesRes.rows[0]?.total_lost ?? 0);
          const referenceBalanceForDailyCap = defenderBalance + lostLast24h;
          const maxDailyTotalLoss = Math.floor((referenceBalanceForDailyCap * cfg.dailyLossCapBps) / 10000);
          const remainingDailyAllowance = Math.max(0, maxDailyTotalLoss - lostLast24h);

          const seizableAmount = Math.max(0, Math.min(aboveFloor, perAttackMax, remainingDailyAllowance));

          if (seizableAmount > 0) {
            await applyLedgerTransfer(tx, {
              idempotencyKey: `pvp-seizure-${incidentId}`,
              fromAccountId: defenderAccountId,
              toAccountId: attackerAccountId,
              amount: seizableAmount,
              txType: 'pvp_seizure',
              referenceId: targetNode.id,
              memo: `PvP heist seizure against ${targetNode.hostname}`,
              metadata: { incidentId, requestId }
            });
            rwcStolen = seizableAmount;
          } else {
            mitigationApplied += ' Defender protected floor / 24h loss cap prevented any RWC seizure.';
          }
        } else if (input.method === 'disrupt') {
          nodeStatusAfter = outcome === 'success' ? 'degraded' : targetNode.status;
        } else if (input.method === 'contest') {
          nodeStatusAfter = outcome === 'success' ? 'contested' : 'degraded';
        }

        // Bounty claim: the conditional UPDATE guarantees a single winner per bounty.
        const openBountyRes = await tx.query<any>(
          `SELECT * FROM bounties
           WHERE target_node_id = $1 AND status = 'open'
           ORDER BY created_at ASC LIMIT 1
           FOR UPDATE`,
          [targetNode.id]
        );
        if (openBountyRes.rows.length > 0 && outcome === 'success') {
          const bounty = openBountyRes.rows[0];
          const claimRes = await tx.query(
            `UPDATE bounties
             SET status = 'claimed', claimed_by_user_id = $1, claimed_at = NOW()
             WHERE id = $2 AND status = 'open'`,
            [attacker.id, bounty.id]
          );
          if (claimRes.rowCount === 1) {
            await applyLedgerTransfer(tx, {
              idempotencyKey: `bounty-payout-${bounty.id}`,
              fromAccountId: SYSTEM_MINT_ACCOUNT_ID,
              toAccountId: getUserAccountId(attacker.id),
              amount: Number(bounty.reward_rwc),
              txType: 'bounty_payout',
              referenceId: bounty.id,
              memo: `Bounty claimed on ${targetNode.hostname}`
            });
            bountyClaimedRwc = Number(bounty.reward_rwc);
          }
        }

        if (attacker.group_id) {
          await tx.query(
            `UPDATE groups
             SET goal_progress = LEAST(goal_target, goal_progress + 1)
             WHERE id = $1`,
            [attacker.group_id]
          );
        }
      }

      // Node bookkeeping + attacker heat/XP + own-shield waiver, all in this transaction.
      await tx.query(
        `UPDATE network_nodes
         SET status = $1,
             contested_by_group_id = CASE
               WHEN $2 = 'contested' THEN $3::text
               WHEN $1 = 'online' THEN NULL
               ELSE contested_by_group_id END,
             outage_until = CASE
               WHEN $1 = 'degraded' THEN NOW() + INTERVAL '10 minutes'
               WHEN $1 IN ('online', 'contested') THEN NULL
               ELSE outage_until END,
             last_attacked_at = NOW()
         WHERE id = $4`,
        [nodeStatusAfter, nodeStatusAfter, attacker.group_id ?? null, targetNode.id]
      );

      await tx.query(
        `UPDATE users
         SET heat = LEAST(100, heat + 6),
             xp = xp + 40,
             new_player_shield_until = CASE
               WHEN new_player_shield_until IS NOT NULL AND new_player_shield_until > NOW() THEN NULL
               ELSE new_player_shield_until END
         WHERE id = $1`,
        [attacker.id]
      );

      const summary = `[PvP ${input.method.toUpperCase()} -> ${outcome.toUpperCase()}] ${
        attacker.username
      } targeted ${targetNode.name} (${targetNode.hostname}) owned by ${defender.username}. Score ${attackScore} vs Defense ${defenseScore}.${
        rwcStolen > 0 ? ` Extracted ${rwcStolen} RWC.` : ''
      }${bountyClaimedRwc > 0 ? ` Claimed ${bountyClaimedRwc} RWC bounty!` : ''}`;

      const inserted = await tx.query<any>(
        `INSERT INTO pvp_incidents (
          id, attacker_user_id, attacker_group_id, defender_user_id, defender_group_id,
          target_node_id, operation_method, outcome, attack_score, defense_score,
          rwc_stolen, bounty_claimed_rwc, intel_exposed, node_status_after, mitigation_applied,
          recovered, summary, idempotency_key
        ) VALUES (
          $1, $2, $3, $4, $5,
          $6, $7, $8, $9, $10,
          $11, $12, $13::jsonb, $14, $15,
          $16, $17, $18
        )
        RETURNING *`,
        [
          incidentId,
          attacker.id,
          attacker.group_id ?? null,
          defender.id,
          targetNode.defender_group_id ?? null,
          targetNode.id,
          input.method,
          outcome,
          attackScore,
          defenseScore,
          rwcStolen,
          bountyClaimedRwc,
          JSON.stringify(intelExposed),
          nodeStatusAfter,
          mitigationApplied,
          nodeStatusAfter === 'online',
          summary,
          requestId
        ]
      );

      return mapIncidentRow(
        {
          ...inserted.rows[0],
          target_node_name: targetNode.name,
          defender_handle: defender.username
        },
        false
      );
    });
  } catch (err: any) {
    // A concurrent duplicate request lost the race on the unique idempotency index:
    // return the winner's result instead of surfacing a constraint error.
    if (isUniqueViolation(err)) {
      const existing = await db.query<any>(
        `SELECT id FROM pvp_incidents WHERE idempotency_key = $1`,
        [requestId]
      );
      if (existing.rows.length > 0) {
        const replay = await loadIncidentOutput(db, existing.rows[0].id, true);
        if (replay) return replay;
      }
    }
    throw err;
  }
}

export async function executeDefenseAction(
  db: DatabaseAdapter,
  userId: string,
  action: 'monitor' | 'patch' | 'segment' | 'decoy' | 'ir' | 'recover'
): Promise<{
  nodeId: string;
  action: string;
  costRwc: number;
  updatedNode: any;
  message: string;
}> {
  const costMap: Record<typeof action, number> = {
    monitor: 200,
    patch: 250,
    segment: 300,
    decoy: 350,
    ir: 150,
    recover: 100
  };
  const costRwc = costMap[action];

  return await db.transaction(async (tx) => {
    const lockedUser = await tx.query<any>(`SELECT id FROM users WHERE id = $1 FOR UPDATE`, [userId]);
    if (lockedUser.rows.length === 0) {
      throw new PvpError('USER_NOT_FOUND', 'Operator not found.');
    }
    const user = await tx.query<any>(`SELECT * FROM users WHERE id = $1`, [userId]);
    const userRow = user.rows[0];

    const nodeRes = await tx.query<any>(
      `SELECT * FROM network_nodes
       WHERE id = $1 OR owner_user_id = $2
       ORDER BY created_at ASC LIMIT 1
       FOR UPDATE`,
      [userRow.home_node_id, userId]
    );
    if (nodeRes.rows.length === 0) {
      throw new PvpError('HOME_NODE_NOT_FOUND', 'No personal network node found for operator.');
    }
    const node = nodeRes.rows[0];

    await applyLedgerTransfer(tx, {
      idempotencyKey: `defend-${userId}-${node.id}-${action}-${Date.now()}`,
      fromAccountId: getUserAccountId(userId),
      toAccountId: SYSTEM_MINT_ACCOUNT_ID,
      amount: costRwc,
      txType: 'recovery_cost',
      referenceId: node.id,
      memo: `Node defense upgrade: ${action}`
    });

    const defCfg = {
      monitoring: 1,
      patching: 1,
      segmentation: 1,
      decoys: 0,
      incident_response: 1,
      recovery: 1,
      ...(node.defense_config ?? {})
    };

    let newSec = Number(node.security_level);
    let newPatch = Number(node.patch_level);
    let newStatus = node.status;
    let message = '';

    switch (action) {
      case 'monitor':
        defCfg.monitoring = Math.min(5, Number(defCfg.monitoring) + 1);
        newSec = Math.min(95, newSec + 3);
        message = `Upgraded IDS Monitoring to Level ${defCfg.monitoring} on ${node.hostname}.`;
        break;
      case 'patch':
        defCfg.patching = Math.min(5, Number(defCfg.patching) + 1);
        newPatch = Math.min(100, newPatch + 10);
        newSec = Math.min(95, newSec + 4);
        message = `Applied kernel & service patches on ${node.hostname}. Patch level is now ${newPatch}%.`;
        break;
      case 'segment':
        defCfg.segmentation = Math.min(5, Number(defCfg.segmentation) + 1);
        newSec = Math.min(95, newSec + 4);
        message = `Tightened Zero-Trust Micro-Segmentation to Level ${defCfg.segmentation}, reducing PvP RWC loss exposure.`;
        break;
      case 'decoy':
        defCfg.decoys = Math.min(5, Number(defCfg.decoys) + 1);
        message = `Deployed Mirage Honeypot Decoys (Level ${defCfg.decoys}) on ${node.hostname}.`;
        break;
      case 'ir':
        defCfg.incident_response = Math.min(5, Number(defCfg.incident_response) + 1);
        await tx.query(`UPDATE users SET heat = GREATEST(0, heat - 10) WHERE id = $1`, [userId]);
        message = `Executed Incident Response playbooks on ${node.hostname}; rotated keys and reduced trace heat.`;
        break;
      case 'recover':
        defCfg.recovery = Math.min(5, Number(defCfg.recovery) + 1);
        newStatus = 'online';
        await tx.query(
          `UPDATE pvp_incidents SET recovered = TRUE WHERE target_node_id = $1 AND recovered = FALSE`,
          [node.id]
        );
        message = `Restored ${node.hostname} from clean snapshot to ONLINE status and cleared contested flags.`;
        break;
    }

    const updated = await tx.query<any>(
      `UPDATE network_nodes
       SET security_level = $1,
           patch_level = $2,
           status = $3,
           contested_by_group_id = CASE WHEN $3 = 'online' THEN NULL ELSE contested_by_group_id END,
           outage_until = CASE WHEN $3 = 'online' THEN NULL ELSE outage_until END,
           defense_config = $4::jsonb
       WHERE id = $5
       RETURNING *`,
      [newSec, newPatch, newStatus, JSON.stringify(defCfg), node.id]
    );

    return {
      nodeId: node.id,
      action,
      costRwc,
      updatedNode: updated.rows[0],
      message
    };
  });
}
