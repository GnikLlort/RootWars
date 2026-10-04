/**
 * RootWars isolated lab backend (Docker).
 *
 * Every lab scan is executed as real Nmap inside a disposable, non-root scanner
 * container attached ONLY to a per-mission, Docker `--internal` network that also
 * contains the RootWars-owned target container for the active mission.
 *
 * Design guarantees:
 *  - The scanner container has no `--network host`, no docker socket, no extra
 *    networks, no added capabilities and no new privileges. Internal Docker
 *    networks have no external route, so public internet and host endpoints are
 *    unreachable by construction.
 *  - The target address is never taken from user input: it is the active lab
 *    session's assigned mission IP, re-validated against the RootWars lab CIDR.
 *  - The Docker CLI is invoked with `execFile` (never a shell) using a fixed,
 *    allowlisted argument vector.
 *  - All disposable resources (target container, mission network) are removed in a
 *    `finally` block, even when the scan fails or times out.
 *  - If a suitable isolated Docker endpoint/images are not available the backend
 *    reports `available: false` and the scan fails closed. There is intentionally
 *    no fallback that would pretend a loopback service emulator is the mission target.
 */

import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import type { LabRuntimeConfig } from '../server/config.js';
import { APPROVED_NMAP_PROFILES, NmapProfileName } from '../shared/commandParser.js';

const execFileAsync = promisify(execFile);

export const LAB_ISOLATION_MODE = 'docker-internal-lab-network' as const;
export const LAB_UNAVAILABLE_MODE = 'unavailable' as const;
export type LabIsolationMode = typeof LAB_ISOLATION_MODE | typeof LAB_UNAVAILABLE_MODE;

export interface LabServiceSpec {
  port: number;
  banner: string;
}

export interface DiscoveredPort {
  port: number;
  protocol: string;
  state: string;
  service: string;
  version: string;
}

export interface LabMissionTarget {
  missionId: string;
  missionCode: string;
  targetIp: string;
  targetHostname: string;
  services: LabServiceSpec[];
}

export interface LabScanRequest {
  tool: string;
  profile: NmapProfileName;
  missionId: string;
  missionCode: string;
  targetIp: string;
  assignedTargetIp: string;
  services: LabServiceSpec[];
  timeoutMs?: number;
}

export interface LabScanResult {
  allowed: boolean;
  backendAvailable: boolean;
  isolationMode: LabIsolationMode;
  rejectionReason?: string;
  sanitizedArgs: string[];
  rawOutput: string;
  truncated: boolean;
  discoveredPorts: DiscoveredPort[];
  durationMs: number;
  networkName?: string;
  targetContainerName?: string;
}

export interface LabBackendStatus {
  available: boolean;
  reason: string;
  dockerHost: string | null;
  dockerServerVersion?: string;
  nmapVersion?: string;
  scannerImage: string;
  targetImage: string;
  checkedAt: string;
}

export interface DockerCommandResult {
  stdout: string;
  stderr: string;
}

/** Fixed mode used inside the lab scanner image: the image ENTRYPOINT is nmap itself. */
export const LAB_TARGET_ENV_VAR = 'ROOTWARS_LAB_SERVICES';

export function parseNmapOutputPorts(rawOutput: string): DiscoveredPort[] {
  const ports: DiscoveredPort[] = [];
  const lines = rawOutput.split('\n');
  const portLineRegex = /^(\d+)\/(tcp|udp)\s+(open|closed|filtered)\s+(\S+)(?:\s+(.*))?$/;

  for (const line of lines) {
    const match = portLineRegex.exec(line.trim());
    if (!match) continue;
    const [, port, protocol, state, col4, rest] = match;
    if (state !== 'open') continue;
    ports.push({
      port: Number(port),
      protocol,
      state,
      service: col4,
      version: (rest ?? '').trim()
    });
  }
  return ports;
}

/**
 * Validates mission-owned lab service specs before they are ever turned into
 * container environment variables.
 */
export function sanitizeLabServices(services: unknown): { valid: boolean; reason?: string; services: LabServiceSpec[] } {
  if (!Array.isArray(services)) {
    return { valid: false, reason: 'Lab service specification must be an array.', services: [] };
  }
  if (services.length > 16) {
    return { valid: false, reason: 'Lab service specification exceeds the 16-service limit.', services: [] };
  }
  const out: LabServiceSpec[] = [];
  const seen = new Set<number>();
  for (const svc of services) {
    const port = Number((svc as any)?.port);
    const banner = String((svc as any)?.banner ?? '');
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return { valid: false, reason: `Lab service port "${(svc as any)?.port}" is not a valid TCP port.`, services: [] };
    }
    if (seen.has(port)) {
      return { valid: false, reason: `Duplicate lab service port ${port}.`, services: [] };
    }
    if (banner.length > 256 || /[\u0000]/.test(banner)) {
      return { valid: false, reason: `Lab service banner on port ${port} is invalid.`, services: [] };
    }
    seen.add(port);
    out.push({ port, banner });
  }
  return { valid: true, services: out };
}

