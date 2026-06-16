/**
 * Issue #4 — ACCEPTANCE: the read half of the M0 slice.
 *   "Asking about the uploaded SOP returns it above the floor; asking about something absent abstains and
 *    logs a miss."
 *
 * Hermetic: pglite (the same migration SQL a client's Supabase runs) + an INJECTED deterministic embedder,
 * so this never touches the network. The REAL gateway.embed() path (the provisional floor vs. genuine
 * paraphrases) is exercised separately, gated on a key, in retrieve.integration.test.ts.
 *
 * The load-bearing properties (each a permanent regression test):
 *   • abstention is the PRODUCT — a below-floor corpus returns EMPTY + a miss, never the nearest weak match;
 *   • the score is the TOP-1 PRE-FUSION DENSE COSINE, never an RRF-style sum (piling on weak candidates must
 *     not push it over the floor — the audit fix);
 *   • the floor is a single injected dial (no magic number); the predicate is a fail-closed SQL seam (#13).
 */
import { describe, it, expect } from 'vitest';
import { freshDb, synthVector, vec } from './helpers/pglite.ts';
import { EMBEDDING_DIM, EMBEDDING_MODEL, EMBEDDING_VERSION } from '../../packages/core/src/harness/gateway.ts';
import type { Embedder } from '../../packages/core/src/harness/gateway.ts';
import { retrieve } from '../../packages/core/src/harness/retrieval.ts';
import { ingestSop } from '../../packages/core/src/memory/store.ts';
import { defaultFor } from '../../packages/core/src/config/system-config.ts';
import { grantAll, grantNothing } from './helpers/grant.ts';

const FLOOR = defaultFor('retrieval_min_relevance') as number; // 0.608 (provisional, #1)

/** A deterministic stand-in for gateway.embed(): synthVector keys a stable unit vector off the exact text. */
function synthEmbedder(): Embedder {
  return async (texts) => texts.map((t) => synthVector(t));
}

/** An embedder that returns a FIXED query vector regardless of the query text — lets a probe pin the exact
 *  cosine of each crafted candidate (synthVector geometry is ~0 or ~1, too coarse for the floor edge). */
function fixedEmbedder(v: number[]): Embedder {
  return async (texts) => texts.map(() => v);
}

/** A unit vector with cosine `c` to e0: component c on axis 0, √(1−c²) on a distinct axis (so candidates at
 *  the same cosine are still different rows). cosine(this, e0) = c exactly. */
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

/** Insert a memory row with an explicit (crafted) embedding — bypasses the embedder to control geometry. */
async function insertRow(
  query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>,
  opts: { namespace?: string; zone?: string; sensitivity?: number; statement: string; embedding: number[] },
): Promise<void> {
  await query(
    `INSERT INTO memories (namespace, zone, sensitivity_level, type, statement, content_hash, provenance,
                           embedding_model, embedding_version, embedding)
     VALUES ($1,$2,$3,'semantic',$4,$5,'{}'::jsonb,$6,$7,$8::vector)`,
    [
      opts.namespace ?? 'org',
      opts.zone ?? 'general',
      opts.sensitivity ?? 1,
      opts.statement,
      `sha256:${opts.statement}`,
      EMBEDDING_MODEL,
      EMBEDDING_VERSION,
      vec(opts.embedding),
    ],
  );
}

const missCount = async (query: (s: string, p?: unknown[]) => Promise<{ rows: any[] }>) =>
  (await query(`SELECT count(*)::int AS n FROM retrieval_misses`)).rows[0].n as number;

