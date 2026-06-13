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

/** Resolve a mention → canonical entity. Unresolved ⇒ caller abstains rather than guesses (§4.10). */
export async function resolveEntity(_mention: string): Promise<CanonicalEntity | null> {
  // TODO: fuzzy match against canonical entities; return null when unresolved.
  throw new Error('TODO: resolveEntity');
}

/** Seed canonical entities from connected SoRs at provisioning (cold-start day-one win, §10.3). */
export async function seedFromConnectors(): Promise<number> {
  // TODO: pull CRM companies/contacts, project-tool projects, accounting customers → mint + mirror ids.
  throw new Error('TODO: seedFromConnectors');
}
