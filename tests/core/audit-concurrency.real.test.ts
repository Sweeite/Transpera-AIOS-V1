/**
 * Issue #11 — the CONCURRENCY guard, on the REAL-PG lane. pglite is single-threaded, so it can prove the lock
 * SQL runs but NOT that it prevents a fork under true parallelism. Here N appenders fire concurrently against a
 * real Postgres: the pg advisory xact lock must serialise read-head+insert so the chain never forks.
 *
 * LOCAL-ONLY: self-skips unless SUPABASE_DB_URL is set (CI has no Docker — #51 automates a service container).
 * Run: SUPABASE_DB_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres pnpm test:core
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';
import { applyMigrations } from '../../control-plane/src/apply-migrations.ts';
import { appendAudit, verifyChain, type QueryFn, type TxFn } from '../../packages/core/src/audit/audit-log.ts';

const ADMIN_URL = process.env.SUPABASE_DB_URL;
const SCRATCH_DB = 'aios_audit_concurrency_lane';

function urlForDb(adminUrl: string, dbName: string): string {
  const u = new URL(adminUrl);
  u.pathname = `/${dbName}`;
  return u.toString();
}

describe.skipIf(!ADMIN_URL)('audit concurrency — advisory lock prevents a forked chain (#11, real PG)', () => {
  let scratchUrl: string;

  beforeAll(async () => {
    const admin = postgres(ADMIN_URL!, { max: 1 });
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
      await admin.unsafe(`CREATE DATABASE ${SCRATCH_DB}`);
    } finally {
      await admin.end({ timeout: 5 });
    }
    scratchUrl = urlForDb(ADMIN_URL!, SCRATCH_DB);
    await applyMigrations(scratchUrl);
  }, 60_000);

  afterAll(async () => {
    if (!ADMIN_URL) return;
    const admin = postgres(ADMIN_URL, { max: 1 });
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
    } finally {
      await admin.end({ timeout: 5 });
    }
  }, 60_000);

  it('N concurrent appends serialise into one unforked, verifiable chain', async () => {
    const N = 24;
    const sql = postgres(scratchUrl, { max: N + 4 });
    try {
      const query: QueryFn = async (q, params) => ({ rows: [...(await sql.unsafe(q, (params as any[]) ?? []))] });
      const transaction: TxFn = (fn) =>
        sql.begin((tx) => fn(async (q, params) => ({ rows: [...(await tx.unsafe(q, (params as any[]) ?? [])) ] }))) as Promise<any>;

      await Promise.all(
        Array.from({ length: N }, (_, i) => appendAudit(query, { actor: `u${i}`, action: 'race', metadata: { i } }, { transaction })),
      );

      // The chain verifies — no fork (a fork would break linkage: two rows sharing a prev_hash).
      const v = await verifyChain(query);
      expect(v.ok).toBe(true);
      expect(v.checkedRows).toBe(N);

      // No two non-genesis rows share a prev_hash (the fork signature), and exactly one genesis (null prev_hash).
      const rows = (await query(`SELECT prev_hash FROM audit_log`)).rows;
      const genesis = rows.filter((r) => r.prev_hash === null);
      expect(genesis.length).toBe(1);
      const nonGenesis = rows.filter((r) => r.prev_hash !== null).map((r) => r.prev_hash);
      expect(new Set(nonGenesis).size).toBe(nonGenesis.length); // all distinct ⇒ no fork
    } finally {
      await sql.end({ timeout: 5 });
    }
  }, 60_000);
});