describe('retrieve() acceptance (#4)', () => {
  it('asking about the uploaded SOP returns it above the floor — no miss logged', async () => {
    const { query } = await freshDb();
    const embed = synthEmbedder();
    const SOP = 'To onboard a new client: create the workspace, invite the team, set the kickoff.';
    await ingestSop(query, { namespace: 'org', statement: SOP, sourceRef: 'upload://sop/onboarding.pdf' }, { embed });

    const out = await retrieve(SOP, { query, embed, ...grantAll() });

    expect(out.abstained).toBe(false);
    expect(out.score).toBeGreaterThanOrEqual(FLOOR);
    expect(out.score).toBeCloseTo(1, 5); // identical vector ⇒ cosine ≈ 1
    expect(out.memories).toHaveLength(1);
    expect(out.memories[0]!.statement).toBe(SOP);
    expect(await missCount(query)).toBe(0); // a hit is NOT a miss
  });

  it('asking about something absent abstains and logs exactly one miss (the learning signal, §6)', async () => {
    const { query } = await freshDb();
    const embed = synthEmbedder();
    await ingestSop(
      query,
      { namespace: 'org', statement: 'SOP: weekly client status email every Friday by 4pm.', sourceRef: 'upload://sop/cadence.pdf' },
      { embed },
    );

    const out = await retrieve('what is the airspeed velocity of an unladen swallow', { query, embed, ...grantAll() });

    expect(out.abstained).toBe(true);
    expect(out.score).toBeLessThan(FLOOR);
    expect(out.memories).toEqual([]); // NEVER the weak match
    expect(await missCount(query)).toBe(1);

    // The miss is queryable and refs-only (a hash fingerprint, plus the best below-floor score seen).
    const row = (await query(`SELECT namespace, query_hash, top_score FROM retrieval_misses`)).rows[0];
    expect(row.query_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(row.namespace).toBeNull(); // #13 fills this; #4 has no clearance/namespace yet
    expect(row.top_score).toBeLessThan(FLOOR); // it recorded HOW close the best candidate got
  });
});

describe('retrieve() probes (#4 — make it lie / leak / fail silently)', () => {
  it('honest abstention: a corpus of ONLY below-floor rows returns empty — never the nearest weak match', async () => {
    const { query } = await freshDb();
    // Two distinct candidates, each cosine 0.40 to the query (e0) — both individually below the 0.608 floor.
    await insertRow(query, { statement: 'weakly-related-a', embedding: cosVector(0.4, 1) });
    await insertRow(query, { statement: 'weakly-related-b', embedding: cosVector(0.4, 2) });

    const out = await retrieve('q', { query, embed: fixedEmbedder(E0), ...grantAll() });

    expect(out.abstained).toBe(true);
    expect(out.score).toBeCloseTo(0.4, 6); // the single best cosine, surfaced honestly
    expect(out.memories).toEqual([]);
    expect(await missCount(query)).toBe(1);
  });

  it('the score is the TOP-1 cosine, NOT a sum — piling on weak candidates cannot defeat the floor (audit fix)', async () => {
    const { query } = await freshDb();
    // FOUR candidates each at cosine 0.40. A buggy RRF-style SUM would be 1.6 (> floor) and WRONGLY not abstain.
    for (let axis = 1; axis <= 4; axis++) {
      await insertRow(query, { statement: `weak-${axis}`, embedding: cosVector(0.4, axis) });
    }

    const out = await retrieve('q', { query, embed: fixedEmbedder(E0), ...grantAll() });

    expect(out.score).toBeCloseTo(0.4, 6); // top-1, not 1.6
    expect(out.abstained).toBe(true); // the floor holds against accumulation
    expect(out.memories).toEqual([]);
  });

  it('the floor is a single injected dial: a borderline candidate flips hit→abstain when the floor is raised', async () => {
    const { query } = await freshDb();
    await insertRow(query, { statement: 'borderline', embedding: cosVector(0.65, 1) }); // 0.65 > default 0.608

    const hit = await retrieve('q', { query, embed: fixedEmbedder(E0), ...grantAll() }); // default floor
    expect(hit.abstained).toBe(false);
    expect(hit.score).toBeCloseTo(0.65, 6);
    expect(hit.memories).toHaveLength(1);
    expect(await missCount(query)).toBe(0);

    const abstain = await retrieve('q', { query, embed: fixedEmbedder(E0), floor: 0.7, ...grantAll() }); // raise the dial
    expect(abstain.abstained).toBe(true);
    expect(abstain.memories).toEqual([]);
    expect(await missCount(query)).toBe(1);
    const top = (await query(`SELECT top_score FROM retrieval_misses`)).rows[0].top_score;
    expect(top).toBeCloseTo(0.65, 6); // recorded the best it saw, below the raised floor
  });

  it('empty corpus abstains and logs a miss with a null top_score (no silent empty)', async () => {
    const { query } = await freshDb();
    const out = await retrieve('anything at all', { query, embed: fixedEmbedder(E0), ...grantAll() });

    expect(out.abstained).toBe(true);
    expect(out.score).toBe(Number.NEGATIVE_INFINITY);
    expect(out.memories).toEqual([]);
    expect(await missCount(query)).toBe(1);
    expect((await query(`SELECT top_score FROM retrieval_misses`)).rows[0].top_score).toBeNull();
  });

  it('the predicate is a fail-closed SQL seam (#13): an empty clearance hides an exact match (never an app post-filter)', async () => {
    const { query } = await freshDb();
    await insertRow(query, { statement: 'an exact match', embedding: E0 }); // cosine 1.0 to the query

    // A granting clearance finds it; an EMPTY clearance (denyAll ⇒ WHERE false) must hide it at the SQL level.
    const open = await retrieve('q', { query, embed: fixedEmbedder(E0), ...grantAll() });
    expect(open.abstained).toBe(false);
    expect(open.memories).toHaveLength(1);

    const closed = await retrieve('q', { query, embed: fixedEmbedder(E0), ...grantNothing() });
    expect(closed.abstained).toBe(true); // filtered out BEFORE ranking — not retrieved-then-filtered
    expect(closed.memories).toEqual([]);
  });

  it('caps the candidate set at retrieval_max_results (the bounded key), not the whole table', async () => {
    const { query } = await freshDb();
    for (let axis = 1; axis <= 25; axis++) {
      await insertRow(query, { statement: `row-${axis}`, embedding: cosVector(0.7, axis) }); // all above floor
    }
    const out = await retrieve('q', { query, embed: fixedEmbedder(E0), ...grantAll() });
    expect(out.abstained).toBe(false);
    expect(out.memories.length).toBe(defaultFor('retrieval_max_results')); // 20, not 25
  });

  it('embeds the QUERY through the injected embedder exactly once (the #46 chokepoint)', async () => {
    const { query } = await freshDb();
    await insertRow(query, { statement: 'x', embedding: E0 });
    const calls: string[][] = [];
    const embed: Embedder = async (texts) => {
      calls.push(texts);
      return texts.map(() => E0);
    };
    await retrieve('my question', { query, embed, ...grantAll() });
    expect(calls).toEqual([['my question']]); // one batch, the query text, nothing else
  });
});
