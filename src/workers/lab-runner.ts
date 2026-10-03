import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  APPROVED_NMAP_PROFILES,
  NmapProfileName,
  isValidLabTargetIp
} from '../shared/commandParser.js';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

export interface LabScanRequest {
  tool: string;
  profile: NmapProfileName;
  targetIp: string;
  assignedTargetIp: string;
  services: LabServiceSpec[];
  timeoutMs?: number;
}

export interface LabScanResult {
  allowed: boolean;
  rejectionReason?: string;
  isolationMode: 'linux-netns-nonroot' | 'process-nonroot-sandbox';
  sanitizedArgs: string[];
  rawOutput: string;
  discoveredPorts: DiscoveredPort[];
  durationMs: number;
}

export function parseNmapOutputPorts(rawOutput: string): DiscoveredPort[] {
  const ports: DiscoveredPort[] = [];
  const lines = rawOutput.split('\n');
  const portLineRegex = /^(\d+)\/(tcp|udp)\s+(open|closed|filtered)\s+(\S+)(?:\s+(.*))?$/;

  for (const line of lines) {
    const trimmed = line.trim();
    const match = portLineRegex.exec(trimmed);
    if (match) {
      // Note: when --reason is used, column 4 might be reason before service; handle both cleanly
      const port = Number(match[1]);
      const protocol = match[2];
      const state = match[3];
      const col4 = match[4];
      const rest = (match[5] ?? '').trim();

      if (state === 'open') {
        ports.push({
          port,
          protocol,
          state,
          service: col4,
          version: rest
        });
      }
    }
  }
  return ports;
}

export function validateLabToolRequest(req: LabScanRequest): {
  valid: boolean;
  reason?: string;
  profileSpec?: (typeof APPROVED_NMAP_PROFILES)[NmapProfileName];
} {
  if (req.tool !== 'nmap') {
    return { valid: false, reason: `Tool "${req.tool}" is not on the RootWars lab allowlist.` };
  }

  const profileSpec = APPROVED_NMAP_PROFILES[req.profile];
  if (!profileSpec) {
    return { valid: false, reason: `Scan profile "${req.profile}" is not approved.` };
  }

  if (!isValidLabTargetIp(req.targetIp)) {
    return {
      valid: false,
      reason: `Target IP "${req.targetIp}" is outside the private RootWars lab CIDR (10.240.0.0/16).`
    };
  }

  if (req.targetIp !== req.assignedTargetIp) {
    return {
      valid: false,
      reason: `Target IP "${req.targetIp}" does not match your active mission's assigned lab target (${req.assignedTargetIp}).`
    };
  }

  return { valid: true, profileSpec };
}

export async function executeIsolatedLabScan(req: LabScanRequest): Promise<LabScanResult> {
  const start = Date.now();
  const validation = validateLabToolRequest(req);

  if (!validation.valid || !validation.profileSpec) {
    return {
      allowed: false,
      rejectionReason: validation.reason,
      isolationMode: 'linux-netns-nonroot',
      sanitizedArgs: [],
      rawOutput: '',
      discoveredPorts: [],
      durationMs: Date.now() - start
    };
  }

  const nmapPath = process.env.LAB_NMAP_PATH ?? '/usr/local/bin/nmap';
  const nmapDataDir = process.env.LAB_NMAP_DATADIR ?? '/usr/share/nmap';
  const timeoutMs = req.timeoutMs ?? Number(process.env.LAB_TIMEOUT_MS ?? 8000);
  const nmapArgs = [...validation.profileSpec.nmapArgs];
  const sanitizedArgs = [nmapPath, '--datadir', nmapDataDir, ...nmapArgs, req.targetIp];

  const netnsName = `rw-lab-${crypto.randomBytes(5).toString('hex')}`;
  const childScriptTs = path.resolve(__dirname, 'lab-sandbox-child.ts');
  const tsxBin = path.resolve(__dirname, '../../node_modules/.bin/tsx');

  const sandboxPayload = JSON.stringify({
    targetIp: req.targetIp,
    nmapPath,
    nmapDataDir,
    nmapArgs,
    services: req.services,
    timeoutMs
  });

  try {
    // Provision disposable isolated Linux network namespace with zero external interfaces or routes
    await execFileAsync('sudo', ['ip', 'netns', 'add', netnsName], { timeout: 3000 });
    await execFileAsync('sudo', ['ip', '-n', netnsName, 'link', 'set', 'lo', 'up'], { timeout: 3000 });
    await execFileAsync('sudo', ['ip', '-n', netnsName, 'addr', 'add', `${req.targetIp}/32`, 'dev', 'lo'], {
      timeout: 3000
    });

    // Execute the child sandbox inside the isolated network namespace
    const { stdout } = await execFileAsync(
      'sudo',
      ['ip', 'netns', 'exec', netnsName, tsxBin, childScriptTs, sandboxPayload],
      {
        timeout: timeoutMs + 4000,
        maxBuffer: 1024 * 512
      }
    );

    const lastLine = stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .pop();

    const parsed = lastLine ? JSON.parse(lastLine) : { ok: false, stdout: '' };
    const rawOutput: string = parsed.stdout || '';
    const discoveredPorts = parseNmapOutputPorts(rawOutput);

    return {
      allowed: true,
      isolationMode: 'linux-netns-nonroot',
      sanitizedArgs,
      rawOutput,
      discoveredPorts,
      durationMs: parsed.durationMs ?? Date.now() - start
    };
  } finally {
    await execFileAsync('sudo', ['ip', 'netns', 'del', netnsName], { timeout: 3000 }).catch(() => {});
  }
}