/** Derives the per-mission /24 lab subnet from a validated 10.240.x.y target. */
export function deriveMissionSubnet(targetIp: string): string | null {
  const parts = targetIp.split('.');
  if (parts.length !== 4) return null;
  if (parts[0] !== '10' || parts[1] !== '240') return null;
  const third = Number(parts[2]);
  if (!Number.isInteger(third) || third < 0 || third > 255) return null;
  return `10.240.${third}.0/24`;
}

export function validateLabToolRequest(req: LabScanRequest): {
  valid: boolean;
  reason?: string;
  profileSpec?: (typeof APPROVED_NMAP_PROFILES)[NmapProfileName];
  services: LabServiceSpec[];
} {
  const emptyServices: LabServiceSpec[] = [];
  if (req.tool !== 'nmap') {
    return { valid: false, reason: `Tool "${req.tool}" is not on the RootWars lab allowlist.`, services: emptyServices };
  }

  const profileSpec = APPROVED_NMAP_PROFILES[req.profile];
  if (!profileSpec) {
    return { valid: false, reason: `Scan profile "${req.profile}" is not approved.`, services: emptyServices };
  }

  if (!deriveMissionSubnet(req.targetIp)) {
    return {
      valid: false,
      reason: `Target IP "${req.targetIp}" is outside the private RootWars lab CIDR (10.240.0.0/16).`,
      services: emptyServices
    };
  }

  if (req.targetIp !== req.assignedTargetIp) {
    return {
      valid: false,
      reason: `Target IP "${req.targetIp}" does not match your active mission's assigned lab target (${req.assignedTargetIp}).`,
      services: emptyServices
    };
  }

  const services = sanitizeLabServices(req.services);
  if (!services.valid) {
    return { valid: false, reason: services.reason, services: emptyServices };
  }

  return { valid: true, profileSpec, services: services.services };
}

/**
 * Builds the complete, allowlisted argument vector for one scan.
 * Every element is derived from the approved profile or the validated mission
 * target; nothing is taken from raw user input.
 */
export function buildSanitizedScanArgs(
  config: LabRuntimeConfig,
  profile: NmapProfileName,
  targetIp: string
): string[] {
  const profileSpec = APPROVED_NMAP_PROFILES[profile];
  if (!profileSpec || !deriveMissionSubnet(targetIp)) {
    throw new Error('Refusing to build lab scan arguments for an unapproved profile or target.');
  }
  return [
    config.nmapPath,
    '--datadir',
    config.nmapDataDir,
    '--host-timeout',
    `${Math.max(1000, Math.floor(config.timeoutMs))}ms`,
    ...profileSpec.nmapArgs,
    targetIp
  ];
}

/**
 * Runs a docker CLI command against the dedicated lab endpoint. Argument vectors
 * are built by this module (or by tests/admin scripts) and executed without a shell.
 */
export async function runLabDockerCommand(
  config: LabRuntimeConfig,
  args: string[],
  options?: { timeoutMs?: number; maxBuffer?: number }
): Promise<DockerCommandResult> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: '/tmp',
    LANG: 'C'
  };
  if (config.dockerHost) {
    env.DOCKER_HOST = config.dockerHost;
  }
  if (process.env.DOCKER_TLS_VERIFY) {
    env.DOCKER_TLS_VERIFY = process.env.DOCKER_TLS_VERIFY;
  }
  if (process.env.DOCKER_CERT_PATH) {
    env.DOCKER_CERT_PATH = process.env.DOCKER_CERT_PATH;
  }

  const { stdout, stderr } = await execFileAsync('docker', args, {
    timeout: options?.timeoutMs ?? config.controlTimeoutMs,
    maxBuffer: options?.maxBuffer ?? 1024 * 1024,
    env,
    killSignal: 'SIGKILL'
  });
  return { stdout, stderr };
}

/**
 * Refuses to talk to a host Docker socket unless explicitly permitted for local
 * development, so an API/worker process cannot silently gain host-level control.
 */
