/**
 * Configuration as a system (Brief §4.8, PRD §6.11).
 * Every threshold/weight/cadence/floor is a system_config row: gated / scoped / bounded / audited & reversible.
 */
import type { Namespace } from '@aios/shared';
import { appendAudit, type QueryFn, type TxFn } from '../audit/audit-log.js';

export interface ConfigKeySpec {
  key: string;
  default: number | string;
  min?: number;
  max?: number; // bounded — the dials have stops
  qualityAffecting: boolean; // true ⇒ propose→approve flow before it takes effect (gated)
}

/** A few load-bearing keys (full set lives in the DB). */
export const KNOWN_KEYS: ConfigKeySpec[] = [
  // PROVISIONAL (#1): the v1 dense-cosine abstention floor. 0.608 = the openai-3-large@1024/float floor from
  // the SYNTHETIC dry run — an indicative starting value, NOT validated (calibration set == test set on ~30
  // synthetic pairs). Re-derive on real de-identified content at first-client onboarding (#43), and again when
  // the reranker lands (#14 — a different scale). See docs/adr/0001-embedding-model-pin.md.
  { key: 'retrieval_min_relevance', default: 0.608, min: 0.5, max: 0.95, qualityAffecting: true },
  { key: 'retrieval_max_results', default: 20, min: 1, max: 100, qualityAffecting: true },
  { key: 'chunk_ttl_days', default: 90, min: 7, max: 365, qualityAffecting: false },
  // Trace store TTL (#11): a span is debug-held only ephemerally, then auto-pruned (§6.9). Plumbing, not
  // retrieval quality. The prune job (harness/trace.ts) deletes traces past this age; audit_log is FOREVER.
  { key: 'trace_ttl_days', default: 30, min: 1, max: 365, qualityAffecting: false },
  { key: 'decay_min_utility_score', default: 0.2, min: 0, max: 1, qualityAffecting: true },
  { key: 'consolidation_dedup_similarity_threshold', default: 0.92, min: 0.8, max: 0.99, qualityAffecting: true },
  { key: 'consolidation_auto_merge_threshold', default: 0.97, min: 0.9, max: 0.999, qualityAffecting: true },
  { key: 'coldstart_backfill_days', default: 90, min: 0, max: 365, qualityAffecting: false },
  { key: 'latency_budget_ms', default: 8000, min: 1000, max: 30000, qualityAffecting: false },
  { key: 'orchestrator_max_depth', default: 3, min: 1, max: 6, qualityAffecting: false }, // keep delegation trees shallow (§7.3)
  // ── added in audit remediation (config IS correctness, §4.8 — no undeclared thresholds) ──
  { key: 'rrf_k', default: 60, min: 1, max: 100, qualityAffecting: true }, // RRF 1/(k+rank) constant (#13)
  { key: 'exact_search_max_rows', default: 5000, min: 100, max: 50000, qualityAffecting: true }, // selectivity switch: ≤ this → exact, else HNSW (#13)
  { key: 'entity_resolution_min_confidence', default: 0.75, min: 0.5, max: 0.99, qualityAffecting: true }, // below → abstain, never guess the entity (#16, leak risk)
  { key: 'gate3_preclassifier_threshold', default: 0.5, min: 0, max: 1, qualityAffecting: true }, // cheap classifier: below → send to LLM, not auto-drop (#17)
  { key: 'corroboration_similarity_threshold', default: 0.9, min: 0.7, max: 0.99, qualityAffecting: true }, // two low-trust sources corroborate above this (#18)
  { key: 'intent_min_confidence', default: 0.6, min: 0, max: 1, qualityAffecting: true }, // below → clarify-back instead of guessing query/command (#22)
  { key: 'verify_sensitivity_threshold', default: 3, min: 1, max: 5, qualityAffecting: true }, // run provenance verify when cited source sensitivity ≥ this (#24)
  { key: 'trust_constrain_threshold', default: 0.5, min: 0, max: 1, qualityAffecting: true }, // below → agent outputs need approval (#29)
  { key: 'trust_quarantine_threshold', default: 0.2, min: 0, max: 1, qualityAffecting: true }, // below → agent disabled (#29)
  { key: 'embedding_canary_drift_threshold', default: 0.02, min: 0.001, max: 0.2, qualityAffecting: false }, // mean cosine drift over the probe set that trips the alarm (#45)
  { key: 'generation_max_tokens', default: 1024, min: 64, max: 8192, qualityAffecting: false }, // cap on a synthesis call's output (#5 minimal callModel; #10 the single output cap)
  // ── gateway dials (#10) — bounded; no magic numbers in the chokepoint (§4.8). qualityAffecting:false
  //    (plumbing/latency, not retrieval quality). The gateway routes Anthropic tiers, retries, repairs, falls back.
  { key: 'gateway_retry_count', default: 2, min: 0, max: 5, qualityAffecting: false }, // transient/timeout retries per model before fallback
  { key: 'gateway_retry_backoff_ms', default: 250, min: 0, max: 5000, qualityAffecting: false }, // base linear backoff between retries
  { key: 'gateway_repair_attempts', default: 1, min: 0, max: 2, qualityAffecting: false }, // THE audit cap: structured-validation repairs on the primary
  { key: 'gateway_request_timeout_ms', default: 60000, min: 1000, max: 600000, qualityAffecting: false }, // per-call abort timeout
  // Overall wall-clock ceiling across ALL attempts — caps total time so it can't reach N × per-call timeout.
  // DISTINCT from `latency_budget_ms` (8s): that is retrieval's interactive SLO; a single Opus reasoning call can
  // exceed it, so the gateway needs its own headroom (≈ primary timeout + one fallback). A caller wanting a tight
  // interactive budget passes a smaller deadline via the GatewayDeps config seam.
  { key: 'gateway_total_deadline_ms', default: 120000, min: 1000, max: 600000, qualityAffecting: false },
  // The sensitivity ceiling assigned to a DENY / unprovisioned principal (#9). Defense-in-depth ONLY: it is
  // never read while denyAll short-circuits retrievalWhereSql to `false`, so it does not affect retrieval
  // quality (qualityAffecting:false). Default 1 = the LOWEST clearance; raising it widens the fail-closed floor.
  { key: 'rbac_default_max_sensitivity', default: 1, min: 1, max: 5, qualityAffecting: false },
];

