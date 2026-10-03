import { DatabaseAdapter } from '../../db/index.js';
import {
  APPROVED_NMAP_PROFILES,
  COMMAND_HELP_CATALOG,
  parseTerminalCommand
} from '../../shared/commandParser.js';
import { generateId } from '../security.js';
import {
  SYSTEM_MINT_ACCOUNT_ID,
  executeLedgerTransfer,
  getAccountBalance,
  getUserAccountId
} from './ledger.js';
import { executeDefenseAction, executePvpOperation } from './pvp.js';
import { executeIsolatedLabScan } from '../../workers/lab-runner.js';
import { enqueueOutboxJob, processPendingOutboxJobs } from '../../workers/outbox-worker.js';

export interface TerminalExecutionOutput {
  ok: boolean;
  command: string;
  category: 'ordinary' | 'lab_tool' | 'error';
  lines: string[];
  clearScreen?: boolean;
  missionCompleted?: {
    missionId: string;
    code: string;
    title: string;
    rewardRwc: number;
    rewardXp: number;
  };
  data?: Record<string, any>;
}

export async function executeUserTerminalCommand(
  db: DatabaseAdapter,
  userId: string,
  rawCommand: string
): Promise<TerminalExecutionOutput> {
  const parsed = parseTerminalCommand(rawCommand);

  if (!parsed.ok) {
    await db.query(
      `INSERT INTO audit_logs (id, user_id, action, category, details)
       VALUES ($1, $2, $3, 'command', $4::jsonb)`,
      [
        generateId('aud'),
        userId,
        `cmd_rejected:${parsed.error.code}`,
        JSON.stringify({ rawCommand, error: parsed.error })
      ]
    );

    const lines = [`[ERROR:${parsed.error.code}] ${parsed.error.message}`];
    if (parsed.error.usage) {
      lines.push(`Usage: ${parsed.error.usage}`);
    }
    return {
      ok: false,
      command: rawCommand,
      category: 'error',
      lines
    };
  }

  const cmd = parsed.command;

  // Load user context
  const userRes = await db.query<any>(
    `SELECT u.*, gm.group_id, gm.role as group_role, g.name as group_name, g.tag as group_tag,
            g.alliance_id, a.name as alliance_name, a.tag as alliance_tag
     FROM users u
     LEFT JOIN group_members gm ON gm.user_id = u.id
     LEFT JOIN groups g ON g.id = gm.group_id
     LEFT JOIN alliances a ON a.id = g.alliance_id
     WHERE u.id = $1`,
    [userId]
  );

  if (userRes.rows.length === 0) {
    return {
      ok: false,
      command: rawCommand,
      category: 'error',
      lines: ['[AUTH_ERROR] Operator session invalid.']
    };
  }
  const user = userRes.rows[0];

  switch (cmd.kind) {
    case 'clear': {
      return {
        ok: true,
        command: rawCommand,
        category: 'ordinary',
        lines: [],
        clearScreen: true
      };
    }

    case 'help': {
      if (cmd.topic) {
        const entry = COMMAND_HELP_CATALOG.find(
          (c) => c.command === cmd.topic || c.syntax.startsWith(cmd.topic!)
        );
        if (!entry) {
          return {
            ok: false,
            command: rawCommand,
            category: 'ordinary',
            lines: [`No manual entry for "${cmd.topic}". Type \`help\` for full command list.`]
          };
        }
        return {
          ok: true,
          command: rawCommand,
          category: 'ordinary',
          lines: [
            `=== ROOTWARS MANUAL: ${entry.command.toUpperCase()} [${entry.category.toUpperCase()}] ===`,
            `Syntax      : ${entry.syntax}`,
            `Description : ${entry.description}`,
            `Examples    :`,
            ...entry.examples.map((ex) => `  $ ${ex}`)
          ]
        };
      }

      const ordinaryCmds = COMMAND_HELP_CATALOG.filter((c) => c.category === 'ordinary');
      const labCmds = COMMAND_HELP_CATALOG.filter((c) => c.category === 'lab_tool');

      return {
        ok: true,
        command: rawCommand,
        category: 'ordinary',
        lines: [
          '========================================================================',
          ' ROOTWARS OS // TERMINAL COMMAND INTERFACE v2.6',
          '========================================================================',
          ' [ORDINARY MMO COMMANDS]',
          ...ordinaryCmds.map((c) => `  ${c.syntax.padEnd(48)} - ${c.description}`),
          '',
          ' [ISOLATED LAB-TOOL COMMANDS (10.240.x.x SANDBOX ONLY)]',
          ...labCmds.map((c) => `  ${c.syntax.padEnd(48)} - ${c.description}`),
          '',
          ' Tip: Use `help <command>` for detailed examples, or press TAB to autocomplete.'
        ]
      };
    }

    case 'status': {
      const balance = await getAccountBalance(db, getUserAccountId(userId));
      const connNodeRes = user.connected_node_id
        ? await db.query<any>('SELECT id, name, hostname, ip_address, status FROM network_nodes WHERE id = $1', [
            user.connected_node_id
          ])
        : { rows: [] };
      const connNode = connNodeRes.rows[0];

      const activeLabRes = await db.query<any>(
        `SELECT ls.*, m.code as mission_code, m.title as mission_title
         FROM lab_sessions ls
         JOIN missions m ON m.id = ls.mission_id
         WHERE ls.user_id = $1 AND ls.status = 'active' AND ls.expires_at > NOW()
         ORDER BY ls.opened_at DESC LIMIT 1`,
        [userId]
      );
      const activeLab = activeLabRes.rows[0];

      const discCountRes = await db.query<{ count: string }>(
        'SELECT COUNT(*) as count FROM player_node_discoveries WHERE user_id = $1',
        [userId]
      );
      const shieldActive =
        user.new_player_shield_until && new Date(user.new_player_shield_until).getTime() > Date.now();

      return {
        ok: true,
        command: rawCommand,
        category: 'ordinary',
        lines: [
          '--- OPERATOR STATUS TELEMETRY ------------------------------------------',
          ` Handle          : ${user.username} (Level ${user.level} // XP: ${user.xp} // Rep: ${user.reputation})`,
          ` Balance         : ${balance.toLocaleString()} RWC`,
          ` Trace Heat      : ${user.heat}/100 ${user.heat >= 70 ? '[WARNING: HIGH FACTION TRACE]' : '[NOMINAL]'}`,
          ` Group / Pact    : ${user.group_name ? `[${user.group_tag}] ${user.group_name} (${user.group_role})` : 'Independent'} ${
            user.alliance_name ? `// Alliance: [${user.alliance_tag}] ${user.alliance_name}` : ''
          }`,
          ` Home Network    : ${user.home_node_id ?? 'Unassigned'} ${shieldActive ? '(New-Player Shield ACTIVE)' : '(Open PvP Active)'}`,
          ` Connected Node  : ${connNode ? `${connNode.name} (${connNode.hostname} / ${connNode.ip_address}) [${connNode.status.toUpperCase()}]` : 'Disconnected'}`,
          ` Discovered Map  : ${discCountRes.rows[0]?.count ?? 0} nodes indexed`,
          ` Active Lab Env  : ${
            activeLab
              ? `[${activeLab.mission_code}] Target ${activeLab.target_ip} (${activeLab.target_hostname})`
              : 'None (use `lab open --mission <id>`)'
          }`,
          '------------------------------------------------------------------------'
        ]
      };
    }

    case 'map': {
      const regionRes = await db.query<any>('SELECT * FROM regions WHERE id = $1', [cmd.region]);
      if (regionRes.rows.length === 0) {
        return {
          ok: false,
          command: rawCommand,
          category: 'ordinary',
          lines: [
            `Region "${cmd.region}" not found. Available regions: neo-cascadia, helvetia-haven.`
          ]
        };
      }
      const region = regionRes.rows[0];

      const nodesRes = await db.query<any>(
        `SELECT n.*, d.inspected, d.discovery_source, f.code as faction_code
         FROM network_nodes n
         LEFT JOIN player_node_discoveries d ON d.node_id = n.id AND d.user_id = $1
         LEFT JOIN factions f ON f.id = n.faction_id
         WHERE n.region_id = $2
         ORDER BY n.tier ASC, n.category ASC, n.name ASC`,
        [userId, cmd.region]
      );

      const discovered = nodesRes.rows.filter(
        (n) => n.is_public_entry || n.discovery_source !== null || n.owner_user_id === userId
      );
      const hiddenCount = nodesRes.rows.length - discovered.length;

      const lines = [
        `=== REGION TOPOLOGY: ${region.name.toUpperCase()} (${region.id}) ===`,
        `Regional Threat Index: ${region.threat_index}/100 | Market Multiplier: ${region.market_multiplier}x`,
        `Visible Nodes: ${discovered.length}/${nodesRes.rows.length} (${hiddenCount} Undiscovered Deep-Grid Nodes — use \`inspect\` or \`scan\` to reveal)`,
        '',
        'ID                   HOSTNAME                       IP             CAT            TIER  SEC  STATUS'
      ];

      for (const n of discovered) {
        lines.push(
          `${String(n.id).padEnd(20)} ${String(n.hostname).padEnd(30)} ${String(n.ip_address).padEnd(14)} ${String(
            n.category
          ).padEnd(14)} T${n.tier}    ${String(n.security_level).padEnd(4)} ${String(n.status).toUpperCase()}`
        );
      }

      return {
        ok: true,
        command: rawCommand,
        category: 'ordinary',
        lines
      };
    }

    case 'connect': {
      const nodeRes = await db.query<any>(
        `SELECT n.*, d.discovery_source
         FROM network_nodes n
         LEFT JOIN player_node_discoveries d ON d.node_id = n.id AND d.user_id = $1
         WHERE n.id = $2 OR LOWER(n.hostname) = LOWER($2) OR n.ip_address = $2`,
        [userId, cmd.target]
      );

      if (nodeRes.rows.length === 0) {
        return {
          ok: false,
          command: rawCommand,
          category: 'ordinary',
          lines: [`Target node "${cmd.target}" not found in routing table.`]
        };
      }
      const node = nodeRes.rows[0];

      await db.query(`UPDATE users SET connected_node_id = $1, last_seen_at = NOW() WHERE id = $2`, [
        node.id,
        userId
      ]);
      await db.query(
        `INSERT INTO player_node_discoveries (user_id, node_id, discovery_source, inspected)
         VALUES ($1, $2, 'connect', FALSE)
         ON CONFLICT (user_id, node_id) DO NOTHING`,
        [userId, node.id]
      );

      return {
        ok: true,
        command: rawCommand,
        category: 'ordinary',
        lines: [
          `[+] Handshake established with ${node.name} (${node.hostname} // ${node.ip_address})`,
          `    Category: ${node.category.toUpperCase()} | Tier ${node.tier} | Security: ${node.security_level} | Status: ${node.status.toUpperCase()}`,
          `    Run \`inspect --target ${node.id}\` to enumerate services and adjacent hops.`
        ],
        data: { connectedNode: node }
      };
    }

    case 'disconnect': {
      await db.query(`UPDATE users SET connected_node_id = NULL WHERE id = $1`, [userId]);
      return {
        ok: true,
        command: rawCommand,
        category: 'ordinary',
        lines: ['[*] Disconnected from remote node. Active tunnel closed; routed via local home bastion.']
      };
    }

    case 'inspect':
    case 'scan': {
      const targetKey = cmd.target ?? user.connected_node_id ?? 'node-infra-ixp';
      const nodeRes = await db.query<any>(
        `SELECT n.*, f.name as faction_name, f.code as faction_code, f.policy_stance
         FROM network_nodes n
         LEFT JOIN factions f ON f.id = n.faction_id
         WHERE n.id = $1 OR LOWER(n.hostname) = LOWER($1) OR n.ip_address = $1`,
        [targetKey]
      );

      if (nodeRes.rows.length === 0) {
        return {
          ok: false,
          command: rawCommand,
          category: 'ordinary',
          lines: [`Target node "${targetKey}" not found.`]
        };
      }
      const node = nodeRes.rows[0];

      // Mark node as discovered & inspected
      await db.query(
        `INSERT INTO player_node_discoveries (user_id, node_id, discovery_source, inspected)
         VALUES ($1, $2, 'scan', TRUE)
         ON CONFLICT (user_id, node_id) DO UPDATE SET inspected = TRUE`,
        [userId, node.id]
      );

      // Discover adjacent nodes (gradual map discovery!)
      const adjIds: string[] = Array.isArray(node.adjacent_nodes) ? node.adjacent_nodes : [];
      const newlyDiscovered: string[] = [];
      for (const adjId of adjIds) {
        const ins = await db.query(
          `INSERT INTO player_node_discoveries (user_id, node_id, discovery_source, inspected)
           VALUES ($1, $2, 'scan', FALSE)
           ON CONFLICT (user_id, node_id) DO NOTHING
           RETURNING node_id`,
          [userId, adjId]
        );
        if (ins.rows.length > 0) {
          newlyDiscovered.push(adjId);
        }
      }

      // Check if inspecting this node completes an accepted World Mission!
      let missionCompleted: TerminalExecutionOutput['missionCompleted'] = undefined;
      const worldMissionRes = await db.query<any>(
        `SELECT pm.id as pm_id, m.*
         FROM player_missions pm
         JOIN missions m ON m.id = pm.mission_id
         WHERE pm.user_id = $1
           AND pm.status != 'completed'
           AND m.is_lab_mission = FALSE
           AND m.target_node_id = $2
         LIMIT 1`,
        [userId, node.id]
      );

      if (worldMissionRes.rows.length > 0) {
        const m = worldMissionRes.rows[0];
        await db.query(
          `UPDATE player_missions
           SET status = 'completed', reward_claimed = TRUE, completed_at = NOW(),
               progress_json = '{"inspected":true}'::jsonb
           WHERE id = $1`,
          [m.pm_id]
        );
        await executeLedgerTransfer(db, {
          idempotencyKey: `mission-reward-${userId}-${m.id}`,
          fromAccountId: SYSTEM_MINT_ACCOUNT_ID,
          toAccountId: getUserAccountId(userId),
          amount: Number(m.reward_rwc),
          txType: 'mission_reward',
          referenceId: m.id,
          memo: `Completed operation ${m.code}: ${m.title}`
        });
        await db.query(
          `UPDATE users
           SET xp = xp + $1, level = GREATEST(1, 1 + FLOOR((xp + $1) / 500.0)::int), reputation = reputation + 10
           WHERE id = $2`,
          [Number(m.reward_xp), userId]
        );
        missionCompleted = {
          missionId: m.id,
          code: m.code,
          title: m.title,
          rewardRwc: Number(m.reward_rwc),
          rewardXp: Number(m.reward_xp)
        };
      }

      // Enqueue an asynchronous NPC faction reaction in the outbox if this node belongs to an NPC faction
      if (node.faction_id) {
        await enqueueOutboxJob(db, 'faction_reaction', {
          factionId: node.faction_id,
          triggerUserId: userId,
          triggerReason: `node inspection on ${node.hostname} by ${user.username}`
        });
        await processPendingOutboxJobs(db, 'inline-worker', 2);
      }

      const services: Array<{ port: number; service: string; banner: string }> = Array.isArray(
        node.services_json
      )
        ? node.services_json
        : [];

      const lines = [
        `=== NODE INSPECTION REPORT: ${node.name.toUpperCase()} ===`,
        ` Node ID        : ${node.id}`,
        ` Hostname / IP  : ${node.hostname} (${node.ip_address})`,
        ` Organization   : ${node.faction_name ? `${node.faction_name} [${node.faction_code}] (Policy: ${node.policy_stance})` : `Player Owned (${node.owner_user_id ?? 'Independent'})`}`,
        ` Security / Tier: Tier ${node.tier} | Security Rating: ${node.security_level}/100 | Patch Level: ${node.patch_level}%`,
        ` Status         : ${node.status.toUpperCase()}`,
        ` Description    : ${node.description}`,
        '',
        ' [IN-WORLD SERVICES]'
      ];

      for (const s of services) {
        lines.push(`  - ${String(s.port).padEnd(6)}/tcp  ${String(s.service).padEnd(14)} ${s.banner}`);
      }

      lines.push('');
      lines.push(` [ADJACENT LINKS]: ${adjIds.length ? adjIds.join(', ') : 'None'}`);
      if (newlyDiscovered.length > 0) {
        lines.push(` [+] TOPOLOGY DISCOVERY: Revealed ${newlyDiscovered.length} new node(s) on your World Map: ${newlyDiscovered.join(', ')}`);
      }
      if (missionCompleted) {
        lines.push('');
        lines.push(
          ` [MISSION COMPLETED] ${missionCompleted.code}: ${missionCompleted.title} -> Credited +${missionCompleted.rewardRwc} RWC & +${missionCompleted.rewardXp} XP!`
        );
      }

      return {
        ok: true,
        command: rawCommand,
        category: 'ordinary',
        lines,
        missionCompleted
      };
    }

    case 'jobs': {
      const missionsRes = await db.query<any>(
        `SELECT m.*, f.code as faction_code, pm.status as player_status
         FROM missions m
         LEFT JOIN factions f ON f.id = m.faction_id
         LEFT JOIN player_missions pm ON pm.mission_id = m.id AND pm.user_id = $1
         WHERE m.active = TRUE
         ORDER BY m.is_lab_mission DESC, m.difficulty ASC, m.code ASC`,
        [userId]
      );

      const lines = [
        '=== AVAILABLE OPERATIONS & ISOLATED LAB CONTRACTS ======================',
        'ID           CODE    TYPE       DIFF  REWARD     TARGET / LAB IP      STATUS        TITLE'
      ];

      for (const m of missionsRes.rows) {
        const typeLabel = m.is_lab_mission ? 'REAL-LAB' : 'WORLD-OP';
        const targetLabel = m.is_lab_mission ? m.lab_target_ip : m.target_node_id;
        const st = (m.player_status ?? 'available').toUpperCase();
        lines.push(
          `${String(m.id).padEnd(12)} ${String(m.code).padEnd(7)} ${typeLabel.padEnd(10)} D${m.difficulty}    ${String(
            m.reward_rwc + ' RWC'
          ).padEnd(10)} ${String(targetLabel).padEnd(20)} ${st.padEnd(13)} ${m.title}`
        );
      }
      lines.push('');
      lines.push('Tip: Run `accept --job <id>` then `lab open --mission <id>` for REAL-LAB missions.');

      return {
        ok: true,
        command: rawCommand,
        category: 'ordinary',
        lines
      };
    }

    case 'accept': {
      const mRes = await db.query<any>(
        `SELECT * FROM missions WHERE id = $1 OR LOWER(code) = LOWER($1)`,
        [cmd.jobId]
      );
      if (mRes.rows.length === 0) {
        return {
          ok: false,
          command: rawCommand,
          category: 'ordinary',
          lines: [`Mission "${cmd.jobId}" not found. Run \`jobs\` to view available contracts.`]
        };
      }
      const m = mRes.rows[0];

      await db.query(
        `INSERT INTO player_missions (id, user_id, mission_id, status, lab_ip_assigned)
         VALUES ($1, $2, $3, 'accepted', $4)
         ON CONFLICT (user_id, mission_id) DO UPDATE
         SET status = CASE WHEN player_missions.status = 'completed' THEN 'completed' ELSE 'accepted' END`,
        [generateId('pm'), userId, m.id, m.lab_target_ip ?? null]
      );

      const nextStep = m.is_lab_mission
        ? `Run \`lab open --mission ${m.id}\` to provision the isolated lab target (${m.lab_target_ip}).`
        : `Run \`connect --target ${m.target_node_id}\` and \`inspect --target ${m.target_node_id}\` to complete.`;

      return {
        ok: true,
        command: rawCommand,
        category: 'ordinary',
        lines: [
          `[+] Accepted Contract [${m.code}] ${m.title} (Reward: ${m.reward_rwc} RWC / ${m.reward_xp} XP)`,
          `    Briefing : ${m.briefing}`,
          `    Next Step: ${nextStep}`
        ]
      };
    }

    case 'lab_list': {
      const labMissionsRes = await db.query<any>(
        `SELECT m.*, pm.status as player_status, ls.id as active_session_id, ls.expires_at
         FROM missions m
         LEFT JOIN player_missions pm ON pm.mission_id = m.id AND pm.user_id = $1
         LEFT JOIN lab_sessions ls ON ls.mission_id = m.id AND ls.user_id = $1 AND ls.status = 'active' AND ls.expires_at > NOW()
         WHERE m.is_lab_mission = TRUE
         ORDER BY m.code ASC`,
        [userId]
      );

      const lines = [
        '=== ROOTWARS ISOLATED LAB MISSIONS (10.240.0.0/16 PRIVATE SANDBOX) ===',
        'MISSION ID   CODE    LAB TARGET IP   REQ PROFILE       SESSION STATUS   TITLE'
      ];

      for (const m of labMissionsRes.rows) {
        const sessStatus = m.active_session_id ? 'OPEN (ACTIVE)' : (m.player_status ?? 'available').toUpperCase();
        lines.push(
          `${String(m.id).padEnd(12)} ${String(m.code).padEnd(7)} ${String(m.lab_target_ip).padEnd(15)} ${String(
            m.required_profile
          ).padEnd(17)} ${sessStatus.padEnd(16)} ${m.title}`
        );
      }
      lines.push('');
      lines.push('Approved Nmap Profiles: quick, service, full-ports, compliance-audit');
      lines.push('To launch a lab: `lab open --mission msn-lab-01` -> then run `nmap --profile service`');

      return {
        ok: true,
        command: rawCommand,
        category: 'ordinary',
        lines
      };
    }

    case 'lab_open': {
      const mRes = await db.query<any>(
        `SELECT * FROM missions WHERE (id = $1 OR LOWER(code) = LOWER($1)) AND is_lab_mission = TRUE`,
        [cmd.missionId]
      );
      if (mRes.rows.length === 0) {
        return {
          ok: false,
          command: rawCommand,
          category: 'ordinary',
          lines: [
            `Lab mission "${cmd.missionId}" not found. Run \`lab list\` to view isolated lab missions.`
          ]
        };
      }
      const m = mRes.rows[0];

      // Ensure mission is accepted for this player
      await db.query(
        `INSERT INTO player_missions (id, user_id, mission_id, status, lab_ip_assigned)
         VALUES ($1, $2, $3, 'lab_open', $4)
         ON CONFLICT (user_id, mission_id) DO UPDATE
         SET status = CASE WHEN player_missions.status = 'completed' THEN 'completed' ELSE 'lab_open' END,
             lab_ip_assigned = EXCLUDED.lab_ip_assigned`,
        [generateId('pm'), userId, m.id, m.lab_target_ip]
      );

      // Close any previous active lab sessions for this user
      await db.query(
        `UPDATE lab_sessions SET status = 'closed', closed_at = NOW() WHERE user_id = $1 AND status = 'active'`,
        [userId]
      );

      const sessionId = generateId('labsess');
      await db.query(
        `INSERT INTO lab_sessions (
          id, user_id, mission_id, assigned_subnet, target_ip, target_hostname, status, expires_at
        ) VALUES ($1, $2, $3, '10.240.0.0/16', $4, $5, 'active', NOW() + INTERVAL '30 minutes')`,
        [sessionId, userId, m.id, m.lab_target_ip, m.lab_target_hostname]
      );

      await db.query(`UPDATE users SET active_lab_session_id = $1 WHERE id = $2`, [sessionId, userId]);

      return {
        ok: true,
        command: rawCommand,
        category: 'ordinary',
        lines: [
          `[+] PROVISIONED ISOLATED LAB ENVIRONMENT: ${sessionId}`,
          `    Mission         : [${m.code}] ${m.title}`,
          `    Assigned Target : ${m.lab_target_ip} (${m.lab_target_hostname})`,
          `    Isolation Mode  : Linux Network Namespace (non-root uid=65534, no-new-privs, egress blocked)`,
          `    Recommended Cmd : nmap --profile ${m.required_profile || 'service'} --target ${m.lab_target_ip}`
        ],
        data: {
          labSessionId: sessionId,
          missionId: m.id,
          targetIp: m.lab_target_ip
        }
      };
    }

    case 'lab_close': {
      await db.query(
        `UPDATE lab_sessions SET status = 'closed', closed_at = NOW() WHERE user_id = $1 AND status = 'active'`,
        [userId]
      );
      await db.query(`UPDATE users SET active_lab_session_id = NULL WHERE id = $1`, [userId]);
      return {
        ok: true,
        command: rawCommand,
        category: 'ordinary',
        lines: ['[*] Closed active lab session and tore down disposable target environment.']
      };
    }

    case 'nmap': {
      // 1. Verify active lab session for this player
      const sessRes = await db.query<any>(
        `SELECT ls.*, m.code as mission_code, m.title as mission_title,
                m.lab_services_spec, m.expected_ports, m.reward_rwc, m.reward_xp, m.faction_id
         FROM lab_sessions ls
         JOIN missions m ON m.id = ls.mission_id
         WHERE ls.user_id = $1 AND ls.status = 'active' AND ls.expires_at > NOW()
         ORDER BY ls.opened_at DESC LIMIT 1`,
        [userId]
      );

      if (sessRes.rows.length === 0) {
        return {
          ok: false,
          command: rawCommand,
          category: 'lab_tool',
          lines: [
            '[LAB_REQUIRED] No active isolated lab environment is open.',
            'Real tools like `nmap` may only run against an active mission’s provisioned lab target.',
            'Run `lab open --mission msn-lab-01` first, then run `nmap --profile service`.'
          ]
        };
      }

      const labSession = sessRes.rows[0];
      const requestedTargetIp = cmd.target ?? labSession.target_ip;

      // 2. Validate that requestedTargetIp matches the assigned mission lab target IP
      if (requestedTargetIp !== labSession.target_ip) {
        await db.query(
          `INSERT INTO tool_audit_logs (
            id, user_id, lab_session_id, mission_id, tool_name, profile,
            target_ip, sanitized_args, allowed, rejection_reason, isolation_mode
          ) VALUES ($1, $2, $3, $4, 'nmap', $5, $6, '[]'::jsonb, FALSE, $7, 'linux-netns-nonroot')`,
          [
            generateId('taud'),
            userId,
            labSession.id,
            labSession.mission_id,
            cmd.profile,
            requestedTargetIp,
            `Target mismatch: requested ${requestedTargetIp}, assigned ${labSession.target_ip}`
          ]
        );

        return {
          ok: false,
          command: rawCommand,
          category: 'lab_tool',
          lines: [
            `[UNAUTHORIZED_LAB_TARGET] Target "${requestedTargetIp}" is not assigned to your active lab session.`,
            `Your active mission [${labSession.mission_code}] only permits scanning ${labSession.target_ip}.`
          ]
        };
      }

      // 3. Dispatch real Nmap scan to the isolated Lab Worker (separate short-lived netns + non-root process)
      const scanResult = await executeIsolatedLabScan({
        tool: 'nmap',
        profile: cmd.profile,
        targetIp: requestedTargetIp,
        assignedTargetIp: labSession.target_ip,
        services: Array.isArray(labSession.lab_services_spec) ? labSession.lab_services_spec : []
      });

      // 4. Record immutable audit entry in tool_audit_logs
      await db.query(
        `INSERT INTO tool_audit_logs (
          id, user_id, lab_session_id, mission_id, tool_name, profile,
          target_ip, sanitized_args, allowed, rejection_reason,
          isolation_mode, raw_output, discovered_ports, duration_ms
        ) VALUES ($1, $2, $3, $4, 'nmap', $5, $6, $7::jsonb, $8, $9, $10, $11, $12::jsonb, $13)`,
        [
          generateId('taud'),
          userId,
          labSession.id,
          labSession.mission_id,
          cmd.profile,
          requestedTargetIp,
          JSON.stringify(scanResult.sanitizedArgs),
          scanResult.allowed,
          scanResult.rejectionReason ?? null,
          scanResult.isolationMode,
          scanResult.rawOutput,
          JSON.stringify(scanResult.discoveredPorts),
          scanResult.durationMs
        ]
      );

      if (!scanResult.allowed) {
        return {
          ok: false,
          command: rawCommand,
          category: 'lab_tool',
          lines: [`[LAB_POLICY_DENIED] ${scanResult.rejectionReason}`]
        };
      }

      // 5. Evaluate mission progress from real Nmap output!
      const expectedPorts: number[] = Array.isArray(labSession.expected_ports)
        ? labSession.expected_ports.map(Number)
        : [];
      const foundPortNumbers = scanResult.discoveredPorts.map((p) => p.port);
      const allExpectedFound =
        expectedPorts.length > 0 && expectedPorts.every((ep) => foundPortNumbers.includes(ep));

      let missionCompleted: TerminalExecutionOutput['missionCompleted'] = undefined;
      const pmRes = await db.query<any>(
        `SELECT * FROM player_missions WHERE user_id = $1 AND mission_id = $2`,
        [userId, labSession.mission_id]
      );
      const pm = pmRes.rows[0];

      if (allExpectedFound && (!pm || !pm.reward_claimed)) {
        await db.query(
          `UPDATE player_missions
           SET status = 'completed',
               reward_claimed = TRUE,
               completed_at = NOW(),
               progress_json = $1::jsonb
           WHERE user_id = $2 AND mission_id = $3`,
          [
            JSON.stringify({
              profileUsed: cmd.profile,
              discoveredPorts: scanResult.discoveredPorts,
              completedViaRealNmap: true
            }),
            userId,
            labSession.mission_id
          ]
        );

        await executeLedgerTransfer(db, {
          idempotencyKey: `mission-reward-${userId}-${labSession.mission_id}`,
          fromAccountId: SYSTEM_MINT_ACCOUNT_ID,
          toAccountId: getUserAccountId(userId),
          amount: Number(labSession.reward_rwc),
          txType: 'mission_reward',
          referenceId: labSession.mission_id,
          memo: `Completed isolated lab mission ${labSession.mission_code}`
        });

        await db.query(
          `UPDATE users
           SET xp = xp + $1,
               level = GREATEST(1, 1 + FLOOR((xp + $1) / 500.0)::int),
               reputation = reputation + 20
           WHERE id = $2`,
          [Number(labSession.reward_xp), userId]
        );

        if (labSession.faction_id) {
          await enqueueOutboxJob(db, 'faction_reaction', {
            factionId: labSession.faction_id,
            triggerUserId: userId,
            triggerReason: `completed lab audit ${labSession.mission_code} on ${labSession.target_ip}`,
            preferredReaction: 'patching'
          });
          await processPendingOutboxJobs(db, 'inline-worker', 2);
        }

        missionCompleted = {
          missionId: labSession.mission_id,
          code: labSession.mission_code,
          title: labSession.mission_title,
          rewardRwc: Number(labSession.reward_rwc),
          rewardXp: Number(labSession.reward_xp)
        };
      }

      const lines = [
        `[LAB WORKER // ${scanResult.isolationMode.toUpperCase()} // UID=65534(nobody)]`,
        `[EXEC] nmap ${APPROVED_NMAP_PROFILES[cmd.profile].nmapArgs.join(' ')} ${requestedTargetIp}`,
        '------------------------------------------------------------------------',
        ...scanResult.rawOutput.trim().split('\n'),
        '------------------------------------------------------------------------',
        `[TELEMETRY] Discovered ${scanResult.discoveredPorts.length} open TCP port(s): ${
          foundPortNumbers.join(', ') || 'none'
        } (${scanResult.durationMs}ms)`
      ];

      if (missionCompleted) {
        lines.push('');
        lines.push(
          `[★ LAB MISSION COMPLETED ★] [${missionCompleted.code}] ${missionCompleted.title}`,
          `[+] Atomic Ledger Credit: +${missionCompleted.rewardRwc.toLocaleString()} RWC | +${missionCompleted.rewardXp} XP`
        );
      }

      return {
        ok: true,
        command: rawCommand,
        category: 'lab_tool',
        lines,
        missionCompleted,
        data: {
          scanResult
        }
      };
    }

    case 'pvp_attack': {
      try {
        const res = await executePvpOperation(db, {
          attackerUserId: userId,
          targetNodeIdentifier: cmd.target,
          method: cmd.method
        });

        return {
          ok: true,
          command: rawCommand,
          category: 'ordinary',
          lines: [
            `=== OPEN PvP OPERATION REPORT [${res.incidentId}] ===`,
            ` Target Node    : ${res.targetNodeName} (${res.targetNodeId}) // Defender: ${res.defenderHandle}`,
            ` Method         : ${res.method.toUpperCase()}`,
            ` Outcome        : ${res.outcome.toUpperCase()} (Attack Score: ${res.attackScore} vs Defense: ${res.defenseScore})`,
            ` RWC Extracted  : ${res.rwcStolen} RWC ${res.bountyClaimedRwc > 0 ? `(+${res.bountyClaimedRwc} RWC Bounty!)` : ''}`,
            ` Node Status    : ${res.nodeStatusAfter.toUpperCase()}`,
            ` Mitigation Log : ${res.mitigationApplied}`,
            ...(res.intelExposed.length > 0 ? [` Exposed Links  : ${res.intelExposed.join(', ')}`] : [])
          ],
          data: { pvpResult: res }
        };
      } catch (err: any) {
        return {
          ok: false,
          command: rawCommand,
          category: 'ordinary',
          lines: [`[PVP_DENIED:${err?.code ?? 'ERROR'}] ${err?.message ?? String(err)}`]
        };
      }
    }

    case 'defend': {
      try {
        const res = await executeDefenseAction(db, userId, cmd.action);
        return {
          ok: true,
          command: rawCommand,
          category: 'ordinary',
          lines: [
            `[+] DEFENSE ACTION EXECUTED (${cmd.action.toUpperCase()}) [-${res.costRwc} RWC]`,
            `    ${res.message}`,
            `    Security Rating: ${res.updatedNode.security_level}/100 | Patch Level: ${res.updatedNode.patch_level}% | Status: ${res.updatedNode.status.toUpperCase()}`
          ],
          data: { defenseResult: res }
        };
      } catch (err: any) {
        return {
          ok: false,
          command: rawCommand,
          category: 'ordinary',
          lines: [`[DEFENSE_ERROR:${err?.code ?? 'ERROR'}] ${err?.message ?? String(err)}`]
        };
      }
    }

    case 'transfer': {
      try {
        const recipientRes = await db.query<{ id: string; username: string }>(
          'SELECT id, username FROM users WHERE LOWER(username) = LOWER($1)',
          [cmd.to]
        );
        if (recipientRes.rows.length === 0) {
          return {
            ok: false,
            command: rawCommand,
            category: 'ordinary',
            lines: [`Recipient operator "${cmd.to}" not found.`]
          };
        }
        const recipient = recipientRes.rows[0];
        const tx = await executeLedgerTransfer(db, {
          idempotencyKey: `term-xfer-${userId}-${recipient.id}-${Date.now()}`,
          fromAccountId: getUserAccountId(userId),
          toAccountId: getUserAccountId(recipient.id),
          amount: cmd.amount,
          txType: 'player_transfer',
          memo: cmd.memo ?? `Terminal transfer to ${recipient.username}`
        });
        const newBal = await getAccountBalance(db, getUserAccountId(userId));
        return {
          ok: true,
          command: rawCommand,
          category: 'ordinary',
          lines: [
            `[+] LEDGER TRANSFER CONFIRMED [${tx.id}]`,
            `    Sent ${cmd.amount.toLocaleString()} RWC -> ${recipient.username}`,
            `    Remaining Balance: ${newBal.toLocaleString()} RWC`
          ]
        };
      } catch (err: any) {
        return {
          ok: false,
          command: rawCommand,
          category: 'ordinary',
          lines: [`[LEDGER_ERROR:${err?.code ?? 'ERROR'}] ${err?.message ?? String(err)}`]
        };
      }
    }

    case 'factions': {
      const facRes = await db.query<any>('SELECT * FROM factions ORDER BY category ASC, name ASC');
      const lines = [
        '=== REGIONAL NPC FACTIONS & SECURITY DIRECTIVES ========================',
        'CODE         CATEGORY          ALERT   POLICY               TARIFF   NAME / ADVISORY'
      ];
      for (const f of facRes.rows) {
        lines.push(
          `${String(f.code).padEnd(12)} ${String(f.category).padEnd(17)} ${String(f.alert_level + '%').padEnd(7)} ${String(
            f.policy_stance.toUpperCase()
          ).padEnd(20)} ${String(f.price_modifier + 'x').padEnd(8)} ${f.name}`
        );
        if (f.active_advisory) {
          lines.push(`             └─ ${f.active_advisory}`);
        }
      }
      return {
        ok: true,
        command: rawCommand,
        category: 'ordinary',
        lines
      };
    }

    case 'events': {
      const evRes = await db.query<any>(
        `SELECT e.*, f.code as faction_code
         FROM world_events e
         LEFT JOIN factions f ON f.id = e.faction_id
         ORDER BY e.created_at DESC
         LIMIT 10`
      );
      const lines = ['=== RECENT WORLD EVENTS & FACTION REACTIONS ============================'];
      for (const ev of evRes.rows) {
        lines.push(
          `[${ev.severity.toUpperCase()}] [${ev.event_type.toUpperCase()}] ${
            ev.faction_code ? `(${ev.faction_code}) ` : ''
          }${ev.title}`,
          `    ${ev.description}`
        );
      }
      return {
        ok: true,
        command: rawCommand,
        category: 'ordinary',
        lines
      };
    }
  }
}
