/**
 * Drizzle schema (tech-stack §2). One Postgres (Supabase, pgvector built in) PER CLIENT.
 *
 * ⚠ SOURCE OF TRUTH = the raw SQL in `/migrations`, NOT this file. Drizzle here is TYPES + QUERY BUILDER
 *   only — we never run `drizzle-kit generate/push`. The DDL (HNSW opclasses, partial indexes, CHECK
 *   constraints, expand/contract semantics) is authored by hand in `migrations/*.sql`; this file MIRRORS it
 *   so inferred types flow into #8–#11. The `tests/core/schema-drift.test.ts` introspects a migrated DB and
 *   fails if any column here diverges from the migrated columns — that is what keeps the mirror honest.
 *
 * Every migration is EXPAND/CONTRACT — the shared image must tolerate schema N and N-1 (tech-stack §5.4).
 * Columns are aligned 1:1 with @aios/shared where a domain type exists (noted per table); the type-less
 * tables gain their @aios/shared type as their consuming issue builds (and the drift test a type↔Drizzle leg).
 */
import {
  pgTable,
  uuid,
  text,
  smallint,
  integer,
  doublePrecision,
  boolean,
  jsonb,
  bigserial,
  timestamp,
  vector,
  customType,
} from 'drizzle-orm/pg-core';
import type {
  Provenance,
  Principal,
  PausePayload,
  Claim,
  Suggestion,
  TriggerKind,
  TaskStatus,
  MemoryType,
  MemoryStatus,
  GateDecision,
} from '@aios/shared';

// Shorthand for the columns that repeat everywhere. timestamptz throughout (never naive timestamp).
const tstz = (name: string) => timestamp(name, { withTimezone: true });

// pgvector has a Drizzle helper; tsvector (the keyword-leg generated column, 0014/#13) does not — declare it.
// Query-builder type only; the column itself is GENERATED ALWAYS in the migration (the source of truth).
const tsvector = customType<{ data: string }>({ dataType: () => 'tsvector' });

// ── memories ── full @aios/shared `Memory`. 0001 (base) + 0002 (type/provenance) + 0004 (lifecycle). ───────
export const memories = pgTable('memories', {
  id: uuid('id').primaryKey().defaultRandom(),
  namespace: text('namespace').notNull(),
  zone: text('zone').notNull(),
  sensitivityLevel: smallint('sensitivity_level').notNull(),
  statement: text('statement').notNull(),
  contentHash: text('content_hash').notNull(),
  embeddingModel: text('embedding_model').notNull(),
  embeddingVersion: text('embedding_version').notNull(),
  embedding: vector('embedding', { dimensions: 1024 }).notNull(), // = EMBEDDING_DIM (#1); one-way door
  createdAt: tstz('created_at').notNull().defaultNow(),
  type: text('type').$type<Exclude<MemoryType, 'working'>>().notNull(), // 'working' never persists (§4.1)
  provenance: jsonb('provenance').$type<Provenance>().notNull(),
  status: text('status').$type<MemoryStatus>().notNull(),
  validFrom: tstz('valid_from').notNull(),
  validTo: tstz('valid_to'), // null ⇒ active (§4.4)
  invalidatedReason: text('invalidated_reason'), // #12: free-text WHY of an invalidation (0013); null while active
  entityRef: text('entity_ref'), // slot (§4.5) — all-or-nothing with attribute/slotValue (DB CHECK)
  attribute: text('attribute'),
  slotValue: text('slot_value'), // @aios/shared MemorySlot.value (column renamed to avoid the SQL keyword)
  utilityScore: doublePrecision('utility_score'), // computed by decay, not on write (§4.6)
  retrievalCount: integer('retrieval_count').notNull(),
  lastRetrievedAt: tstz('last_retrieved_at'),
  ts: tsvector('ts'), // 0014/#13: keyword leg — GENERATED ALWAYS from `statement` ('english'); nullable, no NOT NULL
});

