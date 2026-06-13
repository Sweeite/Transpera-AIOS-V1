/**
 * Drizzle schema (tech-stack §2). One Postgres (Supabase, pgvector built in) PER CLIENT.
 * Every migration is EXPAND/CONTRACT — the shared image must tolerate schema N and N-1 (tech-stack §5.4).
 *
 * Tables (stubs below — fill columns to match @aios/shared types):
 *   memories          — typed, full lifecycle; +entity_ref/attribute/value slots, +zone, +sensitivity,
 *                       +embedding_model/version, +namespace, +status, valid_from/valid_to, content_hash, utility_score
 *   chunks            — RAG-in-place; +zone, +sensitivity (permission-filtered too), expires_at, +embedding_model/version
 *   connector_schemas — Gate-2 registry (deterministic fetch-live lookup)
 *   connections       — org/per-user; +trust_level (high/low), structured-vs-unstructured, live-vs-interpretive
 *   identity_map      — canonical entities + per-SoR external ids (§4.10)
 *   ingestion_log     — every gate decision: source_ref + content_hash + confidence (refs, not content)
 *   inbox_items       — the single push destination (§7.5), permission-scoped
 *   task_state        — durable agent execution state; pause/resume (§4.1)
 *   user_clearance    — { allowed_zones[], max_sensitivity } per user (§9.1)
 *   roles             — role → default clearance + allowed agents
 *   system_config     — gated/scoped/bounded/audited tunables (§4.8)
 *   traces            — short-TTL, permission-scoped, auto-pruned (content allowed for debug, §6.9)
 *   audit_log         — append-only, references-not-content (§11.10)
 */

// TODO: import { pgTable, text, integer, timestamp, vector, jsonb, ... } from 'drizzle-orm/pg-core';
// TODO: define the tables above. Keep columns aligned 1:1 with @aios/shared so the type flows end-to-end.

export const SCHEMA_TODO = true;
