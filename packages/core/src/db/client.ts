/**
 * Per-tenant DB connection (tech-stack §2). The engine connects to EXACTLY ONE client's Supabase,
 * resolved from env (DATABASE_URL). There is no cross-tenant query path — isolation layer 1 (§8.2).
 */

/**
 * Per-tenant connections. TWO are needed (the Supavisor transaction-mode trap, #7):
 *   - API/engine  → DATABASE_URL          (Supavisor TRANSACTION mode — fine for stateless queries)
 *   - worker tier → DATABASE_URL_SESSION  (SESSION/direct — pgmq, LISTEN, and advisory locks DO NOT
 *                                          work under transaction-mode pooling; the queue would deadlock)
 * Crons additionally take a per-tenant advisory lock so overlapping runs never double-write (#30).
 */
export function getDb(): unknown {
  // TODO: pooled (transaction-mode) connection from DATABASE_URL; one instance per process.
  throw new Error('TODO: getDb');
}

export function getWorkerDb(): unknown {
  // TODO: session-mode/direct connection from DATABASE_URL_SESSION — used by the worker + crons (pgmq, locks).
  throw new Error('TODO: getWorkerDb');
}

export const TENANT_ID = process.env.TENANT_ID ?? (() => {
  throw new Error('TENANT_ID is required — the engine refuses to boot without a tenant (fail-closed).');
})();
