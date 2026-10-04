/**
 * RootWars disposable lab target entrypoint.
 *
 * Started by the lab backend as one container per mission on a dedicated
 * `--internal` Docker network. It listens on the mission's RootWars-owned service
 * specification (passed via the ROOTWARS_LAB_SERVICES environment variable as a
 * JSON array of { port, banner }) and is destroyed with the mission.
 *
 * `--selfcheck` opens a TCP connection to every configured port and exits 0 only
 * when all listeners are ready; the backend uses this to avoid scanning before the
 * target is up.
 */

import net from 'node:net';

const SELF_CHECK = process.argv.includes('--selfcheck');

function parseServices() {
  const raw = process.env.ROOTWARS_LAB_SERVICES ?? '[]';
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('ROOTWARS_LAB_SERVICES is not valid JSON');
  }
  if (!Array.isArray(parsed) || parsed.length > 16) {
    throw new Error('ROOTWARS_LAB_SERVICES must be an array of at most 16 services');
  }
  return parsed.map((svc) => {
    const port = Number(svc?.port);
    const banner = String(svc?.banner ?? '');
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`invalid lab service port: ${svc?.port}`);
    }
    return { port, banner };
  });
}

function check(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port, timeout: 1000 });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
  });
}

async function main() {
  const services = parseServices();

  if (SELF_CHECK) {
    const results = await Promise.all(services.map((svc) => check(svc.port)));
    if (results.every(Boolean)) {
      process.exit(0);
    }
    process.stderr.write(`selfcheck failed: ${JSON.stringify(results)}\n`);
    process.exit(1);
  }

  const servers = services.map((svc) => {
    const server = net.createServer((socket) => {
      socket.on('error', () => {});
      if (svc.banner && !svc.banner.startsWith('HTTP/')) {
        socket.write(svc.banner);
      }
      socket.on('data', () => {
        if (svc.banner) {
          socket.write(svc.banner);
        }
        socket.end();
      });
      setTimeout(() => socket.destroy(), 2000).unref();
    });
    server.listen(svc.port, '0.0.0.0');
    return server;
  });

  const shutdown = () => {
    for (const server of servers) {
      try {
        server.close();
      } catch {
        /* ignore */
      }
    }
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  process.stdout.write(`[lab-target] listening on ${services.map((s) => s.port).join(', ')}\n`);
}

main().catch((err) => {
  process.stderr.write(`[lab-target] fatal: ${err?.message ?? err}\n`);
  process.exit(2);
});
