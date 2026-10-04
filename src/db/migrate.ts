import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseAdapter, getDb } from './index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Migrations are resolved at runtime so the same code works from source
 * (`src/db` during `tsx` dev/test) and from the compiled production build
 * (`dist/server/db` inside the API image). Before this, the compiled server
 * looked for `dist/migrations` and crashed on startup in production.
 */
export function candidateMigrationsDirs(fromDir: string): string[] {
  return [
    process.env.MIGRATIONS_DIR?.trim() || undefined,
    path.resolve(process.cwd(), 'migrations'),
    path.resolve(fromDir, '../../migrations'),
    path.resolve(fromDir, '../../../migrations')
  ].filter((dir): dir is string => Boolean(dir));
}

export function resolveMigrationsDir(fromDir: string = __dirname): string {
  for (const dir of candidateMigrationsDirs(fromDir)) {
    if (fs.existsSync(dir)) return dir;
  }
  throw new Error(
    `Unable to locate the RootWars migrations directory (tried: ${candidateMigrationsDirs(fromDir).join(', ')}). ` +
      'Set MIGRATIONS_DIR or run the server from the repository/container root.'
  );
}

export async function runMigrations(db?: DatabaseAdapter): Promise<string[]> {
  const database = db ?? (await getDb());
  await database.execSql(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  const migrationsDir = resolveMigrationsDir();
  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const applied: string[] = [];

  for (const file of files) {
    const existing = await database.query<{ version: string }>(
      'SELECT version FROM schema_migrations WHERE version = $1',
      [file]
    );
    if (existing.rows.length > 0) {
      continue;
    }

    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
    await database.execSql(sql);
    await database.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
    applied.push(file);
  }

  return applied;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runMigrations()
    .then(async (applied) => {
      console.log(`[RootWars Migrate] Applied migrations:`, applied.length ? applied : 'All up to date');
      const db = await getDb();
      await db.close();
    })
    .catch((err) => {
      console.error('[RootWars Migrate] Error:', err);
      process.exit(1);
    });
}
