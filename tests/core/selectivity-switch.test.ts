/**
 * Issue #13 — SELECTIVITY-AWARE exact-vs-HNSW switch (the Tier-1 audit fix; method NAMED below).
 *
 * METHOD: a BOUNDED, LIMIT-capped COUNT over the permission predicate — `count(*)` of `SELECT 1 … WHERE
 * <pred> LIMIT exact_search_max_rows + 1`. The +1 short-circuit bounds the count's cost to O(threshold)
 * regardless of corpus size; we only need to know whether the filtered set is ≤ the threshold. `count ≤
 * exact_search_max_rows` ⇒ EXACT (a MATERIALIZED-CTE flat scan: perfect recall for a restricted user); else
 * HNSW. Chosen over a reltuples×selectivity estimate because it is EXACT at the boundary (no ANALYZE
 * staleness) and DETERMINISTIC — required for a fail-closed path and a testable routing assertion.
 *
 * The predicate is applied BEFORE the ANN in BOTH paths (the whole point — HNSW over an unfiltered set then
 * post-filtering leaks AND collapses recall). pglite diverges from real pgvector here (it cannot force the
 * exact seq-scan via enable_indexscan), so the perfect-RECALL guarantee on the real engine is proven in
 * selectivity-switch.real.test.ts; this lane proves the ROUTING + that the exact path returns correct order.
 */
import { describe, it, expect } from 'vitest';
import { freshDb, vec, pgliteTx } from './helpers/pglite.ts';
import { EMBEDDING_DIM, EMBEDDING_MODEL, EMBEDDING_VERSION } from '../../packages/core/src/harness/gateway.ts';
import type { Embedder } from '../../packages/core/src/harness/gateway.ts';
import { retrieve } from '../../packages/core/src/harness/retrieval.ts';
import { grantAll } from './helpers/grant.ts';
import { constReranker } from './helpers/rerank.ts';

const E0 = (() => {
  const v = new Array<number>(EMBEDDING_DIM).fill(0);
  v[0] = 1;
  return v;
})();
function cosVector(c: number, axis: number): number[] {
  const v = new Array<number>(EMBEDDING_DIM).fill(0);
  v[0] = c;
  v[axis] = Math.sqrt(1 - c * c);
  return v;
}
function fixedEmbedder(v: number[]): Embedder {
  return async (texts) => texts.map(() => v);
}
async function insertRow(
  query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>,
  opts: { statement: string; embedding: number[] },
): Promise<void> {
  await query(
    `INSERT INTO memories (namespace, zone, sensitivity_level, type, statement, content_hash, provenance,
                           embedding_model, embedding_version, embedding)
     VALUES ('org','general',1,'semantic',$1,$2,'{}'::jsonb,$3,$4,$5::vector)`,
    [opts.statement, `sha256:${opts.statement}`, EMBEDDING_MODEL, EMBEDDING_VERSION, vec(opts.embedding)],
  );
}

/** Seed `n` distinct above-floor rows with NO keyword overlap with the query (so fusion = dense-only order). */
async function seedN(query: (s: string, p?: unknown[]) => Promise<{ rows: any[] }>, n: number) {
  for (let i = 1; i <= n; i++) {
    await insertRow(query, { statement: `alpha bravo item ${i}`, embedding: cosVector(0.9 - i * 0.01, i) });
  }
}

describe('#13 selectivity switch — bounded-count routing (exact ↔ HNSW)', () => {
  it('a small filtered set (count ≤ exact_search_max_rows) routes to the EXACT path', async () => {
    const { query } = await freshDb();
    await seedN(query, 3);

    const out = await retrieve('zulu', { query, embed: fixedEmbedder(E0), rerank: constReranker(0.99), exactMaxRows: 10, ...grantAll() });

    expect(out.diagnostics.memories.mode).toBe('exact');
    expect(out.diagnostics.memories.candidateCount).toBe(3); // bounded count saw all 3
  });

  it('a large filtered set (count > exact_search_max_rows) routes to HNSW', async () => {
    const { query } = await freshDb();
    await seedN(query, 3);

    const out = await retrieve('zulu', { query, embed: fixedEmbedder(E0), rerank: constReranker(0.99), exactMaxRows: 2, ...grantAll() });

    expect(out.diagnostics.memories.mode).toBe('hnsw');
    // The bounded count short-circuits at threshold+1 — it never counts the whole corpus.
    expect(out.diagnostics.memories.candidateCount).toBe(3); // = exactMaxRows + 1, the cap
  });

  it('routes at the exact boundary: count == threshold ⇒ exact; count == threshold+1 ⇒ hnsw', async () => {
    const { query } = await freshDb();
    await seedN(query, 4);

    const exact = await retrieve('zulu', { query, embed: fixedEmbedder(E0), rerank: constReranker(0.99), exactMaxRows: 4, ...grantAll() });
    expect(exact.diagnostics.memories.mode).toBe('exact'); // 4 ≤ 4

    const hnsw = await retrieve('zulu', { query, embed: fixedEmbedder(E0), rerank: constReranker(0.99), exactMaxRows: 3, ...grantAll() });
    expect(hnsw.diagnostics.memories.mode).toBe('hnsw'); // count caps at 4 > 3
  });

  it('the HNSW path runs inside a transaction (SET LOCAL iterative_scan/ef_search GUCs apply cleanly)', async () => {
    const { db, query } = await freshDb();
    await seedN(query, 3);

    // exactMaxRows:1 forces HNSW; a transaction is supplied → the txn-scoped GUCs are SET LOCAL and the search
    // runs on that backend. (pglite is single-threaded; the real recall guarantee on the non-selective path is
    // proven on real pgvector in selectivity-switch.real.test.ts.)
    const out = await retrieve('zulu', {
      query,
      embed: fixedEmbedder(E0), rerank: constReranker(0.99),
      exactMaxRows: 1,
      transaction: pgliteTx(db),
      ...grantAll(),
    });

    expect(out.diagnostics.memories.mode).toBe('hnsw');
    expect(out.abstained).toBe(false);
    expect(out.memories.length).toBeGreaterThan(0); // the GUC path returns rows, not an error
  });

  it('the EXACT path returns the TRUE nearest order (dense-only, no keyword overlap)', async () => {
    const { query } = await freshDb();
    // cosines 0.89, 0.88, 0.87 … strictly descending; nearest is item 1.
    await seedN(query, 5);

    const out = await retrieve('zulu', { query, embed: fixedEmbedder(E0), rerank: constReranker(0.99), exactMaxRows: 100, ...grantAll() });

    expect(out.diagnostics.memories.mode).toBe('exact');
    expect(out.abstained).toBe(false);
    expect(out.memories.map((m) => m.statement)).toEqual([
      'alpha bravo item 1',
      'alpha bravo item 2',
      'alpha bravo item 3',
      'alpha bravo item 4',
      'alpha bravo item 5',
    ]);
  });
});
