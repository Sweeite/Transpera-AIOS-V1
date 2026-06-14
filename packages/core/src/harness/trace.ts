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
  // Tamper-evidence (#11) = a HASH CHAIN, not just append-only: each row stores prev_hash = H(prev row),
  // so a rewritten row breaks the chain (append-only alone doesn't stop a superuser rewrite). A verify-chain
  // check is a test + a periodic job. Permission changes are the highest-value class.
  // TODO: compute row hash over (actor, action, refs, prev_hash); persist; expose verifyChain().
  throw new Error('TODO: auditEvent');
}
