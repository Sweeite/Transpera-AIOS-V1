/**
 * Issue #13 (was #5/M0 seam) — the PERMISSION TRUST BOUNDARY inside retrieve(), end-to-end.
 *
 * retrieve() no longer accepts a caller-supplied `predicate` (the old fail-OPEN shape: a caller could pass
 * 'true'). It now takes a `principal` and derives the clearance+namespace predicate INSIDE the boundary:
 *   principal → getClearance() → clearance.allowedNamespaces → buildRetrievalPredicate → retrievalWhereSql(…,3).
 * A missing/forged/service principal resolves to denyClearance() ⇒ `WHERE false` ⇒ zero rows. This proves the
 * HIT / DENY (zone) / DENY (sensitivity) / denyAll paths through the REAL resolution, not a hand-built fragment.
 *
 * getClearance is INJECTED so the test crafts a clearance without seeding a user_clearance row; production uses
 * the real resolver. The injected resolver is still a resolver — the namespaces are taken from the RESOLVED
 * clearance (authorized set), never from a caller argument.
 */
import { describe, it, expect } from 'vitest';
import type { Clearance, Principal } from '@aios/shared';
import { freshDb, synthVector, vec } from './helpers/pglite.ts';
import { EMBEDDING_MODEL, EMBEDDING_VERSION } from '../../packages/core/src/harness/gateway.ts';
import type { Embedder } from '../../packages/core/src/harness/gateway.ts';
import { retrieve } from '../../packages/core/src/harness/retrieval.ts';

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

const USER: Principal = { kind: 'user', userId: 'u-seam' };
/** Inject a resolver that returns a crafted clearance (no user_clearance row needed). */
function withClearance(c: Clearance) {
  return { principal: USER, getClearance: async () => c };
}

describe('#13 retrieval permission boundary through retrieve() (principal-derived predicate)', () => {
  it('HIT: a cleared user retrieves the authorized row (clearance derived from the principal)', async () => {
    const { query } = await freshDb();
    await insertRow(query, { zone: 'general', sensitivity: 1, statement: 'general fact', embedding: E0 });

    const out = await retrieve('q', {
      query,
      embed: fixedEmbedder(E0),
      ...withClearance({ allowedZones: ['general'], maxSensitivity: 3, allowedNamespaces: ['org'] }),
    });

    expect(out.abstained).toBe(false);
    expect(out.memories).toHaveLength(1);
    expect(out.memories[0]!.statement).toBe('general fact');
  });

  it('DENY: an exact-match row in a zone the user lacks is invisible (filtered BEFORE ranking, not after)', async () => {
    const { query } = await freshDb();
    await insertRow(query, { zone: 'finance', sensitivity: 1, statement: 'finance secret', embedding: E0 }); // nearest

    const out = await retrieve('q', {
      query,
      embed: fixedEmbedder(E0),
      ...withClearance({ allowedZones: ['general'], maxSensitivity: 3, allowedNamespaces: ['org'] }),
    });

    expect(out.abstained).toBe(true); // the nearest-but-forbidden row never surfaces
    expect(out.memories).toEqual([]);
  });

  it('DENY on sensitivity: a row above the user max is invisible even in an allowed zone', async () => {
    const { query } = await freshDb();
    await insertRow(query, { zone: 'general', sensitivity: 5, statement: 'restricted', embedding: E0 });

    const out = await retrieve('q', {
      query,
      embed: fixedEmbedder(E0),
      ...withClearance({ allowedZones: ['general'], maxSensitivity: 3, allowedNamespaces: ['org'] }),
    });

    expect(out.abstained).toBe(true);
    expect(out.memories).toEqual([]);
  });

  it('denyAll: an empty-clearance principal sees zero rows (the fail-OPEN trap stays closed)', async () => {
    const { query } = await freshDb();
    await insertRow(query, { zone: 'general', sensitivity: 1, statement: 'general fact', embedding: E0 });

    const out = await retrieve('q', {
      query,
      embed: fixedEmbedder(E0),
      ...withClearance({ allowedZones: [], maxSensitivity: 5, allowedNamespaces: ['org'] }),
    });

    expect(out.abstained).toBe(true);
    expect(out.memories).toEqual([]);
  });

  it('DENY: a forged principal (no injected resolver) resolves to deny via the REAL getClearance ⇒ empty', async () => {
    const { query } = await freshDb();
    await insertRow(query, { zone: 'general', sensitivity: 1, statement: 'general fact', embedding: E0 });

    // No getClearance injected and no user_clearance row → the real resolver denies. Forged kind also denies.
    const out = await retrieve('q', {
      query,
      embed: fixedEmbedder(E0),
      principal: { kind: 'phantom' } as unknown as Principal,
    });

    expect(out.abstained).toBe(true);
    expect(out.memories).toEqual([]);
  });
});
