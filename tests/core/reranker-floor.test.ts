/**
 * Issue #14 — ACCEPTANCE: the abstention floor is a CALIBRATED CROSS-ENCODER RERANK score over the top-N of
 * the FUSED (dense ∪ keyword) candidates, NOT the pre-fusion dense cosine of #4. This SUPERSEDES the #4 interim
 * (same intent — one calibrated score, NEVER an RRF sum — on the real reranker scale).
 *
 * The load-bearing properties (each a permanent regression test):
 *   (a) a "wrong" memory that clears the dense COSINE floor but scores LOW on the reranker is DROPPED;
 *   (b) a KEYWORD-ONLY candidate that sits BELOW the dense cosine floor can now CLEAR the rerank floor —
 *       closing the #13 deferral (the whole point of feeding the fused union, not the dense-only list);
 *   (c) reranker UNAVAILABLE ⇒ ABSTAIN + alert, observable (Decision A) — never the uncalibrated cosine;
 *   (d) per-candidate rerank scores are stashed in the diagnostics (helps #15 context-tightening);
 *   (e) the rerank INPUT is the fused union (a keyword-only doc reaches the reranker), proven by a spy.
 *
 * Hermetic: pglite + an injected deterministic embedder AND an injected fake reranker (the embed-injection
 * precedent). The real Voyage reranker is exercised key-gated in rerank.real.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { freshDb, vec, type Query } from './helpers/pglite.ts';
import {
  EMBEDDING_DIM,
  EMBEDDING_MODEL,
  EMBEDDING_VERSION,
  RERANKER_MODEL,
  type Embedder,
} from '../../packages/core/src/harness/gateway.ts';
import { retrieve, type RetrievalDiagnostics } from '../../packages/core/src/harness/retrieval.ts';
import { grantAll } from './helpers/grant.ts';
import { scriptedReranker, spyReranker, throwingReranker } from './helpers/rerank.ts';

const RERANK_FLOOR = 0.5; // a rerank-scale floor injected explicitly (independent of the provisional default)

/** A unit vector with cosine `c` to e0 — lets a row's DENSE similarity be set precisely, independent of FTS. */
function cosVector(c: number, axis: number): number[] {
  const v = new Array<number>(EMBEDDING_DIM).fill(0);
  v[0] = c;
  v[axis] = Math.sqrt(1 - c * c);
  return v;
}
const E0 = (() => {
  const v = new Array<number>(EMBEDDING_DIM).fill(0);
  v[0] = 1;
  return v;
})();
const fixedEmbedder = (v: number[]): Embedder => async (texts) => texts.map(() => v);

async function insertRow(query: Query, o: { statement: string; embedding: number[] }): Promise<void> {
  await query(
    `INSERT INTO memories (namespace, zone, sensitivity_level, type, statement, content_hash, provenance,
                           embedding_model, embedding_version, embedding)
     VALUES ('org','general',1,'semantic',$1,$2,'{}'::jsonb,$3,$4,$5::vector)`,
    [o.statement, `sha256:${o.statement}`, EMBEDDING_MODEL, EMBEDDING_VERSION, vec(o.embedding)],
  );
}
const missCount = async (query: Query) =>
  (await query(`SELECT count(*)::int AS n FROM retrieval_misses`)).rows[0].n as number;

