/**
 * Issue #13 — HYBRID retrieval: a keyword (tsvector) leg fused with the dense leg by Reciprocal Rank Fusion.
 *
 * Two load-bearing properties (each a permanent regression test):
 *   • RRF FUSES ranks: a doc that is only MODERATELY close in dense space but a STRONG keyword match can be
 *     ranked ABOVE a denser-but-keyword-absent doc. RRF changes the ORDER of the surfaced set.
 *   • RRF ORDERS ONLY — it does NOT move the abstention input. `score` stays the TOP-1 PRE-FUSION DENSE COSINE
 *     (the #4/#14 contract), never the RRF sum. Adding a keyword leg cannot push a below-floor corpus over the
 *     floor (the dense-only abstention is a CONSCIOUS deferral until the #14 reranker — recorded here).
 */
import { describe, it, expect } from 'vitest';
import { freshDb, vec } from './helpers/pglite.ts';
import { EMBEDDING_DIM, EMBEDDING_MODEL, EMBEDDING_VERSION } from '../../packages/core/src/harness/gateway.ts';
import type { Embedder } from '../../packages/core/src/harness/gateway.ts';
import { retrieve } from '../../packages/core/src/harness/retrieval.ts';
import { defaultFor } from '../../packages/core/src/config/system-config.ts';
import { grantAll } from './helpers/grant.ts';

const FLOOR = defaultFor('retrieval_min_relevance') as number; // 0.608

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

describe('#13 RRF fusion — keyword leg + dense leg', () => {
  it('a strong keyword match is promoted above a denser, keyword-absent doc (RRF reorders the set)', async () => {
    const { query } = await freshDb();
    // A: densest (0.95) but no keyword overlap with the query.  B: above-floor (0.62) AND a keyword match.
    await insertRow(query, { statement: 'alpha bravo charlie delta', embedding: cosVector(0.95, 1) });
    await insertRow(query, { statement: 'quarterly revenue forecast for the board', embedding: cosVector(0.62, 2) });

    // The query text drives BOTH legs: embed → E0 (fixed), keyword → websearch_to_tsquery('revenue forecast').
    const out = await retrieve('revenue forecast', { query, embed: fixedEmbedder(E0), ...grantAll() });

    expect(out.abstained).toBe(false);
    // RRF: B gets dense-rank-2 + keyword-rank-1; A gets dense-rank-1 + no keyword → B fuses ABOVE A.
    expect(out.memories.map((m) => m.statement)).toEqual([
      'quarterly revenue forecast for the board',
      'alpha bravo charlie delta',
    ]);
    // But the SCORE is the pre-fusion dense top-1 cosine (A's 0.95), NOT the RRF sum (which is < 0.05).
    expect(out.score).toBeCloseTo(0.95, 5);
  });

  it('RRF orders only: a keyword-strong but dense-below-floor corpus still ABSTAINS (#14 deferral, recorded)', async () => {
    const { query } = await freshDb();
    // Strong keyword match, but the BEST dense cosine (0.40) is below the 0.608 floor.
    await insertRow(query, { statement: 'revenue forecast revenue forecast quarterly', embedding: cosVector(0.4, 1) });

    const out = await retrieve('revenue forecast', { query, embed: fixedEmbedder(E0), ...grantAll() });

    // The keyword leg cannot rescue a below-dense-floor corpus: abstention is the dense top-1, not the RRF sum.
    expect(out.score).toBeCloseTo(0.4, 6);
    expect(out.score).toBeLessThan(FLOOR);
    expect(out.abstained).toBe(true);
    expect(out.memories).toEqual([]);
  });
});
