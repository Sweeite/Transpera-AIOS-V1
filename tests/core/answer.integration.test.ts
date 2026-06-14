/**
 * Issue #5 — ACCEPTANCE, end to end (hermetic): ingest → retrieve → synthesize → labelled answer / abstain.
 *
 * Fully hermetic: pglite (the same migration SQL a client's Supabase runs) + an INJECTED deterministic
 * embedder + an INJECTED FAKE model response. No network. The real-LLM synthesis is exercised separately,
 * key-gated, in answer.real.integration.test.ts.
 *
 * Load-bearing properties (each a permanent regression test):
 *   • the SOP answer shows "I know this" + source + as-of (the demo acceptance);
 *   • ★ THE GUARD HOLDS IN THE FULL PIPELINE: a fake model citing a NON-retrieved id is relabelled, never
 *     surfaced as "I know this" (the audit fix, e2e — complements the unit test);
 *   • an unknown question abstains with the honest copy, logs EXACTLY ONE miss, and NEVER calls the model.
 */
import { describe, it, expect } from 'vitest';
import { freshDb, synthVector } from './helpers/pglite.ts';
import type { Embedder } from '../../packages/core/src/harness/gateway.ts';
import type { CallOptions, CallResult } from '../../packages/core/src/harness/gateway.ts';
import { ingestSop } from '../../packages/core/src/memory/store.ts';
import { answerQuestion, type ModelCaller } from '../../packages/core/src/harness/synthesis.ts';
import { renderAnswer, ABSTENTION_COPY } from '../../packages/core/src/harness/provenance.ts';

const SOP = 'To onboard a new client: create the workspace, invite the team, and book the kickoff.';

function synthEmbedder(): Embedder {
  return async (texts) => texts.map((t) => synthVector(t));
}

/** Extract the first listed source id from the synthesis prompt ([id] statement) — lets a fake model cite a
 *  REAL retrieved id without the test knowing it in advance. */
function firstSourceId(opts: CallOptions<unknown>): string {
  const content = opts.messages.map((m) => m.content).join('\n');
  const m = content.match(/\[([^\]]+)\]/);
  if (!m) throw new Error('fake model: no source id in prompt');
  return m[1]!;
}

/** A fake model that cites whatever the test tells it to. `cite` receives the prompt so it can echo a real id
 *  or return a fabricated one. Counts its calls so we can prove the model is NOT called on abstention. */
function fakeModel(
  build: (opts: CallOptions<unknown>) => Array<{ text: string; sourceId?: string | null }>,
  counter?: { n: number },
): ModelCaller {
  return (async (opts: CallOptions<unknown>) => {
    if (counter) counter.n++;
    const claims = build(opts);
    const output = opts.schema ? opts.schema.parse({ claims }) : ('' as unknown);
    return { output, usage: { model: 'fake', durationMs: 0 } } as CallResult<unknown>;
  }) as ModelCaller;
}

const missCount = async (query: (s: string, p?: unknown[]) => Promise<{ rows: any[] }>) =>
  (await query(`SELECT count(*)::int AS n FROM retrieval_misses`)).rows[0].n as number;

describe('answerQuestion() acceptance (#5 — THE DEMO)', () => {
  it('the SOP answer shows "I know this" + source + as-of; no miss logged; model called once', async () => {
    const { query } = await freshDb();
    const embed = synthEmbedder();
    await ingestSop(query, { namespace: 'org', statement: SOP, sourceRef: 'upload://sop/onboarding.pdf', capturedAt: '2026-02-01T00:00:00.000Z' }, { embed });

    const calls = { n: 0 };
    const callModel = fakeModel(
      (opts) => [{ text: 'Create the workspace and invite the team.', sourceId: firstSourceId(opts) }],
      calls,
    );

    const { answer, retrieval } = await answerQuestion(SOP, { query, embed, callModel });

    expect(answer.abstained).toBe(false);
    expect(answer.claims).toHaveLength(1);
    const claim = answer.claims[0]!;
    expect(claim.label).toBe('memory'); // "I know this"
    expect(claim.sourceId).toBe(retrieval.memories[0]!.id);
    expect(claim.asOf).toBe('2026-02-01T00:00:00.000Z');
    expect(calls.n).toBe(1); // one synthesis call
    expect(await missCount(query)).toBe(0); // a hit is not a miss

    const rendered = renderAnswer(answer, retrieval);
    expect(rendered).toMatch(/I know this/i);
    expect(rendered).toContain('upload://sop/onboarding.pdf'); // the real source, not the uuid
    expect(rendered).toContain('2026-02-01');
  });

  it('★ a fake model citing a NON-retrieved id is relabelled to general-inference in the full pipeline (audit fix, e2e)', async () => {
    const { query } = await freshDb();
    const embed = synthEmbedder();
    await ingestSop(query, { namespace: 'org', statement: SOP, sourceRef: 'upload://sop/onboarding.pdf' }, { embed });

    const signals: Array<{ claimText: string; citedId: string }> = [];
    const callModel = fakeModel(() => [
      { text: 'Invoices are due in 7 days.', sourceId: 'mem-FABRICATED-not-retrieved' }, // a lie
    ]);

    const { answer } = await answerQuestion(SOP, { query, embed, callModel, onFabricatedCitation: (i) => signals.push(i) });

    const claim = answer.claims[0]!;
    expect(claim.label).toBe('general-inference'); // NEVER surfaced as "I know this"
    expect(claim.label).not.toBe('memory');
    expect(claim.sourceId).toBeUndefined(); // the fabricated id is stripped
    expect(claim.asOf).toBeUndefined();
    expect(signals).toEqual([{ claimText: 'Invoices are due in 7 days.', citedId: 'mem-FABRICATED-not-retrieved' }]);
  });

  it('an unknown question abstains: honest copy, EXACTLY ONE miss, model NEVER called (no double-log, no call on abstain)', async () => {
    const { query } = await freshDb();
    const embed = synthEmbedder();
    await ingestSop(query, { namespace: 'org', statement: SOP, sourceRef: 'upload://sop/onboarding.pdf' }, { embed });

    const calls = { n: 0 };
    const callModel = fakeModel(() => [{ text: 'should never be produced' }], calls);

    const { answer, retrieval } = await answerQuestion('what is the airspeed velocity of an unladen swallow', {
      query,
      embed,
      callModel,
    });

    expect(answer.abstained).toBe(true);
    expect(retrieval.abstained).toBe(true);
    expect(answer.claims).toEqual([]); // no invented business fact
    expect(calls.n).toBe(0); // the model is NOT called on abstention (nudge 4)
    expect(await missCount(query)).toBe(1); // retrieve() logged exactly one miss; labelAnswer logged none
    expect(renderAnswer(answer)).toBe(ABSTENTION_COPY); // the surface shows the honest copy, never empty
  });
});
