/**
 * Guardrails (PRD §6.7). Injection defence, anti-poisoning, output validation, PII/confidentiality.
 */
import type { Provenance } from '@aios/shared';

/** Flag/quarantine instruction-shaped content in ingested material; never execute it (§6.7). */
export function scanForInjection(_content: string): { flagged: boolean; reason?: string } {
  // TODO
  return { flagged: false };
}

/**
 * Anti-poisoning (§5, §10.1): low-trust source content may be indexed-in-place but may NOT auto-promote
 * to semantic memory without corroboration OR human review. Stops provenance laundering injected content.
 *
 * NB: `Provenance.trustLevel` MUST be stamped at routing time from the connection's `trust_level`
 * (connectors/adapter.ts `meta.defaultTrust`) — if routing forgets, this silently defaults wrong (#17).
 */
export function mayPromoteToSemantic(p: Provenance, corroborated: boolean): boolean {
  return p.trustLevel === 'high' || corroborated;
}

/**
 * Corroboration is the SAME cross-source semantic-match primitive as consolidation dedup (§4.5) — share it,
 * don't build two. A candidate is corroborated if a DIFFERENT source asserts a semantically-matching fact
 * above `corroboration_similarity_threshold`. (#18 — was previously taken as a bare boolean input.)
 */
export async function corroborate(_candidateStatement: string, _excludeSourceRef: string): Promise<boolean> {
  // TODO: embed candidate → similarity search over active memories from OTHER sources → compare to threshold.
  throw new Error('TODO: corroborate');
}

/** Schema + policy checks before an answer or tool-write is committed (§6.7). */
export async function validateOutput(_payload: unknown, _schema: unknown): Promise<boolean> {
  // TODO
  throw new Error('TODO: validateOutput');
}
