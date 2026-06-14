/**
 * applyMigrations — the SHARED primitive that applies `/migrations/*.sql` in lexical order to ONE database,
 * given its connection string (tech-stack §5.4). Scope is deliberately JUST that: apply-in-order.
 *
 * It is the single place that knows "the migration is the source of truth; run the SQL files in order" — the
 * SAME contract the pglite test helper honours. Three callers share it:
 *   • the real-Supabase test lane (tests/core/supabase-migration.real.test.ts) — the second test lane that
 *     catches pglite-vs-real divergence (#2 HNSW/extension trap),
 *   • migrate-all (#40) — which wraps this with tenant enumeration, per-project status, and halt-on-failure,
 *   • provisioning (#39) — first-boot schema apply.
 *
 * What it is NOT: a migration LEDGER. There is no "which migrations have already run" tracking here — callers
 * apply to a FRESH database (a new tenant, a test scratch DB). Forward-only re-application bookkeeping is the
 * migrate-all/#40 concern. Because the files are expand-only and mostly `IF NOT EXISTS`, re-running the
 * additive parts is safe, but the few `ADD CONSTRAINT` statements are not idempotent — so: apply to a fresh DB.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';

/** Repo-root `/migrations`, resolved from this file (control-plane/src → ../../migrations). */
export const MIGRATIONS_DIR = join(import.meta.dirname, '..', '..', 'migrations');

/** Every forward migration in lexical (= application) order. `.down.sql` files are excluded. */
export function migrationFiles(dir: string = MIGRATIONS_DIR): string[] {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
    .sort();
  if (files.length === 0) {
    throw new Error(`No migrations found in ${dir} — nothing to apply.`);
  }
  return files;
}

/**
 * Apply every migration in order to the database at `connectionString`. Uses a SINGLE session connection
 * (`max: 1`) — DDL wants a stable backend, and this is exactly the SESSION-mode path the worker uses. Each
 * file is one `unsafe()` call so multi-statement DDL (CREATE TABLE + indexes + constraints) runs as authored.
 * Returns the ordered list of files applied. Throws (and stops) on the first file that fails — no silent skip.
 */
export async function applyMigrations(connectionString: string, opts: { dir?: string } = {}): Promise<string[]> {
  const dir = opts.dir ?? MIGRATIONS_DIR;
  const files = migrationFiles(dir);
  const sql = postgres(connectionString, { max: 1 });
  try {
    for (const f of files) {
      const ddl = readFileSync(join(dir, f), 'utf8');
      await sql.unsafe(ddl);
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
  return files;
}
