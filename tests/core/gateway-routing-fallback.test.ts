/**
 * Issue #10 — the LLM gateway's routing / fallback / bounded-repair / cache / cost machinery.
 *
 * Everything here is HERMETIC: the transport is INJECTED (a fake that simulates a timeout, malformed output,
 * a fatal 4xx, a cache-read), so fallback / repair / cost / deadline behaviour is tested deterministically
 * WITHOUT the real API or a global-fetch stub. The key-gated real-API smoke layer lives elsewhere.
 *
 * Red lines under test:
 *   • fallback is VISIBLE — usage.model is the model that actually answered + the span records the downgrade;
 *   • repair is BOUNDED — 1 repair on the primary → escalate to the fallback (single shot) → throw LOUD;
 *   • fatal (4xx) SHORT-CIRCUITS — no retry, no fallback (a bad key/model id must surface, not be masked);
 *   • cost + span AGGREGATE every round-trip (failed primary + repair + fallback), never just the answer;
 *   • a cached prefix shows REDUCED input-token cost (cache-read priced at 0.1×);
 *   • the TOTAL round-trip count is bounded (product of retry × repair × models), and an overall deadline caps wall-time.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import {
  callModel,
  GatewayTransportError,
  GENERATION_MODEL, // Haiku — the cheap tier
  SONNET_MODEL,
  OPUS_MODEL,
  type Transport,
  type ProviderRawResponse,
  type GatewaySpan,
} from '../../packages/core/src/harness/gateway.ts';

const Schema = z.object({ value: z.string() });

// ── response builders ──
const okStructured = (value: string, usage?: ProviderRawResponse['usage']): ProviderRawResponse => ({
  content: [{ type: 'tool_use', name: 'emit_structured_output', input: { value } }],
  ...(usage ? { usage } : {}),
});
const okText = (text: string, usage?: ProviderRawResponse['usage']): ProviderRawResponse => ({
  content: [{ type: 'text', text }],
  ...(usage ? { usage } : {}),
});
// A 200 with no tool_use block — structurally malformed for a forced-tool call.
const malformed = (usage?: ProviderRawResponse['usage']): ProviderRawResponse => ({
  content: [{ type: 'text', text: 'I will not use the tool' }],
  ...(usage ? { usage } : {}),
});

interface Recorded {
  model: string;
  messages: Array<{ role: string; content: string }>;
  body: Record<string, unknown>;
}

/** Build a fake transport from a per-call handler, recording every request it sees. */
function fakeTransport(handler: (model: string, callNo: number, rec: Recorded) => ProviderRawResponse): {
  transport: Transport;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  const transport: Transport = async (req) => {
    const rec: Recorded = {
      model: req.model,
      messages: (req.body.messages as Recorded['messages']) ?? [],
      body: req.body,
    };
    calls.push(rec);
    return handler(req.model, calls.length - 1, rec);
  };
  return { transport, calls };
}

const FAST = { retryBackoffMs: 0 }; // no real backoff sleeping in tests

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = 'test-key';
});
afterEach(() => {
  delete process.env.ANTHROPIC_API_KEY;
});

describe('callModel() routing (#10, Anthropic tiers — conservative until #32)', () => {
  it('routes a non-structured cheap class to the Haiku primary', async () => {
    const { transport, calls } = fakeTransport(() => okText('hi'));
    const { usage } = await callModel({ taskClass: 'classify', messages: [{ role: 'user', content: 'q' }] }, { transport });
    expect(calls[0].model).toBe(GENERATION_MODEL); // Haiku
    expect(usage.model).toBe(GENERATION_MODEL);
  });

  it('routes a hard class to the Sonnet primary, Opus fallback', async () => {
    const { transport, calls } = fakeTransport(() => okStructured('ok'));
    await callModel({ taskClass: 'reason', schema: Schema, messages: [{ role: 'user', content: 'q' }] }, { transport });
    expect(calls[0].model).toBe(SONNET_MODEL);
  });

  it('upgrades a STRUCTURED call off the Haiku tier (cheap model bad at JSON burns repair — the Watch)', async () => {
    const { transport, calls } = fakeTransport(() => okStructured('ok'));
    // 'classify' is Haiku-primary, but WITH a schema it must not start on Haiku until #32 clears the route.
    await callModel({ taskClass: 'classify', schema: Schema, messages: [{ role: 'user', content: 'q' }] }, { transport });
    expect(calls[0].model).toBe(SONNET_MODEL);
  });
});

