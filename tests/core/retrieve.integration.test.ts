/**
 * Issue #4 — the read half against the REAL provisional vector space (text-embedding-3-large @ 1024).
 * Synthetic vectors are ~0 or ~1, so they CANNOT prove the thing that matters: that a genuine paraphrase of
 * the SOP clears the floor while an off-topic question abstains. Only real embeddings test that separation.
 *
 * Gated on OPENAI_API_KEY: with no key this SKIPS (CI without secrets stays green) — but it is meant to be
 * RUN. Locally: `npx vitest run tests/core/retrieve.integration.test.ts` with the key in .env.
 *
 * ⚠ This is ALSO a probe of the PROVISIONAL floor (0.608 came from the SYNTHETIC #1 bake-off, calibration-set
 *   == test-set). If a legitimate paraphrase lands below 0.608 and this test fails, that is a DATA POINT for
 *   the #43 first-client floor recalibration — NOT a bug to paper over. Do NOT lower the floor to make one
 *   example pass: that is the calibration overfit trap we flagged for #1/#14. The robust assertion here is
 *   the BEHAVIOUR/ORDERING (paraphrase scores clearly above off-topic); the absolute floor crossing is
 *   reported (console) so a borderline value surfaces loudly as the #43 signal.
 */
import { describe, it, expect } from 'vitest';
import { freshDb } from './helpers/pglite.ts';
import { retrieve } from '../../packages/core/src/harness/retrieval.ts';
import { ingestSop } from '../../packages/core/src/memory/store.ts';
import { defaultFor } from '../../packages/core/src/config/system-config.ts';

const hasKey = !!process.env.OPENAI_API_KEY;
const FLOOR = defaultFor('retrieval_min_relevance') as number;

describe.skipIf(!hasKey)('retrieve() against the real provisional embedding space (#4)', () => {
  it('a paraphrase of the SOP clears the floor and returns it; an off-topic question abstains + logs a miss', async () => {
    const { query } = await freshDb(); // real embeddings, hermetic DB — the gateway default embedder is used

    const SOP =
      'To onboard a new client, create their workspace, invite their team members, and schedule the kickoff call.';
    await ingestSop(query, { namespace: 'org', statement: SOP, sourceRef: 'upload://sop/onboarding.pdf' });

    // Same meaning, different words — the semantic win synthetic vectors cannot model.
    const paraphrase = await retrieve('How do we set up a brand-new customer so we can get started with them?', { query });
    // Unrelated to anything in the corpus — must abstain.
    const offTopic = await retrieve('What time does the moon rise over Lisbon next Tuesday?', { query });

    // Report the actual scores so a borderline provisional floor is a visible #43 data point (note B).
    console.info(
      `[#4 real-floor probe] floor=${FLOOR} paraphrase=${paraphrase.score.toFixed(4)} offTopic=${offTopic.score.toFixed(4)}`,
    );

    // Robust semantic property: on-topic is clearly more relevant than off-topic, regardless of the exact floor.
    expect(paraphrase.score).toBeGreaterThan(offTopic.score);

    // Off-topic must abstain and log the miss (the spine property — this one should never be borderline).
    expect(offTopic.abstained).toBe(true);
    expect(offTopic.memories).toEqual([]);
    expect((await query(`SELECT count(*)::int AS n FROM retrieval_misses`)).rows[0].n).toBe(1);

    // Behaviour assertion: the paraphrase clears the floor and returns the SOP. If THIS fails on real data,
    // it is the #43 floor-recalibration signal — investigate the floor, do NOT lower it to pass (note B).
    expect(paraphrase.abstained).toBe(false);
    expect(paraphrase.memories[0]?.statement).toBe(SOP);
  });
});
