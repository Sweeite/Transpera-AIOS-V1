/**
 * Drizzle schema (tech-stack §2). One Postgres (Supabase, pgvector built in) PER CLIENT.
 * Every migration is EXPAND/CONTRACT — the shared image must tolerate schema N and N-1 (tech-stack §5.4).
 *
 * Keep columns aligned 1:1 with @aios/shared so types flow end-to-end.
 *
 * ── Core tables ──────────────────────────────────────────────────────────────
 *   memories          — typed, full lifecycle; +entity_ref/attribute/value slots, +zone, +sensitivity,
 *                       +embedding_model/version, +namespace, +status, valid_from/valid_to, content_hash,
 *                       +retrieval_count, +last_retrieved_at, utility_score
 *   chunks            — RAG-in-place; +zone, +sensitivity (permission-filtered too), expires_at, +embedding_model/version
 *   memory_links      — TYPED edges between memories (replaces flat source_refs string[]). One row per edge:
 *                       (from_id, to_id, kind∈{derived_from, supersedes, consolidated_child, corroborates}).
 *                       This is what lets decay query "does an ACTIVE SEMANTIC memory back-reference this
 *                       episodic" cheaply (#31 silent-data-loss guard) and what records supersession (#12/#30).
 *   connector_schemas — Gate-2 registry (deterministic fetch-live lookup); fed by the schema-drift job (#21)
 *   connections       — org/per-user; +trust_level (high/low) → STAMPED onto each item's Provenance.trustLevel
 *                       at routing time (#17); structured-vs-unstructured, live-vs-interpretive
 *   identity_map      — canonical entities + per-SoR external ids (§4.10); +confidence on resolution writes
 *   ingestion_log     — every gate decision: source_ref + content_hash + confidence (refs, not content)
 *
 * ── Agents / runs / human-in-the-loop ───────────────────────────────────────
 *   task_state        — durable agent execution state. status ∈ {running, paused_awaiting_input,
 *                       paused_awaiting_confirmation, completed, failed}. +principal, +version (optimistic
 *                       lock) + lease_until (single-consumer resume — prevents double side-effecting runs, #27).
 *                       payload column holds either the open question (clarification) or the action preview
 *                       (confirmation). RESUME IS IDEMPOTENT and goes through the queue, never the HTTP handler.
 *   standing_approvals— per-user, per-action-type standing grants (scope + expiry). The "unless a standing
 *                       approval exists" store for the confirmation gate (#26). Revocable; audited.
 *   inbox_items       — the single push destination (§7.5), permission-scoped (clarification/brief/alert/suggestion)
 *
 * ── Conversation (was specified NOWHERE — the recentThread source) ───────────
 *   threads           — a conversation, owned by a user, RBAC-shareable (§7.1). Scopes the chat front door.
 *   messages          — turns within a thread (role, content, provenance ref). Source of `recentThread`
 *                       fed into context assembly + intent routing (so "do it" can resolve "do WHAT").
 *
 * ── Permissions ─────────────────────────────────────────────────────────────
 *   user_clearance    — { principal_id (= Supabase auth.users.id), allowed_zones[], max_sensitivity } (§9.1).
 *                       A MISSING row ⇒ deny (fail-closed), distinct from an empty-zones row (#37/#47).
 *   roles             — role → default clearance + allowed agents
 *
 * ── Config / quality / observability ────────────────────────────────────────
 *   system_config     — gated/scoped/bounded/audited tunables (§4.8)
 *   feedback          — 👍/👎/"this is wrong" per answer/memory. Feeds decay's feedback_score (#31) AND the
 *                       wrong→invalidate split (§4.6). Without this table, utility_score is noise.
 *   suggestions       — self-improvement proposals (#33) with a typed Evidence payload (config key,
 *                       current→proposed, fixture-score before/after, supporting sample, cost delta). Dashboard 6.
 *   review_queue      — memory-proposal + consolidation-review + sensitivity-broaden items (dashboard 3 drain rate)
 *   monitors          — heartbeat + expected cadence per monitor/cron. Powers the dead-man's switch (#45):
 *                       a watchdog (run EXTERNALLY, control-plane — not an in-tenant job that dies with the worker)
 *                       alerts on overdue heartbeats.
 *   metrics_rollup    — time-series aggregates (abstention rate, miss rate, cost) for the Quality/Cost dashboards.
 *                       "Just a read" is false for trend lines — they need a rollup store (#50).
 *   traces            — short-TTL, permission-scoped, auto-pruned (content allowed for debug, §6.9)
 *   audit_log         — append-only, references-not-content (§11.10); +prev_hash for tamper-evidence (#11)
 */

// TODO: import { pgTable, text, integer, timestamp, vector, jsonb, uuid, ... } from 'drizzle-orm/pg-core';
// TODO: define the tables above. The pgvector column is `vector(N)` where N is fixed by the pinned
//       embedding model (#1) — a dimension change is a full re-embed migration, NOT expand/contract.

export const SCHEMA_TODO = true;
