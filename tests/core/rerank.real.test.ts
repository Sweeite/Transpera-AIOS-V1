/**
 * Issue #14 — gateway.rerank() against the REAL Voyage reranker (the provisional pin, ADR 0003). Gated on
 * VOYAGE_API_KEY: with no key this SKIPS (CI without secrets stays green) — but it is meant to be RUN, not
 * perpetually skipped. Locally: `npx vitest run tests/core/rerank.real.test.ts` with the key in .env.
 *
 * This is a SMOKE test of the real call shape, NOT the floor calibration — the held-out separation-score
 * calibration lives in tests/eval/reranker-calibration/ and the real floor is deferred to first-client (#43).
 */
import { describe, expect, it } from 'vitest';
import { rerank } from '../../packages/core/src/harness/gateway.ts';

const hasKey = !!process.env.VOYAGE_API_KEY;

describe.skipIf(!hasKey)('gateway.rerank() real Voyage call (#14)', () => {
  it('scores the on-topic document above the off-topic one, in input order', async () => {
    const query = 'What is our weekly client reporting cadence?';
    const docs = [
      'The capital of France is Paris.', // off-topic
      'We send every client a status email every Friday by 4pm.', // on-topic
    ];

    const scores = await rerank(query, docs);

    expect(scores).toHaveLength(docs.length);
    expect(scores.every((s) => Number.isFinite(s))).toBe(true);
    expect(scores[1]).toBeGreaterThan(scores[0]!); // the relevant doc scores higher — in INPUT order
  });

  it('returns [] for an empty batch without calling the provider', async () => {
    expect(await rerank('q', [])).toEqual([]);
  });
});
