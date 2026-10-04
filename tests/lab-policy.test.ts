import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/server/config.js';
import {
  buildSanitizedScanArgs,
  deriveMissionSubnet,
  parseNmapOutputPorts,
  resetLabBackendStatusCache,
  runDockerLabScan,
  sanitizeLabServices,
  validateLabToolRequest
} from '../src/workers/lab-docker-backend.js';
import { executeIsolatedLabScan, getLabAvailability } from '../src/workers/lab-runner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

function labConfig(overrides: Record<string, string | undefined> = {}) {
  return loadConfig({
    NODE_ENV: 'development',
    ...overrides
  } as NodeJS.ProcessEnv).lab;
}

const baseRequest = {
  tool: 'nmap',
  profile: 'service' as const,
  missionId: 'msn-lab-01',
  missionCode: 'LAB-01',
  targetIp: '10.240.10.10',
  assignedTargetIp: '10.240.10.10',
  services: [{ port: 22, banner: 'SSH-2.0-OpenSSH_9.2p1 Test\r\n' }]
};

describe('Lab target & argument validation (policy layer)', () => {
  it('accepts only the mission-assigned address inside the RootWars lab CIDR', () => {
    expect(validateLabToolRequest(baseRequest).valid).toBe(true);

    const mismatched = validateLabToolRequest({ ...baseRequest, targetIp: '10.240.20.15' });
    expect(mismatched.valid).toBe(false);
    expect(mismatched.reason).toMatch(/assigned lab target/);

    const publicTarget = validateLabToolRequest({
      ...baseRequest,
      targetIp: '1.1.1.1',
      assignedTargetIp: '1.1.1.1'
    });
    expect(publicTarget.valid).toBe(false);
    expect(publicTarget.reason).toMatch(/10\.240\.0\.0\/16/);

    const loopback = validateLabToolRequest({
      ...baseRequest,
      targetIp: '127.0.0.1',
      assignedTargetIp: '127.0.0.1'
    });
    expect(loopback.valid).toBe(false);
  });

  it('rejects unapproved tools, unapproved profiles and malformed service specs', () => {
    expect(validateLabToolRequest({ ...baseRequest, tool: 'curl' }).valid).toBe(false);
    expect(validateLabToolRequest({ ...baseRequest, profile: 'aggressive' as any }).valid).toBe(false);

    const badPort = validateLabToolRequest({
      ...baseRequest,
      services: [{ port: 70000, banner: 'x' }]
    });
    expect(badPort.valid).toBe(false);

    const duplicates = validateLabToolRequest({
      ...baseRequest,
      services: [
        { port: 22, banner: 'a' },
        { port: 22, banner: 'b' }
      ]
    });
    expect(duplicates.valid).toBe(false);

    const tooMany = validateLabToolRequest({
      ...baseRequest,
      services: Array.from({ length: 17 }, (_, i) => ({ port: 1000 + i, banner: 'x' }))
    });
    expect(tooMany.valid).toBe(false);
  });

  it('derives the per-mission /24 subnet and refuses non-lab addresses', () => {
    expect(deriveMissionSubnet('10.240.10.10')).toBe('10.240.10.0/24');
    expect(deriveMissionSubnet('10.240.50.99')).toBe('10.240.50.0/24');
    expect(deriveMissionSubnet('192.168.1.5')).toBeNull();
    expect(deriveMissionSubnet('10.241.1.1')).toBeNull();
    expect(deriveMissionSubnet('nope')).toBeNull();
  });

  it('builds a fixed argument vector from the allowlisted profile only', () => {
    const config = labConfig();
    const args = buildSanitizedScanArgs(config, 'service', '10.240.10.10');
    expect(args[0]).toBe(config.nmapPath);
    expect(args[0]).toBe('/usr/bin/nmap');
    expect(args).toContain('--datadir');
    expect(args).toContain(config.nmapDataDir);
    expect(args.slice(-1)).toEqual(['10.240.10.10']);
    expect(args.join(' ')).not.toMatch(/--script|-sC|-oN|-oX|;|\||&&|\$\(/);

    expect(() => buildSanitizedScanArgs(config, 'service', '1.1.1.1')).toThrow();
    expect(() => buildSanitizedScanArgs(config, 'unknown' as any, '10.240.10.10')).toThrow();
  });
});

describe('Fail-closed lab backend (no isolated Docker endpoint available)', () => {
  const originalAllow = process.env.LAB_ALLOW_HOST_DOCKER;
  const originalHost = process.env.LAB_DOCKER_HOST;

  beforeEach(() => {
    delete process.env.LAB_ALLOW_HOST_DOCKER;
    delete process.env.LAB_DOCKER_HOST;
    resetLabBackendStatusCache();
  });

  afterEach(() => {
    if (originalAllow === undefined) delete process.env.LAB_ALLOW_HOST_DOCKER;
    else process.env.LAB_ALLOW_HOST_DOCKER = originalAllow;
    if (originalHost === undefined) delete process.env.LAB_DOCKER_HOST;
    else process.env.LAB_DOCKER_HOST = originalHost;
    resetLabBackendStatusCache();
  });

  it('reports the backend as unavailable instead of falling back to a loopback emulator', async () => {
    const status = await getLabAvailability();
    expect(status.available).toBe(false);
    expect(status.reason).toMatch(/LAB_DOCKER_HOST/);
    expect(status.summary).toMatch(/fail closed/i);
  });

  it('returns LAB_BACKEND_UNAVAILABLE and never allowed=true without a real isolated endpoint', async () => {
    const result = await runDockerLabScan(labConfig(), baseRequest);
    expect(result.allowed).toBe(false);
    expect(result.backendAvailable).toBe(false);
    expect(result.isolationMode).toBe('unavailable');
    expect(result.rejectionReason).toMatch(/^LAB_BACKEND_UNAVAILABLE:/);
    expect(result.discoveredPorts).toEqual([]);
    expect(result.rawOutput).toBe('');
  });

  it('refuses the host Docker socket in production unless it is an explicit lab endpoint', () => {
    const productionConfig = loadConfig({
      NODE_ENV: 'production',
      SESSION_SECRET: 'a'.repeat(48),
      REDIS_URL: 'redis://redis:6379',
      ALLOWED_ORIGINS: 'https://rootwars.example',
      DATABASE_URL: 'postgresql://rootwars:strong-password@postgres:5432/rootwars',
      LAB_DOCKER_HOST: 'tcp://lab-dind:2375'
    } as NodeJS.ProcessEnv);
    expect(productionConfig.lab.dockerHost).toBe('tcp://lab-dind:2375');

    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        SESSION_SECRET: 'a'.repeat(48),
        REDIS_URL: 'redis://redis:6379',
        ALLOWED_ORIGINS: 'https://rootwars.example',
        DATABASE_URL: 'postgresql://rootwars:strong-password@postgres:5432/rootwars',
        LAB_DOCKER_HOST: 'unix:///var/run/docker.sock'
      } as NodeJS.ProcessEnv)
    ).toThrow(/dedicated lab Docker endpoint/);
  });

  it('does not shell out to sudo or Linux network namespaces anywhere in the lab path', () => {
    const labSources = ['src/workers/lab-runner.ts', 'src/workers/lab-docker-backend.ts'].map((rel) =>
      fs.readFileSync(path.join(repoRoot, rel), 'utf-8')
    );
    for (const source of labSources) {
      expect(source).not.toMatch(/\bsudo\b/);
      expect(source).not.toMatch(/netns/);
      expect(source).not.toMatch(/shell:\s*true/);
    }
  });
});

