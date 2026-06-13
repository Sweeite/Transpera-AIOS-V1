/**
 * RBAC — fail-closed authorization (Brief §9, PRD). The highest-stakes correctness property in the system.
 * Layer 2 of the three-layer separation model (§8.2): within-client user isolation, logical.
 */
import type { Clearance, Namespace, Principal, SensitivityLevel, Zone } from '@aios/shared';

/** Resolve a user's clearance. Lives in the engine's authz layer, never Supabase Auth (§8.1a). */
export async function getClearance(_principal: Principal): Promise<Clearance> {
  // TODO: role defaults + per-user overrides; empty allowedZones ⇒ sees nothing (fail-closed).
  throw new Error('TODO: getClearance');
}

/** The retrieval predicate (applied in SQL BEFORE ranking; same for memories and chunks, §9.1). */
export function buildRetrievalPredicate(c: Clearance, namespaces: Namespace[]): {
  zones: Zone[];
  maxSensitivity: SensitivityLevel;
  namespaces: Namespace[];
} {
  return { zones: c.allowedZones, maxSensitivity: c.maxSensitivity, namespaces };
}

/** Action authorization = intersection(agent allowed tools, principal permissions) (§9.2). */
export function canPerformAction(_principal: Principal, _toolName: string, _allowedTools: string[]): boolean {
  // TODO: external-irreversible actions also require a confirmation gate at the call site (§9.2).
  throw new Error('TODO: canPerformAction');
}
