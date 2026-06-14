/**
 * Configuration as a system (Brief §4.8, PRD §6.11).
 * Every threshold/weight/cadence/floor is a system_config row: gated / scoped / bounded / audited & reversible.
 */
import type { Namespace } from '@aios/shared';

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
  { key: 'generation_max_tokens', default: 1024, min: 64, max: 8192, qualityAffecting: false }, // cap on a synthesis call's output (#5 minimal callModel; #10 may route per TaskClass)
  // The sensitivity ceiling assigned to a DENY / unprovisioned principal (#9). Defense-in-depth ONLY: it is
  // never read while denyAll short-circuits retrievalWhereSql to `false`, so it does not affect retrieval
  // quality (qualityAffecting:false). Default 1 = the LOWEST clearance; raising it widens the fail-closed floor.
  { key: 'rbac_default_max_sensitivity', default: 1, min: 1, max: 5, qualityAffecting: false },
];

/**
 * The DECLARED default for a key — a pure, no-DB resolver. Used until `getConfig()`'s scope-aware DB
 * resolution lands, so callers read a bounded, declared key instead of a literal ("no magic numbers", §4.8).
 *
 * ⚠ CARRY-FORWARD: when `getConfig()` is implemented, callers switch to `deps.x ?? await getConfig(key, ns)`
 *   (client override → org default); `defaultFor` remains the static fallback and the value getConfig clamps
 *   toward. Throws on an undeclared key — an undeclared threshold is a bug, never a silent 0.
 */
export function defaultFor(key: string): number | string {
  const spec = KNOWN_KEYS.find((k) => k.key === key);
  if (!spec) {
    throw new Error(`unknown config key '${key}' — declare it in KNOWN_KEYS (no undeclared thresholds, §4.8)`);
  }
  return spec.default;
}

/** Resolution order: client override → org default (§4.8). Range-validated. */
export async function getConfig(_key: string, _namespace?: Namespace): Promise<number | string> {
  // TODO: read system_config with scope resolution; clamp to bounds. Until then, `defaultFor(key)` above
  // gives the static declared default (no DB).
  throw new Error('TODO: getConfig');
}

/** Quality-affecting changes go through propose→approve; every change is an audited, reversible event. */
export async function proposeConfigChange(_key: string, _value: number | string, _evidence: string): Promise<void> {
  // TODO
  throw new Error('TODO: proposeConfigChange');
}