export function assertLabDockerEndpoint(config: LabRuntimeConfig): { ok: boolean; reason?: string } {
  const allowHostDocker = process.env.LAB_ALLOW_HOST_DOCKER === 'true';
  const dockerHost = config.dockerHost;

  if (config.isProduction && !dockerHost) {
    return {
      ok: false,
      reason:
        'LAB_DOCKER_HOST is not configured. Production lab scans require a dedicated lab Docker endpoint and fail closed without one.'
    };
  }

  if (!dockerHost) {
    if (!allowHostDocker) {
      return {
        ok: false,
        reason:
          'No dedicated lab Docker endpoint is configured (LAB_DOCKER_HOST). Refusing to fall back to the host Docker socket; lab scans fail closed. Set LAB_ALLOW_HOST_DOCKER=true only for disposable local development.'
      };
    }
  } else if (dockerHost === 'unix:///var/run/docker.sock' && !allowHostDocker) {
    return {
      ok: false,
      reason:
        'LAB_DOCKER_HOST points at the host Docker socket. Set LAB_ALLOW_HOST_DOCKER=true to allow this in disposable local development only; production must use a dedicated lab daemon.'
    };
  }

  return { ok: true };
}

let cachedStatus: { status: LabBackendStatus; expiresAt: number } | null = null;

/** Probes the isolated lab Docker endpoint, images and nmap binary. */
export async function getLabBackendStatus(
  config: LabRuntimeConfig,
  opts?: { refresh?: boolean; cacheMs?: number }
): Promise<LabBackendStatus> {
  const cacheMs = opts?.cacheMs ?? 15000;
  if (!opts?.refresh && cachedStatus && cachedStatus.expiresAt > Date.now()) {
    return cachedStatus.status;
  }

  const base: LabBackendStatus = {
    available: false,
    reason: '',
    dockerHost: config.dockerHost,
    scannerImage: config.scannerImage,
    targetImage: config.targetImage,
    checkedAt: new Date().toISOString()
  };

  const endpoint = assertLabDockerEndpoint(config);
  if (!endpoint.ok) {
    const status = { ...base, reason: endpoint.reason! };
    cachedStatus = { status, expiresAt: Date.now() + cacheMs };
    return status;
  }

  try {
    const version = await runLabDockerCommand(config, ['version', '--format', '{{.Server.Version}}'], { timeoutMs: 8000 });
    base.dockerServerVersion = version.stdout.trim();
  } catch (err: any) {
    const status = {
      ...base,
      reason: `Lab Docker daemon is unreachable: ${String(err?.stderr || err?.message || err).trim()}`
    };
    cachedStatus = { status, expiresAt: Date.now() + cacheMs };
    return status;
  }

  try {
    await runLabDockerCommand(config, ['image', 'inspect', config.scannerImage, '--format', '{{.Id}}'], { timeoutMs: 8000 });
    await runLabDockerCommand(config, ['image', 'inspect', config.targetImage, '--format', '{{.Id}}'], { timeoutMs: 8000 });
  } catch {
    const status = {
      ...base,
      reason: `Lab images are not present on the lab daemon (expected "${config.scannerImage}" and "${config.targetImage}"); build them with scripts/build-lab-images.sh.`
    };
    cachedStatus = { status, expiresAt: Date.now() + cacheMs };
    return status;
  }

  try {
    const nmapProbe = await runLabDockerCommand(
      config,
      [
        'run',
        '--rm',
        '--network',
        'none',
        '--read-only',
        '--cap-drop',
        'ALL',
        '--security-opt',
        'no-new-privileges',
        '--user',
        '65534:65534',
        '--tmpfs',
        '/tmp:rw,noexec,nosuid,size=8m',
        '--entrypoint',
        config.nmapPath,
        config.scannerImage,
        '--version'
      ],
      { timeoutMs: 15000, maxBuffer: 256 * 1024 }
    );
    const firstLine = nmapProbe.stdout.split('\n')[0]?.trim() ?? '';
    if (!firstLine.toLowerCase().includes('nmap version')) {
      throw new Error(`Unexpected nmap --version output: ${firstLine || '(empty)'}`);
    }
    base.nmapVersion = firstLine;
  } catch (err: any) {
    const status = {
      ...base,
      reason: `Fixed Nmap binary ${config.nmapPath} could not be verified inside image ${config.scannerImage}: ${String(
        err?.stderr || err?.message || err
      ).trim()}`
    };
    cachedStatus = { status, expiresAt: Date.now() + cacheMs };
    return status;
  }

  const status: LabBackendStatus = {
    ...base,
    available: true,
    reason: 'Isolated lab Docker backend verified (daemon reachable, allowlisted images present, nmap binary verified).'
  };
  cachedStatus = { status, expiresAt: Date.now() + cacheMs };
  return status;
}

