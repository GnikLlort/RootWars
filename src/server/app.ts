import Fastify, { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyCors from '@fastify/cors';
import fastifyWebsocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DatabaseAdapter, getDb } from '../db/index.js';
import { RedisClients, getRedis } from '../db/redis.js';
import {
  escapeTerminalText,
  generateId,
  generateSessionToken,
  hashPassword,
  hashToken,
  verifyPassword
} from './security.js';
import {
  SYSTEM_MINT_ACCOUNT_ID,
  ensureLedgerAccount,
  executeLedgerTransfer,
  getAccountBalance,
  getGroupAccountId,
  getUserAccountId
} from './services/ledger.js';
import { executeUserTerminalCommand } from './services/terminal-executor.js';
import { executeDefenseAction, executePvpOperation } from './services/pvp.js';
import { generateDynamicWorldEvent, triggerFactionReaction } from './services/world-factions.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface AuthUser {
  id: string;
  username: string;
  role: string;
  level: number;
  xp: number;
  reputation: number;
  heat: number;
  connected_node_id: string | null;
  active_lab_session_id: string | null;
  home_node_id: string | null;
  new_player_shield_until: string | null;
  account_frozen_until: string | null;
}

declare module 'fastify' {
  interface FastifyRequest {
    authUser?: AuthUser;
    sessionTokenHash?: string;
  }
}

