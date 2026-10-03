-- ROOTWARS PostgreSQL Schema Migration 001
-- Durable source of truth for accounts, world map, factions, missions, lab sessions,
-- transactional ledger, open PvP, groups/alliances, world events, outbox jobs, and audit logs.

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS regions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  threat_index INTEGER NOT NULL DEFAULT 35 CHECK (threat_index BETWEEN 0 AND 100),
  market_multiplier NUMERIC(6,3) NOT NULL DEFAULT 1.000,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'player' CHECK (role IN ('player', 'admin')),
  level INTEGER NOT NULL DEFAULT 1 CHECK (level >= 1),
  xp INTEGER NOT NULL DEFAULT 0 CHECK (xp >= 0),
  reputation INTEGER NOT NULL DEFAULT 100,
  heat INTEGER NOT NULL DEFAULT 0 CHECK (heat BETWEEN 0 AND 100),
  connected_node_id TEXT,
  active_lab_session_id TEXT,
  home_node_id TEXT,
  new_player_shield_until TIMESTAMPTZ,
  account_frozen_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ip_address TEXT,
  user_agent TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS factions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  category TEXT NOT NULL CHECK (category IN ('government', 'bank', 'exchange', 'corporate', 'media', 'logistics', 'infrastructure', 'security_agency', 'syndicate')),
  region_id TEXT NOT NULL REFERENCES regions(id),
  description TEXT NOT NULL,
  alert_level INTEGER NOT NULL DEFAULT 20 CHECK (alert_level BETWEEN 0 AND 100),
  policy_stance TEXT NOT NULL DEFAULT 'standard' CHECK (policy_stance IN ('open', 'standard', 'heightened', 'lockdown', 'amnesty_negotiation')),
  price_modifier NUMERIC(6,3) NOT NULL DEFAULT 1.000,
  active_advisory TEXT,
  last_reaction_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_factions_region_id ON factions(region_id);

CREATE TABLE IF NOT EXISTS network_nodes (
  id TEXT PRIMARY KEY,
  region_id TEXT NOT NULL REFERENCES regions(id),
  faction_id TEXT REFERENCES factions(id),
  owner_user_id TEXT REFERENCES users(id),
  owner_group_id TEXT,
  name TEXT NOT NULL,
  hostname TEXT NOT NULL UNIQUE,
  ip_address TEXT NOT NULL UNIQUE,
  category TEXT NOT NULL CHECK (category IN ('government', 'banking', 'exchange', 'corporate', 'media', 'logistics', 'infrastructure', 'security', 'criminal', 'player')),
  tier INTEGER NOT NULL DEFAULT 1 CHECK (tier BETWEEN 1 AND 4),
  security_level INTEGER NOT NULL DEFAULT 30 CHECK (security_level BETWEEN 1 AND 100),
  patch_level INTEGER NOT NULL DEFAULT 50 CHECK (patch_level BETWEEN 0 AND 100),
  status TEXT NOT NULL DEFAULT 'online' CHECK (status IN ('online', 'degraded', 'contested', 'outage', 'lockdown')),
  is_public_entry BOOLEAN NOT NULL DEFAULT FALSE,
  pos_x INTEGER NOT NULL DEFAULT 50,
  pos_y INTEGER NOT NULL DEFAULT 50,
  adjacent_nodes JSONB NOT NULL DEFAULT '[]'::jsonb,
  services_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  defense_config JSONB NOT NULL DEFAULT '{"monitoring":1,"patching":1,"segmentation":1,"decoys":0,"incident_response":1,"recovery":1}'::jsonb,
  contested_by_group_id TEXT,
  outage_until TIMESTAMPTZ,
  last_attacked_at TIMESTAMPTZ,
  description TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_network_nodes_region_id ON network_nodes(region_id);
CREATE INDEX IF NOT EXISTS idx_network_nodes_faction_id ON network_nodes(faction_id);
CREATE INDEX IF NOT EXISTS idx_network_nodes_owner_user_id ON network_nodes(owner_user_id);

CREATE TABLE IF NOT EXISTS player_node_discoveries (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL REFERENCES network_nodes(id) ON DELETE CASCADE,
  discovery_source TEXT NOT NULL DEFAULT 'initial',
  inspected BOOLEAN NOT NULL DEFAULT FALSE,
  discovered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, node_id)
);

CREATE INDEX IF NOT EXISTS idx_discoveries_user_id ON player_node_discoveries(user_id);

