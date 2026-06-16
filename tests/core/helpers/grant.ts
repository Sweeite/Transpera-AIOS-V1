/**
 * Test helpers for retrieve()'s #13 trust boundary. retrieve() now REQUIRES a principal and derives the
 * permission predicate from its clearance — there is no caller-supplied predicate. Tests that exercise
 * ranking/abstention (not permissions) inject a broad clearance via `grantAll`; tests that need `WHERE false`
 * inject `grantNothing` (an empty clearance) — the honest way to hit the fail-closed path now that the raw
 * `predicate: 'false'` seam is gone.
 */
import type { Clearance, Namespace, Principal, Zone } from '../../../packages/shared/src/types.ts';

const ALL_ZONES: Zone[] = ['general', 'finance', 'hr', 'legal', 'exec'];
const ALL_NS: Namespace[] = ['org', 'client:acme', 'project:atlas'];

export const TEST_USER: Principal = { kind: 'user', userId: 'test-grant' };

/** A deps fragment that GRANTS broad retrieval access (clearance injected — no user_clearance row needed). */
export function grantAll(over: Partial<Clearance> = {}): { principal: Principal; getClearance: () => Promise<Clearance> } {
  const c: Clearance = { allowedZones: ALL_ZONES, maxSensitivity: 5, allowedNamespaces: ALL_NS, ...over };
  return { principal: TEST_USER, getClearance: async () => c };
}

/** A deps fragment that GRANTS nothing — empty clearance ⇒ denyAll ⇒ `WHERE false` (fail-closed path). */
export function grantNothing(): { principal: Principal; getClearance: () => Promise<Clearance> } {
  const c: Clearance = { allowedZones: [], maxSensitivity: 5, allowedNamespaces: [] };
  return { principal: TEST_USER, getClearance: async () => c };
}
