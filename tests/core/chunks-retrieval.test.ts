/**
 * Issue #13 — chunks are searched + returned by retrieve(), filtered by the IDENTICAL permission fragment as
 * memories (§4.2, §9.1). "No lifecycle" ≠ "no permissions": a chunk the principal cannot see must NEVER return.
 *
 * The leak guard is the IDENTITY of the filter across stores (the same retrievalWhereSql fragment, same params).
 * This slice proves chunks come back AND a forbidden chunk never does. The full #36 leak matrix is slice 6.
 */
import { describe, it, expect } from 'vitest';
import type { Clearance } from '@aios/shared';
import { freshDb, vec } from './helpers/pglite.ts';
import { EMBEDDING_DIM, EMBEDDING_MODEL, EMBEDDING_VERSION } from '../../packages/core/src/harness/gateway.ts';
import type { Embedder } from '../../packages/core/src/harness/gateway.ts';
import { retrieve } from '../../packages/core/src/harness/retrieval.ts';
import { TEST_USER } from './helpers/grant.ts';

const E0 = (() => {
  const v = new Array<number>(EMBEDDING_DIM).fill(0);
  v[0] = 1;
  return v;
})();
function fixedEmbedder(v: number[]): Embedder {
  return async (texts) => texts.map(() => v);
}
function withClearance(c: Clearance) {
  return { principal: TEST_USER, getClearance: async () => c };
}

async function insertMemory(query: (s: string, p?: unknown[]) => Promise<{ rows: any[] }>, statement: string) {
  await query(
    `INSERT INTO memories (namespace, zone, sensitivity_level, type, statement, content_hash, provenance,
                           embedding_model, embedding_version, embedding)
     VALUES ('org','general',1,'semantic',$1,$2,'{}'::jsonb,$3,$4,$5::vector)`,
    [statement, `sha256:${statement}`, EMBEDDING_MODEL, EMBEDDING_VERSION, vec(E0)],
  );
}
async function insertChunk(
  query: (s: string, p?: unknown[]) => Promise<{ rows: any[] }>,
  opts: { namespace?: string; zone: string; sensitivity?: number; text: string },
) {
  await query(
    `INSERT INTO chunks (namespace, zone, sensitivity_level, text, content_hash, provenance,
                         embedding_model, embedding_version, embedding)
     VALUES ($1,$2,$3,$4,$5,'{}'::jsonb,$6,$7,$8::vector)`,
    [opts.namespace ?? 'org', opts.zone, opts.sensitivity ?? 1, opts.text, `sha256:${opts.text}`, EMBEDDING_MODEL, EMBEDDING_VERSION, vec(E0)],
  );
}

describe('#13 chunks — searched + filtered identically to memories', () => {
  it('returns a permitted chunk and NEVER a forbidden-zone / over-sensitive / wrong-namespace chunk', async () => {
    const { query } = await freshDb();
    // A visible memory so the outcome is not abstained (abstention is memories-only, by decision).
    await insertMemory(query, 'a general memory');
    // Chunks: one visible, three forbidden on each axis.
    await insertChunk(query, { zone: 'general', sensitivity: 1, text: 'VISIBLE general chunk' });
    await insertChunk(query, { zone: 'finance', sensitivity: 1, text: 'FORBIDDEN finance chunk' });
    await insertChunk(query, { zone: 'general', sensitivity: 5, text: 'FORBIDDEN oversensitive chunk' });
    await insertChunk(query, { namespace: 'client:acme', zone: 'general', sensitivity: 1, text: 'FORBIDDEN namespace chunk' });

    // Cleared for general/org up to s2 only.
    const out = await retrieve('q', {
      query,
      embed: fixedEmbedder(E0),
      ...withClearance({ allowedZones: ['general'], maxSensitivity: 2, allowedNamespaces: ['org'] }),
    });

    expect(out.abstained).toBe(false);
    const texts = out.chunks.map((c) => c.text);
    expect(texts).toContain('VISIBLE general chunk');
    expect(texts).not.toContain('FORBIDDEN finance chunk');
    expect(texts).not.toContain('FORBIDDEN oversensitive chunk');
    expect(texts).not.toContain('FORBIDDEN namespace chunk');
    expect(out.chunks).toHaveLength(1);
    expect(out.diagnostics.chunks.mode).toBe('exact'); // tiny filtered set
  });

  it('an empty-clearance principal gets zero chunks (denyAll ⇒ WHERE false on the chunk store too)', async () => {
    const { query } = await freshDb();
    await insertChunk(query, { zone: 'general', sensitivity: 1, text: 'a chunk' });

    const out = await retrieve('q', {
      query,
      embed: fixedEmbedder(E0),
      ...withClearance({ allowedZones: [], maxSensitivity: 5, allowedNamespaces: [] }),
    });

    expect(out.chunks).toEqual([]);
  });
});
