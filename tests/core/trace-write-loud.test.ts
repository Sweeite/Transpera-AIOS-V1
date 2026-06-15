/**
 * Issue #11 — WRITE-PATH LOUDNESS ASYMMETRY (watching the watchers). The observability layer's own write
 * failure is the one you can't otherwise see, so neither store may swallow it silently:
 *   • TRACE write failure → LOUD (onError fires) but NON-fatal via the gateway sink (a trace hiccup must not
 *     crash a model call). PROBE: "swallow a trace write silently."
 *   • AUDIT write failure → FATAL (propagates — it's inside the logical change). The asymmetry is the point.
 */
import { describe, it, expect, vi } from 'vitest';
import { emitSpan, gatewayOnSpan, type SpanInput, type ClearanceTag, type SpanContext } from '../../packages/core/src/harness/trace.ts';
import { appendAudit } from '../../packages/core/src/audit/audit-log.ts';
import type { Principal } from '../../packages/shared/src/types.ts';
import type { GatewaySpan } from '../../packages/core/src/harness/gateway.ts';

const principal: Principal = { kind: 'user', userId: 'u1' };
const tag: ClearanceTag = { zone: 'general', sensitivityLevel: 1, namespace: 'org' };
const span: SpanInput = { taskId: 't', principal, trigger: 'chat', kind: 'model', model: 'm', durationMs: 1 };

/** A query that always fails — simulates the trace/audit store hiccupping. */
const failingQuery = async () => {
  throw new Error('db down');
};

describe('trace vs audit write-failure loudness asymmetry (#11)', () => {
  it('emitSpan is LOUD on failure (onError fires) and rethrows for a direct caller', async () => {
    const onError = vi.fn();
    await expect(emitSpan(span, tag, { query: failingQuery, onError })).rejects.toThrow(/db down/);
    expect(onError).toHaveBeenCalledOnce(); // surfaced, never silent
  });

  it('the gateway sink is NON-fatal — a trace write failure never crashes the model call', async () => {
    const onError = vi.fn();
    const ctx: SpanContext = { taskId: 't', principal, trigger: 'chat', contentTag: tag };
    const sink = gatewayOnSpan(ctx, { query: failingQuery, onError });
    const gw: GatewaySpan = { model: 'm', taskClass: 'reason', structured: false, ok: true, durationMs: 1, attempts: 1, costUsd: 0.01 };

    // The sink is void + fire-and-forget: it must NOT throw synchronously.
    expect(() => sink(gw)).not.toThrow();
    // Give the fire-and-forget write a tick to reject + log loud.
    await new Promise((r) => setImmediate(r));
    expect(onError).toHaveBeenCalledOnce();
  });

  it('appendAudit is FATAL on failure — it propagates (inside the logical change)', async () => {
    await expect(appendAudit(failingQuery, { actor: 'u', action: 'a', metadata: {} })).rejects.toThrow(/db down/);
  });
});