/**
 * The DECLARED default for a key — a pure, no-DB resolver. Used until `getConfig()`'s scope-aware DB
 * resolution lands, so callers read a bounded, declared key instead of a literal ("no magic numbers", §4.8).
 *
 * ⚠ CARRY-FORWARD: `getConfig(key, ns, { query })` now does scope-aware DB resolution (client override → org
 *   default → this declared default). A caller migrates to `deps.x ?? await getConfig(key, ns, deps)` ONLY if
 *   it's already async + has a `query` (no flag-day — #8 migrates none; retrieval/gateway/permissions stay on
 *   this sync `defaultFor`). `defaultFor` remains the static fallback and the value getConfig clamps toward.
 *   Throws on an undeclared key — an undeclared threshold is a bug, never a silent 0.
 */
export function defaultFor(key: string): number | string {
  const spec = KNOWN_KEYS.find((k) => k.key === key);
  if (!spec) {
    throw new Error(`unknown config key '${key}' — declare it in KNOWN_KEYS (no undeclared thresholds, §4.8)`);
  }
  return spec.default;
}

/** Why a stored value had to be repaired at READ time — a stored OOB/mistyped value is a bug (direct SQL /
 *  migration), so getConfig clamps/falls-back AND raises this. NEVER swallowed (no-silent-failure red line). */
export interface ConfigAnomaly {
  key: string;
  namespace: Namespace | undefined;
  storedValue: unknown;
  reason: 'out_of_bounds' | 'type_mismatch';
  resolved: number | string; // the safe value getConfig returned instead
}

export interface ConfigDeps {
  query: QueryFn;
  /** The audit append's advisory-lock transaction runner (#11). PROD passes it so config-change audit rows are
   *  serialised on the chain; absent ⇒ the unlocked append path, tolerated only under the test runner. */
  transaction?: TxFn;
  /** READ-path alarm for a stored OOB/mistyped value. Omitted ⇒ a LOUD default (logs to stderr) — never silent. */
  onAnomaly?: (anomaly: ConfigAnomaly) => void;
  /** The code-sourced key specs. Defaults to KNOWN_KEYS; injectable ONLY to simulate a code deploy that changed
   *  bounds (the apply-time re-validation test). NEVER DB-sourced — bounds live in code (§4.8 audit fix). */
  keys?: ConfigKeySpec[];
}

export type ProposeResult =
  | { status: 'applied'; auditId: string } // cosmetic key → took effect immediately
  | { status: 'pending'; proposalId: string }; // quality-affecting → parked until approval

