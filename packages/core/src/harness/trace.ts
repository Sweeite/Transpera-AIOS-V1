/**
 * Tracing & cost accounting (PRD §6.9). Every model/tool/retrieval call emits a structured span.
 * Powers activity log, cost monitor, quality monitor.
 *
 * Two stores, different rules (§6.9, §11.10):
 *   - audit log: references + actions only, append-only, long retention.
 *   - traces: MAY include content for debugging, but short-TTL, permission-scoped, never exported, auto-pruned.
 */
import type { TraceSpan } from '@aios/shared';

export async function emitSpan(_span: TraceSpan): Promise<void> {
  // TODO: write to the per-client traces store with a TTL + clearance tag.
  throw new Error('TODO: emitSpan');
}

export async function auditEvent(_event: {
  actor: string;
  action: string;
  refs: string[]; // NEVER content (§11.10)
  before?: unknown;
  after?: unknown;
}): Promise<void> {
  // TODO: append-only, tamper-evident; permission changes are the highest-value class.
  throw new Error('TODO: auditEvent');
}
