/**
 * Issue #5 — TRUE end-to-end with the REAL providers (key-gated, normally skipped in CI/local).
 *
 * Runs ONLY when BOTH keys are present: OPENAI_API_KEY (the pinned embedder) + ANTHROPIC_API_KEY (the Haiku
 * 4.5 synthesis). Exercises the genuine path the hermetic tests stub: real embeddings clear the real floor,
 * real forced-tool-use returns structured cited claims, and the structural guard runs over them.
 *
 *   node --env-file=.env node_modules/.bin/vitest run tests/core/answer.real.integration.test.ts
 *
 * Asserts the load-bearing behaviour, NOT exact wording (the model's prose varies): a near-verbatim question
 * yields at least one grounded "I know this" claim citing a retrieved id; an unrelated question abstains.
 */
import { describe, it, expect } from 'vitest';
import { freshDb } from './helpers/pglite.ts';
import { ingestSop } from '../../packages/core/src/memory/store.ts';
import { answerQuestion } from '../../packages/core/src/harness/synthesis.ts';

const HAVE_KEYS = !!process.env.OPENAI_API_KEY && !!process.env.ANTHROPIC_API_KEY;
const SOP =
  'To onboard a new client: 1) create the workspace, 2) invite the client team, 3) book the kickoff within 5 business days, 4) send the welcome pack.';

describe.skipIf(!HAVE_KEYS)('answerQuestion() real-LLM end-to-end (#5, key-gated)', () => {
  it('a near-verbatim question returns a grounded "I know this" claim citing a retrieved id', async () => {
    const { query } = await freshDb();
    // Real pinned embeddings (opts {} → gateway.embed); real synthesis (no callModel injected → gateway.callModel).
    await ingestSop(query, { namespace: 'org', statement: SOP, sourceRef: 'upload://sop/onboarding.pdf', capturedAt: '2026-02-01T00:00:00.000Z' });

    const { answer, retrieval } = await answerQuestion('What are the steps to onboard a new client?', { query });

    expect(answer.abstained).toBe(false);
    const retrievedIds = new Set(retrieval.memories.map((m) => m.id));
    const grounded = answer.claims.filter((c) => c.label === 'memory');
    expect(grounded.length).toBeGreaterThanOrEqual(1);
    // Every grounded claim's id MUST be a real retrieved id (the structural guard's invariant, post-synthesis).
    for (const c of grounded) expect(retrievedIds.has(c.sourceId!)).toBe(true);
  }, 30_000);

  it('an unrelated question abstains with the honest copy (no confabulation)', async () => {
    const { query } = await freshDb();
    await ingestSop(query, { namespace: 'org', statement: SOP, sourceRef: 'upload://sop/onboarding.pdf' });

    const { answer } = await answerQuestion('what is the airspeed velocity of an unladen swallow', { query });
    expect(answer.abstained).toBe(true);
    expect(answer.claims).toEqual([]);
  }, 30_000);
});
