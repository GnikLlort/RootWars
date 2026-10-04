/**
 * Explicit local demo seed command.
 *
 * Runs ONLY when invoked directly (`npm run db:demo-seed`). It refuses to run in
 * production and requires an explicit password (from `--password=...`, the
 * `DEMO_SEED_PASSWORD` environment variable, or a freshly generated random value
 * which is printed once). There is no shared, hard-coded demo password anywhere
 * in the code base.
 */

import crypto from 'node:crypto';
import { getDb } from './index.js';
import { seedDatabase } from './seed.js';

export function assertDemoSeedAllowed(env: NodeJS.ProcessEnv = process.env): void {
  if (env.NODE_ENV === 'production') {
    throw new Error(
      'Demo seeding is disabled in production: demo accounts and demo balances must never be part of a deployed instance.'
    );
  }
}

export function resolveDemoPassword(argv: string[], env: NodeJS.ProcessEnv): { password: string; generated: boolean } {
  const arg = argv.find((a) => a.startsWith('--password='));
  const fromArg = arg ? arg.slice('--password='.length) : undefined;
  const candidate = fromArg ?? env.DEMO_SEED_PASSWORD;
  if (candidate && candidate.length >= 8) {
    return { password: candidate, generated: false };
  }
  if (candidate && candidate.length < 8) {
    throw new Error('The supplied demo seed password must be at least 8 characters.');
  }
  return { password: crypto.randomBytes(18).toString('base64url'), generated: true };
}

async function main(): Promise<void> {
  assertDemoSeedAllowed();
  const { password, generated } = resolveDemoPassword(process.argv.slice(2), process.env);
  const db = await getDb();
  await seedDatabase(db, { demo: { password } });
  console.log('[RootWars Demo Seed] Demo fixture data created (rival operators, groups, bounties).');
  if (generated) {
    console.log(`[RootWars Demo Seed] Generated one-time demo password: ${password}`);
    console.log('[RootWars Demo Seed] Store it locally; it is not recoverable from the database.');
  }
  await db.close();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('[RootWars Demo Seed] Error:', err?.message ?? err);
    process.exit(1);
  });
}