/** The LOUD default alarm. A stored out-of-bounds/mistyped value is a bug — surface it so it's alertable. */
function defaultOnAnomaly(a: ConfigAnomaly): void {
  console.error(
    `[system_config] STORED-VALUE ANOMALY: '${a.key}' (ns=${a.namespace ?? 'org'}) is ${a.reason}: ` +
      `${JSON.stringify(a.storedValue)} → resolved to ${JSON.stringify(a.resolved)}. A stored value outside ` +
      `KNOWN_KEYS bounds means a direct-SQL/migration bug — fix the row (the read was clamped fail-safe).`,
  );
}

/** namespace null/'org' ⇒ the org default row (stored as NULL); any client:/project: scope ⇒ an override row. */
function normNs(namespace: Namespace | undefined): string | null {
  return namespace == null || namespace === 'org' ? null : namespace;
}

function targetRef(key: string, ns: string | null): string {
  return `system_config:${key}:${ns ?? 'org'}`;
}

function specFor(key: string, keys: ConfigKeySpec[]): ConfigKeySpec {
  const spec = keys.find((k) => k.key === key);
  if (!spec) {
    // Undeclared key ⇒ THROW, never a silent 0 — and this fires BEFORE any DB read, so a DB row for an
    // undeclared key (a DB-defined "bound") can never be returned (§4.8 audit fix: DB stores values, not bounds).
    throw new Error(`unknown config key '${key}' — declare it in KNOWN_KEYS (no undeclared thresholds, §4.8)`);
  }
  return spec;
}

/**
 * WRITE-path validation — REJECT loudly, NEVER clamp. A fat-fingered floor of 0.99 on a max-0.95 key is the
 * self-inflicted silent failure the whole issue warns about, so an out-of-bounds write throws (the caller must
 * see it). String keys are type-checked only (no numeric clamp). Re-run at EVERY apply (propose, approve,
 * rollback): code bounds can tighten while a proposal sits pending, and approve must not bypass this guard.
 */
function validateWrite(spec: ConfigKeySpec, value: number | string): void {
  const expected = typeof spec.default; // 'number' | 'string'
  if (typeof value !== expected) {
    throw new Error(`config '${spec.key}': expected ${expected}, got ${typeof value} — REJECTED (no coercion)`);
  }
  if (expected === 'number') {
    const v = value as number;
    if (!Number.isFinite(v)) throw new Error(`config '${spec.key}': ${v} is not a finite number — REJECTED`);
    const min = spec.min ?? -Infinity;
    const max = spec.max ?? Infinity;
    if (v < min || v > max) {
      throw new Error(
        `config '${spec.key}': ${v} is out of bounds [${spec.min}, ${spec.max}] — REJECTED, never clamped (§4.8)`,
      );
    }
  }
}

/** Resolve the stored value at a scope: client/project override → org default. undefined ⇒ no row at all. */
async function resolveStored(query: QueryFn, key: string, ns: string | null): Promise<unknown | undefined> {
  const { rows } = await query(
    `SELECT namespace, value FROM system_config WHERE key = $1 AND (namespace IS NOT DISTINCT FROM $2 OR namespace IS NULL)`,
    [key, ns],
  );
  if (rows.length === 0) return undefined;
  const override = ns !== null ? rows.find((r) => r.namespace === ns) : undefined;
  const org = rows.find((r) => r.namespace === null);
  const chosen = override ?? org;
  return chosen ? chosen.value : undefined;
}

/**
 * Resolution order: client/project override → org default → the DECLARED default (§4.8). The key is validated
 * against KNOWN_KEYS (code) FIRST — an undeclared key throws before any DB read. A stored value that is somehow
 * out of bounds or the wrong type is clamped / falls back to the default AND raises an alarm (defense in depth).
 */
export async function getConfig(
  key: string,
  namespace: Namespace | undefined,
  deps: ConfigDeps,
): Promise<number | string> {
  const spec = specFor(key, deps.keys ?? KNOWN_KEYS);
  const stored = await resolveStored(deps.query, key, normNs(namespace));
  if (stored === undefined) return spec.default; // no row ⇒ declared default (in-bounds by construction)

  const onAnomaly = deps.onAnomaly ?? defaultOnAnomaly;
  if (typeof spec.default === 'number') {
    if (typeof stored !== 'number' || !Number.isFinite(stored)) {
      onAnomaly({ key, namespace, storedValue: stored, reason: 'type_mismatch', resolved: spec.default });
      return spec.default;
    }
    const min = spec.min ?? -Infinity;
    const max = spec.max ?? Infinity;
    if (stored < min || stored > max) {
      const clamped = Math.min(Math.max(stored, min), max);
      onAnomaly({ key, namespace, storedValue: stored, reason: 'out_of_bounds', resolved: clamped });
      return clamped;
    }
    return stored;
  }
  // string key — type-check only, no clamp
  if (typeof stored !== 'string') {
    onAnomaly({ key, namespace, storedValue: stored, reason: 'type_mismatch', resolved: spec.default });
    return spec.default;
  }
  return stored;
}

