import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHarness, registerOperator, runCommand, TestHarness, AuthSession } from './support/harness.js';

/**
 * End-to-end lab mission flow through the real HTTP terminal route.
 *
 * The sandbox/CI this runs in has no isolated Docker lab endpoint, so the scan
 * must FAIL CLOSED: no ports discovered, no mission credit, no ledger movement,
 * and an audit record explaining that no isolated backend was available. This is
 * the honest behavior the previous "network namespace" runner pretended to have.
 */
describe('Isolated lab mission flow (fail-closed without a lab Docker endpoint)', () => {
  let h: TestHarness;
  let session: AuthSession;

  beforeAll(async () => {
    delete process.env.LAB_DOCKER_HOST;
    delete process.env.LAB_ALLOW_HOST_DOCKER;
    h = await createHarness();
    session = await registerOperator(h.app, 'lab_flow_operator', 'LabFlow!2026');
  }, 120000);

  afterAll(async () => {
    await h.close();
  });

  it('accepts, opens and closes a lab mission with the assigned target address', async () => {
    const accept = await runCommand(h.app, session, 'accept --job msn-lab-01');
    expect(accept.statusCode).toBe(200);
    expect(accept.body.ok).toBe(true);
    expect(accept.body.lines.join('\n')).toMatch(/Accepted Contract \[LAB-01\]/);

    const open = await runCommand(h.app, session, 'lab open --mission msn-lab-01');
    expect(open.statusCode).toBe(200);
    expect(open.body.ok).toBe(true);
    expect(open.body.data.targetIp).toBe('10.240.10.10');
    expect(open.body.lines.join('\n')).toMatch(/PROVISIONED ISOLATED LAB ENVIRONMENT/);
    expect(open.body.lines.join('\n')).toMatch(/Docker internal-only lab network/);

    const dbSession = await h.db.query<any>(
      `SELECT target_ip, status FROM lab_sessions WHERE user_id = $1 AND status = 'active'`,
      [session.userId]
    );
    expect(dbSession.rows).toHaveLength(1);
    expect(dbSession.rows[0].target_ip).toBe('10.240.10.10');

    const close = await runCommand(h.app, session, 'lab close');
    expect(close.body.lines.join('\n')).toMatch(/Closed active lab session/);
    const after = await h.db.query<any>(
      `SELECT status FROM lab_sessions WHERE user_id = $1 ORDER BY opened_at DESC LIMIT 1`,
      [session.userId]
    );
    expect(after.rows[0].status).toBe('closed');
  }, 60000);

  it('rejects a scan against a target that is not the mission assignment and audits it', async () => {
    await runCommand(h.app, session, 'lab open --mission msn-lab-01');

    const res = await runCommand(h.app, session, 'nmap --profile quick --target 10.240.20.15');
    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(false);
    const output = res.body.lines.join('\n');
    expect(output).toMatch(/UNAUTHORIZED_LAB_TARGET/);
    expect(output).toMatch(/only permits scanning 10\.240\.10\.10/);

    const audit = await h.db.query<any>(
      `SELECT allowed, rejection_reason, isolation_mode, discovered_ports
       FROM tool_audit_logs WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [session.userId]
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].allowed).toBe(false);
    expect(audit.rows[0].rejection_reason).toMatch(/Target mismatch/);
    expect(audit.rows[0].isolation_mode).toBe('not-executed');
    expect(audit.rows[0].discovered_ports).toEqual([]);
  }, 60000);

  it('fails closed and reports the missing isolated backend for the assigned target', async () => {
    const balanceBefore = await h.db.query<any>(
      `SELECT balance FROM ledger_accounts WHERE id = 'acct-user-${session.userId}'`
    );
    const missionBefore = await h.db.query<any>(
      `SELECT status FROM player_missions WHERE user_id = $1 AND mission_id = 'msn-lab-01'`,
      [session.userId]
    );

    const res = await runCommand(h.app, session, 'nmap --profile service');
    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(false);
    const output = res.body.lines.join('\n');
    expect(output).toMatch(/LAB_POLICY_DENIED/);
    expect(output).toMatch(/LAB_BACKEND_UNAVAILABLE/);
    expect(output).toMatch(/No dedicated lab Docker endpoint/);
    expect(output).toMatch(/no mission progress was credited|No scan was executed/i);

    const audit = await h.db.query<any>(
      `SELECT allowed, isolation_mode, discovered_ports, raw_output, rejection_reason
       FROM tool_audit_logs WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [session.userId]
    );
    expect(audit.rows[0].allowed).toBe(false);
    expect(audit.rows[0].isolation_mode).toBe('unavailable');
    expect(audit.rows[0].discovered_ports).toEqual([]);
    expect(audit.rows[0].raw_output).toBe('');
    expect(audit.rows[0].rejection_reason).toMatch(/^LAB_BACKEND_UNAVAILABLE:/);

    const balanceAfter = await h.db.query<any>(
      `SELECT balance FROM ledger_accounts WHERE id = 'acct-user-${session.userId}'`
    );
    expect(Number(balanceAfter.rows[0].balance)).toBe(Number(balanceBefore.rows[0].balance));

    const missionAfter = await h.db.query<any>(
      `SELECT status FROM player_missions WHERE user_id = $1 AND mission_id = 'msn-lab-01'`,
      [session.userId]
    );
    expect(missionAfter.rows[0].status).toBe(missionBefore.rows[0].status);

    const rewardTx = await h.db.query<any>(
      `SELECT COUNT(*)::int AS count FROM ledger_transactions WHERE reference_id LIKE 'msn-lab-01%'`
    );
    expect(rewardTx.rows[0].count).toBe(0);
  }, 60000);

  it('never lets an unaccepted mission be scanned and blocks the scan without a session', async () => {
    const other = await registerOperator(h.app, 'lab_flow_other', 'LabFlow!2026');

    const noSession = await runCommand(h.app, other, 'nmap --profile service --target 10.240.10.10');
    expect(noSession.body.ok).toBe(false);
    expect(noSession.body.lines.join('\n')).toMatch(/LAB_REQUIRED/);

    // lab open on a mission that was never accepted still provisions the disposable
    // environment for the assigned target, but never for an arbitrary address.
    const openOther = await runCommand(h.app, other, 'lab open --mission msn-lab-02');
    expect(openOther.body.data.targetIp).toBe('10.240.20.15');
    const crossMission = await runCommand(h.app, other, 'nmap --profile service --target 10.240.10.10');
    expect(crossMission.body.ok).toBe(false);
    expect(crossMission.body.lines.join('\n')).toMatch(/UNAUTHORIZED_LAB_TARGET/);
  }, 60000);
});
