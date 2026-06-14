/**
 * Dense retrieval + abstention — the READ half of the M0 tracer (Issue #4, Brief §4.7, §6).
 *
 * v1 is DENSE-ONLY: embed the query through the gateway chokepoint, cosine-rank `memories`, and either
 * return the best candidate ABOVE the floor or ABSTAIN + log a miss. Abstention is the PRODUCT, not an
 * error path — nothing clears the floor ⇒ empty result + a logged miss, and we NEVER reach down for a weak
 * below-floor match to avoid looking empty (that is the dishonesty most RAG quietly commits, §6).
 *
 * ⚠ AUDIT FIX (Tier 2): the abstention score is the TOP-1 PRE-FUSION DENSE COSINE, never an RRF sum. In v1
 *   there is no fusion at all — it is literally the cosine of the nearest candidate. `abstentionScore()` is
 *   the ONE seam #14's reranker swaps (same signature — it already receives the query text it will need),
 *   so no caller of `retrieve()` changes when the reranker drops in (the Watch).
 *
 * DEFERRED seams (documented, do NOT pre-build):
 *   #13 — the permission predicate (clearance + namespace) REPLACES the `'true'` default below; chunks are
 *         then searched with the IDENTICAL predicate (§9.1). retrieve() stays ONE SQL query — the filter is
 *         in the WHERE clause, never an app-layer post-filter (retrieve-then-filter is the fail-OPEN shape).
 *   #14 — a reranker scores top-N; swap the body of `abstentionScore()` and re-derive the floor (different
 *         scale). The floor compare and every caller are untouched.
 *   getConfig — the floor/limit come from `defaultFor()` (the static declared default) until DB-scoped
 *         resolution lands; then `deps.floor ?? await getConfig('retrieval_min_relevance', ns)`.
 */
import { createHash } from 'node:crypto';
import type { Provenance } from '@aios/shared';
import { embed as gatewayEmbed, type Embedder } from './gateway.js';
import { defaultFor } from '../config/system-config.js';

