/**
 * migrate-all — run a schema change across all tenant Supabase projects (Brief §8.1a; tech-stack §5.4).
 * EXPAND/CONTRACT discipline: additive migration → deploy → cleanup. The shared image must tolerate N and N-1.
 * Reports per-project status and HALTS deploy-all to any project that didn't migrate (no version skew).
 *
 * #7 de-stubbed the apply PRIMITIVE only — `applyMigrations(connectionString)` (apply-in-lexical-order). The
 * full migrate-all (enumerate tenants, per-project status, halt deploy-all on any failure, forward-only
 * ledger) remains #40; it will fan `applyMigrations` across every tenant connection string and collect status.
 */
export { applyMigrations, migrationFiles, MIGRATIONS_DIR } from './apply-migrations.js';

export async function migrateAll(): Promise<{ ok: string[]; failed: string[] }> {
  // TODO (#40): enumerate tenants; call applyMigrations() per project; collect per-project status; halt deploy-all.
  throw new Error('TODO: migrateAll (#40) — the apply primitive (applyMigrations) is ready; tenant fan-out is #40.');
}
