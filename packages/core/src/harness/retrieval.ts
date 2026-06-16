/**
 * Hybrid retrieval + reranked abstention — the READ half of the harness (Issues #4 → #13 → #14, Brief §4.7, §6).
 *
 * Embed the query through the gateway chokepoint, run a hybrid dense+keyword search of `memories` and `chunks`
 * behind a fail-closed permission predicate, fuse with RRF, then score the abstention decision with a
 * CROSS-ENCODER RERANKER (#14) over the top-N of the fused union. Either return the candidates ABOVE the floor
 * or ABSTAIN + log a miss. Abstention is the PRODUCT, not an error path — nothing clears the floor ⇒ empty
 * result + a logged miss; we NEVER reach down for a weak below-floor match to look non-empty (the dishonesty
 * most RAG quietly commits, §6).
 *
 * ⚠ AUDIT FIX (Tier 2, #14): the abstention score is the MAX RERANK score over the top-N fused candidates —
 *   a single CALIBRATED per-candidate score, NEVER an RRF sum (piling on weak candidates cannot raise a max).
 *   This SUPERSEDES the #4 interim (the pre-fusion dense cosine) with the real calibrated score on the
 *   reranker's scale (ADR 0003 supersedes ADR 0001's floor). `scoreByReranker()` is the ONE seam that does
 *   this; `retrieve()`'s external signature is UNCHANGED, so no caller changes (the Watch).
 *
 * ⚠ The rerank INPUT is the FUSED UNION (dense ∪ keyword), in RRF order — NOT the dense-only list. That is the
 *   whole point (#13 deferral closed): a strong KEYWORD-only candidate, below the dense cosine floor, is now
 *   scored and can clear. One rerank call per query (the Watch). It runs AFTER the DB transaction closes (an
 *   external HTTP call must not hold a DB connection).
 *
 * #13 (BUILT) — the permission predicate (clearance + namespace) is DERIVED inside retrieve() from the
 *         `principal`'s clearance (rbac.getClearance → buildRetrievalPredicate → retrievalWhereSql(…, 3)) —
 *         there is no caller-supplied predicate (that was the fail-OPEN shape). The fragment numbers from $3
 *         ($1 = vector, $2 = limit). Both legs (dense + keyword) of BOTH stores (memories + chunks) filter in
 *         the WHERE clause BEFORE ranking — never an app-layer post-filter (retrieve-then-filter is the leak).
 *         A forbidden row therefore never enters the fused set and never reaches the reranker (zero content
 *         egress, reranker-egress.test.ts). Locked by retrieval-where-seam.test.ts + the #36 leak fixtures.
 *
 * DECISION A (reranker unavailable) — ABSTAIN + alert, never the uncalibrated cosine. A provider outage is
 *         fail-SAFE (honest "I don't know"), observable on `degraded` + the diagnostics span + a loud alert
 *         sink; it is an OUTAGE, not a knowledge gap, so it logs NO miss (that would teach a false gap).
 *
 * DEFERRED seams (documented, do NOT pre-build):
 *   #15 — rerank-REORDERING the surfaced set (output stays RRF order here; #14 only changes the FLOOR).
 *   #24 — chunk-relevance abstention (abstention is memories-only by the #4 decision; chunks are still
 *         searched + permission-filtered, only the SURFACED output is gated on the memory reranker decision).
 *   getConfig — floor/limit/top_n come from `defaultFor()` (the static declared default) until DB-scoped
 *         resolution lands; then `deps.x ?? await getConfig(key, ns)`.
 */
import { createHash } from 'node:crypto';
import type { Clearance, Principal, Provenance } from '@aios/shared';
import { embed as gatewayEmbed, rerank as gatewayRerank, RERANKER_MODEL, type Embedder, type Reranker } from './gateway.js';
import { defaultFor } from '../config/system-config.js';
import { getClearance as realGetClearance, buildRetrievalPredicate, retrievalWhereSql } from '../rbac/permissions.js';
import { underTestRunner, type TxFn } from '../audit/audit-log.js';

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

/** A chunk the read path can surface — RAG-in-place, no lifecycle but the SAME permission columns (§4.2, §9.1).
 *  `text` (not `statement`), and no `type`/`status`; otherwise carries the same access label + provenance. */
