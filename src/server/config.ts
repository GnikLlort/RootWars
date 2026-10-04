/**
 * RootWars centralized runtime configuration.
 *
 * Every security-relevant default lives here so that production startup can fail
 * fast instead of silently running with development secrets or unsafe knobs.
 */

export class ConfigError extends Error {
  public readonly problems: string[];
  constructor(problems: string[]) {
    super(`Invalid RootWars configuration:\n  - ${problems.join('\n  - ')}`);
    this.problems = problems;
  }
}

export type ServerRole = 'api' | 'worker' | 'all';
export type RateLimitFailMode = 'closed' | 'open';

/** Secrets/credentials that only ever belong to local development fixtures. */
export const KNOWN_DEV_SECRETS: readonly string[] = [
  'rootwars-dev-secret-key-2026-32bytes',
  'change-me-in-production-rootwars-32-byte-secret-key',
  'docker-compose-dev-secret-change-in-prod',
  'rootwars_dev_password',
  'RootWars!2026'
];

export interface LabRuntimeConfig {
  /** True when NODE_ENV=production; used to refuse unsafe lab endpoints. */
  isProduction: boolean;
  /** Docker endpoint used ONLY for disposable lab resources (never the host socket in production). */
  dockerHost: string | null;
  /** Fixed, image-verified nmap binary path. */
  nmapPath: string;
  nmapDataDir: string;
  /** Allowlisted scanner image (must contain nmap at nmapPath). */
  scannerImage: string;
  /** Allowlisted target container image (RootWars-owned service emulator). */
  targetImage: string;
  /** Hard wall-clock ceiling for one scan. */
  timeoutMs: number;
  /** Hard ceiling for captured nmap stdout, in bytes. */
  maxOutputBytes: number;
  /** Per-scan container resource limits. */
  scannerMemoryMb: number;
  scannerCpus: number;
  scannerPidsLimit: number;
  targetMemoryMb: number;
  targetCpus: number;
  targetPidsLimit: number;
  /** Timeout for docker control-plane commands (create/rm network, container start). */
  controlTimeoutMs: number;
}

export interface RateLimitConfig {
  authPerMinute: number;
  commandPerMinute: number;
  chatPerMinute: number;
  factionInteractPerMinute: number;
  worldEventPerMinute: number;
}

export interface RootWarsConfig {
  nodeEnv: string;
  isProduction: boolean;
  isTest: boolean;
  role: ServerRole;
  port: number;
  host: string;
  sessionSecret: string;
  sessionTtlSeconds: number;
  cookieSecure: boolean;
  allowedOrigins: string[];
  trustProxy: string | false;
  rateLimitFailMode: RateLimitFailMode;
  rateLimits: RateLimitConfig;
  requireRealRedis: boolean;
  redisUrl: string | null;
  databaseUrl: string | null;
  lab: LabRuntimeConfig;
}

function parseOrigins(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
}

function parseTrustProxy(raw: string | undefined): string | false {
  const value = (raw ?? '').trim();
  if (!value || value.toLowerCase() === 'false' || value === '0') {
    return false;
  }
  if (value.toLowerCase() === 'true') {
    return 'true';
  }
  return value; // explicit comma-separated list of trusted proxy IPs/CIDRs
}

