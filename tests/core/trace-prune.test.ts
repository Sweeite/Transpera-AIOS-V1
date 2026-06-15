/**
 * Issue #11 — TTL prune touches `traces` ONLY; `audit_log` is FOREVER. The two stores have opposite retention,
 * and the prune must never conflate them (PROBE: "prune an audit row"). Plus idempotence + fresh-row safety.
 */
import { describe, it, expect } from 'vitest';
import { freshDb, type Query } from './helpers/pglite.ts';
import { pruneTraces } from '../../packages/core/src/harness/trace.ts';
import { appendAudit, verifyChain } from '../../packages/core/src/audit/audit-log.ts';
import type { Principal } from '../../packages/shared/src/types.ts';

const principal: Principal = { kind: 'user', userId: 'u1' };

/** Insert a trace at an explicit age (days old) so the TTL boundary is testable without waiting. */
async function insertTraceAged(query: Query, daysOld: number): Promise<string> {
  const r = await query(
    `INSERT INTO traces (task_id, principal, trigger, kind, duration_ms, zone, sensitivity_level, namespace, created_at)
     VALUES ($1, $2::jsonb, 'chat', 'model', 1, 'general', 1, 'org', now() - make_interval(days => $3))
     RETURNING id`,
    ['00000000-0000-0000-0000-000000000001', JSON.stringify(principal), daysOld],
  );
  return String(r.rows[0].id);
}

describe('pruneTraces — traces are ephemeral, audit_log is permanent (#11)', () => {
  it('prunes a past-TTL trace, keeps a fresh one, and NEVER touches audit_log', async () => {
    const { query } = await freshDb();
    const oldId = await insertTraceAged(query, 60);
    const freshId = await insertTraceAged(query, 1);
    await appendAudit(query, { actor: 'u1', action: 'a.one', metadata: { v: 1 } });

    const pruned = await pruneTraces(query, { ttlDays: 30 });
    expect(pruned).toBe(1);

    const remaining = (await query(`SELECT id FROM traces`)).rows.map((r) => String(r.id));
    expect(remaining).toEqual([freshId]);
    expect(remaining).not.toContain(oldId);

    // The audit row is untouched — and the chain still verifies.
    expect((await query(`SELECT count(*)::int AS n FROM audit_log`)).rows[0].n).toBe(1);
    expect((await verifyChain(query)).ok).toBe(true);
  });

  it('is idempotent — a second prune deletes nothing more', async () => {
    const { query } = await freshDb();
    await insertTraceAged(query, 60);
    expect(await pruneTraces(query, { ttlDays: 30 })).toBe(1);
    expect(await pruneTraces(query, { ttlDays: 30 })).toBe(0);
  });
});
