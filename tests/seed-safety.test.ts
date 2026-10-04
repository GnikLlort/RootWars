import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { createDatabase } from '../src/db/index.js';
import { createRedisClients } from '../src/db/redis.js';
import { seedDatabase } from '../src/db/seed.js';
import { ConfigError, KNOWN_DEV_SECRETS, loadConfig } from '../src/server/config.js';
import { candidateMigrationsDirs, resolveMigrationsDir } from '../src/db/migrate.js';
import { assertDemoSeedAllowed, resolveDemoPassword } from '../src/db/demo-seed.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => fs.readFileSync(path.join(repoRoot, rel), 'utf-8');

const productionEnv = (overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv =>
  ({
    NODE_ENV: 'production',
    SESSION_SECRET: 'unique-production-secret-value-0123456789abcdef',
    REDIS_URL: 'redis://redis:6379',
    ALLOWED_ORIGINS: 'https://rootwars.example',
    DATABASE_URL: 'postgresql://rootwars:strong-unique-password@postgres:5432/rootwars',
    ...overrides
  }) as NodeJS.ProcessEnv;

describe('Production startup safety (credentials & demo seeding)', () => {
  it('never creates demo accounts with the world seed', async () => {
    const db = await createDatabase({ pgliteDataDir: 'memory://' });
    try {
      await seedDatabase(db);

      const users = await db.query<{ count: string }>('SELECT COUNT(*) as count FROM users');
      expect(Number(users.rows[0].count)).toBe(0);

      // World content is present even without demo fixtures.
      const regions = await db.query('SELECT id FROM regions');
      expect(regions.rows.length).toBe(2);
      const missions = await db.query(`SELECT id FROM missions WHERE is_lab_mission = TRUE`);
      expect(missions.rows.length).toBe(5);
      const nodes = await db.query(`SELECT COUNT(*)::int AS count FROM network_nodes WHERE category <> 'player'`);
      expect(nodes.rows[0].count).toBe(27); // 24 Neo-Cascadia + 3 Helvetia NPC nodes; player nodes are demo-only
      const market = await db.query('SELECT COUNT(*)::int AS count FROM market_items');
      expect(market.rows[0].count).toBeGreaterThan(0);
      const demoNodes = await db.query(`SELECT COUNT(*)::int AS count FROM network_nodes WHERE category = 'player'`);
      expect(demoNodes.rows[0].count).toBe(0);
    } finally {
      await db.close();
    }
  }, 60000);

  it('creates demo accounts only when an explicit password is supplied', async () => {
    const db = await createDatabase({ pgliteDataDir: 'memory://' });
    try {
      const password = crypto.randomBytes(15).toString('base64url');
      await seedDatabase(db, { demo: { password } });

      const users = await db.query<{ username: string }>(
        `SELECT username FROM users WHERE id LIKE 'usr-%' ORDER BY username`
      );
      expect(users.rows.map((u) => u.username)).toEqual([
        'cipher_wolf',
        'kestrel_9',
        'nyx_zero',
        'vortex_prime'
      ]);

      // The supplied password is the only thing that authenticates those accounts.
      const { verifyPassword } = await import('../src/server/security.js');
      const stored = await db.query<{ password_hash: string }>(
        `SELECT password_hash FROM users WHERE username = 'cipher_wolf'`
      );
      expect(await verifyPassword(password, stored.rows[0].password_hash)).toBe(true);
      expect(await verifyPassword('RootWars!2026', stored.rows[0].password_hash)).toBe(false);
    } finally {
      await db.close();
    }
  }, 60000);

  it('refuses to seed demo fixtures in production', () => {
    expect(() => assertDemoSeedAllowed({ NODE_ENV: 'production' } as NodeJS.ProcessEnv)).toThrow(/disabled in production/);
    expect(() => assertDemoSeedAllowed({ NODE_ENV: 'development' } as NodeJS.ProcessEnv)).not.toThrow();
  });

  it('generates a random demo password when none is supplied and validates the provided one', () => {
    const generated = resolveDemoPassword([], {} as NodeJS.ProcessEnv);
    expect(generated.generated).toBe(true);
    expect(generated.password.length).toBeGreaterThanOrEqual(24);

    const provided = resolveDemoPassword(['--password=MyLocalDemoPassword1'], {} as NodeJS.ProcessEnv);
    expect(provided).toEqual({ password: 'MyLocalDemoPassword1', generated: false });

    expect(() => resolveDemoPassword(['--password=short'], {} as NodeJS.ProcessEnv)).toThrow(/at least 8/);
  });

  it('fails production startup when development secrets or demo credentials are configured', () => {
    expect(() => loadConfig(productionEnv({ SESSION_SECRET: undefined }))).toThrow(ConfigError);
    expect(() => loadConfig(productionEnv({ SESSION_SECRET: KNOWN_DEV_SECRETS[0] }))).toThrow(/known development secret/);
    expect(() => loadConfig(productionEnv({ SESSION_SECRET: 'short' }))).toThrow(/at least 32 characters/);
    expect(() => loadConfig(productionEnv({ DEMO_SEED_PASSWORD: 'anything' }))).toThrow(/Demo seeding/);
    expect(() => loadConfig(productionEnv({ ALLOW_DEMO_SEED: 'true' }))).toThrow(/Demo seeding/);
    expect(() => loadConfig(productionEnv({ DATABASE_URL: 'postgresql://rootwars:rootwars_dev_password@db:5432/x' }))).toThrow(
      /development database password/
    );
    expect(() => loadConfig(productionEnv({ REDIS_URL: undefined }))).toThrow(/REDIS_URL is required/);
    expect(() => loadConfig(productionEnv({ ALLOWED_ORIGINS: undefined }))).toThrow(/ALLOWED_ORIGINS/);
    expect(() => loadConfig(productionEnv({ TRUST_PROXY: 'true' }))).toThrow(/TRUST_PROXY=true is unsafe/);
    expect(() => loadConfig(productionEnv({ RATE_LIMIT_FAIL_MODE: 'open' }))).toThrow(/fail closed/);

    // A correctly configured production environment loads.
    const config = loadConfig(productionEnv());
    expect(config.isProduction).toBe(true);
    expect(config.cookieSecure).toBe(true);
    expect(config.rateLimitFailMode).toBe('closed');
    expect(config.trustProxy).toBe(false);
  });

  it('does not seed or advertise credentials during server startup', () => {
    const serverSource = read('src/server/index.ts');
    expect(serverSource).not.toMatch(/seedDatabase/);
    expect(serverSource).toMatch(/runMigrations/);
    expect(read('src/db/seed.ts')).not.toMatch(/RootWars!2026/);

    const readme = read('README.md');
    expect(readme).not.toMatch(/RootWars!2026/);
  });
});

describe('Deployment configuration regressions', () => {
  it('runs the API with the compiled production server and never mounts the Docker socket', () => {
    const dockerfileApi = read('Dockerfile.api');
    expect(dockerfileApi).toMatch(/CMD \["node", "dist\/server\/server\/index\.js"\]/);
    expect(dockerfileApi).not.toMatch(/tsx/);
    expect(dockerfileApi).toMatch(/USER node/);

    const compose = read('docker-compose.yml');
    expect(compose).not.toMatch(/docker\.sock/);
    const apiSection = compose.slice(compose.indexOf('  api:'), compose.indexOf('  lab-worker:'));
    expect(apiSection).not.toMatch(/docker\.sock/);
    expect(apiSection).toMatch(/ROLE: api/);
    expect(compose).toMatch(/POSTGRES_PASSWORD:\s*\$\{POSTGRES_PASSWORD:\?/);
    expect(compose).toMatch(/SESSION_SECRET:\s*\$\{SESSION_SECRET:\?/);
  });

  it('keeps the fixed nmap path consistent between the scanner image and the backend default', () => {
    const scannerDockerfile = read('Dockerfile.lab-scanner');
    expect(scannerDockerfile).toMatch(/ENTRYPOINT \["\/usr\/bin\/nmap"\]/);

    const config = loadConfig({ NODE_ENV: 'development' } as NodeJS.ProcessEnv);
    expect(config.lab.nmapPath).toBe('/usr/bin/nmap');

    // The legacy apt/static-binary path must no longer be the default anywhere.
    expect(read('.env.example')).not.toMatch(/LAB_NMAP_PATH=\/usr\/local\/bin\/nmap/);
  });

  it('starts the worker loop only for worker-capable roles', () => {
    const source = read('src/server/index.ts');
    expect(source).toMatch(/config\.role !== 'api'/);
    const workerSource = read('src/workers/index.ts');
    expect(workerSource).toMatch(/startOutboxLoop\(db, \{ workerId, role: 'worker'/);
  });

  it('fails fast in production instead of silently falling back to embedded backends', async () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      await expect(
        createDatabase({ databaseUrl: 'postgresql://nobody:nopass@127.0.0.1:1/none' })
      ).rejects.toThrow(/never falls back to embedded PGlite/);
      await expect(createRedisClients('redis://127.0.0.1:1')).rejects.toThrow(
        /never falls back to the embedded mock/
      );
    } finally {
      process.env.NODE_ENV = previous;
    }
  }, 30000);

  it('resolves the migrations directory from both source and compiled layouts', () => {
    const fromSource = candidateMigrationsDirs(path.join(repoRoot, 'src/db'));
    expect(fromSource).toContain(path.join(repoRoot, 'migrations'));

    const fromCompiled = candidateMigrationsDirs(path.join(repoRoot, 'dist/server/db'));
    expect(fromCompiled).toContain(path.join(repoRoot, 'migrations'));

    const resolved = resolveMigrationsDir();
    expect(fs.existsSync(path.join(resolved, '001_initial_schema.sql'))).toBe(true);
    expect(fs.existsSync(path.join(resolved, '002_pvp_atomicity.sql'))).toBe(true);
  });

  it('documents the lab limitation instead of claiming netns scanning works', () => {
    const readme = read('README.md');
    expect(readme).not.toMatch(/verifyLabNetworkIsolation/);
    expect(readme).not.toMatch(/ip netns/);
  });
});