describe('callModel() fallback is VISIBLE, never silent (#10)', () => {
  it('primary times out → fallback answers → usage.model = fallback + the fallback is recorded on usage AND the span', async () => {
    const spans: GatewaySpan[] = [];
    const { transport, calls } = fakeTransport((model) => {
      if (model === SONNET_MODEL) throw new GatewayTransportError('timeout', 'simulated timeout');
      return okStructured('answered-by-opus');
    });
    const { output, usage } = await callModel(
      { taskClass: 'synthesize', schema: Schema, messages: [{ role: 'user', content: 'q' }] },
      { transport, onSpan: (s) => spans.push(s), config: { retryCount: 0, ...FAST } },
    );

    expect(output).toEqual({ value: 'answered-by-opus' });
    expect(usage.model).toBe(OPUS_MODEL); // the model that ACTUALLY answered
    expect(usage.fallback).toEqual({ from: SONNET_MODEL, reason: 'timeout' });
    expect(calls.map((c) => c.model)).toEqual([SONNET_MODEL, OPUS_MODEL]);
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({ model: OPUS_MODEL, ok: true, fallback: { from: SONNET_MODEL, reason: 'timeout' } });
  });

  it('transient (429/5xx) retries the SAME model with backoff, then falls back', async () => {
    const { transport, calls } = fakeTransport((model) => {
      if (model === SONNET_MODEL) throw new GatewayTransportError('transient', '529 overloaded');
      return okStructured('ok');
    });
    const { usage } = await callModel(
      { taskClass: 'synthesize', schema: Schema, messages: [{ role: 'user', content: 'q' }] },
      { transport, config: { retryCount: 2, ...FAST } },
    );
    // Sonnet tried 1 + 2 retries = 3, then Opus once. usage.model = Opus, downgrade reason transient.
    expect(calls.filter((c) => c.model === SONNET_MODEL)).toHaveLength(3);
    expect(usage.model).toBe(OPUS_MODEL);
    expect(usage.fallback).toEqual({ from: SONNET_MODEL, reason: 'transient' });
  });
});

describe('callModel() bounded repair — the ⚠ audit fix (#10)', () => {
  it('malformed → exactly ONE repair on the primary → escalate to fallback → loud throw; no unbounded loop', async () => {
    const { transport, calls } = fakeTransport(() => malformed()); // every attempt malformed
    await expect(
      callModel(
        { taskClass: 'synthesize', schema: Schema, messages: [{ role: 'user', content: 'q' }] },
        { transport, config: { retryCount: 0, repairAttempts: 1, ...FAST } },
      ),
    ).rejects.toThrow(/exhausted 2 model\(s\)[\s\S]*refusing to surface/i);

    // EXACTLY 3 transport calls: primary initial, primary repair, fallback single-shot. Bounded.
    expect(calls.map((c) => c.model)).toEqual([SONNET_MODEL, SONNET_MODEL, OPUS_MODEL]);
    // The repair (call #2) re-prompts the SAME model with a content-free validation reason appended.
    expect(calls[1].messages).toHaveLength(calls[0].messages.length + 1);
    expect(calls[1].messages.at(-1)!.content).toMatch(/did not satisfy the required structure/i);
    // The fallback (call #3) is a single shot — NOT itself repaired (back to the original messages).
    expect(calls[2].messages).toHaveLength(calls[0].messages.length);
  });

  it('malformed → repair SUCCEEDS on the primary → returns, no fallback', async () => {
    const { transport, calls } = fakeTransport((_model, callNo) => (callNo === 0 ? malformed() : okStructured('repaired')));
    const { output, usage } = await callModel(
      { taskClass: 'synthesize', schema: Schema, messages: [{ role: 'user', content: 'q' }] },
      { transport, config: { retryCount: 0, repairAttempts: 1, ...FAST } },
    );
    expect(output).toEqual({ value: 'repaired' });
    expect(usage.model).toBe(SONNET_MODEL);
    expect(usage.fallback).toBeUndefined();
    expect(calls.map((c) => c.model)).toEqual([SONNET_MODEL, SONNET_MODEL]); // primary twice, no Opus
  });

  it('a 2nd repair CHAINS context — each repair turn is appended, not replaced (repairAttempts=2)', async () => {
    // Review fix: withRepairTurn must build from the CURRENT messages so repair#2 carries repair#1's turn too.
    const { transport, calls } = fakeTransport((_m, callNo) => (callNo < 2 ? malformed() : okStructured('ok')));
    await callModel(
      { taskClass: 'synthesize', schema: Schema, messages: [{ role: 'user', content: 'q' }] },
      { transport, config: { retryCount: 0, repairAttempts: 2, ...FAST } },
    );
    expect(calls.map((c) => c.model)).toEqual([SONNET_MODEL, SONNET_MODEL, SONNET_MODEL]); // 3 on primary, no fallback
    expect(calls[2].messages.length).toBe(calls[0].messages.length + 2); // BOTH prior repair turns chained
  });
});

