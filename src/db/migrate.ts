import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseAdapter, getDb } from './index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

export async function runMigrations(db?: DatabaseAdapter): Promise<string[]> {
  const database = db ?? (await getDb());
  await database.execSql(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  const files = fs
    .readdirSync(MIGRATIONS_DIR)
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

    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8');
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
