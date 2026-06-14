/**
 * Issue #9 — getClearance(): fail-closed clearance resolution (Brief §9.1, §3.2). The highest-stakes
 * correctness property in the system. getClearance() resolves a Principal → Clearance and feeds the EXISTING,
 * untouched buildRetrievalPredicate → retrievalWhereSql seam. Every test threads the RESOLVED clearance through
 * that real seam against seeded `memories` + `chunks` — the predicate is never hand-built here.
 *
 * Each `it` named "(leak …)" is a permanent regression test for a specific fail-OPEN shape.
 */
import { describe, it, expect } from 'vitest';
import type { Clearance, Principal, SensitivityLevel } from '@aios/shared';
import { freshDb, type Query } from './helpers/pglite.ts';
import { seedDemoRows, DEMO_ROWS } from './helpers/seed.ts';
import { buildRetrievalPredicate, retrievalWhereSql, getClearance } from '../../packages/core/src/rbac/permissions.ts';
import { defaultFor } from '../../packages/core/src/config/system-config.ts';

/** Insert an effective clearance row (already-materialised; getClearance reads this, never roles — see #9). */
async function seedClearance(query: Query, principalId: string, allowedZones: string[], maxSensitivity: number) {
  await query(
    `INSERT INTO user_clearance (principal_id, allowed_zones, max_sensitivity) VALUES ($1, $2::text[], $3)`,
    [principalId, allowedZones, maxSensitivity],
  );
}

/** Resolve clearance → run the REAL predicate seam against one table → visible row keys (by content_hash). */
async function visibleKeys(query: Query, table: 'memories' | 'chunks', clearance: Clearance) {
  const { sql, params } = retrievalWhereSql(buildRetrievalPredicate(clearance, ['org']));
  const res = await query(`SELECT content_hash FROM ${table} WHERE ${sql}`, params);
  return new Set(res.rows.map((r) => r.content_hash.replace('sha256:', '')));
}

const USER = (userId: string): Principal => ({ kind: 'user', userId });
const SERVICE = (serviceId: string): Principal => ({ kind: 'service', serviceId });

describe('getClearance() — fail-closed resolution (#9)', () => {
  it('(leak) a principal with NO clearance row resolves to empty ⇒ sees nothing on BOTH tables', async () => {
    const { query } = await freshDb();
    await seedDemoRows(query);

    const c = await getClearance(USER('ghost-never-provisioned'), { query });
    expect(c.allowedZones).toEqual([]); // empty, NOT a populated/all-zones default

    expect(buildRetrievalPredicate(c, ['org']).denyAll).toBe(true);
    expect((await visibleKeys(query, 'memories', c)).size).toBe(0);
    expect((await visibleKeys(query, 'chunks', c)).size).toBe(0);
    // sanity: the data is really there — the resolver is what hides it, not an empty table
    const all = await query(`SELECT count(*)::int AS n FROM chunks`);
    expect(all.rows[0].n).toBe(DEMO_ROWS.length);
  });

  it('(leak) an EXISTING row with empty allowed_zones ⇒ sees nothing (explicit audited empty, still deny)', async () => {
    const { query } = await freshDb();
    await seedDemoRows(query);
    await seedClearance(query, 'u-empty', [], 5); // deliberately provisioned empty, max sensitivity

    const c = await getClearance(USER('u-empty'), { query });
    expect(c.allowedZones).toEqual([]);
    expect(buildRetrievalPredicate(c, ['org']).denyAll).toBe(true);
    expect((await visibleKeys(query, 'chunks', c)).size).toBe(0);
  });

  it('a provisioned user sees exactly their zone, never a higher zone or sensitivity', async () => {
    const { query } = await freshDb();
    await seedDemoRows(query);
    await seedClearance(query, 'u-gen', ['general'], 2); // general only, up to s2

    const c = await getClearance(USER('u-gen'), { query });
    expect(c).toEqual({ allowedZones: ['general'], maxSensitivity: 2 });

    const mem = await visibleKeys(query, 'memories', c);
    const chk = await visibleKeys(query, 'chunks', c);
    expect([...chk].sort()).toEqual([...mem].sort()); // ONE path — identical visibility
    expect([...chk].sort()).toEqual(['gen-1', 'gen-2']);
    expect(chk.has('fin-1')).toBe(false);
    expect(chk.has('hr-1')).toBe(false);
  });

  it('a sensitivity ceiling hides over-classified rows in the allowed zone', async () => {
    const { query } = await freshDb();
    await seedDemoRows(query);
    await seedClearance(query, 'u-fin', ['finance'], 3); // finance up to s3 ⇒ fin-1 (s3) yes, fin-2 (s4) no

    const c = await getClearance(USER('u-fin'), { query });
    expect([...(await visibleKeys(query, 'chunks', c))]).toEqual(['fin-1']);
  });

  it('(leak) a SERVICE principal does NOT inherit a user row keyed by the same id string', async () => {
    const { query } = await freshDb();
    await seedDemoRows(query);
    // A user 'X' is broadly cleared. A SERVICE whose serviceId is the SAME string must NOT pick this up.
    await seedClearance(query, 'X', ['finance', 'hr', 'exec'], 5);

    const c = await getClearance(SERVICE('X'), { query });
    expect(c.allowedZones).toEqual([]); // service denies the retrieval predicate — never reads user_clearance
    expect((await visibleKeys(query, 'chunks', c)).size).toBe(0);

    // and the user 'X' itself still resolves correctly (the row is real; only the discriminant differs)
    const cu = await getClearance(USER('X'), { query });
    expect(cu.allowedZones).toEqual(['finance', 'hr', 'exec']);
  });

  it('(leak) a forged/unknown principal kind ⇒ deny WITHOUT touching the DB (no ambient authority)', async () => {
    // A query that THROWS if called — proves the deny path short-circuits before any DB read.
    const exploding: Query = async () => {
      throw new Error('DB must not be consulted for an unknown principal kind');
    };
    for (const forged of [{ kind: 'admin' }, { kind: undefined }, {}, null, undefined] as unknown as Principal[]) {
      const c = await getClearance(forged, { query: exploding });
      expect(c.allowedZones).toEqual([]);
      expect(buildRetrievalPredicate(c, ['org']).denyAll).toBe(true);
    }
  });

  it('(leak) ERROR PATH is fail-closed: a query that rejects NEVER yields a populated clearance', async () => {
    const dbDown: Query = async () => {
      throw new Error('connection refused');
    };
    // Must REJECT (surfaced/alertable), not resolve to a populated — or any — clearance.
    await expect(getClearance(USER('u1'), { query: dbDown })).rejects.toThrow();
  });

  it('most-restrictive sensitivity default: the deny clearance ceiling is the LOWEST (1), never the highest', async () => {
    const { query } = await freshDb();
    const c = await getClearance(USER('ghost'), { query });
    expect(c.maxSensitivity).toBe(1);
    expect(c.maxSensitivity).toBe(defaultFor('rbac_default_max_sensitivity'));
  });

  it('(leak) denyAll compiles to `false` REGARDLESS of the maxSensitivity floor value', async () => {
    // The deny floor is never read — retrievalWhereSql short-circuits on denyAll. Prove it for both extremes.
    for (const floor of [1, 5] as SensitivityLevel[]) {
      const pred = buildRetrievalPredicate({ allowedZones: [], maxSensitivity: floor }, ['org']);
      expect(pred.denyAll).toBe(true);
      expect(retrievalWhereSql(pred).sql).toBe('false'); // never an empty `zone = ANY()`/bare IN
    }
  });
});