export interface RetrievedChunk {
  id: string;
  namespace: string;
  zone: string;
  sensitivityLevel: number;
  text: string;
  contentHash: string;
  provenance: Provenance;
  embeddingModel: string;
  embeddingVersion: string;
  createdAt: string;
  cosine: number;
}

/** A recorded miss — the learning signal (§6). refs-only fingerprint for #4 (see migration 0003 carry-forward:
 *  #32/#50 add the permission-scoped query content, since acting on a gap needs the question, not a hash). */
export interface MissRecord {
  namespace?: string | null;
  queryHash: string;
  topScore: number | null; // best below-floor RERANK score seen (#14, was cosine); null ⇒ empty candidate set
}

/** A reranker-unavailable alarm (Decision A). retrieve() ABSTAINS fail-safe on a rerank outage; this fires so
 *  the degradation is alertable (never a silent uncalibrated answer). refs-only — never the query/doc content. */
export interface RerankerUnavailable {
  queryHash: string;
  namespace?: string | null;
  reason: string; // the transport/status error message (status-only by construction, §11.10) — never content
}
export type RerankerAlert = (info: RerankerUnavailable) => void;

export type MissLogger = (query: QueryFn, miss: MissRecord) => Promise<void>;

/** A clearance resolver — the real one (rbac.getClearance) in prod; injected in tests to craft a clearance
 *  without seeding a row. Either way it is a RESOLVER: retrieve() derives the authorized namespaces from the
 *  clearance it returns, never from a caller-supplied list (that was the old fail-OPEN shape #13 closes). */
export type ClearanceResolver = (principal: Principal, deps: { query: QueryFn }) => Promise<Clearance>;

export interface RetrieveDeps {
  query: QueryFn;
  /** #13 TRUST BOUNDARY: WHO is asking. The permission predicate is DERIVED from this principal's clearance
   *  inside retrieve() — there is no caller-supplied predicate. A missing/forged/service principal resolves to
   *  denyClearance() ⇒ `WHERE false` ⇒ zero rows (never a permissive default). */
  principal: Principal;
  getClearance?: ClearanceResolver; // injectable; default: rbac.getClearance (the real materialised-row resolver).
  embed?: Embedder; // the #46 chokepoint; injectable for hermetic tests. Default: gateway.embed.
  rerank?: Reranker; // the #14 chokepoint; injectable for hermetic tests (the embed-injection precedent). Default: gateway.rerank.
  floor?: number; // retrieval_min_relevance (bounded key); default: defaultFor(...) — the provisional RERANK floor (#14).
  rerankerTopN?: number; // reranker_top_n (bounded key); how many fused candidates the one rerank call scores. Default: defaultFor(...).
  maxResults?: number; // retrieval_max_results (bounded key); default: defaultFor(...) — 20.
  /** Reranker-unavailable alarm (Decision A). Default: a LOUD console.error — never silent. */
  onRerankerUnavailable?: RerankerAlert;
  exactMaxRows?: number; // exact_search_max_rows (bounded key); ≤ this filtered ⇒ exact path. Injectable for tests.
  /** PROD HNSW path requires a transaction (mirrors appendAudit's prod-needs-a-txn posture): the SET LOCAL
   *  hnsw.iterative_scan / ef_search GUCs that keep a FILTERED HNSW scan from collapsing recall are txn-scoped.
   *  count + both legs also run inside it on ONE backend (a single snapshot — works under Supavisor txn pooling).
   *  Without it the HNSW path is tolerated ONLY under the test runner (single-threaded); prod throws loud. */
  transaction?: TxFn;
  logMiss?: MissLogger; // default: INSERT into retrieval_misses.
  /** Observability sink (slice 7): receives searchMode + per-leg counts (RetrievalDiagnostics). Fire-and-forget;
   *  the caller wires it to a permission-tagged kind='retrieval' trace (emitSpan) with its run context. */
  onRetrieval?: (diagnostics: RetrievalDiagnostics) => void;
}

/** Per-store observability: which ANN path ran and the candidate counts that drove it (slice 4/7). */
export interface StoreDiagnostics {
  mode: 'exact' | 'hnsw'; // exact = MATERIALIZED-CTE flat scan (perfect recall); hnsw = iterative index scan
  candidateCount: number; // the BOUNDED selectivity count (capped at exact_search_max_rows + 1) that chose `mode`
  denseCount: number; // dense-leg rows fed into the RRF join
  keywordCount: number; // keyword-leg rows fed into the RRF join
}

