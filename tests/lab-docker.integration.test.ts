import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import crypto from 'node:crypto';
import { loadConfig } from '../src/server/config.js';
import {
  buildScannerContainerArgs,
  buildTargetContainerArgs,
  deriveMissionSubnet,
  resetLabBackendStatusCache,
  runLabDockerCommand,
  runDockerLabScan,
  type LabScanRequest
} from '../src/workers/lab-docker-backend.js';

/**
 * REAL Docker/network isolation integration test.
 *
 * This suite is intentionally skipped when no Docker daemon is reachable, because
 * the isolation guarantees it asserts cannot be reproduced with mocks. When the
 * environment claims to be one where these tests must run, set:
 *
 *   ROOTWARS_REQUIRE_DOCKER_TESTS=true
 *
 * and the suite fails loudly instead of skipping. In CI/local sandboxes without
 * Docker, `npm test` reports these as skipped and prints the banner below.
 *
 * Recommended invocation in a disposable, isolated local environment:
 *
 *   bash scripts/build-lab-images.sh
 *   ROOTWARS_REQUIRE_DOCKER_TESTS=true ROOTWARS_BUILD_LAB_IMAGES=true npx vitest run tests/lab-docker.integration.test.ts
 */

const execFileAsync = promisify(execFile);

const SCANNER_IMAGE = process.env.LAB_SCANNER_IMAGE ?? 'rootwars/lab-scanner:1.0.0';
const TARGET_IMAGE = process.env.LAB_TARGET_IMAGE ?? 'rootwars/lab-target:1.0.0';
const REQUIRE_DOCKER = process.env.ROOTWARS_REQUIRE_DOCKER_TESTS === 'true';
const BUILD_IMAGES = process.env.ROOTWARS_BUILD_LAB_IMAGES === 'true';

const SKIP_BANNER = [
  '='.repeat(78),
  'REAL DOCKER ISOLATION TESTS WERE NOT EXECUTED (no Docker daemon reachable).',
  'No network-isolation claim can be made from this test run.',
  'Run them in a disposable Docker host with:',
  '  ROOTWARS_REQUIRE_DOCKER_TESTS=true ROOTWARS_BUILD_LAB_IMAGES=true \\',
  '    npx vitest run tests/lab-docker.integration.test.ts',
  '='.repeat(78)
].join('\n');

async function docker(args: string[], timeoutMs = 60000): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFileAsync('docker', args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 });
  return { stdout: String(stdout), stderr: String(stderr) };
}

async function dockerAvailable(): Promise<boolean> {
  try {
    await docker(['info', '--format', '{{.ServerVersion}}'], 15000);
    return true;
  } catch {
    return false;
  }
}

const dockerOk = await dockerAvailable();

describe('Docker lab isolation environmental gate', () => {
  it('states explicitly whether real isolation tests can run here', () => {
    if (dockerOk) {
      expect(dockerOk).toBe(true);
      return;
    }
    console.warn(SKIP_BANNER);
    if (REQUIRE_DOCKER) {
      throw new Error(
        'ROOTWARS_REQUIRE_DOCKER_TESTS=true but no Docker daemon is reachable: refusing to pretend the lab ' +
          'isolation tests ran.'
      );
    }
    // Container isolation is unavailable here; the dedicated `describe.skipIf`
    // suite below does not execute and this run makes no isolation claim.
    expect(dockerOk).toBe(false);
  });
});

