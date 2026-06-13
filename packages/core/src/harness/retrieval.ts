/**
 * Hybrid retrieval — Postgres tsvector + pgvector, RRF-fused, fail-closed (PRD §6.4, Brief §4.7).
 * The abstention floor is a CALIBRATED score (reranker target / pre-fusion cosine v1), NOT the RRF sum.
 */
import type { Clearance, Namespace, RetrievalResult } from '@aios/shared';

export interface RetrievalQuery {
  text: string;
  namespaces: Namespace[]; // resolved from context BEFORE retrieval, never post-filtered
  clearance: Clearance; // applied in the SQL predicate before ranking
}

/**
 * Selectivity-aware, fail-closed (§4.7):
 *   1. apply the permission predicate in SQL (zone ∈ allowedZones AND sensitivity ≤ max AND namespace ∈ ns)
 *   2. if the filtered candidate set is SMALL → exact/flat search (perfect recall for restricted users)
 *      else → HNSW iterative scan (+ partial index on the high-traffic `org` zone)
 *   3. RRF fuse keyword+dense → reranker scores top-N → floor check → abstain below `retrieval_min_relevance`
 * NEVER retrieve-then-filter. Same filter for memories AND chunks (§9.1).
 */
export async function retrieve(_q: RetrievalQuery): Promise<RetrievalResult> {
  // TODO: implement selectivity-aware filtered ANN; RRF fusion; reranker floor; cap at retrieval_max_results.
  throw new Error('TODO: retrieve');
}
