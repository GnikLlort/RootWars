import { DatabaseAdapter } from '../../db/index.js';
import { generateId } from '../security.js';

export type FactionReactionType =
  | 'investigating'
  | 'patching'
  | 'changing_policies'
  | 'changing_prices'
  | 'issuing_advisories'
  | 'freezing_accounts'
  | 'offering_contracts'
  | 'negotiating';

export interface FactionReactionResult {
  factionId: string;
  factionName: string;
  reactionType: FactionReactionType;
  eventId: string;
  title: string;
  description: string;
  alertLevelAfter: number;
  policyStanceAfter: string;
  priceModifierAfter: number;
}

export async function triggerFactionReaction(
  db: DatabaseAdapter,
  params: {
    factionId: string;
    triggerUserId?: string;
    triggerReason: string;
    preferredReaction?: FactionReactionType;
  }
): Promise<FactionReactionResult | null> {
  const facRes = await db.query<any>(`SELECT * FROM factions WHERE id = $1`, [params.factionId]);
  if (facRes.rows.length === 0) return null;
  const faction = facRes.rows[0];

  const reactions: FactionReactionType[] = [
    'investigating',
    'patching',
    'changing_policies',
    'changing_prices',
    'issuing_advisories',
    'offering_contracts',
    'negotiating',
    'freezing_accounts'
  ];

  // Deterministic/bounded selection based on alert level and category
  let reaction: FactionReactionType =
    params.preferredReaction ??
    reactions[(Number(faction.alert_level) + params.triggerReason.length) % reactions.length];

  let newAlert = Math.min(100, Number(faction.alert_level) + 5);
  let newPolicy = faction.policy_stance as string;
  let newPriceMod = Number(faction.price_modifier);
  let advisory = faction.active_advisory as string;
  let title = '';
  let description = '';

  switch (reaction) {
    case 'investigating': {
      title = `${faction.name} Initiates Forensic Trace Investigation`;
      description = `Following ${params.triggerReason}, ${faction.code} counter-intrusion teams elevated packet telemetry correlation across ${faction.region_id}.`;
      advisory = `INVESTIGATION ACTIVE: ${faction.code} SOC auditing recent session handshakes.`;
      if (params.triggerUserId) {
        await db.query(`UPDATE users SET heat = LEAST(100, heat + 5) WHERE id = $1`, [params.triggerUserId]);
      }
      break;
    }

    case 'patching': {
      title = `${faction.name} Rolls Out Emergency Kernel & Firmware Patches`;
      description = `${faction.code} sysadmins deployed hotfixes across regional nodes (+6% patch level, +4 security rating) in response to ${params.triggerReason}.`;
      advisory = `PATCH CYCLE COMPLETE: ${faction.code} perimeter nodes hardened.`;
      await db.query(
        `UPDATE network_nodes
         SET patch_level = LEAST(100, patch_level + 6),
             security_level = LEAST(95, security_level + 4)
         WHERE faction_id = $1`,
        [faction.id]
      );
      break;
    }

    case 'changing_policies': {
      newPolicy = newAlert >= 60 ? 'lockdown' : 'heightened';
      title = `${faction.name} Enacts "${newPolicy.toUpperCase()}" Security Policy`;
      description = `${faction.code} updated access control directives to ${newPolicy.toUpperCase()} status following ${params.triggerReason}.`;
      advisory = `POLICY CHANGE: ${faction.code} operating under ${newPolicy.toUpperCase()} access rules.`;
      break;
    }

    case 'changing_prices': {
      const delta = faction.category === 'exchange' || faction.category === 'bank' ? 0.04 : -0.03;
      newPriceMod = Number(Math.max(0.8, Math.min(1.35, newPriceMod + delta)).toFixed(3));
      title = `${faction.name} Adjusts Regional Liquidity & Equipment Pricing`;
      description = `${faction.code} repriced contract multipliers and equipment tariffs to ${newPriceMod}x due to ${params.triggerReason}.`;
      advisory = `TARIFF UPDATE: ${faction.code} price index set to ${(newPriceMod * 100).toFixed(1)}%.`;
      break;
    }

    case 'issuing_advisories': {
      title = `${faction.code} Security Bulletin: Anomalous Recon Activity`;
      description = `${faction.name} published a regional CERT advisory warning operators of active probing (${params.triggerReason}).`;
      advisory = `CERT BULLETIN [${new Date().toISOString().slice(11, 19)} UTC]: Heightened telemetry monitoring.`;
      break;
    }

    case 'freezing_accounts': {
      title = `${faction.name} Places Temporary Compliance Hold Advisory`;
      description = `${faction.code} compliance algorithms flagged high-heat transfers (${params.triggerReason}). Operators with >85 heat face temporary regulatory holds until cleared.`;
      advisory = `COMPLIANCE HOLD WATCH: High-heat accounts subject to temporary audit review.`;
      if (params.triggerUserId) {
        const uRes = await db.query<{ heat: number }>(`SELECT heat FROM users WHERE id = $1`, [
          params.triggerUserId
        ]);
        if ((uRes.rows[0]?.heat ?? 0) >= 85) {
          await db.query(
            `UPDATE users SET account_frozen_until = NOW() + INTERVAL '5 minutes' WHERE id = $1`,
            [params.triggerUserId]
          );
        }
      }
      break;
    }

    case 'offering_contracts': {
      title = `${faction.name} Posts High-Priority Security Audit Contract`;
      description = `In response to ${params.triggerReason}, ${faction.code} increased mission reward bonuses and opened emergency response contracts.`;
      advisory = `CONTRACTS OPEN: ${faction.code} offering bonus RWC for verified audits.`;
      await db.query(
        `UPDATE missions SET reward_rwc = LEAST(5000, reward_rwc + 100) WHERE faction_id = $1`,
        [faction.id]
      );
      break;
    }

    case 'negotiating': {
      newPolicy = 'amnesty_negotiation';
      newAlert = Math.max(15, newAlert - 10);
      title = `${faction.name} Opens Backchannel Amnesty & Disclosure Talks`;
      description = `${faction.code} offered trace-heat amnesty to operators who submit responsible audit reports following ${params.triggerReason}.`;
      advisory = `DIPLOMATIC CHANNEL: ${faction.code} offering heat reduction for cooperative audits.`;
      if (params.triggerUserId) {
        await db.query(`UPDATE users SET heat = GREATEST(0, heat - 8) WHERE id = $1`, [params.triggerUserId]);
      }
      break;
    }
  }

  await db.query(
    `UPDATE factions
     SET alert_level = $1,
         policy_stance = $2,
         price_modifier = $3,
         active_advisory = $4,
         last_reaction_at = NOW()
     WHERE id = $5`,
    [newAlert, newPolicy, newPriceMod, advisory, faction.id]
  );

  const eventId = generateId('evt');
  await db.query(
    `INSERT INTO world_events (
      id, region_id, faction_id, event_type, severity, title, description, effects_json
    ) VALUES ($1, $2, $3, 'faction_reaction', $4, $5, $6, $7::jsonb)`,
    [
      eventId,
      faction.region_id,
      faction.id,
      newAlert >= 60 ? 'high' : 'medium',
      title,
      description,
      JSON.stringify({
        reaction_type: reaction,
        alert_level: newAlert,
        policy_stance: newPolicy,
        price_modifier: newPriceMod
      })
    ]
  );

  await db.query(
    `INSERT INTO audit_logs (id, user_id, action, category, target_id, details)
     VALUES ($1, $2, $3, 'faction', $4, $5::jsonb)`,
    [
      generateId('aud'),
      params.triggerUserId ?? null,
      `faction_reaction:${reaction}`,
      faction.id,
      JSON.stringify({ title, triggerReason: params.triggerReason, alertLevelAfter: newAlert })
    ]
  );

  return {
    factionId: faction.id,
    factionName: faction.name,
    reactionType: reaction,
    eventId,
    title,
    description,
    alertLevelAfter: newAlert,
    policyStanceAfter: newPolicy,
    priceModifierAfter: newPriceMod
  };
}

