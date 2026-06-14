/**
 * Identity Map — entity resolution, used on BOTH the write path (namespace derivation, §4.3)
 * and the read path (federated live fetch, §4.10). Promoted to a first-class core component.
 *
 * Canonical ids are owned INTERNALLY; per-SoR ids are MIRRORED. "SoR wins" governs field VALUES, not identity.
 */
import type { Namespace } from '@aios/shared';

export type EntityKind = 'client' | 'project' | 'person' | 'vendor';

export interface CanonicalEntity {
  id: string; // minted internally
  kind: EntityKind;
  namespace: Namespace;
  displayName: string;
  externalIds: Record<string, string>; // { ghl: 'contact_123', xero: 'cust_456', asana: 'proj_789' }
}

export interface ResolveResult {
  entity: CanonicalEntity;
  confidence: number; // 0..1
}

/**
 * Resolve a mention → canonical entity (federation decision D1). Signature carries the context and returns
 * the confidence the spec requires — the bare `(mention) => entity` form could not implement its own rule.
 * Method: deterministic/alias match → embedding similarity, BOOSTED by `namespaceHint`. Below
 * `entity_resolution_min_confidence` → return null so the caller ABSTAINS. A wrong entity is a cross-client
 * leak risk — NEVER guess (§4.10).
 */
export async function resolveEntity(_args: {
  mention: string;
  namespaceHint?: Namespace;
}): Promise<ResolveResult | null> {
  // TODO: deterministic → similarity (namespace-boosted) → confidence floor → null below floor.
  throw new Error('TODO: resolveEntity');
}

/**
 * Seed canonical entities from connected SoRs at provisioning (cold-start day-one win, §10.3).
 * Cross-SoR merge: GHL "Acme Corp" and Xero "Acme Corporation" must collapse to ONE canonical id — use the
 * SAME similarity+floor primitive as read-time resolution (don't build a second matcher). Below floor → keep
 * separate + flag for review rather than wrongly merge. (#16)
 */
export async function seedFromConnectors(): Promise<number> {
  // TODO: pull CRM companies/contacts, project-tool projects, accounting customers → mint + merge + mirror ids.
  throw new Error('TODO: seedFromConnectors');
}