CREATE TABLE IF NOT EXISTS ledger_accounts (
  id TEXT PRIMARY KEY,
  owner_type TEXT NOT NULL CHECK (owner_type IN ('system', 'user', 'group', 'faction')),
  owner_id TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'RWC',
  balance BIGINT NOT NULL DEFAULT 0 CHECK (balance >= 0),
  frozen BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (owner_type, owner_id, currency)
);

CREATE INDEX IF NOT EXISTS idx_ledger_accounts_owner ON ledger_accounts(owner_type, owner_id);

CREATE TABLE IF NOT EXISTS ledger_transactions (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  from_account_id TEXT NOT NULL REFERENCES ledger_accounts(id),
  to_account_id TEXT NOT NULL REFERENCES ledger_accounts(id),
  amount BIGINT NOT NULL CHECK (amount > 0),
  tx_type TEXT NOT NULL CHECK (tx_type IN (
    'initial_grant',
    'mission_reward',
    'player_transfer',
    'market_purchase',
    'pvp_seizure',
    'bounty_escrow',
    'bounty_payout',
    'group_deposit',
    'compliance_fine',
    'recovery_cost'
  )),
  reference_id TEXT,
  memo TEXT NOT NULL DEFAULT '',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (from_account_id <> to_account_id)
);

CREATE INDEX IF NOT EXISTS idx_ledger_tx_from ON ledger_transactions(from_account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ledger_tx_to ON ledger_transactions(to_account_id, created_at DESC);

CREATE TABLE IF NOT EXISTS missions (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('lab_recon', 'lab_audit', 'lab_incident', 'world_recon', 'world_policy', 'faction_response')),
  is_lab_mission BOOLEAN NOT NULL DEFAULT FALSE,
  faction_id TEXT REFERENCES factions(id),
  target_node_id TEXT REFERENCES network_nodes(id),
  lab_target_ip TEXT,
  lab_target_hostname TEXT,
  lab_services_spec JSONB NOT NULL DEFAULT '[]'::jsonb,
  required_profile TEXT,
  expected_ports JSONB NOT NULL DEFAULT '[]'::jsonb,
  difficulty INTEGER NOT NULL DEFAULT 1 CHECK (difficulty BETWEEN 1 AND 5),
  reward_rwc BIGINT NOT NULL CHECK (reward_rwc > 0),
  reward_xp INTEGER NOT NULL DEFAULT 100,
  briefing TEXT NOT NULL,
  objectives_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS player_missions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'accepted' CHECK (status IN ('accepted', 'lab_open', 'completed', 'expired')),
  progress_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  lab_ip_assigned TEXT,
  reward_claimed BOOLEAN NOT NULL DEFAULT FALSE,
  accepted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  UNIQUE (user_id, mission_id)
);

CREATE INDEX IF NOT EXISTS idx_player_missions_user ON player_missions(user_id, status);

CREATE TABLE IF NOT EXISTS lab_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  assigned_subnet TEXT NOT NULL,
  target_ip TEXT NOT NULL,
  target_hostname TEXT NOT NULL,
  allowed_profiles JSONB NOT NULL DEFAULT '["quick","service","full-ports","compliance-audit"]'::jsonb,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed', 'expired')),
  opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  closed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_lab_sessions_user ON lab_sessions(user_id, status);

CREATE TABLE IF NOT EXISTS tool_audit_logs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lab_session_id TEXT REFERENCES lab_sessions(id),
  mission_id TEXT REFERENCES missions(id),
  tool_name TEXT NOT NULL,
  profile TEXT NOT NULL,
  target_ip TEXT NOT NULL,
  sanitized_args JSONB NOT NULL,
  allowed BOOLEAN NOT NULL,
  rejection_reason TEXT,
  isolation_mode TEXT NOT NULL,
  raw_output TEXT NOT NULL DEFAULT '',
  discovered_ports JSONB NOT NULL DEFAULT '[]'::jsonb,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tool_audit_user ON tool_audit_logs(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS market_items (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('scanner', 'stealth', 'defense', 'exploit_sim', 'recovery')),
  tier INTEGER NOT NULL DEFAULT 1 CHECK (tier BETWEEN 1 AND 4),
  base_price_rwc BIGINT NOT NULL CHECK (base_price_rwc > 0),
  effects_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  description TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS player_inventory (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL REFERENCES market_items(id) ON DELETE CASCADE,
  quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity >= 0),
  equipped BOOLEAN NOT NULL DEFAULT TRUE,
  acquired_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, item_id)
);

CREATE INDEX IF NOT EXISTS idx_inventory_user ON player_inventory(user_id);