describe('Nmap output parsing', () => {
  it('extracts only open ports with service and version columns', () => {
    const output = [
      'Starting Nmap 7.95 ( https://nmap.org )',
      'Nmap scan report for 10.240.10.10',
      'PORT     STATE    SERVICE   VERSION',
      '22/tcp   open     ssh       OpenSSH 9.2p1 (protocol 2.0)',
      '80/tcp   open     http      nginx 1.26.0',
      '443/tcp  closed   https',
      '8080/tcp filtered http-proxy',
      '8443/tcp open     ssl/https RootWars HSM Auth',
      'Nmap done: 1 IP address (1 host up) scanned in 0.42 seconds'
    ].join('\n');

    const ports = parseNmapOutputPorts(output);
    expect(ports.map((p) => p.port)).toEqual([22, 80, 8443]);
    expect(ports[0]).toMatchObject({ protocol: 'tcp', state: 'open', service: 'ssh' });
    expect(ports[1].version).toContain('nginx');
    expect(parseNmapOutputPorts('')).toEqual([]);
  });
});

describe('Lab scan request isolation guarantees (unit level)', () => {
  it('never takes an address from user-supplied input when dispatching', async () => {
    // Even a syntactically valid lab address that is NOT the mission assignment is refused
    // before any container work begins.
    const result = await executeIsolatedLabScan({
      ...baseRequest,
      targetIp: '10.240.99.10',
      assignedTargetIp: '10.240.10.10'
    });
    expect(result.allowed).toBe(false);
    expect(result.rejectionReason).toMatch(/assigned lab target/);
    expect(result.sanitizedArgs).toEqual([]);
  });
});
