/**
 * Embedding bake-off candidates (Issue #1 — the #1 one-way door, Brief §4.7 / tech-stack §5.5).
 *
 * A "candidate" is the FULL shippable representation, not just a model name. Three knobs are each a
 * one-way door once a client's corpus is embedded:
 *   - model      → the vector space itself (§4.7: never cost-route, never mix spaces).
 *   - dim (N)    → vector(N) + the HNSW index are fixed at DDL time; changing N = full re-embed.
 *                  (Addition #1 — hand the chosen N to #2 for vector(N).) OpenAI 3-large + Voyage
 *                  3-large support dimension reduction; Cohere v3 is fixed at 1024.
 *   - dtype      → quantization. We CALIBRATE THE FLOOR ON WHAT WE SHIP (addition #3): if an int8
 *                  variant wins, its cosine distribution differs from float, so the floor is derived
 *                  on the int8 vectors, not float.
 *   - multilingual → a selection criterion only if a client will have non-English content
 *                    (addition #4). Default assumption: English-v1 (documented in ADR 0001).
 *
 * Each variant is scored independently so the dimension/quantization trade (quality vs HNSW RAM,
 * tech-stack §5.2 #4) is a conscious, recorded call — not a default.
 */

export type Vendor = 'voyage' | 'openai' | 'cohere';
export type Dtype = 'float' | 'int8' | 'binary';

export interface Candidate {
  id: string; // stable label used in the results table + ADR
  vendor: Vendor;
  model: string;
  dim: number; // the N that becomes vector(N) in #2
  dtype: Dtype; // the representation we'd actually ship (floor calibrated on THIS)
  multilingual: boolean;
  /** Voyage/Cohere want distinct doc vs query input types (asymmetric embeddings → better retrieval). */
  asymmetric: boolean;
  notes?: string;
}

/**
 * The default roster. Trim to 2 if a vendor is disqualified up front on price/stability (issue allows 2–3).
 * Exact model strings are confirmed at spike time; quantized + dim variants are added per-vendor so the
 * one-way doors are measured, not assumed. Bias on a near-tie → stable, well-priced (the issue's Watch note).
 */
export const CANDIDATES: Candidate[] = [
  // ── Voyage — quality front-runner; supports output_dimension + output_dtype (covers BOTH one-way doors) ──
  { id: 'voyage-3-large@1024/float', vendor: 'voyage', model: 'voyage-3-large', dim: 1024, dtype: 'float', multilingual: true, asymmetric: true },
  { id: 'voyage-3-large@1024/int8', vendor: 'voyage', model: 'voyage-3-large', dim: 1024, dtype: 'int8', multilingual: true, asymmetric: true, notes: 'int8: 4× smaller index (HNSW RAM, §5.2 #4); floor calibrated on int8' },

  // ── OpenAI — the stability anchor (wins ties, Watch note); dimension-reducible via `dimensions` ──
  { id: 'openai-3-large@3072/float', vendor: 'openai', model: 'text-embedding-3-large', dim: 3072, dtype: 'float', multilingual: true, asymmetric: false, notes: 'full dim — highest quality, heaviest index' },
  { id: 'openai-3-large@1024/float', vendor: 'openai', model: 'text-embedding-3-large', dim: 1024, dtype: 'float', multilingual: true, asymmetric: false, notes: 'reduced dim — RAM/quality trade for #2' },

  // NB: Cohere dropped from this run (no COHERE_API_KEY supplied). Re-add { vendor:'cohere', model:'embed-english-v3.0',
  //     dim:1024, dtype:'int8', asymmetric:true } — or embed-multilingual-v3.0 if a client needs non-English (#4) — when a key is available.
];