const WORLD_EVENT_TEMPLATES = [
  {
    event_type: 'election',
    faction_id: 'fac-aegis-gov',
    severity: 'medium',
    title: 'Cascadia Digital Sovereignty Council Vote Concludes',
    description:
      'Voters approved stronger encryption mandates on municipal gateways while authorizing independent security audits.',
    effects_json: { threat_delta: -2, patch_boost: 5 }
  },
  {
    event_type: 'sanction',
    faction_id: 'fac-sovereign-bank',
    severity: 'high',
    title: 'Cross-Regional Liquidity Sanctions Imposed on Unverified Relays',
    description:
      'Sovereign Pacific Bank tightened wire verification thresholds on offshore escrow nodes, raising banking security posture.',
    effects_json: { threat_delta: 4, price_modifier: 1.04 }
  },
  {
    event_type: 'leak',
    faction_id: 'fac-veritas-media',
    severity: 'medium',
    title: 'Veritas Broadcast Releases "Project Glasshouse" Cable Dump',
    description:
      'Whistleblower documents revealed internal routing tables across corporate R&D extranets in Neo-Cascadia.',
    effects_json: { exposed_category: 'corporate' }
  },
  {
    event_type: 'market_shock',
    faction_id: 'fac-kronos-exchange',
    severity: 'high',
    title: 'Kronos Quant Flash-Liquidity Rebalance',
    description:
      'High-frequency arbitrage algorithms triggered a temporary +6% surge in mission payouts and hardware module demand.',
    effects_json: { market_multiplier: 1.06 }
  },
  {
    event_type: 'strike',
    faction_id: 'fac-pacport-logistics',
    severity: 'medium',
    title: 'Autonomous Gantry Technicians Walkout at Pacific Port',
    description:
      'Maintenance slowdown at Pacific Automated Port reduced patch cadence on logistics nodes by 8%.',
    effects_json: { logistics_patch_delta: -8 }
  },
  {
    event_type: 'outage',
    faction_id: 'fac-helios-infra',
    severity: 'high',
    title: 'Transient Harmonic Spike on Cascadia Hydro Telemetry Bus',
    description:
      'Substation load shedding briefly degraded secondary hydro telemetry relays; emergency SCADA contracts prioritized.',
    effects_json: { degraded_node: 'node-infra-hydro' }
  },
  {
    event_type: 'security_incident',
    faction_id: 'fac-sentinel-sec',
    severity: 'critical',
    title: 'Sentinel CERT Raises Grid Threat Index Following Syndicate Sweep',
    description:
      'Sentinel analysts detected coordinated dark-fiber scanning and deployed enhanced honeypot signatures.',
    effects_json: { threat_delta: 6 }
  }
] as const;