/**
 * The observability record `onRetrieval` receives — searchMode + per-leg counts per store, NOT just the return
 * value. retrieve() does NOT own taskId/trigger, so it cannot itself write a permission-tagged `kind='retrieval'`
 * trace row (emitSpan requires them); the caller (#37/#5) wires this sink → emitSpan with its run context, the
 * same split as gatewayOnSpan. Fired on BOTH the hit and abstain paths.
 */
export interface RetrievalDiagnostics {
  memories: StoreDiagnostics;
  chunks: StoreDiagnostics;
  abstained: boolean;
  score: number; // the MAX RERANK score (#14) — the calibrated abstention input, NOT a cosine, NEVER an RRF sum
  degraded: boolean; // true ⇒ the reranker was unavailable and we abstained fail-safe (Decision A)
  rerankerModel: string; // the pinned reranker the floor binds to (RERANKER_MODEL) — honest provenance of the score
  rerankerScores: Array<{ id: string; score: number }>; // per-candidate scores over the top-N (helps #15 context-tightening)
  durationMs: number;
}

export interface RetrieveOutcome {
  abstained: boolean;
  score: number; // the MAX RERANK score over the top-N fused candidates (#14) — a CALIBRATED score, NEVER an RRF sum
  degraded: boolean; // true ⇒ reranker unavailable ⇒ abstained fail-safe (Decision A); the score is not meaningful
  memories: RetrievedMemory[]; // [] when abstained — never a below-floor match
  chunks: RetrievedChunk[]; // permission-filtered identically to memories; [] when abstained
  diagnostics: { memories: StoreDiagnostics; chunks: StoreDiagnostics }; // observability, not just the return value
}

/** Normalise identically to the write path's content_hash so the SAME question maps to ONE miss fingerprint. */
function normalizeQuery(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase();
}
function queryHashOf(text: string): string {
  return `sha256:${createHash('sha256').update(normalizeQuery(text)).digest('hex')}`;
}

/**
 * THE ABSTENTION SCORE — the MAX RERANK score over the top-N FUSED candidates (Issue #14). NEVER an RRF sum.
 *
 * ⚠ This function DOES I/O: it makes ONE cross-encoder rerank call (the gateway chokepoint) per query. It is
 * async for that reason — the #4 cosine version was pure; this supersedes it. It takes the fused union in RRF
 * ORDER (`fusedByRrf`), so a keyword-surfaced candidate below the dense cosine floor is included in the top-N
 * (the #13 deferral closed). The score is the SINGLE best calibrated relevance — adding more weak candidates
 * cannot raise a max (a sum could, and would silently defeat the floor; the bug the audit fix forbids). Empty
 * set ⇒ −∞ and NO rerank call (nothing to score, no spend). It returns the per-candidate scores too, so the
 * caller can record them (honest transparency + #15 context-tightening) without a second pass.
 *
 * This function + the one-line floor compare in `retrieve()` are the SINGLE interface that scores abstention;
 * `retrieve()`'s external signature is unchanged, so no caller changes (the Watch). A rerank failure is thrown
 * to the caller, which abstains fail-safe (Decision A) — it is NEVER swallowed into a cosine fallback here.
 */
async function scoreByReranker(
  queryText: string,
  fusedByRrf: RetrievedMemory[],
  rerank: Reranker,
  topN: number,
): Promise<{ score: number; perCandidate: Array<{ id: string; score: number }> }> {
  if (fusedByRrf.length === 0) return { score: Number.NEGATIVE_INFINITY, perCandidate: [] };
  const top = fusedByRrf.slice(0, Math.max(1, Math.trunc(topN)));
  const scores = await rerank(queryText, top.map((m) => m.statement));
  if (scores.length !== top.length) {
    // Defensive: a reranker that returns the wrong count cannot be trusted to align scores to candidates.
    throw new Error(`rerank returned ${scores.length} scores for ${top.length} candidates`);
  }
  const perCandidate = top.map((m, i) => ({ id: m.id, score: scores[i]! }));
  const max = perCandidate.reduce((acc, c) => (c.score > acc ? c.score : acc), Number.NEGATIVE_INFINITY);
  return { score: max, perCandidate };
}