// ── chunks ── full @aios/shared `Chunk`. 0001 (base) + 0004 (provenance). content_hash is an extra dedup
//    aid not present on the `Chunk` type (RAG-in-place); harmless, noted. ──────────────────────────────────
export const chunks = pgTable('chunks', {
  id: uuid('id').primaryKey().defaultRandom(),
  namespace: text('namespace').notNull(),
  zone: text('zone').notNull(),
  sensitivityLevel: smallint('sensitivity_level').notNull(),
  text: text('text').notNull(),
  contentHash: text('content_hash').notNull(),
  embeddingModel: text('embedding_model').notNull(),
  embeddingVersion: text('embedding_version').notNull(),
  embedding: vector('embedding', { dimensions: 1024 }).notNull(),
  createdAt: tstz('created_at').notNull().defaultNow(),
  expiresAt: tstz('expires_at').notNull(), // chunk_ttl_days, default 90 (§4.2)
  provenance: jsonb('provenance').$type<Provenance>().notNull(),
  ts: tsvector('ts'), // 0014/#13: keyword leg — GENERATED ALWAYS from `text` ('english'); nullable, no NOT NULL
});

// ── retrieval_misses ── 0003 (M0 read half). DB-only; #32/#50 add query_text + aggregation. ────────────────
export const retrievalMisses = pgTable('retrieval_misses', {
  id: uuid('id').primaryKey().defaultRandom(),
  namespace: text('namespace'), // nullable: #4 has no clearance/namespace yet (#13 fills it)
  queryHash: text('query_hash').notNull(),
  topScore: doublePrecision('top_score'), // null ⇒ empty candidate set
  createdAt: tstz('created_at').notNull().defaultNow(),
});

// ── memory_links ── 0005. TYPED edges (replaces flat source_refs string[]). DB-only. ────────────────────────
export const memoryLinks = pgTable('memory_links', {
  id: uuid('id').primaryKey().defaultRandom(),
  fromId: uuid('from_id').notNull(),
  toId: uuid('to_id').notNull(),
  kind: text('kind').$type<'derived_from' | 'supersedes' | 'consolidated_child' | 'corroborates'>().notNull(),
  createdAt: tstz('created_at').notNull().defaultNow(),
});

// ── connector_schemas ── 0006. Gate-2 registry. DB-only → type with #20. ────────────────────────────────────
export const connectorSchemas = pgTable('connector_schemas', {
  id: uuid('id').primaryKey().defaultRandom(),
  connectorType: text('connector_type').notNull(),
  version: text('version').notNull(),
  schema: jsonb('schema').notNull(),
  fetchedAt: tstz('fetched_at').notNull().defaultNow(),
});

// ── connections ── 0006. +trust_level → Provenance.trustLevel at routing time (§10.1). DB-only → type #20. ──
export const connections = pgTable('connections', {
  id: uuid('id').primaryKey().defaultRandom(),
  connectorType: text('connector_type').notNull(),
  scope: text('scope').$type<'org' | 'user'>().notNull(),
  ownerId: text('owner_id'), // null for org, set for user-scoped (DB CHECK enforces the match)
  trustLevel: text('trust_level').$type<'high' | 'low'>().notNull(),
  structured: boolean('structured').notNull(),
  live: boolean('live').notNull(),
  config: jsonb('config').notNull(), // refs/settings only — secrets in the vault, never here
  createdAt: tstz('created_at').notNull().defaultNow(),
});

// ── identity_map ── 0006. canonical entity ⇄ per-SoR external ids (§4.10). DB-only → type with #16. ─────────
export const identityMap = pgTable('identity_map', {
  id: uuid('id').primaryKey().defaultRandom(),
  canonicalId: uuid('canonical_id').notNull(),
  connectorType: text('connector_type').notNull(),
  externalId: text('external_id').notNull(),
  entityType: text('entity_type'),
  confidence: doublePrecision('confidence'),
  createdAt: tstz('created_at').notNull().defaultNow(),
});

