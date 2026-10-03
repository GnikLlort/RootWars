import net from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

interface ServiceSpec {
  port: number;
  banner: string;
}

interface SandboxPayload {
  targetIp: string;
  nmapPath: string;
  nmapDataDir: string;
  nmapArgs: string[];
  services: ServiceSpec[];
  timeoutMs: number;
}

async function runSandbox(): Promise<void> {
  const rawPayload = process.argv[2];
  if (!rawPayload) {
    process.stderr.write('Missing sandbox payload argument\n');
    process.exit(2);
  }

  const payload: SandboxPayload = JSON.parse(rawPayload);
  const servers: net.Server[] = [];

  try {
    // 1. Start disposable TCP service emulators bound ONLY to the assigned 10.240.x.x target IP
    for (const svc of payload.services) {
      const srv = net.createServer((socket) => {
        socket.on('error', () => {});
        // Immediately write banner on connect (for SSH/SMTP/IRC/Modbus) and also respond to HTTP probes
        if (svc.banner && !svc.banner.startsWith('HTTP/')) {
          socket.write(svc.banner);
        }
        socket.on('data', () => {
          if (svc.banner) {
            socket.write(svc.banner);
          }
          socket.end();
        });
        setTimeout(() => {
          socket.destroy();
        }, 1500).unref();
      });

      await new Promise<void>((resolve, reject) => {
        srv.once('error', reject);
        srv.listen(svc.port, payload.targetIp, () => resolve());
      });
      servers.push(srv);
    }

    // 2. Execute real Nmap as non-root (65534:65534) with no-new-privs and resource limits via execFile (NEVER shell)
    const args = [
      '--as=268435456',
      '--cpu=8',
      '--nproc=32',
      'setpriv',
      '--reuid=65534',
      '--regid=65534',
      '--clear-groups',
      '--no-new-privs',
      payload.nmapPath,
      '--datadir',
      payload.nmapDataDir,
      ...payload.nmapArgs,
      payload.targetIp
    ];

    const start = Date.now();
    const { stdout, stderr } = await execFileAsync('/usr/bin/prlimit', args, {
      timeout: payload.timeoutMs,
      maxBuffer: 1024 * 512,
      env: {
        PATH: '/usr/local/bin:/usr/bin:/bin',
        LANG: 'C'
      }
    });
    const durationMs = Date.now() - start;

    process.stdout.write(
      JSON.stringify({
        ok: true,
        stdout,
        stderr,
        durationMs
      }) + '\n'
    );
  } catch (err: any) {
    process.stdout.write(
      JSON.stringify({
        ok: false,
        error: err?.message ?? String(err),
        stdout: err?.stdout ?? '',
        stderr: err?.stderr ?? ''
      }) + '\n'
    );
  } finally {
    for (const srv of servers) {
      try {
        srv.close();
      } catch {}
    }
  }
}

runSandbox();
