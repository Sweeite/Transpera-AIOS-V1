/**
 * Issue #3 — the FIRST real provider call to land in the engine. gateway.embed() must:
 *   - go through the single chokepoint (gateway.ts) — #46 keeps that true,
 *   - use the PROVISIONAL pin (text-embedding-3-large @ 1024 dims),
 *   - read OPENAI_API_KEY from the env to run for real.
 *
 * Gated on the key: with no key this SKIPS (CI without secrets stays green) — but it is meant to be RUN,
 * not perpetually skipped. Locally: `npx vitest run tests/core/embed.integration.test.ts` with the key in .env
 * (load it: `tsx`/`vitest` pick up process.env; or `node --env-file=.env`).
 */
import { describe, it, expect } from 'vitest';
import { embed, EMBEDDING_DIM } from '../../packages/core/src/harness/gateway.ts';

const hasKey = !!process.env.OPENAI_API_KEY;

describe.skipIf(!hasKey)('gateway.embed() real OpenAI call (#3)', () => {
  it('embeds a batch → one pinned-dimension vector per input, in order', async () => {
    const inputs = ['the nearest thing', 'something entirely unrelated'];
    const vectors = await embed(inputs);

    expect(vectors).toHaveLength(inputs.length);
    for (const v of vectors) {
      expect(v).toHaveLength(EMBEDDING_DIM); // 1024 — the provisional pin, NOT large's 3072 default
      expect(v.every((x) => Number.isFinite(x))).toBe(true);
    }
    // Sanity: two different texts produce different vectors.
    expect(vectors[0]).not.toEqual(vectors[1]);
  });

  it('returns [] for an empty batch without calling the provider', async () => {
    expect(await embed([])).toEqual([]);
  });
});
