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
 */
export function mayPromoteToSemantic(p: Provenance, corroborated: boolean): boolean {
  return p.trustLevel === 'high' || corroborated;
}

/** Schema + policy checks before an answer or tool-write is committed (§6.7). */
export async function validateOutput(_payload: unknown, _schema: unknown): Promise<boolean> {
  // TODO
  throw new Error('TODO: validateOutput');
}
