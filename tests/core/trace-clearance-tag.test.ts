/**
 * Issue #11 — THE WATCH: "don't let a trace become a permanent shadow copy that bypasses the permission model."
 * A trace carries the SAME access columns as memories/chunks (zone, sensitivity_level, namespace), so the SAME
 * rbac.retrievalWhereSql predicate filters it — verbatim. These are the leak probes turned regressions:
 *   • a trace is filtered identically to a memory under the same clearance;
 *   • a MULTI-zone span (tagged '_untagged') is invisible to a partial-clearance user (zones are unordered —
 *     no "union zone"; the fail-closed sentinel is the only sound tag);
 *   • a cross-NAMESPACE trace is invisible when the namespace isn't authorized (the namespace backdoor);
 *   • the default/untagged span is invisible to everyone (fail-closed).
 */
import { describe, it, expect } from 'vitest';
import { freshDb, type Query } from './helpers/pglite.ts';
import { seedDemoRows } from './helpers/seed.ts';
import { buildRetrievalPredicate, retrievalWhereSql } from '../../packages/core/src/rbac/permissions.ts';
import { emitSpan, tagFromSources, UNTAGGED, type ClearanceTag } from '../../packages/core/src/harness/trace.ts';
import type { Clearance, Namespace, Principal } from '../../packages/shared/src/types.ts';

const principal: Principal = { kind: 'user', userId: 'u1' };

async function emitTagged(query: Query, tag: ClearanceTag, taskId = '00000000-0000-0000-0000-000000000009') {
  return emitSpan(
    { taskId, principal, trigger: 'chat', kind: 'model', model: 'm', durationMs: 1 },
    tag,
    { query },
  );
}

/** Visible trace ids under a clearance, using the PRODUCTION predicate (the same one memories/chunks use). */
async function visibleTraces(query: Query, clearance: Clearance, namespaces: Namespace[]): Promise<Set<string>> {
  const pred = buildRetrievalPredicate(clearance, namespaces);
  const { sql, params } = retrievalWhereSql(pred);
  const res = await query(`SELECT id FROM traces WHERE ${sql}`, params);
  return new Set(res.rows.map((r) => String(r.id)));
}

describe('trace clearance tag — filtered exactly like memories/chunks (#11 Watch)', () => {
  it('a single-zone trace is filtered identically to a memory under the same clearance', async () => {
    const { query } = await freshDb();
    await seedDemoRows(query); // memories/chunks across zones
    const finId = await emitTagged(query, { zone: 'finance', sensitivityLevel: 3, namespace: 'org' });
    const hrId = await emitTagged(query, { zone: 'hr', sensitivityLevel: 5, namespace: 'org' });

    // Cleared for finance up to s3 ⇒ sees the finance trace, not the hr trace — like fin-1 vs hr-1 on memories.
    const clearance: Clearance = { allowedZones: ['finance'], maxSensitivity: 3 };
    const seen = await visibleTraces(query, clearance, ['org']);
    expect(seen.has(finId)).toBe(true);
    expect(seen.has(hrId)).toBe(false);

    const mem = (await query(`SELECT content_hash FROM memories WHERE ${retrievalWhereSql(buildRetrievalPredicate(clearance, ['org'])).sql}`,
      retrievalWhereSql(buildRetrievalPredicate(clearance, ['org'])).params)).rows.map((r) => r.content_hash);
    expect(mem).toContain('sha256:fin-1'); // same predicate, same visibility shape
  });

  it('a MULTI-zone span gets the fail-closed sentinel and is invisible to a partial-clearance user', async () => {
    const { query } = await freshDb();
    // content spanned finance AND hr → no sound single zone → sentinel.
    const tag = tagFromSources([
      { zone: 'finance', sensitivityLevel: 3, namespace: 'org' },
      { zone: 'hr', sensitivityLevel: 2, namespace: 'org' },
    ]);
    expect(tag.zone).toBe(UNTAGGED);
    expect(tag.sensitivityLevel).toBe(3); // max of the two
    const id = await emitTagged(query, tag);

    // A user cleared for BOTH finance and hr at max sensitivity still can't see it — '_untagged' is in no list.
    const broad: Clearance = { allowedZones: ['finance', 'hr', 'general'], maxSensitivity: 5 };
    const seen = await visibleTraces(query, broad, ['org']);
    expect(seen.has(id)).toBe(false);
  });

  it('a cross-namespace trace is invisible when the namespace is not authorized (the namespace backdoor)', async () => {
    const { query } = await freshDb();
    const id = await emitTagged(query, { zone: 'general', sensitivityLevel: 1, namespace: 'client:acme' });
    // Same zone + sensitivity, but the reader is only authorized for 'org' → must NOT see the client:acme trace.
    const clearance: Clearance = { allowedZones: ['general'], maxSensitivity: 5 };
    const seen = await visibleTraces(query, clearance, ['org']);
    expect(seen.has(id)).toBe(false);
    // authorized for the right namespace ⇒ visible (sanity: the filter isn't just always-deny).
    const seenRight = await visibleTraces(query, clearance, ['client:acme']);
    expect(seenRight.has(id)).toBe(true);
  });

  it('the DB-default (untagged) span is invisible to everyone — fail-closed', async () => {
    const { query } = await freshDb();
    // Insert a span the way an old (pre-#11) writer would — no tag columns → DB defaults apply.
    const id = String((await query(
      `INSERT INTO traces (task_id, principal, trigger, kind, duration_ms)
       VALUES ($1, $2::jsonb, 'chat', 'model', 1) RETURNING id`,
      ['00000000-0000-0000-0000-000000000003', JSON.stringify(principal)],
    )).rows[0].id);

    const row = (await query(`SELECT zone, sensitivity_level, namespace FROM traces WHERE id = $1`, [id])).rows[0];
    expect(row.zone).toBe(UNTAGGED);
    expect(row.sensitivity_level).toBe(5);
    expect(row.namespace).toBe(UNTAGGED);

    const broad: Clearance = { allowedZones: ['general', 'finance', 'hr', 'legal', 'exec'], maxSensitivity: 5 };
    const seen = await visibleTraces(query, broad, ['org', 'client:acme']);
    expect(seen.has(id)).toBe(false);
  });
});
