/**
 * Issue #2 — LEAK PREVENTION (not just plumbing). `chunks` carry `zone` + `sensitivity` and are
 * permission-filtered EXACTLY like `memories` (Brief §4.2, §9.1). We prove that by running the SAME
 * SQL predicate — built once from a user's Clearance — against both tables and asserting identical
 * visibility, then asserting the fail-OPEN empty-IN trap is closed.
 *
 * The predicate under test is the production seam: rbac.buildRetrievalPredicate → rbac.retrievalWhereSql.
 */
import { describe, it, expect } from 'vitest';
import type { Clearance, Namespace } from '../../packages/shared/src/types.ts';
import { buildRetrievalPredicate, retrievalWhereSql } from '../../packages/core/src/rbac/permissions.ts';
import { freshDb, type Query } from './helpers/pglite.ts';
import { seedDemoRows, DEMO_ROWS } from './helpers/seed.ts';

/** Run the clearance predicate against one table and return the visible row keys (by content_hash). */
async function visibleKeys(query: Query, table: 'memories' | 'chunks', clearance: Clearance, namespaces: Namespace[]) {
  const pred = buildRetrievalPredicate(clearance, namespaces);
  const { sql, params } = retrievalWhereSql(pred);
  const res = await query(`SELECT content_hash FROM ${table} WHERE ${sql}`, params);
  return new Set(res.rows.map((r) => r.content_hash.replace('sha256:', '')));
}

describe('chunks respect clearance exactly like memories (#2)', () => {
  it('a chunk is filtered identically to a memory under the same clearance', async () => {
    const { query } = await freshDb();
    await seedDemoRows(query);

    // Cleared for general only, up to sensitivity 2 ⇒ should see exactly gen-1 (s1) and gen-2 (s2).
    const clearance: Clearance = { allowedZones: ['general'], maxSensitivity: 2 };
    const ns: Namespace[] = ['org'];

    const mem = await visibleKeys(query, 'memories', clearance, ns);
    const chk = await visibleKeys(query, 'chunks', clearance, ns);

    expect([...chk].sort()).toEqual([...mem].sort()); // identical visibility — the core guarantee
    expect([...chk].sort()).toEqual(['gen-1', 'gen-2']);
    // never leaks a higher zone or a higher sensitivity
    expect(chk.has('fin-1')).toBe(false);
    expect(chk.has('hr-1')).toBe(false);
  });

  it('a sensitivity ceiling hides over-classified rows in the allowed zone', async () => {
    const { query } = await freshDb();
    await seedDemoRows(query);

    // Cleared for finance up to s3 ⇒ sees fin-1 (s3) but NOT fin-2 (s4).
    const clearance: Clearance = { allowedZones: ['finance'], maxSensitivity: 3 };
    const chk = await visibleKeys(query, 'chunks', clearance, ['org']);
    expect([...chk]).toEqual(['fin-1']);
  });

  it('empty allowedZones compiles to WHERE false → zero rows on BOTH tables (fail-closed, not fail-open)', async () => {
    const { query } = await freshDb();
    await seedDemoRows(query);

    const clearance: Clearance = { allowedZones: [], maxSensitivity: 5 };
    const pred = buildRetrievalPredicate(clearance, ['org']);
    expect(pred.denyAll).toBe(true);

    const { sql } = retrievalWhereSql(pred);
    expect(sql).toBe('false'); // NOT `zone IN ()` (syntax error) and NOT an absent clause (leaks everything)

    const mem = await visibleKeys(query, 'memories', clearance, ['org']);
    const chk = await visibleKeys(query, 'chunks', clearance, ['org']);
    expect(mem.size).toBe(0);
    expect(chk.size).toBe(0);
    // sanity: the data really is there — the filter is what hides it, not an empty table
    expect(DEMO_ROWS.length).toBeGreaterThan(0);
    const all = await query(`SELECT count(*)::int AS n FROM chunks`);
    expect(all.rows[0].n).toBe(DEMO_ROWS.length);
  });

  it('empty namespaces also denies all (namespace is resolved before retrieval, never post-filtered)', async () => {
    const { query } = await freshDb();
    await seedDemoRows(query);
    const clearance: Clearance = { allowedZones: ['general'], maxSensitivity: 5 };
    const pred = buildRetrievalPredicate(clearance, []);
    expect(pred.denyAll).toBe(true);
    const chk = await visibleKeys(query, 'chunks', clearance, []);
    expect(chk.size).toBe(0);
  });
});
