/**
 * RBAC — fail-closed authorization (Brief §9, PRD). The highest-stakes correctness property in the system.
 * Layer 2 of the three-layer separation model (§8.2): within-client user isolation, logical.
 */
import type { Clearance, Namespace, Principal, SensitivityLevel, Zone } from '@aios/shared';
import { defaultFor } from '../config/system-config.js';

/** Coerce a Postgres array column to a typed string[] — a NULL or non-array (malformed) value ⇒ [] (fail-closed:
 *  an absent grant must read as deny, never as the absence of a filter). Used for both authorization axes. */
function asStringArray<T extends string>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

/**
 * Minimal DB executor — matches both pglite (tests) and the real pooled connection (#7 wires getDb()).
 * Defined LOCALLY (not imported from the harness) so the security layer never depends on the harness layer.
 */
export type QueryFn = (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>;

/**
 * The fail-closed clearance: NO zones (⇒ `denyAll` downstream ⇒ `WHERE false`) + the LOWEST sensitivity
 * ceiling. The empty zone list is the operative deny; the floor is defense-in-depth — it is never read while
 * denyAll short-circuits retrievalWhereSql, but if that guard were ever bypassed the ceiling is the most
 * restrictive, never the most permissive. The floor is a bounded `system_config` key, not a literal (§4.8, #9).
 */
function denyClearance(): Clearance {
  return {
    allowedZones: [],
    maxSensitivity: defaultFor('rbac_default_max_sensitivity') as SensitivityLevel,
    allowedNamespaces: [], // the namespace axis denies too (empty ⇒ denyAll) — fail-closed on all three axes (#13)
  };
}

/**
 * Resolve a principal's clearance — the engine's authz layer, never Supabase Auth (§8.1a). Feeds the EXISTING
 * predicate (below); does not reshape it. EVERY branch leans deny (Brief §9.1, §3.2 — the worst leak).
 *
 * RUNTIME default-deny: a Principal is parsed from API/queue payloads at runtime, so a forged, unknown, or
 * undefined `kind` must hit the `default` arm and deny — we never lean on TS exhaustiveness for a security
 * boundary (#9). The `default` and `service` arms deny WITHOUT touching the DB: no ambient authority, and a
 * serviceId that happens to equal a userId can never inherit that user's row.
 */
export async function getClearance(principal: Principal, deps: { query: QueryFn }): Promise<Clearance> {
  switch (principal?.kind) {
    case 'user':
      return resolveUserClearance(principal.userId, deps);
    case 'service':
      // Denies the RETRIEVAL predicate (sees nothing via memories/chunks). A service principal still holds ORG
      // connections for ingestion (Principal, §7.5) — this denies the retrieval axis only, NOT "no access on
      // any axis". A real service-clearance mechanism lands later (#6/#26); until then, fail closed and never
      // read user_clearance (so the same-id-string case below cannot leak).
      return denyClearance();
    default:
      return denyClearance();
  }
}

/** Read the already-materialised effective clearance row. MISSING row ⇒ deny (never a role fallback — an
 *  unprovisioned user must see nothing, not inherit a role default; role→clearance is provisioning-time, #9). */
async function resolveUserClearance(userId: string, deps: { query: QueryFn }): Promise<Clearance> {
  let rows: any[];
  try {
    ({ rows } = await deps.query(
      `SELECT allowed_zones, max_sensitivity, allowed_namespaces FROM user_clearance WHERE principal_id = $1`,
      [userId],
    ));
  } catch (cause) {
    // ERROR PATH is FAIL-CLOSED *and* SURFACED (red line: no silent failure). A DB error must NEVER fall
    // through into a populated — or any — clearance; throw so the caller's trace span records it and it is
    // alertable. Swallowing into a deny would also be wrong here (it hides an outage as a permission state).
    throw new Error('getClearance: user_clearance lookup failed — failing closed (no clearance granted)', { cause });
  }

  // A resolved-but-malformed result (no array) is not an outage to surface — deny, don't throw. An absent
  // row is THE leak shape: an unprovisioned principal must see nothing.
  if (!Array.isArray(rows) || rows.length === 0) return denyClearance();
  const row = rows[0];

  // Empty allowed_zones ('{}') passes straight through ⇒ denyAll downstream (explicit, audited empty state).
  const allowedZones = asStringArray<Zone>(row.allowed_zones);
  // Namespace AUTHORIZATION (#13): NULL (pre-#13 / never provisioned) or '{}' ⇒ [] ⇒ denyAll. Same fail-closed
  // shape as zones — an absent namespace grant is deny, never "no namespace filter".
  const allowedNamespaces = asStringArray<Namespace>(row.allowed_namespaces);
  const max = Number(row.max_sensitivity);
  // Defense in depth: the DB CHECK bounds 1..5, but never trust a row that somehow falls outside it — deny.
  if (!Number.isInteger(max) || max < 1 || max > 5) return denyClearance();
  return { allowedZones, maxSensitivity: max as SensitivityLevel, allowedNamespaces };
}

/**
 * The retrieval predicate (applied in SQL BEFORE ranking; same for memories and chunks, §9.1).
 *
 * FAIL-OPEN TRAP (the worst leak, §3.2): an EMPTY `allowedZones` must compile to `WHERE false`,
 * NEVER an empty `zone IN ()` — that's a Postgres syntax error, and an ORM that silently drops an
 * empty IN clause returns EVERYTHING. The SQL builder MUST special-case the empty list. (#9)
 *
 * ⚠ FORWARD FLAG (#13 DoD, not #9): `namespaces` arrives ALREADY-AUTHORIZED. Clearance carries only zones +
 * sensitivity — there is no owner yet for namespace AUTHORIZATION ("may this principal see `client:acme`?").
 * Before #13 wires retrieve() live, that authorization must exist; passing an unfiltered namespaces array
 * here would be a namespace leak. getClearance() does NOT resolve namespaces.
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