/** Upsert one scoped value (NULL-safe on namespace via IS NOT DISTINCT FROM, so the org row updates in place). */
async function upsertValue(
  query: QueryFn,
  key: string,
  ns: string | null,
  value: number | string,
  updatedBy: string | null,
): Promise<void> {
  const updated = await query(
    `UPDATE system_config SET value = $3::jsonb, updated_at = now(), updated_by = $4
       WHERE key = $1 AND namespace IS NOT DISTINCT FROM $2 RETURNING key`,
    [key, ns, JSON.stringify(value), updatedBy],
  );
  if (updated.rows.length === 0) {
    await query(
      `INSERT INTO system_config (key, namespace, value, updated_by) VALUES ($1, $2, $3::jsonb, $4)`,
      [key, ns, JSON.stringify(value), updatedBy],
    );
  }
}

/**
 * Propose a config change. Out-of-bounds/typed/undeclared ⇒ REJECT (throws) before anything is written.
 * A qualityAffecting:false key applies instantly + is audited. A qualityAffecting:true key is parked in
 * `config_proposals` (one open proposal per key/namespace — a duplicate is rejected) and does NOT take effect
 * until `approveConfigChange`. `getConfig` reads `system_config` only, so a pending change is invisible to it.
 */
export async function proposeConfigChange(
  key: string,
  value: number | string,
  evidence: string,
  deps: ConfigDeps,
  opts: { namespace?: Namespace; actor?: string } = {},
): Promise<ProposeResult> {
  const spec = specFor(key, deps.keys ?? KNOWN_KEYS);
  validateWrite(spec, value); // loud reject — never clamp a write
  const ns = normNs(opts.namespace);
  const actor = opts.actor ?? null;

  if (!spec.qualityAffecting) {
    const old = await getConfig(key, opts.namespace, deps);
    await upsertValue(deps.query, key, ns, value, actor);
    const audit = await appendAudit(deps.query, {
      actor,
      action: 'config.applied',
      targetRef: targetRef(key, ns),
      metadata: { key, namespace: ns, old, new: value, via: 'instant' },
    }, { transaction: deps.transaction });
    return { status: 'applied', auditId: audit.id };
  }

  // One OPEN proposal per (key, namespace): reject a duplicate (the partial unique index is the race backstop).
  const open = await deps.query(
    `SELECT id FROM config_proposals WHERE key = $1 AND COALESCE(namespace, '') = COALESCE($2, '') AND status = 'pending'`,
    [key, ns],
  );
  if (open.rows.length > 0) {
    throw new Error(
      `config '${key}' (ns=${ns ?? 'org'}) already has an open proposal — approve or reject it first ` +
        `(one open proposal per key/namespace, §4.8 audit fix)`,
    );
  }
  const current = await getConfig(key, opts.namespace, deps);
  let inserted: { rows: any[] };
  try {
    inserted = await deps.query(
      `INSERT INTO config_proposals (key, namespace, current_value, proposed_value, evidence, status, created_by)
       VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, 'pending', $6) RETURNING id`,
      [key, ns, JSON.stringify(current), JSON.stringify(value), evidence, actor],
    );
  } catch (cause) {
    throw new Error(`config '${key}' (ns=${ns ?? 'org'}): a concurrent open proposal exists — REJECTED`, { cause });
  }
  const proposalId = String(inserted.rows[0].id);
  await appendAudit(deps.query, {
    actor,
    action: 'config.proposed',
    targetRef: targetRef(key, ns),
    metadata: { key, namespace: ns, old: current, new: value, proposalId },
  }, { transaction: deps.transaction });
  return { status: 'pending', proposalId };
}

/** Approve a pending proposal → it takes effect. RE-VALIDATES against the CURRENT code bounds (which may have
 *  tightened since propose) so approval can never bypass the write-reject guard. Audited (old→new). */