// ── ingestion_log ── 0006. = @aios/shared `IngestionDecision` (refs + confidence, NEVER content). ───────────
export const ingestionLog = pgTable('ingestion_log', {
  id: uuid('id').primaryKey().defaultRandom(),
  sourceRef: text('source_ref').notNull(),
  contentHash: text('content_hash').notNull(),
  connectorType: text('connector_type').notNull(),
  decision: text('decision').$type<GateDecision>().notNull(),
  classifierConfidence: doublePrecision('classifier_confidence'),
  decidedAt: tstz('decided_at').notNull().defaultNow(),
});

// ── task_state ── 0007. = @aios/shared `TaskState`. ─────────────────────────────────────────────────────────
export const taskState = pgTable('task_state', {
  id: uuid('id').primaryKey().defaultRandom(),
  status: text('status').$type<TaskStatus>().notNull(),
  principal: jsonb('principal').$type<Principal>().notNull(), // immutable down the delegation tree (#28)
  trigger: text('trigger').$type<TriggerKind>().notNull(),
  context: jsonb('context').notNull(),
  pause: jsonb('pause').$type<PausePayload>(), // set when paused
  version: integer('version').notNull(), // optimistic lock (#27)
  leaseUntil: tstz('lease_until'),
  createdAt: tstz('created_at').notNull().defaultNow(),
  updatedAt: tstz('updated_at').notNull().defaultNow(),
});

// ── standing_approvals ── 0007. = @aios/shared `StandingApproval`. ─────────────────────────────────────────
export const standingApprovals = pgTable('standing_approvals', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: text('user_id').notNull(),
  actionType: text('action_type').notNull(),
  scope: text('scope'),
  expiresAt: tstz('expires_at'),
  createdAt: tstz('created_at').notNull().defaultNow(),
});

// ── inbox_items ── 0007. = @aios/shared `InboxItem`. body is a provenance-labelled Claim[]. ─────────────────
export const inboxItems = pgTable('inbox_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: text('user_id').notNull(),
  type: text('type').$type<'brief' | 'report' | 'clarification_request' | 'alert' | 'suggestion'>().notNull(),
  title: text('title').notNull(),
  body: jsonb('body').$type<Claim[]>().notNull(),
  taskId: uuid('task_id'), // set for clarification_request (FK → task_state, ON DELETE SET NULL)
  createdAt: tstz('created_at').notNull().defaultNow(),
});

// ── threads ── 0008. = @aios/shared `Thread`. ──────────────────────────────────────────────────────────────
export const threads = pgTable('threads', {
  id: uuid('id').primaryKey().defaultRandom(),
  ownerId: text('owner_id').notNull(),
  title: text('title'),
  createdAt: tstz('created_at').notNull().defaultNow(),
});

// ── messages ── 0008. = @aios/shared `Message`. source of `recentThread` (§7.1). ───────────────────────────
export const messages = pgTable('messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  threadId: uuid('thread_id').notNull(),
  role: text('role').$type<'user' | 'brain'>().notNull(),
  content: text('content').notNull(),
  answerRef: text('answer_ref'),
  principal: jsonb('principal').$type<Principal>().notNull(),
  createdAt: tstz('created_at').notNull().defaultNow(),
});

// ── user_clearance ── 0009. = @aios/shared `Clearance` (+ principal_id). MISSING row ⇒ deny (#9). ───────────
export const userClearance = pgTable('user_clearance', {
  principalId: text('principal_id').primaryKey(),
  allowedZones: text('allowed_zones').array().notNull(), // empty {} ⇒ sees nothing (fail-closed)
  maxSensitivity: smallint('max_sensitivity').notNull(),
  allowedNamespaces: text('allowed_namespaces').array(), // 0014/#13: NULL/'{}' ⇒ denyAll; nullable, NO default (force-explicit)
  createdAt: tstz('created_at').notNull().defaultNow(),
  updatedAt: tstz('updated_at').notNull().defaultNow(),
});

