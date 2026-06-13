/**
 * AIOS shared domain types — defined once, used in the DB layer, the API, and the UI.
 * Canonical reference: AIOS_Brief.md. Section refs (§) point there unless noted.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Identity & permissions (§9 RBAC, §7.5 principal)
// ─────────────────────────────────────────────────────────────────────────────

/** Functional/departmental access label. Tenant-configurable; these are the defaults (§9.1). */
export type Zone = 'general' | 'finance' | 'hr' | 'legal' | 'exec' | (string & {});

/** Ordinal sensitivity, 1 (internal) … 5 (restricted). Comparable with `<=` (§9.1). */
export type SensitivityLevel = 1 | 2 | 3 | 4 | 5;

/** A user's clearance row — lives in the engine's authz layer, never Supabase Auth (§8.1a, §9.1). */
export interface Clearance {
  allowedZones: Zone[]; // empty ⇒ sees nothing (fail-closed)
  maxSensitivity: SensitivityLevel;
}

/** Who a run acts as. Fixed at trigger time, immutable down the delegation tree (§7.5). */
export type Principal =
  | { kind: 'user'; userId: string }
  | { kind: 'service'; serviceId: string }; // system cron / webhook — org connections only, no per-user tokens

/** Namespace scopes memory to a subject. Resolved before retrieval, never post-filtered (§4.3). */
export type Namespace = 'org' | `client:${string}` | `project:${string}`;

// ─────────────────────────────────────────────────────────────────────────────
// Memory model (§4)
// ─────────────────────────────────────────────────────────────────────────────

export type MemoryType = 'working' | 'episodic' | 'semantic' | 'procedural';
export type MemoryStatus = 'active' | 'invalidated';

/** Optional structured slot for deterministic supersession/dedup (§4.5). Free-text facts omit it. */
export interface MemorySlot {
  entityRef: string; // canonical entity id (§4.10 Identity Map)
  attribute: string;
  value: string;
}

export interface Provenance {
  sourceRefs: string[]; // references, never content (§11.10)
  author?: string;
  capturedAt: string; // ISO
  connectorId?: string;
  trustLevel: 'high' | 'low'; // gates promotion to semantic memory (§5 anti-poisoning, §10.1)
}

/** A row on the `memories` table — full lifecycle. Surfaced as "I know this" (§4.2). */
export interface Memory {
  id: string;
  type: MemoryType;
  status: MemoryStatus;
  namespace: Namespace;
  zone: Zone; // = union of source zones, but stored as the effective access label (§5, §9.1)
  sensitivityLevel: SensitivityLevel; // = max of source levels (§5)
  statement: string;
  slot?: MemorySlot;
  provenance: Provenance;
  contentHash: string; // tier-1 exact-dup guard (§5)
  utilityScore?: number; // computed by the decay cron, not on write (§4.6)
  retrievalCount: number;
  lastRetrievedAt?: string;
  validFrom: string;
  validTo?: string | null; // null ⇒ active (§4.4 invalidate-don't-overwrite)
  embeddingModel: string; // pinned; mixing vector spaces is forbidden (§4.7)
  embeddingVersion: string;
  createdAt: string;
}

/** A row on the `chunks` table — RAG-in-place, no lifecycle but SAME permissions (§4.2, §9.1). */
export interface Chunk {
  id: string;
  namespace: Namespace;
  zone: Zone; // chunks ARE permission-filtered — "no lifecycle" ≠ "no permissions" (§4.2)
  sensitivityLevel: SensitivityLevel;
  text: string;
  provenance: Provenance;
  embeddingModel: string;
  embeddingVersion: string;
  createdAt: string;
  expiresAt: string; // chunk_ttl_days, default 90 (§4.2)
}

// ─────────────────────────────────────────────────────────────────────────────
// Retrieval & provenance-labelled answers (§4.7, §6)
// ─────────────────────────────────────────────────────────────────────────────

export type ProvenanceLabel = 'memory' | 'live' | 'failed-fetch' | 'general-inference';

/** A single grounded claim in an answer — per-claim, not per-span (§6). */
export interface Claim {
  text: string;
  label: ProvenanceLabel;
  sourceId?: string; // memory id / live-fetch id; absent ⇒ general-inference by exclusion
  asOf?: string; // for "I know this" / "couldn't reach source"
}

export interface Answer {
  claims: Claim[];
  abstained: boolean; // below the relevance floor ⇒ abstain + log a miss (§6)
}

export interface RetrievalResult {
  memories: Memory[];
  chunks: Chunk[];
  score: number; // calibrated floor score (reranker target / pre-fusion cosine v1) — NOT the RRF sum (§4.7)
}

// ─────────────────────────────────────────────────────────────────────────────
// Agents, runs, tracing (§7, §11.4)
// ─────────────────────────────────────────────────────────────────────────────

export type TriggerKind = 'chat' | 'individual-cron' | 'system-cron' | 'webhook' | 'system-event';

/** Durable execution state — survives a worker restart (§4.1). Distinct from working memory. */
export interface TaskState {
  id: string;
  status: 'running' | 'paused_awaiting_input' | 'completed' | 'failed';
  principal: Principal;
  trigger: TriggerKind;
  context: unknown; // accumulated agent context
  openQuestion?: string; // set when paused on a clarification_request (§7.3)
  createdAt: string;
  updatedAt: string;
}

/** One structured trace span. Powers activity log, cost + quality monitors (§6.9, §11). */
export interface TraceSpan {
  id: string;
  taskId: string;
  agent?: string;
  principal: Principal;
  trigger: TriggerKind;
  kind: 'model' | 'tool' | 'retrieval';
  model?: string; // provider/model actually used (multi-model routing, §6.1)
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number;
  durationMs: number;
  rating?: number;
  // NB: spans may include content for debugging but are short-TTL + permission-scoped (§6.9). Audit log stays refs-only.
}

// ─────────────────────────────────────────────────────────────────────────────
// Inbox — the single push destination (§7.5)
// ─────────────────────────────────────────────────────────────────────────────

export type InboxItemType = 'brief' | 'report' | 'clarification_request' | 'alert' | 'suggestion';

export interface InboxItem {
  id: string;
  userId: string; // permission-scoped: only what this user is cleared to see
  type: InboxItemType;
  title: string;
  body: Claim[]; // provenance-labelled, like any answer
  taskId?: string; // set for clarification_request (answering resumes the task)
  createdAt: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Ingestion (§5)
// ─────────────────────────────────────────────────────────────────────────────

export type GateDecision =
  | 'drop' // Gate 1
  | 'fetch-live' // Gate 2 (deterministic, no LLM)
  | 'review' // Gate 2 miss on a structured connector / sensitivity (§5)
  | 'index-in-place' // Gate 3 NO/UNSURE → chunks
  | 'write-memory' // Gate 4 NO → memories
  | 'write-both'; // Gate 4 YES → SoR + episodic

/** One row of the ingestion-decision log — references + confidence, NOT content (§5, §11). */
export interface IngestionDecision {
  id: string;
  sourceRef: string;
  contentHash: string;
  connectorType: string;
  decision: GateDecision;
  classifierConfidence?: number; // for the sampled audit / false-drop rate (§11.8)
  decidedAt: string;
}
