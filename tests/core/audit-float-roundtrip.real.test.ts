/**
 * Issue #11 — the FLOAT cry-wolf guard, on the REAL-PG lane (must-fix #2). #8 writes float metadata (0.608,
 * 0.92). The hash is over the stored `hash_input` TEXT, so a new row is bulletproof across engines. But a
 * ROLLOUT-WINDOW row (written by a pre-#11 image with NO hash_input) verifies by reconstructing canonical from
 * the jsonb-roundtripped columns — the float-sensitive path. This proves it does NOT cry tamper on a clean
 * float chain on real Postgres (where jsonb numeric handling may differ from pglite).
 *
 * LOCAL-ONLY: self-skips unless SUPABASE_DB_URL is set.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import postgres from 'postgres';
import { applyMigrations } from '../../control-plane/src/apply-migrations.ts';
import { appendAudit, verifyChain, canonicalizeAuditEntry, type QueryFn } from '../../packages/core/src/audit/audit-log.ts';

const ADMIN_URL = process.env.SUPABASE_DB_URL;
const SCRATCH_DB = 'aios_audit_float_lane';

function urlForDb(adminUrl: string, dbName: string): string {
  const u = new URL(adminUrl);
  u.pathname = `/${dbName}`;
  return u.toString();
}

describe.skipIf(!ADMIN_URL)('audit float roundtrip — no false tamper on a clean float chain (#11, real PG)', () => {
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

  it('a legacy (no hash_input) float row + a new float row both verify clean', async () => {
    const sql = postgres(scratchUrl, { max: 4 });
    try {
      const query: QueryFn = async (q, params) => ({ rows: [...(await sql.unsafe(q, (params as any[]) ?? []))] });

      // (1) Simulate a PRE-#11 genesis row: NO hash_input, hash computed the old way over JS canonical + ''.
      const legacy = { actor: 'u', action: 'config.applied', targetRef: 'r', metadata: { old: 0.608, new: 0.92 } };
      const legacyInput = canonicalizeAuditEntry(legacy);
      const legacyHash = createHash('sha256').update(`${legacyInput}\n`).digest('hex');
      await query(
        `INSERT INTO audit_log (actor, action, target_ref, metadata, prev_hash, hash)
         VALUES ($1,$2,$3,$4::jsonb,$5,$6)`,
        [legacy.actor, legacy.action, legacy.targetRef, JSON.stringify(legacy.metadata), null, legacyHash],
      );

      // (2) A NEW (#11) row with float metadata, written by the hardened appender (stores hash_input).
      await appendAudit(query, { actor: 'u2', action: 'config.applied', metadata: { old: 0.92, new: 0.97 } }, { unsafeUnlocked: true });

      const v = await verifyChain(query);
      expect(v.ok).toBe(true); // floats must not trigger false tamper on either path
      expect(v.checkedRows).toBe(2);
    } finally {
      await sql.end({ timeout: 5 });
    }
  }, 60_000);
});