describe('#14 reranker floor', () => {
  it('(a) drops a wrong memory that clears the dense cosine floor but scores LOW on the reranker', async () => {
    const { query } = await freshDb();
    // Cosine 0.9 to the query — comfortably above the old 0.608 dense floor (v1 would have RETURNED it).
    await insertRow(query, { statement: 'a misleadingly close vector', embedding: cosVector(0.9, 1) });

    const rerank = scriptedReranker({ 'a misleadingly close vector': 0.2 }); // below the 0.5 rerank floor

    const out = await retrieve('q', { query, embed: fixedEmbedder(E0), rerank, floor: RERANK_FLOOR, ...grantAll() });

    expect(out.abstained).toBe(true); // the reranker overrules the cosine
    expect(out.memories).toEqual([]);
    expect(out.score).toBeCloseTo(0.2, 6); // the score is the RERANK score, not the 0.9 cosine
    expect(await missCount(query)).toBe(1);
    expect((await query(`SELECT top_score FROM retrieval_misses`)).rows[0].top_score).toBeCloseTo(0.2, 6);
  });

  it('(b) lets a KEYWORD-ONLY candidate below the dense cosine floor clear the rerank floor (#13 deferral closed)', async () => {
    const { query } = await freshDb();
    // Cosine 0.05 to the query — FAR below the dense floor, so the dense leg/abstention of v1 would NEVER admit
    // it. But its statement shares lexemes with the query, so the KEYWORD leg surfaces it into the fused union.
    await insertRow(query, { statement: 'the quarterly revenue forecast spreadsheet', embedding: cosVector(0.05, 7) });

    const rerank = scriptedReranker({ 'the quarterly revenue forecast spreadsheet': 0.88 }); // strong on the reranker

    const out = await retrieve('quarterly revenue forecast', {
      query,
      embed: fixedEmbedder(E0),
      rerank,
      floor: RERANK_FLOOR,
      ...grantAll(),
    });

    expect(out.abstained).toBe(false); // a keyword-surfaced, low-cosine candidate now CLEARS
    expect(out.memories).toHaveLength(1);
    expect(out.memories[0]!.statement).toBe('the quarterly revenue forecast spreadsheet');
    expect(out.score).toBeCloseTo(0.88, 6);
    expect(await missCount(query)).toBe(0);
  });

  it('(c) reranker UNAVAILABLE ⇒ abstain + alert + degraded flag, NOT the uncalibrated cosine (Decision A)', async () => {
    const { query } = await freshDb();
    await insertRow(query, { statement: 'an exact match', embedding: E0 }); // cosine 1.0 — would clear ANY cosine floor

    const alerts: Array<{ reason: string }> = [];
    const out = await retrieve('q', {
      query,
      embed: fixedEmbedder(E0),
      rerank: throwingReranker(),
      floor: RERANK_FLOOR,
      onRerankerUnavailable: (info) => alerts.push(info),
      ...grantAll(),
    });

    expect(out.abstained).toBe(true); // fail-SAFE: we do not answer on an uncalibrated score
    expect(out.degraded).toBe(true); // observable on the outcome
    expect(out.memories).toEqual([]);
    expect(alerts).toHaveLength(1); // loudly alerted
    expect(await missCount(query)).toBe(0); // an OUTAGE is not a knowledge gap — no false miss logged
  });

  it('(d) stashes per-candidate rerank scores + the reranker model in the diagnostics (helps #15)', async () => {
    const { query } = await freshDb();
    await insertRow(query, { statement: 'alpha note', embedding: cosVector(0.9, 1) });
    await insertRow(query, { statement: 'beta note', embedding: cosVector(0.8, 2) });

    const rerank = scriptedReranker({ 'alpha note': 0.7, 'beta note': 0.4 });
    const seen: RetrievalDiagnostics[] = [];

    const out = await retrieve('q', {
      query,
      embed: fixedEmbedder(E0),
      rerank,
      floor: RERANK_FLOOR,
      onRetrieval: (d) => seen.push(d),
      ...grantAll(),
    });

    expect(out.abstained).toBe(false);
    expect(out.score).toBeCloseTo(0.7, 6); // the MAX, never a sum
    const d = seen[0]!;
    expect(d.rerankerModel).toBe(RERANKER_MODEL);
    expect(d.degraded).toBe(false);
    const byStatement = new Map(d.rerankerScores!.map((r) => [r.id, r.score]));
    // both candidates carry their individual rerank score (not just the winner)
    expect([...byStatement.values()].sort()).toEqual([0.4, 0.7]);
  });

  it('(e) the rerank INPUT is the fused UNION — a keyword-only document reaches the reranker (spy)', async () => {
    const { query } = await freshDb();
    await insertRow(query, { statement: 'the quarterly revenue forecast spreadsheet', embedding: cosVector(0.05, 7) });
    const spy = spyReranker(scriptedReranker({ 'the quarterly revenue forecast spreadsheet': 0.88 }));

    await retrieve('quarterly revenue forecast', {
      query,
      embed: fixedEmbedder(E0),
      rerank: spy.rerank,
      floor: RERANK_FLOOR,
      ...grantAll(),
    });

    expect(spy.calls).toHaveLength(1); // ONE call per query (the Watch: keep it cheap)
    expect(spy.calls[0]!.documents).toContain('the quarterly revenue forecast spreadsheet');
  });

  it('still abstains on an empty candidate set WITHOUT calling the reranker (no needless model call)', async () => {
    const { query } = await freshDb();
    const spy = spyReranker();

    const out = await retrieve('anything', { query, embed: fixedEmbedder(E0), rerank: spy.rerank, floor: RERANK_FLOOR, ...grantAll() });

    expect(out.abstained).toBe(true);
    expect(out.score).toBe(Number.NEGATIVE_INFINITY);
    expect(spy.calls).toHaveLength(0); // nothing to score ⇒ no call, no spend
    expect((await query(`SELECT top_score FROM retrieval_misses`)).rows[0].top_score).toBeNull();
  });
});
