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
  { key: 'retrieval_min_relevance', default: 0.72, min: 0.5, max: 0.95, qualityAffecting: true },
  { key: 'retrieval_max_results', default: 20, min: 1, max: 100, qualityAffecting: true },
  { key: 'chunk_ttl_days', default: 90, min: 7, max: 365, qualityAffecting: false },
  { key: 'decay_min_utility_score', default: 0.2, min: 0, max: 1, qualityAffecting: true },
  { key: 'consolidation_dedup_similarity_threshold', default: 0.92, min: 0.8, max: 0.99, qualityAffecting: true },
  { key: 'consolidation_auto_merge_threshold', default: 0.97, min: 0.9, max: 0.999, qualityAffecting: true },
  { key: 'coldstart_backfill_days', default: 90, min: 0, max: 365, qualityAffecting: false },
  { key: 'latency_budget_ms', default: 8000, min: 1000, max: 30000, qualityAffecting: false },
  { key: 'orchestrator_max_depth', default: 3, min: 1, max: 6, qualityAffecting: false }, // keep delegation trees shallow (§7.3)
];

/** Resolution order: client override → org default (§4.8). Range-validated. */
export async function getConfig(_key: string, _namespace?: Namespace): Promise<number | string> {
  // TODO: read system_config with scope resolution; clamp to bounds.
  throw new Error('TODO: getConfig');
}

/** Quality-affecting changes go through propose→approve; every change is an audited, reversible event. */
export async function proposeConfigChange(_key: string, _value: number | string, _evidence: string): Promise<void> {
  // TODO
  throw new Error('TODO: proposeConfigChange');
}