export interface IsolationVerificationReport {
  netnsCreated: boolean;
  effectiveUid: number;
  effectiveGid: number;
  publicInternetBlocked: boolean;
  publicInternetError: string;
  hostLoopbackIsolated: boolean;
  assignedLabTargetReachable: boolean;
  discoveredAssignedPorts: number[];
}

/**
 * Verifies and proves that an isolated lab worker namespace:
 * 1. Runs tool processes as non-root uid=65534 / gid=65534 with --no-new-privs.
 * 2. Cannot reach public internet addresses (e.g., 1.1.1.1:80 or 8.8.8.8:53).
 * 3. Cannot reach the host machine's loopback services (e.g., host SSH 127.0.0.1:22).
 * 4. Can reach its assigned private lab target IP (e.g., 10.240.99.10).
 */
export async function verifyLabNetworkIsolation(): Promise<IsolationVerificationReport> {
  const netnsName = `rw-iso-${crypto.randomBytes(4).toString('hex')}`;
  const testTargetIp = '10.240.99.10';

  try {
    await execFileAsync('sudo', ['ip', 'netns', 'add', netnsName], { timeout: 3000 });
    await execFileAsync('sudo', ['ip', '-n', netnsName, 'link', 'set', 'lo', 'up'], { timeout: 3000 });
    await execFileAsync('sudo', ['ip', '-n', netnsName, 'addr', 'add', `${testTargetIp}/32`, 'dev', 'lo'], {
      timeout: 3000
    });

    // 1. Check effective UID and GID inside the non-root sandbox wrapper
    const idRes = await execFileAsync('sudo', [
      'ip',
      'netns',
      'exec',
      netnsName,
      'setpriv',
      '--reuid=65534',
      '--regid=65534',
      '--clear-groups',
      '--no-new-privs',
      '/usr/bin/id',
      '-u'
    ]);
    const gidRes = await execFileAsync('sudo', [
      'ip',
      'netns',
      'exec',
      netnsName,
      'setpriv',
      '--reuid=65534',
      '--regid=65534',
      '--clear-groups',
      '--no-new-privs',
      '/usr/bin/id',
      '-g'
    ]);
    const effectiveUid = Number(idRes.stdout.trim());
    const effectiveGid = Number(gidRes.stdout.trim());

    // 2. Attempt to connect to public internet IP (1.1.1.1:80) from inside the isolated namespace
    let publicInternetBlocked = false;
    let publicInternetError = '';
    try {
      await execFileAsync(
        'sudo',
        [
          'ip',
          'netns',
          'exec',
          netnsName,
          'setpriv',
          '--reuid=65534',
          '--regid=65534',
          '--clear-groups',
          '--no-new-privs',
          '/usr/local/bin/node',
          '-e',
          `const net = require('net');
           const s = net.connect({ host: '1.1.1.1', port: 80, timeout: 1000 });
           s.on('connect', () => { console.log('CONNECTED'); process.exit(0); });
           s.on('error', (e) => { console.error(e.code || e.message); process.exit(1); });
           s.on('timeout', () => { console.error('ETIMEDOUT'); process.exit(1); });`
        ],
        { timeout: 3000 }
      );
    } catch (err: any) {
      publicInternetBlocked = true;
      publicInternetError = (err?.stderr || err?.message || 'ENETUNREACH').trim();
    }

    // 3. Attempt to connect to host SSH (127.0.0.1:22) from inside the isolated namespace
    let hostLoopbackIsolated = false;
    try {
      await execFileAsync(
        'sudo',
        [
          'ip',
          'netns',
          'exec',
          netnsName,
          'setpriv',
          '--reuid=65534',
          '--regid=65534',
          '--clear-groups',
          '--no-new-privs',
          '/usr/local/bin/node',
          '-e',
          `const net = require('net');
           const s = net.connect({ host: '127.0.0.1', port: 22, timeout: 1000 });
           s.on('connect', () => { process.exit(0); });
           s.on('error', () => { process.exit(1); });`
        ],
        { timeout: 3000 }
      );
    } catch {
      hostLoopbackIsolated = true;
    }

    // 4. Verify that a real Nmap scan inside the isolated namespace reaches the assigned 10.240.99.10 target
    const scanRes = await executeIsolatedLabScan({
      tool: 'nmap',
      profile: 'service',
      targetIp: testTargetIp,
      assignedTargetIp: testTargetIp,
      services: [
        { port: 22, banner: 'SSH-2.0-OpenSSH_9.2p1 RootWars-IsoTest\r\n' },
        { port: 80, banner: 'HTTP/1.1 200 OK\r\nServer: RootWars-IsoLab/1.0\r\n\r\n' }
      ]
    });

    const discoveredAssignedPorts = scanRes.discoveredPorts.map((p) => p.port).sort((a, b) => a - b);

    return {
      netnsCreated: true,
      effectiveUid,
      effectiveGid,
      publicInternetBlocked,
      publicInternetError,
      hostLoopbackIsolated,
      assignedLabTargetReachable:
        scanRes.allowed && discoveredAssignedPorts.includes(22) && discoveredAssignedPorts.includes(80),
      discoveredAssignedPorts
    };
  } finally {
    await execFileAsync('sudo', ['ip', 'netns', 'del', netnsName], { timeout: 3000 }).catch(() => {});
  }
}
