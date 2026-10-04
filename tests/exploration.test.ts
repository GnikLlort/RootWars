import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHarness, registerOperator, runCommand, TestHarness, AuthSession } from './support/harness.js';

/**
 * Regression: a stale adjacency reference (e.g. a player-owned PvP node in a
 * world seeded without demo fixtures) used to violate
 * `player_node_discoveries_node_id_fkey` and turn `inspect` into an HTTP 500.
 * Exploration must degrade gracefully and never record a discovery that does not
 * correspond to an existing node.
 */
describe('World exploration with non-demo world data', () => {
  let h: TestHarness;
  let session: AuthSession;

  beforeAll(async () => {
    // A production-like world: no demo accounts, therefore no player-owned nodes.
    h = await createHarness({ seedDemo: false });
    session = await registerOperator(h.app, 'explorer_zero', 'Explore!2026');
  }, 120000);

  afterAll(async () => {
    await h.close();
  });

  it('inspects NPC nodes whose adjacency lists reference non-existent player nodes', async () => {
    // Demo fixtures created the four player-owned PvP nodes; this world has none
    // (only the home node registration creates for the new operator).
    const demoNodes = await h.db.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM network_nodes WHERE id LIKE 'node-pvp-%'`
    );
    expect(demoNodes.rows[0].count).toBe(0);

    for (const target of ['node-infra-ixp', 'node-crim-blacksun']) {
      const res = await runCommand(h.app, session, `inspect --target ${target}`);
      expect(res.statusCode).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.lines.join('\n')).toMatch(/NODE INSPECTION REPORT/);
    }
  }, 60000);

  it('never records a discovery row that does not reference an existing node', async () => {
    const orphans = await h.db.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count
       FROM player_node_discoveries d
       LEFT JOIN network_nodes n ON n.id = d.node_id
       WHERE n.id IS NULL`
    );
    expect(orphans.rows[0].count).toBe(0);
  }, 60000);

  it('still discovers valid neighbours and the scanned node itself', async () => {
    const discoveries = await h.db.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count
       FROM player_node_discoveries d
       JOIN network_nodes n ON n.id = d.node_id
       WHERE d.user_id = $1`,
      [session.userId]
    );
    expect(discoveries.rows[0].count).toBeGreaterThan(0);

    const inspected = await h.db.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM player_node_discoveries WHERE user_id = $1 AND inspected = TRUE`,
      [session.userId]
    );
    expect(inspected.rows[0].count).toBeGreaterThanOrEqual(2);
  }, 60000);

  it('ignores a stale adjacency reference during a PvP probe instead of aborting the operation', async () => {
    const defender = await registerOperator(h.app, 'explorer_owner', 'Explore!2026');
    // Turn an existing NPC node into a player-owned node whose adjacency list
    // contains a stale reference, then probe it.
    await h.db.query(
      `UPDATE network_nodes
       SET category = 'player',
           owner_user_id = $1,
           adjacent_nodes = '["node-does-not-exist","node-infra-hydro"]'::jsonb,
           security_level = 1,
           patch_level = 1,
           defense_config = '{"monitoring":0,"patching":0,"segmentation":0,"decoys":0,"incident_response":0,"recovery":0}'::jsonb,
           last_attacked_at = NULL,
           status = 'online',
           outage_until = NULL
       WHERE id = 'node-infra-helios'`,
      [defender.userId]
    );
    // New-player shields would otherwise block the probe regardless of adjacency data.
    await h.db.query(`UPDATE users SET new_player_shield_until = NULL WHERE id = $1`, [defender.userId]);

    const res = await runCommand(h.app, session, 'pvp attack --target node-infra-helios --method probe');
    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);

    const orphans = await h.db.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count
       FROM player_node_discoveries d
       LEFT JOIN network_nodes n ON n.id = d.node_id
       WHERE n.id IS NULL`
    );
    expect(orphans.rows[0].count).toBe(0);
  }, 60000);
});
