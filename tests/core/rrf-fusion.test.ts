/**
 * Issue #13 → #14 — HYBRID retrieval: a keyword (tsvector) leg fused with the dense leg by Reciprocal Rank
 * Fusion, with the abstention decision made by the #14 RERANKER over the fused union.
 *
 * Two load-bearing properties (each a permanent regression test):
 *   • RRF FUSES ranks: a doc only MODERATELY close in dense space but a STRONG keyword match can be ranked
 *     ABOVE a denser-but-keyword-absent doc. RRF changes the ORDER of the surfaced set (output stays RRF order;
 *     rerank-REORDERING the surfaced set is the #15 refinement). The abstention SCORE is the reranker's, never
 *     the RRF sum.
 *   • The #14 reranker scores the FUSED UNION: a keyword-strong candidate whose dense cosine is BELOW the old
 *     dense floor now CLEARS when the reranker scores it high (the #13 dense-only-abstention deferral is CLOSED
 *     — the canonical case lives in reranker-floor.test.ts (b); here we prove it through the fusion path).
 */
import { describe, it, expect } from 'vitest';
import { freshDb, vec } from './helpers/pglite.ts';
import { EMBEDDING_DIM, EMBEDDING_MODEL, EMBEDDING_VERSION } from '../../packages/core/src/harness/gateway.ts';
import type { Embedder } from '../../packages/core/src/harness/gateway.ts';
import { retrieve } from '../../packages/core/src/harness/retrieval.ts';
import { grantAll } from './helpers/grant.ts';
import { constReranker, scriptedReranker } from './helpers/rerank.ts';

const RERANK_FLOOR = 0.5; // a rerank-scale floor injected explicitly (#14 — was the 0.608 cosine floor)

const E0 = (() => {
  const v = new Array<number>(EMBEDDING_DIM).fill(0);
  v[0] = 1;
  return v;
})();
/** Unit vector with cosine `c` to E0. */
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

describe('#13/#14 RRF fusion — keyword leg + dense leg + reranked floor', () => {
  it('a strong keyword match is promoted above a denser, keyword-absent doc (RRF reorders the set)', async () => {
    const { query } = await freshDb();
    // A: densest (0.95) but no keyword overlap with the query.  B: above-floor (0.62) AND a keyword match.
    await insertRow(query, { statement: 'alpha bravo charlie delta', embedding: cosVector(0.95, 1) });
    await insertRow(query, { statement: 'quarterly revenue forecast for the board', embedding: cosVector(0.62, 2) });

    // The query text drives BOTH legs: embed → E0 (fixed), keyword → websearch_to_tsquery('revenue forecast').
    const out = await retrieve('revenue forecast', {
      query,
      embed: fixedEmbedder(E0),
      rerank: constReranker(0.9),
      floor: RERANK_FLOOR,
      ...grantAll(),
    });

    expect(out.abstained).toBe(false);
    // RRF: B gets dense-rank-2 + keyword-rank-1; A gets dense-rank-1 + no keyword → B fuses ABOVE A. The output
    // order stays RRF (rerank-reordering is #15), so B is still first.
    expect(out.memories.map((m) => m.statement)).toEqual([
      'quarterly revenue forecast for the board',
      'alpha bravo charlie delta',
    ]);
    // The SCORE is the reranker's max (0.9), NOT the dense cosine and NEVER the RRF sum (which is < 0.05).
    expect(out.score).toBeCloseTo(0.9, 6);
  });

  it('the reranker scores the FUSED union: a keyword-strong, dense-below-floor doc now CLEARS (#13 deferral closed)', async () => {
    const { query } = await freshDb();
    // Strong keyword match, but the BEST dense cosine (0.40) is below the old 0.608 dense floor — v1 abstained.
    await insertRow(query, { statement: 'revenue forecast revenue forecast quarterly', embedding: cosVector(0.4, 1) });

    const out = await retrieve('revenue forecast', {
      query,
      embed: fixedEmbedder(E0),
      // The reranker — not the dense cosine — now decides: it scores this keyword-surfaced candidate high.
      rerank: scriptedReranker({ 'revenue forecast revenue forecast quarterly': 0.82 }),
      floor: RERANK_FLOOR,
      ...grantAll(),
    });

    expect(out.abstained).toBe(false); // the keyword leg's candidate is rescued by the reranker (was the deferral)
    expect(out.score).toBeCloseTo(0.82, 6);
    expect(out.memories.map((m) => m.statement)).toEqual(['revenue forecast revenue forecast quarterly']);
  });
});