/** Minimal DB executor — matches both pglite (tests) and the real pooled connection (#7 wires getDb()). */
export type QueryFn = (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>;

/**
 * A memory the read path can surface: only the columns the M0 thin schema actually has (the full lifecycle
 * shape — status, valid_from/to, utility_score, … — lands in #7), plus its dense cosine to the query. We do
 * NOT fabricate the missing lifecycle fields into a full `Memory` (that would be lying about what we stored).
 */
export interface RetrievedMemory {
  id: string;
  namespace: string;
  zone: string;
  sensitivityLevel: number;
  type: string;
  statement: string;
  contentHash: string;
  provenance: Provenance; // refs-only (§11.10); the answer surface reads sourceRefs + capturedAt to render
  //                         "I know this" + source + as-of (#5). Additive to #4 — the column already exists.
  embeddingModel: string;
  embeddingVersion: string;
  createdAt: string;
  cosine: number; // 1 − (embedding <=> query): the PRE-FUSION dense similarity that IS the score (audit fix)
}

/** A recorded miss — the learning signal (§6). refs-only fingerprint for #4 (see migration 0003 carry-forward:
 *  #32/#50 add the permission-scoped query content, since acting on a gap needs the question, not a hash). */
export interface MissRecord {
  namespace?: string | null;
  queryHash: string;
  topScore: number | null; // best below-floor cosine seen; null ⇒ empty candidate set
}

export type MissLogger = (query: QueryFn, miss: MissRecord) => Promise<void>;

export interface RetrieveDeps {
  query: QueryFn;
  embed?: Embedder; // the #46 chokepoint; injectable for hermetic tests. Default: gateway.embed.
  floor?: number; // retrieval_min_relevance (bounded key); default: defaultFor(...) — the provisional 0.608.
  maxResults?: number; // retrieval_max_results (bounded key); default: defaultFor(...) — 20.
  predicate?: string; // #13 SEAM: a parameterised SQL WHERE fragment over columns only. Default 'true' (no-op).
  logMiss?: MissLogger; // default: INSERT into retrieval_misses.
}

export interface RetrieveOutcome {
  abstained: boolean;
  score: number; // top-1 PRE-FUSION DENSE COSINE (audit fix) — NEVER an RRF sum
  memories: RetrievedMemory[]; // [] when abstained — never a below-floor match
}

/** Normalise identically to the write path's content_hash so the SAME question maps to ONE miss fingerprint. */
function normalizeQuery(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase();
}
function queryHashOf(text: string): string {
  return `sha256:${createHash('sha256').update(normalizeQuery(text)).digest('hex')}`;
}

/**
 * THE ABSTENTION SCORE — top-1 PRE-FUSION DENSE COSINE (Issue #4 audit fix). NEVER an RRF sum.
 *
 * `ranked` arrives ordered by ascending cosine distance (so `ranked[0]` is the NEAREST = highest cosine).
 * The score is that single best cosine — adding more weak candidates cannot raise it (a sum could, and would
 * silently defeat the floor; that is exactly the bug the audit fix forbids). Empty set ⇒ −∞ (always abstains).
 *
 * This function + the one-line floor compare in `retrieve()` are the SINGLE interface #14 replaces with the
 * reranker. The signature already takes the query text the reranker needs, so callers never change (the Watch).
 */
function abstentionScore(_queryText: string, ranked: RetrievedMemory[]): number {
  return ranked.length > 0 ? ranked[0]!.cosine : Number.NEGATIVE_INFINITY;
}

const defaultLogMiss: MissLogger = async (query, miss) => {
  await query(`INSERT INTO retrieval_misses (namespace, query_hash, top_score) VALUES ($1, $2, $3)`, [
    miss.namespace ?? null,
    miss.queryHash,
    miss.topScore,
  ]);
};

/**
 * Embed the query (same pinned space as the stored vectors — both flow through gateway.embed; cosine is
 * magnitude-invariant so they share the same angular space) → dense-rank `memories` in ONE SQL query behind
 * the fail-closed predicate seam → score the top-1 cosine → return it above the floor, else abstain + log.
 */
export async function retrieve(queryText: string, deps: RetrieveDeps): Promise<RetrieveOutcome> {
  const embed = deps.embed ?? gatewayEmbed;
  const floor = deps.floor ?? (defaultFor('retrieval_min_relevance') as number);
  const maxResults = deps.maxResults ?? (defaultFor('retrieval_max_results') as number);
  const predicate = deps.predicate ?? 'true'; // #13 replaces this default with the clearance+namespace fragment
  const logMiss = deps.logMiss ?? defaultLogMiss;

  // The query embedding goes through the gateway chokepoint (#46) — the SAME pinned model/dim/version as the
  // stored vectors, or cosine would be meaningless. Fail loud rather than search a null vector.
  const [queryVec] = await embed([queryText]);
  if (!queryVec) {
    throw new Error('embed returned no vector for the query (refusing to search a null embedding)');
  }

  // ONE query: filter (predicate) → rank (`<=>` cosine distance) → cap. NEVER retrieve-then-filter (#13 just
  // swaps `true` for the permission fragment; the param placeholders it adds start AFTER $1/$2 used here).
  const { rows } = await deps.query(
    `SELECT id, namespace, zone, sensitivity_level, type, statement, content_hash, provenance,
            embedding_model, embedding_version, created_at,
            (embedding <=> $1::vector)::float8 AS distance
       FROM memories
      WHERE ${predicate}
      ORDER BY embedding <=> $1::vector
      LIMIT $2`,
    [`[${queryVec.join(',')}]`, maxResults],
  );

  const ranked: RetrievedMemory[] = rows.map((r) => ({
    id: r.id,
    namespace: r.namespace,
    zone: r.zone,
    sensitivityLevel: r.sensitivity_level,
    type: r.type,
    statement: r.statement,
    contentHash: r.content_hash,
    provenance: r.provenance, // jsonb → Provenance (refs only); rows inserted with '{}' simply carry no refs
    embeddingModel: r.embedding_model,
    embeddingVersion: r.embedding_version,
    createdAt: new Date(r.created_at).toISOString(),
    cosine: 1 - r.distance, // pgvector `<=>` is cosine DISTANCE; similarity = 1 − distance
  }));

  const score = abstentionScore(queryText, ranked);

  if (score < floor) {
    // ABSTAIN — the product. Record the miss (learning signal, §6) and return EMPTY: we never surface the
    // weak below-floor candidate just to look non-empty. `score` is still returned for honest transparency.
    await logMiss(deps.query, {
      queryHash: queryHashOf(queryText),
      topScore: ranked.length > 0 ? ranked[0]!.cosine : null,
    });
    return { abstained: true, score, memories: [] };
  }

  return { abstained: false, score, memories: ranked };
}
