/**
 * Memory store — write / invalidate (NEVER overwrite, §4.4). Provenance, sensitivity, namespace on write (§5).
 */
import { createHash } from 'node:crypto';
import type { InvalidationCode, Memory, Namespace, Provenance, SensitivityLevel, Zone } from '@aios/shared';
import { embed as gatewayEmbed, EMBEDDING_MODEL, EMBEDDING_VERSION, type Embedder } from '../harness/gateway.js';
import { appendAuditInTx, underTestRunner, type TxFn } from '../audit/audit-log.js';

// `Embedder` now lives next to `embed` in the gateway (the read path needs it too); re-exported here so
// existing callers/tests importing it from the store keep working.
export type { Embedder };

/** Minimal DB executor — matches both pglite (tests) and the real pooled connection (#7 wires getDb()). */
export type QueryFn = (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>;

export interface WriteMemoryInput {
  // 'working' is excluded — working memory never persists (§4.1); only the three durable types reach the table.
  type: Exclude<Memory['type'], 'working'>;
  namespace: Namespace; // derived via the Identity Map from entity refs (§4.10)
  zone: Zone; // #3: set from input (the max(sources)/union(sources) derivation is multi-source ingestion, later)
  sensitivityLevel: SensitivityLevel; // #3: from input
  statement: string;
  provenance: Provenance; // trustLevel gates promotion to semantic (anti-poisoning, §5). REFS only, never content.
  // NB: `slot` (deterministic supersession key) is intentionally absent until #7 adds its columns — accepting
  // it now would silently drop it (a silent failure). It returns with the lifecycle schema.
}

/** The subset of a memory row #2/#3's thin schema can store. The full lifecycle shape (status, valid_from/to,
 *  utility_score, …) lands in #7. */
export interface WrittenMemory {
  id: string;
  namespace: Namespace;
  zone: Zone;
  sensitivityLevel: SensitivityLevel;
  type: WriteMemoryInput['type'];
  statement: string;
  contentHash: string;
  provenance: Provenance;
  embeddingModel: string;
  embeddingVersion: string;
  createdAt: string;
}

export interface WriteResult {
  memory: WrittenMemory;
  deduped: boolean; // true ⇒ an identical (namespace, content_hash) row already existed; nothing was written
  /**
   * true ⇒ a dedup hit where the incoming access label was MORE RESTRICTIVE (or differing) than the stored
   * row: incoming sensitivity > stored, OR incoming zone != stored zone. The stored (more permissive) label
   * is NOT changed here (relabel = invalidate-old + write-new, deferred to #12) — but the conflict is made
   * LOUD so a more-restrictive re-upload can't silently under-classify (over-sharing, principle #2).
   */
  labelConflict: boolean;
  /**
   * true ⇒ a dedup hit where the incoming `type` differs from the STORED row's type (e.g. the same text was
   * first written as 'semantic' and is now re-uploaded as 'procedural'). The stored type is NOT changed here.
   *
   * ⚠ #12 DEFERRAL (recorded on the issue): a type-change supersession is intentionally NOT implemented in #12.
   *   The acceptance criteria are silent on it, and a type change is not an access/leak issue (the #3 obligation
   *   #12 closes is purely about access labels), so auto-deciding it is a #30-class judgment. The flag stays the
   *   honest interim signal (surfaced, never silently swallowed); a future type-supersession reuses `supersede()`
   *   built here — nothing is forked. Always false on a fresh write.
   */
  typeConflict: boolean;
  /**
   * true ⇒ this dedup hit was a more-restrictive SAME-ZONE re-upload, and #12 RESOLVED it by relabel:
   * invalidate-old + write-new at max(sensitivity) (§5 max-of-sources + §4.4). `memory` is then the NEW active
   * row at the raised label, and `labelConflict` is false (the conflict was applied, not merely flagged). A
   * DIFFERING-zone conflict is never relabeled (zones are unordered — no fail-closed union); it stays
   * labelConflict:true / relabeled:false (frozen pending review). Always false on a fresh write.
   */
  relabeled: boolean;
}

/** Shared opts for the durable write paths. `transaction` is the single-connection runner the atomic relabel /
 *  invalidate / supersede path needs (same shape the audit chain uses); `unsafeUnlocked` opts into the unlocked
 *  path outside the test runner (use with care — see `runAtomic`). */
export interface WriteOpts {
  embed?: Embedder;
  transaction?: TxFn;
  unsafeUnlocked?: boolean;
}

/** A structured invalidation reason: `code` (closed vocab) → the refs-only audit chain; `note` (free text) →
 *  the permission-tagged `memories.invalidated_reason` column ONLY, never the content-free audit log (§11.10). */
export interface InvalidationReason {
  code: InvalidationCode;
  note?: string;
}

/** Normalise before hashing so trivial whitespace/case differences dedup (§5 tier-1 exact-dup guard). */
function normalizeForHash(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** content_hash = sha256 over NORMALISED text, scoped to a namespace at lookup time (NOT global — #2 proved
 *  the same text legitimately coexists across clients; a global hash would evict one client's memory). */
function contentHashOf(statement: string): string {
  return `sha256:${createHash('sha256').update(normalizeForHash(statement)).digest('hex')}`;
}

function rowToMemory(row: any): WrittenMemory {
  return {
    id: row.id,
    namespace: row.namespace,
    zone: row.zone,
    sensitivityLevel: row.sensitivity_level,
    type: row.type,
    statement: row.statement,
    contentHash: row.content_hash,
    provenance: row.provenance,
    embeddingModel: row.embedding_model,
    embeddingVersion: row.embedding_version,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

const SELECT_COLS =
  'id, namespace, zone, sensitivity_level, type, statement, content_hash, provenance, embedding_model, embedding_version, created_at';

/**
 * Happy-path write: embed → hash → set sensitivity/zone from input → insert (§5). NO routing gates (#17) and
 * NO invalidation/supersession (#12) — those are separate issues; this is a direct write.
 *
 * Dedup is NAMESPACE-SCOPED and now race-safe (#7 closed #3's TOCTOU deferral). Two layers:
 *   1. a cheap pre-SELECT of the ACTIVE row — the fast path that skips the embed entirely on the common
 *      re-upload case (a model call saved), and
 *   2. INSERT … ON CONFLICT (namespace, content_hash) WHERE status='active' DO NOTHING — the DB-level guard
 *      (the partial UNIQUE added in 0004) that closes the window between the SELECT and the INSERT. If a
 *      concurrent writer wins that race, our INSERT no-ops and we re-read the winner's row.
 * Invalidated rows are exempt from the unique index (they legitimately share the hash with their successor,
 * §4.4), so the guard constrains exactly the live set.
 */
export async function writeMemory(
  query: QueryFn,
  input: WriteMemoryInput,
  opts: WriteOpts = {},
): Promise<WriteResult> {
  const embed = opts.embed ?? gatewayEmbed;

  // FAIL-CLOSED on provenance (anti-poisoning, §5): trustLevel gates promotion to semantic. A missing/garbage
  // trustLevel (e.g. the '{}' jsonb default, or a caller that forgot to stamp it) must NOT slip through as an
  // implicit "trusted" write — refuse it loudly rather than poison the vector space with an unrated source.
  const trust = input.provenance?.trustLevel;
  if (trust !== 'high' && trust !== 'low') {
    throw new Error(
      `writeMemory: provenance.trustLevel must be 'high' or 'low' (got ${JSON.stringify(trust)}) — ` +
        'refusing a fail-open write with an unrated source (anti-poisoning, §5).',
    );
  }

  const contentHash = contentHashOf(input.statement);

  // Fast path — namespace-scoped dedup against the ACTIVE row: skip the write AND the embed entirely. Scoped
  // to status='active' because an invalidated row legitimately shares the hash with its successor (§4.4).
  const existing = await query(
    `SELECT ${SELECT_COLS} FROM memories WHERE namespace = $1 AND content_hash = $2 AND status = 'active' LIMIT 1`,
    [input.namespace, contentHash],
  );
  if (existing.rows.length > 0) {
    // Dedup hit on the live row. #12 closes the #3 obligation here: a more-restrictive SAME-ZONE re-upload is
    // RELABELED (invalidate-old + write-new at max), a differing-zone conflict is frozen + alertable, and an
    // equal/cooler re-upload is a plain dedup. resolveDedup owns that decision (one place, both dedup paths).
    return resolveDedup(query, input, rowToMemory(existing.rows[0]), opts);
  }

  // First real provider call goes through the gateway chokepoint (#46). One statement in → one vector out.
  const [embedding] = await embed([input.statement]);
  if (!embedding) throw new Error('embed returned no vector for the statement (refusing to write a null embedding)');

  const inserted = await query(
    `INSERT INTO memories
       (namespace, zone, sensitivity_level, type, statement, content_hash, provenance, embedding_model, embedding_version, embedding)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10::vector)
     ON CONFLICT (namespace, content_hash) WHERE status = 'active' DO NOTHING
     RETURNING ${SELECT_COLS}`,
    [
      input.namespace,
      input.zone,
      input.sensitivityLevel,
      input.type,
      input.statement,
      contentHash,
      JSON.stringify(input.provenance), // refs only — Provenance carries no raw content (§11.10)
      EMBEDDING_MODEL,
      EMBEDDING_VERSION,
      `[${embedding.join(',')}]`,
    ],
  );

  // ON CONFLICT DO NOTHING returns zero rows ⇒ a concurrent writer inserted the same (namespace, content_hash)
  // between our pre-SELECT and this INSERT (the TOCTOU window #3 deferred to the DB). The DB held the line —
  // one active row exists. Re-read the WINNER's row and return it truthfully as a dedup, exactly like the
  // fast path. The wasted embed on the losing side is the only cost of the race; correctness is preserved.
  if (inserted.rows.length === 0) {
    const winner = await query(
      `SELECT ${SELECT_COLS} FROM memories WHERE namespace = $1 AND content_hash = $2 AND status = 'active' LIMIT 1`,
      [input.namespace, contentHash],
    );
    if (winner.rows.length === 0) {
      // The active row was invalidated (#12) in the sliver between the conflict and this read. Vanishingly
      // rare and #12 isn't built yet — fail LOUDLY rather than fabricate a row (no silent failure).
      throw new Error(
        'writeMemory: ON CONFLICT race — the conflicting active row vanished before re-read (concurrent invalidation?). ' +
          'Refusing to return a fabricated result.',
      );
    }
    return resolveDedup(query, input, rowToMemory(winner.rows[0]), opts);
  }

  return { memory: rowToMemory(inserted.rows[0]), deduped: false, labelConflict: false, typeConflict: false, relabeled: false };
}

/**
 * Resolve a dedup hit against the stored live row — the #3 obligation, closed (#12). Three outcomes:
 *   • differing zone (alone or with higher sensitivity) → FREEZE the stored row (no auto-union/auto-move: zones
 *     are unordered, a union BROADENS access and an auto-move silently reclassifies / lets an attacker nuke a
 *     memory by re-uploading it under another zone). ATOMICALLY (one txn): append an ALERTABLE
 *     `memory.relabel.zone_conflict` audit event (tamper-evidence) AND enqueue a `review_queue` row
 *     kind='sensitivity_broaden' (the triage work-item) — both, or neither. labelConflict stays true. The
 *     PRODUCER is wired here; ⚠ FORWARD OBLIGATION (recorded on #12): the review_queue DRAIN/consumer lands with
 *     #25/#33 — until then items accumulate pending. Do not mistake the enqueue for a closed loop.
 *   • same-zone sensitivity escalation → RELABEL via supersede() at max(sensitivity) (§5 max-of-sources, §4.4).
 *   • same-zone equal/lower → plain dedup (stored is already at least as restrictive).
 */
async function resolveDedup(
  query: QueryFn,
  input: WriteMemoryInput,
  stored: WrittenMemory,
  opts: WriteOpts,
): Promise<WriteResult> {
  const typeConflict = input.type !== stored.type; // surfaced, never silently swallowed (type-supersession deferred)
  const zoneDiffers = input.zone !== stored.zone;
  const sensitivityEscalation = input.sensitivityLevel > stored.sensitivityLevel;

  if (zoneDiffers) {
    // refs/scalars + deltas ONLY — zone labels, sensitivity ordinals, a memory id ref; never the statement (§11.10).
    const deltas = {
      memoryId: stored.id,
      storedZone: stored.zone,
      incomingZone: input.zone,
      storedSensitivity: stored.sensitivityLevel,
      incomingSensitivity: input.sensitivityLevel,
    };
    await runAtomic(query, opts, async (q) => {
      // Tamper-evidence (audit chain) AND the triage work-item (review_queue) commit together, or not at all.
      await appendAuditInTx(q, {
        actor: null,
        action: 'memory.relabel.zone_conflict',
        targetRef: `memory:${stored.id}`,
        metadata: deltas,
      });
      await q(`INSERT INTO review_queue (kind, payload) VALUES ('sensitivity_broaden', $1::jsonb)`, [JSON.stringify(deltas)]);
    });
    console.warn(
      `[writeMemory] zone conflict on dedup — stored memory ${stored.id} FROZEN + enqueued for review (no ` +
        `auto-relabel across zones; zones are unordered so there is no fail-closed union). The review_queue DRAIN ` +
        `is #25/#33. stored zone=${stored.zone} incoming zone=${input.zone}`,
    );
    return { memory: stored, deduped: true, labelConflict: true, typeConflict, relabeled: false };
  }

  if (sensitivityEscalation) {
    // Same zone, higher sensitivity → raise the wall. STORED provenance/trustLevel is KEPT, not the re-upload's:
    // identical content is corroboration, not a replacement, and taking the incoming provenance could silently
    // DOWNGRADE trust (which gates semantic promotion, §5 anti-poisoning). Multi-source union stays #17.
    const maxSensitivity = Math.max(input.sensitivityLevel, stored.sensitivityLevel) as SensitivityLevel;
    const newRow = await supersede(
      query,
      stored.id,
      {
        type: stored.type,
        namespace: stored.namespace,
        zone: stored.zone,
        sensitivityLevel: maxSensitivity,
        statement: input.statement,
        provenance: stored.provenance,
      },
      { code: 'relabel_restrictive_reupload' },
      opts,
    );
    return { memory: newRow, deduped: true, labelConflict: false, typeConflict, relabeled: true };
  }

  // Equal/cooler same-zone re-upload — stored is already at least as restrictive; nothing to do.
  return { memory: stored, deduped: true, labelConflict: false, typeConflict, relabeled: false };
}

export interface IngestSopInput {
  namespace: Namespace;
  statement: string; // the SOP text
  sourceRef: string; // a reference to the upload (a ref, NOT the content)
  zone?: Zone; // overridable; defaults to a deliberate, non-permissive label
  sensitivityLevel?: SensitivityLevel; // overridable
  author?: string;
  capturedAt?: string; // ISO; caller supplies (the engine has no ambient clock here)
}

/**
 * Manual SOP upload → a `procedural` memory. A hand-uploaded SOP is HIGH trust (§5 anti-poisoning).
 * Defaults are DELIBERATE, not most-permissive-by-accident: a general-zone, sensitivity-1 SOP is the common
 * case (process docs are broadly readable), and both are explicit + overridable for anything more restricted.
 */
export async function ingestSop(
  query: QueryFn,
  input: IngestSopInput,
  opts: WriteOpts = {},
): Promise<WriteResult> {
  const provenance: Provenance = {
    sourceRefs: [input.sourceRef],
    capturedAt: input.capturedAt ?? new Date().toISOString(),
    trustLevel: 'high',
    ...(input.author !== undefined ? { author: input.author } : {}),
  };
  const result = await writeMemory(
    query,
    {
      type: 'procedural',
      namespace: input.namespace,
      zone: input.zone ?? 'general',
      sensitivityLevel: input.sensitivityLevel ?? 1,
      statement: input.statement,
      provenance,
    },
    opts,
  );

  if (result.labelConflict) {
    // Since #12, a more-restrictive SAME-ZONE re-upload is RELABELED (result.relabeled), so labelConflict here
    // means ONLY the unresolvable case: a differing ZONE. The stored row is FROZEN (no fail-closed union across
    // unordered zones); writeMemory already audited + enqueued a sensitivity_broaden review item (drain: #25/#33).
    // Refs-only — never the statement.
    console.warn(
      `[ingestSop] zone conflict on dedup — stored memory ${result.memory.id} FROZEN + enqueued for review ` +
        `(drain: #25/#33): source=${input.sourceRef} requested zone=${input.zone ?? 'general'} ` +
        `but stored zone=${result.memory.zone}`,
    );
  }
  if (result.typeConflict) {
    // The same text already exists as a DIFFERENT type — surfaced, never silently returned as 'procedural'.
    console.warn(
      `[ingestSop] type conflict on dedup — stored type kept (see #12): ` +
        `source=${input.sourceRef} requested type=procedural but stored memory ${result.memory.id} is type=${result.memory.type}`,
    );
  }
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// #12 — invalidate-don't-overwrite + supersession. The atomicity policy mirrors appendAudit: a transaction
// runner is REQUIRED in production (a crash mid-pair would leave a fact with zero active rows = silent data
// loss, or two = a leak); the unlocked path is tolerated only under the test runner (single-threaded).
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Run `fn` atomically. With a `transaction` runner → on its single backend (invalidate + write + link + the
 *  in-txn audit append all commit/roll back together). Else under the test runner / `unsafeUnlocked` → unlocked
 *  on `query` (single-threaded, can't race). Else (prod, no runner) → throw loud rather than risk a torn pair. */
async function runAtomic<T>(query: QueryFn, opts: WriteOpts, fn: (q: QueryFn) => Promise<T>): Promise<T> {
  if (opts.transaction) return opts.transaction(fn);
  if (opts.unsafeUnlocked || underTestRunner()) return fn(query);
  throw new Error(
    'memory store: no transaction runner — an invalidate/supersede pair (and its chained audit append) must be ' +
      'ATOMIC, else a crash leaves a fact with zero active rows (silent loss) or two (leak). Pass `transaction` ' +
      'in production; the unlocked path is tolerated only under the test runner or with explicit `unsafeUnlocked`.',
  );
}

/** Flip a live row active→invalidated within the caller's txn `q`: set valid_to + the free-text reason note,
 *  guarded on status='active'. Returns false if no live row matched (caller decides whether that's an error). */
async function invalidateRow(q: QueryFn, id: string, note: string | undefined): Promise<boolean> {
  const upd = await q(
    `UPDATE memories SET status = 'invalidated', valid_to = now(), invalidated_reason = $2
      WHERE id = $1 AND status = 'active'
      RETURNING id`,
    [id, note ?? null],
  );
  return upd.rows.length > 0;
}

/**
 * Invalidate-don't-overwrite (§4.4): flip status→invalidated + valid_to=now(), persist the reason note, and
 * append a refs-only `memory.invalidated` event to the #11 audit chain — ATOMICALLY (the mutation can't land
 * without its audit, nor vice versa). The history row is NEVER otherwise mutated or deleted. A missing or
 * already-invalidated row THROWS (no silent no-op — double-invalidation would corrupt valid_to).
 *
 * This is the reusable primitive `supersede()` and #30 (consolidation) build on — not forked.
 */
export async function invalidate(
  query: QueryFn,
  id: string,
  reason: InvalidationReason,
  opts: WriteOpts = {},
): Promise<void> {
  await runAtomic(query, opts, async (q) => {
    const ok = await invalidateRow(q, id, reason.note);
    if (!ok) {
      throw new Error(`invalidate: memory ${id} not found or already invalidated (no silent no-op)`);
    }
    // refs/scalars ONLY: the closed-vocab code + a memory ref. The free-text note lives in the column, not here.
    await appendAuditInTx(q, {
      actor: null,
      action: 'memory.invalidated',
      targetRef: `memory:${id}`,
      metadata: { code: reason.code },
    });
  });
}

/**
 * Supersede: atomically invalidate the OLD row and write a NEW active row carrying the same content slot, linked
 * NEW→OLD via a typed `memory_links` kind='supersedes' edge (from=successor, to=invalidated — reads "new
 * supersedes old"). The reusable supersession PRIMITIVE: #12's relabel and #30's consolidation both call it.
 *
 * ORDERING: invalidate-old happens BEFORE write-new so the partial-unique slot (namespace, content_hash WHERE
 * status='active') is free for the successor. The embed runs FIRST, OUTSIDE the txn — a network call must never
 * be held under the audit advisory lock. A non-active `oldId` THROWS (never a half-applied supersession).
 */
export async function supersede(
  query: QueryFn,
  oldId: string,
  newInput: WriteMemoryInput,
  reason: InvalidationReason,
  opts: WriteOpts = {},
): Promise<WrittenMemory> {
  const embed = opts.embed ?? gatewayEmbed;

  // Fail-closed on provenance, same as writeMemory (anti-poisoning §5) — refuse an unrated successor.
  const trust = newInput.provenance?.trustLevel;
  if (trust !== 'high' && trust !== 'low') {
    throw new Error(
      `supersede: provenance.trustLevel must be 'high' or 'low' (got ${JSON.stringify(trust)}) — ` +
        'refusing a fail-open write with an unrated source (anti-poisoning, §5).',
    );
  }

  const contentHash = contentHashOf(newInput.statement);
  // Embed BEFORE the transaction — never hold the audit advisory lock across a provider network call.
  const [embedding] = await embed([newInput.statement]);
  if (!embedding) throw new Error('supersede: embed returned no vector for the new statement (refusing a null embedding)');

  return runAtomic(query, opts, async (q) => {
    // 1. Invalidate the old row (frees the active slot). Must be currently active.
    const ok = await invalidateRow(q, oldId, reason.note);
    if (!ok) {
      throw new Error(`supersede: memory ${oldId} not found or already invalidated (refusing a half-applied supersession)`);
    }

    // 2. Insert the new active row. The slot is free, so a remaining ON CONFLICT would mean a CONCURRENT active
    //    row exists (a real anomaly inside this txn) — fail loud rather than fabricate.
    const inserted = await q(
      `INSERT INTO memories
         (namespace, zone, sensitivity_level, type, statement, content_hash, provenance, embedding_model, embedding_version, embedding)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10::vector)
       ON CONFLICT (namespace, content_hash) WHERE status = 'active' DO NOTHING
       RETURNING ${SELECT_COLS}`,
      [
        newInput.namespace,
        newInput.zone,
        newInput.sensitivityLevel,
        newInput.type,
        newInput.statement,
        contentHash,
        JSON.stringify(newInput.provenance),
        EMBEDDING_MODEL,
        EMBEDDING_VERSION,
        `[${embedding.join(',')}]`,
      ],
    );
    if (inserted.rows.length === 0) {
      throw new Error(
        `supersede: a concurrent active row already holds (${newInput.namespace}, ${contentHash}) after invalidating ` +
          `${oldId} — refusing to fabricate a successor (the txn rolls back, restoring the original).`,
      );
    }
    const newRow = rowToMemory(inserted.rows[0]);

    // 3. Typed supersession edge — NEW supersedes OLD (the invariant: memory_links, not a flat source_refs[]).
    await q(`INSERT INTO memory_links (from_id, to_id, kind) VALUES ($1, $2, 'supersedes')`, [newRow.id, oldId]);

    // 4. Audit, in-txn (refs/scalars only): the change is durable + tamper-evident with its mutation.
    await appendAuditInTx(q, {
      actor: null,
      action: 'memory.superseded',
      targetRef: `memory:${oldId}`,
      metadata: { code: reason.code, oldId, newId: newRow.id, zone: newRow.zone, sensitivity: newRow.sensitivityLevel },
    });

    return newRow;
  });
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// Inspector — full lifecycle history incl. invalidated rows, with the supersession chain. READ-ONLY.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface MemoryHistoryRow {
  id: string;
  namespace: Namespace;
  zone: Zone;
  sensitivityLevel: SensitivityLevel;
  type: WriteMemoryInput['type'];
  statement: string;
  status: 'active' | 'invalidated';
  validFrom: string;
  validTo: string | null;
  invalidatedReason: string | null;
  createdAt: string;
  /** The row this one supersedes (its invalidated predecessor), or null. Populated ONLY when that row is itself
   *  visible under the predicate — so an edge never leaks the existence of a permission-hidden neighbour. */
  supersedesId: string | null;
  /** The row that supersedes this one (its successor), or null. Same visibility rule. */
  supersededById: string | null;
}

export interface HistoryOpts {
  /** #13 SEAM (REQUIRED in prod): the clearance+namespace WHERE fragment over `memories m`, numbering from $3
   *  ($1 = seed id, $2 = depth cap). The inspector surfaces invalidated rows that still carry zone/sensitivity,
   *  so it MUST be permission-filtered exactly like retrieve() — it is NOT a backdoor. Default 'true' is
   *  tolerated only under the test runner (mirroring appendAudit); prod without a predicate throws.
   *  Admin/clearance gating of the surface itself is a forward obligation on #37/#47. */
  predicate?: string;
  predicateParams?: unknown[];
  /** Cycle-cap for the recursive chain walk (defensive; supersession is a DAG in practice). */
  maxDepth?: number;
}

const HISTORY_DEFAULT_MAX_DEPTH = 256;

/**
 * Walk the supersession chain through `seedId` (both directions of kind='supersedes' edges) and return every
 * memory on it that the caller may see, oldest-first. The recursive CTE is CYCLE-GUARDED (UNION + a visited
 * path array + a depth cap) so a malformed edge can't loop forever. Permission filtering happens on the JOINed
 * `memories` rows; edges to permission-hidden rows are dropped, so neither the content NOR the id of a hidden
 * neighbour leaks through the chain shape (proven by the leak-probe test). READ-ONLY.
 */
export async function getMemoryHistory(query: QueryFn, seedId: string, opts: HistoryOpts = {}): Promise<MemoryHistoryRow[]> {
  const predicate = opts.predicate ?? 'true';
  const predicateParams = opts.predicateParams ?? [];
  if (predicate === 'true' && !underTestRunner()) {
    throw new Error(
      'getMemoryHistory: refusing an unfiltered (predicate="true") inspector read in production — it surfaces ' +
        'invalidated rows that still carry zone/sensitivity. Pass the clearance predicate (rbac.retrievalWhereSql, ' +
        'numbering from $3); the no-op default is tolerated only under the test runner.',
    );
  }
  const maxDepth = opts.maxDepth ?? HISTORY_DEFAULT_MAX_DEPTH;

  // 1. Resolve the chain ids (permission-free — edges carry no zone), then 2. fetch only the rows the caller may
  //    see. Splitting the walk from the filter keeps the CTE simple and the visibility check in one WHERE.
  const { rows } = await query(
    `WITH RECURSIVE chain(id, depth, path) AS (
        SELECT $1::uuid, 0, ARRAY[$1::uuid]
        UNION
        SELECT nbr.other, c.depth + 1, c.path || nbr.other
          FROM chain c
          JOIN LATERAL (
            SELECT to_id   AS other FROM memory_links WHERE from_id = c.id AND kind = 'supersedes'
            UNION
            SELECT from_id AS other FROM memory_links WHERE to_id   = c.id AND kind = 'supersedes'
          ) nbr ON true
         WHERE c.depth < $2 AND NOT (nbr.other = ANY(c.path))
      )
      SELECT m.id, m.namespace, m.zone, m.sensitivity_level, m.type, m.statement, m.status,
             m.valid_from, m.valid_to, m.invalidated_reason, m.created_at
        FROM memories m
        JOIN (SELECT DISTINCT id FROM chain) ch ON ch.id = m.id
       WHERE ${predicate}
       ORDER BY m.valid_from ASC`,
    [seedId, maxDepth, ...predicateParams],
  );

  const visible = new Set<string>(rows.map((r: any) => r.id));

  // Edges restricted to pairs where BOTH endpoints are visible — an edge to a hidden row is never surfaced
  // (no existence leak via an id). One query over the visible set.
  const ids = [...visible];
  const edges =
    ids.length === 0
      ? { rows: [] as any[] }
      : await query(
          `SELECT from_id, to_id FROM memory_links
            WHERE kind = 'supersedes' AND from_id = ANY($1::uuid[]) AND to_id = ANY($1::uuid[])`,
          [ids],
        );
  const supersedesOf = new Map<string, string>(); // successor → predecessor (from_id → to_id)
  const supersededByOf = new Map<string, string>(); // predecessor → successor (to_id → from_id)
  for (const e of edges.rows) {
    supersedesOf.set(e.from_id, e.to_id);
    supersededByOf.set(e.to_id, e.from_id);
  }

  return rows.map((r: any) => ({
    id: r.id,
    namespace: r.namespace,
    zone: r.zone,
    sensitivityLevel: r.sensitivity_level,
    type: r.type,
    statement: r.statement,
    status: r.status,
    validFrom: new Date(r.valid_from).toISOString(),
    validTo: r.valid_to ? new Date(r.valid_to).toISOString() : null,
    invalidatedReason: r.invalidated_reason ?? null,
    createdAt: new Date(r.created_at).toISOString(),
    supersedesId: supersedesOf.get(r.id) ?? null,
    supersededById: supersededByOf.get(r.id) ?? null,
  }));
}
