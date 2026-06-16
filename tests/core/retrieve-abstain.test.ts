/**
 * Issue #4 → #14 — ACCEPTANCE: the read half of the slice, now scored by the cross-encoder RERANKER.
 *   "Asking about a known memory returns it above the floor; asking about something the reranker scores below
 *    the floor abstains and logs a miss." This SUPERSEDES the #4 interim (the pre-fusion dense cosine) with the
 *    real calibrated score — same intent, new scale (ADR 0003 supersedes ADR 0001's floor).
 *
 * Hermetic: pglite (the same migration SQL a client's Supabase runs) + an INJECTED deterministic embedder AND
 * an INJECTED fake reranker, so this never touches the network. The REAL Voyage reranker is exercised
 * separately, key-gated, in rerank.real.test.ts; the real provisional floor is deferred to #43.
 *
 * The load-bearing properties (each a permanent regression test):
 *   • abstention is the PRODUCT — a below-floor corpus returns EMPTY + a miss, never the nearest weak match;
 *   • the score is the MAX RERANK score, never an RRF-style sum (piling on weak candidates must not push it
 *     over the floor — the audit fix, on the reranker scale);
 *   • the floor is a single injected dial (no magic number); the predicate is a fail-closed SQL seam (#13) and
 *     a forbidden row never even reaches the reranker (zero content egress — see reranker-egress.test.ts).
 */
import { describe, it, expect } from 'vitest';
import { freshDb, vec, type Query } from './helpers/pglite.ts';
import { EMBEDDING_DIM, EMBEDDING_MODEL, EMBEDDING_VERSION, type Embedder } from '../../packages/core/src/harness/gateway.ts';
import { retrieve } from '../../packages/core/src/harness/retrieval.ts';
import { grantAll, grantNothing } from './helpers/grant.ts';
import { constReranker, scriptedReranker, spyReranker } from './helpers/rerank.ts';

const FLOOR = 0.5; // a rerank-scale floor injected explicitly (#14 — supersedes the 0.608 cosine floor)

const E0 = (() => {
  const v = new Array<number>(EMBEDDING_DIM).fill(0);
  v[0] = 1;
  return v;
})();
/** A fixed query embedding — every row sits at E0 too, so all rows are dense candidates and the RERANKER, not
 *  the cosine, makes the abstention decision (the #14 contract). */
const fixedEmbedder = (v: number[]): Embedder => async (texts) => texts.map(() => v);

async function insertRow(query: Query, statement: string): Promise<void> {
  await query(
    `INSERT INTO memories (namespace, zone, sensitivity_level, type, statement, content_hash, provenance,
                           embedding_model, embedding_version, embedding)
     VALUES ('org','general',1,'semantic',$1,$2,'{}'::jsonb,$3,$4,$5::vector)`,
    [statement, `sha256:${statement}`, EMBEDDING_MODEL, EMBEDDING_VERSION, vec(E0)],
  );
}
const missCount = async (query: Query) =>
  (await query(`SELECT count(*)::int AS n FROM retrieval_misses`)).rows[0].n as number;