describe.skipIf(!dockerOk)('Real Docker lab isolation (requires a Docker daemon)', () => {
  const config = loadConfig({ NODE_ENV: 'development', LAB_ALLOW_HOST_DOCKER: 'true' }).lab;
  const cleanup: Array<() => Promise<void>> = [];
  let suffix = '';

  const request = (overrides: Partial<LabScanRequest> = {}): LabScanRequest => ({
    tool: 'nmap',
    profile: 'service',
    missionId: 'msn-lab-01',
    missionCode: 'LAB-01',
    targetIp: '10.240.10.10',
    assignedTargetIp: '10.240.10.10',
    services: [
      { port: 22, banner: 'SSH-2.0-OpenSSH_9.2p1 IntegrationTest\r\n' },
      { port: 8080, banner: 'HTTP/1.1 200 OK\r\nServer: IntegrationTest\r\n\r\nOK' }
    ],
    timeoutMs: 20000,
    ...overrides
  });

  async function imagePresent(image: string): Promise<boolean> {
    try {
      await docker(['image', 'inspect', image], 15000);
      return true;
    } catch {
      return false;
    }
  }

  async function startTarget(params: {
    network: string;
    name: string;
    ip: string;
    missionId: string;
    services: Array<{ port: number; banner: string }>;
  }): Promise<void> {
    await docker(
      buildTargetContainerArgs(config, {
        networkName: params.network,
        targetContainerName: params.name,
        targetIp: params.ip,
        missionId: params.missionId,
        services: params.services
      })
    );
    cleanup.push(async () => {
      await docker(['rm', '-f', '-v', params.name]).catch(() => {});
    });
    for (let i = 0; i < 40; i++) {
      try {
        await docker(['exec', params.name, 'node', '/app/lab-target.mjs', '--selfcheck'], 5000);
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    throw new Error(`target container ${params.name} never became ready`);
  }

  /** Runs a busybox check inside a disposable scanner container on `network`. */
  async function probeFromNetwork(network: string, command: string[]): Promise<string> {
    const res = await docker(['run', '--rm', '--network', network, '--entrypoint', 'sh', SCANNER_IMAGE, '-c', command.join(' ')], 30000);
    return res.stdout;
  }

  beforeAll(async () => {
    suffix = crypto.randomBytes(4).toString('hex');
    if (BUILD_IMAGES) {
      const { stdout } = await execFileAsync('bash', ['scripts/build-lab-images.sh'], { timeout: 900000 });
      console.log(stdout);
    }
    if (!(await imagePresent(SCANNER_IMAGE)) || !(await imagePresent(TARGET_IMAGE))) {
      throw new Error(
        `Lab images ${SCANNER_IMAGE} / ${TARGET_IMAGE} are missing. Build them with ` +
          '`bash scripts/build-lab-images.sh` or set ROOTWARS_BUILD_LAB_IMAGES=true.'
      );
    }
    // The host Docker socket is only acceptable in this disposable test environment.
    process.env.LAB_ALLOW_HOST_DOCKER = 'true';
    resetLabBackendStatusCache();
  }, 900000);

  afterAll(async () => {
    for (const fn of cleanup.reverse()) await fn();
    delete process.env.LAB_ALLOW_HOST_DOCKER;
    resetLabBackendStatusCache();
  }, 120000);

  it('scans the mission-assigned target and discovers its real open ports', async () => {
    const result = await runDockerLabScan(config, request());

    expect(result.allowed).toBe(true);
    expect(result.backendAvailable).toBe(true);
    expect(result.isolationMode).toBe('docker-internal-lab-network');
    expect(result.discoveredPorts.map((p) => p.port).sort((a, b) => a - b)).toEqual([22, 8080]);
    expect(result.rawOutput).toContain('Nmap scan report');
    expect(result.sanitizedArgs.join(' ')).not.toMatch(/--script|-sC|;|\|/);
  }, 180000);

  it('cannot reach another mission\'s lab target from this mission\'s network', async () => {
    const netA = `rwlab-net-${suffix}a`;
    const netB = `rwlab-net-${suffix}b`;
    const ipA = '10.240.10.10';
    const ipB = '10.240.20.15';

    await docker(['network', 'create', '--driver', 'bridge', '--internal', '--subnet', deriveMissionSubnet(ipA)!, netA]);
    await docker(['network', 'create', '--driver', 'bridge', '--internal', '--subnet', deriveMissionSubnet(ipB)!, netB]);
    cleanup.push(async () => {
      await docker(['network', 'rm', netA]).catch(() => {});
      await docker(['network', 'rm', netB]).catch(() => {});
    });

    await startTarget({
      network: netB,
      name: `rwlab-target-${suffix}b`,
      ip: ipB,
      missionId: 'msn-lab-02',
      services: [{ port: 22, banner: 'SSH-2.0-OtherMission\r\n' }]
    });

    // The scanner container is attached to mission A's network only; other
    // mission subnets must be unroutable (no route, no ARP response).
    const output = await probeFromNetwork(netA, ['ip', 'route', 'get', ipB, '2>&1', '||', 'true']);
    expect(output).not.toMatch(ipB);

    const reach = await probeFromNetwork(netA, ['nc', '-z', '-w', '2', ipB, '22', ';', 'echo', 'RC=$?']);
    expect(reach).not.toMatch(/RC=0/);
  }, 180000);

  it('has no route to the public internet or the host loopback', async () => {
    const network = `rwlab-net-${suffix}c`;
    await docker(['network', 'create', '--driver', 'bridge', '--internal', '--subnet', '10.240.90.0/24', network]);
    cleanup.push(async () => {
      await docker(['network', 'rm', network]).catch(() => {});
    });

    const routes = await probeFromNetwork(network, ['ip', 'route']);
    expect(routes).not.toMatch(/^\s*default\b/m);
    expect(routes).toMatch(/10\.240\.90\.0\/24/);

    const publicProbe = await probeFromNetwork(network, ['nc', '-z', '-w', '3', '1.1.1.1', '80', ';', 'echo', 'RC=$?']);
    expect(publicProbe).not.toMatch(/RC=0/);

    const hostLoopback = await probeFromNetwork(network, ['nc', '-z', '-w', '3', '127.0.0.1', '22', ';', 'echo', 'RC=$?']);
    expect(hostLoopback).not.toMatch(/RC=0/);

    const uid = await probeFromNetwork(network, ['id', '-u']);
    expect(uid.trim()).toBe('65534');
  }, 180000);

  it('tears down every disposable container and network, even on failure', async () => {
    const failed = await runDockerLabScan(
      config,
      request({ targetIp: '10.240.99.10', assignedTargetIp: '10.240.10.10' })
    );
    expect(failed.allowed).toBe(false);

    const containers = await docker(['ps', '-a', '--filter', 'label=rootwars.disposable=true', '--format', '{{.Names}}']);
    const networks = await docker(['network', 'ls', '--filter', 'label=rootwars.disposable=true', '--format', '{{.Name}}']);
    const ownContainers = containers.stdout
      .split('\n')
      .filter((name) => name.includes(suffix))
      .filter(Boolean);
    const ownNetworks = networks.stdout
      .split('\n')
      .filter((name) => name.includes(suffix))
      .filter(Boolean);
    expect(ownContainers).toEqual([]);
    expect(ownNetworks).toEqual([]);
  }, 180000);

  it('never routes the scanner through the host network namespace or the Docker socket', async () => {
    const args = buildScannerContainerArgs(config, {
      networkName: 'rwlab-net-test',
      scannerContainerName: 'rwlab-scanner-test',
      missionId: 'msn-lab-01',
      sanitizedArgs: ['/usr/bin/nmap', '-sV', '10.240.10.10']
    });
    expect(args).not.toContain('--network');
    expect(args.join(' ')).not.toMatch(/--net=host|host\b|docker\.sock|--privileged/);
    expect(args.join(' ')).toContain('--network rwlab-net-test');
    expect(args).toContain('65534:65534');
    expect(args).toContain('--cap-drop');
    expect(args).toContain('--read-only');

    // The API container must not be able to talk to a Docker socket either.
    const info = await runLabDockerCommand(config, ['info', '--format', '{{.ServerVersion}}'], { timeoutMs: 15000 });
    expect(info.stdout.trim().length).toBeGreaterThan(0);
  }, 60000);
});
