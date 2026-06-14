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

/**
 * The retrieval predicate (applied in SQL BEFORE ranking; same for memories and chunks, §9.1).
 *
 * FAIL-OPEN TRAP (the worst leak, §3.2): an EMPTY `allowedZones` must compile to `WHERE false`,
 * NEVER an empty `zone IN ()` — that's a Postgres syntax error, and an ORM that silently drops an
 * empty IN clause returns EVERYTHING. The SQL builder MUST special-case the empty list. (#9)
 */
export function buildRetrievalPredicate(c: Clearance, namespaces: Namespace[]): {
  zones: Zone[];
  maxSensitivity: SensitivityLevel;
  namespaces: Namespace[];
  denyAll: boolean; // true ⇒ emit `WHERE false`; the query layer must honour this before any IN clause
} {
  return {
    zones: c.allowedZones,
    maxSensitivity: c.maxSensitivity,
    namespaces,
    denyAll: c.allowedZones.length === 0 || namespaces.length === 0,
  };
}

/**
 * Compile a retrieval predicate into a parameterised SQL WHERE fragment — the ONE filter applied
 * identically to `memories` AND `chunks` (§9.1). It references columns only (no table name), so the same
 * fragment slots into `FROM memories WHERE …` and `FROM chunks WHERE …` — that identity is the leak guard.
 *
 * FAIL-OPEN TRAP (§3.2, #9): `denyAll` ⇒ literal `false`. We use `= ANY($n)` (not `IN (…)`) so an empty
 * list could never silently widen to "everything"; `denyAll` already short-circuits before we get there,
 * but ANY keeps the floor doubly safe. Parameters are 1-indexed from `startParam` (default 1).
 */
export function retrievalWhereSql(
  pred: ReturnType<typeof buildRetrievalPredicate>,
  startParam = 1,
): { sql: string; params: unknown[] } {
  if (pred.denyAll) return { sql: 'false', params: [] };
  const [z, s, n] = [startParam, startParam + 1, startParam + 2];
  return {
    sql: `zone = ANY($${z}) AND sensitivity_level <= $${s} AND namespace = ANY($${n})`,
    params: [pred.zones, pred.maxSensitivity, pred.namespaces],
  };
}

/** Action authorization = intersection(agent allowed tools, principal permissions) (§9.2). */
export function canPerformAction(_principal: Principal, _toolName: string, _allowedTools: string[]): boolean {
  // TODO: external-irreversible actions also require a confirmation gate at the call site (§9.2).
  throw new Error('TODO: canPerformAction');
}