/** One DB row → RetrievedMemory. `distance` is pgvector `<=>` (cosine DISTANCE); similarity = 1 − distance. */
function mapMemoryRow(r: any): RetrievedMemory {
  return {
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
    cosine: 1 - r.distance,
  };
}

/** One DB row → RetrievedChunk (the chunk store's `text`/no-type shape). */
function mapChunkRow(r: any): RetrievedChunk {
  return {
    id: r.id,
    namespace: r.namespace,
    zone: r.zone,
    sensitivityLevel: r.sensitivity_level,
    text: r.text,
    contentHash: r.content_hash,
    provenance: r.provenance,
    embeddingModel: r.embedding_model,
    embeddingVersion: r.embedding_version,
    createdAt: new Date(r.created_at).toISOString(),
    cosine: 1 - r.distance,
  };
}

/** The LOUD default reranker-unavailable alarm (Decision A) — a degraded abstention must be alertable, never
 *  silent. Refs-only: the reason is a status/transport message (no content by construction, §11.10). */
const defaultOnRerankerUnavailable: RerankerAlert = (info) => {
  console.error(
    `[retrieval] RERANKER UNAVAILABLE — abstained fail-safe (no uncalibrated answer). ` +
      `ns=${info.namespace ?? 'org'} query=${info.queryHash} reason=${info.reason}`,
  );
};

const defaultLogMiss: MissLogger = async (query, miss) => {
  await query(`INSERT INTO retrieval_misses (namespace, query_hash, top_score) VALUES ($1, $2, $3)`, [
    miss.namespace ?? null,
    miss.queryHash,
    miss.topScore,
  ]);
};

/** Per-store query shape. The permission predicate fragment + status conjunct are applied IDENTICALLY across
 *  stores (the leak guard); only the table, the lifecycle conjunct, and the projected columns differ. */
interface StoreSpec {
  table: 'memories' | 'chunks';
  statusConjunct: string; // "status = 'active' AND " (memories) | '' (chunks have no lifecycle, §4.2)
  cols: string; // the `m.<col>` projection feeding mapMemoryRow/mapChunkRow (sans distance/rrf, appended below)
}

const MEMORIES_SPEC: StoreSpec = {
  table: 'memories',
  statusConjunct: "status = 'active' AND ",
  cols: 'm.id, m.namespace, m.zone, m.sensitivity_level, m.type, m.statement, m.content_hash, m.provenance, m.embedding_model, m.embedding_version, m.created_at',
};

// chunks: NO status conjunct (lifecycle is memories-only, §4.2) — the permission predicate is the ONLY filter.
// The fragment + params are IDENTICAL to memories' (the leak guard is that identity); only table/cols differ.
const CHUNKS_SPEC: StoreSpec = {
  table: 'chunks',
  statusConjunct: '',
  cols: 'm.id, m.namespace, m.zone, m.sensitivity_level, m.text, m.content_hash, m.provenance, m.embedding_model, m.embedding_version, m.created_at',
};

interface SearchCtx {
  vecLit: string;
  maxResults: number;
  queryText: string;
  rrfK: number;
  efSearch: number;
  exactMaxRows: number;
  pred: ReturnType<typeof buildRetrievalPredicate>;
}

/**
 * Hybrid (dense + keyword) search of ONE store, selectivity-routed. Returns raw rows in RRF order + the store's
 * diagnostics. The permission predicate is applied in the WHERE of BOTH legs AND the selectivity count — always
 * BEFORE the ANN, never an app-layer post-filter.
 *
 * SELECTIVITY (named method): a BOUNDED, LIMIT-capped COUNT over the predicate (`LIMIT exact_search_max_rows+1`)
 * — O(threshold) regardless of corpus size. `count ≤ exact_search_max_rows` ⇒ EXACT (a MATERIALIZED candidate
 * CTE: the index can't serve an ORDER BY outside its scope, so the planner does a flat scan + sort ⇒ perfect
 * recall for a restricted user); else HNSW (txn-scoped iterative_scan/ef_search GUCs keep a filtered HNSW scan
 * from collapsing recall — and the switch only sends NON-selective filters here, where recall-collapse is mild).
 *
 * ⚠ KNOWN LIMITATION — RECALL RESIDUAL (quality, NOT a leak): the count is a PROXY for selectivity. A filter
 * just OVER the threshold on a large corpus takes the HNSW path, where recall is approximate — a just-relevant
 * row beyond ef_search's reach may be missed. This is bounded and quality-only: the WHERE still filters
 * (nothing forbidden leaks), iterative_scan mitigates it, and acceptance ties PERFECT recall to the EXACT path
 * (the restricted-user case that matters most). Tighten by raising exact_search_max_rows / hnsw_ef_search; a
 * principled recall SLO on the non-selective path is a forward refinement (revisit with #14/#32).
 */
