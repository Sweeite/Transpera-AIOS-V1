/**
 * Per-tenant DB connection (tech-stack §2). The engine connects to EXACTLY ONE client's Supabase,
 * resolved from env (DATABASE_URL). There is no cross-tenant query path — isolation layer 1 (§8.2).
 */

/** Returns the Drizzle client bound to this tenant's Supabase project. Uses Supavisor pooling. */
export function getDb(): unknown {
  // TODO: create the pooled connection from DATABASE_URL; one instance per process.
  throw new Error('TODO: getDb');
}

export const TENANT_ID = process.env.TENANT_ID ?? (() => {
  throw new Error('TENANT_ID is required — the engine refuses to boot without a tenant (fail-closed).');
})();