describe('callModel() an empty completion is NOT a silent answer (#10 review fix, §3.2)', () => {
  it('a non-structured EMPTY/whitespace completion falls back, never returns "" as success', async () => {
    const { transport, calls } = fakeTransport((model) =>
      model === GENERATION_MODEL ? okText('   ') : okText('real answer'),
    );
    const { output, usage } = await callModel(
      { taskClass: 'summarise', messages: [{ role: 'user', content: 'q' }] }, // Haiku-primary, Sonnet fallback
      { transport, config: { retryCount: 0, ...FAST } },
    );
    expect(output).toBe('real answer');
    expect(usage.model).toBe(SONNET_MODEL);
    expect(usage.fallback).toMatchObject({ from: GENERATION_MODEL });
    expect(calls.map((c) => c.model)).toEqual([GENERATION_MODEL, SONNET_MODEL]);
  });

  it('an all-empty chain throws LOUD — never silently returns ""', async () => {
    const { transport } = fakeTransport(() => okText(''));
    await expect(
      callModel({ taskClass: 'summarise', messages: [{ role: 'user', content: 'q' }] }, { transport, config: { retryCount: 0, ...FAST } }),
    ).rejects.toThrow(/exhausted/i);
  });
});

describe('callModel() fatal (4xx) short-circuits — surface, never mask (#10 gap 2)', () => {
  it('a fatal 401/400 throws immediately with NO retry and NO fallback', async () => {
    const { transport, calls } = fakeTransport((model) => {
      if (model === SONNET_MODEL) throw new GatewayTransportError('fatal', '401 unauthorized');
      return okStructured('should-never-be-reached');
    });
    await expect(
      callModel(
        { taskClass: 'synthesize', schema: Schema, messages: [{ role: 'user', content: 'q' }] },
        { transport, config: { retryCount: 2, ...FAST } }, // retries enabled — must STILL not retry on fatal
      ),
    ).rejects.toThrow(/401 unauthorized/);
    // Only the primary was called once; the fallback model was never touched.
    expect(calls.map((c) => c.model)).toEqual([SONNET_MODEL]);
    expect(calls.some((c) => c.model === OPUS_MODEL)).toBe(false);
  });
});