async function searchStore(
  q: QueryFn,
  spec: StoreSpec,
  ctx: SearchCtx,
  inTransaction: boolean,
): Promise<{ rows: any[]; diagnostics: StoreDiagnostics }> {
  // 1. BOUNDED selectivity count — predicate numbers from $2 ($1 = threshold+1). Filtered in WHERE (not a probe
  //    that ignores permissions): a denied principal counts 0 ⇒ exact ⇒ the empty result is reached cheaply.
  const countPred = retrievalWhereSql(ctx.pred, 2);
  const { rows: cRows } = await q(
    `SELECT count(*)::int AS n FROM (
        SELECT 1 FROM ${spec.table} WHERE ${spec.statusConjunct}(${countPred.sql}) LIMIT $1
     ) t`,
    [ctx.exactMaxRows + 1, ...countPred.params],
  );
  const candidateCount = cRows[0].n as number;
  const mode: 'exact' | 'hnsw' = candidateCount <= ctx.exactMaxRows ? 'exact' : 'hnsw';

  // 2. HNSW GUCs are txn-scoped. PROD requires the txn (recall-collapse guard, mirrors appendAudit); the
  //    txn-less HNSW path is tolerated ONLY under the test runner (single-threaded, tiny sets).
  if (mode === 'hnsw') {
    if (inTransaction) {
      await q(`SET LOCAL hnsw.iterative_scan = relaxed_order`);
      await q(`SET LOCAL hnsw.ef_search = ${Math.trunc(ctx.efSearch)}`);
    } else if (!underTestRunner()) {
      throw new Error(
        'retrieve(): the HNSW (non-selective) path requires a transaction in production — the SET LOCAL ' +
          'hnsw.iterative_scan/ef_search GUCs that stop a FILTERED HNSW scan from collapsing recall are ' +
          'txn-scoped. Pass `transaction`; the txn-less path is tolerated only under the test runner.',
      );
    }
  }

  // 3. The fused query. Predicate numbers from $5 (after $1=vector, $2=limit, $3=keyword text, $4=rrf_k); it
  //    appears in BOTH legs with the SAME placeholders (bound once). Each leg is CAPPED at $2 BEFORE the join.
  const mainPred = retrievalWhereSql(ctx.pred, 5);
  const denseCte =
    mode === 'exact'
      ? // EXACT: MATERIALIZED candidate set (filter + distance for EVERY filtered row), THEN order+limit outside
        // it — the HNSW index can't serve the outer ORDER BY, so the planner flat-scans ⇒ perfect recall.
        `cand AS MATERIALIZED (
            SELECT id, (embedding <=> $1::vector)::float8 AS distance
              FROM ${spec.table} WHERE ${spec.statusConjunct}(${mainPred.sql})
         ),
         dense AS (
            SELECT id, distance, row_number() OVER (ORDER BY distance) AS d_rank
              FROM cand ORDER BY distance LIMIT $2
         )`
      : // HNSW: the index serves the ORDER BY `<=>` directly (iterative_scan set above for filtered recall).
        `dense AS (
            SELECT id, (embedding <=> $1::vector)::float8 AS distance,
                   row_number() OVER (ORDER BY embedding <=> $1::vector) AS d_rank
              FROM ${spec.table} WHERE ${spec.statusConjunct}(${mainPred.sql})
             ORDER BY embedding <=> $1::vector LIMIT $2
         )`;

  const { rows } = await q(
    `WITH ${denseCte},
       kw AS (
          SELECT id, row_number() OVER (ORDER BY ts_rank(ts, websearch_to_tsquery('english', $3)) DESC, id) AS k_rank
            FROM ${spec.table}
           WHERE ${spec.statusConjunct}(${mainPred.sql})
             AND ts @@ websearch_to_tsquery('english', $3)
           LIMIT $2
       ),
       fused AS (
          SELECT COALESCE(d.id, k.id) AS id,
                 (COALESCE(1.0 / ($4 + d.d_rank), 0) + COALESCE(1.0 / ($4 + k.k_rank), 0))::float8 AS rrf,
                 (d.id IS NOT NULL) AS in_dense, (k.id IS NOT NULL) AS in_kw
            FROM dense d FULL OUTER JOIN kw k ON d.id = k.id
       )
       SELECT ${spec.cols}, (m.embedding <=> $1::vector)::float8 AS distance,
              f.rrf AS rrf, f.in_dense AS in_dense, f.in_kw AS in_kw
         FROM fused f JOIN ${spec.table} m ON m.id = f.id
        ORDER BY f.rrf DESC, m.id`,
    [ctx.vecLit, ctx.maxResults, ctx.queryText, ctx.rrfK, ...mainPred.params],
  );

  const denseCount = rows.filter((r) => r.in_dense).length;
  const keywordCount = rows.filter((r) => r.in_kw).length;
  return { rows, diagnostics: { mode, candidateCount, denseCount, keywordCount } };
}