describe('retrieve() acceptance (#4 → #14)', () => {
  it('a known memory the reranker scores above the floor is returned — no miss logged', async () => {
    const { query } = await freshDb();
    const SOP = 'To onboard a new client: create the workspace, invite the team, set the kickoff.';
    await insertRow(query, SOP);

    const out = await retrieve(SOP, {
      query,
      embed: fixedEmbedder(E0),
      rerank: scriptedReranker({ [SOP]: 0.91 }),
      floor: FLOOR,
      ...grantAll(),
    });

    expect(out.abstained).toBe(false);
    expect(out.score).toBeCloseTo(0.91, 6); // the RERANK score, not a cosine
    expect(out.memories).toHaveLength(1);
    expect(out.memories[0]!.statement).toBe(SOP);
    expect(await missCount(query)).toBe(0); // a hit is NOT a miss
  });

  it('a candidate the reranker scores below the floor abstains and logs exactly one miss (§6)', async () => {
    const { query } = await freshDb();
    await insertRow(query, 'SOP: weekly client status email every Friday by 4pm.');

    const out = await retrieve('what is the airspeed velocity of an unladen swallow', {
      query,
      embed: fixedEmbedder(E0),
      rerank: constReranker(0.18), // surfaced as a candidate, but the reranker says it's not relevant
      floor: FLOOR,
      ...grantAll(),
    });

    expect(out.abstained).toBe(true);
    expect(out.score).toBeLessThan(FLOOR);
    expect(out.memories).toEqual([]); // NEVER the weak match
    expect(await missCount(query)).toBe(1);

    const row = (await query(`SELECT namespace, query_hash, top_score FROM retrieval_misses`)).rows[0];
    expect(row.query_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(row.top_score).toBeCloseTo(0.18, 6); // it recorded the best RERANK score the candidate set reached
  });

  it('honest abstention: a corpus of ONLY below-floor candidates returns empty — never the nearest weak match', async () => {
    const { query } = await freshDb();
    await insertRow(query, 'weakly-related-a');
    await insertRow(query, 'weakly-related-b');

    const out = await retrieve('q', { query, embed: fixedEmbedder(E0), rerank: constReranker(0.4), floor: FLOOR, ...grantAll() });

    expect(out.abstained).toBe(true);
    expect(out.score).toBeCloseTo(0.4, 6);
    expect(out.memories).toEqual([]);
    expect(await missCount(query)).toBe(1);
  });

  it('the score is the MAX rerank score, NOT a sum — piling on weak candidates cannot defeat the floor (audit fix)', async () => {
    const { query } = await freshDb();
    // FOUR candidates each scored 0.30. A buggy RRF-style SUM would be 1.2 (> floor) and WRONGLY not abstain.
    for (let i = 1; i <= 4; i++) await insertRow(query, `weak-${i}`);

    const out = await retrieve('q', { query, embed: fixedEmbedder(E0), rerank: constReranker(0.3), floor: FLOOR, ...grantAll() });

    expect(out.score).toBeCloseTo(0.3, 6); // the max, not 1.2
    expect(out.abstained).toBe(true); // the floor holds against accumulation
    expect(out.memories).toEqual([]);
  });

  it('the floor is a single injected dial: a borderline candidate flips hit→abstain when the floor is raised', async () => {
    const { query } = await freshDb();
    await insertRow(query, 'borderline');
    const rerank = scriptedReranker({ borderline: 0.65 });

    const hit = await retrieve('q', { query, embed: fixedEmbedder(E0), rerank, floor: 0.5, ...grantAll() });
    expect(hit.abstained).toBe(false);
    expect(hit.score).toBeCloseTo(0.65, 6);
    expect(hit.memories).toHaveLength(1);
    expect(await missCount(query)).toBe(0);

    const abstain = await retrieve('q', { query, embed: fixedEmbedder(E0), rerank, floor: 0.7, ...grantAll() });
    expect(abstain.abstained).toBe(true);
    expect(abstain.memories).toEqual([]);
    expect(await missCount(query)).toBe(1);
    expect((await query(`SELECT top_score FROM retrieval_misses`)).rows[0].top_score).toBeCloseTo(0.65, 6);
  });

  it('empty corpus abstains, logs a miss with a null top_score, and NEVER calls the reranker (no silent empty)', async () => {
    const { query } = await freshDb();
    const spy = spyReranker();

    const out = await retrieve('anything at all', { query, embed: fixedEmbedder(E0), rerank: spy.rerank, floor: FLOOR, ...grantAll() });

    expect(out.abstained).toBe(true);
    expect(out.score).toBe(Number.NEGATIVE_INFINITY);
    expect(out.memories).toEqual([]);
    expect(spy.calls).toHaveLength(0); // nothing to score ⇒ no model call
    expect(await missCount(query)).toBe(1);
    expect((await query(`SELECT top_score FROM retrieval_misses`)).rows[0].top_score).toBeNull();
  });

  it('the predicate is a fail-closed SQL seam (#13): an empty clearance hides an exact match AND sends nothing to the reranker', async () => {
    const { query } = await freshDb();
    await insertRow(query, 'an exact match'); // would score high — but the user cannot see it

    const open = await retrieve('q', { query, embed: fixedEmbedder(E0), rerank: constReranker(0.99), floor: FLOOR, ...grantAll() });
    expect(open.abstained).toBe(false);
    expect(open.memories).toHaveLength(1);

    const spy = spyReranker();
    const closed = await retrieve('q', { query, embed: fixedEmbedder(E0), rerank: spy.rerank, floor: FLOOR, ...grantNothing() });
    expect(closed.abstained).toBe(true); // filtered out BEFORE ranking — not retrieved-then-filtered
    expect(closed.memories).toEqual([]);
    expect(spy.calls).toEqual([]); // the forbidden statement never reached the reranker (zero content egress)
  });

  it('caps the surfaced set at retrieval_max_results (the bounded key), not the whole table', async () => {
    const { query } = await freshDb();
    for (let i = 1; i <= 25; i++) await insertRow(query, `row-${i}`);

    const out = await retrieve('q', { query, embed: fixedEmbedder(E0), rerank: constReranker(0.9), floor: FLOOR, ...grantAll() });

    expect(out.abstained).toBe(false);
    expect(out.memories.length).toBe(20); // retrieval_max_results, not 25
  });

  it('embeds the QUERY through the injected embedder exactly once (the #46 chokepoint)', async () => {
    const { query } = await freshDb();
    await insertRow(query, 'x');
    const calls: string[][] = [];
    const embed: Embedder = async (texts) => {
      calls.push(texts);
      return texts.map(() => E0);
    };
    await retrieve('my question', { query, embed, rerank: constReranker(0.9), floor: FLOOR, ...grantAll() });
    expect(calls).toEqual([['my question']]); // one batch, the query text, nothing else
  });
});