export async function generateDynamicWorldEvent(db: DatabaseAdapter): Promise<any> {
  const countRes = await db.query<{ count: string }>('SELECT COUNT(*) as count FROM world_events');
  const idx = Number(countRes.rows[0]?.count ?? 0) % WORLD_EVENT_TEMPLATES.length;
  const tpl = WORLD_EVENT_TEMPLATES[idx];

  const eventId = generateId('evt');
  const inserted = await db.query<any>(
    `INSERT INTO world_events (
      id, region_id, faction_id, event_type, severity, title, description, effects_json
    ) VALUES ($1, 'neo-cascadia', $2, $3, $4, $5, $6, $7::jsonb)
    RETURNING *`,
    [
      eventId,
      tpl.faction_id,
      tpl.event_type,
      tpl.severity,
      tpl.title,
      tpl.description,
      JSON.stringify(tpl.effects_json)
    ]
  );

  // Apply bounded world state effects
  if ('threat_delta' in tpl.effects_json) {
    await db.query(
      `UPDATE regions
       SET threat_index = GREATEST(10, LEAST(95, threat_index + $1))
       WHERE id = 'neo-cascadia'`,
      [(tpl.effects_json as any).threat_delta]
    );
  }
  if ('logistics_patch_delta' in tpl.effects_json) {
    await db.query(
      `UPDATE network_nodes
       SET patch_level = GREATEST(20, LEAST(100, patch_level + $1))
       WHERE category = 'logistics'`,
      [(tpl.effects_json as any).logistics_patch_delta]
    );
  }

  return inserted.rows[0];
}
