import { DatabaseAdapter } from '../../db/index.js';
import { generateId } from '../security.js';
import {
  executeLedgerTransfer,
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
  configOverrides?: Partial<PvpConfig>;
  bypassCooldownForTest?: boolean;
}

export interface PvpAttackOutput {
  incidentId: string;
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

export async function executePvpOperation(
  db: DatabaseAdapter,
  input: PvpAttackInput
): Promise<PvpAttackOutput> {
  const cfg = getPvpConfig(input.configOverrides);

  // 1. Load attacker profile & group/alliance
  const attackerRes = await db.query<any>(
    `SELECT u.*, gm.group_id, g.alliance_id
     FROM users u
     LEFT JOIN group_members gm ON gm.user_id = u.id
     LEFT JOIN groups g ON g.id = gm.group_id
     WHERE u.id = $1`,
    [input.attackerUserId]
  );
  if (attackerRes.rows.length === 0) {
    throw new PvpError('ATTACKER_NOT_FOUND', 'Attacker account not found.');
  }
  const attacker = attackerRes.rows[0];

  // 2. Resolve target node (must be a player-owned in-game network node)
  const targetRes = await db.query<any>(
    `SELECT n.*, u.username as defender_handle, u.new_player_shield_until,
            gm.group_id as defender_group_id, g.alliance_id as defender_alliance_id
     FROM network_nodes n
     LEFT JOIN users u ON u.id = n.owner_user_id
     LEFT JOIN group_members gm ON gm.user_id = n.owner_user_id
     LEFT JOIN groups g ON g.id = gm.group_id
     WHERE n.id = $1 OR LOWER(n.hostname) = LOWER($1) OR n.ip_address = $1`,
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

  if (targetNode.owner_user_id === attacker.id) {
    throw new PvpError('SELF_TARGET', 'You cannot launch a PvP attack against your own network node.');
  }

  if (
    attacker.group_id &&
    targetNode.defender_group_id &&
    attacker.group_id === targetNode.defender_group_id
  ) {
    throw new PvpError('FRIENDLY_FIRE_GROUP', 'Target node belongs to a fellow member of your hacking group.');
  }

  if (
    attacker.alliance_id &&
    targetNode.defender_alliance_id &&
    attacker.alliance_id === targetNode.defender_alliance_id
  ) {
    throw new PvpError('FRIENDLY_FIRE_ALLIANCE', 'Target node is protected by your mutual defense alliance pact.');
  }

  // 3. Check New-Player Protection Shield on defender
  if (
    targetNode.new_player_shield_until &&
    new Date(targetNode.new_player_shield_until).getTime() > Date.now()
  ) {
    throw new PvpError(
      'NEW_PLAYER_PROTECTED',
      `Target operator "${targetNode.defender_handle}" is protected by an active New-Player Shield until ${new Date(
        targetNode.new_player_shield_until
      ).toISOString()}.`
    );
  }

  // 4. Check Attacker & Target Cooldowns
  if (!input.bypassCooldownForTest) {
    if (cfg.attackerCooldownSeconds > 0) {
      const lastAtkRes = await db.query<{ created_at: string }>(
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

  // 5. If attacker had a new-player shield, launching an offensive PvP attack waives their own shield
  if (attacker.new_player_shield_until && new Date(attacker.new_player_shield_until).getTime() > Date.now()) {
    await db.query(`UPDATE users SET new_player_shield_until = NULL WHERE id = $1`, [attacker.id]);
  }

  // 6. Compute Attack Score vs Defense Score (incorporating inventory items, defense_config, alliance mutual defense)
  const atkItemsRes = await db.query<{ effects_json: any }>(
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

  const defItemsRes = await db.query<{ effects_json: any }>(
    `SELECT m.effects_json
     FROM player_inventory pi
     JOIN market_items m ON m.id = pi.item_id
     WHERE pi.user_id = $1 AND pi.equipped = TRUE`,
    [targetNode.owner_user_id]
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

  // Check if decoys deflect the operation
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

  let rwcStolen = 0;
  let bountyClaimedRwc = 0;
  let intelExposed: string[] = [];
  let nodeStatusAfter = targetNode.status;

  // 7. Resolve outcome effects with strict loss caps & atomic ledger transfers
  if (outcome === 'success' || outcome === 'partial') {
    if (input.method === 'probe') {
      const adj: string[] = Array.isArray(targetNode.adjacent_nodes) ? targetNode.adjacent_nodes : [];
      intelExposed = outcome === 'success' ? adj : adj.slice(0, 2);
      for (const nodeId of intelExposed) {
        await db.query(
          `INSERT INTO player_node_discoveries (user_id, node_id, discovery_source, inspected)
           VALUES ($1, $2, 'scan', FALSE)
           ON CONFLICT (user_id, node_id) DO NOTHING`,
          [attacker.id, nodeId]
        );
      }
    } else if (input.method === 'heist') {
      const defenderAccountId = getUserAccountId(targetNode.owner_user_id);
      const attackerAccountId = getUserAccountId(attacker.id);
      const defenderBalance = await getAccountBalance(db, defenderAccountId);

      // Calculate loss caps:
      // 1) Defender balance cannot drop below minProtectedBalance
      const aboveFloor = Math.max(0, defenderBalance - cfg.minProtectedBalance);

      // 2) Per-attack max loss in basis points (reduced by segmentation defense)
      const segmentationReductionBps = Math.min(
        500,
        (Number(defCfg.segmentation ?? 1) - 1) * 150 + itemLossReductionBps
      );
      const effectiveMaxBps = Math.max(100, cfg.maxLossBps - segmentationReductionBps);
      let perAttackMax = Math.floor((defenderBalance * effectiveMaxBps) / 10000);
      if (outcome === 'partial') {
        perAttackMax = Math.floor(perAttackMax * 0.5);
      }

      // 3) 24-hour cumulative loss cap
      const recentLossesRes = await db.query<{ total_lost: string | number }>(
        `SELECT COALESCE(SUM(rwc_stolen), 0) AS total_lost
         FROM pvp_incidents
         WHERE defender_user_id = $1
           AND created_at >= NOW() - INTERVAL '24 hours'`,
        [targetNode.owner_user_id]
      );
      const lostLast24h = Number(recentLossesRes.rows[0]?.total_lost ?? 0);
      const referenceBalanceForDailyCap = defenderBalance + lostLast24h;
      const maxDailyTotalLoss = Math.floor((referenceBalanceForDailyCap * cfg.dailyLossCapBps) / 10000);
      const remainingDailyAllowance = Math.max(0, maxDailyTotalLoss - lostLast24h);

      const SeizableAmount = Math.min(aboveFloor, perAttackMax, remainingDailyAllowance);

      if (SeizableAmount > 0) {
        const incidentTxKey = `pvp-heist-${attacker.id}-${targetNode.id}-${Date.now()}-${Math.random()
          .toString(36)
          .slice(2, 7)}`;
        await executeLedgerTransfer(db, {
          idempotencyKey: incidentTxKey,
          fromAccountId: defenderAccountId,
          toAccountId: attackerAccountId,
          amount: SeizableAmount,
          txType: 'pvp_seizure',
          referenceId: targetNode.id,
          memo: `PvP heist seizure against ${targetNode.hostname}`
        });
        rwcStolen = SeizableAmount;
      } else {
        mitigationApplied += ' Defender protected floor / 24h loss cap prevented any RWC seizure.';
      }
    } else if (input.method === 'disrupt') {
      nodeStatusAfter = outcome === 'success' ? 'degraded' : targetNode.status;
      await db.query(
        `UPDATE network_nodes
         SET status = $1, outage_until = NOW() + INTERVAL '10 minutes', last_attacked_at = NOW()
         WHERE id = $2`,
        [nodeStatusAfter, targetNode.id]
      );
    } else if (input.method === 'contest') {
      nodeStatusAfter = outcome === 'success' ? 'contested' : 'degraded';
      await db.query(
        `UPDATE network_nodes
         SET status = $1, contested_by_group_id = $2, last_attacked_at = NOW()
         WHERE id = $3`,
        [nodeStatusAfter, attacker.group_id ?? null, targetNode.id]
      );
    }

    // Check if there is an open bounty on this target node!
    const openBountyRes = await db.query<any>(
      `SELECT * FROM bounties
       WHERE target_node_id = $1 AND status = 'open'
       ORDER BY created_at ASC LIMIT 1`,
      [targetNode.id]
    );
    if (openBountyRes.rows.length > 0 && outcome === 'success') {
      const bounty = openBountyRes.rows[0];
      await db.query(
        `UPDATE bounties
         SET status = 'claimed', claimed_by_user_id = $1, claimed_at = NOW()
         WHERE id = $2 AND status = 'open'`,
        [attacker.id, bounty.id]
      );
      await executeLedgerTransfer(db, {
        idempotencyKey: `bounty-payout-${bounty.id}`,
        fromAccountId: 'acct-system-mint',
        toAccountId: getUserAccountId(attacker.id),
        amount: Number(bounty.reward_rwc),
        txType: 'bounty_payout',
        referenceId: bounty.id,
        memo: `Bounty claimed on ${targetNode.hostname}`
      });
      bountyClaimedRwc = Number(bounty.reward_rwc);
    }

    // Increment attacker group goal progress if in a group
    if (attacker.group_id) {
      await db.query(
        `UPDATE groups
         SET goal_progress = LEAST(goal_target, goal_progress + 1)
         WHERE id = $1`,
        [attacker.group_id]
      );
    }
  }

  // Update target node last_attacked_at
  await db.query(`UPDATE network_nodes SET last_attacked_at = NOW() WHERE id = $1`, [targetNode.id]);

  // Increase attacker heat slightly
  await db.query(`UPDATE users SET heat = LEAST(100, heat + 6), xp = xp + 40 WHERE id = $1`, [attacker.id]);

  const incidentId = generateId('inc');
  const summary = `[PvP ${input.method.toUpperCase()} -> ${outcome.toUpperCase()}] ${
    attacker.username
  } targeted ${targetNode.name} (${targetNode.hostname}) owned by ${targetNode.defender_handle}. Score ${attackScore} vs Defense ${defenseScore}.${
    rwcStolen > 0 ? ` Extracted ${rwcStolen} RWC.` : ''
  }${bountyClaimedRwc > 0 ? ` Claimed ${bountyClaimedRwc} RWC bounty!` : ''}`;

  await db.query(
    `INSERT INTO pvp_incidents (
      id, attacker_user_id, attacker_group_id, defender_user_id, defender_group_id,
      target_node_id, operation_method, outcome, attack_score, defense_score,
      rwc_stolen, intel_exposed, node_status_after, mitigation_applied, recovered, summary
    ) VALUES (
      $1, $2, $3, $4, $5,
      $6, $7, $8, $9, $10,
      $11, $12::jsonb, $13, $14, $15, $16
    )`,
    [
      incidentId,
      attacker.id,
      attacker.group_id ?? null,
      targetNode.owner_user_id,
      targetNode.defender_group_id ?? null,
      targetNode.id,
      input.method,
      outcome,
      attackScore,
      defenseScore,
      rwcStolen,
      JSON.stringify(intelExposed),
      nodeStatusAfter,
      mitigationApplied,
      nodeStatusAfter === 'online',
      summary
    ]
  );

  return {
    incidentId,
    outcome,
    method: input.method,
    targetNodeId: targetNode.id,
    targetNodeName: targetNode.name,
    defenderHandle: targetNode.defender_handle,
    attackScore,
    defenseScore,
    rwcStolen,
    bountyClaimedRwc,
    intelExposed,
    nodeStatusAfter,
    mitigationApplied,
    summary
  };
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
  const userRes = await db.query<any>(`SELECT * FROM users WHERE id = $1`, [userId]);
  if (userRes.rows.length === 0) {
    throw new PvpError('USER_NOT_FOUND', 'Operator not found.');
  }
  const user = userRes.rows[0];

  const nodeRes = await db.query<any>(
    `SELECT * FROM network_nodes WHERE id = $1 OR owner_user_id = $2 ORDER BY created_at ASC LIMIT 1`,
    [user.home_node_id, userId]
  );
  if (nodeRes.rows.length === 0) {
    throw new PvpError('HOME_NODE_NOT_FOUND', 'No personal network node found for operator.');
  }
  const node = nodeRes.rows[0];
  const defCfg = {
    monitoring: 1,
    patching: 1,
    segmentation: 1,
    decoys: 0,
    incident_response: 1,
    recovery: 1,
    ...(node.defense_config ?? {})
  };

  const costMap: Record<typeof action, number> = {
    monitor: 200,
    patch: 250,
    segment: 300,
    decoy: 350,
    ir: 150,
    recover: 100
  };
  const costRwc = costMap[action];

  await executeLedgerTransfer(db, {
    idempotencyKey: `defend-${userId}-${node.id}-${action}-${Date.now()}`,
    fromAccountId: getUserAccountId(userId),
    toAccountId: 'acct-system-mint',
    amount: costRwc,
    txType: 'recovery_cost',
    referenceId: node.id,
    memo: `Node defense upgrade: ${action}`
  });

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
      await db.query(`UPDATE users SET heat = GREATEST(0, heat - 10) WHERE id = $1`, [userId]);
      message = `Executed Incident Response playbooks on ${node.hostname}; rotated keys and reduced trace heat.`;
      break;
    case 'recover':
      defCfg.recovery = Math.min(5, Number(defCfg.recovery) + 1);
      newStatus = 'online';
      await db.query(
        `UPDATE pvp_incidents SET recovered = TRUE WHERE target_node_id = $1 AND recovered = FALSE`,
        [node.id]
      );
      message = `Restored ${node.hostname} from clean snapshot to ONLINE status and cleared contested flags.`;
      break;
  }

  const updated = await db.query<any>(
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
}
