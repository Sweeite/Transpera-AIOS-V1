# AIOS — Handover at the M1→M2 boundary

*Resume-here snapshot for a fresh **review session**. Start the fresh chat with `Be my review partner per AIOS_Review_Partner.md`, then read this. Everything critical is in the repo/issues — this just orients you fast. Written at M1 close.*

## Where the build is
- **M0 (tracer slice) + M1 (foundations) are COMPLETE.** Milestone gate green (leak fixtures #36 green at every close).
- **M1 closed (8):** #7 schema+per-tenant connection · #51 CI (two lanes) · #9 RBAC `getClearance` · #8 `system_config` service · #10 LLM gateway · #11 tracing+audit · #46 chokepoint test · #55 jsonb-divergence bug.
- **#47** (auth bootstrap) moved to **M8** — it depends on #39 (provisioning), which lives in M8.
- **Open follow-up: #56** — adapter-level jsonb parse (the real one-place fix for the `prepare:false` raw-text divergence; per-site `asObject`/`asConfigValue` is today's stopgap). Build it with the api/worker tiers.

## What you can now assume exists (the engine)
Sealed core: full schema (23 tables, raw-SQL-canonical + drift test) · CI (hermetic pglite + real-Postgres lanes, leak-gated, Node24-ready) · fail-closed RBAC (`getClearance`) · gated/bounded/audited `system_config` · multi-tier LLM gateway (routing→fallback→bounded-repair→prompt-cache→cost, single chokepoint) · two-store tracing+audit (tamper-evident hash chain + permission-tagged traces) · enforced gateway chokepoint.

## Live seams — respect these (cross-issue wiring, half-built on purpose)
- 🔴 **`retrieve()` is FAIL-OPEN** (`predicate ?? 'true'`, `harness/retrieval.ts`). #13 wires `getClearance` + namespace authz in. **Do NOT build any user-facing read (API #37, chat) on it until #13 lands.** This is the single most important standing caveat.
- **Namespace AUTHORIZATION has no owner yet** — `Clearance` carries zones+sensitivity only; `buildRetrievalPredicate(c, namespaces)` trusts the array it's handed. **Decision recorded on #13: #13 absorbs namespace authz** (resolve AND authorize; multi-value → fail-closed sentinel). See the inline ⚠ FORWARD FLAG above `buildRetrievalPredicate` and #13's DoD comment.
- **Audit chain** (`audit/audit-log.ts`): `appendAudit` + `verifyChain` (hash over stored `hash_input` text — never re-canonicalizes jsonb). Concurrency guard requires a **transaction runner in prod** (advisory lock); the unlocked path throws outside the test runner.
- **Gateway → trace seam**: `callModel`'s `onSpan` is wired to `emitSpan` (#11). Run context (taskId/principal/trigger) is attached at the call site, not in the gateway.
- **jsonb driver divergence** (`db/jsonb.ts`): postgres.js under `prepare:false` returns jsonb as raw text on parameterized reads; pglite parses. Per-site `asObject`(object) / `asConfigValue(raw, expected)`(scalar) normalize today; **#56** centralizes via result-column-OID inspection.
- **Traces clearance tag** (`zone`+`sensitivity_level`+`namespace`, fail-closed `_untagged` defaults): a future trace READ (#37/#32) reuses `retrievalWhereSql` VERBATIM. `tagFromSources` sends multi-zone/ns spans to `_untagged`.

## Deferred tripwires (full list in `AIOS_Operations.md`)
Embedding pin is **provisional** (#1→#43, floor 0.608) — finalize on real client data at first onboarding. Re-derive the abstention floor + quantization then. Re-enable `enforce_admins` on `main` at first client (off for the solo build). Reranker recalibrates the floor (#14).

## M2 (memory) — the next milestone, in dependency order
**M2 is exactly 4 issues: #12, #13, #14, #15.** (Identity Map **#16** is **M3** — `ingestion` — not M2; CLAUDE.md's build order files identity under M3, and nothing in M2 depends on it. An earlier draft of this line wrongly slotted it in.)
**#12** invalidate-don't-overwrite → **#13** *(the fail-open closer + namespace authz — the milestone's keystone)* → then **#14** reranker (recalibrates `retrieval_min_relevance`) **∥ #15** context assembly + token budgeting — 14 and 15 both depend only on #13, not on each other, so they can go in parallel after it. Front-load nothing new; the leak fixtures gate every close.

## How we work now (the primers carry the detail)
`AIOS_Review_Partner.md` (the role) + `AIOS_Workflow.md` (the loop) were refreshed at this boundary. The non-obvious habits: **ground every review in the real code and RUN the gate yourself** (build summaries are untrustworthy at high context — the 250k "dumbzone"); **fresh build session per issue**; **fix-now if it's the issue's own correctness, else note on the owning issue / open a ticket**; **the reviewer closes the issue after approval and verifies CI both lanes** (incl. that new `*.real.test.ts` actually run — the file count must bump). See [[working-style-grounded-serial]] and [[m1-handover-and-refresh]] in memory.

## First action on resume
Start the fresh review chat → load `CLAUDE.md` + `AIOS_QA_Playbook.md` + skim `AIOS_Issues.md` → then: **"generate the build command for #12"** (or #13 if you want to close the fail-open leak first — but #12 is the cleaner dependency order). Boot `pnpm ask` once to feel M1 before diving in.
