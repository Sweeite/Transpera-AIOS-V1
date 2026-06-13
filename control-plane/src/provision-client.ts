/**
 * provision-client — stand up client N in ONE command (Brief §8.1a, §8.4; tech-stack §5.4).
 * Idempotent, resumable STATE MACHINE — a half-failed onboard never leaves an orphaned paid project.
 *
 *   pending → db_created → migrated → deployed → seeded
 *
 * Steps: create Supabase project (Management API) → run migrations → deploy Railway engine+worker (Railway API)
 *        → seed Identity Map from connectors + kick off bounded cold-start backfill (§10.3).
 */
type ProvisionState = 'pending' | 'db_created' | 'migrated' | 'deployed' | 'seeded';

export async function provisionClient(_args: {
  tenantId: string;
  region?: string; // residency: one-project-per-client lets you place each correctly (§5.2)
  resumeFrom?: ProvisionState; // re-runnable
}): Promise<void> {
  // TODO: each step idempotent + checkpointed; teardown on failure; never twenty minutes of clicking.
  throw new Error('TODO: provisionClient');
}