/**
 * Builds the runtime configuration. When `NODE_ENV=production` the environment is
 * validated and startup is aborted if a development secret, demo credential, or
 * unsafe network knob is present.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): RootWarsConfig {
  const nodeEnv = env.NODE_ENV ?? 'development';
  const isProduction = nodeEnv === 'production';
  const isTest = nodeEnv === 'test' || Boolean(env.VITEST);

  const sessionSecret = env.SESSION_SECRET ?? 'rootwars-dev-secret-key-2026-32bytes';
  const allowedOrigins = parseOrigins(env.ALLOWED_ORIGINS);
  const roleRaw = (env.ROLE ?? (isProduction ? 'all' : 'all')).toLowerCase();
  const role: ServerRole = roleRaw === 'api' || roleRaw === 'worker' ? (roleRaw as ServerRole) : 'all';

  const redisUrl = env.REDIS_URL?.trim() ? env.REDIS_URL.trim() : null;
  const databaseUrl = env.DATABASE_URL?.trim() ? env.DATABASE_URL.trim() : null;

  const problems: string[] = [];

  if (isProduction) {
    if (!env.SESSION_SECRET) {
      problems.push('SESSION_SECRET must be set explicitly in production (no development default is provided).');
    } else if (sessionSecret.length < 32) {
      problems.push('SESSION_SECRET must be at least 32 characters in production.');
    } else if (KNOWN_DEV_SECRETS.includes(sessionSecret)) {
      problems.push('SESSION_SECRET matches a known development secret; refusing to start in production.');
    }

    if (env.DEMO_SEED_PASSWORD || env.ALLOW_DEMO_SEED === 'true') {
      problems.push(
        'Demo seeding credentials (DEMO_SEED_PASSWORD / ALLOW_DEMO_SEED) must never be configured in production.'
      );
    }

    if (!redisUrl) {
      problems.push('REDIS_URL is required in production: rate limiting and multi-instance event fan-out must not silently degrade.');
    }

    if (env.FORCE_REDIS_MOCK === 'true') {
      problems.push('FORCE_REDIS_MOCK must not be enabled in production.');
    }

    if (env.FORCE_PGLITE === 'true') {
      problems.push('FORCE_PGLITE must not be enabled in production.');
    }

    if (databaseUrl && KNOWN_DEV_SECRETS.some((secret) => databaseUrl.includes(secret))) {
      problems.push('DATABASE_URL contains a known development database password; refusing to start in production.');
    }

    if (allowedOrigins.length === 0) {
      problems.push('ALLOWED_ORIGINS must list the exact browser origins allowed to call this API (comma separated).');
    }

    if ((env.TRUST_PROXY ?? '').toLowerCase() === 'true') {
      problems.push(
        'TRUST_PROXY=true is unsafe in production; configure an explicit list of trusted proxy IPs/CIDRs instead.'
      );
    }

    if (env.RATE_LIMIT_FAIL_MODE === 'open') {
      problems.push('RATE_LIMIT_FAIL_MODE=open is refused in production: rate limiting must fail closed.');
    }

    if (!env.LAB_DOCKER_HOST) {
      // Not fatal: the lab runner reports itself unavailable and every lab scan fails closed.
    } else if (env.LAB_DOCKER_HOST === 'unix:///var/run/docker.sock') {
      problems.push(
        'LAB_DOCKER_HOST must point at a dedicated lab Docker endpoint, not the host Docker socket, in production.'
      );
    }

    if (env.LAB_ALLOW_HOST_DOCKER === 'true') {
      problems.push('LAB_ALLOW_HOST_DOCKER must not be enabled in production.');
    }
  }

  if (problems.length > 0) {
    throw new ConfigError(problems);
  }

  return {
    nodeEnv,
    isProduction,
    isTest,
    role,
    port: Number(env.PORT ?? 3000),
    host: env.HOST ?? '0.0.0.0',
    sessionSecret,
    sessionTtlSeconds: Number(env.SESSION_TTL_SECONDS ?? 86400),
    cookieSecure: isProduction || env.COOKIE_SECURE === 'true',
    allowedOrigins,
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    rateLimitFailMode: (env.RATE_LIMIT_FAIL_MODE ?? 'closed') === 'open' ? 'open' : 'closed',
    rateLimits: {
      authPerMinute: Number(env.RATE_LIMIT_MAX_PER_MINUTE ?? 30),
      commandPerMinute: Number(env.COMMAND_RATE_LIMIT_PER_MINUTE ?? 120),
      chatPerMinute: Number(env.CHAT_RATE_LIMIT_PER_MINUTE ?? 30),
      factionInteractPerMinute: Number(env.FACTION_RATE_LIMIT_PER_MINUTE ?? 10),
      worldEventPerMinute: Number(env.WORLD_EVENT_RATE_LIMIT_PER_MINUTE ?? 2)
    },
    requireRealRedis: isProduction,
    redisUrl,
    databaseUrl,
    lab: {
      isProduction,
      dockerHost: env.LAB_DOCKER_HOST?.trim() ? env.LAB_DOCKER_HOST.trim() : null,
      nmapPath: env.LAB_NMAP_PATH ?? '/usr/bin/nmap',
      nmapDataDir: env.LAB_NMAP_DATADIR ?? '/usr/share/nmap',
      scannerImage: env.LAB_SCANNER_IMAGE ?? 'rootwars/lab-scanner:1.0.0',
      targetImage: env.LAB_TARGET_IMAGE ?? 'rootwars/lab-target:1.0.0',
      timeoutMs: Number(env.LAB_TIMEOUT_MS ?? 8000),
      maxOutputBytes: Number(env.LAB_MAX_OUTPUT_BYTES ?? 65536),
      scannerMemoryMb: Number(env.LAB_SCANNER_MEMORY_MB ?? 256),
      scannerCpus: Number(env.LAB_SCANNER_CPUS ?? 0.5),
      scannerPidsLimit: Number(env.LAB_SCANNER_PIDS_LIMIT ?? 32),
      targetMemoryMb: Number(env.LAB_TARGET_MEMORY_MB ?? 128),
      targetCpus: Number(env.LAB_TARGET_CPUS ?? 0.25),
      targetPidsLimit: Number(env.LAB_TARGET_PIDS_LIMIT ?? 64),
      controlTimeoutMs: Number(env.LAB_CONTROL_TIMEOUT_MS ?? 20000)
    }
  };
}

let cached: RootWarsConfig | null = null;

export function getConfig(): RootWarsConfig {
  if (!cached) {
    cached = loadConfig();
  }
  return cached;
}

/** Test helper: drop the cached configuration so `loadConfig` runs again. */
export function resetConfigCache(): void {
  cached = null;
}