describe('callModel() cost + span aggregate EVERY round-trip (#10 gap 1, §11.7)', () => {
  const U = { input_tokens: 100, output_tokens: 50 };

  it('a repair→fallback success costs MORE than a clean call (failed attempts are billed too)', async () => {
    // Path A: Sonnet malformed (billed) → Sonnet repair malformed (billed) → Opus answers (billed).
    const a = fakeTransport((_m, callNo) => (callNo < 2 ? malformed(U) : okStructured('ok', U)));
    const { usage: usageA } = await callModel(
      { taskClass: 'synthesize', schema: Schema, messages: [{ role: 'user', content: 'q' }] },
      { transport: a.transport, config: { retryCount: 0, repairAttempts: 1, ...FAST } },
    );

    // Path B: a clean single Opus answer (use 'reason' but force malformed off — just answer first try on Opus
    // by timing out Sonnet so Opus is the lone billed success).
    const b = fakeTransport((model) => {
      if (model === SONNET_MODEL) throw new GatewayTransportError('timeout', 't');
      return okStructured('ok', U);
    });
    const { usage: usageB } = await callModel(
      { taskClass: 'synthesize', schema: Schema, messages: [{ role: 'user', content: 'q' }] },
      { transport: b.transport, config: { retryCount: 0, ...FAST } },
    );

    expect(usageA.attempts).toBe(3);
    expect(usageB.attempts).toBe(2); // Sonnet timeout (no usage) + Opus answer (billed)
    // A billed two extra Sonnet round-trips on top of the same Opus answer → strictly more cost.
    expect(usageA.costUsd!).toBeGreaterThan(usageB.costUsd!);
    expect(usageA.costUsd!).toBeGreaterThan(0);
  });

  it('a cached prefix shows REDUCED input-token cost (cache-read priced at 0.1× — the acceptance)', async () => {
    const fresh = fakeTransport(() => okText('x', { input_tokens: 1000, output_tokens: 0 }));
    const { usage: freshUsage } = await callModel(
      { taskClass: 'classify', messages: [{ role: 'user', content: 'q' }] },
      { transport: fresh.transport, config: { ...FAST } },
    );

    const cached = fakeTransport(() => okText('x', { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 1000 }));
    const { usage: cachedUsage } = await callModel(
      { taskClass: 'classify', messages: [{ role: 'user', content: 'q' }] },
      { transport: cached.transport, config: { ...FAST } },
    );

    expect(cachedUsage.cacheReadTokens).toBe(1000);
    // Same 1000 input tokens, but served from cache → ~0.1× the fresh-input cost.
    expect(cachedUsage.costUsd!).toBeCloseTo(freshUsage.costUsd! * 0.1, 12);
    expect(cachedUsage.costUsd!).toBeLessThan(freshUsage.costUsd!);
  });

  it('places cache_control on the stable system prefix (per-provider adapter concern)', async () => {
    const { transport, calls } = fakeTransport(() => okStructured('ok'));
    await callModel(
      { taskClass: 'synthesize', system: 'STABLE PREFIX', schema: Schema, messages: [{ role: 'user', content: 'q' }] },
      { transport, config: { ...FAST } },
    );
    const system = calls[0].body.system as Array<{ type: string; text: string; cache_control?: unknown }>;
    expect(system[0]).toMatchObject({ type: 'text', text: 'STABLE PREFIX', cache_control: { type: 'ephemeral' } });
  });
});

