/**
 * Issue #55 — the jsonb DRIVER-DIVERGENCE regression, on the REAL-PG lane. Found in the #11 review: under
 * postgres.js with `prepare: false` (the Supavisor invariant) a PARAMETERIZED jsonb read comes back as RAW
 * TEXT, not a parsed object/scalar — proven against pgvector:0.8.0-pg15. So on a real client:
 *   • rollbackConfig read audit_log.metadata as an object → meta.key/old undefined → "not a config change".
 *   • getConfig read system_config.value as a scalar → wrong type → false anomaly → silent fall-back to default.
 *   • approveConfigChange read config_proposals.proposed_value → "0.608" (string) → validateWrite wrongly rejects.
 *
 * pglite CANNOT catch any of this — it pre-parses jsonb, so the bug is invisible there (the divergence #11 hit).
 * This lane uses the SAME raw-SQL+positional-params path (`sql.unsafe(q, params)`) the production QueryFn will
 * use, so the raw-text shape is exercised. The fix (db/jsonb.ts: asObject + type-directed asConfigValue) makes
 * all three paths driver-agnostic. Each `it` is a permanent regression test.
 *
 * LOCAL/CI-ONLY: self-skips unless SUPABASE_DB_URL is set (the real-postgres CI lane sets it; #51).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import postgres from 'postgres';
import { applyMigrations } from '../../control-plane/src/apply-migrations.ts';
import {
  getConfig,
  proposeConfigChange,
  approveConfigChange,
  rollbackConfig,
  type ConfigDeps,
} from '../../packages/core/src/config/system-config.ts';
import type { QueryFn, TxFn } from '../../packages/core/src/audit/audit-log.ts';

const ADMIN_URL = process.env.SUPABASE_DB_URL;
const SCRATCH_DB = 'aios_system_config_lane';

function urlForDb(adminUrl: string, dbName: string): string {
  const u = new URL(adminUrl);
  u.pathname = `/${dbName}`;
  return u.toString();
}

describe.skipIf(!ADMIN_URL)('system_config — jsonb driver divergence is normalised on real PG (#55)', () => {
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

  /** A fresh connection per test (clean state), `prepare: false` — production's config exactly, so jsonb comes
   *  back as RAW TEXT. The TxFn serialises audit appends on the advisory lock inside one backend (the prod path). */
  async function withDb<T>(fn: (deps: ConfigDeps, reset: () => Promise<void>) => Promise<T>): Promise<T> {
    const sql = postgres(scratchUrl, { max: 4, prepare: false });
    try {
      const query: QueryFn = async (q, params) => ({ rows: [...(await sql.unsafe(q, (params as any[]) ?? []))] });
      const transaction: TxFn = (run) =>
        sql.begin(async (tx) => run(async (q, params) => ({ rows: [...(await tx.unsafe(q, (params as any[]) ?? []))] }))) as Promise<any>;
      const reset = async () => {
        await query(`DELETE FROM config_proposals`);
        await query(`DELETE FROM system_config`);
        await query(`DELETE FROM audit_log`);
      };
      await reset();
      return await fn({ query, transaction }, reset);
    } finally {
      await sql.end({ timeout: 5 });
    }
  }

  it('rollback round-trip: a prior APPLIED value is restored from audit_log.metadata (object jsonb)', async () => {
    await withDb(async (deps) => {
      // chunk_ttl_days is cosmetic (qualityAffecting:false) ⇒ instant-apply + audited. Two applies so the
      // restored value (120) is NOT the declared default (90) — a default-equals-restore can't prove the read.
      await proposeConfigChange('chunk_ttl_days', 120, 'first', deps);
      expect(await getConfig('chunk_ttl_days', 'org', deps)).toBe(120);

      const second = await proposeConfigChange('chunk_ttl_days', 150, 'second', deps);
      if (second.status !== 'applied') throw new Error('expected instant apply');
      expect(await getConfig('chunk_ttl_days', 'org', deps)).toBe(150);

      // The bug: metadata read as object → meta.old undefined → throws. Fixed: asObject parses it → old = 120.
      await rollbackConfig(second.auditId, deps);
      expect(await getConfig('chunk_ttl_days', 'org', deps)).toBe(120); // restored, not 150 and not default 90
    });
  }, 60_000);

  it('approve round-trip: a numeric proposed_value (scalar jsonb) applies, not rejected as a string', async () => {
    await withDb(async (deps) => {
      // retrieval_max_results is quality-affecting ⇒ parked until approve. proposed_value comes back as the raw
      // text "42" on real PG; the bug had validateWrite reject it ("expected number, got string").
      const r = await proposeConfigChange('retrieval_max_results', 42, 'bump', deps);
      if (r.status !== 'pending') throw new Error('expected a pending proposal');
      expect(await getConfig('retrieval_max_results', 'org', deps)).toBe(20); // pending is invisible to reads

      await approveConfigChange(r.proposalId, deps);
      expect(await getConfig('retrieval_max_results', 'org', deps)).toBe(42); // applied through the normaliser
    });
  }, 60_000);

  it('getConfig reads a STORED override (scalar jsonb) — not the default, with NO false anomaly', async () => {
    await withDb(async (deps) => {
      // Seed an in-bounds override straight into the table (raw-text path). The bug: value read as the string
      // "0.7" → type_mismatch anomaly → silent fall-back to the 0.608 default. Fixed: asConfigValue → 0.7.
      await deps.query(
        `INSERT INTO system_config (key, namespace, value) VALUES ($1, $2, $3::jsonb)`,
        ['retrieval_min_relevance', null, JSON.stringify(0.7)],
      );
      const onAnomaly = vi.fn();
      expect(await getConfig('retrieval_min_relevance', 'org', { ...deps, onAnomaly })).toBe(0.7);
      expect(onAnomaly).not.toHaveBeenCalled(); // a stored, in-bounds value must NOT trip the alarm
    });
  }, 60_000);
});
