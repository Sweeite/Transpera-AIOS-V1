/**
 * Memory store — write / invalidate (NEVER overwrite, §4.4). Provenance, sensitivity, namespace on write (§5).
 */
import { createHash } from 'node:crypto';
import type { Memory, Namespace, Provenance, SensitivityLevel, Zone } from '@aios/shared';
import { embed as gatewayEmbed, EMBEDDING_MODEL, EMBEDDING_VERSION, type Embedder } from '../harness/gateway.js';

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
 * Dedup is NAMESPACE-SCOPED and check-then-insert (a SELECT, then skip if found). That is a TOCTOU race —
 * fine for M0's single writer, but #7 adds the DB-level guard (partial UNIQUE (namespace, content_hash)
 * WHERE status='active' + ON CONFLICT here) once `status` exists; until then the duplicate is caught here.
 */
export async function writeMemory(
  query: QueryFn,
  input: WriteMemoryInput,
  opts: { embed?: Embedder } = {},
): Promise<WriteResult> {
  const embed = opts.embed ?? gatewayEmbed;
  const contentHash = contentHashOf(input.statement);

  // Namespace-scoped dedup: if an identical row already exists, skip the write AND the embed entirely.
  const existing = await query(
    `SELECT ${SELECT_COLS} FROM memories WHERE namespace = $1 AND content_hash = $2 LIMIT 1`,
    [input.namespace, contentHash],
  );
  if (existing.rows.length > 0) {
    // Return the EXISTING row truthfully (deduped:true) — the caller sees the STORED zone/sensitivity, never a
    // false confirmation that its requested labels were applied. Re-classifying an existing memory (a re-upload
    // declaring a MORE restrictive label) is a supersession/relabel decision that belongs to #12. Until then we
    // do NOT silently swallow it: flag labelConflict so a more-restrictive re-upload is DETECTABLE, not a silent
    // under-classification (over-sharing, principle #2). Fail-closed posture in the interim.
    const stored = rowToMemory(existing.rows[0]);
    const labelConflict = input.sensitivityLevel > stored.sensitivityLevel || input.zone !== stored.zone;
    return { memory: stored, deduped: true, labelConflict };
  }

  // First real provider call goes through the gateway chokepoint (#46). One statement in → one vector out.
  const [embedding] = await embed([input.statement]);
  if (!embedding) throw new Error('embed returned no vector for the statement (refusing to write a null embedding)');

  const inserted = await query(
    `INSERT INTO memories
       (namespace, zone, sensitivity_level, type, statement, content_hash, provenance, embedding_model, embedding_version, embedding)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10::vector)
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
  return { memory: rowToMemory(inserted.rows[0]), deduped: false, labelConflict: false };
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
  opts: { embed?: Embedder } = {},
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
    // LOUD, refs-only (no content): a more-restrictive re-upload deduped onto a more-permissive stored row.
    // The restriction was NOT applied — surface it so the caller can't assume it was. Full fix is #12.
    // (Interim signal — the alertable trace lands with the trace/monitor wiring; never log the statement.)
    console.warn(
      `[ingestSop] label conflict on dedup — restriction NOT applied (see #12): ` +
        `source=${input.sourceRef} requested zone=${input.zone ?? 'general'}/s${input.sensitivityLevel ?? 1} ` +
        `but stored memory ${result.memory.id} is zone=${result.memory.zone}/s${result.memory.sensitivityLevel}`,
    );
  }
  return result;
}

/** Invalidate, don't overwrite: set valid_to = now(), status = 'invalidated'. History stays queryable (§4.4). */
export async function invalidate(_memoryId: string, _reason: string): Promise<void> {
  // TODO (#12)
  throw new Error('TODO: invalidate');
}
