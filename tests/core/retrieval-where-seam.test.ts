/**
 * Issue #5 / M0 gate — the #13 PERMISSION SEAM is honest, not a lie (Brief §9.1, §3.2).
 *
 * retrieve() now carries BOTH the SQL fragment (`predicate`) AND its bound values (`predicateParams`). This
 * proves the seam end-to-end through retrieve(): a clearance predicate built by rbac.retrievalWhereSql(pred, 3)
 * — numbering from $3 because $1 is the query vector and $2 is the limit — HITs an authorized row, DENYs an
 * unauthorized zone, and an empty clearance (denyAll ⇒ `false`) returns nothing. The full filter lands in
 * #13/M2; this locks the SEAM so it can never silently fail-open.
 *
 * NB: the SQL-level HIT/DENY of retrievalWhereSql itself is also covered against chunks in
 * retrieval-filter.probe.test.ts (#2); this asserts retrieve() THREADS the params correctly ($3+ line up).
 */
import { describe, it, expect } from 'vitest';
import type { Clearance } from '@aios/shared';
import { freshDb, synthVector, vec } from './helpers/pglite.ts';
import { EMBEDDING_MODEL, EMBEDDING_VERSION } from '../../packages/core/src/harness/gateway.ts';
import type { Embedder } from '../../packages/core/src/harness/gateway.ts';
import { retrieve } from '../../packages/core/src/harness/retrieval.ts';
import { buildRetrievalPredicate, retrievalWhereSql } from '../../packages/core/src/rbac/permissions.ts';

/** Insert a memory row with a crafted embedding + explicit access label (bypasses the embedder). */
async function insertRow(
  query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>,
  opts: { namespace?: string; zone: string; sensitivity?: number; statement: string; embedding: number[] },
): Promise<void> {
  await query(
    `INSERT INTO memories (namespace, zone, sensitivity_level, type, statement, content_hash, provenance,
                           embedding_model, embedding_version, embedding)
     VALUES ($1,$2,$3,'semantic',$4,$5,'{}'::jsonb,$6,$7,$8::vector)`,
    [opts.namespace ?? 'org', opts.zone, opts.sensitivity ?? 1, opts.statement, `sha256:${opts.statement}`, EMBEDDING_MODEL, EMBEDDING_VERSION, vec(opts.embedding)],
  );
}

/** A fixed query vector so the crafted rows are clearly above the floor regardless of clearance. */
function fixedEmbedder(v: number[]): Embedder {
  return async (texts) => texts.map(() => v);
}

const E0 = (() => {
  const v = new Array<number>(synthVector('x').length).fill(0);
  v[0] = 1;
  return v;
})();

/** retrieve()'s base params are $1 (vector) + $2 (limit), so the clearance fragment numbers from $3. */
function seam(clearance: Clearance, namespaces: Parameters<typeof buildRetrievalPredicate>[1]) {
  const { sql, params } = retrievalWhereSql(buildRetrievalPredicate(clearance, namespaces), 3);
  return { predicate: sql, predicateParams: params };
}

describe('#13 retrieval permission seam through retrieve() (M0 gate)', () => {
  it('HIT: a cleared user retrieves the authorized row (params thread correctly from $3)', async () => {
    const { query } = await freshDb();
    await insertRow(query, { zone: 'general', sensitivity: 1, statement: 'general fact', embedding: E0 });

    const { predicate, predicateParams } = seam({ allowedZones: ['general'], maxSensitivity: 3 }, ['org']);
    const out = await retrieve('q', { query, embed: fixedEmbedder(E0), predicate, predicateParams });

    expect(out.abstained).toBe(false);
    expect(out.memories).toHaveLength(1);
    expect(out.memories[0]!.statement).toBe('general fact');
  });

  it('DENY: an exact-match row in a zone the user lacks is invisible (filtered BEFORE ranking, not after)', async () => {
    const { query } = await freshDb();
    await insertRow(query, { zone: 'finance', sensitivity: 1, statement: 'finance secret', embedding: E0 }); // nearest

    const { predicate, predicateParams } = seam({ allowedZones: ['general'], maxSensitivity: 3 }, ['org']);
    const out = await retrieve('q', { query, embed: fixedEmbedder(E0), predicate, predicateParams });

    expect(out.abstained).toBe(true); // the nearest-but-forbidden row never surfaces
    expect(out.memories).toEqual([]);
  });

  it('DENY on sensitivity: a row above the user max is invisible even in an allowed zone', async () => {
    const { query } = await freshDb();
    await insertRow(query, { zone: 'general', sensitivity: 5, statement: 'restricted', embedding: E0 });

    const { predicate, predicateParams } = seam({ allowedZones: ['general'], maxSensitivity: 3 }, ['org']);
    const out = await retrieve('q', { query, embed: fixedEmbedder(E0), predicate, predicateParams });

    expect(out.abstained).toBe(true);
    expect(out.memories).toEqual([]);
  });

  it('denyAll: empty allowedZones compiles to `false` ⇒ zero rows (the fail-OPEN trap stays closed)', async () => {
    const { query } = await freshDb();
    await insertRow(query, { zone: 'general', sensitivity: 1, statement: 'general fact', embedding: E0 });

    const { predicate, predicateParams } = seam({ allowedZones: [], maxSensitivity: 5 }, ['org']);
    expect(predicate).toBe('false'); // not an empty IN/ANY — WHERE false
    const out = await retrieve('q', { query, embed: fixedEmbedder(E0), predicate, predicateParams });

    expect(out.abstained).toBe(true);
    expect(out.memories).toEqual([]);
  });
});