// ── roles ── 0009. DB-only → type with #9. ─────────────────────────────────────────────────────────────────
export const roles = pgTable('roles', {
  id: text('id').primaryKey(),
  defaultAllowedZones: text('default_allowed_zones').array().notNull(),
  defaultMaxSensitivity: smallint('default_max_sensitivity').notNull(),
  allowedAgents: text('allowed_agents').array().notNull(),
  defaultAllowedNamespaces: text('default_allowed_namespaces').array().notNull(), // 0014/#13: provisioning symmetry
  createdAt: tstz('created_at').notNull().defaultNow(),
});

// ── system_config ── 0010. DB-only → type with #8. namespace null ⇒ org default. ──────────────────────────
export const systemConfig = pgTable('system_config', {
  key: text('key').notNull(),
  namespace: text('namespace'), // null ⇒ org default; set ⇒ client/project override
  value: jsonb('value').$type<number | string>().notNull(),
  updatedAt: tstz('updated_at').notNull().defaultNow(),
  updatedBy: text('updated_by'),
});

// ── feedback ── 0010. = @aios/shared `Feedback`. ──────────────────────────────────────────────────────────
export const feedback = pgTable('feedback', {
  id: uuid('id').primaryKey().defaultRandom(),
  targetId: text('target_id').notNull(),
  userId: text('user_id').notNull(),
  kind: text('kind').$type<'up' | 'down_not_useful' | 'down_wrong'>().notNull(),
  createdAt: tstz('created_at').notNull().defaultNow(),
});

// ── suggestions ── 0010. = @aios/shared `Suggestion`. ─────────────────────────────────────────────────────
export const suggestions = pgTable('suggestions', {
  id: uuid('id').primaryKey().defaultRandom(),
  targetConfigKey: text('target_config_key'),
  current: jsonb('current').$type<number | string>(),
  proposed: jsonb('proposed').$type<number | string>(),
  evidence: jsonb('evidence').$type<Suggestion['evidence']>().notNull(),
  status: text('status').$type<Suggestion['status']>().notNull(),
  createdAt: tstz('created_at').notNull().defaultNow(),
});

// ── review_queue ── 0010. DB-only → type with #25/#33. ────────────────────────────────────────────────────
export const reviewQueue = pgTable('review_queue', {
  id: uuid('id').primaryKey().defaultRandom(),
  kind: text('kind').$type<'memory_proposal' | 'consolidation_review' | 'sensitivity_broaden'>().notNull(),
  payload: jsonb('payload').notNull(),
  status: text('status').$type<'pending' | 'approved' | 'rejected'>().notNull(),
  createdAt: tstz('created_at').notNull().defaultNow(),
  resolvedAt: tstz('resolved_at'),
});

// ── monitors ── 0010. DB-only → type with #45. ────────────────────────────────────────────────────────────
export const monitors = pgTable('monitors', {
  id: text('id').primaryKey(),
  expectedCadence: text('expected_cadence').notNull(),
  lastHeartbeatAt: tstz('last_heartbeat_at'),
  createdAt: tstz('created_at').notNull().defaultNow(),
});

// ── metrics_rollup ── 0010. DB-only → type with #50. ──────────────────────────────────────────────────────
export const metricsRollup = pgTable('metrics_rollup', {
  id: uuid('id').primaryKey().defaultRandom(),
  metric: text('metric').notNull(),
  namespace: text('namespace'),
  bucket: tstz('bucket').notNull(),
  value: doublePrecision('value').notNull(),
  createdAt: tstz('created_at').notNull().defaultNow(),
});