/**
 * Embed the query (same pinned space as the stored vectors — both flow through gateway.embed; cosine is
 * magnitude-invariant so they share the same angular space) → hybrid dense+keyword search behind the fail-closed
 * predicate, selectivity-routed exact↔HNSW → score the PRE-FUSION dense top-1 → above the floor, else abstain.
 */
export async function retrieve(queryText: string, deps: RetrieveDeps): Promise<RetrieveOutcome> {
  const startedAt = performance.now();
  const embed = deps.embed ?? gatewayEmbed;
  const rerank = deps.rerank ?? gatewayRerank;
  const floor = deps.floor ?? (defaultFor('retrieval_min_relevance') as number);
  const rerankerTopN = deps.rerankerTopN ?? (defaultFor('reranker_top_n') as number);
  const maxResults = deps.maxResults ?? (defaultFor('retrieval_max_results') as number);
  const logMiss = deps.logMiss ?? defaultLogMiss;
  const onRerankerUnavailable = deps.onRerankerUnavailable ?? defaultOnRerankerUnavailable;

  // #13 TRUST BOUNDARY: derive the permission predicate from the principal's clearance — INSIDE retrieve(), never
  // caller-supplied. getClearance fail-closes service/missing/forged to denyClearance() (empty zones AND empty
  // namespaces). The AUTHORIZED namespaces are the ones on the resolved clearance — never a caller argument
  // (passing an unfiltered namespaces array here was the namespace-leak shape #13 absorbs). namespaces.length===0
  // (or empty zones) ⇒ denyAll ⇒ `WHERE false`. `searchStore` compiles the fragment per query (the count
  // numbers it from $2, the fused search from $5) — never forking retrievalWhereSql, just re-offsetting it.
  const clearance = await (deps.getClearance ?? realGetClearance)(deps.principal, { query: deps.query });
  const pred = buildRetrievalPredicate(clearance, clearance.allowedNamespaces);

  // The query embedding goes through the gateway chokepoint (#46) — the SAME pinned model/dim/version as the
  // stored vectors, or cosine would be meaningless. Fail loud rather than search a null vector.
  const [queryVec] = await embed([queryText]);
  if (!queryVec) {
    throw new Error('embed returned no vector for the query (refusing to search a null embedding)');
  }

  const ctx: SearchCtx = {
    vecLit: `[${queryVec.join(',')}]`,
    maxResults,
    queryText,
    rrfK: defaultFor('rrf_k') as number,
    efSearch: defaultFor('hnsw_ef_search') as number,
    exactMaxRows: deps.exactMaxRows ?? (defaultFor('exact_search_max_rows') as number),
    pred,
  };

  // All DB reads run on ONE backend: inside the caller's transaction when provided (required for the prod HNSW
  // path's txn-scoped GUCs + a single count/search snapshot), else directly on deps.query (test tolerance).
  // BOTH stores are searched behind the IDENTICAL permission fragment (the leak guard, §9.1).
  const work = async (q: QueryFn, inTx: boolean) => ({
    mem: await searchStore(q, MEMORIES_SPEC, ctx, inTx),
    chk: await searchStore(q, CHUNKS_SPEC, ctx, inTx),
  });
  const { mem, chk } = deps.transaction ? await deps.transaction((q) => work(q, true)) : await work(deps.query, false);
  const diagnostics = { memories: mem.diagnostics, chunks: chk.diagnostics };

  // Rows arrive in RRF (output) order. Each carries its real dense cosine (recomputed for every fused row,
  // including keyword-only ones, so the score is never null).
  const fused: RetrievedMemory[] = mem.rows.map(mapMemoryRow);
  const fusedChunks: RetrievedChunk[] = chk.rows.map(mapChunkRow);

  // ABSTENTION INPUT = the MAX RERANK score over the top-N of the FUSED UNION in RRF order (#14), NOT the dense
  // cosine and NEVER an RRF sum. Feeding `fused` (the RRF output, dense ∪ keyword) — not a dense-only list — is
  // what lets a keyword-surfaced candidate below the dense cosine floor be scored and clear (the #13 deferral).
  // ONE rerank call per query; it runs HERE, after the DB transaction has closed (an HTTP call must not hold a
  // DB connection). A rerank failure is caught → ABSTAIN fail-safe + alert (Decision A), never a cosine fallback.
  let score = Number.NEGATIVE_INFINITY;
  let rerankerScores: Array<{ id: string; score: number }> = [];
  let degraded = false;
  try {
    const scored = await scoreByReranker(queryText, fused, rerank, rerankerTopN);
    score = scored.score;
    rerankerScores = scored.perCandidate;
  } catch (err) {
    // Decision A: the reranker is unavailable. We DO NOT answer on the uncalibrated cosine. Abstain fail-safe,
    // loudly alert (alertable, never silent), and emit a degraded span. An outage is not a knowledge gap, so we
    // log NO miss (recording one would teach the self-improvement loop a false gap).
    degraded = true;
    onRerankerUnavailable({
      queryHash: queryHashOf(queryText),
      namespace: clearance.allowedNamespaces[0] ?? null,
      reason: err instanceof Error ? err.message : String(err),
    });
  }

  // Observability (slice 7): emit searchMode + per-leg counts + the reranker score/model/per-candidate scores
  // (NOT just the return value). Fired on BOTH the hit and abstain paths, AND on the degraded path.
  const emit = (abstained: boolean) =>
    deps.onRetrieval?.({
      ...diagnostics,
      abstained,
      score,
      degraded,
      rerankerModel: RERANKER_MODEL,
      rerankerScores,
      durationMs: performance.now() - startedAt,
    });

  if (degraded) {
    emit(true);
    return { abstained: true, score, degraded: true, memories: [], chunks: [], diagnostics };
  }

  if (score < floor) {
    // ABSTAIN — the product. Record the miss (learning signal, §6) and return EMPTY: we never surface the
    // weak below-floor candidate just to look non-empty. `score` is still returned for honest transparency.
    await logMiss(deps.query, {
      queryHash: queryHashOf(queryText),
      topScore: rerankerScores.length > 0 ? score : null, // best below-floor RERANK score seen (null ⇒ empty set)
    });
    // Abstention is the PRODUCT: we surface NOTHING (memories AND chunks) once we've declared we don't know.
    // Abstention is memories-only by decision (the #4 contract); chunk-relevance abstention is the forward #24
    // refinement (recorded). Both stores are still SEARCHED above (diagnostics populated, the chunk filter
    // exercised) — only the surfaced output is gated here.
    emit(true);
    return { abstained: true, score, degraded: false, memories: [], chunks: [], diagnostics };
  }

  emit(false);

  // Output: each store's RRF-ordered set, capped at maxResults (rerank-REORDERING the surfaced set is the #15
  // refinement — #14 only changes the FLOOR, not the output order). The dense leg already bounded candidates;
  // each fused set is ≤ 2·maxResults, sliced here to the final cap (already in rrf-desc order from the query).
  return {
    abstained: false,
    score,
    degraded: false,
    memories: fused.slice(0, maxResults),
    chunks: fusedChunks.slice(0, maxResults),
    diagnostics,
  };
}