describe('callModel() bounded TOTAL round-trips + overall deadline (#10 gaps 3 & 4)', () => {
  // Worst case for a structured call = (1 initial + repairAttempts + (chainLen-1 fallbacks)) × (1 + retryCount).
  // With repairAttempts=1, chainLen=2, retryCount=2 → (1+1+1) × 3 = 9. The count must never exceed this.
  const WORST_CASE_STRUCTURED = (1 + 1 + 1) * (1 + 2);

  it('all-transient exhausts retries × models but stays within the ceiling (product, not each lever alone)', async () => {
    const spans: GatewaySpan[] = [];
    const { transport } = fakeTransport(() => {
      throw new GatewayTransportError('transient', '529');
    });
    await expect(
      callModel(
        { taskClass: 'synthesize', schema: Schema, messages: [{ role: 'user', content: 'q' }] },
        { transport, onSpan: (s) => spans.push(s), config: { retryCount: 2, repairAttempts: 1, ...FAST } },
      ),
    ).rejects.toThrow(/exhausted/i);
    // Sonnet: 1+2 retries = 3; Opus: 1+2 = 3 (repairs are skipped on transient — they're not validation failures).
    expect(spans[0].attempts).toBe(6);
    expect(spans[0].attempts).toBeLessThanOrEqual(WORST_CASE_STRUCTURED);
    expect(spans[0].ok).toBe(false); // failure still records a span (the spend is real + alertable)
  });

  it('malformed-only (no transient) is bounded by the repair+fallback sum, well under the ceiling', async () => {
    const spans: GatewaySpan[] = [];
    const { transport } = fakeTransport(() => malformed());
    await expect(
      callModel(
        { taskClass: 'synthesize', schema: Schema, messages: [{ role: 'user', content: 'q' }] },
        { transport, onSpan: (s) => spans.push(s), config: { retryCount: 2, repairAttempts: 1, ...FAST } },
      ),
    ).rejects.toThrow(/exhausted/i);
    expect(spans[0].attempts).toBe(3); // initial + 1 repair + fallback; retries unused (malformed isn't transient)
    expect(spans[0].attempts).toBeLessThanOrEqual(WORST_CASE_STRUCTURED);
  });

  it('a malformed primary is BILLED even when a later attempt answers (no under-report through a failed call)', async () => {
    // Probe: try to make a failed primary "cost nothing". Primary malformed WITH tokens, fallback answers.
    const { transport } = fakeTransport((_m, callNo) =>
      callNo < 2 ? malformed({ input_tokens: 100, output_tokens: 10 }) : okStructured('ok', { input_tokens: 100, output_tokens: 10 }),
    );
    const { usage } = await callModel(
      { taskClass: 'synthesize', schema: Schema, messages: [{ role: 'user', content: 'q' }] },
      { transport, config: { retryCount: 0, repairAttempts: 1, ...FAST } },
    );
    // tokensIn aggregates all 3 round-trips (2 malformed + 1 answer) — 300, not just the answering 100.
    expect(usage.tokensIn).toBe(300);
    expect(usage.attempts).toBe(3);
  });
});

describe('callModel() PROBE regressions (#10 — make it lie / leak / skip cost)', () => {
  it('stream:true FAILS LOUD — never a silent non-stream, never an un-traced streamed call (deferred to #54)', async () => {
    const { transport, calls } = fakeTransport(() => okText('x'));
    await expect(
      callModel({ taskClass: 'summarise', stream: true, messages: [{ role: 'user', content: 'q' }] }, { transport }),
    ).rejects.toThrow(/streaming[\s\S]*#54/i);
    expect(calls).toHaveLength(0); // refused before any provider call
  });

  it('does NOT response-cache — two identical calls each re-hit the transport (no stale answer served)', async () => {
    // Probe: a response cache would serve a stale model OUTPUT. The gateway caches PROMPT prefixes only.
    const { transport, calls } = fakeTransport(() => okText('fresh'));
    const opts = { taskClass: 'classify' as const, system: 'STABLE', messages: [{ role: 'user', content: 'same' }] };
    await callModel(opts, { transport, config: { ...FAST } });
    await callModel(opts, { transport, config: { ...FAST } });
    expect(calls).toHaveLength(2); // both calls reached the provider — nothing was served from an output cache
  });

  it('honors an overall deadline — total wall-time cannot reach N × per-call timeout', async () => {
    const spans: GatewaySpan[] = [];
    const clock = { t: 0 };
    const { transport } = fakeTransport(() => {
      clock.t += 1000; // each transport call "takes" 1s of wall-clock
      throw new GatewayTransportError('transient', 'slow');
    });
    await expect(
      callModel(
        { taskClass: 'synthesize', schema: Schema, messages: [{ role: 'user', content: 'q' }] },
        {
          transport,
          onSpan: (s) => spans.push(s),
          now: () => clock.t,
          sleep: async () => {},
          // deadline of 1500ms: after ~2 round-trips the elapsed clock trips it, well before the 6–9 ceiling.
          config: { retryCount: 2, repairAttempts: 1, totalDeadlineMs: 1500, requestTimeoutMs: 60000, retryBackoffMs: 0 },
        },
      ),
    ).rejects.toThrow(/deadline/i);
    expect(spans[0].attempts).toBeLessThanOrEqual(2); // stopped early — not the full retry × model budget
  });
});