export function resetLabBackendStatusCache(): void {
  cachedStatus = null;
}

function unavailableResult(start: number, reason: string, sanitizedArgs: string[] = []): LabScanResult {
  return {
    allowed: false,
    backendAvailable: false,
    isolationMode: LAB_UNAVAILABLE_MODE,
    rejectionReason: `LAB_BACKEND_UNAVAILABLE: ${reason}`,
    sanitizedArgs,
    rawOutput: '',
    truncated: false,
    discoveredPorts: [],
    durationMs: Date.now() - start
  };
}

/**
 * Runs one real Nmap scan inside a disposable hardened scanner container that can
 * only reach the active mission's RootWars-owned target container.
 */

export const LAB_CONTAINER_LABELS = (missionId: string): string[] => [
  '--label',
  `rootwars.mission=${missionId}`,
  '--label',
  'rootwars.disposable=true'
];

/** Exact docker arguments used to start a mission target container. */
export function buildTargetContainerArgs(
  config: LabRuntimeConfig,
  params: {
    networkName: string;
    targetContainerName: string;
    targetIp: string;
    missionId: string;
    services: LabServiceSpec[];
  }
): string[] {
  const targetEnv = JSON.stringify(params.services.map((svc) => ({ port: svc.port, banner: svc.banner })));
  return [
    'run',
    '-d',
    '--rm',
    '--name',
    params.targetContainerName,
    '--network',
    params.networkName,
    '--ip',
    params.targetIp,
    '--user',
    '65534:65534',
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--pids-limit',
    String(config.targetPidsLimit),
    '--memory',
    `${config.targetMemoryMb}m`,
    '--memory-swap',
    `${config.targetMemoryMb}m`,
    '--cpus',
    String(config.targetCpus),
    '--tmpfs',
    '/tmp:rw,noexec,nosuid,size=8m',
    ...LAB_CONTAINER_LABELS(params.missionId),
    '--env',
    `${LAB_TARGET_ENV_VAR}=${targetEnv}`,
    config.targetImage
  ];
}

/** Exact docker arguments used to execute one non-root, capability-dropped scan. */
export function buildScannerContainerArgs(
  config: LabRuntimeConfig,
  params: { networkName: string; scannerContainerName: string; missionId: string; sanitizedArgs: string[] }
): string[] {
  return [
    'run',
    '--rm',
    '--name',
    params.scannerContainerName,
    '--network',
    params.networkName,
    '--user',
    '65534:65534',
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--pids-limit',
    String(config.scannerPidsLimit),
    '--memory',
    `${config.scannerMemoryMb}m`,
    '--memory-swap',
    `${config.scannerMemoryMb}m`,
    '--cpus',
    String(config.scannerCpus),
    '--ulimit',
    'nofile=256:256',
    '--ulimit',
    `fsize=${config.maxOutputBytes * 2}:${config.maxOutputBytes * 2}`,
    '--tmpfs',
    '/tmp:rw,noexec,nosuid,size=16m',
    ...LAB_CONTAINER_LABELS(params.missionId),
    '--env',
    'HOME=/tmp',
    config.scannerImage,
    ...params.sanitizedArgs
  ];
}

/** Network creation arguments for one mission's dedicated internal-only network. */
export function buildMissionNetworkArgs(missionId: string, subnet: string, networkName: string): string[] {
  return [
    'network',
    'create',
    '--driver',
    'bridge',
    '--internal',
    '--subnet',
    subnet,
    ...LAB_CONTAINER_LABELS(missionId),
    networkName
  ];
}

export function missionNetworkName(): string {
  return `rwlab-net-${crypto.randomBytes(5).toString('hex')}`;
}

