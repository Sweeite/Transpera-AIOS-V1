/**
 * Issue #11 — emitSpan writes a span to the TRACE store with its clearance tag. The acceptance: a model/tool/
 * retrieval call emits a span. The tag (zone+sensitivity+namespace) is persisted at write — the column exists
 * so a future read (#37/#32) can filter it exactly like memories/chunks.
 */
import { describe, it, expect } from 'vitest';
import { freshDb } from './helpers/pglite.ts';
import { emitSpan, type SpanInput, type ClearanceTag } from '../../packages/core/src/harness/trace.ts';
import type { Principal } from '../../packages/shared/src/types.ts';

const principal: Principal = { kind: 'user', userId: 'u1' };
const tag: ClearanceTag = { zone: 'finance', sensitivityLevel: 3, namespace: 'org' };

describe('emitSpan — trace store write (#11)', () => {
  it.each(['model', 'tool', 'retrieval'] as const)('emits a %s span with the clearance tag persisted', async (kind) => {
    const { query } = await freshDb();
    const span: SpanInput = {
      taskId: '00000000-0000-0000-0000-000000000001',
      principal,
      trigger: 'chat',
      kind,
      model: kind === 'model' ? 'claude-haiku-4-5-20251001' : undefined,
      durationMs: 42,
      costUsd: 0.0012,
      tokensIn: 100,
      tokensOut: 20,
    };
    const id = await emitSpan(span, tag, { query });
    expect(id).toBeTruthy();

    const row = (await query(`SELECT kind, zone, sensitivity_level, namespace, duration_ms, cost_usd FROM traces WHERE id = $1`, [id])).rows[0];
    expect(row.kind).toBe(kind);
    expect(row.zone).toBe('finance');
    expect(row.sensitivity_level).toBe(3);
    expect(row.namespace).toBe('org');
    expect(row.duration_ms).toBe(42);
  });
});