CREATE TABLE IF NOT EXISTS alliances (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  tag TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  founder_group_id TEXT,
  permissions_json JSONB NOT NULL DEFAULT '{"share_intel":true,"mutual_defense":true,"coordinated_ops":true,"treasury_access":false}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  tag TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  leader_user_id TEXT NOT NULL REFERENCES users(id),
  alliance_id TEXT REFERENCES alliances(id) ON DELETE SET NULL,
  home_node_id TEXT REFERENCES network_nodes(id),
  shared_goal TEXT NOT NULL DEFAULT 'Control 3 regional nodes & complete 10 group operations',
  goal_progress INTEGER NOT NULL DEFAULT 0,
  goal_target INTEGER NOT NULL DEFAULT 10,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS group_members (
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'operator' CHECK (role IN ('leader', 'officer', 'operator', 'recruit')),
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (group_id, user_id),
  UNIQUE (user_id)
);

CREATE TABLE IF NOT EXISTS diplomacy_relations (
  id TEXT PRIMARY KEY,
  source_group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  target_group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  relation_type TEXT NOT NULL CHECK (relation_type IN ('allied', 'non_aggression', 'rivalry', 'war')),
  strategic_objective TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (source_group_id, target_group_id),
  CHECK (source_group_id <> target_group_id)
);

CREATE TABLE IF NOT EXISTS bounties (
  id TEXT PRIMARY KEY,
  issuer_user_id TEXT NOT NULL REFERENCES users(id),
  target_node_id TEXT NOT NULL REFERENCES network_nodes(id),
  target_user_id TEXT REFERENCES users(id),
  reward_rwc BIGINT NOT NULL CHECK (reward_rwc > 0),
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'claimed', 'cancelled')),
  claimed_by_user_id TEXT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  claimed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS pvp_incidents (
  id TEXT PRIMARY KEY,
  attacker_user_id TEXT NOT NULL REFERENCES users(id),
  attacker_group_id TEXT,
  defender_user_id TEXT REFERENCES users(id),
  defender_group_id TEXT,
  target_node_id TEXT NOT NULL REFERENCES network_nodes(id),
  operation_method TEXT NOT NULL CHECK (operation_method IN ('probe', 'heist', 'disrupt', 'contest')),
  outcome TEXT NOT NULL CHECK (outcome IN ('success', 'partial', 'repelled', 'decoys_triggered')),
  attack_score INTEGER NOT NULL,
  defense_score INTEGER NOT NULL,
  rwc_stolen BIGINT NOT NULL DEFAULT 0 CHECK (rwc_stolen >= 0),
  intel_exposed JSONB NOT NULL DEFAULT '[]'::jsonb,
  node_status_after TEXT NOT NULL,
  mitigation_applied TEXT,
  recovered BOOLEAN NOT NULL DEFAULT FALSE,
  summary TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pvp_incidents_attacker ON pvp_incidents(attacker_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pvp_incidents_defender ON pvp_incidents(defender_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pvp_incidents_target_node ON pvp_incidents(target_node_id, created_at DESC);

CREATE TABLE IF NOT EXISTS world_events (
  id TEXT PRIMARY KEY,
  region_id TEXT NOT NULL REFERENCES regions(id),
  faction_id TEXT REFERENCES factions(id),
  event_type TEXT NOT NULL CHECK (event_type IN ('election', 'sanction', 'leak', 'market_shock', 'strike', 'outage', 'security_incident', 'faction_reaction')),
  severity TEXT NOT NULL DEFAULT 'medium' CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  effects_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_world_events_region ON world_events(region_id, created_at DESC);

CREATE TABLE IF NOT EXISTS chat_messages (
  id TEXT PRIMARY KEY,
  channel_type TEXT NOT NULL CHECK (channel_type IN ('global', 'group', 'alliance', 'system')),
  channel_id TEXT NOT NULL DEFAULT 'global',
  sender_user_id TEXT REFERENCES users(id),
  sender_handle TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chat_channel ON chat_messages(channel_type, channel_id, created_at DESC);

CREATE TABLE IF NOT EXISTS outbox_jobs (
  id TEXT PRIMARY KEY,
  job_type TEXT NOT NULL CHECK (job_type IN ('lab_scan', 'faction_reaction', 'world_event_tick', 'mission_timer', 'node_recovery', 'realtime_broadcast')),
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  run_after TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_by TEXT,
  locked_at TIMESTAMPTZ,
  result_json JSONB,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_outbox_pending ON outbox_jobs(status, run_after) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  action TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('auth', 'command', 'economy', 'pvp', 'group', 'alliance', 'lab', 'faction', 'admin')),
  target_id TEXT,
  ip_address TEXT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at DESC);