export async function runDockerLabScan(config: LabRuntimeConfig, req: LabScanRequest): Promise<LabScanResult> {
  const start = Date.now();
  const validation = validateLabToolRequest(req);

  if (!validation.valid || !validation.profileSpec) {
    return {
      allowed: false,
      backendAvailable: true,
      isolationMode: LAB_ISOLATION_MODE,
      rejectionReason: validation.reason,
      sanitizedArgs: [],
      rawOutput: '',
      truncated: false,
      discoveredPorts: [],
      durationMs: Date.now() - start
    };
  }

  const sanitizedArgs = buildSanitizedScanArgs(config, req.profile, req.targetIp);

  const status = await getLabBackendStatus(config);
  if (!status.available) {
    return unavailableResult(start, status.reason, sanitizedArgs);
  }

  const subnet = deriveMissionSubnet(req.targetIp)!;
  const suffix = crypto.randomBytes(5).toString('hex');
  const networkName = `rwlab-net-${suffix}`;
  const targetContainerName = `rwlab-target-${suffix}`;
  const scannerContainerName = `rwlab-scanner-${suffix}`;
  const timeoutMs = Math.min(req.timeoutMs ?? config.timeoutMs, config.timeoutMs);

  let rawOutput = '';
  let truncated = false;

  try {
    // 1. Dedicated, internal-only network for this mission. `--internal` removes any
    //    gateway to the outside world: public internet and host endpoints are unroutable.
    await runLabDockerCommand(config, buildMissionNetworkArgs(req.missionId, subnet, networkName));

    // 2. Disposable RootWars-owned target container bound to the mission's assigned IP.
    await runLabDockerCommand(
      config,
      buildTargetContainerArgs(config, {
        networkName,
        targetContainerName,
        targetIp: req.targetIp,
        missionId: req.missionId,
        services: validation.services
      })
    );

    // 3. Wait until the mission target is actually listening before scanning.
    await waitForTargetReady(config, targetContainerName);

    // 4. Execute real Nmap as non-root inside a hardened, single-network scanner container.
    let stdout = '';
    try {
      const res = await runLabDockerCommand(
        config,
        buildScannerContainerArgs(config, {
          networkName,
          scannerContainerName,
          missionId: req.missionId,
          sanitizedArgs
        }),
        { timeoutMs: timeoutMs + 5000, maxBuffer: config.maxOutputBytes * 2 }
      );
      stdout = res.stdout;
    } catch (err: any) {
      // Nmap exits non-zero on some benign conditions; keep partial stdout when present.
      stdout = String(err?.stdout ?? '');
      if (!stdout) {
        throw err;
      }
    }

    if (Buffer.byteLength(stdout, 'utf8') > config.maxOutputBytes) {
      rawOutput = Buffer.from(stdout, 'utf8').subarray(0, config.maxOutputBytes).toString('utf8');
      truncated = true;
    } else {
      rawOutput = stdout;
    }

    return {
      allowed: true,
      backendAvailable: true,
      isolationMode: LAB_ISOLATION_MODE,
      sanitizedArgs,
      rawOutput,
      truncated,
      discoveredPorts: parseNmapOutputPorts(rawOutput),
      durationMs: Date.now() - start,
      networkName,
      targetContainerName
    };
  } catch (err: any) {
    return {
      allowed: false,
      backendAvailable: true,
      isolationMode: LAB_ISOLATION_MODE,
      rejectionReason: `LAB_EXECUTION_ERROR: ${String(err?.stderr || err?.message || err).trim()}`.slice(0, 500),
      sanitizedArgs,
      rawOutput,
      truncated,
      discoveredPorts: parseNmapOutputPorts(rawOutput),
      durationMs: Date.now() - start,
      networkName,
      targetContainerName
    };
  } finally {
    // 5. Always tear the disposable mission resources down, even after errors/timeouts.
    await teardownMissionResources(config, scannerContainerName, targetContainerName, networkName);
  }
}

async function waitForTargetReady(config: LabRuntimeConfig, targetContainerName: string): Promise<void> {
  const deadline = Date.now() + Math.min(config.controlTimeoutMs, 10000);
  let lastError = 'target container did not report readiness';
  while (Date.now() < deadline) {
    try {
      await runLabDockerCommand(config, ['exec', targetContainerName, 'node', '/app/lab-target.mjs', '--selfcheck'], {
        timeoutMs: 4000,
        maxBuffer: 64 * 1024
      });
      return;
    } catch (err: any) {
      lastError = String(err?.stderr || err?.message || err).trim();
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw new Error(`Lab target container failed to become ready: ${lastError}`);
}

async function teardownMissionResources(
  config: LabRuntimeConfig,
  scannerContainerName: string,
  targetContainerName: string,
  networkName: string
): Promise<void> {
  const cleanups: string[][] = [
    ['rm', '-f', '-v', scannerContainerName],
    ['rm', '-f', '-v', targetContainerName],
    ['network', 'rm', networkName]
  ];
  for (const args of cleanups) {
    try {
      await runLabDockerCommand(config, args, { timeoutMs: 15000 });
    } catch {
      // Best-effort teardown: resources are labelled rootwars.disposable=true and
      // can also be reaped by scripts/reap-lab-resources.sh.
    }
  }
}