export async function buildApp(options?: {
  db?: DatabaseAdapter;
  redis?: RedisClients;
}): Promise<FastifyInstance> {
  const db = options?.db ?? (await getDb());
  const redis = options?.redis ?? (await getRedis());

  const app = Fastify({
    logger: false,
    trustProxy: true
  });

  await app.register(fastifyCors, {
    origin: true,
    credentials: true
  });

  await app.register(fastifyCookie, {
    secret: process.env.SESSION_SECRET ?? 'rootwars-dev-secret-key-2026-32bytes'
  });

  await app.register(fastifyWebsocket);

  // Connected WebSocket clients for realtime fanout
  const wsClients = new Set<{
    socket: any;
    userId: string;
    username: string;
    groupId: string | null;
    allianceId: string | null;
  }>();

  function broadcastRealtime(event: {
    type: string;
    channelType?: 'global' | 'group' | 'alliance' | 'user';
    channelId?: string;
    payload: any;
  }) {
    const serialized = JSON.stringify(event);
    redis.pub.publish('rootwars:events', serialized).catch(() => {});

    for (const client of wsClients) {
      try {
        if (event.channelType === 'group' && client.groupId !== event.channelId) continue;
        if (event.channelType === 'alliance' && client.allianceId !== event.channelId) continue;
        if (event.channelType === 'user' && client.userId !== event.channelId) continue;
        if (client.socket.readyState === 1) {
          client.socket.send(serialized);
        }
      } catch {}
    }
  }

  // Rate limit helper backed by Redis
  async function checkRateLimit(key: string, maxPerWindow: number, windowMs = 60_000): Promise<boolean> {
    try {
      const redisKey = `rl:${key}`;
      const count = await redis.client.incr(redisKey);
      if (count === 1) {
        await redis.client.pexpire(redisKey, windowMs);
      }
      return count <= maxPerWindow;
    } catch {
      return true;
    }
  }

  // Session resolution helper
  async function resolveSessionUser(req: FastifyRequest): Promise<AuthUser | null> {
    const authHeader = req.headers.authorization;
    const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7).trim() : undefined;
    const cookieToken = req.cookies?.rw_session;
    const queryToken = (req.query as any)?.token;

    const rawToken = bearerToken || cookieToken || queryToken;
    if (!rawToken || typeof rawToken !== 'string') {
      return null;
    }

    const tokenHash = hashToken(rawToken);
    req.sessionTokenHash = tokenHash;

    const sessRes = await db.query<any>(
      `SELECT s.id as session_id, s.expires_at, s.revoked, u.*
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.id = $1 AND s.revoked = FALSE AND s.expires_at > NOW()`,
      [tokenHash]
    );

    if (sessRes.rows.length === 0) {
      return null;
    }

    const u = sessRes.rows[0];
    return {
      id: u.id,
      username: u.username,
      role: u.role,
      level: Number(u.level),
      xp: Number(u.xp),
      reputation: Number(u.reputation),
      heat: Number(u.heat),
      connected_node_id: u.connected_node_id,
      active_lab_session_id: u.active_lab_session_id,
      home_node_id: u.home_node_id,
      new_player_shield_until: u.new_player_shield_until,
      account_frozen_until: u.account_frozen_until
    };
  }

  async function requireAuth(req: FastifyRequest, reply: FastifyReply) {
    const user = await resolveSessionUser(req);
    if (!user) {
      return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'Valid operator session required.' });
    }
    req.authUser = user;
  }

  async function buildFullOperatorState(userId: string) {
    const uRes = await db.query<any>(
      `SELECT u.*, gm.group_id, gm.role as group_role, g.name as group_name, g.tag as group_tag,
              g.alliance_id, a.name as alliance_name, a.tag as alliance_tag
       FROM users u
       LEFT JOIN group_members gm ON gm.user_id = u.id
       LEFT JOIN groups g ON g.id = gm.group_id
       LEFT JOIN alliances a ON a.id = g.alliance_id
       WHERE u.id = $1`,
      [userId]
    );
    const user = uRes.rows[0];
    if (!user) return null;

    const balance = await getAccountBalance(db, getUserAccountId(userId));
    const connNodeRes = user.connected_node_id
      ? await db.query<any>('SELECT * FROM network_nodes WHERE id = $1', [user.connected_node_id])
      : { rows: [] };
    const homeNodeRes = user.home_node_id
      ? await db.query<any>('SELECT * FROM network_nodes WHERE id = $1', [user.home_node_id])
      : { rows: [] };
    const activeLabRes = await db.query<any>(
      `SELECT ls.*, m.code as mission_code, m.title as mission_title, m.required_profile
       FROM lab_sessions ls
       JOIN missions m ON m.id = ls.mission_id
       WHERE ls.user_id = $1 AND ls.status = 'active' AND ls.expires_at > NOW()
       ORDER BY ls.opened_at DESC LIMIT 1`,
      [userId]
    );

    const onlineMembers = await redis.client.smembers('presence:online').catch(() => []);

    return {
      id: user.id,
      username: user.username,
      role: user.role,
      level: Number(user.level),
      xp: Number(user.xp),
      reputation: Number(user.reputation),
      heat: Number(user.heat),
      balanceRwc: balance,
      connectedNode: connNodeRes.rows[0] ?? null,
      homeNode: homeNodeRes.rows[0] ?? null,
      activeLabSession: activeLabRes.rows[0] ?? null,
      newPlayerShieldUntil: user.new_player_shield_until,
      shieldActive: Boolean(
        user.new_player_shield_until && new Date(user.new_player_shield_until).getTime() > Date.now()
      ),
      group: user.group_id
        ? {
            id: user.group_id,
            name: user.group_name,
            tag: user.group_tag,
            role: user.group_role
          }
        : null,
      alliance: user.alliance_id
        ? {
            id: user.alliance_id,
            name: user.alliance_name,
            tag: user.alliance_tag
          }
        : null,
      onlineCount: Math.max(1, onlineMembers.length + 3) // +3 seeded active NPC/rival operators
    };
  }

  // Health endpoint
  app.get('/api/health', async () => {
    return {
      status: 'ok',
      service: 'rootwars-api',
      dbBackend: db.backendType,
      redisBackend: redis.backendType,
      timestamp: new Date().toISOString()
    };
  });

  // =========================================================================
  // AUTH ROUTES
  // =========================================================================
  app.post('/api/auth/register', async (req, reply) => {
    const authMax = Number(process.env.RATE_LIMIT_MAX_PER_MINUTE ?? 30);
    const allowed = await checkRateLimit(`auth:${req.ip}`, authMax, 60_000);
    if (!allowed) {
      return reply.code(429).send({ error: 'RATE_LIMITED', message: 'Too many authentication attempts.' });
    }

    const body = (req.body as any) ?? {};
    const username = String(body.username ?? '').trim();
    const password = String(body.password ?? '');

    if (!/^[a-zA-Z0-9_]{3,24}$/.test(username)) {
      return reply.code(400).send({
        error: 'INVALID_USERNAME',
        message: 'Handle must be 3-24 characters (letters, numbers, underscores).'
      });
    }
    if (password.length < 8 || password.length > 128) {
      return reply.code(400).send({
        error: 'INVALID_PASSWORD',
        message: 'Password must be between 8 and 128 characters.'
      });
    }

    const existing = await db.query('SELECT id FROM users WHERE LOWER(username) = LOWER($1)', [username]);
    if (existing.rows.length > 0) {
      return reply.code(409).send({
        error: 'USERNAME_TAKEN',
        message: `Operator handle "${username}" is already registered.`
      });
    }

    const userId = generateId('usr');
    const homeNodeId = `node-player-${username.toLowerCase().replace(/[^a-z0-9]/g, '')}`;
    const passwordHash = await hashPassword(password);
    const shieldMinutes = Number(process.env.PVP_NEW_PLAYER_SHIELD_MINUTES ?? 60);

    // Allocate unique fictional player subnet IP
    const countRes = await db.query<{ count: string }>('SELECT COUNT(*) as count FROM network_nodes');
    const nodeNum = Number(countRes.rows[0]?.count ?? 30) + 15;
    const oct3 = 100 + Math.floor(nodeNum / 200);
    const oct4 = (nodeNum % 200) + 10;
    const playerIp = `172.16.${oct3}.${oct4}`;

    await db.query(
      `INSERT INTO users (
        id, username, password_hash, role, level, xp, reputation, heat,
        connected_node_id, home_node_id, new_player_shield_until
      ) VALUES (
        $1, $2, $3, 'player', 1, 0, 100, 0,
        'node-infra-ixp', $4, NOW() + ($5 || ' minutes')::interval
      )`,
      [userId, username, passwordHash, homeNodeId, String(shieldMinutes)]
    );

    // Create player's personal network node for Open PvP
    await db.query(
      `INSERT INTO network_nodes (
        id, region_id, owner_user_id, name, hostname, ip_address,
        category, tier, security_level, patch_level, is_public_entry,
        pos_x, pos_y, adjacent_nodes, services_json, description
      ) VALUES (
        $1, 'neo-cascadia', $2, $3, $4, $5,
        'player', 1, 35, 65, TRUE,
        $6, $7, '["node-infra-ixp","node-pvp-kestrel"]'::jsonb,
        '[{"port":22,"service":"ssh","banner":"RootWars-Operator-Bastion"},{"port":443,"service":"https","banner":"Operator-Command-Relay"}]'::jsonb,
        $8
      ) ON CONFLICT (id) DO NOTHING`,
      [
        homeNodeId,
        userId,
        `${username} Personal Bastion`,
        `${username.toLowerCase()}.player.rw`,
        playerIp,
        40 + (nodeNum % 35),
        52 + (nodeNum % 30),
        `Personal network enclave operated by ${username}.`
      ]
    );

    // Seed initial public node discoveries
    const publicNodes = await db.query<{ id: string }>(
      `SELECT id FROM network_nodes WHERE is_public_entry = TRUE OR id = $1`,
      [homeNodeId]
    );
    for (const pn of publicNodes.rows) {
      await db.query(
        `INSERT INTO player_node_discoveries (user_id, node_id, discovery_source, inspected)
         VALUES ($1, $2, 'initial', FALSE)
         ON CONFLICT (user_id, node_id) DO NOTHING`,
        [userId, pn.id]
      );
    }

    // Create user ledger account and grant 2,500 RWC starting balance
    const userAccountId = getUserAccountId(userId);
    await ensureLedgerAccount(db, userAccountId, 'user', userId, 0);
    await executeLedgerTransfer(db, {
      idempotencyKey: `initial-grant-${userId}`,
      fromAccountId: SYSTEM_MINT_ACCOUNT_ID,
      toAccountId: userAccountId,
      amount: 2500,
      txType: 'initial_grant',
      memo: 'New operator onboarding stipend (2,500 RWC)'
    });

    // Create session
    const { rawToken, tokenHash } = generateSessionToken();
    const ttlSeconds = Number(process.env.SESSION_TTL_SECONDS ?? 86400);
    await db.query(
      `INSERT INTO sessions (id, user_id, ip_address, user_agent, expires_at)
       VALUES ($1, $2, $3, $4, NOW() + ($5 || ' seconds')::interval)`,
      [tokenHash, userId, req.ip, req.headers['user-agent'] ?? '', String(ttlSeconds)]
    );

    await redis.client.sadd('presence:online', username).catch(() => {});

    await db.query(
      `INSERT INTO audit_logs (id, user_id, action, category, ip_address, details)
       VALUES ($1, $2, 'user_registered', 'auth', $3, $4::jsonb)`,
      [generateId('aud'), userId, req.ip, JSON.stringify({ username, homeNodeId })]
    );

    reply.setCookie('rw_session', rawToken, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      maxAge: ttlSeconds
    });

    const state = await buildFullOperatorState(userId);
    return reply.code(201).send({
      token: rawToken,
      operator: state
    });
  });

  app.post('/api/auth/login', async (req, reply) => {
    const authMax = Number(process.env.RATE_LIMIT_MAX_PER_MINUTE ?? 30);
    const allowed = await checkRateLimit(`auth:${req.ip}`, authMax, 60_000);
    if (!allowed) {
      return reply.code(429).send({ error: 'RATE_LIMITED', message: 'Too many login attempts.' });
    }

    const body = (req.body as any) ?? {};
    const username = String(body.username ?? '').trim();
    const password = String(body.password ?? '');

    const userRes = await db.query<any>(
      'SELECT * FROM users WHERE LOWER(username) = LOWER($1)',
      [username]
    );
    if (userRes.rows.length === 0) {
      return reply.code(401).send({ error: 'INVALID_CREDENTIALS', message: 'Invalid operator handle or password.' });
    }
    const user = userRes.rows[0];
    const valid = await verifyPassword(password, user.password_hash);
    if (!valid) {
      return reply.code(401).send({ error: 'INVALID_CREDENTIALS', message: 'Invalid operator handle or password.' });
    }

    const { rawToken, tokenHash } = generateSessionToken();
    const ttlSeconds = Number(process.env.SESSION_TTL_SECONDS ?? 86400);
    await db.query(
      `INSERT INTO sessions (id, user_id, ip_address, user_agent, expires_at)
       VALUES ($1, $2, $3, $4, NOW() + ($5 || ' seconds')::interval)`,
      [tokenHash, user.id, req.ip, req.headers['user-agent'] ?? '', String(ttlSeconds)]
    );

    await db.query('UPDATE users SET last_seen_at = NOW() WHERE id = $1', [user.id]);
    await redis.client.sadd('presence:online', user.username).catch(() => {});

    await db.query(
      `INSERT INTO audit_logs (id, user_id, action, category, ip_address, details)
       VALUES ($1, $2, 'user_login', 'auth', $3, $4::jsonb)`,
      [generateId('aud'), user.id, req.ip, JSON.stringify({ username: user.username })]
    );

    reply.setCookie('rw_session', rawToken, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      maxAge: ttlSeconds
    });

    const state = await buildFullOperatorState(user.id);
    return {
      token: rawToken,
      operator: state
    };
  });

  app.post('/api/auth/logout', { preHandler: [requireAuth] }, async (req, reply) => {
    if (req.sessionTokenHash) {
      await db.query('UPDATE sessions SET revoked = TRUE WHERE id = $1', [req.sessionTokenHash]);
    }
    if (req.authUser) {
      await redis.client.srem('presence:online', req.authUser.username).catch(() => {});
    }
    reply.clearCookie('rw_session', { path: '/' });
    return { ok: true };
  });

  app.get('/api/auth/me', { preHandler: [requireAuth] }, async (req) => {
    const state = await buildFullOperatorState(req.authUser!.id);
    return { operator: state };
  });

  // =========================================================================
  // TERMINAL COMMAND EXECUTION ROUTE
  // =========================================================================
  app.post('/api/terminal/exec', { preHandler: [requireAuth] }, async (req, reply) => {
    const userId = req.authUser!.id;
    const maxCmdPerMin = Number(process.env.COMMAND_RATE_LIMIT_PER_MINUTE ?? 120);
    const allowed = await checkRateLimit(`cmd:${userId}`, maxCmdPerMin, 60_000);
    if (!allowed) {
      return reply.code(429).send({
        ok: false,
        command: '',
        category: 'error',
        lines: ['[RATE_LIMIT] Terminal command rate exceeded. Wait before issuing further commands.']
      });
    }

    const body = (req.body as any) ?? {};
    const command = String(body.command ?? '');

    const output = await executeUserTerminalCommand(db, userId, command);
    const operator = await buildFullOperatorState(userId);

    if (output.missionCompleted) {
      broadcastRealtime({
        type: 'mission_completed',
        channelType: 'global',
        payload: {
          username: req.authUser!.username,
          ...output.missionCompleted
        }
      });
    }

    return {
      ...output,
      operator
    };
  });

  // =========================================================================
  // WORLD MAP & TOPOLOGY ROUTES
  // =========================================================================
  app.get('/api/world/map', { preHandler: [requireAuth] }, async (req) => {
    const userId = req.authUser!.id;
    const regionId = String((req.query as any)?.region ?? 'neo-cascadia');

    const regionsRes = await db.query<any>('SELECT * FROM regions ORDER BY id ASC');
    const nodesRes = await db.query<any>(
      `SELECT n.*, d.inspected, d.discovery_source,
              f.name as faction_name, f.code as faction_code, f.policy_stance,
              u.username as owner_handle, g.name as owner_group_name, g.tag as owner_group_tag
       FROM network_nodes n
       LEFT JOIN player_node_discoveries d ON d.node_id = n.id AND d.user_id = $1
       LEFT JOIN factions f ON f.id = n.faction_id
       LEFT JOIN users u ON u.id = n.owner_user_id
       LEFT JOIN groups g ON g.id = n.owner_group_id
       WHERE n.region_id = $2
       ORDER BY n.tier ASC, n.name ASC`,
      [userId, regionId]
    );

    const nodes = nodesRes.rows.map((n) => {
      const discovered = Boolean(
        n.is_public_entry || n.discovery_source !== null || n.owner_user_id === userId
      );
      if (!discovered) {
        return {
          id: n.id,
          region_id: n.region_id,
          name: 'Undiscovered Deep-Grid Node',
          hostname: '???.hidden.rw',
          ip_address: '172.16.?.?',
          category: n.category,
          tier: n.tier,
          security_level: n.security_level,
          patch_level: n.patch_level,
          status: 'unknown',
          discovered: false,
          inspected: false,
          pos_x: n.pos_x,
          pos_y: n.pos_y,
          adjacent_nodes: n.adjacent_nodes,
          services_json: [],
          description: 'Perform topology scans or inspect adjacent nodes to reveal this network.'
        };
      }
      return {
        ...n,
        discovered: true,
        inspected: Boolean(n.inspected)
      };
    });

    const eventsRes = await db.query<any>(
      `SELECT e.*, f.name as faction_name, f.code as faction_code
       FROM world_events e
       LEFT JOIN factions f ON f.id = e.faction_id
       WHERE e.region_id = $1
       ORDER BY e.created_at DESC
       LIMIT 15`,
      [regionId]
    );

    return {
      regions: regionsRes.rows,
      currentRegion: regionsRes.rows.find((r) => r.id === regionId) ?? regionsRes.rows[0],
      nodes,
      discoveredCount: nodes.filter((n) => n.discovered).length,
      totalCount: nodes.length,
      events: eventsRes.rows
    };
  });

  // =========================================================================
  // MISSIONS & ISOLATED LAB ROUTES
  // =========================================================================
  app.get('/api/missions', { preHandler: [requireAuth] }, async (req) => {
    const userId = req.authUser!.id;
    const missionsRes = await db.query<any>(
      `SELECT m.*, f.name as faction_name, f.code as faction_code,
              pm.status as player_status, pm.reward_claimed, pm.completed_at, pm.progress_json
       FROM missions m
       LEFT JOIN factions f ON f.id = m.faction_id
       LEFT JOIN player_missions pm ON pm.mission_id = m.id AND pm.user_id = $1
       WHERE m.active = TRUE
       ORDER BY m.is_lab_mission DESC, m.difficulty ASC, m.code ASC`,
      [userId]
    );

    const activeLabRes = await db.query<any>(
      `SELECT ls.*, m.code as mission_code, m.title as mission_title, m.required_profile
       FROM lab_sessions ls
       JOIN missions m ON m.id = ls.mission_id
       WHERE ls.user_id = $1 AND ls.status = 'active' AND ls.expires_at > NOW()
       ORDER BY ls.opened_at DESC LIMIT 1`,
      [userId]
    );

    const toolLogsRes = await db.query<any>(
      `SELECT * FROM tool_audit_logs WHERE user_id = $1 ORDER BY created_at DESC LIMIT 15`,
      [userId]
    );

    return {
      missions: missionsRes.rows,
      activeLabSession: activeLabRes.rows[0] ?? null,
      toolAuditLogs: toolLogsRes.rows
    };
  });

  // =========================================================================
  // SOCIAL: GROUPS, ALLIANCES, DIPLOMACY, BOUNTIES & OPEN PvP
  // =========================================================================
  app.get('/api/social/overview', { preHandler: [requireAuth] }, async (req) => {
    const groupsRes = await db.query<any>(
      `SELECT g.*, u.username as leader_handle, a.name as alliance_name, a.tag as alliance_tag,
              (SELECT COUNT(*) FROM group_members gm WHERE gm.group_id = g.id) as member_count,
              COALESCE(la.balance, 0) as treasury_rwc
       FROM groups g
       LEFT JOIN users u ON u.id = g.leader_user_id
       LEFT JOIN alliances a ON a.id = g.alliance_id
       LEFT JOIN ledger_accounts la ON la.id = ('acct-group-' || g.id)
       ORDER BY g.created_at ASC`
    );

    const membersRes = await db.query<any>(
      `SELECT gm.*, u.username, u.level, u.reputation
       FROM group_members gm
       JOIN users u ON u.id = gm.user_id
       ORDER BY gm.joined_at ASC`
    );

    const alliancesRes = await db.query<any>('SELECT * FROM alliances ORDER BY created_at ASC');
    const diplomacyRes = await db.query<any>(
      `SELECT d.*, sg.name as source_name, sg.tag as source_tag, tg.name as target_name, tg.tag as target_tag
       FROM diplomacy_relations d
       JOIN groups sg ON sg.id = d.source_group_id
       JOIN groups tg ON tg.id = d.target_group_id
       ORDER BY d.created_at DESC`
    );

    const bountiesRes = await db.query<any>(
      `SELECT b.*, iu.username as issuer_handle, tu.username as target_handle,
              n.name as target_node_name, n.hostname as target_node_hostname
       FROM bounties b
       JOIN users iu ON iu.id = b.issuer_user_id
       LEFT JOIN users tu ON tu.id = b.target_user_id
       JOIN network_nodes n ON n.id = b.target_node_id
       ORDER BY b.created_at DESC LIMIT 20`
    );

    const pvpNodesRes = await db.query<any>(
      `SELECT n.*, u.username as owner_handle, u.new_player_shield_until,
              g.name as group_name, g.tag as group_tag
       FROM network_nodes n
       LEFT JOIN users u ON u.id = n.owner_user_id
       LEFT JOIN group_members gm ON gm.user_id = n.owner_user_id
       LEFT JOIN groups g ON g.id = gm.group_id
       WHERE n.category = 'player'
       ORDER BY n.security_level DESC`
    );

    const incidentsRes = await db.query<any>(
      `SELECT p.*, au.username as attacker_handle, du.username as defender_handle,
              n.name as target_node_name, n.hostname as target_node_hostname
       FROM pvp_incidents p
       JOIN users au ON au.id = p.attacker_user_id
       LEFT JOIN users du ON du.id = p.defender_user_id
       JOIN network_nodes n ON n.id = p.target_node_id
       ORDER BY p.created_at DESC LIMIT 25`
    );

    return {
      groups: groupsRes.rows.map((g) => ({
        ...g,
        treasury_rwc: Number(g.treasury_rwc),
        member_count: Number(g.member_count),
        members: membersRes.rows.filter((m) => m.group_id === g.id)
      })),
      alliances: alliancesRes.rows,
      diplomacy: diplomacyRes.rows,
      bounties: bountiesRes.rows,
      pvpNodes: pvpNodesRes.rows,
      incidents: incidentsRes.rows
    };
  });

  app.post('/api/social/groups', { preHandler: [requireAuth] }, async (req, reply) => {
    const userId = req.authUser!.id;
    const body = (req.body as any) ?? {};
    const name = String(body.name ?? '').trim();
    const tag = String(body.tag ?? '').trim().toUpperCase();
    const description = String(body.description ?? '').trim();
    const sharedGoal = String(body.sharedGoal ?? 'Control regional relays & complete 10 operations').trim();

    if (name.length < 3 || name.length > 36 || !/^[A-Z0-9]{2,5}$/.test(tag)) {
      return reply.code(400).send({
        error: 'INVALID_GROUP_INPUT',
        message: 'Group name must be 3-36 chars and tag must be 2-5 uppercase alphanumeric chars.'
      });
    }

    const groupId = generateId('grp');
    await db.query('DELETE FROM group_members WHERE user_id = $1', [userId]);

    await db.query(
      `INSERT INTO groups (id, name, tag, description, leader_user_id, home_node_id, shared_goal)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [groupId, name, tag, description, userId, req.authUser!.home_node_id, sharedGoal]
    );

    await db.query(
      `INSERT INTO group_members (group_id, user_id, role) VALUES ($1, $2, 'leader')`,
      [groupId, userId]
    );

    await ensureLedgerAccount(db, getGroupAccountId(groupId), 'group', groupId, 1000);
    const operator = await buildFullOperatorState(userId);
    return { ok: true, groupId, operator };
  });

  app.post('/api/social/groups/:groupId/join', { preHandler: [requireAuth] }, async (req, reply) => {
    const userId = req.authUser!.id;
    const groupId = (req.params as any).groupId;

    const grp = await db.query('SELECT id FROM groups WHERE id = $1', [groupId]);
    if (grp.rows.length === 0) {
      return reply.code(404).send({ error: 'GROUP_NOT_FOUND', message: 'Group not found.' });
    }

    await db.query('DELETE FROM group_members WHERE user_id = $1', [userId]);
    await db.query(
      `INSERT INTO group_members (group_id, user_id, role) VALUES ($1, $2, 'operator')`,
      [groupId, userId]
    );

    const operator = await buildFullOperatorState(userId);
    return { ok: true, operator };
  });

  app.post('/api/social/alliances', { preHandler: [requireAuth] }, async (req, reply) => {
    const userId = req.authUser!.id;
    const body = (req.body as any) ?? {};
    const name = String(body.name ?? '').trim();
    const tag = String(body.tag ?? '').trim().toUpperCase();
    const description = String(body.description ?? '').trim();

    const gmRes = await db.query<{ group_id: string; role: string }>(
      'SELECT group_id, role FROM group_members WHERE user_id = $1',
      [userId]
    );
    if (gmRes.rows.length === 0) {
      return reply.code(400).send({
        error: 'MUST_BE_IN_GROUP',
        message: 'Join or create a hacking group before forming an alliance.'
      });
    }

    const allianceId = generateId('all');
    await db.query(
      `INSERT INTO alliances (id, name, tag, description, founder_group_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [allianceId, name, tag, description, gmRes.rows[0].group_id]
    );

    await db.query(`UPDATE groups SET alliance_id = $1 WHERE id = $2`, [
      allianceId,
      gmRes.rows[0].group_id
    ]);

    const operator = await buildFullOperatorState(userId);
    return { ok: true, allianceId, operator };
  });

  app.post('/api/social/alliances/:allianceId/join', { preHandler: [requireAuth] }, async (req, reply) => {
    const userId = req.authUser!.id;
    const allianceId = (req.params as any).allianceId;

    const gmRes = await db.query<{ group_id: string }>(
      'SELECT group_id FROM group_members WHERE user_id = $1',
      [userId]
    );
    if (gmRes.rows.length === 0) {
      return reply.code(400).send({ error: 'NO_GROUP', message: 'You must belong to a group first.' });
    }

    await db.query('UPDATE groups SET alliance_id = $1 WHERE id = $2', [
      allianceId,
      gmRes.rows[0].group_id
    ]);

    // If alliance shares intel, propagate discovered nodes across alliance members
    const operator = await buildFullOperatorState(userId);
    return { ok: true, operator };
  });

  app.post('/api/social/diplomacy', { preHandler: [requireAuth] }, async (req, reply) => {
    const userId = req.authUser!.id;
    const body = (req.body as any) ?? {};
    const targetGroupId = String(body.targetGroupId ?? '');
    const relationType = String(body.relationType ?? 'rivalry');
    const strategicObjective = String(body.strategicObjective ?? 'Contest regional relays');

    const gmRes = await db.query<{ group_id: string }>(
      'SELECT group_id FROM group_members WHERE user_id = $1',
      [userId]
    );
    if (gmRes.rows.length === 0) {
      return reply.code(400).send({ error: 'NO_GROUP', message: 'You must belong to a group.' });
    }
    const sourceGroupId = gmRes.rows[0].group_id;
    if (sourceGroupId === targetGroupId) {
      return reply.code(400).send({ error: 'SELF_DIPLOMACY', message: 'Cannot set diplomacy with own group.' });
    }

    await db.query(
      `INSERT INTO diplomacy_relations (id, source_group_id, target_group_id, relation_type, strategic_objective)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (source_group_id, target_group_id)
       DO UPDATE SET relation_type = EXCLUDED.relation_type, strategic_objective = EXCLUDED.strategic_objective`,
      [generateId('dip'), sourceGroupId, targetGroupId, relationType, strategicObjective]
    );

    return { ok: true };
  });

  app.post('/api/pvp/attack', { preHandler: [requireAuth] }, async (req, reply) => {
    const userId = req.authUser!.id;
    const body = (req.body as any) ?? {};
    const targetNodeId = String(body.targetNodeId ?? '');
    const method = (body.method ?? 'probe') as 'probe' | 'heist' | 'disrupt' | 'contest';

    try {
      const result = await executePvpOperation(db, {
        attackerUserId: userId,
        targetNodeIdentifier: targetNodeId,
        method
      });

      broadcastRealtime({
        type: 'pvp_incident',
        channelType: 'global',
        payload: result
      });

      const operator = await buildFullOperatorState(userId);
      return { ok: true, result, operator };
    } catch (err: any) {
      return reply.code(400).send({
        error: err?.code ?? 'PVP_ERROR',
        message: err?.message ?? String(err)
      });
    }
  });

  app.post('/api/pvp/defend', { preHandler: [requireAuth] }, async (req, reply) => {
    const userId = req.authUser!.id;
    const body = (req.body as any) ?? {};
    const action = (body.action ?? 'patch') as
      | 'monitor'
      | 'patch'
      | 'segment'
      | 'decoy'
      | 'ir'
      | 'recover';

    try {
      const result = await executeDefenseAction(db, userId, action);
      const operator = await buildFullOperatorState(userId);
      return { ok: true, result, operator };
    } catch (err: any) {
      return reply.code(400).send({
        error: err?.code ?? 'DEFENSE_ERROR',
        message: err?.message ?? String(err)
      });
    }
  });

  app.post('/api/pvp/bounties', { preHandler: [requireAuth] }, async (req, reply) => {
    const userId = req.authUser!.id;
    const body = (req.body as any) ?? {};
    const targetNodeId = String(body.targetNodeId ?? '');
    const rewardRwc = Math.floor(Number(body.rewardRwc ?? 0));
    const reason = String(body.reason ?? 'High-priority syndicate bounty').trim();

    if (!targetNodeId || rewardRwc < 100) {
      return reply.code(400).send({
        error: 'INVALID_BOUNTY',
        message: 'Specify a target player node and minimum 100 RWC bounty reward.'
      });
    }

    const nodeRes = await db.query<any>('SELECT * FROM network_nodes WHERE id = $1', [targetNodeId]);
    if (nodeRes.rows.length === 0) {
      return reply.code(404).send({ error: 'NODE_NOT_FOUND', message: 'Target node not found.' });
    }

    const bountyId = generateId('bty');
    await executeLedgerTransfer(db, {
      idempotencyKey: `bounty-escrow-${bountyId}`,
      fromAccountId: getUserAccountId(userId),
      toAccountId: SYSTEM_MINT_ACCOUNT_ID,
      amount: rewardRwc,
      txType: 'bounty_escrow',
      referenceId: bountyId,
      memo: `Bounty escrow on ${nodeRes.rows[0].hostname}`
    });

    await db.query(
      `INSERT INTO bounties (id, issuer_user_id, target_node_id, target_user_id, reward_rwc, reason, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'open')`,
      [bountyId, userId, targetNodeId, nodeRes.rows[0].owner_user_id ?? null, rewardRwc, reason]
    );

    const operator = await buildFullOperatorState(userId);
    return { ok: true, bountyId, operator };
  });

  // =========================================================================
  // ECONOMY: MARKET, INVENTORY & LEDGER ROUTES
  // =========================================================================
  app.get('/api/economy/overview', { preHandler: [requireAuth] }, async (req) => {
    const userId = req.authUser!.id;
    const userAccountId = getUserAccountId(userId);
    const balance = await getAccountBalance(db, userAccountId);

    const regRes = await db.query<any>(`SELECT market_multiplier FROM regions WHERE id = 'neo-cascadia'`);
    const multiplier = Number(regRes.rows[0]?.market_multiplier ?? 1.0);

    const itemsRes = await db.query<any>('SELECT * FROM market_items ORDER BY tier ASC, base_price_rwc ASC');
    const invRes = await db.query<any>(
      `SELECT pi.*, m.code, m.name, m.category, m.tier, m.effects_json, m.description
       FROM player_inventory pi
       JOIN market_items m ON m.id = pi.item_id
       WHERE pi.user_id = $1
       ORDER BY pi.acquired_at DESC`,
      [userId]
    );

    const txRes = await db.query<any>(
      `SELECT * FROM ledger_transactions
       WHERE from_account_id = $1 OR to_account_id = $1
       ORDER BY created_at DESC
       LIMIT 30`,
      [userAccountId]
    );

    return {
      accountId: userAccountId,
      balanceRwc: balance,
      marketMultiplier: multiplier,
      marketItems: itemsRes.rows.map((it) => ({
        ...it,
        base_price_rwc: Number(it.base_price_rwc),
        effective_price_rwc: Math.max(50, Math.round(Number(it.base_price_rwc) * multiplier))
      })),
      inventory: invRes.rows,
      transactions: txRes.rows.map((t) => ({
        ...t,
        amount: Number(t.amount)
      }))
    };
  });

  app.post('/api/economy/buy', { preHandler: [requireAuth] }, async (req, reply) => {
    const userId = req.authUser!.id;
    const body = (req.body as any) ?? {};
    const itemId = String(body.itemId ?? '');
    const idempotencyKey = String(body.idempotencyKey ?? `buy-${userId}-${itemId}-${Date.now()}`);

    const itemRes = await db.query<any>('SELECT * FROM market_items WHERE id = $1', [itemId]);
    if (itemRes.rows.length === 0) {
      return reply.code(404).send({ error: 'ITEM_NOT_FOUND', message: 'Market item not found.' });
    }
    const item = itemRes.rows[0];

    const regRes = await db.query<any>(`SELECT market_multiplier FROM regions WHERE id = 'neo-cascadia'`);
    const multiplier = Number(regRes.rows[0]?.market_multiplier ?? 1.0);
    const price = Math.max(50, Math.round(Number(item.base_price_rwc) * multiplier));

    try {
      const tx = await executeLedgerTransfer(db, {
        idempotencyKey,
        fromAccountId: getUserAccountId(userId),
        toAccountId: SYSTEM_MINT_ACCOUNT_ID,
        amount: price,
        txType: 'market_purchase',
        referenceId: item.id,
        memo: `Purchased ${item.name}`
      });

      if (!tx.idempotentReplay) {
        await db.query(
          `INSERT INTO player_inventory (id, user_id, item_id, quantity, equipped)
           VALUES ($1, $2, $3, 1, TRUE)
           ON CONFLICT (user_id, item_id)
           DO UPDATE SET quantity = player_inventory.quantity + 1`,
          [generateId('inv'), userId, item.id]
        );
      }

      const operator = await buildFullOperatorState(userId);
      return { ok: true, transaction: tx, operator };
    } catch (err: any) {
      return reply.code(400).send({
        error: err?.code ?? 'PURCHASE_FAILED',
        message: err?.message ?? String(err)
      });
    }
  });

  app.post('/api/economy/transfer', { preHandler: [requireAuth] }, async (req, reply) => {
    const userId = req.authUser!.id;
    const body = (req.body as any) ?? {};
    const toUsername = String(body.toUsername ?? '').trim();
    const amount = Math.floor(Number(body.amount ?? 0));
    const memo = String(body.memo ?? '').trim();
    const idempotencyKey = String(body.idempotencyKey ?? '');

    if (!idempotencyKey) {
      return reply.code(400).send({
        error: 'MISSING_IDEMPOTENCY_KEY',
        message: 'idempotencyKey is required for atomic ledger transfers.'
      });
    }

    const recipientRes = await db.query<{ id: string; username: string }>(
      'SELECT id, username FROM users WHERE LOWER(username) = LOWER($1)',
      [toUsername]
    );
    if (recipientRes.rows.length === 0) {
      return reply.code(404).send({
        error: 'RECIPIENT_NOT_FOUND',
        message: `Recipient operator "${toUsername}" not found.`
      });
    }

    try {
      const tx = await executeLedgerTransfer(db, {
        idempotencyKey,
        fromAccountId: getUserAccountId(userId),
        toAccountId: getUserAccountId(recipientRes.rows[0].id),
        amount,
        txType: 'player_transfer',
        memo: memo || `Transfer to ${recipientRes.rows[0].username}`
      });

      const operator = await buildFullOperatorState(userId);
      return { ok: true, transaction: tx, operator };
    } catch (err: any) {
      return reply.code(400).send({
        error: err?.code ?? 'TRANSFER_FAILED',
        message: err?.message ?? String(err)
      });
    }
  });

  // =========================================================================
  // INTEL, WORLD EVENTS, FACTIONS & AUDIT LOGS
  // =========================================================================
  app.get('/api/intel/overview', { preHandler: [requireAuth] }, async (req) => {
    const userId = req.authUser!.id;
    const factionsRes = await db.query<any>('SELECT * FROM factions ORDER BY category ASC, name ASC');
    const eventsRes = await db.query<any>(
      `SELECT e.*, f.name as faction_name, f.code as faction_code
       FROM world_events e
       LEFT JOIN factions f ON f.id = e.faction_id
       ORDER BY e.created_at DESC
       LIMIT 25`
    );
    const incidentsRes = await db.query<any>(
      `SELECT p.*, au.username as attacker_handle, du.username as defender_handle,
              n.name as target_node_name, n.hostname as target_node_hostname
       FROM pvp_incidents p
       JOIN users au ON au.id = p.attacker_user_id
       LEFT JOIN users du ON du.id = p.defender_user_id
       JOIN network_nodes n ON n.id = p.target_node_id
       ORDER BY p.created_at DESC
       LIMIT 25`
    );
    const toolLogsRes = await db.query<any>(
      `SELECT * FROM tool_audit_logs WHERE user_id = $1 ORDER BY created_at DESC LIMIT 25`,
      [userId]
    );
    const auditLogsRes = await db.query<any>(
      `SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 30`
    );

    return {
      factions: factionsRes.rows,
      events: eventsRes.rows,
      incidents: incidentsRes.rows,
      toolAuditLogs: toolLogsRes.rows,
      auditLogs: auditLogsRes.rows
    };
  });

  app.post('/api/intel/faction-interact', { preHandler: [requireAuth] }, async (req, reply) => {
    const userId = req.authUser!.id;
    const body = (req.body as any) ?? {};
    const factionId = String(body.factionId ?? 'fac-aegis-gov');
    const action = String(body.action ?? 'negotiating') as any;

    const reaction = await triggerFactionReaction(db, {
      factionId,
      triggerUserId: userId,
      triggerReason: `operator diplomatic/contract interaction by ${req.authUser!.username}`,
      preferredReaction: action
    });

    if (!reaction) {
      return reply.code(404).send({ error: 'FACTION_NOT_FOUND', message: 'Faction not found.' });
    }

    broadcastRealtime({
      type: 'world_event',
      channelType: 'global',
      payload: reaction
    });

    const operator = await buildFullOperatorState(userId);
    return { ok: true, reaction, operator };
  });

  app.post('/api/intel/world-event', { preHandler: [requireAuth] }, async () => {
    const event = await generateDynamicWorldEvent(db);
    broadcastRealtime({
      type: 'world_event',
      channelType: 'global',
      payload: event
    });
    return { ok: true, event };
  });

  // =========================================================================
  // CHAT & WEBSOCKET GATEWAY
  // =========================================================================
  app.get('/api/chat', { preHandler: [requireAuth] }, async (req) => {
    const userId = req.authUser!.id;
    const gmRes = await db.query<{ group_id: string; alliance_id: string | null }>(
      `SELECT gm.group_id, g.alliance_id
       FROM group_members gm
       JOIN groups g ON g.id = gm.group_id
       WHERE gm.user_id = $1`,
      [userId]
    );
    const groupId = gmRes.rows[0]?.group_id ?? 'none';
    const allianceId = gmRes.rows[0]?.alliance_id ?? 'none';

    const msgsRes = await db.query<any>(
      `SELECT * FROM chat_messages
       WHERE (channel_type = 'global')
          OR (channel_type = 'group' AND channel_id = $1)
          OR (channel_type = 'alliance' AND channel_id = $2)
       ORDER BY created_at DESC
       LIMIT 50`,
      [groupId, allianceId]
    );

    return {
      messages: msgsRes.rows.reverse()
    };
  });

  app.post('/api/chat', { preHandler: [requireAuth] }, async (req, reply) => {
    const user = req.authUser!;
    const allowed = await checkRateLimit(`chat:${user.id}`, 30, 60_000);
    if (!allowed) {
      return reply.code(429).send({ error: 'CHAT_RATE_LIMIT', message: 'Sending messages too quickly.' });
    }

    const body = (req.body as any) ?? {};
    const channelType = (body.channelType ?? 'global') as 'global' | 'group' | 'alliance';
    const rawMsg = String(body.message ?? '').trim();

    if (!rawMsg || rawMsg.length > 400) {
      return reply.code(400).send({ error: 'INVALID_MESSAGE', message: 'Message must be 1-400 characters.' });
    }

    const gmRes = await db.query<{ group_id: string; alliance_id: string | null }>(
      `SELECT gm.group_id, g.alliance_id
       FROM group_members gm
       JOIN groups g ON g.id = gm.group_id
       WHERE gm.user_id = $1`,
      [user.id]
    );

    let channelId = 'global';
    if (channelType === 'group') {
      if (!gmRes.rows[0]?.group_id) {
        return reply.code(400).send({ error: 'NOT_IN_GROUP', message: 'You are not in a hacking group.' });
      }
      channelId = gmRes.rows[0].group_id;
    } else if (channelType === 'alliance') {
      if (!gmRes.rows[0]?.alliance_id) {
        return reply.code(400).send({ error: 'NOT_IN_ALLIANCE', message: 'Your group is not in an alliance.' });
      }
      channelId = gmRes.rows[0].alliance_id;
    }

    const sanitized = escapeTerminalText(rawMsg);
    const msgId = generateId('msg');
    const inserted = await db.query<any>(
      `INSERT INTO chat_messages (id, channel_type, channel_id, sender_user_id, sender_handle, message)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [msgId, channelType, channelId, user.id, user.username, sanitized]
    );

    const chatRecord = inserted.rows[0];
    broadcastRealtime({
      type: 'chat_message',
      channelType,
      channelId,
      payload: chatRecord
    });

    return { ok: true, message: chatRecord };
  });

  // WebSocket Gateway
  app.get('/ws', { websocket: true }, async (socket, req) => {
    const user = await resolveSessionUser(req);
    if (!user) {
      socket.close(4001, 'Unauthorized');
      return;
    }

    const gmRes = await db.query<{ group_id: string; alliance_id: string | null }>(
      `SELECT gm.group_id, g.alliance_id
       FROM group_members gm
       JOIN groups g ON g.id = gm.group_id
       WHERE gm.user_id = $1`,
      [user.id]
    );

    const clientEntry = {
      socket,
      userId: user.id,
      username: user.username,
      groupId: gmRes.rows[0]?.group_id ?? null,
      allianceId: gmRes.rows[0]?.alliance_id ?? null
    };

    wsClients.add(clientEntry);
    await redis.client.sadd('presence:online', user.username).catch(() => {});

    socket.send(
      JSON.stringify({
        type: 'connected',
        payload: {
          username: user.username,
          timestamp: new Date().toISOString()
        }
      })
    );

    socket.on('message', async (rawBuf: Buffer) => {
      try {
        const msg = JSON.parse(rawBuf.toString('utf-8'));
        if (msg.type === 'ping') {
          socket.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
        }
      } catch {}
    });

    socket.on('close', () => {
      wsClients.delete(clientEntry);
    });
  });

  // Serve built static frontend from dist/client if it exists
  const clientDistDir = path.resolve(__dirname, '../../dist/client');
  if (fs.existsSync(clientDistDir)) {
    await app.register(fastifyStatic, {
      root: clientDistDir,
      prefix: '/'
    });

    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/') || req.url.startsWith('/ws')) {
        reply.code(404).send({ error: 'NOT_FOUND', message: 'Endpoint not found' });
      } else {
        reply.sendFile('index.html');
      }
    });
  }

  return app;
}
