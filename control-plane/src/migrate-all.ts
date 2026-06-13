/**
 * migrate-all — run a schema change across all tenant Supabase projects (Brief §8.1a; tech-stack §5.4).
 * EXPAND/CONTRACT discipline: additive migration → deploy → cleanup. The shared image must tolerate N and N-1.
 * Reports per-project status and HALTS deploy-all to any project that didn't migrate (no version skew).
 */
export async function migrateAll(): Promise<{ ok: string[]; failed: string[] }> {
  // TODO: enumerate tenants; run forward-only migration per project transactionally; collect per-project status.
  throw new Error('TODO: migrateAll');
}