// ── traces ── 0010. = @aios/shared `TraceSpan`. short-TTL, permission-scoped (§6.9). ──────────────────────
export const traces = pgTable('traces', {
  id: uuid('id').primaryKey().defaultRandom(),
  taskId: uuid('task_id').notNull(),
  agent: text('agent'),
  principal: jsonb('principal').$type<Principal>().notNull(),
  trigger: text('trigger').$type<TriggerKind>().notNull(),
  kind: text('kind').$type<'model' | 'tool' | 'retrieval'>().notNull(),
  model: text('model'),
  tokensIn: integer('tokens_in'),
  tokensOut: integer('tokens_out'),
  costUsd: doublePrecision('cost_usd'),
  durationMs: integer('duration_ms').notNull(),
  rating: doublePrecision('rating'),
  // ── clearance tag (#11, 0012) — same names as memories/chunks so retrievalWhereSql filters traces verbatim.
  // Tagged at write with the CONTENT's clearance; fail-closed sentinels keep an untagged span invisible. ──
  zone: text('zone').notNull(),
  sensitivityLevel: smallint('sensitivity_level').notNull(),
  namespace: text('namespace').notNull(),
  createdAt: tstz('created_at').notNull().defaultNow(),
});

// ── audit_log ── 0010. DB-only → type with #11. append-only, refs-not-content, +prev_hash chain. ──────────
export const auditLog = pgTable('audit_log', {
  id: uuid('id').primaryKey().defaultRandom(),
  seq: bigserial('seq', { mode: 'number' }).notNull(),
  actor: text('actor'),
  action: text('action').notNull(),
  targetRef: text('target_ref'),
  metadata: jsonb('metadata').notNull(),
  prevHash: text('prev_hash'),
  hash: text('hash').notNull(),
  // The exact canonical bytes hashed at write (#11, 0012) — verifyChain recomputes from this text, never from
  // a jsonb-roundtripped row (no float-normalisation false-tamper). Nullable for the expand/contract window.
  hashInput: text('hash_input'),
  createdAt: tstz('created_at').notNull().defaultNow(),
});

// ── config_proposals ── 0011. The gated approval queue for quality-affecting config changes (#8). ─────────
// Applied values live in `system_config`; a PENDING qualityAffecting change parks here until approved, so
// `getConfig` (reads system_config only) cannot see it. One open proposal per (key, namespace) — see the
// partial unique index in the migration. Bounds/quality live in KNOWN_KEYS (code), never in a row.
export const configProposals = pgTable('config_proposals', {
  id: uuid('id').primaryKey().defaultRandom(),
  key: text('key').notNull(),
  namespace: text('namespace'), // null ⇒ org-scope proposal; set ⇒ client/project override
  currentValue: jsonb('current_value').$type<number | string>(),
  proposedValue: jsonb('proposed_value').$type<number | string>().notNull(),
  evidence: text('evidence').notNull(),
  status: text('status').$type<'pending' | 'approved' | 'rejected' | 'superseded'>().notNull(),
  createdAt: tstz('created_at').notNull().defaultNow(),
  createdBy: text('created_by'),
  resolvedAt: tstz('resolved_at'),
  resolvedBy: text('resolved_by'),
});

/** Every table, for the drift test + the typed drizzle instance. Add new tables here as migrations land. */
export const schema = {
  memories,
  chunks,
  retrievalMisses,
  memoryLinks,
  connectorSchemas,
  connections,
  identityMap,
  ingestionLog,
  taskState,
  standingApprovals,
  inboxItems,
  threads,
  messages,
  userClearance,
  roles,
  systemConfig,
  feedback,
  suggestions,
  reviewQueue,
  monitors,
  metricsRollup,
  traces,
  auditLog,
  configProposals,
} as const;

// Inferred row types flow into #8–#11 (select shapes; insert shapes via `$inferInsert`).
export type MemoryRow = typeof memories.$inferSelect;
export type ChunkRow = typeof chunks.$inferSelect;
export type TaskStateRow = typeof taskState.$inferSelect;
export type ThreadRow = typeof threads.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;
export type InboxItemRow = typeof inboxItems.$inferSelect;
export type UserClearanceRow = typeof userClearance.$inferSelect;
export type TraceRow = typeof traces.$inferSelect;
export type AuditRow = typeof auditLog.$inferSelect; // #11 — the typed audit read shape (refs/scalars only)