export async function approveConfigChange(
  proposalId: string,
  deps: ConfigDeps,
  opts: { approver?: string } = {},
): Promise<{ auditId: string }> {
  const { rows } = await deps.query(
    `SELECT key, namespace, proposed_value, status FROM config_proposals WHERE id = $1`,
    [proposalId],
  );
  if (rows.length === 0) throw new Error(`config proposal ${proposalId} not found`);
  const p = rows[0];
  if (p.status !== 'pending') throw new Error(`config proposal ${proposalId} is '${p.status}', not pending`);

  const spec = specFor(p.key, deps.keys ?? KNOWN_KEYS);
  const value = p.proposed_value as number | string;
  validateWrite(spec, value); // re-validate at APPLY — bounds can tighten while a proposal sits pending
  const ns: string | null = p.namespace ?? null;
  const old = await getConfig(p.key, (ns ?? undefined) as Namespace | undefined, deps);
  await upsertValue(deps.query, p.key, ns, value, opts.approver ?? null);
  await deps.query(
    `UPDATE config_proposals SET status = 'approved', resolved_at = now(), resolved_by = $2 WHERE id = $1`,
    [proposalId, opts.approver ?? null],
  );
  const audit = await appendAudit(deps.query, {
    actor: opts.approver ?? null,
    action: 'config.applied',
    targetRef: targetRef(p.key, ns),
    metadata: { key: p.key, namespace: ns, old, new: value, proposalId, via: 'approval' },
  }, { transaction: deps.transaction });
  return { auditId: audit.id };
}

/** Reject a pending proposal — the escape hatch that keeps one-open-per-key from deadlocking on a bad proposal
 *  (a fat-fingered pending change can be cleared WITHOUT applying it). Audited. */
export async function rejectConfigChange(
  proposalId: string,
  deps: ConfigDeps,
  opts: { rejecter?: string } = {},
): Promise<void> {
  const { rows } = await deps.query(
    `SELECT key, namespace, proposed_value, status FROM config_proposals WHERE id = $1`,
    [proposalId],
  );
  if (rows.length === 0) throw new Error(`config proposal ${proposalId} not found`);
  const p = rows[0];
  if (p.status !== 'pending') throw new Error(`config proposal ${proposalId} is '${p.status}', not pending`);
  await deps.query(
    `UPDATE config_proposals SET status = 'rejected', resolved_at = now(), resolved_by = $2 WHERE id = $1`,
    [proposalId, opts.rejecter ?? null],
  );
  await appendAudit(deps.query, {
    actor: opts.rejecter ?? null,
    action: 'config.rejected',
    targetRef: targetRef(p.key, p.namespace ?? null),
    metadata: { key: p.key, namespace: p.namespace ?? null, proposed: p.proposed_value, proposalId },
  }, { transaction: deps.transaction });
}

/** Applied-value audit actions — the only entries a rollback may target (see rollbackConfig). */
const APPLIED_ACTIONS = new Set(['config.applied', 'config.rolled_back']);

/**
 * Roll a config change back FROM the audit log: restore the prior value recorded on an APPLIED audit entry, and
 * audit the rollback itself (it's a change too). Refuses any entry that is not an applied change (e.g. a mere
 * 'config.proposed') — so a rollback can only restore a previously-APPLIED value, never inject one that was
 * never approved. Re-validates the restored value against current bounds (apply-time guard).
 */
export async function rollbackConfig(
  auditId: string,
  deps: ConfigDeps,
  opts: { actor?: string } = {},
): Promise<{ auditId: string }> {
  const { rows } = await deps.query(`SELECT action, metadata FROM audit_log WHERE id = $1`, [auditId]);
  if (rows.length === 0) throw new Error(`audit entry ${auditId} not found`);
  const entry = rows[0];
  if (!APPLIED_ACTIONS.has(entry.action)) {
    throw new Error(
      `audit ${auditId} is '${entry.action}', not an applied change — cannot roll back (would inject a ` +
        `never-applied value)`,
    );
  }
  const meta = (entry.metadata ?? {}) as Record<string, unknown>;
  const key = meta.key;
  const ns: string | null = (meta.namespace as string | null) ?? null;
  const restore = meta.old;
  if (typeof key !== 'string') throw new Error(`audit ${auditId} is not a config change (no key)`);
  if (restore === undefined || restore === null) throw new Error(`audit ${auditId} has no prior value to restore`);

  const spec = specFor(key, deps.keys ?? KNOWN_KEYS);
  validateWrite(spec, restore as number | string); // re-validate — the prior value must still be in bounds
  const current = await getConfig(key, (ns ?? undefined) as Namespace | undefined, deps);
  await upsertValue(deps.query, key, ns, restore as number | string, opts.actor ?? null);
  const audit = await appendAudit(deps.query, {
    actor: opts.actor ?? null,
    action: 'config.rolled_back',
    targetRef: targetRef(key, ns),
    metadata: { key, namespace: ns, old: current, new: restore, revertOf: auditId },
  }, { transaction: deps.transaction });
  return { auditId: audit.id };
}
