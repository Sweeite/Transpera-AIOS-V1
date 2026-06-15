/**
 * Issue #11 — the two #10 carry-forwards (observability completeness on a FAILED call), as regressions:
 *   1. a failed call's span includes `fallback` — a call that fell back and THEN failed still shows the
 *      downgrade was attempted (previously attached only when succeeded).
 *   2. a failed call's aggregate spend is visible — on the span (the sink #11 wires) AND in the loud throw
 *      message (visibility even with NO sink).
 * Hermetic: the transport is injected (no real API). See gateway-routing-fallback.test.ts (#10).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import { callModel, SONNET_MODEL, type Transport, type ProviderRawResponse, type GatewaySpan } from '../../packages/core/src/harness/gateway.ts';

const Schema = z.object({ value: z.string() });
const usage = { input_tokens: 100, output_tokens: 10 };
// A 200 with no tool_use block — structurally malformed for a forced-tool call, but it BILLS (usage present).
const malformed = (): ProviderRawResponse => ({ content: [{ type: 'text', text: 'nope' }], usage });

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = 'test-key';
});
afterEach(() => {
  delete process.env.ANTHROPIC_API_KEY;
});

describe('gateway span completeness on failure (#11 / #10 carry-forwards)', () => {
  it('a failed structured call records fallback + non-zero cost on its span, and surfaces cost in the throw', async () => {
    // Every round-trip bills but is malformed → primary (Sonnet) repairs then escalates (validation) → fallback
    // (Opus) single shot also malformed → total failure.
    const transport: Transport = async () => malformed();
    let span: GatewaySpan | undefined;

    await expect(
      callModel({ taskClass: 'reason', messages: [{ role: 'user', content: 'hi' }], schema: Schema },
        { transport, onSpan: (s) => { span = s; }, config: { retryBackoffMs: 0 } }),
    ).rejects.toThrow(/costUsd=/); // (2) cost visible in the throw even without a sink

    expect(span).toBeDefined();
    expect(span!.ok).toBe(false);
    expect(span!.fallback).toEqual({ from: SONNET_MODEL, reason: 'validation' }); // (1) downgrade recorded on a FAILED call
    expect(span!.costUsd).toBeGreaterThan(0); // (2) aggregate spend on the span
  });
});
